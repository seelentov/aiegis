import { describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db';
import { ProjectStore } from '../src/main/store';

const usage = { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, costUsd: 0.5 };

function store() {
  return new ProjectStore('p', openDb(':memory:'));
}

const newRun = { kind: 'background' as const, role: 'task', author: 'ai:task', sessionId: 's', cwd: '/w', commitSha: 'abc', configSnapshot: { a: 1 } };

describe('ProjectStore', () => {
  it('jobs: FIFO queue and crash recovery', () => {
    const s = store();
    const a = s.addJob({ type: 'agent', role: 'task', title: 'a', entityType: 'task', entityId: 'a', payload: { prompt: 'x' } });
    s.addJob({ type: 'agent', role: 'task', title: 'b', entityType: 'task', entityId: 'b', payload: {} });
    expect(s.queuedJobs().map((j) => j.title)).toEqual(['a', 'b']);
    s.setJobStatus(a.id, 'running');
    expect(s.queuedJobs().map((j) => j.title)).toEqual(['b']);
    expect(s.recoverJobs()).toBe(1);
    expect(s.getJob(a.id)!.status).toBe('queued');
    expect(s.getJob(a.id)!.payload).toEqual({ prompt: 'x' });
  });

  it('runs are finalized once and then immutable; never deleted', () => {
    const s = store();
    const r = s.startRun(newRun);
    expect(r.status).toBe('running');
    s.finishRun(r.id, 'succeeded', usage);
    const done = s.getRun(r.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.usage).toEqual(usage);
    expect(done.configSnapshot).toEqual({ a: 1 });
    // A second finish is a no-op (guarded by finished_at IS NULL)...
    s.finishRun(r.id, 'failed', usage, 'late');
    expect(s.getRun(r.id)!.status).toBe('succeeded');
    // ...and direct updates/deletes are rejected by triggers.
    expect(() => s.db.prepare(`UPDATE runs SET status = 'failed' WHERE id = ?`).run(r.id)).toThrow(/immutable/);
    expect(() => s.db.prepare('DELETE FROM runs WHERE id = ?').run(r.id)).toThrow(/append-only/);
  });

  it('unfinished runs become interrupted on recovery', () => {
    const s = store();
    const r = s.startRun(newRun);
    expect(s.recoverRuns()).toBe(1);
    expect(s.getRun(r.id)!.status).toBe('interrupted');
    expect(s.getRun(r.id)!.finishedAt).not.toBeNull();
  });

  it('results are append-only and filterable', () => {
    const s = store();
    const r = s.startRun(newRun);
    s.addResult({ runId: r.id, entityType: 'task', entityId: 'a', data: { summary: 'x' }, author: 'ai:task' });
    s.addResult({ runId: r.id, entityType: 'task', entityId: 'b', data: { summary: 'y' }, author: 'ai:task' });
    expect(s.listResults({ entityId: 'b' }).map((x) => x.data.summary)).toEqual(['y']);
    expect(s.listResults({ runId: r.id })).toHaveLength(2);
    expect(() => s.db.prepare('DELETE FROM results').run()).toThrow(/append-only/);
  });
});
