import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import type { DocSet, DocumentSummary, Job } from '../src/shared/types';
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

let core: Core;
let pid: string;
let server: http.Server;
let base: string;
const pages = new Map<string, { body: string; type?: string; status?: number }>();

const html = (body: string, noise = '') => `<html><body><nav>${noise}</nav><main>${body}</main></body></html>`;
const FIRST = 'A-1: Rule one must hold.\nA-2: Rule two must hold.\n';
const OTHER = 'V-1: Standard rule must hold.\n';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = pages.get(req.url ?? '');
    res.statusCode = p?.status ?? (p ? 200 : 404);
    res.setHeader('content-type', p?.type ?? 'text/html; charset=utf-8');
    res.end(p?.body ?? 'missing');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = tmpDir();
  const repo = fs.realpathSync(tmpDir());
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  git('init', '-q');
  write(path.join(repo, 'svc', 'Api.java'), 'class Api {}');
  git('add', '.');
  git('commit', '-qm', 'init');
  ensureGlobalDefaults(DEFAULTS_DIR, home);
  const cfgFile = path.join(home, 'config.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(cfgFile, 'utf8'));
  doc.setIn(['claude', 'binary'], FAKE);
  doc.setIn(['queue', 'parallelism'], 2);
  doc.setIn(['doc_refresh', 'allow_private_addresses'], true);
  fs.writeFileSync(cfgFile, doc.toString());
  core = new Core({ globalDir: home, dataDir: fs.realpathSync(tmpDir()), defaultsDir: DEFAULTS_DIR });
  await core.start();
  pid = (await core.addProject(repo)).id;
  await core.saveModule(pid, { name: 'svc', globs: ['svc/**'], description: 'api' });
});

afterAll(async () => {
  await core.shutdown();
  server.close();
});

const settled = (id: string) => waitFor(() => !['queued', 'running'].includes(core.store(pid).getJob(id)!.status) && core.store(pid).getJob(id)!);
const docOf = (id: string) => core.listDocuments(pid).find((d) => d.id === id) as DocumentSummary;
const pending = () => core.listDocProposals(pid).filter((p) => p.status === 'pending');
const refreshJobs = () => core.store(pid).listJobs(500).filter((j) => j.entityType === 'doc_refresh');
const logOf = (j: Job) => fs.readFileSync(core.store(pid).getRun(j.lastRunId!)!.logPath!, 'utf8');

/** Imports, extracts with the fake agent and approves. */
async function approved(title: string, text: string, o: { setId?: string } = {}): Promise<string> {
  const file = path.join(tmpDir(), 'doc.md');
  write(file, text);
  const v = await core.importDocument(pid, file, { title, ...o });
  await settled(v.job!.id);
  const view = core.docVersion(pid, v.version.id);
  core.reviewItems(pid, v.version.id, view.items.map((i) => i.id), 'accepted');
  core.approveVersion(pid, v.version.id);
  return v.document.id;
}

async function check(target: { setId: string } | { documentId: string }, o: { force?: boolean } = {}) {
  const r = await core.refreshDocuments(pid, target, o);
  return { ...r, job: r.job ? await settled(r.job.id) : null };
}

describe('document refresher', () => {
  let set: DocSet;
  let docA: string;
  let docB: string;
  let matrixId: string;

  it('a set: checks only its documents, an agent reaches only its own tools and hosts', async () => {
    pages.set('/list', { body: html('<h1>Orders</h1><p>Edition first. Rule one must hold.</p>', 'menu 1') });
    set = core.saveDocSet(pid, { name: 'Regulator', scope: 'orders of the regulator', links: [{ url: `${base}/list`, insecure: false }] });
    docA = await approved('Order A', FIRST, { setId: set.id });
    docB = await approved('Standard', OTHER);
    matrixId = core.saveMatrix(pid, { name: 'm', documentIds: [docA, docB], moduleIds: [] }).id;
    expect(core.estimateDocRefresh(pid, { setId: set.id })).toMatchObject({ role: 'doc-refresh', documents: 1, tokensSource: 'config' });

    const { job } = await check({ setId: set.id });
    expect(job!.status).toBe('done');
    expect(job).toMatchObject({ role: 'doc-refresh', entityType: 'doc_refresh', entityId: `set:${set.id}` });
    const prompt = String(job!.payload.prompt);
    expect(prompt).toContain('"Order A"');
    expect(prompt).not.toContain('Standard');
    const log = logOf(job!);
    expect(log).toContain('Tool list_documents not found');
    expect(log).toContain('not among the links');
    expect(docOf(docA).lastCheck).toMatchObject({ status: 'current', url: `${base}/list`, unverifiedChannel: true });
    expect(docOf(docA).edition).toBe('first');
    expect(docOf(docB).lastCheck).toBeNull();
    expect(pending()).toEqual([]);
  });

  it('nothing changed on the source: no agent, even if the menu of the site changed', async () => {
    const before = refreshJobs().length;
    const at = docOf(docA).lastCheck!.at;
    await new Promise((r) => setTimeout(r, 5));
    pages.set('/list', { body: html('<h1>Orders</h1><p>Edition first. Rule one must hold.</p>', 'menu 2') });
    const r = await check({ setId: set.id });
    expect(r).toMatchObject({ job: null, unchanged: true, compared: 1, failed: [] });
    expect(refreshJobs()).toHaveLength(before);
    expect(docOf(docA).lastCheck!.at > at).toBe(true);
    expect(pending()).toEqual([]);
  });

  it('a site down: no agent, not current any more, and back when the site is', async () => {
    const before = refreshJobs().length;
    const body = pages.get('/list')!.body;
    const lastCurrent = docOf(docA).lastCheck!.lastCurrentAt;
    pages.set('/list', { body: 'down', status: 503 });
    const r = await check({ setId: set.id });
    expect(r.job).toBeNull();
    expect(r.failed[0].error).toContain('HTTP 503');
    expect(docOf(docA).lastCheck).toMatchObject({ status: 'unverifiable', lastCurrentAt: lastCurrent });
    pages.set('/list', { body });
    expect(await check({ setId: set.id })).toMatchObject({ job: null, unchanged: true });
    expect(docOf(docA).lastCheck!.status).toBe('current');
    expect(refreshJobs()).toHaveLength(before);
  });

  it('force runs the agent; it still changes nothing without a change', async () => {
    const { job } = await check({ setId: set.id }, { force: true });
    expect(job!.status).toBe('done');
    expect(pending()).toEqual([]);
  });

  it('refuses a proposal without proof; repeats and rejections do not come back', async () => {
    pages.set('/list', { body: html('<p>NEW EDITION e2</p><p>A-1: Rule one must hold now.</p><p>END</p>') });
    const { job } = await check({ setId: set.id });
    const log = logOf(job!);
    expect(log).toContain('state the edition');
    expect(log).toContain('the quote is not on the page');
    expect(pending()).toHaveLength(1);
    expect(pending()[0]).toMatchObject({ kind: 'update', documentId: docA, edition: 'e2', unverifiedChannel: true });
    expect(docOf(docA).lastCheck!.status).toBe('changed');
    // Without a human decision the same change stays one proposal.
    await check({ setId: set.id }, { force: true });
    expect(pending()).toHaveLength(1);
    const id = pending()[0].id;
    core.rejectDocProposal(pid, id, 'not relevant');
    const again = await check({ setId: set.id }, { force: true });
    expect(logOf(again.job!)).toContain('a human rejected this proposal');
    expect(pending()).toEqual([]);
    expect(docOf(docA).lastCheck!.status).toBe('unverifiable');
  });

  it('something newer on the source outdates the old proposal; applying goes through extraction and review', async () => {
    pages.set('/list', { body: html('<p>NEW EDITION e3</p><p>A-1: Rule one must hold now.</p><p>END</p>') });
    await check({ setId: set.id });
    const old = pending()[0];
    pages.set('/list', { body: html('<p>NEW EDITION e4</p><p>A-1: Rule one must hold always.</p><p>A-2: Rule two must hold.</p><p>END</p>') });
    await check({ setId: set.id });
    expect(core.listDocProposals(pid).find((p) => p.id === old.id)!.status).toBe('outdated');
    const p = pending()[0];
    const cellsBefore = await core.matrixSlice(pid, matrixId, {});
    const applied = await core.acceptDocProposal(pid, p.id);
    expect(applied.status).toBe('applied');
    const view = core.docVersion(pid, applied.versionId!);
    expect(view.proposal?.id).toBe(p.id);
    expect(fs.existsSync(path.join(path.dirname(view.sourceFile!), 'page-1.html'))).toBe(true);
    expect(fs.readFileSync(view.sourceFile!, 'utf8')).toBe('NEW EDITION e4\nA-1: Rule one must hold always.\nA-2: Rule two must hold.\nEND');
    expect(docOf(docA).edition).toBe('e4');
    // Nothing in the matrix changes before the approval.
    expect(await core.matrixSlice(pid, matrixId, {})).toEqual(cellsBefore);
    // An unapproved version blocks a further update instead of being overwritten.
    await settled(view.job!.id);
    pages.set('/list', { body: html('<p>NEW EDITION e5</p><p>A-1: Another text.</p><p>END</p>') });
    await check({ setId: set.id });
    await expect(core.acceptDocProposal(pid, pending()[0].id)).rejects.toThrow(/unapproved version/);
    core.rejectDocProposal(pid, pending()[0].id, '');
    const v = core.docVersion(pid, applied.versionId!);
    core.reviewItems(pid, v.version.id, v.items.filter((i) => i.review === 'pending').map((i) => i.id), 'accepted');
    core.approveVersion(pid, v.version.id);
    const items = core.currentRequirements(pid).filter((i) => i.documentTitle === 'Order A');
    expect(items.find((i) => i.key === 'A-1')?.text).toContain('always');
  });

  it('text rewritten by AI: refused when not on the page, marked when accepted', async () => {
    pages.set('/list', { body: html('<p>RESTORED</p><p>Clause restored from a page.</p>') });
    const { job } = await check({ setId: set.id });
    expect(logOf(job!)).toMatch(/only 0% of the paragraphs/);
    expect(pending()[0]).toMatchObject({ restored: true, coverage: 1, edition: 'r1' });
    core.rejectDocProposal(pid, pending()[0].id, '');
  });

  it('retire and restore: the requirements leave and come back, history stays', async () => {
    const withCells = await core.matrixSlice(pid, matrixId, {});
    pages.set('/list', { body: html('<p>CANCELLED by a new act</p>') });
    const { job } = await check({ setId: set.id });
    expect(logOf(job!)).toContain('needs a quote');
    expect(pending()[0].kind).toBe('retire');
    await core.acceptDocProposal(pid, pending()[0].id);
    expect(docOf(docA).retiredAt).not.toBeNull();
    expect(core.currentRequirements(pid).some((i) => i.documentTitle === 'Order A')).toBe(false);
    expect((await core.matrixSlice(pid, matrixId, {})).length).toBeLessThan(withCells.length);
    expect(docOf(docA).current).not.toBeNull();
    // Out of force: not checked at all.
    await expect(core.refreshDocuments(pid, { documentId: docA })).rejects.toThrow(/out of force/);
    expect(core.estimateDocRefresh(pid, { setId: set.id }).documents).toBe(0);
    core.restoreDocument(pid, docA);
    expect(docOf(docA).retiredAt).toBeNull();
    expect((await core.matrixSlice(pid, matrixId, {})).length).toBe(withCells.length);
  });

  it('replace: the old document leaves only when the new one is approved, and stays if it is discarded', async () => {
    pages.set('/list', { body: html('<p>REPLACED BY order S</p><p>S-1: Successor rule must hold.</p><p>END</p>') });
    await check({ setId: set.id });
    const applied = await core.acceptDocProposal(pid, pending()[0].id);
    const successor = applied.resultDocumentId!;
    expect(docOf(successor)).toMatchObject({ replaces: docA, setId: set.id });
    expect(core.listMatrices(pid).find((m) => m.id === matrixId)!.documentIds).toContain(successor);
    expect(docOf(docA).retiredAt).toBeNull();
    const v = core.docVersion(pid, applied.versionId!);
    await settled(v.job!.id);
    const view = core.docVersion(pid, v.version.id);
    core.reviewItems(pid, v.version.id, view.items.map((i) => i.id), 'accepted');
    core.approveVersion(pid, v.version.id);
    expect(docOf(docA).retiredAt).not.toBeNull();
    expect(docOf(docA).retiredReason).toContain('Successor');
    expect(core.currentRequirements(pid).some((i) => i.key === 'S-1')).toBe(true);
    core.restoreDocument(pid, docA);
    core.retireDocument(pid, successor, 'test cleanup');
  });

  it('add: into the checked set; a file already in the project moves instead of duplicating', async () => {
    pages.set('/standard.txt', { body: OTHER, type: 'text/plain; charset=utf-8' });
    pages.set('/list', { body: html('<p>Orders</p><a href="/standard.txt">ADD Standard copy</a>') });
    await check({ setId: set.id });
    const p = pending().find((x) => x.kind === 'add')!;
    expect(p.setId).toBe(set.id);
    const count = core.listDocuments(pid).length;
    const applied = await core.acceptDocProposal(pid, p.id);
    expect(applied.resultDocumentId).toBe(docB);
    expect(core.listDocuments(pid)).toHaveLength(count);
    expect(docOf(docB).setId).toBe(set.id);
    core.setDocumentSet(pid, docB, null);
  });

  it('a new file joins the set and the matrices with documents of the set', async () => {
    pages.set('/new.txt', { body: 'N-1: New rule must hold.\n', type: 'text/plain; charset=utf-8' });
    pages.set('/list', { body: html('<p>Orders</p><a href="/new.txt">ADD Fresh order</a>') });
    await check({ setId: set.id });
    const applied = await core.acceptDocProposal(pid, pending().find((x) => x.kind === 'add')!.id);
    const fresh = applied.resultDocumentId!;
    expect(docOf(fresh)).toMatchObject({ title: 'Fresh order', setId: set.id, source: { url: `${base}/new.txt`, insecure: false } });
    expect(core.listMatrices(pid).find((m) => m.id === matrixId)!.documentIds).toContain(fresh);
    await settled(core.docVersion(pid, applied.versionId!).job!.id);
  });

  it('one document: its link only, with no additions; the document needs a link', async () => {
    await expect(core.refreshDocuments(pid, { documentId: docB })).rejects.toThrow(/no link/);
    await expect(core.refreshDocuments(pid, { setId: core.saveDocSet(pid, { name: 'Empty', scope: '', links: [] }).id })).rejects.toThrow(/no links/);
    pages.set('/own', { body: html('<p>Standard</p><a href="/new.txt">ADD Not allowed here</a>') });
    core.setDocumentSource(pid, docB, { url: `${base}/own`, insecure: false });
    const before = pending().length;
    const { job } = await check({ documentId: docB });
    expect(job!.entityId).toBe(`doc:${docB}`);
    expect(logOf(job!)).toContain('cannot add documents');
    expect(pending()).toHaveLength(before);
    expect(() => core.setDocumentSource(pid, docB, { url: 'file:///etc/passwd', insecure: false })).toThrow(/only http and https/);
  });

  it('a failed run: the documents are unverifiable and the next check starts over', async () => {
    const s = core.saveDocSet(pid, { name: 'Limited', scope: 'TOKENS', links: [{ url: `${base}/own`, insecure: false }] });
    const d = await approved('Limited doc', 'L-1: A limited rule must hold.\n', { setId: s.id });
    const { job } = await check({ setId: s.id });
    expect(job!.status).toBe('failed');
    expect(docOf(d).lastCheck!.status).toBe('unverifiable');
    expect(core.store(pid).audit.refreshBaseline(`set:${s.id}`)).toBeUndefined();
    core.removeDocSet(pid, s.id);
    expect(docOf(d).setId).toBeNull();
  });

  it('first filling of an empty set: all additions at once, only there', async () => {
    pages.set('/one.txt', { body: 'O-1: One must hold.\n', type: 'text/plain; charset=utf-8' });
    pages.set('/fill', { body: html('<a href="/one.txt">ADD One</a>') });
    const s = core.saveDocSet(pid, { name: 'To fill', scope: 'all', links: [{ url: `${base}/fill`, insecure: false }] });
    await check({ setId: s.id });
    const done = await core.acceptAllDocAdditions(pid, s.id);
    expect(done.map((p) => p.status)).toEqual(['applied']);
    await expect(core.acceptAllDocAdditions(pid, s.id)).rejects.toThrow(/empty set/);
    await settled(core.docVersion(pid, done[0].versionId!).job!.id);
  });
});
