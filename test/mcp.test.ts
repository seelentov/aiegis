import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db';
import { AiegisMcpServer, mcpConfigJson } from '../src/main/mcp/server';
import { TokenRegistry } from '../src/main/mcp/tokens';
import { ProjectStore } from '../src/main/store';
import { tmpDir, write } from './helpers';

const tokens = new TokenRegistry();
const store = new ProjectStore('p1', openDb(':memory:'));
const enqueued: string[] = [];
const server = new AiegisMcpServer(tokens, {
  store: () => store,
  projectName: () => 'demo',
  enqueueTask: (_pid, t) => {
    enqueued.push(t.prompt);
    return store.addJob({ type: 'agent', role: t.role, title: t.title, entityType: 'task', entityId: 'x', payload: {} });
  },
  stopJob: () => undefined,
  queueState: () => ({ pausedUntil: null, parallelism: 2, running: 0 }),
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
