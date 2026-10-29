import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import type { AppEvent, Job } from '../src/shared/types';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const FAKE = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const GUIDE = `# Access control
AUTH-1: Every endpoint must check the caller's role SKIP_ONCE.
AUTH-2: Object access must verify ownership to prevent IDOR.

# Output
OUT-1: HTML output must be encoded against XSS.
OUT-2: Error responses must not leak stack traces.
`;

let core: Core;
let repo: string;
let pid: string;
let moduleId: string;
const events: AppEvent[] = [];
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });

beforeAll(async () => {
  const home = tmpDir();
  const data = fs.realpathSync(tmpDir());
  repo = fs.realpathSync(tmpDir());
  git('init', '-q');
  write(path.join(repo, 'svc', 'Api.java'), 'class Api {}');
  write(path.join(repo, 'lib', 'Util.java'), 'class Util {}');
  git('add', '.');
  git('commit', '-qm', 'init');

  ensureGlobalDefaults(DEFAULTS_DIR, home);
  const cfgFile = path.join(home, 'config.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(cfgFile, 'utf8'));
  doc.setIn(['claude', 'binary'], FAKE);
  doc.setIn(['queue', 'parallelism'], 1);
  // Scanners are covered by scan-core.test.ts; real ones must not run here.
  doc.setIn(['signals', 'auto_scan'], false);
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

describe('documents -> requirements -> matrix with a fake claude', () => {
  let docId: string;
  let matrixId: string;

  it('import queues extraction in the document directory; review is mandatory before approval', async () => {
    const file = path.join(tmpDir(), 'guide.md');
    write(file, GUIDE);
    const view = await core.importDocument(pid, file, { title: 'Mini guide' });
    docId = view.document.id;
    expect(view.version).toMatchObject({ n: 1, status: 'extracting', format: 'md' });
    const j = job(view.job!.id);
    expect(j).toMatchObject({ role: 'requirements', entityType: 'doc_version', entityId: view.version.id, title: 'Требования: Mini guide v1' });
    expect(String(j.payload.prompt)).toContain('the file `text.md`');
    const done = await settled(j);
    expect(done.status).toBe('done');
    const run = core.store(pid).getRun(done.lastRunId!)!;
    expect(run.cwd).toBe(path.join(core.paths.dataDir, pid, 'documents', view.version.id));
    expect(run.scope).toEqual([{ type: 'doc_version', id: view.version.id }]);

    const v = core.docVersion(pid, view.version.id);
    expect(v.version.status).toBe('review');
    expect(v.quotesVerified).toBe(true);
    // The made-up item with a quote that is not in the document was rejected.
    expect(v.items.map((i) => [i.key, i.section, i.change, i.review])).toEqual([
      ['AUTH-1', 'Access control', 'added', 'pending'],
      ['AUTH-2', 'Access control', 'added', 'pending'],
      ['OUT-1', 'Output', 'added', 'pending'],
      ['OUT-2', 'Output', 'added', 'pending'],
    ]);
    expect(() => core.approveVersion(pid, view.version.id)).toThrow(/не просмотрено/);
    core.reviewItems(pid, view.version.id, v.items.map((i) => i.id), 'accepted');
    core.saveItem(pid, view.version.id, { key: 'SEC-1', text: 'No secrets in source code.', section: 'Secrets', quote: '' });
    core.approveVersion(pid, view.version.id);
    expect(core.listDocuments(pid)[0].current?.itemCount).toBe(5);
    await expect(core.importDocument(pid, file, { documentId: docId })).rejects.toThrow(/совпадает/);
  });

  it('matrix: dry-run estimate, n/a triage, verdict batches by group with findings', async () => {
    write(path.join(repo, '.aiegis', 'config.yaml'), 'matrices: { mini: { effort: matrix-effort } }\nrequirements: { SEC-1: { model: item-model } }\n');
    matrixId = core.saveMatrix(pid, { name: 'mini', documentIds: [docId], moduleIds: [moduleId] }).id;
    const view = await core.matrixView(pid, matrixId);
    expect(view.cells).toHaveLength(5);
    expect(view.cells.every((c) => c.status === 'not_checked' && !c.stale)).toBe(true);

    const est = await core.estimateMatrix(pid, matrixId, 'triage', 'pending');
    expect(est).toMatchObject({ stage: 'triage', role: 'matrix-triage', sessions: 1, cells: 5, tokensPerCell: 2000, tokensPerCellSource: 'config', tokens: 10000 });
    const [tj] = await core.runMatrix(pid, matrixId, 'triage', 'pending');
    expect(tj.title).toBe('Отсев n/a: mini × svc');
    expect((await core.matrixView(pid, matrixId)).cells.every((c) => c.activeJob?.id === tj.id)).toBe(true);
    expect((await settled(tj)).status).toBe('done');
    const triaged = await core.matrixView(pid, matrixId);
    const byKey = (v: typeof triaged, key: string) => v.cells.find((c) => c.requirementId === v.requirements.find((r) => r.key === key)!.requirementId)!;
    expect(byKey(triaged, 'OUT-1')).toMatchObject({ status: 'n/a', triaged: false });
    expect(byKey(triaged, 'OUT-1').verdict).toMatchObject({ author: 'ai:matrix-triage', reason: 'looked at the build file' });
    expect(byKey(triaged, 'AUTH-1')).toMatchObject({ status: 'not_checked', triaged: true });
    expect((await core.estimateMatrix(pid, matrixId, 'triage', 'pending')).cells).toBe(0);

    const ve = await core.estimateMatrix(pid, matrixId, 'verdicts', 'pending');
    // Access control (2), Output (1 left after n/a), Secrets alone (own cascade level).
    expect(ve.batches.map((b) => [b.group, b.cells])).toEqual([
      ['Access control', 2],
      ['Output', 1],
      ['Secrets', 1],
    ]);
    const jobs = await core.runMatrix(pid, matrixId, 'verdicts', 'pending');
    expect(jobs.map((j) => j.title)).toEqual(['Вердикты: mini × svc / Access control', 'Вердикты: mini × svc / Output', 'Вердикты: mini × svc / Secrets']);
    await expect(core.recheckCells(pid, jobs[0].payload.cells as string[])).rejects.toThrow(/уже в очереди/);
    const done = await Promise.all(jobs.map(settled));
    // Cell-level atomicity (SPEC §7): the access batch left AUTH-1 without a verdict; retry re-runs only that cell.
    expect(done.map((d) => d.status)).toEqual(['failed', 'done', 'done']);
    expect(done[0].error).toMatch(/без результата осталось ячеек: 1/);
    const access = core.store(pid).getRun(done[0].lastRunId!)!;
    expect(access.configSnapshot).toMatchObject({ effort: { value: 'matrix-effort', source: 'матрица mini' } });
    expect(access.scope).toHaveLength(2);
    expect(core.store(pid).getRun(done[2].lastRunId!)!.configSnapshot).toMatchObject({ model: { value: 'item-model', source: 'пункт SEC-1' } });
    core.retryJob(pid, jobs[0].id);
    expect((await settled(jobs[0])).status).toBe('done');
    const runs = core.store(pid).jobRuns(jobs[0].id);
    expect(runs).toHaveLength(2);
    expect(runs[1].scope).toHaveLength(1);
    expect(String(job(jobs[0].id).payload.prompt).match(/^- requirement_id/gm)).toHaveLength(1);

    const v = await core.matrixView(pid, matrixId);
    expect(v.requirements.map((r) => byKey(v, r.key).status)).toEqual(['pass', 'finding', 'n/a', 'pass', 'pass']);
    const idor = byKey(v, 'AUTH-2');
    expect(idor.findingCount).toBe(1);
    const [f] = core.listFindings(pid);
    expect(f).toMatchObject({ title: 'IDOR in /api', status: 'suspected', cwe: 'CWE-639', cells: [{ moduleId, requirementId: idor.requirementId }] });
    expect(idor.verdict!.reason).toContain('needed a finding first');
    // Estimates now come from history.
    expect((await core.estimateRecheck(pid, [`${moduleId}/${idor.requirementId}`])).tokensPerCellSource).toBe('history');
  });

  it('history: human verdict, timeline, effective config, stale by code and by requirement', async () => {
    const v = await core.matrixView(pid, matrixId);
    const auth1 = v.requirements.find((r) => r.key === 'AUTH-1')!;
    const id = `${moduleId}/${auth1.requirementId}`;
    await expect(core.setVerdict(pid, id, { status: 'pass', reason: 'ok', evidence: [] })).rejects.toThrow(/ссылки на код/);
    await core.setVerdict(pid, id, { status: 'needs_human', reason: 'role model is in the gateway', evidence: [] });
    const d = await core.cellDetails(pid, id, matrixId);
    expect(d.verdicts[0]).toMatchObject({ author: 'human', status: 'needs_human', run: null });
    expect(d.verdicts.map((x) => x.author)).toEqual(['human', 'ai:matrix']);
    expect(d.triage[0].applicable).toBe(true);
    expect(d.config?.effort).toEqual({ value: 'matrix-effort', source: 'матрица mini' });

    // Code change in the module: AI verdicts made before become stale; untouched files do not matter.
    write(path.join(repo, 'lib', 'Util.java'), 'class Util { int x; }');
    git('commit', '-qam', 'lib only');
    expect((await core.matrixView(pid, matrixId)).cells.some((c) => c.stale)).toBe(false);
    write(path.join(repo, 'svc', 'Api.java'), 'class Api { void get() {} }');
    git('commit', '-qam', 'api');
    const after = await core.matrixView(pid, matrixId);
    expect(after.cells.every((c) => c.stale && c.staleReasons.includes('code'))).toBe(true);
    expect((await core.cellDetails(pid, id)).changedFiles).toEqual(['svc/Api.java']);
    const est = await core.estimateMatrix(pid, matrixId, 'verdicts', 'stale');
    expect(est.cells).toBe(5);

    // New document version with a changed requirement text.
    const file = path.join(tmpDir(), 'guide2.md');
    write(file, GUIDE.replace('verify ownership', 'verify ownership and tenant'));
    const nv = await core.importDocument(pid, file, { documentId: docId });
    // Items whose quote is unchanged are carried over without AI; the agent re-extracts only AUTH-2.
    const prompt = String(job(nv.job!.id).payload.prompt);
    expect(prompt).toContain('- OUT-1 [Output]: HTML output must be encoded against XSS.');
    expect(prompt).toMatch(/whose quoted text changed or is gone[^\n]*\n[^\n]*\n- AUTH-2 /);
    await settled(job(nv.job!.id));
    const view2 = core.docVersion(pid, nv.version.id);
    expect(view2.items.map((i) => [i.key, i.change, i.author, i.review])).toEqual([
      ['AUTH-1', 'same', 'auto', 'accepted'],
      ['OUT-1', 'same', 'auto', 'accepted'],
      ['OUT-2', 'same', 'auto', 'accepted'],
      ['AUTH-2', 'changed', 'ai:requirements', 'pending'],
    ]);
    expect(view2.removed.map((i) => i.key)).toEqual(['SEC-1']);
    core.reviewItems(pid, nv.version.id, view2.items.map((i) => i.id), 'accepted');
    core.approveVersion(pid, nv.version.id);
    const m3 = await core.matrixView(pid, matrixId);
    expect(m3.requirements).toHaveLength(4);
    const idor = m3.cells.find((c) => c.requirementId === m3.requirements.find((r) => r.key === 'AUTH-2')!.requirementId)!;
    expect(idor.staleReasons).toEqual(['requirement', 'code']);
  });

  it('findings: status with reason, merge, fix session in the working copy offers re-checks after a commit', async () => {
    const [f] = core.listFindings(pid);
    expect(() => core.setFindingStatus(pid, f.id, 'false_positive', ' ')).toThrow(/причину/);
    core.setFindingStatus(pid, f.id, 'verified', 'reproduced');
    const cell = `${f.cells[0].moduleId}/${f.cells[0].requirementId}`;
    const dup = core.createFinding(pid, cell, { title: 'IDOR again', description: 'd', severity: 'medium', cwe: 'CWE-639', entryPoint: null, files: [{ file: 'svc/Api.java' }], recommendation: null });
    const details = core.findingDetails(pid, dup.id);
    expect(details.similar[0].finding.id).toBe(f.id);
    core.mergeFinding(pid, dup.id, f.id);
    expect(core.findingDetails(pid, f.id).events.map((e) => e.kind)).toContain('status');
    expect(core.listFindings(pid).filter((x) => !x.mergedInto)).toHaveLength(1);

    const term = await core.openFixSession(pid, dup.id);
    const info = core.terminals.list().find((t) => t.id === term)!;
    expect(core.store(pid).getRun(info.runId)).toMatchObject({ cwd: repo, role: 'assistant', entityType: 'finding', entityId: f.id });
    await waitFor(() => core.terminals.snapshot(term).includes('initial prompt: Help me fix finding'));
    write(path.join(repo, 'svc', 'Api.java'), 'class Api { void get() { check(); } }');
    git('commit', '-qam', 'fix');
    core.terminals.write(term, 'q\r');
    const notice = await waitFor(() => events.find((e) => e.type === 'notice' && e.recheck));
    expect(notice.type === 'notice' && notice.recheck!.cells).toContain(cell);
    expect(core.findingDetails(pid, f.id).runs.some((r) => r.id === info.runId)).toBe(true);
  });
});
