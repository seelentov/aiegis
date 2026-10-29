import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AppEvent,
  Cell,
  CellDetails,
  CellLabel,
  ConfigFileInfo,
  DocumentSummary,
  DocVersionView,
  EffectiveConfigView,
  EntryPointMap,
  Evidence,
  Finding,
  FindingDetails,
  FindingInput,
  FindingStatus,
  Job,
  Matrix,
  MatrixEstimate,
  MatrixScope,
  MatrixStage,
  MatrixView,
  Module,
  ModuleRevision,
  ModuleSummary,
  ProjectInfo,
  RecheckOffer,
  RequirementItem,
  ResultRecord,
  ReviewState,
  Run,
  RunStatus,
  StaleReason,
  TokenUsage,
  Verdict,
  VerdictStatus,
} from '../shared/types';
import { FINDING_STATUSES, VERDICT_STATUSES } from '../shared/types';
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
  SOURCE_PROJECT,
  type EffectiveConfig,
  type RoleInfo,
  type Settings,
} from './config/loader';
import { openDb } from './db';
import { agentFile, detectFormat, documentText, sha256File, sourceFile, stageDocument } from './documents';
import { changedFiles, headSha } from './git';
import {
  affectingChanges,
  CELL_ENTITY,
  cellId,
  DOC_VERSION_ENTITY,
  FINDING_ENTITY,
  MATRIX_BATCH_ENTITY,
  parseCellId,
  planBatches,
  rankSimilar,
  reqHash,
  SNAPSHOT_VALIDITY,
  VERDICT_VALIDITY,
  type Batch,
  type BatchCell,
  type CellRef,
} from './matrix';
import { AiegisMcpServer, mcpConfigJson } from './mcp/server';
import { TokenRegistry, type EntityRef } from './mcp/tokens';
import { projectDataDir, type AppPaths } from './paths';
import { ProjectRegistry, type Project } from './projects';
import { diffEntryPoints, globsError, matchFiles, MODULE_ENTITY, MODULE_MAP_ENTITY, renderTemplate, repoFileError } from './modules';
import { JobQueue, type JobOutcome } from './queue';
import { ProjectStore } from './store';
import { Terminals } from './terminals';
import { WorktreeCache } from './worktrees';

/** Job type for a background claude run. */
export const AGENT_JOB = 'agent';
/** Entity type of ad-hoc background tasks (scope of their token). */
export const TASK_ENTITY = 'task';

const KILL_GRACE_MS = 5000;

/** Task kind (`tasks.<kind>`) of each matrix stage. */
const STAGE_TASK: Record<MatrixStage, string> = { triage: 'matrix_triage', verdicts: 'matrix_verdicts' };

/** Payload of a matrix job: which matrix, stage and cells it covers. */
interface MatrixPayload {
  matrix_id: string;
  stage: MatrixStage;
  cells: string[];
}

const matrixPayload = (job: Job): MatrixPayload | null =>
  job.entityType === MATRIX_BATCH_ENTITY ? (job.payload as unknown as MatrixPayload) : null;

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

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
      documentText: (pid, versionId) => documentText(this.docDir(pid, versionId)),
      matrixView: (pid, id) => this.matrixView(pid, id),
      cellDetails: (pid, c) => this.cellDetails(pid, cellId(c)),
      recheckCells: (pid, cells) => this.recheckCells(pid, cells.map(cellId)),
      similarLimit: (pid) => this.projectSettings(pid).findings.similar_limit,
      onWrite: (pid) => {
        this.send({ type: 'runs-changed', projectId: pid });
        this.send({ type: 'modules-changed', projectId: pid });
        this.send({ type: 'audit-changed', projectId: pid });
      },
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
    const added = ensureGlobalDefaults(this.paths.defaultsDir, this.paths.globalDir);
    if (added.length) this.notice('info', `В глобальный конфиг добавлены новые настройки по умолчанию: ${added.join(', ')}`);
    await this.mcp.start();
    for (const p of this.registry.list()) {
      const s = this.store(p.id);
      s.recoverRuns();
      s.recoverSnapshots();
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

  notice(level: 'info' | 'warn' | 'error', text: string, projectId?: string, recheck?: RecheckOffer): void {
    this.send({ type: 'notice', level, text, projectId, recheck });
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

  /**
   * Effective config of a role, optionally with the module (`modules.<name>`), matrix (`matrices.<name>`)
   * and requirement (`requirements.<key>`) levels of the cascade.
   */
  resolve(projectId: string | null, role: string, module?: string, extra: { matrix?: string; item?: string } = {}): EffectiveConfig {
    return resolveConfig(
      { globalDir: this.paths.globalDir, projectRoot: projectId ? this.project(projectId).root : undefined },
      { role, module, ...extra },
    );
  }

  /** Non-cascade settings of a project (global -> project). */
  projectSettings(projectId: string): Settings {
    const global = loadConfigFile(globalConfigPath(this.paths.globalDir));
    return resolveSettings(global, loadConfigFile(projectConfigPath(this.project(projectId).root))).settings;
  }

  /** Config of a job's run: module jobs get the module level, matrix jobs also the matrix and (single cell) item levels. */
  private resolveForJob(job: Job): EffectiveConfig {
    const mp = matrixPayload(job);
    if (mp) {
      const s = this.store(job.projectId);
      const cells = mp.cells.map(parseCellId);
      const mod = s.getModule(cells[0].moduleId);
      if (!mod) throw new Error(`модуль ${cells[0].moduleId} удалён`);
      const matrix = s.audit.getMatrix(mp.matrix_id);
      const item = cells.length === 1 ? s.audit.currentItem(cells[0].requirementId) : undefined;
      return this.resolve(job.projectId, job.role, mod.name, { matrix: matrix?.name, item: item?.key });
    }
    if (job.entityType !== MODULE_ENTITY) return this.resolve(job.projectId, job.role);
    const mod = this.store(job.projectId).getModule(job.entityId);
    if (!mod) throw new Error(`модуль ${job.entityId} удалён`);
    return this.resolve(job.projectId, job.role, mod.name);
  }

  roles(projectId: string | null): RoleInfo[] {
    return listRoles({ globalDir: this.paths.globalDir, projectRoot: projectId ? this.project(projectId).root : undefined });
  }

  sessionsSettings(projectId: string | null): Settings['sessions'] {
    const files = { global: loadConfigFile(globalConfigPath(this.paths.globalDir)) };
    const project = projectId ? loadConfigFile(projectConfigPath(this.project(projectId).root)) : undefined;
    return resolveSettings(files.global, project).settings.sessions;
  }

  effectiveView(projectId: string | null, role: string, module?: string, extra: { matrix?: string; item?: string } = {}): EffectiveConfigView {
    const cfg = this.resolve(projectId, role, module, extra);
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
    const id = crypto.randomUUID();
    return this.addAgentJob(projectId, { ...t, entity: { type: TASK_ENTITY, id } }, sha ?? execFileSyncHead(this.project(projectId).root), id);
  }

  /** Queues a background claude run whose token may write `entity`. */
  private addAgentJob(
    projectId: string,
    t: { prompt: string; role: string; title: string; entity: EntityRef; payload?: Record<string, unknown> },
    sha: string,
    id?: string,
  ): Job {
    const cfg = this.resolve(projectId, t.role);
    if (cfg.role.kind !== 'background') throw new ConfigError(`роль ${t.role} не фоновая`);
    const job = this.store(projectId).addJob(
      {
        type: AGENT_JOB,
        role: t.role,
        title: t.title,
        entityType: t.entity.type,
        entityId: t.entity.id,
        payload: { ...t.payload, prompt: t.prompt, commit_sha: sha },
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

  // --- modules and entry points ---

  /** App-started task kind from config (`tasks.<kind>`) with its prompt template loaded. */
  private taskSpec(projectId: string, kind: string): { role: string; title: string; template: string; file: string } {
    const files = { global: loadConfigFile(globalConfigPath(this.paths.globalDir)) };
    const root = this.project(projectId).root;
    const { settings, sources } = resolveSettings(files.global, loadConfigFile(projectConfigPath(root)));
    const t = settings.tasks[kind];
    if (!t) throw new ConfigError(`в конфигурации не задана задача tasks.${kind}`);
    const dir = sources[`tasks.${kind}.prompt`] === SOURCE_PROJECT ? projectConfigDir(root) : this.paths.globalDir;
    const file = path.resolve(dir, t.prompt);
    if (!fs.existsSync(file)) throw new ConfigError(`tasks.${kind}.prompt: не найден файл ${file}`);
    return { role: t.role, title: t.title, template: fs.readFileSync(file, 'utf8'), file };
  }

  taskRole(projectId: string, kind: string): string {
    return this.taskSpec(projectId, kind).role;
  }

  private assertNotQueued(projectId: string, entity: EntityRef): void {
    const active = this.store(projectId).activeJobFor(entity.type, entity.id);
    if (active) throw new Error(`для этой сущности уже есть задача в очереди: «${active.title}»`);
  }

  /** Queues the AI module markup of the repository; `hint` narrows or redirects it. */
  async enqueueModuleMarkup(projectId: string, hint: string): Promise<Job> {
    const p = this.project(projectId);
    const entity = { type: MODULE_MAP_ENTITY, id: projectId };
    this.assertNotQueued(projectId, entity);
    const spec = this.taskSpec(projectId, 'modules');
    const mods = this.store(projectId).listModules();
    const vars = {
      project: p.name,
      hint: hint.trim() || '(none)',
      modules: mods.length
        ? mods.map((m) => `- ${m.name} (module_id ${m.id}): ${m.globs.join(', ')} — ${m.description}`).join('\n')
        : '(none)',
    };
    return this.addAgentJob(
      projectId,
      { role: spec.role, title: renderTemplate(spec.title, vars), prompt: renderTemplate(spec.template, vars, spec.file), entity },
      await headSha(p.root),
    );
  }

  /** Queues the entry point map run of one module on the current HEAD. */
  async enqueueEntryPoints(projectId: string, moduleId: string, sha?: string): Promise<Job> {
    const p = this.project(projectId);
    const mod = this.store(projectId).getModule(moduleId);
    if (!mod) throw new Error(`модуль ${moduleId} не найден`);
    const entity = { type: MODULE_ENTITY, id: mod.id };
    this.assertNotQueued(projectId, entity);
    const spec = this.taskSpec(projectId, 'entry_points');
    const vars = {
      project: p.name,
      module_id: mod.id,
      module_name: mod.name,
      module_globs: mod.globs.map((g) => `- ${g}`).join('\n'),
      module_description: mod.description || '(none)',
    };
    return this.addAgentJob(
      projectId,
      { role: spec.role, title: renderTemplate(spec.title, vars), prompt: renderTemplate(spec.template, vars, spec.file), entity },
      sha ?? (await headSha(p.root)),
    );
  }

  /** Queues entry point maps of all modules that have no job in the queue. */
  async enqueueAllEntryPoints(projectId: string): Promise<Job[]> {
    const sha = await headSha(this.project(projectId).root);
    const s = this.store(projectId);
    const jobs: Job[] = [];
    for (const m of s.listModules()) {
      if (!s.activeJobFor(MODULE_ENTITY, m.id)) jobs.push(await this.enqueueEntryPoints(projectId, m.id, sha));
    }
    return jobs;
  }

  async listModules(projectId: string): Promise<ModuleSummary[]> {
    const s = this.store(projectId);
    const head = await headSha(this.project(projectId).root);
    const out: ModuleSummary[] = [];
    for (const m of s.listModules()) {
      const job = s.activeJobFor(MODULE_ENTITY, m.id);
      const snap = s.latestSnapshot(m.id) ?? null;
      const valid = snap ? await this.validityOf(projectId, SNAPSHOT_VALIDITY, snap.id, snap.commitSha, snap.touchedFiles ?? [], snap.globs, head) : null;
      out.push({ ...m, latestSnapshot: snap, snapshotStale: valid ? !valid.valid : false, activeJob: job ? { id: job.id, status: job.status } : null });
    }
    return out;
  }

  moduleHistory(projectId: string, moduleId: string): ModuleRevision[] {
    return this.store(projectId).moduleHistory(moduleId);
  }

  /** Tracked files of the working tree matching globs (UI preview and validation of manual edits). */
  async previewGlobs(projectId: string, globs: string[]): Promise<{ count: number; sample: string[] }> {
    const files = await matchFiles(this.project(projectId).root, globs);
    return { count: files.length, sample: files.slice(0, 20) };
  }

  /** Manual module edit from the UI: a new revision authored by "human". */
  async saveModule(projectId: string, m: { id?: string; name: string; globs: string[]; description: string }): Promise<Module> {
    const globs = m.globs.map((g) => g.trim()).filter(Boolean);
    const err = globsError(globs);
    if (err) throw new Error(err);
    if (!(await this.previewGlobs(projectId, globs)).count) throw new Error('globs не совпадают ни с одним файлом репозитория');
    const mod = this.store(projectId).saveModule({ ...m, globs, description: m.description.trim() }, { author: 'human', runId: null });
    this.send({ type: 'modules-changed', projectId });
    return mod;
  }

  removeModule(projectId: string, moduleId: string, reason: string): void {
    if (!reason.trim()) throw new Error('укажите причину удаления');
    this.store(projectId).removeModule(moduleId, reason.trim(), { author: 'human', runId: null });
    this.send({ type: 'modules-changed', projectId });
  }

  /** A snapshot of the module's map (default: current) with changes against the previous complete snapshot. */
  entryPointMap(projectId: string, moduleId: string, snapshotId?: string): EntryPointMap {
    const s = this.store(projectId);
    const snapshots = s.listSnapshots(moduleId);
    const snapshot = (snapshotId ? snapshots.find((x) => x.id === snapshotId) : snapshots.find((x) => x.status === 'complete')) ?? null;
    if (!snapshot) return { snapshots, snapshot: null, baseline: null, entries: [], removed: [] };
    const idx = snapshots.indexOf(snapshot);
    const baseline = snapshots.slice(idx + 1).find((x) => x.status === 'complete') ?? null;
    const diff = diffEntryPoints(s.listEntryPoints(snapshot.id), baseline ? s.listEntryPoints(baseline.id) : null);
    return { snapshots, snapshot, baseline, ...diff };
  }

  // --- validity (SPEC §5) ---

  private readonly diffs = new Map<string, Promise<string[] | null>>();

  private diffBetween(projectId: string, from: string, to: string): Promise<string[] | null> {
    const key = `${projectId}:${from}..${to}`;
    let d = this.diffs.get(key);
    if (!d) {
      d = changedFiles(this.project(projectId).root, from, to);
      this.diffs.set(key, d);
    }
    return d;
  }

  /**
   * Whether a verdict or snapshot made at `sha` still holds at `head`: no changed file is among its touched files
   * or module files. Computed without AI from `git diff` and cached in `validity`. An unknown commit is not valid.
   */
  private async validityOf(
    projectId: string,
    type: string,
    id: string,
    sha: string,
    touched: string[],
    globs: string[],
    head: string,
  ): Promise<{ valid: boolean; changedFiles: string[] }> {
    if (sha === head) return { valid: true, changedFiles: [] };
    const a = this.store(projectId).audit;
    const cached = a.getValidity(type, id, head);
    if (cached) return cached;
    const diff = await this.diffBetween(projectId, sha, head);
    const changed = diff ? affectingChanges(diff, touched, globs) : [];
    const valid = diff !== null && changed.length === 0;
    a.setValidity(type, id, head, valid, changed);
    return { valid, changedFiles: changed };
  }

  // --- documents and requirements (SPEC §4, Q17) ---

  private docDir(projectId: string, versionId: string): string {
    return path.join(projectDataDir(this.paths, projectId), 'documents', versionId);
  }

  private auditChanged(projectId: string): void {
    this.send({ type: 'audit-changed', projectId });
  }

  listDocuments(projectId: string): DocumentSummary[] {
    return this.store(projectId).audit.listDocuments();
  }

  /** Imports a file as a new document or a new version of `documentId` and queues requirement extraction. */
  async importDocument(projectId: string, file: string, o: { documentId?: string; title?: string } = {}): Promise<DocVersionView> {
    const format = detectFormat(file);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`файл ${file} не найден`);
    const a = this.store(projectId).audit;
    const sha = sha256File(file);
    if (o.documentId) {
      const doc = a.listDocuments().find((d) => d.id === o.documentId);
      if (!doc) throw new Error(`документ ${o.documentId} не найден`);
      const open = doc.versions.find((v) => v.status === 'extracting' || v.status === 'review');
      if (open) throw new Error(`у документа есть неутверждённая версия v${open.n}: утвердите или отбросьте её`);
      if (doc.current?.sha256 === sha) throw new Error('файл совпадает с текущей утверждённой версией');
    }
    this.taskSpec(projectId, 'requirements');
    const versionId = crypto.randomUUID();
    await stageDocument(file, this.docDir(projectId, versionId), format);
    const documentId = o.documentId ?? a.createDocument(o.title?.trim() || path.basename(file, path.extname(file)));
    a.addVersion(documentId, { filename: path.basename(file), format, sha256: sha }, versionId);
    try {
      await this.enqueueExtraction(projectId, versionId);
    } catch (e) {
      a.setVersionStatus(versionId, 'failed');
      throw e;
    }
    this.auditChanged(projectId);
    return this.docVersion(projectId, versionId);
  }

  private async enqueueExtraction(projectId: string, versionId: string): Promise<Job> {
    const p = this.project(projectId);
    const a = this.store(projectId).audit;
    const v = a.getVersion(versionId);
    if (!v) throw new Error(`версия ${versionId} не найдена`);
    const entity = { type: DOC_VERSION_ENTITY, id: versionId };
    this.assertNotQueued(projectId, entity);
    const spec = this.taskSpec(projectId, 'requirements');
    const prev = a.previousApproved(v);
    const prevItems = prev ? a.listItems(prev.id).filter((i) => i.review === 'accepted') : [];
    const vars = {
      project: p.name,
      document_title: a.getDocumentTitle(v.documentId) ?? '',
      version_id: v.id,
      version_n: String(v.n),
      file: agentFile(this.docDir(projectId, versionId)),
      format: v.format,
      previous: prevItems.length ? prevItems.map((i) => `- ${i.key} [${i.section}]: ${i.text}`).join('\n') : '(none)',
    };
    return this.addAgentJob(
      projectId,
      { role: spec.role, title: renderTemplate(spec.title, vars), prompt: renderTemplate(spec.template, vars, spec.file), entity },
      await headSha(p.root),
    );
  }

  /** Re-runs extraction of a version whose run failed or never ran. */
  async retryExtraction(projectId: string, versionId: string): Promise<Job> {
    const a = this.store(projectId).audit;
    const v = a.getVersion(versionId);
    if (!v || (v.status !== 'failed' && v.status !== 'extracting')) throw new Error('повторить можно только неудавшееся извлечение');
    a.setVersionStatus(versionId, 'extracting');
    const job = await this.enqueueExtraction(projectId, versionId);
    this.auditChanged(projectId);
    return job;
  }

  /** Moves a version out of extraction: to review (keeps what was extracted) or discarded. */
  setVersionState(projectId: string, versionId: string, status: 'review' | 'discarded'): void {
    const s = this.store(projectId);
    const v = s.audit.getVersion(versionId);
    if (!v) throw new Error(`версия ${versionId} не найдена`);
    if (v.status === 'approved') throw new Error('утверждённая версия неизменяема');
    if (s.activeJobFor(DOC_VERSION_ENTITY, versionId)) throw new Error('извлечение ещё идёт');
    if (status === 'review' && !v.itemCount) throw new Error('в версии нет пунктов');
    s.audit.setVersionStatus(versionId, status);
    this.auditChanged(projectId);
  }

  docVersion(projectId: string, versionId: string): DocVersionView {
    const s = this.store(projectId);
    const a = s.audit;
    const version = a.getVersion(versionId);
    if (!version) throw new Error(`версия ${versionId} не найдена`);
    const job = s.latestJobFor(DOC_VERSION_ENTITY, versionId);
    const dir = this.docDir(projectId, versionId);
    return {
      document: { id: version.documentId, title: a.getDocumentTitle(version.documentId) ?? '' },
      version,
      ...a.versionDiff(version),
      job: job ? { id: job.id, status: job.status, lastRunId: job.lastRunId, error: job.error } : null,
      sourceFile: sourceFile(dir),
      quotesVerified: version.format !== 'pdf',
    };
  }

  reviewItems(projectId: string, versionId: string, itemIds: string[], review: ReviewState): void {
    const v = this.store(projectId).audit.getVersion(versionId);
    if (!v || v.status === 'approved') throw new Error('версия недоступна для ревью');
    this.store(projectId).audit.reviewItems(versionId, itemIds, review);
    this.auditChanged(projectId);
  }

  /** Manual add/edit of an item during review: authored by human and accepted. */
  saveItem(projectId: string, versionId: string, it: { key?: string | null; text: string; section: string; quote: string }): RequirementItem {
    const a = this.store(projectId).audit;
    const v = a.getVersion(versionId);
    if (!v || v.status === 'approved' || v.status === 'discarded') throw new Error('версия недоступна для правки');
    const item = a.upsertItem(versionId, it, { author: 'human', runId: null }, 'accepted');
    this.auditChanged(projectId);
    return item;
  }

  approveVersion(projectId: string, versionId: string): void {
    this.store(projectId).audit.approveVersion(versionId, 'human');
    this.auditChanged(projectId);
  }

  // --- matrices (SPEC §4, Q8/Q9) ---

  listMatrices(projectId: string): Matrix[] {
    return this.store(projectId).audit.listMatrices();
  }

  saveMatrix(projectId: string, m: { id?: string; name: string; documentIds: string[]; moduleIds: string[] }): Matrix {
    const s = this.store(projectId);
    for (const d of m.documentIds) if (!s.audit.getDocumentTitle(d)) throw new Error(`документ ${d} не найден`);
    for (const id of m.moduleIds) if (!s.getModule(id)) throw new Error(`модуль ${id} не найден`);
    const saved = s.audit.saveMatrix(m);
    this.auditChanged(projectId);
    return saved;
  }

  private matrixOf(s: ProjectStore, matrixId: string): Matrix {
    const m = s.audit.getMatrix(matrixId);
    if (!m) throw new Error(`матрица ${matrixId} не найдена`);
    return m;
  }

  /** Modules (empty list = all current) and current requirements of a matrix. */
  private matrixScope(s: ProjectStore, matrix: Matrix): { modules: Module[]; requirements: (RequirementItem & { documentTitle: string })[] } {
    const modules = matrix.moduleIds.length ? matrix.moduleIds.map((id) => s.getModule(id)).filter((m): m is Module => Boolean(m)) : s.listModules();
    return { modules, requirements: s.audit.currentItems(matrix.documentIds) };
  }

  /** Matrices whose cells include `c` (by name). */
  private matricesOfCell(s: ProjectStore, c: CellRef): Matrix[] {
    const doc = s.audit.requirementDocument(c.requirementId);
    return s.audit
      .listMatrices()
      .filter((m) => doc && m.documentIds.includes(doc) && (m.moduleIds.length ? m.moduleIds.includes(c.moduleId) : Boolean(s.getModule(c.moduleId))));
  }

  /** Queued or running matrix jobs by the cells they cover. */
  private busyCells(projectId: string): Map<string, { id: string; status: Job['status'] }> {
    const out = new Map<string, { id: string; status: Job['status'] }>();
    for (const j of this.store(projectId).activeJobs()) {
      for (const c of matrixPayload(j)?.cells ?? []) out.set(c, { id: j.id, status: j.status });
    }
    return out;
  }

  private cellContext(projectId: string, head: string) {
    const a = this.store(projectId).audit;
    return { head, verdicts: a.latestVerdicts(), triage: a.latestTriage(), counts: a.findingCounts(), busy: this.busyCells(projectId) };
  }

  /** Current state of a cell: latest verdict, staleness by code (validity at HEAD) and by requirement text. */
  private async cellState(
    projectId: string,
    ref: CellRef,
    item: RequirementItem | undefined,
    ctx: ReturnType<Core['cellContext']>,
  ): Promise<{ cell: Cell; changed: string[] }> {
    const id = cellId(ref);
    const v = ctx.verdicts.get(id) ?? null;
    const t = ctx.triage.get(id);
    const hash = item ? reqHash(item.text) : null;
    const reasons: StaleReason[] = [];
    let changed: string[] = [];
    if (v) {
      if (v.reqHash !== hash) reasons.push('requirement');
      const val = await this.validityOf(projectId, VERDICT_VALIDITY, v.id, v.commitSha, v.touchedFiles, v.moduleGlobs, ctx.head);
      if (!val.valid) {
        reasons.push('code');
        changed = val.changedFiles;
      }
    }
    return {
      cell: {
        ...ref,
        status: v?.status ?? 'not_checked',
        stale: reasons.length > 0,
        staleReasons: reasons,
        triaged: !v && Boolean(t?.applicable && t.reqHash === hash),
        verdict: v,
        findingCount: ctx.counts.get(id) ?? 0,
        activeJob: ctx.busy.get(id) ?? null,
      },
      changed,
    };
  }

  async matrixView(projectId: string, matrixId: string): Promise<MatrixView> {
    const s = this.store(projectId);
    const matrix = this.matrixOf(s, matrixId);
    const head = await headSha(this.project(projectId).root);
    const { modules, requirements } = this.matrixScope(s, matrix);
    const ctx = this.cellContext(projectId, head);
    const cells: Cell[] = [];
    for (const r of requirements) {
      for (const m of modules) cells.push((await this.cellState(projectId, { moduleId: m.id, requirementId: r.requirementId }, r, ctx)).cell);
    }
    return { matrix, head, modules, requirements, cells };
  }

  async cellDetails(projectId: string, id: string, matrixId?: string): Promise<CellDetails> {
    const ref = parseCellId(id);
    const s = this.store(projectId);
    const a = s.audit;
    const head = await headSha(this.project(projectId).root);
    const item = a.currentItem(ref.requirementId);
    const module = s.getModule(ref.moduleId) ?? null;
    const { cell, changed } = await this.cellState(projectId, ref, item, this.cellContext(projectId, head));
    const doc = a.requirementDocument(ref.requirementId);
    const findings = a.findingsOfCell(ref);
    const matrix = matrixId ? a.getMatrix(matrixId) : this.matricesOfCell(s, ref)[0];
    let config: EffectiveConfigView | null = null;
    if (module) {
      try {
        config = this.effectiveView(projectId, this.taskRole(projectId, STAGE_TASK.verdicts), module.name, { matrix: matrix?.name, item: item?.key });
      } catch {
        config = null;
      }
    }
    return {
      cell,
      module,
      requirement: item ? { ...item, documentTitle: (doc && a.getDocumentTitle(doc)) || '' } : null,
      verdicts: a.verdictHistory(ref).map((v) => ({ ...v, run: v.runId ? (s.getRun(v.runId) ?? null) : null })),
      triage: a.triageHistory(ref),
      findings,
      findingEvents: findings
        .flatMap((f) => a.findingEvents(f.id))
        .filter((e) => e.kind !== 'link' || (e.cell && cellId(e.cell) === id))
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt)),
      changedFiles: changed,
      config,
    };
  }

  /** Cells of a matrix a stage would cover: triage — never triaged and not checked; verdicts — not checked or stale. */
  private async stageCells(projectId: string, matrix: Matrix, stage: MatrixStage, scope: MatrixScope): Promise<{ free: CellRef[]; busy: number }> {
    const view = await this.matrixView(projectId, matrix.id);
    const want = view.cells.filter((c) =>
      stage === 'triage' ? c.status === 'not_checked' && !c.triaged : scope === 'stale' ? c.stale : c.status === 'not_checked',
    );
    return {
      free: want.filter((c) => !c.activeJob).map((c) => ({ moduleId: c.moduleId, requirementId: c.requirementId })),
      busy: want.filter((c) => c.activeJob).length,
    };
  }

  /** Sessions for cells: verdicts — one per module x group (cells with their own cascade level alone); triage — per module. */
  private planCells(projectId: string, stage: MatrixStage, cells: CellRef[]): Batch[] {
    const s = this.store(projectId);
    const settings = this.projectSettings(projectId);
    const itemLevels = new Set(Object.keys(loadConfigFile(projectConfigPath(this.project(projectId).root)).data.requirements ?? {}));
    const bc: BatchCell[] = cells.map((c) => {
      const item = s.audit.currentItem(c.requirementId);
      return { ...c, group: item?.section || '—', alone: stage === 'verdicts' && Boolean(item && itemLevels.has(item.key)) };
    });
    return stage === 'triage' ? planBatches(bc, settings.matrix.triage_batch_size, false) : planBatches(bc, settings.matrix.batch_size);
  }

  /** Average billable tokens per cell over recent successful runs of the role, or null without history. */
  private historyTokensPerCell(projectId: string, role: string, stage: MatrixStage, limit: number): number | null {
    const s = this.store(projectId);
    let tokensSum = 0;
    let cells = 0;
    for (const r of s.recentRuns(role, limit)) {
      const rows = stage === 'triage' ? s.audit.triageOfRuns([r.id]) : s.audit.verdictsOfRuns([r.id]);
      const n = new Set(rows.map((x) => cellId(x))).size;
      if (!n) continue;
      tokensSum += billableTokens(r.usage);
      cells += n;
    }
    return cells ? Math.round(tokensSum / cells) : null;
  }

  private estimateOf(projectId: string, stage: MatrixStage, batches: Batch[], busy: number): MatrixEstimate {
    const s = this.store(projectId);
    const settings = this.projectSettings(projectId);
    const role = this.taskRole(projectId, STAGE_TASK[stage]);
    const hist = this.historyTokensPerCell(projectId, role, stage, settings.matrix.estimate_history_runs);
    const tpc = hist ?? settings.matrix.estimate_tokens_per_cell[stage];
    const cells = batches.reduce((n, b) => n + b.cells.length, 0);
    return {
      stage,
      role,
      sessions: batches.length,
      cells,
      tokensPerCell: tpc,
      tokensPerCellSource: hist === null ? 'config' : 'history',
      tokens: cells * tpc,
      maxTokensPerRun: settings.limits.max_tokens_per_run,
      batches: batches.map((b) => ({
        moduleId: b.moduleId,
        moduleName: s.getModule(b.moduleId)?.name ?? b.moduleId,
        group: b.group,
        cells: b.cells.length,
        tokens: b.cells.length * tpc,
      })),
      busy,
    };
  }

  /** Dry-run estimate of a matrix stage (SPEC §7): sessions, cells and tokens, nothing is queued. */
  async estimateMatrix(projectId: string, matrixId: string, stage: MatrixStage, scope: MatrixScope): Promise<MatrixEstimate> {
    const matrix = this.matrixOf(this.store(projectId), matrixId);
    const { free, busy } = await this.stageCells(projectId, matrix, stage, scope);
    return this.estimateOf(projectId, stage, this.planCells(projectId, stage, free), busy);
  }

  /** Queues a matrix stage: one job per batch; cells already covered by queued/running jobs are skipped. */
  async runMatrix(projectId: string, matrixId: string, stage: MatrixStage, scope: MatrixScope): Promise<Job[]> {
    const matrix = this.matrixOf(this.store(projectId), matrixId);
    const { free } = await this.stageCells(projectId, matrix, stage, scope);
    if (!free.length) throw new Error('нет ячеек для проверки');
    return this.enqueueBatches(projectId, matrix, stage, this.planCells(projectId, stage, free));
  }

  /** Groups cells by matrix (given, else the first matrix containing the cell); busy and orphan cells are reported. */
  private recheckGroups(projectId: string, ids: string[], matrixId?: string): { groups: { matrix: Matrix; cells: CellRef[] }[]; busy: number } {
    const s = this.store(projectId);
    const busyMap = this.busyCells(projectId);
    const groups = new Map<string, { matrix: Matrix; cells: CellRef[] }>();
    let busy = 0;
    for (const id of uniq(ids)) {
      const c = parseCellId(id);
      if (!this.cellAlive(s, c)) throw new Error(`ячейка ${id} не найдена: модуль удалён или требование выведено`);
      if (busyMap.has(id)) {
        busy++;
        continue;
      }
      const matrix = matrixId ? this.matrixOf(s, matrixId) : this.matricesOfCell(s, c)[0];
      if (!matrix) throw new Error(`ячейка ${id} не входит ни в одну матрицу`);
      const g = groups.get(matrix.id) ?? { matrix, cells: [] };
      g.cells.push(c);
      groups.set(matrix.id, g);
    }
    return { groups: [...groups.values()], busy };
  }

  async estimateRecheck(projectId: string, cells: string[], matrixId?: string): Promise<MatrixEstimate> {
    const { groups, busy } = this.recheckGroups(projectId, cells, matrixId);
    return this.estimateOf(projectId, 'verdicts', groups.flatMap((g) => this.planCells(projectId, 'verdicts', g.cells)), busy);
  }

  /** Verdict re-check of cells; a single cell is its own session. */
  async recheckCells(projectId: string, cells: string[], matrixId?: string): Promise<Job[]> {
    const { groups, busy } = this.recheckGroups(projectId, cells, matrixId);
    if (!groups.length) throw new Error(busy ? 'эти ячейки уже в очереди' : 'нет ячеек для проверки');
    const jobs: Job[] = [];
    for (const g of groups) jobs.push(...(await this.enqueueBatches(projectId, g.matrix, 'verdicts', this.planCells(projectId, 'verdicts', g.cells))));
    return jobs;
  }

  private async enqueueBatches(projectId: string, matrix: Matrix, stage: MatrixStage, batches: Batch[]): Promise<Job[]> {
    const sha = await headSha(this.project(projectId).root);
    const jobs = batches.map((b) => {
      const t = this.renderMatrixTask(projectId, matrix, stage, b.cells);
      const id = crypto.randomUUID();
      const payload: MatrixPayload = { matrix_id: matrix.id, stage, cells: b.cells.map(cellId) };
      return this.addAgentJob(projectId, { ...t, entity: { type: MATRIX_BATCH_ENTITY, id }, payload: { ...payload } }, sha, id);
    });
    this.auditChanged(projectId);
    return jobs;
  }

  /** Title and prompt of a matrix job from `tasks.matrix_triage` / `tasks.matrix_verdicts`; all cells share a module. */
  private renderMatrixTask(projectId: string, matrix: Matrix, stage: MatrixStage, cells: CellRef[]): { role: string; title: string; prompt: string } {
    const s = this.store(projectId);
    const spec = this.taskSpec(projectId, STAGE_TASK[stage]);
    const mod = s.getModule(cells[0].moduleId);
    if (!mod) throw new Error(`модуль ${cells[0].moduleId} не найден`);
    const items = cells.map((c) => {
      const it = s.audit.currentItem(c.requirementId);
      if (!it) throw new Error(`требование ${c.requirementId} не найдено`);
      return it;
    });
    const vars = {
      project: this.project(projectId).name,
      matrix: matrix.name,
      module_id: mod.id,
      module_name: mod.name,
      module_globs: mod.globs.map((g) => `- ${g}`).join('\n'),
      module_description: mod.description || '(none)',
      group: stage === 'verdicts' ? items[0].section || '—' : '',
      requirements: items.map((i) => `- requirement_id \`${i.requirementId}\` — ${i.key}${i.section ? ` (${i.section})` : ''}: ${i.text}`).join('\n'),
    };
    return { role: spec.role, title: renderTemplate(spec.title, vars), prompt: renderTemplate(spec.template, vars, spec.file) };
  }

  /** Manual verdict (SPEC §6): a record authored by human at the working copy's HEAD. */
  async setVerdict(projectId: string, id: string, v: { status: VerdictStatus; reason: string; evidence: Evidence[] }): Promise<Verdict> {
    const p = this.project(projectId);
    const s = this.store(projectId);
    const ref = parseCellId(id);
    if (!VERDICT_STATUSES.includes(v.status)) throw new Error(`неизвестный статус ${v.status}`);
    const reason = v.reason.trim();
    if (!reason) throw new Error('укажите обоснование');
    const item = s.audit.currentItem(ref.requirementId);
    const mod = s.getModule(ref.moduleId);
    if (!item || !mod) throw new Error('ячейка не найдена: модуль удалён или требование выведено');
    const evidence = v.evidence.filter((e) => e.file.trim());
    if ((v.status === 'pass' || v.status === 'finding') && !evidence.length) throw new Error('для pass/finding нужны ссылки на код');
    for (const e of evidence) {
      const err = repoFileError(p.root, e.file);
      if (err) throw new Error(err);
    }
    const findings = s.audit.findingsOfCell(ref);
    if (v.status === 'finding' && !findings.length) throw new Error('сначала создайте или свяжите находку для этой ячейки');
    const touched = uniq([...evidence.map((e) => e.file), ...(v.status === 'finding' ? findings.flatMap((f) => f.files.map((x) => x.file)) : [])]).sort();
    const saved = s.audit.addVerdict(
      {
        ...ref,
        itemId: item.id,
        reqHash: reqHash(item.text),
        status: v.status,
        reason,
        evidence,
        commitSha: await headSha(p.root),
        touchedFiles: touched,
        moduleGlobs: mod.globs,
      },
      { author: 'human', runId: null },
    );
    this.auditChanged(projectId);
    return saved;
  }

  // --- findings (SPEC §4, Q9/Q23) ---

  listFindings(projectId: string): Finding[] {
    return this.store(projectId).audit.listFindings();
  }

  private cellLabel(s: ProjectStore, c: CellRef): CellLabel {
    const item = s.audit.currentItem(c.requirementId) ?? s.audit.latestItem(c.requirementId);
    return { ...c, moduleName: s.getModule(c.moduleId)?.name ?? null, key: item?.key ?? null, text: item?.text ?? null };
  }

  findingDetails(projectId: string, id: string): FindingDetails {
    const s = this.store(projectId);
    const a = s.audit;
    const finding = a.getFinding(id);
    if (!finding) throw new Error(`находка ${id} не найдена`);
    const events = a.findingEvents(id);
    const limit = this.projectSettings(projectId).findings.similar_limit;
    const runIds = uniq([finding.runId, ...events.map((e) => e.runId)].filter((x): x is string => Boolean(x)));
    const runs = uniq([...s.entityRuns(FINDING_ENTITY, id).map((r) => r.id), ...runIds])
      .map((r) => s.getRun(r))
      .filter((r): r is Run => Boolean(r))
      .sort((x, y) => y.startedAt.localeCompare(x.startedAt));
    return {
      finding,
      events,
      cells: finding.cells.map((c) => this.cellLabel(s, c)),
      similar: rankSimilar(finding, a.listFindings().filter((f) => f.id !== id), limit),
      runs,
    };
  }

  setFindingStatus(projectId: string, id: string, status: FindingStatus, reason: string): Finding {
    if (!FINDING_STATUSES.includes(status)) throw new Error(`неизвестный статус ${status}`);
    if ((status === 'false_positive' || status === 'accepted_risk') && !reason.trim()) throw new Error('укажите причину');
    const f = this.store(projectId).audit.setFindingStatus(id, status, reason.trim() || null, { author: 'human', runId: null });
    this.auditChanged(projectId);
    return f;
  }

  mergeFinding(projectId: string, sourceId: string, targetId: string): Finding {
    const f = this.store(projectId).audit.mergeFinding(sourceId, targetId, { author: 'human', runId: null });
    this.auditChanged(projectId);
    return f;
  }

  /** Manual finding linked to a cell; file references must exist in the working copy. */
  createFinding(projectId: string, id: string, input: Omit<FindingInput, 'moduleId'>): Finding {
    const p = this.project(projectId);
    const s = this.store(projectId);
    const ref = parseCellId(id);
    if (!this.cellAlive(s, ref)) throw new Error('ячейка не найдена');
    if (!input.title.trim()) throw new Error('укажите заголовок');
    for (const e of input.files) {
      const err = repoFileError(p.root, e.file);
      if (err) throw new Error(err);
    }
    const f = s.audit.createFinding({ ...input, title: input.title.trim(), moduleId: ref.moduleId }, [ref], { author: 'human', runId: null });
    this.auditChanged(projectId);
    return f;
  }

  linkFinding(projectId: string, findingId: string, id: string): Finding {
    const s = this.store(projectId);
    const ref = parseCellId(id);
    if (!this.cellAlive(s, ref)) throw new Error('ячейка не найдена');
    const f = s.audit.linkFinding(findingId, ref, { author: 'human', runId: null });
    this.auditChanged(projectId);
    return f;
  }

  /** "Открыть сессию для фикса": interactive session in the working directory with the finding as the initial prompt. */
  async openFixSession(projectId: string, findingId: string): Promise<string> {
    const p = this.project(projectId);
    const s = this.store(projectId);
    let f = s.audit.getFinding(findingId);
    if (!f) throw new Error(`находка ${findingId} не найдена`);
    while (f.mergedInto) f = s.audit.getFinding(f.mergedInto)!;
    const spec = this.taskSpec(projectId, 'fix');
    const cfg = this.resolve(projectId, spec.role);
    if (cfg.role.kind !== 'interactive') throw new ConfigError(`tasks.fix: роль ${spec.role} не интерактивная`);
    const fl = f;
    const vars = {
      project: p.name,
      finding_id: fl.id,
      title: fl.title,
      severity: fl.severity,
      cwe: fl.cwe ?? '—',
      description: fl.description,
      files: fl.files.map((e) => `- ${e.file}${e.line ? `:${e.line}` : ''}${e.note ? ` — ${e.note}` : ''}`).join('\n'),
      recommendation: fl.recommendation ?? '—',
      cells: fl.cells.map((c) => this.cellLabel(s, c)).map((l) => `- ${l.key ?? l.requirementId}: ${l.text ?? ''} (модуль ${l.moduleName ?? l.moduleId})`).join('\n') || '—',
    };
    return this.spawnInteractive(projectId, {
      role: spec.role,
      sessionId: crypto.randomUUID(),
      resume: false,
      cwd: p.root,
      commitSha: await headSha(p.root),
      parentRunId: null,
      entity: { type: FINDING_ENTITY, id: fl.id },
      scope: [],
      cfg,
      prompt: renderTemplate(spec.template, vars, spec.file),
      title: `✎ ${renderTemplate(spec.title, vars)}`,
    });
  }

  // --- background execution ---

  private async execute(job: Job, signal: AbortSignal): Promise<JobOutcome> {
    if (job.type !== AGENT_JOB) return { kind: 'failed', error: `неизвестный тип задачи ${job.type}` };
    const p = this.project(job.projectId);
    const s = this.store(job.projectId);
    const prep = this.prepareJob(job);
    if (!prep) return { kind: 'done' };
    job = prep.job;
    const cfg = this.resolveForJob(job);
    const sha = String(job.payload.commit_sha);
    // Requirement extraction reads the stored document; everything else runs in a worktree at the job's commit.
    const cwd = job.entityType === DOC_VERSION_ENTITY ? this.docDir(p.id, job.entityId) : await this.worktreeCache(p).ensure(sha);
    if (signal.aborted) return { kind: signal.reason === 'taken_over' ? 'taken_over' : 'cancelled' };

    const runId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const dir = projectDataDir(this.paths, p.id);
    const logPath = path.join(dir, 'logs', `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const scope = prep.scope;
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
        scope,
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
      const res = await this.runClaudeProcess(cmd, cwd, prep.prompt, {
        signal,
        logPath,
        terminalId,
        maxTokens: cfg.settings.limits.max_tokens_per_run,
      });
      this.finishRun(p.id, runId, res.status, res.usage, res.error);
      switch (res.status) {
        case 'succeeded': {
          const missing = this.missingOutputs(job);
          return missing ? { kind: 'failed', error: missing } : { kind: 'done' };
        }
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
      this.finishRun(p.id, runId, 'failed', zeroUsage(), (e as Error).message);
      throw e;
    } finally {
      this.tokens.revoke(grant.token);
      this.mcp.forgetRun(runId);
      fs.rmSync(mcpPath, { force: true });
      this.terminals.markEnded(terminalId);
      this.activeRuns.delete(job.id);
      resolveDone();
      this.send({ type: 'runs-changed', projectId: p.id });
    }
  }

  /**
   * What a job's run covers. Matrix jobs are atomic per cell (SPEC §7): a re-run (after a crash, failure or retry)
   * covers only the cells earlier runs of the job left without a result. Null when nothing is left to do.
   */
  private prepareJob(job: Job): { job: Job; scope: EntityRef[]; prompt: string } | null {
    const mp = matrixPayload(job);
    if (!mp) return { job, scope: [{ type: job.entityType, id: job.entityId }], prompt: String(job.payload.prompt) };
    const s = this.store(job.projectId);
    const covered = this.coveredCells(job, mp.stage);
    const remaining = mp.cells.filter((c) => !covered.has(c) && this.cellAlive(s, parseCellId(c)));
    if (!remaining.length) return null;
    if (remaining.length !== mp.cells.length) {
      const matrix = s.audit.getMatrix(mp.matrix_id);
      if (!matrix) throw new Error(`матрица ${mp.matrix_id} не найдена`);
      const t = this.renderMatrixTask(job.projectId, matrix, mp.stage, remaining.map(parseCellId));
      s.setJobPayload(job.id, { ...job.payload, cells: remaining, prompt: t.prompt });
      job = s.getJob(job.id)!;
    }
    return { job, scope: remaining.map((id) => ({ type: CELL_ENTITY, id })), prompt: String(job.payload.prompt) };
  }

  /** Cells that runs of a matrix job already wrote a result for (verdict, or triage mark for the triage stage). */
  private coveredCells(job: Job, stage: MatrixStage): Set<string> {
    const s = this.store(job.projectId);
    const runIds = s.jobRuns(job.id).map((r) => r.id);
    const rows = stage === 'triage' ? s.audit.triageOfRuns(runIds) : s.audit.verdictsOfRuns(runIds);
    return new Set(rows.map((r) => cellId(r)));
  }

  private cellAlive(s: ProjectStore, c: CellRef): boolean {
    return Boolean(s.getModule(c.moduleId) && s.audit.currentItem(c.requirementId));
  }

  /** A successful matrix run that left cells without a result fails, so "retry" re-runs only those cells. */
  private missingOutputs(job: Job): string | null {
    const mp = matrixPayload(job);
    if (!mp) return null;
    const covered = this.coveredCells(job, mp.stage);
    const s = this.store(job.projectId);
    const left = mp.cells.filter((c) => !covered.has(c) && this.cellAlive(s, parseCellId(c)));
    return left.length ? `прогон завершился, но без результата осталось ячеек: ${left.length}; «Повторить» перезапустит только их` : null;
  }

  /** Finalizes a run together with what it was building: entry point snapshots, requirement extraction. */
  private finishRun(projectId: string, runId: string, status: RunStatus, usage: TokenUsage, error: string | null): void {
    const s = this.store(projectId);
    s.finishRun(runId, status, usage, error);
    const ok = status === 'succeeded' || status === 'exited';
    s.finalizeSnapshots(runId, ok);
    const run = s.getRun(runId);
    if (run?.entityType === DOC_VERSION_ENTITY && run.entityId) {
      const v = s.audit.getVersion(run.entityId);
      if (v && (v.status === 'extracting' || v.status === 'failed')) s.audit.setVersionStatus(v.id, ok ? 'review' : 'failed');
    }
    this.send({ type: 'modules-changed', projectId });
    this.send({ type: 'audit-changed', projectId });
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
      scope: run.scope,
      cfg: this.resumeConfig(projectId, run),
      title: `↺ ${run.role} ${run.sessionId.slice(0, 8)}`,
    });
  }

  /** A resumed session gets the cascade levels of its job (module, matrix, item); falls back to the role. */
  private resumeConfig(projectId: string, run: Run): EffectiveConfig | undefined {
    const job = run.jobId ? this.store(projectId).getJob(run.jobId) : undefined;
    try {
      return job ? this.resolveForJob(job) : undefined;
    } catch {
      return undefined;
    }
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
    o: InteractiveSpec,
    external: boolean,
  ): { runId: string; cmd: ClaudeCommand; token: string; mcpPath: string } {
    const cfg = o.cfg ?? this.resolve(projectId, o.role);
    const runId = crypto.randomUUID();
    const scope = o.scope ?? (o.entity ? [o.entity] : []);
    const grant = this.tokens.issue({
      projectId,
      role: o.role,
      access: cfg.role.mcp_access,
      sessionId: o.sessionId,
      runId,
      scope,
    });
    const mcpPath = this.writeMcpConfig(projectId, runId, grant.token);
    const cmd = interactiveCommand(cfg, { sessionId: o.sessionId, resume: o.resume, mcpConfigPath: mcpPath, prompt: o.prompt });
    const s = this.store(projectId);
    s.startRun(
      {
        parentRunId: o.parentRunId,
        kind: 'interactive',
        role: o.role,
        author: 'human',
        entityType: o.entity?.type,
        entityId: o.entity?.id,
        scope,
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

  private spawnInteractive(projectId: string, o: InteractiveSpec & { title: string }): string {
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
        this.mcp.forgetRun(runId);
        fs.rmSync(mcpPath, { force: true });
        this.finishRun(projectId, runId, 'exited', zeroUsage(), code === 0 ? null : `код выхода ${code}`);
        this.send({ type: 'runs-changed', projectId });
        if (o.cwd === p.root) void this.checkCommits(projectId, o.commitSha, o.entity);
      },
    });
    this.liveSessions.set(o.sessionId, terminalId);
    return terminalId;
  }

  /** After a session in the user's working directory: if it committed, offer re-checks of linked cells (SPEC §1, Q22). */
  private async checkCommits(projectId: string, before: string, entity: EntityRef | null): Promise<void> {
    try {
      const after = await headSha(this.project(projectId).root);
      if (after === before) return;
      const text = `Сессия изменила HEAD: ${before.slice(0, 8)} → ${after.slice(0, 8)}.`;
      const offer = await this.recheckOffer(projectId, before, after, entity?.type === FINDING_ENTITY ? entity.id : null);
      if (offer) this.notice('info', `${text} ${offer.reason}`, projectId, offer);
      else this.notice('info', `${text} Связанных ячеек матрицы нет.`, projectId);
    } catch {
      /* repository may be mid-rebase; nothing to report */
    }
  }

  /** Cells whose verdicts depend on files the commits changed, plus the cells of the fixed finding. */
  private async recheckOffer(projectId: string, before: string, after: string, findingId: string | null): Promise<RecheckOffer | null> {
    const s = this.store(projectId);
    const diff = (await changedFiles(this.project(projectId).root, before, after)) ?? [];
    const affected = [...s.audit.latestVerdicts().values()]
      .filter((v) => affectingChanges(diff, v.touchedFiles, v.moduleGlobs).length > 0)
      .map((v) => cellId(v));
    const linked = findingId ? (s.audit.getFinding(findingId)?.cells ?? []).map(cellId) : [];
    const cells = uniq([...linked, ...affected]).filter((c) => this.cellAlive(s, parseCellId(c)) && this.matricesOfCell(s, parseCellId(c)).length);
    if (!cells.length) return null;
    const parts = [
      linked.length ? `связанных с находкой: ${linked.length}` : '',
      affected.length ? `затронутых изменениями: ${affected.length}` : '',
    ].filter(Boolean);
    return { cells, reason: `Предлагается перепроверить ячейки матрицы (${parts.join(', ')}).` };
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
      {
        role: run.role,
        sessionId: run.sessionId,
        resume: true,
        cwd,
        commitSha: run.commitSha,
        parentRunId: run.id,
        entity,
        scope: run.scope,
        cfg: this.resumeConfig(projectId, run),
      },
      true,
    );
    // The external process is not tracked; its run record is finalized right away.
    this.finishRun(projectId, newRunId, 'exited', zeroUsage(), null);
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

interface InteractiveSpec {
  role: string;
  sessionId: string;
  resume: boolean;
  cwd: string;
  commitSha: string;
  parentRunId: string | null;
  entity: EntityRef | null;
  /** Entities the token may write; default: the entity. */
  scope?: EntityRef[];
  /** Config to run with; default: the role's. */
  cfg?: EffectiveConfig;
  /** Initial prompt of a new session. */
  prompt?: string;
}

/** Used only by the synchronous MCP enqueue path; the UI resolves HEAD asynchronously. */
function execFileSyncHead(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}
