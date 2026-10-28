import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db';
import { AiegisMcpServer, mcpConfigJson } from '../src/main/mcp/server';
import { TokenRegistry } from '../src/main/mcp/tokens';
import { ProjectStore } from '../src/main/store';

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
