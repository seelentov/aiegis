import crypto from 'node:crypto';
import type { DB } from './db';
import type {
  EntryPoint,
  EntryPointInput,
  EntryPointSnapshot,
  Job,
  JobStatus,
  Module,
  ModuleRevision,
  ResultRecord,
  Run,
  RunKind,
  RunStatus,
  SnapshotStatus,
  TokenUsage,
} from '../shared/types';
import { AuditStore } from './audit-store';
import { entryPointKey, touchedFiles } from './modules';

const now = () => new Date().toISOString();

type Row = Record<string, unknown>;

function toJob(projectId: string, r: Row): Job {
  return {
    id: r.id as string,
    projectId,
    type: r.type as string,
    role: r.role as string,
    title: r.title as string,
    entityType: r.entity_type as string,
    entityId: r.entity_id as string,
    payload: JSON.parse(r.payload as string),
    status: r.status as JobStatus,
    error: (r.error as string) ?? null,
    lastRunId: (r.last_run_id as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toRun(projectId: string, r: Row): Run {
  return {
    id: r.id as string,
    projectId,
    jobId: (r.job_id as string) ?? null,
    parentRunId: (r.parent_run_id as string) ?? null,
    kind: r.kind as RunKind,
    role: r.role as string,
    author: r.author as string,
    entityType: (r.entity_type as string) ?? null,
    entityId: (r.entity_id as string) ?? null,
    scope: r.scope ? JSON.parse(r.scope as string) : r.entity_type ? [{ type: r.entity_type, id: r.entity_id }] : [],
    sessionId: r.session_id as string,
    cwd: r.cwd as string,
    commitSha: r.commit_sha as string,
    configSnapshot: JSON.parse(r.config_snapshot as string),
    logPath: (r.log_path as string) ?? null,
    status: r.status as RunStatus,
    error: (r.error as string) ?? null,
    usage: {
      input: r.tokens_input as number,
      output: r.tokens_output as number,
      cacheCreation: r.tokens_cache_creation as number,
      cacheRead: r.tokens_cache_read as number,
      costUsd: r.cost_usd as number,
    },
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

function toRevision(r: Row): ModuleRevision {
  return {
    id: r.id as string,
    moduleId: r.module_id as string,
    name: r.name as string,
    globs: JSON.parse(r.globs as string),
    description: r.description as string,
    deleted: Boolean(r.deleted),
    reason: (r.reason as string) ?? null,
    runId: (r.run_id as string) ?? null,
    author: r.author as string,
    createdAt: r.created_at as string,
  };
}

function toModule(r: ModuleRevision): Module {
  return {
    id: r.moduleId,
    name: r.name,
    globs: r.globs,
    description: r.description,
    author: r.author,
    runId: r.runId,
    updatedAt: r.createdAt,
  };
}

function toSnapshot(r: Row): EntryPointSnapshot {
  return {
    id: r.id as string,
    moduleId: r.module_id as string,
    runId: r.run_id as string,
    commitSha: r.commit_sha as string,
    globs: JSON.parse(r.globs as string),
    status: r.status as SnapshotStatus,
    touchedFiles: r.touched_files ? JSON.parse(r.touched_files as string) : null,
    entryCount: r.entry_count as number,
    createdAt: r.created_at as string,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

function toEntryPoint(r: Row): EntryPoint {
  const d = JSON.parse(r.data as string);
  return {
    id: r.id as string,
    snapshotId: r.snapshot_id as string,
    key: r.key as string,
    kind: r.kind as EntryPoint['kind'],
    method: (r.method as string) ?? null,
    name: r.name as string,
    handler: { file: r.handler_file as string, line: r.handler_line as number },
    middleware: d.middleware,
    auth: d.auth,
    params: d.params,
    callChain: d.callChain,
    notes: d.notes ?? null,
    updatedAt: r.updated_at as string,
  };
}

const SNAPSHOT_SELECT = `SELECT s.*, (SELECT COUNT(*) FROM entry_points e WHERE e.snapshot_id = s.id) AS entry_count FROM ep_snapshots s`;

/** Who wrote a module revision. */
export interface Authorship {
  author: string;
  runId: string | null;
}

export interface NewJob {
  type: string;
  role: string;
  title: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
}

export interface NewRun {
  jobId?: string | null;
  parentRunId?: string | null;
  kind: RunKind;
  role: string;
  author: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Entities the token may write; defaults to the entity. */
  scope?: { type: string; id: string }[];
  sessionId: string;
  cwd: string;
  commitSha: string;
  configSnapshot: unknown;
  logPath?: string | null;
}

/** Per-project persistence on top of db.sqlite. */
export class ProjectStore {
  /** Documents, requirements, matrix cells and findings. */
  readonly audit: AuditStore;

  constructor(
    readonly projectId: string,
    readonly db: DB,
  ) {
    this.audit = new AuditStore(db);
  }

  // --- jobs ---

  addJob(j: NewJob, id: string = crypto.randomUUID()): Job {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO jobs (id, type, role, title, entity_type, entity_id, payload, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, j.type, j.role, j.title, j.entityType, j.entityId, JSON.stringify(j.payload), t, t);
    return this.getJob(id)!;
  }

  getJob(id: string): Job | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return r && toJob(this.projectId, r);
  }

  listJobs(limit = 500): Job[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map((r) =>
      toJob(this.projectId, r),
    );
  }

  queuedJobs(): Job[] {
    return (this.db.prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid`).all() as Row[]).map(
      (r) => toJob(this.projectId, r),
    );
  }

  setJobStatus(id: string, status: JobStatus, error: string | null = null): void {
    this.db.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error, now(), id);
  }

  setJobPayload(id: string, payload: Record<string, unknown>): void {
    this.db.prepare('UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(payload), now(), id);
  }

  /** Queued and running jobs (any entity). */
  activeJobs(): Job[] {
    return (this.db.prepare(`SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at`).all() as Row[]).map((r) =>
      toJob(this.projectId, r),
    );
  }

  /** Runs started for a job, oldest first. */
  jobRuns(jobId: string): Run[] {
    return (this.db.prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY started_at, rowid').all(jobId) as Row[]).map((r) =>
      toRun(this.projectId, r),
    );
  }

  /** Latest finished successful background runs of a role (dry-run estimates). */
  recentRuns(role: string, limit: number): Run[] {
    return (
      this.db
        .prepare(`SELECT * FROM runs WHERE role = ? AND kind = 'background' AND status = 'succeeded' ORDER BY started_at DESC LIMIT ?`)
        .all(role, limit) as Row[]
    ).map((r) => toRun(this.projectId, r));
  }

  setJobRun(id: string, runId: string): void {
    this.db.prepare('UPDATE jobs SET last_run_id = ?, updated_at = ? WHERE id = ?').run(runId, now(), id);
  }

  /** After a crash, jobs left "running" are put back in the queue. */
  recoverJobs(): number {
    return this.db.prepare(`UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'`).run(now()).changes;
  }

  // --- runs ---

  startRun(r: NewRun, id: string = crypto.randomUUID()): Run {
    this.db
      .prepare(
        `INSERT INTO runs (id, job_id, parent_run_id, kind, role, author, entity_type, entity_id, scope, session_id, cwd,
                           commit_sha, config_snapshot, log_path, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        id,
        r.jobId ?? null,
        r.parentRunId ?? null,
        r.kind,
        r.role,
        r.author,
        r.entityType ?? null,
        r.entityId ?? null,
        JSON.stringify(r.scope ?? (r.entityType && r.entityId ? [{ type: r.entityType, id: r.entityId }] : [])),
        r.sessionId,
        r.cwd,
        r.commitSha,
        JSON.stringify(r.configSnapshot),
        r.logPath ?? null,
        now(),
      );
    return this.getRun(id)!;
  }

  finishRun(id: string, status: RunStatus, usage: TokenUsage, error: string | null = null): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, error = ?, tokens_input = ?, tokens_output = ?, tokens_cache_creation = ?,
                tokens_cache_read = ?, cost_usd = ?, finished_at = ? WHERE id = ? AND finished_at IS NULL`,
      )
      .run(status, error, usage.input, usage.output, usage.cacheCreation, usage.cacheRead, usage.costUsd, now(), id);
  }

  /** Runs still marked running after a crash are finalized as interrupted. */
  recoverRuns(): number {
    return this.db
      .prepare(`UPDATE runs SET status = 'interrupted', finished_at = ? WHERE finished_at IS NULL`)
      .run(now()).changes;
  }

  getRun(id: string): Run | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r && toRun(this.projectId, r);
  }

  listRuns(limit = 500): Run[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map(
      (r) => toRun(this.projectId, r),
    );
  }

  // --- results ---

  addResult(r: Omit<ResultRecord, 'id' | 'createdAt'>): ResultRecord {
    const id = crypto.randomUUID();
    const t = now();
    this.db
      .prepare('INSERT INTO results (id, run_id, entity_type, entity_id, data, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, r.runId, r.entityType, r.entityId, JSON.stringify(r.data), r.author, t);
    return { ...r, id, createdAt: t };
  }

  listResults(filter: { runId?: string; entityType?: string; entityId?: string } = {}): ResultRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.runId) (where.push('run_id = ?'), args.push(filter.runId));
    if (filter.entityType) (where.push('entity_type = ?'), args.push(filter.entityType));
    if (filter.entityId) (where.push('entity_id = ?'), args.push(filter.entityId));
    const sql = `SELECT * FROM results ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, rowid`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => ({
      id: r.id as string,
      runId: r.run_id as string,
      entityType: r.entity_type as string,
      entityId: r.entity_id as string,
      data: JSON.parse(r.data as string),
      author: r.author as string,
      createdAt: r.created_at as string,
    }));
  }

  /** A queued or running job of the entity, if any. */
  activeJobFor(entityType: string, entityId: string): Job | undefined {
    const r = this.db
      .prepare(`SELECT * FROM jobs WHERE entity_type = ? AND entity_id = ? AND status IN ('queued', 'running') ORDER BY created_at LIMIT 1`)
      .get(entityType, entityId) as Row | undefined;
    return r && toJob(this.projectId, r);
  }

  /** Latest job of the entity in any status. */
  latestJobFor(entityType: string, entityId: string): Job | undefined {
    const r = this.db
      .prepare(`SELECT * FROM jobs WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(entityType, entityId) as Row | undefined;
    return r && toJob(this.projectId, r);
  }

  /** Runs of an entity (newest first): e.g. fix sessions of a finding. */
  entityRuns(entityType: string, entityId: string): Run[] {
    return (
      this.db.prepare('SELECT * FROM runs WHERE entity_type = ? AND entity_id = ? ORDER BY started_at DESC, rowid DESC').all(entityType, entityId) as Row[]
    ).map((r) => toRun(this.projectId, r));
  }

  // --- modules ---

  private latestRevisions(): ModuleRevision[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM module_revisions r
           WHERE rowid = (SELECT MAX(rowid) FROM module_revisions WHERE module_id = r.module_id) ORDER BY name`,
        )
        .all() as Row[]
    ).map(toRevision);
  }

  listModules(): Module[] {
    return this.latestRevisions()
      .filter((r) => !r.deleted)
      .map(toModule);
  }

  /** Current module; undefined if unknown or deleted. */
  getModule(id: string): Module | undefined {
    const r = this.db
      .prepare('SELECT * FROM module_revisions WHERE module_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(id) as Row | undefined;
    const rev = r && toRevision(r);
    return rev && !rev.deleted ? toModule(rev) : undefined;
  }

  moduleByName(name: string): Module | undefined {
    return this.listModules().find((m) => m.name === name);
  }

  moduleHistory(id: string): ModuleRevision[] {
    return (this.db.prepare('SELECT * FROM module_revisions WHERE module_id = ? ORDER BY rowid DESC').all(id) as Row[]).map(
      toRevision,
    );
  }

  /**
   * Creates a module (no id) or appends a revision to an existing one.
   * Names are unique among live modules; an unchanged module gets no new revision.
   */
  saveModule(m: { id?: string; name: string; globs: string[]; description: string }, by: Authorship): Module {
    const name = m.name.trim();
    if (!name) throw new Error('пустое имя модуля');
    const clash = this.moduleByName(name);
    if (clash && clash.id !== m.id) throw new Error(`модуль с именем ${name} уже есть`);
    const cur = m.id ? this.getModule(m.id) : undefined;
    if (m.id && !cur) throw new Error(`модуль ${m.id} не найден`);
    const same = cur && cur.name === name && cur.description === m.description && JSON.stringify(cur.globs) === JSON.stringify(m.globs);
    if (same) return cur;
    const id = m.id ?? crypto.randomUUID();
    this.insertRevision({ moduleId: id, name, globs: m.globs, description: m.description, deleted: false, reason: null }, by);
    return this.getModule(id)!;
  }

  removeModule(id: string, reason: string, by: Authorship): void {
    const cur = this.getModule(id);
    if (!cur) throw new Error(`модуль ${id} не найден`);
    this.insertRevision({ moduleId: id, name: cur.name, globs: cur.globs, description: cur.description, deleted: true, reason }, by);
  }

  private insertRevision(
    r: { moduleId: string; name: string; globs: string[]; description: string; deleted: boolean; reason: string | null },
    by: Authorship,
  ): void {
    this.db
      .prepare(
        `INSERT INTO module_revisions (id, module_id, name, globs, description, deleted, reason, run_id, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), r.moduleId, r.name, JSON.stringify(r.globs), r.description, r.deleted ? 1 : 0, r.reason, by.runId, by.author, now());
  }

  // --- entry point snapshots ---

  getSnapshot(id: string): EntryPointSnapshot | undefined {
    const r = this.db.prepare(`${SNAPSHOT_SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
    return r && toSnapshot(r);
  }

  snapshotOf(runId: string, moduleId: string): EntryPointSnapshot | undefined {
    const r = this.db.prepare(`${SNAPSHOT_SELECT} WHERE s.run_id = ? AND s.module_id = ?`).get(runId, moduleId) as Row | undefined;
    return r && toSnapshot(r);
  }

  /** Newest first. */
  listSnapshots(moduleId: string): EntryPointSnapshot[] {
    return (this.db.prepare(`${SNAPSHOT_SELECT} WHERE s.module_id = ? ORDER BY s.created_at DESC, s.rowid DESC`).all(moduleId) as Row[]).map(
      toSnapshot,
    );
  }

  /** Current map of a module = its latest complete snapshot. */
  latestSnapshot(moduleId: string): EntryPointSnapshot | undefined {
    return this.listSnapshots(moduleId).find((s) => s.status === 'complete');
  }

  /**
   * Snapshot a run writes into, created on first write. A run that resumes another run's session
   * (parent_run_id) starts from the parent's snapshot so it can correct it instead of starting over.
   */
  ensureSnapshot(run: Run, moduleId: string): EntryPointSnapshot {
    const existing = this.snapshotOf(run.id, moduleId);
    if (existing) return existing;
    const mod = this.getModule(moduleId);
    if (!mod) throw new Error(`модуль ${moduleId} не найден`);
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO ep_snapshots (id, module_id, run_id, commit_sha, globs, status, created_at) VALUES (?, ?, ?, ?, ?, 'building', ?)`)
        .run(id, moduleId, run.id, run.commitSha, JSON.stringify(mod.globs), now());
      const parent = run.parentRunId ? this.snapshotOf(run.parentRunId, moduleId) : undefined;
      for (const e of parent ? this.listEntryPoints(parent.id) : []) this.upsertEntryPoint(id, e);
    })();
    return this.getSnapshot(id)!;
  }

  listEntryPoints(snapshotId: string): EntryPoint[] {
    return (this.db.prepare('SELECT * FROM entry_points WHERE snapshot_id = ? ORDER BY kind, name, method').all(snapshotId) as Row[]).map(
      toEntryPoint,
    );
  }

  upsertEntryPoint(snapshotId: string, e: EntryPointInput): EntryPoint {
    const key = entryPointKey(e);
    const data = JSON.stringify({ middleware: e.middleware, auth: e.auth, params: e.params, callChain: e.callChain, notes: e.notes });
    this.db
      .prepare(
        `INSERT INTO entry_points (id, snapshot_id, key, kind, method, name, handler_file, handler_line, data, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (snapshot_id, key) DO UPDATE SET handler_file = excluded.handler_file,
           handler_line = excluded.handler_line, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(crypto.randomUUID(), snapshotId, key, e.kind, e.method, e.name.trim(), e.handler.file, e.handler.line, data, now());
    return toEntryPoint(this.db.prepare('SELECT * FROM entry_points WHERE snapshot_id = ? AND key = ?').get(snapshotId, key) as Row);
  }

  removeEntryPoint(snapshotId: string, key: string): boolean {
    return this.db.prepare('DELETE FROM entry_points WHERE snapshot_id = ? AND key = ?').run(snapshotId, key).changes > 0;
  }

  /** Finalizes the snapshots a run was building: complete on success, failed otherwise. */
  finalizeSnapshots(runId: string, ok: boolean): void {
    const rows = this.db.prepare(`SELECT id FROM ep_snapshots WHERE run_id = ? AND status = 'building'`).all(runId) as { id: string }[];
    for (const { id } of rows) this.finalizeSnapshot(id, ok ? 'complete' : 'failed');
  }

  private finalizeSnapshot(id: string, status: SnapshotStatus): void {
    const files = touchedFiles(this.listEntryPoints(id));
    this.db
      .prepare('UPDATE ep_snapshots SET status = ?, touched_files = ?, finished_at = ? WHERE id = ?')
      .run(status, JSON.stringify(files), now(), id);
  }

  /** After a crash, snapshots of finalized runs that are still building are marked failed. */
  recoverSnapshots(): number {
    const rows = this.db
      .prepare(
        `SELECT s.id FROM ep_snapshots s JOIN runs r ON r.id = s.run_id
         WHERE s.status = 'building' AND r.finished_at IS NOT NULL`,
      )
      .all() as { id: string }[];
    for (const { id } of rows) this.finalizeSnapshot(id, 'failed');
    return rows.length;
  }
}
