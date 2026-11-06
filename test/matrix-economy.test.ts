import * as pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import type { Job } from '../src/shared/types';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const FAKE = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');
const GUIDE = `# Access control
AUTH-1: Every endpoint must check the caller's role SKIP_ONCE.
AUTH-2: Object access must verify ownership.

# Output
OUT-1: HTML output must be encoded.
`;

let core: Core;
let pid: string;
let matrixId: string;
let cfgFile: string;

async function waitFor<T>(fn: () => T | undefined | false): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > 10_000) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const job = (id: string) => core.store(pid).getJob(id)!;
const settled = (j: Job) => waitFor(() => !['queued', 'running'].includes(job(j.id).status) && job(j.id));
const setAbove = (tokens: number) => {
  const doc = YAML.parseDocument(fs.readFileSync(cfgFile, 'utf8'));
  doc.setIn(['matrix', 'economy_above_tokens'], tokens);
  fs.writeFileSync(cfgFile, doc.toString());
};

beforeAll(async () => {
  const home = tmpDir();
  const repo = fs.realpathSync(tmpDir());
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  git('init', '-q');
  write(path.join(repo, 'svc', 'Api.java'), 'class Api {}');
  write(path.join(repo, 'lib', 'Util.java'), 'class Util {}');
  git('add', '.');
  git('commit', '-qm', 'init');
  ensureGlobalDefaults(DEFAULTS_DIR, home);
  cfgFile = path.join(home, 'config.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(cfgFile, 'utf8'));
  doc.setIn(['claude', 'binary'], FAKE);
  doc.setIn(['queue', 'parallelism'], 1);
  doc.setIn(['signals', 'auto_scan'], false);
  doc.setIn(['matrix', 'estimate_tokens_per_economy_session'], 20000);
  fs.writeFileSync(cfgFile, doc.toString());
  core = new Core({ globalDir: home, dataDir: fs.realpathSync(tmpDir()), defaultsDir: DEFAULTS_DIR }, { pty: pty.spawn });
  await core.start();
  pid = (await core.addProject(repo)).id;
  const modules = [await core.saveModule(pid, { name: 'svc', globs: ['svc/**'], description: 'api' }), await core.saveModule(pid, { name: 'lib', globs: ['lib/**'], description: '' })];
  const file = path.join(tmpDir(), 'guide.md');
  write(file, GUIDE);
  const view = await core.importDocument(pid, file, { title: 'Guide' });
  await settled(job(view.job!.id));
  const v = core.docVersion(pid, view.version.id);
  core.reviewItems(pid, view.version.id, v.items.map((i) => i.id), 'accepted');
  core.approveVersion(pid, view.version.id);
  matrixId = core.saveMatrix(pid, { name: 'mini', documentIds: [view.document.id], moduleIds: modules.map((m) => m.id) }).id;
});

afterAll(() => core.shutdown());

describe('merged sessions of a large run', () => {
  it('stay off at zero and below the threshold', async () => {
    setAbove(0);
    const off = await core.estimateMatrix(pid, matrixId, 'verdicts', 'pending');
    expect(off).toMatchObject({ mode: 'usual', role: 'matrix', cells: 6, tokens: 6 * 17000 });
    expect(off.alternative).toBeUndefined();
    setAbove(6 * 17000);
    expect((await core.estimateMatrix(pid, matrixId, 'verdicts', 'pending')).mode).toBe('usual');
  });

  it('above the threshold: merged estimate, force keeps the usual one, triage never merges', async () => {
    setAbove(50000);
    const e = await core.estimateMatrix(pid, matrixId, 'verdicts', 'pending');
    expect(e).toMatchObject({ mode: 'economy', role: 'matrix-economy', sessions: 1, cells: 6, tokens: 20000 });
    expect(e.batches[0].moduleName).toBe('svc, lib');
    expect(e.alternative).toEqual({ mode: 'usual', sessions: 4, tokens: 6 * 17000 });
    const forced = await core.estimateMatrix(pid, matrixId, 'verdicts', 'pending', true);
    expect(forced).toMatchObject({ mode: 'usual', role: 'matrix', tokens: 6 * 17000 });
    expect(forced.alternative).toEqual({ mode: 'economy', sessions: 1, tokens: 20000 });
    expect((await core.estimateMatrix(pid, matrixId, 'triage', 'pending')).mode).toBe('usual');
  });

  it('runs one session, keeps the mode on retry, marks verdicts as preliminary', async () => {
    const jobs = await core.runMatrix(pid, matrixId, 'verdicts', 'pending');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ role: 'matrix-economy', title: 'Verdicts, merged: mini (6 cells)' });
    const failed = await settled(jobs[0]);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/cells left without a result: 2/);
    expect(core.store(pid).getRun(failed.lastRunId!)!.scope).toHaveLength(6);
    core.retryJob(pid, jobs[0].id);
    const done = await settled(jobs[0]);
    expect(done.status).toBe('done');
    expect(done.payload).toMatchObject({ economy: true, cells: expect.any(Array) });
    expect(String(done.payload.prompt)).toContain('Check the modules of project');
    const view = await core.matrixView(pid, matrixId);
    expect(view.cells.every((c) => c.status === 'pass' && c.preliminary && c.verdict?.preliminary && c.verdict.author === 'ai:matrix-economy')).toBe(true);
    expect(await core.matrixSlice(pid, matrixId, { preliminary: true })).toHaveLength(6);
  });

  it('a usual recheck of preliminary cells removes the mark', async () => {
    const cells = await core.matrixSlice(pid, matrixId, { preliminary: true });
    const est = await core.estimateRecheck(pid, cells, matrixId);
    expect(est.batches.reduce((n, b) => n + b.tokens, 0)).toBe(est.tokens);
    const jobs = await core.recheckCells(pid, cells, matrixId, true);
    expect(jobs.every((j) => j.role === 'matrix')).toBe(true);
    for (const j of jobs) {
      if ((await settled(j)).status === 'failed') {
        core.retryJob(pid, j.id);
        await settled(j);
      }
    }
    const view = await core.matrixView(pid, matrixId);
    expect(view.cells.every((c) => !c.preliminary && c.verdict?.author === 'ai:matrix')).toBe(true);
  });
});
