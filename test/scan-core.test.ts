import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core, SCAN_JOB } from '../src/main/core';
import type { AppEvent, Job } from '../src/shared/types';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const FAKE_CLAUDE = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');
const FAKE_SCANNER = path.resolve(__dirname, 'fixtures', 'fake-scanner.mjs');

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let core: Core;
let repo: string;
let pid: string;
let moduleId: string;
const events: AppEvent[] = [];
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
const head = () => git('rev-parse', 'HEAD').trim();

beforeAll(async () => {
  const home = tmpDir();
  const data = fs.realpathSync(tmpDir());
  repo = fs.realpathSync(tmpDir());
  git('init', '-q');
  git('config', 'user.name', 'Alice');
  git('config', 'user.email', 'alice@example.com');
  write(path.join(repo, 'svc', 'Api.java'), 'class Api {\n  String a = req.getParameter("a");\n  String b = req.getParameter("b");\n}\n');
  write(path.join(repo, 'svc', 'test', 'ApiTest.java'), 'class ApiTest { String t = req.getParameter("t"); }\n');
  write(path.join(repo, 'lib', 'Util.java'), 'class Util { String u = req.getParameter("u"); }\n');
  write(path.join(repo, 'svc', 'Tpl.java'), 'class Tpl { BROKEN_SYNTAX % }\n');
  git('add', '.');
  git('commit', '-qm', 'init');

  ensureGlobalDefaults(DEFAULTS_DIR, home);
  const cfgFile = path.join(home, 'config.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(cfgFile, 'utf8'));
  doc.setIn(['claude', 'binary'], FAKE_CLAUDE);
  doc.setIn(['queue', 'parallelism'], 2);
  for (const name of ['semgrep', 'gitleaks', 'trivy']) doc.setIn(['scanners', name, 'enabled'], false);
  doc.setIn(['scanners', 'fake'], { enabled: true, binary: FAKE_SCANNER, format: 'semgrep', version_args: ['--version'], args: ['scan', '{{targets}}'], ok_exit_codes: [0], timeout_sec: 60 });
  doc.setIn(['scanners', 'ghost'], { enabled: true, binary: 'aiegis-no-such-scanner', format: 'gitleaks', version_args: ['version'], args: ['{{target}}'], ok_exit_codes: [0], timeout_sec: 60 });
  fs.writeFileSync(cfgFile, doc.toString());

  core = new Core({ globalDir: home, dataDir: data, defaultsDir: DEFAULTS_DIR });
  core.on('event', (e: AppEvent) => events.push(e));
  await core.start();
  pid = (await core.addProject(repo)).id;
  moduleId = (await core.saveModule(pid, { name: 'svc', globs: ['svc/**'], description: 'api' })).id;
});

afterAll(() => core.shutdown());

const job = (id: string) => core.store(pid).getJob(id)!;
const settled = (j: Job) => waitFor(() => !['queued', 'running'].includes(job(j.id).status) && job(j.id));

/** Approved document with one requirement, created without AI. */
function requirement(key: string, text: string): string {
  const a = core.store(pid).audit;
  const doc = a.createDocument(`Guide ${key}`);
  const v = a.addVersion(doc, { filename: 'g.md', format: 'md', sha256: key });
  a.upsertItem(v.id, { key, text, section: 'Input', quote: text }, { author: 'human', runId: null }, 'accepted');
  a.setVersionStatus(v.id, 'review');
  a.approveVersion(v.id, 'human');
  return a.currentItems([doc])[0].requirementId;
}

describe('scanners, raw findings and suppressions with a fake scanner', () => {
  it('availability check: missing binaries are reported, disabled scanners are not run', async () => {
    const st = await core.scannerStatus(pid);
    expect(st.find((s) => s.name === 'fake')).toMatchObject({ available: true, version: 'fake-scanner 1.2.3', error: null });
    expect(st.find((s) => s.name === 'ghost')).toMatchObject({ available: false, error: 'aiegis-no-such-scanner not found in PATH' });
    expect(st.find((s) => s.name === 'semgrep')).toMatchObject({ enabled: false, available: false });
    await waitFor(() => events.find((e) => e.type === 'notice' && /ghost/.test(e.text)));
  });

  it('scans modules once per commit in a worktree; results are normalized and cached', async () => {
    const r = await core.runScanners(pid, { moduleIds: [] });
    expect(r.unavailable).toEqual(['ghost']);
    expect(r.jobs.map((j) => [j.type, j.role, j.payload.targets])).toEqual([[SCAN_JOB, 'fake', ['svc']]]);
    expect((await settled(r.jobs[0])).status).toBe('done');
    const [scan] = core.listScans(pid);
    expect(scan).toMatchObject({ scanner: 'fake', status: 'complete', commitSha: head(), targets: ['svc'], findingCount: 3, toolVersion: 'fake-scanner 1.2.3' });
    expect(scan.commands[0]).toEqual([FAKE_SCANNER, 'scan', 'svc']);
    expect(scan.warnings).toEqual(['PartialParsing: Syntax error at line svc/Tpl.java:1: `%` was unexpected']);
    expect(fs.existsSync(path.join(core.paths.dataDir, pid, 'worktrees', head()))).toBe(true);
    expect((await core.runScanners(pid, { moduleIds: [moduleId] })).cached).toEqual(['fake']);

    // A whole-repository scan is a different target set; the view is the union per commit.
    const repoScan = await core.runScanners(pid, { moduleIds: null });
    expect(repoScan.jobs).toHaveLength(1);
    await settled(repoScan.jobs[0]);
    const view = await core.signalsView(pid);
    expect(view.commit).toBe(head());
    expect(view.signals.map((s) => [s.file, s.line, s.moduleIds.length, s.cwe])).toEqual([
      ['lib/Util.java', 1, 0, ['CWE-20']],
      ['svc/Api.java', 2, 1, ['CWE-20']],
      ['svc/Api.java', 3, 1, ['CWE-20']],
      ['svc/test/ApiTest.java', 1, 1, ['CWE-20']],
    ]);
  });

  it('get_signals: module slice minus suppressions; suppressions need a reason and record author and commit', async () => {
    const slice = await core.signalSlice(pid, { moduleId });
    expect(slice).toMatchObject({ total: 3, suppressed: 0, truncated: false, run_commit: head() });
    expect(String(slice.note)).toMatch(/hints, not a complete list/);
    expect(slice.scans).toEqual(expect.arrayContaining([expect.objectContaining({ scanner: 'fake', warnings_in_module: 1 })]));
    expect((slice.scans as { scanner: string; scanned: boolean }[]).map((s) => [s.scanner, s.scanned])).toEqual([
      ['fake', true],
      ['ghost', false],
    ]);

    const view = await core.signalsView(pid);
    const test = view.signals.find((s) => s.file === 'svc/test/ApiTest.java')!;
    await expect(core.createSuppression(pid, { scope: 'rule_glob', signalId: test.id, globs: ['svc/test/**'], reason: ' ' })).rejects.toThrow(/suppression reason/);
    await expect(core.createSuppression(pid, { scope: 'rule_glob', signalId: test.id, globs: ['lib/**'], reason: 'x' })).rejects.toThrow(/do not cover/);
    const rg = await core.createSuppression(pid, { scope: 'rule_glob', signalId: test.id, globs: ['svc/test/**'], reason: 'test code' });
    expect(rg).toMatchObject({ author: 'Alice <alice@example.com>', commitSha: head(), ruleId: 'fake.tainted-input', touchedFiles: ['svc/test/ApiTest.java'] });
    const a2 = view.signals.find((s) => s.file === 'svc/Api.java' && s.line === 2)!;
    const one = await core.createSuppression(pid, { scope: 'finding', signalId: a2.id, reason: 'validated by the filter', expiresAt: '2999-01-01' });
    expect(one).toMatchObject({ fingerprint: a2.fingerprint, file: 'svc/Api.java', line: 2, expiresAt: '2999-01-01' });
    await expect(core.createSuppression(pid, { scope: 'finding', signalId: a2.id, reason: 'x', expiresAt: '2000-01-01' })).rejects.toThrow(/future date/);

    const after = await core.signalSlice(pid, { moduleId });
    expect(after).toMatchObject({ total: 1, suppressed: 2 });
    expect((after.signals as { line: number }[]).map((s) => s.line)).toEqual([3]);
    expect((await core.signalsView(pid)).signals.filter((s) => s.suppression?.state === 'active')).toHaveLength(2);
    expect((await core.signalDetails(pid, a2.id)).suppressions.map((s) => s.id)).toEqual([one.id]);

    // Requirement x module hides every signal of that cell only.
    const req = requirement('IN-1', 'Validate request input');
    await core.createSuppression(pid, { scope: 'requirement_module', requirementId: req, moduleId, reason: 'validated by the gateway' });
    const cell = await core.signalSlice(pid, { moduleId, requirementId: req });
    expect(cell).toMatchObject({ total: 0, suppressed: 3 });
    expect(cell.cell_suppression).toEqual([{ state: 'active', reason: 'validated by the gateway', author: 'Alice <alice@example.com>' }]);
    expect((await core.signalSlice(pid, { moduleId })).total).toBe(1);

    await expect(core.revokeSuppression(pid, one.id, '')).rejects.toThrow(/reason for revoking/);
    await core.revokeSuppression(pid, one.id, 'filter removed');
    expect((await core.signalSlice(pid, { moduleId })).total).toBe(2);
    expect((await core.listSuppressions(pid)).find((s) => s.id === one.id)?.state).toBe('revoked');
  });

  it('suppressions become stale when the code they depend on changes; renew confirms them at HEAD', async () => {
    const before = head();
    write(path.join(repo, 'svc', 'test', 'ApiTest.java'), 'class ApiTest { String t = req.getParameter("t"); int n; }\n');
    git('commit', '-qam', 'test changed');
    const list = await core.listSuppressions(pid);
    const rg = list.find((s) => s.scope === 'rule_glob')!;
    expect(rg).toMatchObject({ state: 'stale', changedFiles: ['svc/test/ApiTest.java'] });
    expect(list.find((s) => s.scope === 'requirement_module')?.state).toBe('stale');

    // At the old commit the suppression still holds; at the new one the stale suppression does not filter.
    expect((await core.signalSlice(pid, { moduleId, commit: before })).total).toBe(2);
    await settled((await core.runScanners(pid, { moduleIds: [moduleId] })).jobs[0]);
    const now = await core.signalSlice(pid, { moduleId });
    expect(now).toMatchObject({ run_commit: head(), total: 3, suppressed: 0 });
    expect((now.signals as { suppression_not_applied?: { state: string } }[]).filter((s) => s.suppression_not_applied?.state === 'stale')).toHaveLength(1);

    const renewed = await core.renewSuppression(pid, rg.id);
    expect(renewed).toMatchObject({ commitSha: head(), replaces: rg.id });
    expect((await core.listSuppressions(pid)).find((s) => s.id === rg.id)?.state).toBe('revoked');
    expect((await core.signalSlice(pid, { moduleId })).total).toBe(2);
  });

  it('verdict sessions wait for auto-scans of their commit and get suppressions as few-shot', async () => {
    write(path.join(repo, 'svc', 'Slow.java'), '// SLOW_SCAN\nclass Slow { String s = req.getParameter("s"); }\n');
    git('add', '.');
    git('commit', '-qm', 'slow');
    const req = core.currentRequirements(pid).find((r) => r.key === 'IN-1')!;
    const docId = core.store(pid).audit.requirementDocument(req.requirementId)!;
    const matrix = core.saveMatrix(pid, { name: 'scan', documentIds: [docId], moduleIds: [moduleId] });
    await core.renewSuppression(pid, (await core.listSuppressions(pid)).find((s) => s.scope === 'requirement_module' && s.state !== 'revoked')!.id);

    const [vj] = await core.runMatrix(pid, matrix.id, 'verdicts', 'pending');
    const scanJob = core.store(pid).activeJobs().find((j) => j.type === SCAN_JOB)!;
    expect(scanJob.payload).toMatchObject({ scanner: 'fake', commit_sha: head(), targets: ['svc'] });
    const prompt = String(vj.payload.prompt);
    expect(prompt).toContain('fake rule `fake.tainted-input` in files svc/test/**');
    expect(prompt).toContain('all signals for requirement IN-1 in this module — suppressed by Alice <alice@example.com>');
    expect(prompt.indexOf('requirement IN-1')).toBeLessThan(prompt.indexOf('svc/test/**'));

    expect((await settled(vj)).status).toBe('done');
    const scan = core.listScans(pid).find((s) => s.jobId === scanJob.id)!;
    const run = core.store(pid).getRun(job(vj.id).lastRunId!)!;
    expect(scan.status).toBe('complete');
    expect(run.startedAt >= scan.finishedAt!).toBe(true);
    const verdict = (await core.matrixView(pid, matrix.id)).cells[0].verdict!;
    // The fake agent called get_signals for the cell: the requirement x module suppression hid all signals.
    expect(verdict.reason).toBe('checked in code (signals: 0, suppressed: 4)');
  });
});
