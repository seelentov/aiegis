import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AppEvent,
  ConfigFileInfo,
  EffectiveConfigView,
  Job,
  ProjectInfo,
  ResultRecord,
  Run,
  RunStatus,
  TokenUsage,
} from '../shared/types';
import { backgroundCommand, interactiveCommand, shellQuote, type ClaudeCommand } from './claude/args';
import { billableTokens, formatEvent, LineSplitter, StreamTracker } from './claude/stream';
import { effectiveAllow } from './config/cascade';
import {
  ConfigError,
  ensureGlobalDefaults,
  globalConfigPath,
  listRoles,
  loadConfigFile,
  parseConfigText,
  projectConfigDir,
  projectConfigPath,
  resolveConfig,
  resolveSettings,
  type EffectiveConfig,
  type RoleInfo,
  type Settings,
} from './config/loader';
import { openDb } from './db';
import { headSha } from './git';
import { AiegisMcpServer, mcpConfigJson } from './mcp/server';
import { TokenRegistry, type EntityRef } from './mcp/tokens';
import { projectDataDir, type AppPaths } from './paths';
import { ProjectRegistry, type Project } from './projects';
import { JobQueue, type JobOutcome } from './queue';
import { ProjectStore } from './store';
import { Terminals } from './terminals';
import { WorktreeCache } from './worktrees';

/** Job type for a background claude run. */
export const AGENT_JOB = 'agent';
/** Entity type of ad-hoc background tasks (scope of their token). */
export const TASK_ENTITY = 'task';

const KILL_GRACE_MS = 5000;

const zeroUsage = (): TokenUsage => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0, costUsd: 0 });

/** Config snapshot stored with each run (env values are omitted: they may hold secrets). */
function snapshot(cfg: EffectiveConfig): unknown {
  return {
    role: cfg.role,
    model: cfg.level.model,
    effort: cfg.level.effort,
    instructions: cfg.level.instructions,
    allow: effectiveAllow(cfg.level),
    deny: cfg.level.permissions.deny.map((d) => d.value),
    env_keys: Object.keys(cfg.level.env),
    settings: cfg.settings,
  };
}

/** Everything the app does, independent of Electron (used by the window process and by e2e). */
export class Core extends EventEmitter {
  readonly registry: ProjectRegistry;
  readonly tokens = new TokenRegistry();
  readonly terminals = new Terminals();
  readonly mcp: AiegisMcpServer;
  readonly queue: JobQueue;
  private readonly stores = new Map<string, ProjectStore>();
  private readonly worktrees = new Map<string, WorktreeCache>();
  /** jobId -> stream terminal and completion of the current background run. */
  private readonly activeRuns = new Map<string, { runId: string; terminalId: string; done: Promise<void> }>();
  /** sessionId -> live interactive terminal (one claude process per session). */
  private readonly liveSessions = new Map<string, string>();
  private lastSettings: Settings | null = null;

  constructor(readonly paths: AppPaths) {
    super();
    this.registry = new ProjectRegistry(paths.dataDir);
    this.mcp = new AiegisMcpServer(this.tokens, {
      store: (pid) => this.store(pid),
      projectName: (pid) => this.registry.get(pid).name,
      enqueueTask: (pid, t) => this.enqueueTaskSync(pid, t),
      stopJob: (pid, jobId) => this.cancelJob(pid, jobId),
      queueState: () => this.queue.state(),
      onWrite: (pid) => this.send({ type: 'runs-changed', projectId: pid }),
    });
    this.queue = new JobQueue(
      {
        queued: () =>
          this.registry
            .list()
            .flatMap((p) => this.store(p.id).queuedJobs())
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        setStatus: (job, status, error) => {
          this.store(job.projectId).setJobStatus(job.id, status, error ?? null);
          this.send({ type: 'jobs-changed', projectId: job.projectId });
        },
      },
      (job, signal) => this.execute(job, signal),
      {
        parallelism: () => this.globalSettings().queue.parallelism,
        fallbackPauseMs: () => this.globalSettings().queue.rate_limit_fallback_pause_sec * 1000,
      },
    );
    this.queue.on('changed', () => this.send({ type: 'queue-changed', state: this.queue.state() }));
    this.terminals.on('changed', () => this.send({ type: 'terminals-changed' }));
    this.terminals.on('data', (terminalId: string, data: string) => this.send({ type: 'terminal-data', terminalId, data }));
  }

  async start(): Promise<void> {
    ensureGlobalDefaults(this.paths.defaultsDir, this.paths.globalDir);
    await this.mcp.start();
    for (const p of this.registry.list()) {
      const s = this.store(p.id);
      s.recoverRuns();
      s.recoverJobs();
    }
    this.queue.pump();
  }

  async shutdown(): Promise<void> {
    for (const job of this.allRunningJobs()) this.queue.stop(job, 'cancelled');
    await Promise.all([...this.activeRuns.values()].map((r) => r.done));
    this.terminals.killAll();
    await this.mcp.stop();
    for (const s of this.stores.values()) s.db.close();
    this.stores.clear();
  }

  private send(ev: AppEvent): void {
    this.emit('event', ev);
  }

  notice(level: 'info' | 'warn' | 'error', text: string, projectId?: string): void {
    this.send({ type: 'notice', level, text, projectId });
  }

  // --- projects ---

  listProjects(): ProjectInfo[] {
    return this.registry.list().map(({ id, name, root }) => ({ id, name, root }));
  }

  async addProject(dir: string): Promise<ProjectInfo> {
    const p = await this.registry.add(dir);
    this.store(p.id);
    return { id: p.id, name: p.name, root: p.root };
  }

  removeProject(id: string): void {
    this.stores.get(id)?.db.close();
    this.stores.delete(id);
    this.registry.remove(id);
  }

  store(projectId: string): ProjectStore {
    let s = this.stores.get(projectId);
    if (!s) {
      this.registry.get(projectId);
      s = new ProjectStore(projectId, openDb(path.join(projectDataDir(this.paths, projectId), 'db.sqlite')));
      this.stores.set(projectId, s);
    }
    return s;
  }

  private project(projectId: string): Project {
    return this.registry.get(projectId);
  }

  private worktreeCache(p: Project): WorktreeCache {
    let w = this.worktrees.get(p.id);
    if (!w) {
      w = new WorktreeCache(p.root, path.join(projectDataDir(this.paths, p.id), 'worktrees'));
      this.worktrees.set(p.id, w);
    }
    return w;
  }

  // --- configuration ---

  private globalSettings(): Settings {
    try {
      this.lastSettings = resolveSettings(loadConfigFile(globalConfigPath(this.paths.globalDir))).settings;
    } catch (e) {
      if (!this.lastSettings) throw e;
      this.notice('error', `Глобальный конфиг не читается, используются последние корректные настройки: ${(e as Error).message}`);
    }
    return this.lastSettings!;
  }

  resolve(projectId: string | null, role: string): EffectiveConfig {
    return resolveConfig(
      { globalDir: this.paths.globalDir, projectRoot: projectId ? this.project(projectId).root : undefined },
      { role },
    );
  }

  roles(projectId: string | null): RoleInfo[] {
    return listRoles({ globalDir: this.paths.globalDir, projectRoot: projectId ? this.project(projectId).root : undefined });
  }

  sessionsSettings(projectId: string | null): Settings['sessions'] {
    const files = { global: loadConfigFile(globalConfigPath(this.paths.globalDir)) };
    const project = projectId ? loadConfigFile(projectConfigPath(this.project(projectId).root)) : undefined;
    return resolveSettings(files.global, project).settings.sessions;
  }

  effectiveView(projectId: string | null, role: string): EffectiveConfigView {
    const cfg = this.resolve(projectId, role);
    const denied = new Set(cfg.level.permissions.deny.map((d) => d.value));
    const flat: { key: string; value: string; source: string }[] = [];
    const walk = (o: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(o)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, key);
        else flat.push({ key, value: JSON.stringify(v), source: cfg.settingsSources[key] ?? '' });
      }
    };
    walk(cfg.settings as unknown as Record<string, unknown>, '');
    return {
      role: cfg.role,
      model: cfg.level.model,
      effort: cfg.level.effort,
      instructions: cfg.level.instructions,
      allow: cfg.level.permissions.allow.map((a) => ({ ...a, denied: denied.has(a.value) })),
      deny: cfg.level.permissions.deny,
      env: Object.entries(cfg.level.env).map(([key, v]) => ({ key, value: v.value, source: v.source })),
      settings: flat,
    };
  }

  private editableRoots(projectId: string | null): { scope: 'global' | 'project'; dir: string }[] {
    const roots: { scope: 'global' | 'project'; dir: string }[] = [{ scope: 'global', dir: this.paths.globalDir }];
    if (projectId) roots.push({ scope: 'project', dir: projectConfigDir(this.project(projectId).root) });
    return roots;
  }

  /** Config and instruction files the settings UI may edit. */
  listConfigFiles(projectId: string | null): ConfigFileInfo[] {
    const out: ConfigFileInfo[] = [];
    for (const { scope, dir } of this.editableRoots(projectId)) {
      const cfg = path.join(dir, 'config.yaml');
      out.push({ scope, path: cfg, rel: 'config.yaml', exists: fs.existsSync(cfg) });
      const walk = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else if (e.name.endsWith('.md')) out.push({ scope, path: f, rel: path.relative(dir, f), exists: true });
        }
      };
      walk(path.join(dir, 'instructions'));
    }
    return out;
  }

  private assertEditable(projectId: string | null, file: string): string {
    const abs = path.resolve(file);
    const ok = this.editableRoots(projectId).some(({ dir }) => abs.startsWith(path.resolve(dir) + path.sep));
    if (!ok || !(abs.endsWith('.yaml') || abs.endsWith('.md'))) throw new Error(`файл ${file} нельзя редактировать`);
    return abs;
  }

  readConfigFile(projectId: string | null, file: string): string {
    const abs = this.assertEditable(projectId, file);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  }

  /** Validates YAML config before saving; instruction files are saved as-is. */
  writeConfigFile(projectId: string | null, file: string, text: string): void {
    const abs = this.assertEditable(projectId, file);
    if (abs.endsWith('.yaml')) parseConfigText(text, abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    if (abs === globalConfigPath(this.paths.globalDir)) this.queue.pump();
  }

  // --- jobs ---

  listJobs(projectId: string): Job[] {
    return this.store(projectId).listJobs();
  }

  listRuns(projectId: string): Run[] {
    return this.store(projectId).listRuns();
  }

  runDetails(projectId: string, runId: string): { run: Run; results: ResultRecord[]; log: string | null } {
    const s = this.store(projectId);
    const run = s.getRun(runId);
    if (!run) throw new Error(`прогон ${runId} не найден`);
    return { run, results: s.listResults({ runId }), log: run.logPath };
  }

  private enqueueTaskSync(projectId: string, t: { prompt: string; role: string; title: string }, sha?: string): Job {
    const cfg = this.resolve(projectId, t.role);
    if (cfg.role.kind !== 'background') throw new ConfigError(`роль ${t.role} не фоновая`);
    const id = crypto.randomUUID();
    const commit = sha ?? execFileSyncHead(this.project(projectId).root);
    const job = this.store(projectId).addJob(
      {
        type: AGENT_JOB,
        role: t.role,
        title: t.title,
        entityType: TASK_ENTITY,
        entityId: id,
        payload: { prompt: t.prompt, commit_sha: commit },
      },
      id,
    );
    this.send({ type: 'jobs-changed', projectId });
    queueMicrotask(() => this.queue.pump());
    return job;
  }

  async enqueueTask(projectId: string, t: { prompt: string; role: string; title?: string }): Promise<Job> {
    const sha = await headSha(this.project(projectId).root);
    return this.enqueueTaskSync(projectId, { prompt: t.prompt, role: t.role, title: t.title || t.prompt.slice(0, 80) }, sha);
  }

  cancelJob(projectId: string, jobId: string): void {
    const job = this.store(projectId).getJob(jobId);
    if (!job) throw new Error(`задача ${jobId} не найдена`);
    this.queue.stop(job, 'cancelled');
  }

  retryJob(projectId: string, jobId: string): void {
    const s = this.store(projectId);
    const job = s.getJob(jobId);
    if (!job || job.status === 'running' || job.status === 'queued') return;
    s.setJobStatus(jobId, 'queued');
    this.send({ type: 'jobs-changed', projectId });
    this.queue.pump();
  }

  private allRunningJobs(): Job[] {
    return this.registry
      .list()
      .flatMap((p) => this.store(p.id).listJobs())
      .filter((j) => this.queue.isRunning(j.id));
  }

  /** Stops the background run of a job and opens its session interactively (SPEC §1, Q3). */
  async takeOver(projectId: string, jobId: string): Promise<string> {
    const job = this.store(projectId).getJob(jobId);
    if (!job) throw new Error(`задача ${jobId} не найдена`);
    const active = this.activeRuns.get(jobId);
    if (!active) throw new Error('задача не выполняется');
    this.queue.stop(job, 'taken_over');
    await active.done;
    return this.openRun(projectId, active.runId);
  }

  // --- background execution ---

  private async execute(job: Job, signal: AbortSignal): Promise<JobOutcome> {
    if (job.type !== AGENT_JOB) return { kind: 'failed', error: `неизвестный тип задачи ${job.type}` };
    const p = this.project(job.projectId);
    const s = this.store(job.projectId);
    const cfg = this.resolve(job.projectId, job.role);
    const sha = String(job.payload.commit_sha);
    const cwd = await this.worktreeCache(p).ensure(sha);
    if (signal.aborted) return { kind: signal.reason === 'taken_over' ? 'taken_over' : 'cancelled' };

    const runId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const dir = projectDataDir(this.paths, p.id);
    const logPath = path.join(dir, 'logs', `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const scope: EntityRef[] = [{ type: job.entityType, id: job.entityId }];
    const grant = this.tokens.issue({
      projectId: p.id,
      role: job.role,
      access: cfg.role.mcp_access,
      sessionId,
      runId,
      scope,
    });
    const mcpPath = this.writeMcpConfig(p.id, runId, grant.token);
    const cmd = backgroundCommand(cfg, { sessionId, mcpConfigPath: mcpPath });

    s.startRun(
      {
        jobId: job.id,
        kind: 'background',
        role: job.role,
        author: `ai:${job.role}`,
        entityType: job.entityType,
        entityId: job.entityId,
        sessionId,
        cwd,
        commitSha: sha,
        configSnapshot: snapshot(cfg),
        logPath,
      },
      runId,
    );
    s.setJobRun(job.id, runId);
    this.send({ type: 'runs-changed', projectId: p.id });

    const terminalId = this.terminals.openStream(p.id, runId, `▶ ${job.title}`);
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.activeRuns.set(job.id, { runId, terminalId, done });

    try {
      const res = await this.runClaudeProcess(cmd, cwd, String(job.payload.prompt), {
        signal,
        logPath,
        terminalId,
        maxTokens: cfg.settings.limits.max_tokens_per_run,
      });
      s.finishRun(runId, res.status, res.usage, res.error);
      switch (res.status) {
        case 'succeeded':
          return { kind: 'done' };
        case 'cancelled':
          return { kind: 'cancelled' };
        case 'taken_over':
          return { kind: 'taken_over' };
        case 'rate_limited':
          return { kind: 'rate_limited', resetsAt: res.rateLimitResetsAt };
        default:
          return { kind: 'failed', error: res.error ?? res.status };
      }
    } catch (e) {
      s.finishRun(runId, 'failed', zeroUsage(), (e as Error).message);
      throw e;
    } finally {
      this.tokens.revoke(grant.token);
      fs.rmSync(mcpPath, { force: true });
      this.terminals.markEnded(terminalId);
      this.activeRuns.delete(job.id);
      resolveDone();
      this.send({ type: 'runs-changed', projectId: p.id });
    }
  }

  private writeMcpConfig(projectId: string, name: string, token: string): string {
    const file = path.join(projectDataDir(this.paths, projectId), 'mcp', `${name}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, mcpConfigJson(this.mcp.url(), token), { mode: 0o600 });
    return file;
  }

  private runClaudeProcess(
    cmd: ClaudeCommand,
    cwd: string,
    prompt: string,
    o: { signal: AbortSignal; logPath: string; terminalId: string; maxTokens: number },
  ): Promise<{ status: RunStatus; usage: TokenUsage; error: string | null; rateLimitResetsAt?: number }> {
    return new Promise((resolve) => {
      const child = spawn(cmd.binary, cmd.args, { cwd, env: { ...process.env, ...cmd.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      const log = fs.createWriteStream(o.logPath, { flags: 'a' });
      const tracker = new StreamTracker();
      const lines = new LineSplitter();
      let stderr = '';
      let stopReason: RunStatus | null = null;
      let spawnError: string | null = null;

      const stop = (reason: RunStatus) => {
        if (stopReason) return;
        stopReason = reason;
        child.kill('SIGTERM');
        setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), KILL_GRACE_MS).unref();
      };
      const onAbort = () => stop(o.signal.reason === 'taken_over' ? 'taken_over' : 'cancelled');
      if (o.signal.aborted) onAbort();
      o.signal.addEventListener('abort', onAbort, { once: true });

      const handle = (line: string) => {
        log.write(line + '\n');
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          this.terminals.append(o.terminalId, line + '\r\n');
          return;
        }
        tracker.feed(ev);
        this.terminals.append(o.terminalId, formatEvent(ev));
        if (billableTokens(tracker.summary.usage) > o.maxTokens) {
          this.terminals.append(o.terminalId, `\x1b[31m[aiegis] превышен лимит токенов на прогон (${o.maxTokens})\x1b[0m\r\n`);
          stop('token_limit');
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => lines.push(d).forEach(handle));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => {
        stderr = (stderr + d).slice(-4000);
        this.terminals.append(o.terminalId, `\x1b[2m${d.replace(/\r?\n/g, '\r\n')}\x1b[0m`);
      });
      child.on('error', (e) => (spawnError = `не удалось запустить ${cmd.binary}: ${e.message}`));
      child.stdin.on('error', () => undefined);
      child.stdin.end(prompt);

      child.on('close', (code) => {
        lines.flush().forEach(handle);
        log.end();
        o.signal.removeEventListener('abort', onAbort);
        const sum = tracker.summary;
        let status: RunStatus;
        let error: string | null = null;
        if (stopReason) {
          status = stopReason;
        } else if (sum.rateLimited) {
          status = 'rate_limited';
          error = sum.result?.text ?? 'rate limit';
        } else if (code === 0 && sum.result && !sum.result.isError) {
          status = 'succeeded';
        } else {
          status = 'failed';
          error = spawnError ?? sum.result?.text ?? (stderr.trim() || `код выхода ${code}`);
        }
        resolve({ status, usage: sum.usage, error, rateLimitResetsAt: sum.rateLimitResetsAt });
      });
    });
  }

  // --- interactive sessions ---

  /**
   * "Провалиться": shows the read-only stream while the background run is alive,
   * otherwise opens `claude --resume` in a PTY in the run's cwd.
   */
  async openRun(projectId: string, runId: string): Promise<string> {
    const run = this.store(projectId).getRun(runId);
    if (!run) throw new Error(`прогон ${runId} не найден`);
    if (run.jobId) {
      const active = this.activeRuns.get(run.jobId);
      if (active?.runId === runId) return active.terminalId;
    }
    const live = this.liveSessions.get(run.sessionId);
    if (live) return live;
    const cwd = await this.ensureCwd(projectId, run);
    return this.spawnInteractive(projectId, {
      role: run.role,
      sessionId: run.sessionId,
      resume: true,
      cwd,
      commitSha: run.commitSha,
      parentRunId: run.id,
      entity: run.entityType && run.entityId ? { type: run.entityType, id: run.entityId } : null,
      title: `↺ ${run.role} ${run.sessionId.slice(0, 8)}`,
    });
  }

  /** "Новая сессия": interactive claude in the user's working directory with the free-session role. */
  async newSession(projectId: string): Promise<string> {
    const p = this.project(projectId);
    const role = this.sessionsSettings(projectId).free_role;
    return this.spawnInteractive(projectId, {
      role,
      sessionId: crypto.randomUUID(),
      resume: false,
      cwd: p.root,
      commitSha: await headSha(p.root),
      parentRunId: null,
      entity: null,
      title: `✦ ${this.resolve(projectId, role).role.title}`,
    });
  }

  private async ensureCwd(projectId: string, run: Run): Promise<string> {
    const p = this.project(projectId);
    const wt = this.worktreeCache(p);
    if (run.cwd === wt.pathFor(run.commitSha)) return wt.ensure(run.commitSha);
    return run.cwd;
  }

  private interactiveSetup(
    projectId: string,
    o: { role: string; sessionId: string; resume: boolean; cwd: string; commitSha: string; parentRunId: string | null; entity: EntityRef | null },
    external: boolean,
  ): { runId: string; cmd: ClaudeCommand; token: string; mcpPath: string } {
    const cfg = this.resolve(projectId, o.role);
    const runId = crypto.randomUUID();
    const grant = this.tokens.issue({
      projectId,
      role: o.role,
      access: cfg.role.mcp_access,
      sessionId: o.sessionId,
      runId,
      scope: o.entity ? [o.entity] : [],
    });
    const mcpPath = this.writeMcpConfig(projectId, runId, grant.token);
    const cmd = interactiveCommand(cfg, { sessionId: o.sessionId, resume: o.resume, mcpConfigPath: mcpPath });
    const s = this.store(projectId);
    s.startRun(
      {
        parentRunId: o.parentRunId,
        kind: 'interactive',
        role: o.role,
        author: 'human',
        entityType: o.entity?.type,
        entityId: o.entity?.id,
        sessionId: o.sessionId,
        cwd: o.cwd,
        commitSha: o.commitSha,
        configSnapshot: { ...(snapshot(cfg) as object), external },
      },
      runId,
    );
    this.send({ type: 'runs-changed', projectId });
    return { runId, cmd, token: grant.token, mcpPath };
  }

  private spawnInteractive(
    projectId: string,
    o: { role: string; sessionId: string; resume: boolean; cwd: string; commitSha: string; parentRunId: string | null; entity: EntityRef | null; title: string },
  ): string {
    const { runId, cmd, token, mcpPath } = this.interactiveSetup(projectId, o, false);
    const p = this.project(projectId);
    const terminalId = this.terminals.openPty({
      projectId,
      runId,
      title: o.title,
      cwd: o.cwd,
      binary: cmd.binary,
      args: cmd.args,
      env: cmd.env,
      onExit: (code) => {
        this.liveSessions.delete(o.sessionId);
        this.tokens.revoke(token);
        fs.rmSync(mcpPath, { force: true });
        this.store(projectId).finishRun(runId, 'exited', zeroUsage(), code === 0 ? null : `код выхода ${code}`);
        this.send({ type: 'runs-changed', projectId });
        if (o.cwd === p.root) void this.checkCommits(projectId, o.commitSha);
      },
    });
    this.liveSessions.set(o.sessionId, terminalId);
    return terminalId;
  }

  /** After a session in the user's working directory: if it committed, offer re-checks (SPEC §1, Q22). */
  private async checkCommits(projectId: string, before: string): Promise<void> {
    try {
      const after = await headSha(this.project(projectId).root);
      if (after !== before) {
        this.notice(
          'info',
          `Сессия изменила HEAD: ${before.slice(0, 8)} → ${after.slice(0, 8)}. Связанные проверки стоит перепроверить.`,
          projectId,
        );
      }
    } catch {
      /* repository may be mid-rebase; nothing to report */
    }
  }

  /** Opens the session in an external terminal (macOS). The token lives until the app exits. */
  async openExternal(projectId: string, runId: string): Promise<void> {
    const run = this.store(projectId).getRun(runId);
    if (!run) throw new Error(`прогон ${runId} не найден`);
    if (run.jobId && this.activeRuns.get(run.jobId)?.runId === runId) throw new Error('фоновый прогон ещё идёт — сначала перехватите его');
    if (this.liveSessions.has(run.sessionId)) throw new Error('сессия уже открыта во встроенном терминале');
    const cwd = await this.ensureCwd(projectId, run);
    const entity = run.entityType && run.entityId ? { type: run.entityType, id: run.entityId } : null;
    const { runId: newRunId, cmd } = this.interactiveSetup(
      projectId,
      { role: run.role, sessionId: run.sessionId, resume: true, cwd, commitSha: run.commitSha, parentRunId: run.id, entity },
      true,
    );
    // The external process is not tracked; its run record is finalized right away.
    this.store(projectId).finishRun(newRunId, 'exited', zeroUsage(), null);
    const envPart = Object.entries(cmd.env).map(([k, v]) => `${k}=${shellQuote(v)}`);
    const line = ['cd', shellQuote(cwd), '&&', ...envPart, shellQuote(cmd.binary), ...cmd.args.map(shellQuote)].join(' ');
    const app = this.resolve(projectId, run.role).settings.terminal.external_app;
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await new Promise<void>((resolve, reject) =>
      execFile(
        'osascript',
        ['-e', `tell application "${esc(app)}" to do script "${esc(line)}"`, '-e', `tell application "${esc(app)}" to activate`],
        (err) => (err ? reject(err) : resolve()),
      ),
    );
  }
}

/** Used only by the synchronous MCP enqueue path; the UI resolves HEAD asynchronously. */
function execFileSyncHead(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}
