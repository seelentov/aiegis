import { EventEmitter } from 'node:events';
import type { Job, JobStatus, QueueState } from '../shared/types';
import { getLogger } from './log';

const log = getLogger('queue');

export type JobOutcome =
  | { kind: 'done' }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled' }
  | { kind: 'taken_over' }
  /** Subscription rate limit: job goes back to the queue, the whole queue pauses. `resetsAt` is epoch ms. */
  | { kind: 'rate_limited'; resetsAt?: number };

export type StopReason = 'cancelled' | 'taken_over';

const MAX_TIMER_MS = 2 ** 31 - 1;

export type Executor = (job: Job, signal: AbortSignal) => Promise<JobOutcome>;

/** Persistence the queue needs; implemented over all project stores. */
export interface QueueBackend {
  /** Queued jobs in FIFO order across projects. */
  queued(): Job[];
  setStatus(job: Job, status: JobStatus, error?: string | null): void;
}

export interface QueueOptions {
  parallelism: () => number;
  fallbackPauseMs: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

/** Single queue of background jobs (SPEC §7). Emits "changed" on any state change. */
export class JobQueue extends EventEmitter {
  private readonly running = new Map<string, { job: Job; ctrl: AbortController }>();
  private pausedUntilMs: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private pumping = false;
  private closed = false;

  constructor(
    private readonly backend: QueueBackend,
    private readonly executor: Executor,
    private readonly opts: QueueOptions,
  ) {
    super();
    this.now = opts.now ?? Date.now;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  state(): QueueState {
    return { pausedUntil: this.pausedUntilMs, parallelism: this.opts.parallelism(), running: this.running.size };
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  pauseUntil(ms: number): void {
    this.pausedUntilMs = Math.max(this.pausedUntilMs ?? 0, ms);
    this.armTimer();
    this.emit('changed');
  }

  private armTimer(): void {
    this.cancelTimer?.();
    // setTimeout overflows above 2^31-1 ms; long pauses re-arm from pump().
    const delay = Math.min(Math.max(0, this.pausedUntilMs! - this.now()), MAX_TIMER_MS);
    this.cancelTimer = this.setTimer(() => this.pump(), delay);
  }

  resume(): void {
    log.info('resumed');
    this.pausedUntilMs = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.emit('changed');
    this.pump();
  }

  /** No job starts any more; resolves when the running ones have finished. */
  close(): Promise<void> {
    this.closed = true;
    return new Promise((resolve) => {
      const check = () => {
        if (this.running.size) return;
        this.off('changed', check);
        resolve();
      };
      this.on('changed', check);
      check();
    });
  }

  /** Starts as many queued jobs as parallelism allows. */
  pump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      if (this.pausedUntilMs !== null) {
        if (this.now() < this.pausedUntilMs) {
          this.armTimer();
          return;
        }
        this.pausedUntilMs = null;
        this.emit('changed');
      }
      const limit = this.opts.parallelism();
      log.trace('pump: %d running, limit %d', this.running.size, limit);
      for (const job of this.backend.queued()) {
        if (this.running.size >= limit) break;
        if (this.running.has(job.id)) continue;
        this.start(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Stops a running job (or drops a queued one). */
  stop(job: Job, reason: StopReason): void {
    const r = this.running.get(job.id);
    if (r) {
      r.ctrl.abort(reason);
      return;
    }
    if (job.status === 'queued') {
      this.backend.setStatus(job, reason === 'taken_over' ? 'taken_over' : 'cancelled');
      this.emit('changed');
    }
  }

  private start(job: Job): void {
    const ctrl = new AbortController();
    this.running.set(job.id, { job, ctrl });
    log.info('job %s started: project %s, role %s', job.id, job.projectId, job.role);
    this.backend.setStatus(job, 'running');
    this.emit('changed');
    let outcome: Promise<JobOutcome>;
    try {
      outcome = this.executor(job, ctrl.signal);
    } catch (e) {
      outcome = Promise.resolve({ kind: 'failed', error: (e as Error).message });
    }
    outcome
      .catch((e: unknown): JobOutcome => ({ kind: 'failed', error: e instanceof Error ? e.message : String(e) }))
      .then((o) => this.finish(job, o));
  }

  private finish(job: Job, o: JobOutcome): void {
    this.running.delete(job.id);
    if (o.kind === 'failed') log.error('job %s failed: %s', job.id, o.error);
    else if (o.kind === 'rate_limited') log.warn('job %s hit the rate limit, the queue pauses until %s', job.id, new Date(o.resetsAt ?? this.now() + this.opts.fallbackPauseMs()).toISOString());
    else log.info('job %s finished: %s', job.id, o.kind);
    switch (o.kind) {
      case 'done':
        this.backend.setStatus(job, 'done');
        break;
      case 'failed':
        this.backend.setStatus(job, 'failed', o.error);
        break;
      case 'cancelled':
        this.backend.setStatus(job, 'cancelled');
        break;
      case 'taken_over':
        this.backend.setStatus(job, 'taken_over');
        break;
      case 'rate_limited':
        this.backend.setStatus(job, 'queued', 'rate limit');
        this.pauseUntil(o.resetsAt ?? this.now() + this.opts.fallbackPauseMs());
        break;
    }
    this.emit('changed');
    this.pump();
  }
}
