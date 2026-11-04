import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import { UI_METHODS, type CoreApi } from '../shared/api';
import { LOG_LEVELS, type AppEvent, type LogLevel } from '../shared/types';
import { coreApi } from '../main/api';
import { LineSplitter } from '../main/claude/stream';
import { Core } from '../main/core';
import { acquireLock } from '../main/lock';
import { getLogger, setLogLevel, shutdownLogging } from '../main/log';
import { resolveAppPaths, socketPath } from '../main/paths';
import { adoptLoginShellPath } from '../main/shell-env';

const log = getLogger('core');

export interface Request {
  id: number;
  method: string;
  args?: unknown[];
}

export type Response = { id: number; result?: unknown; error?: string } | { event: AppEvent };

export interface Host {
  api: CoreApi;
  /** Emits "event" (AppEvent). */
  events: EventEmitter;
  /** Scrollback of a terminal. */
  snapshot(terminalId: string): string;
}

function dispatch(host: Host, conn: net.Socket, write: (r: Response) => void, method: string, args: unknown[]): unknown {
  if (method === 'subscribe') {
    const terminalId = args[0] as string | undefined;
    const listener = (event: AppEvent) => {
      if (event.type !== 'terminal-data' || event.terminalId === terminalId) write({ event });
    };
    host.events.on('event', listener);
    conn.on('close', () => host.events.off('event', listener));
    // Same tick as the subscription: no chunk is lost or repeated between the two.
    return { snapshot: terminalId ? host.snapshot(terminalId) : '' };
  }
  if (method === 'logLevel') {
    const [level, category] = args as [LogLevel, string | undefined];
    if (!LOG_LEVELS.includes(level)) throw new Error(`unknown level ${level}, available: ${LOG_LEVELS.join(', ')}`);
    return setLogLevel(level, category);
  }
  if ((UI_METHODS as readonly string[]).includes(method)) throw new Error(`${method} needs the desktop app`);
  if (!Object.hasOwn(host.api, method)) throw new Error(`unknown method ${method}`);
  log.debug('api %s', method);
  return (host.api[method as keyof CoreApi] as (...a: unknown[]) => unknown)(...args);
}

/** Control socket of the service: JSON lines, one request per line. Access is limited by the file mode (SPEC §23). */
export function listen(host: Host, file: string): Promise<net.Server> {
  const server = net.createServer((conn) => {
    conn.setEncoding('utf8');
    conn.on('error', () => undefined);
    const lines = new LineSplitter();
    const write = (r: Response) => {
      if (!conn.destroyed) conn.write(JSON.stringify(r) + '\n');
    };
    const handle = async (line: string) => {
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
        if (typeof req?.id !== 'number' || typeof req.method !== 'string' || !(req.args === undefined || Array.isArray(req.args))) throw new Error();
      } catch {
        return write({ id: 0, error: 'the request is not a JSON object with id, method and args' });
      }
      try {
        write({ id: req.id, result: await dispatch(host, conn, write, req.method, req.args ?? []) });
      } catch (e) {
        write({ id: req.id, error: (e as Error).message });
      }
    };
    conn.on('data', (d: string) => lines.push(d).forEach((l) => void handle(l)));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // The caller holds the lock, so a socket left here is stale.
    fs.rmSync(file, { force: true });
    // listen() binds synchronously: nothing else can run under this umask.
    const umask = process.umask(0o177);
    server.listen(file, () => resolve(server));
    process.umask(umask);
  });
}

/** `aiegis` without arguments: runs until SIGTERM or SIGINT. */
export async function runService(defaultsDir: string): Promise<void> {
  // A long-lived process: one forgotten promise must not stop the jobs of every project.
  process.on('unhandledRejection', (e) => log.error('unhandled rejection: %s', e));
  // Before anything spawns `claude` or scanners: a service manager starts us with a minimal PATH.
  await adoptLoginShellPath();
  const paths = resolveAppPaths(defaultsDir);
  const file = socketPath(paths);
  const release = acquireLock(paths.dataDir);
  const core = new Core(paths, { logging: true });
  let server: net.Server | undefined;
  const started = (async () => {
    await core.start();
    server = await listen({ api: coreApi(core), events: core, snapshot: (id) => core.terminals.snapshot(id) }, file);
    log.info('service ready: %s', file);
  })();
  let stopping = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log.info('%s received', signal);
    // The queue may already have started agents: a signal during the start stops them the same way.
    await started.catch(() => undefined);
    server?.close();
    await core.shutdown({ requeue: true }).catch((e: unknown) => log.error('shutdown: %s', e));
    fs.rmSync(file, { force: true });
    release();
    await shutdownLogging();
    process.exit(0);
  };
  process.on('SIGTERM', (s) => void stop(s));
  process.on('SIGINT', (s) => void stop(s));
  try {
    await started;
  } catch (e) {
    release();
    throw e;
  }
}
