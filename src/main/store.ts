import crypto from 'node:crypto';
import type { DB } from './db';
import type { Job, JobStatus, ResultRecord, Run, RunKind, RunStatus, TokenUsage } from '../shared/types';

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
  sessionId: string;
  cwd: string;
  commitSha: string;
  configSnapshot: unknown;
  logPath?: string | null;
}

/** Per-project persistence on top of db.sqlite. */
export class ProjectStore {
  constructor(
    readonly projectId: string,
    readonly db: DB,
  ) {}

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
        `INSERT INTO runs (id, job_id, parent_run_id, kind, role, author, entity_type, entity_id, session_id, cwd,
                           commit_sha, config_snapshot, log_path, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
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
}
