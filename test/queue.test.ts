import { describe, expect, it } from 'vitest';
import type { Job, JobStatus } from '../src/shared/types';
import { JobQueue, type JobOutcome, type QueueBackend } from '../src/main/queue';

function makeJob(id: string, createdAt: string): Job {
  return {
    id,
    projectId: 'p',
    type: 'agent',
    role: 'task',
    title: id,
    entityType: 'task',
    entityId: id,
    payload: {},
    status: 'queued',
    error: null,
    lastRunId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

class MemBackend implements QueueBackend {
  jobs: Job[] = [];
  history: [string, JobStatus][] = [];
  add(id: string) {
    this.jobs.push(makeJob(id, `2026-01-01T00:00:${String(this.jobs.length).padStart(2, '0')}Z`));
  }
  queued() {
    return this.jobs.filter((j) => j.status === 'queued').map((j) => ({ ...j }));
  }
  setStatus(job: Job, status: JobStatus) {
    this.jobs.find((j) => j.id === job.id)!.status = status;
    this.history.push([job.id, status]);
  }
  status(id: string) {
    return this.jobs.find((j) => j.id === id)!.status;
  }
}

/** Executor whose jobs finish when the test resolves them. */
function controllable() {
  const pending = new Map<string, { resolve: (o: JobOutcome) => void; signal: AbortSignal }>();
  const started: string[] = [];
  const exec = (job: Job, signal: AbortSignal) =>
    new Promise<JobOutcome>((resolve) => {
      started.push(job.id);
      pending.set(job.id, { resolve, signal });
      signal.addEventListener('abort', () => resolve({ kind: signal.reason }));
    });
  return { exec, pending, started };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeClock() {
  let t = 1_000_000;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { at: t + ms, fn, dead: false };
      timers.push(timer);
      return () => (timer.dead = true);
    },
    advance(ms: number) {
      t += ms;
      for (const x of timers) if (!x.dead && x.at <= t) (x.dead = true), x.fn();
    },
  };
}

describe('JobQueue', () => {
  it('runs FIFO with bounded parallelism', async () => {
    const b = new MemBackend();
    ['a', 'b', 'c'].forEach((id) => b.add(id));
    const c = controllable();
    const q = new JobQueue(b, c.exec, { parallelism: () => 2, fallbackPauseMs: () => 1000 });
    q.pump();
    expect(c.started).toEqual(['a', 'b']);
    expect(q.state().running).toBe(2);
    c.pending.get('a')!.resolve({ kind: 'done' });
    await flush();
    expect(c.started).toEqual(['a', 'b', 'c']);
    expect(b.status('a')).toBe('done');
    c.pending.get('b')!.resolve({ kind: 'failed', error: 'x' });
    c.pending.get('c')!.resolve({ kind: 'done' });
    await flush();
    expect(b.status('b')).toBe('failed');
    expect(q.state().running).toBe(0);
  });

  it('cancels queued and running jobs; takeover is a distinct status', async () => {
    const b = new MemBackend();
    ['a', 'b', 'c'].forEach((id) => b.add(id));
    const c = controllable();
    const q = new JobQueue(b, c.exec, { parallelism: () => 1, fallbackPauseMs: () => 1000 });
    q.pump();
    q.stop(b.jobs[2], 'cancelled');
    expect(b.status('c')).toBe('cancelled');
    q.stop(b.jobs[0], 'taken_over');
    await flush();
    expect(b.status('a')).toBe('taken_over');
    expect(c.started).toEqual(['a', 'b']);
    q.stop(b.jobs[1], 'cancelled');
    await flush();
    expect(b.status('b')).toBe('cancelled');
  });

  it('treats executor exceptions as failures', async () => {
    const b = new MemBackend();
    b.add('a');
    const q = new JobQueue(b, async () => Promise.reject(new Error('boom')), { parallelism: () => 1, fallbackPauseMs: () => 1 });
    q.pump();
    await flush();
    expect(b.status('a')).toBe('failed');
  });

  it('rate limit requeues the job and pauses until reset', async () => {
    const b = new MemBackend();
    ['a', 'b'].forEach((id) => b.add(id));
    const c = controllable();
    const clock = fakeClock();
    const q = new JobQueue(b, c.exec, { parallelism: () => 1, fallbackPauseMs: () => 60_000, ...clock });
    q.pump();
    c.pending.get('a')!.resolve({ kind: 'rate_limited', resetsAt: clock.now() + 5000 });
    await flush();
    expect(b.status('a')).toBe('queued');
    expect(q.state().pausedUntil).toBe(clock.now() + 5000);
    expect(c.started).toEqual(['a']);
    q.pump();
    expect(c.started).toEqual(['a']);
    clock.advance(5000);
    expect(q.state().pausedUntil).toBeNull();
    expect(c.started).toEqual(['a', 'a']);
  });

  it('uses the fallback pause when the reset time is unknown; resume() unpauses', async () => {
    const b = new MemBackend();
    b.add('a');
    const c = controllable();
    const clock = fakeClock();
    const q = new JobQueue(b, c.exec, { parallelism: () => 1, fallbackPauseMs: () => 60_000, ...clock });
    q.pump();
    c.pending.get('a')!.resolve({ kind: 'rate_limited' });
    await flush();
    expect(q.state().pausedUntil).toBe(clock.now() + 60_000);
    q.resume();
    expect(q.state().pausedUntil).toBeNull();
    expect(c.started).toEqual(['a', 'a']);
  });
});
