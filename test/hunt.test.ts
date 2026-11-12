import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import { NothingToDo } from '../src/main/schedules';
import type { Job } from '../src/shared/types';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const FAKE = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

async function waitFor<T>(fn: () => T | undefined | false, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let core: Core;
let repo: string;
let pid: string;
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
const job = (id: string) => core.store(pid).getJob(id)!;
const settled = (j: Job) => waitFor(() => !['queued', 'running'].includes(job(j.id).status) && job(j.id));

beforeAll(async () => {
  const home = tmpDir();
  repo = fs.realpathSync(tmpDir());
  git('init', '-q');
  for (const f of ['svc/a.js', 'svc/b.js', 'svc/c.js', 'svc/a.test.js', 'web/x.js', 'web/y.js', 'README.md']) write(path.join(repo, f), 'line 1\nline 2\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  ensureGlobalDefaults(DEFAULTS_DIR, home);
  const cfgFile = path.join(home, 'config.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(cfgFile, 'utf8'));
  doc.setIn(['claude', 'binary'], FAKE);
  doc.setIn(['hunt', 'batch_files'], 2);
  doc.setIn(['queue', 'parallelism'], 3);
  fs.writeFileSync(cfgFile, doc.toString());
  core = new Core({ globalDir: home, dataDir: fs.realpathSync(tmpDir()), defaultsDir: DEFAULTS_DIR });
  await core.start();
  pid = (await core.addProject(repo)).id;
});

afterAll(() => core.shutdown());

describe('vulnerability hunt', () => {
  it('reads every module file but tests in batches; findings carry the flow and no requirement', async () => {
    const mod = await core.saveModule(pid, { name: 'svc', globs: ['svc/**'], description: 'service' });
    const est = await core.estimateHunt(pid, [mod.id]);
    expect(est).toMatchObject({ role: 'hunt', sessions: 2, cells: 3, tokensPerCellSource: 'config', busy: 0 });
    expect(est.modulesWithoutMap).toEqual([{ id: mod.id, name: 'svc' }]);

    const jobs = await core.runHunt(pid, [mod.id]);
    expect(jobs.map((j) => j.payload.files)).toEqual([['svc/a.js', 'svc/b.js'], ['svc/c.js']]);
    expect((await core.estimateHunt(pid, [mod.id])).busy).toBe(1);
    await expect(core.runHunt(pid, [mod.id])).rejects.toBeInstanceOf(NothingToDo);
    for (const j of jobs) expect((await settled(j)).status).toBe('done');

    const findings = core.store(pid).audit.listFindings().filter((f) => f.moduleId === mod.id);
    expect(findings.map((f) => f.title).sort()).toEqual(['SQL injection in svc/a.js', 'SQL injection in svc/c.js']);
    for (const f of findings) {
      expect(f.cells).toEqual([]);
      expect(f.author).toBe('ai:hunt');
      expect(f.trace).toHaveLength(2);
    }
    const runs = jobs.map((j) => job(j.id).lastRunId!);
    expect([...core.store(pid).huntReviewedFiles(runs)].sort()).toEqual(['svc/a.js', 'svc/b.js', 'svc/c.js']);
    expect(core.store(pid).getRun(runs[0])!.status).toBe('succeeded');
    const coverage = await core.huntCoverage(pid, mod.id);
    expect(coverage.map((c) => c.file).sort()).toEqual(['svc/a.js', 'svc/b.js', 'svc/c.js']);
    expect(coverage.every((c) => c.reviewedAt && runs.includes(c.runId!))).toBe(true);
    // Batches of one module never overlap, so each sees the findings of the one before.
    const [r1, r2] = runs.map((id) => core.store(pid).getRun(id)!);
    expect(r2.startedAt >= r1.finishedAt!).toBe(true);
  });

  it('a run that leaves files unread fails; retry reads only those', async () => {
    const mod = await core.saveModule(pid, { name: 'web', globs: ['web/**'], description: 'HUNT_PARTIAL' });
    const [j] = await core.runHunt(pid, [mod.id]);
    const failed = await settled(j);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/files left unread: 1/);
    expect((await core.huntCoverage(pid, mod.id)).map((c) => [c.file, !!c.reviewedAt])).toEqual([['web/y.js', false], ['web/x.js', true]]);

    core.retryJob(pid, j.id);
    await waitFor(() => job(j.id).status === 'running' || job(j.id).status === 'done');
    expect((await settled(job(j.id))).status).toBe('done');
    expect(job(j.id).payload.files).toEqual(['web/y.js']);
    expect(job(j.id).payload.prompt).not.toContain('web/x.js');
  });

  it('a schedule respects its limit and starts the chosen modules', async () => {
    const mod = await core.saveModule(pid, { name: 'sched', globs: ['svc/a.js'], description: 'service' });
    const s = await core.createSchedule(pid, { name: 'hunt', cron: '0 3 * * *', action: { kind: 'hunt', moduleIds: [mod.id] }, maxTokens: 1 });
    expect((await core.runSchedule(pid, s.id)).outcome).toBe('over_limit');

    await core.updateSchedule(pid, s.id, { maxTokens: 10_000_000 });
    const firing = await core.runSchedule(pid, s.id);
    expect(firing.outcome).toBe('started');
    expect(firing.jobIds.map((id) => job(id).payload.module_id)).toEqual([mod.id]);
    for (const id of firing.jobIds) expect((await settled(job(id))).status).toBe('done');
  });
});
