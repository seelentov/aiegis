import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import { diffVerdictError } from '../src/main/diff-check';
import { commitOf, listBranches } from '../src/main/git';
import { piRunConfig } from '../src/main/pi/args';
import { decide } from '../src/main/pi/permissions';
import type { DiffCheckInput, Job } from '../src/shared/types';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const FAKE = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

async function waitFor<T>(fn: () => T | undefined | false, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('verdict rules', () => {
  const files = ['a.java'];
  it('asks evidence, a severity and a changed file of a finding', () => {
    expect(diffVerdictError(files, 'n/a', undefined, [])).toBeNull();
    expect(diffVerdictError(files, 'pass', undefined, [])).toMatch(/evidence/);
    expect(diffVerdictError(files, 'needs_human', undefined, [])).toMatch(/evidence/);
    expect(diffVerdictError(files, 'needs_human', undefined, [{ file: 'b.java' }])).toBeNull();
    expect(diffVerdictError(files, 'finding', undefined, [{ file: 'a.java' }])).toMatch(/severity/);
    expect(diffVerdictError(files, 'finding', 'high', [{ file: 'b.java' }])).toMatch(/changes/);
    expect(diffVerdictError(files, 'finding', 'high', [{ file: 'b.java' }, { file: 'a.java' }])).toBeNull();
  });
});

describe('branch checks', () => {
  let core: Core;
  let repo: string;
  let pid: string;
  let documentId: string;
  let setId: string;
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
  const jobsDone = (jobs: Job[]) => waitFor(() => jobs.every((j) => ['done', 'failed'].includes(core.store(pid).getJob(j.id)!.status)));
  const importDoc = async (title: string, text: string) => {
    const file = path.join(tmpDir(), `${title}.md`);
    write(file, text);
    const v = await core.importDocument(pid, file, { title });
    await waitFor(() => core.docVersion(pid, v.version.id).version.status !== 'extracting');
    core.reviewItems(pid, v.version.id, core.docVersion(pid, v.version.id).items.map((i) => i.id), 'accepted');
    core.approveVersion(pid, v.version.id);
    return v.document.id;
  };

  beforeAll(async () => {
    const home = tmpDir();
    repo = fs.realpathSync(tmpDir());
    git('init', '-q', '-b', 'main');
    write(path.join(repo, 'svc', 'Gone.java'), 'class Gone {}');
    write(path.join(repo, 'lib', 'Util.java'), 'class Util {}');
    git('add', '.');
    git('commit', '-qm', 'init');
    git('checkout', '-qb', 'task');
    git('rm', '-q', 'svc/Gone.java');
    git('commit', '-qm', 'drop the check');
    git('checkout', '-q', 'main');
    git('checkout', '-qb', 'big');
    write(path.join(repo, 'big.txt'), 'x'.repeat(4000));
    git('add', '.');
    git('commit', '-qm', 'big');
    git('checkout', '-q', 'main');
    // Moves the target after the fork: the check must not see this file.
    write(path.join(repo, 'later.txt'), 'x');
    git('add', '.');
    git('commit', '-qm', 'later');

    ensureGlobalDefaults(DEFAULTS_DIR, home);
    const cfg = path.join(home, 'config.yaml');
    const doc = YAML.parseDocument(fs.readFileSync(cfg, 'utf8'));
    doc.setIn(['claude', 'binary'], FAKE);
    doc.setIn(['queue', 'parallelism'], 1);
    doc.setIn(['signals', 'auto_scan'], false);
    doc.setIn(['diff_check', 'max_diff_kb_in_prompt'], 1);
    fs.writeFileSync(cfg, doc.toString());
    core = new Core({ globalDir: home, dataDir: fs.realpathSync(tmpDir()), defaultsDir: DEFAULTS_DIR });
    await core.start();
    pid = (await core.addProject(repo)).id;
    documentId = await importDoc('Guide', '# Access\nAUTH-1: Object access must verify ownership to prevent IDOR.\nAUTH-2: Sessions expire SKIP_ONCE.\nAUTH-3: Tokens are signed.\n');
    const other = await importDoc('Other', '# Output\nOUT-1: Errors must not leak stack traces.\n');
    setId = core.store(pid).audit.saveDocSet({ name: 'Set', scope: '', links: [] }).id;
    core.store(pid).audit.setDocumentSet(documentId, setId);
    core.store(pid).audit.setDocumentSet(other, setId);
  });

  afterAll(() => core.shutdown());

  it('lists branches and does not read a ref as a flag', async () => {
    expect(await listBranches(repo)).toEqual(['big', 'main', 'task']);
    await expect(commitOf(repo, '--all')).rejects.toThrow(/not found/);
    await expect(commitOf(repo, 'nope')).rejects.toThrow(/not found/);
  });

  it('checks what the branch brings, re-runs only open requirements and accepts a deleted file as evidence', async () => {
    const input: DiffCheckInput = { baseRef: 'main', headRef: 'task', target: { documentId } };
    const est = await core.estimateDiffCheck(pid, input);
    expect(est).toMatchObject({ cells: 3, sessions: 1, role: 'diff-check' });

    const { check, jobs } = await core.runDiffCheck(pid, input);
    expect(check.files).toEqual(['svc/Gone.java']);
    expect(check.baseSha).toBe(git('rev-parse', 'main~1').trim());
    expect(check.headSha).toBe(git('rev-parse', 'task').trim());
    expect(String(jobs[0].payload.prompt)).toContain('-class Gone {}');
    await jobsDone(jobs);

    const job = core.store(pid).getJob(jobs[0].id)!;
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/requirements left without a verdict: 1/);
    let view = core.diffCheckView(pid, check.id);
    expect(view.check.counts).toMatchObject({ finding: 1, 'n/a': 1, not_checked: 1 });
    const finding = view.rows.find((r) => r.verdict?.status === 'finding')!;
    expect(finding).toMatchObject({ documentTitle: 'Guide', verdict: { severity: 'high', reason: 'owner check removed', evidence: [{ file: 'svc/Gone.java' }] } });
    expect(fs.readFileSync(core.runDetails(pid, core.store(pid).listRuns(1)[0].id).log!, 'utf8')).toMatch(/outside=true no_severity=true[\s\S]*saved=1 foreign_rejected=not-mine/);

    core.retryJob(pid, job.id);
    await waitFor(() => core.store(pid).getJob(job.id)!.status === 'done');
    view = core.diffCheckView(pid, check.id);
    expect(view.check.counts).toMatchObject({ finding: 1, 'n/a': 2, not_checked: 0 });
    expect(String(core.store(pid).getJob(job.id)!.payload.prompt)).not.toContain('AUTH-1');
  });

  it('covers every document of a set in one session', async () => {
    const { check, jobs } = await core.runDiffCheck(pid, { baseRef: 'main', headRef: 'task', target: { setId } });
    expect(check.title).toBe('Set');
    expect(jobs).toHaveLength(1);
    for (const title of ['### Guide', '### Other']) expect(String(jobs[0].payload.prompt)).toContain(title);
    await waitFor(() => jobs.every((j) => core.store(pid).getJob(j.id)!.status !== 'queued' && core.store(pid).getJob(j.id)!.status !== 'running'));
    const view = core.diffCheckView(pid, check.id);
    expect(view.rows.map((r) => r.documentTitle).sort()).toEqual(['Guide', 'Guide', 'Guide', 'Other']);
    expect(core.listDiffChecks(pid).map((c) => c.id)).toContain(check.id);
  });

  it('keeps a large diff out of the prompt', async () => {
    const { jobs } = await core.runDiffCheck(pid, { baseRef: 'main', headRef: 'big', target: { documentId } });
    expect(String(jobs[0].payload.prompt)).toContain('too large for this prompt');
    await waitFor(() => !['queued', 'running'].includes(core.store(pid).getJob(jobs[0].id)!.status));
  });

  it('rejects a branch with no changes and a target without approved requirements', async () => {
    await expect(core.estimateDiffCheck(pid, { baseRef: 'task', headRef: 'task', target: { documentId } })).rejects.toThrow(/no changes/);
    await expect(core.estimateDiffCheck(pid, { baseRef: 'main', headRef: 'task', target: { documentId: 'gone' } })).rejects.toThrow(/not found/);
    const empty = core.store(pid).audit.saveDocSet({ name: 'Empty', scope: '', links: [] }).id;
    await expect(core.estimateDiffCheck(pid, { baseRef: 'main', headRef: 'task', target: { setId: empty } })).rejects.toThrow(/no approved/);
  });

  it('a schedule starts only for changes it has not seen', async () => {
    const target = { documentId };
    const action = { kind: 'diff_check' as const, baseRef: 'main', headRef: 'task', target };
    await expect(core.createSchedule(pid, { name: 'gone', cron: '0 3 * * *', action: { ...action, headRef: 'nope' }, maxTokens: null })).rejects.toThrow(/not found/);
    const s = await core.createSchedule(pid, { name: 'pr', cron: '0 3 * * *', action, maxTokens: 10_000_000 });
    expect((await core.runSchedule(pid, s.id)).outcome).toBe('nothing_to_do');

    git('checkout', '-q', 'task');
    write(path.join(repo, 'svc', 'New.java'), 'class New {}');
    git('add', '.');
    git('commit', '-qm', 'more');
    git('checkout', '-q', 'main');
    const small = await core.updateSchedule(pid, s.id, { maxTokens: 1 });
    expect((await core.runSchedule(pid, small.id)).outcome).toBe('over_limit');
    await core.updateSchedule(pid, s.id, { maxTokens: null });
    const firing = await core.runSchedule(pid, s.id);
    expect(firing.outcome).toBe('started');
    await waitFor(() => firing.jobIds.every((id) => !['queued', 'running'].includes(core.store(pid).getJob(id)!.status)));
    expect((await core.runSchedule(pid, s.id)).outcome).toBe('nothing_to_do');
  });

  it('the role cannot write files through git', () => {
    const rc = piRunConfig(core.resolve(pid, 'diff-check'), { url: 'http://127.0.0.1', token: 't' });
    const bash = (command: string) => decide(rc, repo, 'bash', { command }).kind;
    expect(bash('git diff a..b -- x')).toBe('allow');
    expect(bash('git log --oneline -3')).toBe('allow');
    for (const c of ['git diff --output=/tmp/x a..b', 'git show --outp=/tmp/x HEAD', 'git log -p --output /tmp/x']) expect(bash(c)).not.toBe('allow');
  });
});
