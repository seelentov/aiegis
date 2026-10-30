import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db';
import { diffEntryPoints, globsError, matchFiles, renderTemplate, repoFileError, toPathspecs, touchedFiles } from '../src/main/modules';
import { ProjectStore } from '../src/main/store';
import type { EntryPointInput } from '../src/shared/types';
import { tmpDir, write } from './helpers';

const by = { author: 'human', runId: null };
const newRun = { kind: 'background' as const, role: 'entry-points', author: 'ai:entry-points', sessionId: 's', cwd: '/w', commitSha: 'abc', configSnapshot: {} };
const usage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, costUsd: 0 };

const ep = (name: string, over: Partial<EntryPointInput> = {}): EntryPointInput => ({
  kind: 'http',
  method: 'GET',
  name,
  handler: { file: 'svc/Api.java', line: 10 },
  middleware: [],
  auth: 'none found',
  params: [],
  callChain: [],
  notes: null,
  ...over,
});

function store() {
  return new ProjectStore('p', openDb(':memory:'));
}

describe('module globs', () => {
  it('validates and converts to git pathspecs', () => {
    expect(globsError(['a/**', '!a/test/**'])).toBeNull();
    expect(globsError(['!a/**'])).toMatch(/including glob/);
    expect(globsError(['/etc/**'])).toMatch(/relative/);
    expect(globsError([':(top)x'])).toMatch(/pathspec/);
    expect(globsError(['a/../../x'])).toMatch(/leaves the repository/);
    expect(toPathspecs(['a/**', '!a/test/**'])).toEqual([':(glob)a/**', ':(glob,exclude)a/test/**']);
  });

  it('matches tracked files only, with exclusions', async () => {
    const repo = tmpDir();
    for (const f of ['svc/src/A.java', 'svc/src/sub/B.java', 'svc/test/T.java', 'other/C.java']) write(path.join(repo, f), 'x');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    write(path.join(repo, 'svc/src/Untracked.java'), 'x');
    expect(await matchFiles(repo, ['svc/**', '!svc/test/**'])).toEqual(['svc/src/A.java', 'svc/src/sub/B.java']);
    expect(await matchFiles(repo, ['svc/*/*.java'])).toEqual(['svc/src/A.java', 'svc/test/T.java']);
    expect(await matchFiles(repo, ['nope/**'])).toEqual([]);
    expect(repoFileError(repo, 'svc/src/A.java')).toBeNull();
    expect(repoFileError(repo, 'svc/src')).toMatch(/not found/);
    expect(repoFileError(repo, '../x')).toMatch(/relative/);
    expect(fs.existsSync(path.join(repo, 'svc'))).toBe(true);
  });
});

describe('prompt templates', () => {
  it('fills placeholders and rejects unknown ones', () => {
    expect(renderTemplate('Map {{module_name}} ({{ module_id }})', { module_name: 'm', module_id: '1' })).toBe('Map m (1)');
    expect(() => renderTemplate('{{oops}}', { a: '' }, 'tasks/x.md')).toThrow(/tasks\/x.md: unknown placeholder \{\{oops\}\}/);
  });
});

describe('entry point diff', () => {
  it('marks added, changed, same and removed by key', () => {
    const s = store();
    s.saveModule({ name: 'm', globs: ['svc/**'], description: '' }, by);
    const m = s.listModules()[0];
    const r1 = s.startRun(newRun);
    const a = s.ensureSnapshot(r1, m.id);
    s.upsertEntryPoint(a.id, ep('/a'));
    s.upsertEntryPoint(a.id, ep('/b'));
    s.upsertEntryPoint(a.id, ep('/c'));
    const r2 = s.startRun(newRun);
    const b = s.ensureSnapshot(r2, m.id);
    s.upsertEntryPoint(b.id, ep('/a'));
    s.upsertEntryPoint(b.id, ep('/b', { auth: '@PreAuthorize admin' }));
    s.upsertEntryPoint(b.id, ep('/d'));
    const d = diffEntryPoints(s.listEntryPoints(b.id), s.listEntryPoints(a.id));
    expect(Object.fromEntries(d.entries.map((e) => [e.name, e.change]))).toEqual({ '/a': 'same', '/b': 'changed', '/d': 'added' });
    expect(d.removed.map((e) => e.name)).toEqual(['/c']);
    expect(diffEntryPoints(s.listEntryPoints(b.id), null).entries.every((e) => e.change === 'same')).toBe(true);
    expect(touchedFiles([ep('/a', { callChain: [{ file: 'z/Repo.java', function: 'find' }] }), ep('/b')])).toEqual(['svc/Api.java', 'z/Repo.java']);
  });
});

describe('ProjectStore: modules', () => {
  it('keeps every revision; current = latest; names unique; unchanged save is a no-op', () => {
    const s = store();
    const m = s.saveModule({ name: 'auth', globs: ['auth/**'], description: 'v1' }, { author: 'ai:modules', runId: 'r1' });
    expect(s.saveModule({ id: m.id, name: 'auth', globs: ['auth/**'], description: 'v1' }, by)).toEqual(m);
    s.saveModule({ id: m.id, name: 'auth-service', globs: ['auth/**', '!auth/test/**'], description: 'v2' }, by);
    expect(s.getModule(m.id)).toMatchObject({ name: 'auth-service', description: 'v2', author: 'human', runId: null });
    expect(() => s.saveModule({ name: 'auth-service', globs: ['x/**'], description: '' }, by)).toThrow(/already exists/);
    expect(s.moduleHistory(m.id).map((h) => h.description)).toEqual(['v2', 'v1']);

    s.removeModule(m.id, 'merged into core', by);
    expect(s.getModule(m.id)).toBeUndefined();
    expect(s.listModules()).toEqual([]);
    expect(s.moduleHistory(m.id)[0]).toMatchObject({ deleted: true, reason: 'merged into core' });
    // A removed module's name is free again.
    expect(s.saveModule({ name: 'auth-service', globs: ['auth/**'], description: '' }, by).id).not.toBe(m.id);
    expect(() => s.db.prepare('DELETE FROM module_revisions').run()).toThrow(/append-only/);
  });
});

describe('ProjectStore: entry point snapshots', () => {
  it('builds per run, upserts by key, freezes on finalize, current = latest complete', () => {
    const s = store();
    const m = s.saveModule({ name: 'm', globs: ['svc/**'], description: '' }, by);
    const r1 = s.startRun(newRun);
    const a = s.ensureSnapshot(r1, m.id);
    expect(s.ensureSnapshot(r1, m.id).id).toBe(a.id);
    expect(a).toMatchObject({ status: 'building', commitSha: 'abc', globs: ['svc/**'] });
    s.upsertEntryPoint(a.id, ep('/a'));
    s.upsertEntryPoint(a.id, ep('/a', { method: 'get', handler: { file: 'svc/Api.java', line: 42 } }));
    s.upsertEntryPoint(a.id, ep('/x'));
    expect(s.removeEntryPoint(a.id, 'http GET /x')).toBe(true);
    expect(s.listEntryPoints(a.id).map((e) => [e.key, e.handler.line])).toEqual([['http GET /a', 42]]);
    expect(s.latestSnapshot(m.id)).toBeUndefined();

    s.finishRun(r1.id, 'succeeded', usage);
    s.finalizeSnapshots(r1.id, true);
    const done = s.getSnapshot(a.id)!;
    expect(done).toMatchObject({ status: 'complete', touchedFiles: ['svc/Api.java'], entryCount: 1 });
    expect(s.latestSnapshot(m.id)!.id).toBe(a.id);
    expect(() => s.upsertEntryPoint(a.id, ep('/late'))).toThrow(/immutable/);
    expect(() => s.removeEntryPoint(a.id, 'http GET /a')).toThrow(/immutable/);
    expect(() => s.db.prepare(`UPDATE ep_snapshots SET status = 'building'`).run()).toThrow(/immutable/);

    // A failed run leaves a failed snapshot; the current map stays the previous complete one.
    const r2 = s.startRun(newRun);
    s.upsertEntryPoint(s.ensureSnapshot(r2, m.id).id, ep('/partial'));
    s.finalizeSnapshots(r2.id, false);
    expect(s.listSnapshots(m.id).map((x) => x.status)).toEqual(['failed', 'complete']);
    expect(s.latestSnapshot(m.id)!.id).toBe(a.id);
  });

  it('a resumed session starts from its parent snapshot; crash recovery fails building snapshots', () => {
    const s = store();
    const m = s.saveModule({ name: 'm', globs: ['svc/**'], description: '' }, by);
    const bg = s.startRun(newRun);
    s.upsertEntryPoint(s.ensureSnapshot(bg, m.id).id, ep('/a'));
    s.finishRun(bg.id, 'taken_over', usage);
    s.finalizeSnapshots(bg.id, false);
    const resumed = s.startRun({ ...newRun, kind: 'interactive', parentRunId: bg.id });
    const snap = s.ensureSnapshot(resumed, m.id);
    expect(s.listEntryPoints(snap.id).map((e) => e.name)).toEqual(['/a']);

    s.recoverRuns();
    expect(s.recoverSnapshots()).toBe(1);
    expect(s.getSnapshot(snap.id)!.status).toBe('failed');
  });
});
