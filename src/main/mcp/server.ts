import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Job, QueueState } from '../../shared/types';
import type { ProjectStore } from '../store';
import { authorize, type Action, type Grant, type TokenRegistry } from './tokens';

export interface McpServices {
  store(projectId: string): ProjectStore;
  projectName(projectId: string): string;
  enqueueTask(projectId: string, t: { prompt: string; role: string; title: string }): Job;
  stopJob(projectId: string, jobId: string): void;
  queueState(): QueueState;
  /** Called after an agent wrote something, so the UI can refresh. */
  onWrite(projectId: string): void;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Builds an MCP server instance whose tools are bound to one grant. */
export function buildServer(grant: Grant, svc: McpServices): McpServer {
  const server = new McpServer({ name: 'aiegis', version: '0.1.0' });
  const pid = grant.projectId;
  const guard = (action: Action, fn: () => ToolResult): ToolResult => {
    const d = authorize(grant, pid, action);
    if (!d.ok) return fail(`Отказано: ${d.reason}`);
    try {
      return fn();
    } catch (e) {
      return fail((e as Error).message);
    }
  };
  server.registerTool(
    'whoami',
    { description: 'Who this session is: project, role, access level, session/run ids and the entities it may write.' },
    async () =>
      ok({
        project: { id: pid, name: svc.projectName(pid) },
        role: grant.role,
        access: grant.access,
        session_id: grant.sessionId,
        run_id: grant.runId,
        writable_entities: grant.scope,
      }),
  );

  server.registerTool(
    'list_jobs',
    { description: 'List background jobs of the project with their status, plus the queue state.' },
    async () =>
      guard({ kind: 'read' }, () => ok({ queue: svc.queueState(), jobs: svc.store(pid).listJobs(100) })),
  );

  server.registerTool(
    'list_runs',
    {
      description: 'List recent runs (history) of the project.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ limit }) =>
      guard({ kind: 'read' }, () =>
        ok(svc.store(pid).listRuns(limit ?? 50).map(({ configSnapshot: _c, ...r }) => r)),
      ),
  );

  server.registerTool(
    'get_results',
    {
      description: 'Read results written by agents, optionally filtered by entity.',
      inputSchema: { entity_type: z.string().optional(), entity_id: z.string().optional() },
    },
    async ({ entity_type, entity_id }) =>
      guard({ kind: 'read' }, () => ok(svc.store(pid).listResults({ entityType: entity_type, entityId: entity_id }))),
  );

  server.registerTool(
    'submit_result',
    {
      description: 'Write the result for an entity in your scope (see whoami.writable_entities).',
      inputSchema: {
        entity_type: z.string(),
        entity_id: z.string(),
        summary: z.string().min(1),
        details: z.string().optional(),
      },
    },
    async ({ entity_type, entity_id, summary, details }) =>
      guard({ kind: 'write', entity: { type: entity_type, id: entity_id } }, () => {
        const r = svc.store(pid).addResult({
          runId: grant.runId,
          entityType: entity_type,
          entityId: entity_id,
          data: { summary, ...(details ? { details } : {}) },
          author: `ai:${grant.role}`,
        });
        svc.onWrite(pid);
        return ok({ saved: r.id });
      }),
  );

  server.registerTool(
    'enqueue_task',
    {
      description: 'Queue a background agent task in this project (requires management access).',
      inputSchema: {
        prompt: z.string().min(1),
        role: z.string().optional().describe('Background role, default "task"'),
        title: z.string().optional(),
      },
    },
    async ({ prompt, role, title }) =>
      guard({ kind: 'manage' }, () => {
        const job = svc.enqueueTask(pid, { prompt, role: role ?? 'task', title: title ?? prompt.slice(0, 80) });
        return ok({ job_id: job.id, status: job.status });
      }),
  );

  server.registerTool(
    'cancel_job',
    { description: 'Cancel a queued or running job (requires management access).', inputSchema: { job_id: z.string() } },
    async ({ job_id }) =>
      guard({ kind: 'manage' }, () => {
        svc.stopJob(pid, job_id);
        return ok({ cancelled: job_id });
      }),
  );

  return server;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** HTTP MCP server on 127.0.0.1:<random>; each request is authenticated by its run token. */
export class AiegisMcpServer {
  private server: http.Server | null = null;
  port = 0;

  constructor(
    private readonly tokens: TokenRegistry,
    private readonly svc: McpServices,
  ) {}

  url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const grant = this.tokens.fromHeader(req.headers.authorization);
    if (!grant) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid token' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const body = await readBody(req);
    const server = buildServer(grant, this.svc);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

/** Content of the --mcp-config file handed to claude. */
export function mcpConfigJson(url: string, token: string): string {
  return JSON.stringify({
    mcpServers: { aiegis: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } },
  });
}
