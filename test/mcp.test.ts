import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db';
import { AiegisMcpServer, mcpConfigJson, NO_SIGNALS_REASON } from '../src/main/mcp/server';
import { TokenRegistry } from '../src/main/mcp/tokens';
import { ProjectStore } from '../src/main/store';
import { tmpDir, write } from './helpers';

const tokens = new TokenRegistry();
const store = new ProjectStore('p1', openDb(':memory:'));
const enqueued: string[] = [];
let docText: string | null = null;
const signalQueries: unknown[] = [];
const reportDir = tmpDir();
const server = new AiegisMcpServer(tokens, {
  store: () => store,
  projectName: () => 'demo',
  enqueueTask: (_pid, t) => {
    enqueued.push(t.prompt);
    return store.addJob({ type: 'agent', role: t.role, title: t.title, entityType: 'task', entityId: 'x', payload: {} });
  },
  stopJob: () => undefined,
  queueState: () => ({ pausedUntil: null, parallelism: 2, running: 0 }),
  documentText: () => docText,
  matrixView: () => Promise.reject(new Error('n/a')),
  cellDetails: () => Promise.reject(new Error('n/a')),
  recheckCells: () => Promise.resolve([]),
  similarLimit: () => 5,
  signals: (_pid, q) => {
    signalQueries.push(q);
    return Promise.resolve({ signals: [{ rule: 'r1' }] });
  },
  scaSettings: () => ({ estimate_history_runs: 20, estimate_tokens_per_package: 1000, scanner_hints_limit: 10, prefilter_max_file_kb: 64, report_max_mb: 1 }),
  scaReportFile: (_pid, r) => path.join(reportDir, `${r.id}${path.extname(r.path)}`),
  onWrite: () => undefined,
});

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url()), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

beforeAll(() => server.start());
afterAll(() => server.stop());

describe('MCP server with run tokens', () => {
  const run = store.startRun({ kind: 'background', role: 'task', author: 'ai:task', sessionId: 's1', cwd: '/', commitSha: 'a', configSnapshot: {} });

  it('rejects requests without a valid token', async () => {
    const res = await fetch(server.url(), { method: 'POST', headers: { Authorization: 'Bearer deadbeef', 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    await expect(connect('00')).rejects.toThrow();
  });

  it('scoped token: whoami, write in scope, reject out of scope and management', async () => {
    const g = tokens.issue({ projectId: 'p1', role: 'task', access: 'scoped', sessionId: 's1', runId: run.id, scope: [{ type: 'task', id: 'j1' }] });
    const c = await connect(g.token);
    const tools = (await c.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['whoami', 'submit_result', 'enqueue_task', 'list_runs']));

    const who = JSON.parse(text(await c.callTool({ name: 'whoami', arguments: {} })));
    expect(who).toMatchObject({ role: 'task', access: 'scoped', session_id: 's1', run_id: run.id, project: { name: 'demo' } });

    const okRes = await c.callTool({ name: 'submit_result', arguments: { entity_type: 'task', entity_id: 'j1', summary: 'done' } });
    expect(okRes.isError).toBeFalsy();
    expect(store.listResults({ entityId: 'j1' })[0]).toMatchObject({ runId: run.id, author: 'ai:task', data: { summary: 'done' } });

    const bad = await c.callTool({ name: 'submit_result', arguments: { entity_type: 'task', entity_id: 'j2', summary: 'x' } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/вне scope/);
    expect(store.listResults({ entityId: 'j2' })).toHaveLength(0);

    const manage = await c.callTool({ name: 'enqueue_task', arguments: { prompt: 'p' } });
    expect(manage.isError).toBe(true);
    expect(enqueued).toHaveLength(0);
    await c.close();
  });

  it('manage token can enqueue; revoked token stops working', async () => {
    const g = tokens.issue({ projectId: 'p1', role: 'assistant', access: 'manage', sessionId: 's2', runId: 'r2', scope: [] });
    const c = await connect(g.token);
    const r = await c.callTool({ name: 'enqueue_task', arguments: { prompt: 'scan it' } });
    expect(r.isError).toBeFalsy();
    expect(enqueued).toEqual(['scan it']);
    await c.close();
    tokens.revoke(g.token);
    await expect(connect(g.token)).rejects.toThrow();
  });

  it('get_signals is a read tool bound to the commit of the token run', async () => {
    const r = store.startRun({ kind: 'background', role: 'matrix', author: 'ai:matrix', sessionId: 's3', cwd: '/', commitSha: 'sig-sha', configSnapshot: {} });
    const g = tokens.issue({ projectId: 'p1', role: 'matrix', access: 'scoped', sessionId: 's3', runId: r.id, scope: [] });
    const c = await connect(g.token);
    const res = await c.callTool({ name: 'get_signals', arguments: { module_id: 'm1', requirement_id: 'q1', min_severity: 'medium', limit: 5 } });
    expect(JSON.parse(text(res))).toEqual({ signals: [{ rule: 'r1' }] });
    expect(signalQueries.at(-1)).toEqual({ moduleId: 'm1', requirementId: 'q1', commit: 'sig-sha', kind: null, scanner: null, minSeverity: 'medium', filePrefix: null, limit: 5 });
    expect((await c.callTool({ name: 'get_signals', arguments: { module_id: 'm1', kind: 'nope' } })).isError).toBe(true);
    await c.close();
  });

  it('mcp config file format', () => {
    expect(JSON.parse(mcpConfigJson('http://127.0.0.1:1/mcp', 'tok'))).toEqual({
      mcpServers: { aiegis: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer tok' } } },
    });
  });
});

describe('MCP module and entry point tools', () => {
  const repo = tmpDir();
  write(path.join(repo, 'svc/Api.java'), 'class Api {}');
  write(path.join(repo, 'svc/Repo.java'), 'class Repo {}');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  const base = { kind: 'background' as const, author: 'ai', sessionId: 's', cwd: repo, commitSha: 'c1', configSnapshot: {} };

  it('module markup token writes modules only; globs must match tracked files', async () => {
    const run = store.startRun({ ...base, role: 'modules' });
    const g = tokens.issue({ projectId: 'p1', role: 'modules', access: 'scoped', sessionId: 's', runId: run.id, scope: [{ type: 'module_map', id: 'p1' }] });
    const c = await connect(g.token);
    const none = await c.callTool({ name: 'upsert_module', arguments: { name: 'svc', globs: ['nope/**'], description: 'd' } });
    expect(text(none)).toMatch(/не совпадают/);
    const res = await c.callTool({ name: 'upsert_module', arguments: { name: 'svc', globs: ['svc/**'], description: 'service' } });
    expect(JSON.parse(text(res))).toMatchObject({ name: 'svc', matched_files: 2 });
    // Same name updates the same module.
    await c.callTool({ name: 'upsert_module', arguments: { name: 'svc', globs: ['svc/*.java'], description: 'service v2' } });
    const mods = JSON.parse(text(await c.callTool({ name: 'list_modules', arguments: {} })));
    expect(mods).toMatchObject([{ name: 'svc', globs: ['svc/*.java'], author: 'ai:modules', runId: run.id }]);
    const ep = await c.callTool({
      name: 'upsert_entry_point',
      arguments: { module_id: mods[0].id, kind: 'http', name: '/x', handler_file: 'svc/Api.java', handler_line: 1, auth: 'none' },
    });
    expect(text(ep)).toMatch(/вне scope/);
    await c.close();
  });

  it('entry point token writes its module only, into its run snapshot, with existing files; finished run cannot write', async () => {
    const mod = store.moduleByName('svc')!;
    const other = store.saveModule({ name: 'other', globs: ['svc/Repo.java'], description: '' }, { author: 'human', runId: null });
    const run = store.startRun({ ...base, role: 'entry-points' });
    const g = tokens.issue({ projectId: 'p1', role: 'entry-points', access: 'scoped', sessionId: 's', runId: run.id, scope: [{ type: 'module', id: mod.id }] });
    const c = await connect(g.token);
    const args = { module_id: mod.id, kind: 'http', method: 'post', name: '/login', handler_file: 'svc/Api.java', handler_line: 3, auth: 'none found' };
    const okRes = await c.callTool({
      name: 'upsert_entry_point',
      arguments: { ...args, params: [{ name: 'user', source: 'body' }], call_chain: [{ file: 'svc/Repo.java', function: 'find', sink: 'SQL' }] },
    });
    expect(JSON.parse(text(okRes))).toMatchObject({ saved: 'http POST /login', entries_in_snapshot: 1 });
    // Platform callbacks (SPI) are their own kind, not HTTP routes.
    const plugin = await c.callTool({ name: 'upsert_entry_point', arguments: { ...args, kind: 'plugin', method: undefined, name: 'AuthPlugin.authenticate' } });
    expect(JSON.parse(text(plugin))).toMatchObject({ saved: 'plugin  AuthPlugin.authenticate', entries_in_snapshot: 2 });
    await c.callTool({ name: 'remove_entry_point', arguments: { module_id: mod.id, kind: 'plugin', name: 'AuthPlugin.authenticate' } });
    const missing = await c.callTool({ name: 'upsert_entry_point', arguments: { ...args, handler_file: 'svc/Nope.java' } });
    expect(text(missing)).toMatch(/не найден/);
    const foreign = await c.callTool({ name: 'upsert_entry_point', arguments: { ...args, module_id: other.id } });
    expect(text(foreign)).toMatch(/вне scope/);
    const markup = await c.callTool({ name: 'upsert_module', arguments: { name: 'x', globs: ['svc/**'], description: 'd' } });
    expect(text(markup)).toMatch(/вне scope/);

    const snap = store.snapshotOf(run.id, mod.id)!;
    expect(store.listEntryPoints(snap.id)[0]).toMatchObject({ callChain: [{ file: 'svc/Repo.java', sink: 'SQL' }], params: [{ name: 'user' }] });
    store.finishRun(run.id, 'succeeded', { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, costUsd: 0 });
    store.finalizeSnapshots(run.id, true);
    const late = await c.callTool({ name: 'upsert_entry_point', arguments: args });
    expect(text(late)).toMatch(/завершён/);
    const read = JSON.parse(text(await c.callTool({ name: 'get_entry_points', arguments: { module_id: mod.id } })));
    expect(read.snapshot.id).toBe(snap.id);
    expect(read.entry_points).toHaveLength(1);
    await c.close();
  });
});

describe('MCP requirement, matrix and finding tools', () => {
  const repo = tmpDir();
  write(path.join(repo, 'svc/Api.java'), 'class Api {}');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  const a = store.audit;
  const base = { kind: 'background' as const, author: 'ai', sessionId: 's', cwd: repo, commitSha: 'c1', configSnapshot: {} };

  it('add_requirement: own version only, verbatim quotes, not after approval', async () => {
    const doc = a.createDocument('Guide');
    const v = a.addVersion(doc, { filename: 'g.md', format: 'md', sha256: 'x' });
    const other = a.addVersion(a.createDocument('Other'), { filename: 'o.md', format: 'md', sha256: 'y' });
    docText = '# Access\nEvery endpoint must check authorization.\n';
    const run = store.startRun({ ...base, role: 'requirements' });
    const g = tokens.issue({ projectId: 'p1', role: 'requirements', access: 'scoped', sessionId: 's', runId: run.id, scope: [{ type: 'doc_version', id: v.id }] });
    const c = await connect(g.token);
    const args = { version_id: v.id, key: 'A-1', text: 'Endpoints check authorization', section: 'Access', quote: 'every endpoint must check  authorization' };
    expect(JSON.parse(text(await c.callTool({ name: 'add_requirement', arguments: args })))).toMatchObject({ saved: 'A-1', items_in_version: 1 });
    expect(text(await c.callTool({ name: 'add_requirement', arguments: { ...args, quote: 'made up' } }))).toMatch(/цитата не найдена/);
    expect(text(await c.callTool({ name: 'add_requirement', arguments: { ...args, version_id: other.id } }))).toMatch(/вне scope/);
    expect(a.listItems(v.id)).toMatchObject([{ key: 'A-1', review: 'pending', author: 'ai:requirements', runId: run.id }]);
    a.setVersionStatus(v.id, 'review');
    a.reviewItems(v.id, a.listItems(v.id).map((i) => i.id), 'accepted');
    a.approveVersion(v.id, 'human');
    expect(text(await c.callTool({ name: 'add_requirement', arguments: { ...args, key: 'A-2' } }))).toMatch(/утверждена/);

    // Re-import: the unchanged item is carried over; re-extracting its key or sentence is rejected.
    docText = '# Access\nEvery endpoint must check authorization.\nTokens must expire.\n';
    const v2 = a.addVersion(doc, { filename: 'g2.md', format: 'md', sha256: 'z' });
    expect(a.carryOverItems(v2, docText).map((i) => [i.key, i.author, i.review])).toEqual([['A-1', 'auto', 'accepted']]);
    const g2 = tokens.issue({ projectId: 'p1', role: 'requirements', access: 'scoped', sessionId: 's', runId: run.id, scope: [{ type: 'doc_version', id: v2.id }] });
    const c2 = await connect(g2.token);
    const args2 = { ...args, version_id: v2.id };
    expect(text(await c2.callTool({ name: 'add_requirement', arguments: args2 }))).toMatch(/A-1 перенесён/);
    expect(text(await c2.callTool({ name: 'add_requirement', arguments: { ...args2, key: 'A-1a', quote: 'every endpoint must check authorization. tokens must expire.' } }))).toMatch(
      /A-1 перенесён/,
    );
    expect(JSON.parse(text(await c2.callTool({ name: 'add_requirement', arguments: { ...args2, key: 'A-2', quote: 'Tokens must expire.' } })))).toMatchObject({ saved: 'A-2' });
    await c2.close();
    docText = null;
    await c.close();
  });

  it('verdicts: cells in scope only, evidence required and must exist, finding needs find_similar + a linked finding', async () => {
    const mod = store.saveModule({ name: 'api', globs: ['svc/**'], description: '' }, { author: 'human', runId: null });
    const doc = a.listDocuments().find((d) => d.title === 'Guide')!;
    const item = a.currentItems([doc.id])[0];
    const cell = { module_id: mod.id, requirement_id: item.requirementId };
    const run = store.startRun({ ...base, role: 'matrix' });
    const g = tokens.issue({ projectId: 'p1', role: 'matrix', access: 'scoped', sessionId: 's', runId: run.id, scope: [{ type: 'cell', id: `${mod.id}/${item.requirementId}` }] });
    const c = await connect(g.token);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: args });
      return { err: Boolean(r.isError), text: text(r) };
    };
    const evidence = [{ file: 'svc/Api.java', line: 1, note: 'check' }];
    expect((await call('set_verdict', { ...cell, status: 'pass', reason: 'ok' })).text).toMatch(/evidence/);
    expect((await call('set_verdict', { ...cell, status: 'pass', reason: 'ok', evidence: [{ file: 'svc/Nope.java' }] })).text).toMatch(/не найден/);
    expect((await call('set_verdict', { ...cell, status: 'finding', reason: 'bad', evidence })).text).toMatch(/find_similar/);
    expect((await call('set_verdict', { module_id: mod.id, requirement_id: 'other', status: 'n/a', reason: 'x' })).text).toMatch(/вне scope/);
    expect((await call('create_finding', { ...cell, check_id: 'nope', title: 't', description: 'd', severity: 'high', files: evidence })).text).toMatch(/find_similar/);

    const sim = JSON.parse((await call('find_similar', { module_id: mod.id, files: ['svc/Api.java'], cwe: 'CWE-639' })).text);
    expect(sim.candidates).toEqual([]);
    const created = JSON.parse(
      (await call('create_finding', { ...cell, check_id: sim.check_id, title: 'IDOR', description: 'd', severity: 'high', cwe: 'CWE-639', files: evidence })).text,
    );
    expect(created.status).toBe('suspected');
    const v = await call('set_verdict', { ...cell, status: 'finding', reason: 'no owner check', evidence });
    expect(v.err).toBe(false);
    const verdict = a.latestVerdicts().get(`${mod.id}/${item.requirementId}`)!;
    expect(verdict).toMatchObject({ status: 'finding', commitSha: 'c1', author: 'ai:matrix', runId: run.id, touchedFiles: ['svc/Api.java'], moduleGlobs: ['svc/**'] });

    // A second agent finds the same flaw: the candidate is returned and linked instead of duplicated.
    const again = JSON.parse((await call('find_similar', { module_id: mod.id, files: ['svc/Api.java'], cwe: 'cwe-639' })).text);
    expect(again.candidates[0]).toMatchObject({ finding_id: created.finding_id, reasons: expect.arrayContaining(['тот же CWE-639']) });
    expect((await call('link_finding', { ...cell, finding_id: created.finding_id })).err).toBe(false);
    expect(a.listFindings()).toHaveLength(1);

    const tri = await call('triage_cell', { ...cell, applicable: false, reason: 'no HTTP' });
    expect(JSON.parse(tri.text).status).toBe('n/a');
    expect(a.latestVerdicts().get(`${mod.id}/${item.requirementId}`)).toMatchObject({ status: 'n/a', reason: 'no HTTP' });
    expect((await call('recheck_cells', { cells: [cell] })).text).toMatch(/прав управления/);
    await c.close();
  });
});

describe('NO_SIGNALS_REASON', () => {
  it('catches a pass argued from silent scanners, not code-based reasons', () => {
    for (const r of ['No signals were found and the code looks fine.', 'Scanners returned no signals.', 'gitleaks reported nothing for the module', 'pass: without scanner hits'])
      expect(NO_SIGNALS_REASON.test(r), r).toBe(true);
    for (const r of ['Every handler calls requireRole before reading the order.', 'Secrets come from Vault; no literal keys in the config files.', 'Input is validated by the Bean Validation filter.'])
      expect(NO_SIGNALS_REASON.test(r), r).toBe(false);
  });
});
