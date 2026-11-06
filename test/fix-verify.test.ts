import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import { fixBaseline, fixEligible } from '../src/main/matrix';
import { parseAction } from '../src/main/schedules';
import type { Finding, FindingInput, Job } from '../src/shared/types';
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

describe('fix baseline and eligibility', () => {
  it('moves only on a decided check, the newest one', () => {
    expect(fixBaseline('origin', [])).toBe('origin');
    expect(fixBaseline(null, [])).toBeNull();
    expect(fixBaseline('origin', [{ outcome: 'undetermined', commitSha: 'u' }])).toBe('origin');
    expect(
      fixBaseline('origin', [
        { outcome: 'undetermined', commitSha: 'u' },
        { outcome: 'not_closed', commitSha: 'n' },
        { outcome: 'closed', commitSha: 'c' },
      ]),
    ).toBe('n');
  });

  it('takes live suspected and verified findings only', () => {
    expect(fixEligible({ status: 'suspected', mergedInto: null })).toBe(true);
    expect(fixEligible({ status: 'verified', mergedInto: null })).toBe(true);
    expect(fixEligible({ status: 'suspected', mergedInto: 'x' })).toBe(false);
    for (const status of ['false_positive', 'accepted_risk', 'fixed'] as const) expect(fixEligible({ status, mergedInto: null })).toBe(false);
  });

  it('is a schedule action without parameters', () => {
    expect(parseAction({ kind: 'fix_verify' })).toEqual({ kind: 'fix_verify' });
    expect(() => parseAction({ kind: 'fix_verify', moduleIds: [] })).toThrow('invalid schedule action');
  });
});

describe('fix verification with a fake claude', () => {
  const INPUT: FindingInput = {
    title: 'orders IDOR',
    description: 'IDOR on orders',
    severity: 'high',
    cwe: 'CWE-639',
    moduleId: null,
    entryPoint: null,
    files: [{ file: 'srv.js', line: 1 }, { file: 'deleted.js' }],
    recommendation: 'SESSION_RECOMMENDATION',
  };
  let core: Core;
  let repo: string;
  let pid: string;
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  const job = (id: string) => core.store(pid).getJob(id)!;
  const settled = (j: Job) => waitFor(() => !['queued', 'running'].includes(job(j.id).status) && job(j.id));
  const head = () => git('rev-parse', 'HEAD');
  /** A manual finding at HEAD, the way the core records it. */
  const finding = (over: Partial<FindingInput> = {}): Finding => core.store(pid).audit.createFinding({ ...INPUT, ...over }, [], { author: 'human', runId: null }, [], head());
  const commit = (file: string, text: string) => {
    write(path.join(repo, file), text);
    git('add', '.');
    git('commit', '-qm', `change ${file}`);
  };
  const state = async (f: Finding) => (await core.findingsFixState(pid))[f.id];
  /** Finishes earlier checks so that one test's stale findings do not reach the next. */
  const closeOthers = async () => {
    const live = Object.keys(await core.findingsFixState(pid));
    for (const id of live) core.setFindingStatus(pid, id, 'fixed', '');
  };

  beforeAll(async () => {
    const home = tmpDir();
    repo = fs.realpathSync(tmpDir());
    git('init', '-q');
    write(path.join(repo, 'srv.js'), 'first\n');
    write(path.join(repo, 'deleted.js'), 'gone soon\n');
    write(path.join(repo, 'other.js'), 'other\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    ensureGlobalDefaults(DEFAULTS_DIR, home);
    const file = path.join(home, 'config.yaml');
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    doc.setIn(['claude', 'binary'], FAKE);
    fs.writeFileSync(file, doc.toString());
    core = new Core({ globalDir: home, dataDir: fs.realpathSync(tmpDir()), defaultsDir: DEFAULTS_DIR });
    await core.start();
    pid = (await core.addProject(repo)).id;
  });

  afterAll(() => core.shutdown());

  it('a finding goes stale only when its own files change, without any job', async () => {
    const f = finding();
    const before = core.store(pid).listJobs().length;
    expect(await state(f)).toEqual({ stale: false, changedFiles: [], baseline: head(), last: null });
    const start = head();
    commit('other.js', 'other 2\n');
    expect(await state(f)).toMatchObject({ stale: false, baseline: start });
    commit('srv.js', 'second\n');
    expect(await state(f)).toEqual({ stale: true, changedFiles: ['srv.js'], baseline: start, last: null });
    expect(core.store(pid).listJobs()).toHaveLength(before);
    await closeOthers();
  });

  it('a session finding takes the commit of its run, and an older manual one with no commit is stale', async () => {
    const task = await settled(await core.enqueueTask(pid, { prompt: 'x', role: 'task' }));
    const made = core.store(pid).audit.createFinding(INPUT, [], { author: 'ai:matrix', runId: task.lastRunId });
    expect(made.commitSha).toBe(head());
    const old = core.store(pid).audit.createFinding(INPUT, [], { author: 'human', runId: null });
    expect(old.commitSha).toBeNull();
    expect(await state(old)).toEqual({ stale: true, changedFiles: [], baseline: null, last: null });
    await closeOthers();
  });

  it('a commit that is gone from the repository is stale', async () => {
    const f = core.store(pid).audit.createFinding(INPUT, [], { author: 'human', runId: null }, [], 'a'.repeat(40));
    expect(await state(f)).toMatchObject({ stale: true, changedFiles: [] });
    await closeOthers();
  });

  it('other statuses and merged findings have no fix state', async () => {
    const a = finding();
    const fp = finding();
    core.setFindingStatus(pid, fp.id, 'false_positive', 'no');
    const merged = finding();
    core.mergeFinding(pid, merged.id, a.id);
    const states = await core.findingsFixState(pid);
    expect(states[a.id]).toBeDefined();
    expect(states[fp.id]).toBeUndefined();
    expect(states[merged.id]).toBeUndefined();
    commit('srv.js', `merged ${Date.now()}\n`);
    await expect(core.runFixVerify(pid, [fp.id, merged.id])).rejects.toThrow('no live suspected or verified');
    await closeOthers();
  });

  it('a check runs at HEAD, keeps the status and the refutation column, and a closed result moves the baseline', async () => {
    const f = finding();
    const start = head();
    await expect(core.runFixVerify(pid, [f.id])).rejects.toThrow('new commit');
    expect(await core.estimateFixVerify(pid, [f.id])).toMatchObject({ sessions: 0, busy: 0 });
    fs.rmSync(path.join(repo, 'deleted.js'));
    commit('srv.js', `fixed ${Date.now()}\n`);
    expect((await state(f)).changedFiles.sort()).toEqual(['deleted.js', 'srv.js']);
    expect(await core.estimateFixVerify(pid, [f.id])).toMatchObject({ role: 'finding-verify', sessions: 1, cells: 1 });

    const [j] = await core.runFixVerify(pid, [f.id]);
    expect(j.role).toBe('finding-verify');
    expect(j.payload.commit_sha).toBe(head());
    const prompt = String(j.payload.prompt);
    expect(prompt).toContain(start);
    expect(prompt).toContain('- srv.js');
    expect(prompt).not.toContain('SESSION_RECOMMENDATION');
    await expect(core.runFixVerify(pid, [f.id])).rejects.toThrow('already queued');
    expect(await core.estimateFixVerify(pid, [f.id])).toMatchObject({ sessions: 0, busy: 1 });
    expect((await settled(j)).status).toBe('done');

    const d = core.findingDetails(pid, f.id);
    expect(d.finding.status).toBe('suspected');
    expect(d.finding.verification).toBeNull();
    expect(d.verify.results).toEqual([]);
    expect(d.fix.job).toBeNull();
    expect(d.runs.some((r) => r.role === 'finding-verify')).toBe(true);
    expect(d.fix.results).toHaveLength(1);
    const [r] = d.fix.results;
    // A deleted file of the finding can be cited; any other reference must exist.
    expect(r).toMatchObject({ outcome: 'closed', author: 'ai:finding-verify', commitSha: head(), evidence: [{ file: 'deleted.js' }] });
    expect(r.reason).toMatch(/other tool=.*(not found|no such tool)/i);
    expect(r.reason).toContain('no evidence=closed requires evidence');
    expect(r.reason).toMatch(/missing file=.*nope\.js/);
    expect(r.reason).toContain('other finding=Denied');
    expect(() => core.store(pid).audit.db.prepare('UPDATE finding_verifications SET reason = 1').run()).toThrow('append-only');

    expect(await state(f)).toEqual({ stale: false, changedFiles: [], baseline: head(), last: 'closed' });
    const checked = head();
    commit('srv.js', `regressed ${Date.now()}\n`);
    expect(await state(f)).toEqual({ stale: true, changedFiles: ['srv.js'], baseline: checked, last: 'closed' });
    await closeOthers();
  });

  it('an undetermined result leaves the finding stale from the same commit', async () => {
    const f = finding({ description: 'FIX_UNDETERMINED' });
    const start = head();
    commit('srv.js', `again ${Date.now()}\n`);
    const [j] = await core.runFixVerify(pid, [f.id]);
    expect((await settled(j)).status).toBe('done');
    expect(core.findingDetails(pid, f.id).fix.results[0].outcome).toBe('undetermined');
    expect(await state(f)).toMatchObject({ stale: true, baseline: start, last: 'undetermined' });
    await closeOthers();
  });

  it('fails the job when no result was recorded', async () => {
    const f = finding({ description: 'FIX_REFUSED' });
    commit('srv.js', `refused ${Date.now()}\n`);
    const [j] = await core.runFixVerify(pid, [f.id]);
    const d = await settled(j);
    expect(d.status).toBe('failed');
    expect(d.error).toContain('set_fix_verification');
    expect(core.findingDetails(pid, f.id).fix.results).toEqual([]);
    await closeOthers();
  });

  it('a schedule costs nothing without stale findings, respects its limit and starts only stale ones', async () => {
    const s = await core.createSchedule(pid, { name: 'fixes', cron: '0 3 * * *', action: { kind: 'fix_verify' }, maxTokens: 1 });
    const jobs = () => core.store(pid).listJobs().length;
    const before = jobs();
    const fresh = finding();
    expect((await core.runSchedule(pid, s.id)).outcome).toBe('nothing_to_do');

    const staleOne = finding({ files: [{ file: 'srv.js' }] });
    const untouched = finding({ files: [{ file: 'other.js' }] });
    commit('srv.js', `scheduled ${Date.now()}\n`);
    const over = await core.runSchedule(pid, s.id);
    expect(over.outcome).toBe('over_limit');
    expect(jobs()).toBe(before);

    await core.updateSchedule(pid, s.id, { maxTokens: 10_000_000 });
    const firing = await core.runSchedule(pid, s.id);
    expect(firing.outcome).toBe('started');
    const started = firing.jobIds.map((id) => job(id));
    expect(started.map((j) => j.entityId).sort()).toEqual([fresh.id, staleOne.id].sort());
    expect(started.map((j) => j.entityId)).not.toContain(untouched.id);
    for (const j of started) await settled(j);
  });
});
