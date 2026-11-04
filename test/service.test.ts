import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { build } from 'esbuild';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UI_METHODS } from '../src/shared/api';
import { Client, NotRunning } from '../src/cli/client';
import { parseArgs, pickProject, runCli, table, type Io } from '../src/cli/cli';
import { COMMANDS } from '../src/cli/commands';
import { listen } from '../src/cli/service';
import { coreApi } from '../src/main/api';
import { ensureGlobalDefaults } from '../src/main/config/loader';
import { Core } from '../src/main/core';
import { acquireLock } from '../src/main/lock';
import { socketPath } from '../src/main/paths';
import { Terminals } from '../src/main/terminals';
import type { Job } from '../src/shared/types';
import { DEFAULTS_DIR, tmpDir, write } from './helpers';

const FAKE = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');
const SLOW = path.resolve(__dirname, 'fixtures', 'slow-claude.mjs');

const GUIDE = `# Access control
AUTH-1: Every endpoint must check the caller's role.
AUTH-2: Object access must verify ownership to prevent IDOR.

# Output
OUT-1: HTML output must be encoded against XSS.
OUT-2: Error responses must not leak stack traces.
`;

function setup(binary: string): { home: string; data: string; repo: string } {
  const home = tmpDir();
  const data = fs.realpathSync(tmpDir());
  const repo = fs.realpathSync(tmpDir());
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  g('init', '-q');
  write(path.join(repo, 'svc', 'Api.java'), 'class Api {}');
  g('add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  ensureGlobalDefaults(DEFAULTS_DIR, home);
  const file = path.join(home, 'config.yaml');
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  doc.setIn(['claude', 'binary'], binary);
  doc.setIn(['queue', 'parallelism'], 1);
  doc.setIn(['signals', 'auto_scan'], false);
  fs.writeFileSync(file, doc.toString());
  return { home, data, repo };
}

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('service and CLI over the socket', () => {
  let core: Core;
  let server: net.Server;
  let repo: string;
  let socket: string;

  /** Runs a command and returns what it printed. */
  async function cli(argv: string[], o: Partial<Io> = {}): Promise<string> {
    const lines: string[] = [];
    await runCli(argv, { socket, out: (t) => lines.push(t), isTty: false, cwd: repo, stdin: process.stdin, ...o });
    return lines.join('\n');
  }
  const json = async <T>(...argv: string[]) => JSON.parse(await cli([...argv, '--json'])) as T;
  const settled = (id: string) =>
    waitFor(async () => {
      const j = (await json<Job[]>('job', 'list')).find((x) => x.id === id)!;
      return !['queued', 'running'].includes(j.status) && j;
    });

  beforeAll(async () => {
    const s = setup(FAKE);
    repo = s.repo;
    socket = path.join(tmpDir(), 's.sock');
    core = new Core({ globalDir: s.home, dataDir: s.data, defaultsDir: DEFAULTS_DIR });
    await core.start();
    server = await listen({ api: coreApi(core), events: core, snapshot: (id) => core.terminals.snapshot(id) }, socket);
    await cli(['project', 'add', '.'], { cwd: repo });
  });

  afterAll(async () => {
    server.close();
    await core.shutdown();
  });

  it('every API method has a command or is listed as UI-only, and names resolve', () => {
    const api = Object.keys(coreApi(core));
    expect(api.sort()).toEqual(Object.keys(COMMANDS).sort());
    for (const m of UI_METHODS) expect(api).not.toContain(m);
    const names = Object.values(COMMANDS).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.split(' ')).toHaveLength(2);
  });

  it('the socket is private', () => {
    expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
  });

  it('project: relative path, table, json, by directory and by flag', async () => {
    expect(await cli(['project', 'list'])).toMatch(new RegExp(`^ID +NAME +ROOT\\n.*${path.basename(repo)} +${repo}$`));
    const [p] = await json<{ id: string; root: string }[]>('project', 'list');
    expect(p.root).toBe(repo);
    expect(await json('job', 'list')).toEqual([]);
    expect(await cli(['job', 'list', '--project', p.id, '--json'], { cwd: '/' })).toBe('[]');
    await expect(cli(['job', 'list'], { cwd: '/' })).rejects.toThrow(/use --project/);
    await expect(cli(['job', 'list', '--project', 'nope'])).rejects.toThrow(/no project matches/);
  });

  it('errors: usage, unknown flag and command, UI-only, bad JSON, unknown and inherited methods', async () => {
    await expect(cli(['job', 'cancel'])).rejects.toThrow(/usage: <job>/);
    await expect(cli(['job', 'list', 'extra'])).rejects.toThrow(/usage/);
    await expect(cli(['job', 'list', '--nope'])).rejects.toThrow(/unknown flag/);
    await expect(cli(['nope'])).rejects.toThrow(/unknown command/);
    await expect(cli(['call', 'newSession', '["x"]'])).rejects.toThrow(/needs the desktop app/);
    await expect(cli(['call', 'nope'])).rejects.toThrow(/unknown method/);
    await expect(cli(['call', 'constructor'])).rejects.toThrow(/unknown method/);
    await expect(cli(['call', 'listJobs', '{}'])).rejects.toThrow(/JSON array/);
    await expect(cli(['log-level', 'loud'])).rejects.toThrow(/unknown level/);
  });

  it('call and status reach the service; log-level is accepted', async () => {
    expect(JSON.parse(await cli(['call', 'queueState']))).toMatchObject({ parallelism: 1 });
    expect(JSON.parse(await cli(['status']))).toMatchObject({ running: true, socket });
    await cli(['log-level', 'queue', 'info']);
  });

  it('a malformed request gets an error and the connection keeps working', async () => {
    const conn = net.connect(socket);
    const replies: string[] = [];
    conn.setEncoding('utf8').on('data', (d: string) => replies.push(...d.trim().split('\n')));
    await once(conn, 'connect');
    conn.write('null\nnot json\n{"id":"1","method":"queueState"}\n{"id":7,"method":"queueState"}\n');
    await waitFor(() => replies.length === 4);
    conn.destroy();
    expect(replies.slice(0, 3).every((r) => r.includes('not a JSON object'))).toBe(true);
    expect(JSON.parse(replies[3])).toMatchObject({ id: 7, result: { parallelism: 1 } });
  });

  it('config: read, write from stdin, global scope', async () => {
    const files = await json<{ path: string; scope: string; rel: string }[]>('config', 'files', '--global');
    const cfg = files.find((f) => f.scope === 'global' && f.rel === 'config.yaml')!;
    const text = await cli(['config', 'read', cfg.path, '--global']);
    expect(text).toContain('logging:');
    const stdin = (async function* () {
      yield text + '\n# changed\n';
    })() as unknown as NodeJS.ReadableStream;
    await cli(['config', 'write', cfg.path, '--global'], { stdin });
    expect(fs.readFileSync(cfg.path, 'utf8')).toContain('# changed');
  });

  it('job: add, watch its output to the end', async () => {
    const job = await json<Job>('job', 'add', 'say hi', '--title', 'hello');
    const out: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((d: string) => (out.push(String(d)), true)) as typeof process.stdout.write;
    try {
      await cli(['watch', job.id]);
    } finally {
      process.stdout.write = write;
    }
    expect((await settled(job.id)).status).toBe('done');
    expect(out.join('')).toContain('init');
    await expect(cli(['watch', 'nope'])).rejects.toThrow(/not found/);
  });

  it('the whole flow: document, review, matrix, confirmation, slices', async () => {
    const file = path.join(tmpDir(), 'guide.md');
    write(file, GUIDE);
    const view = await json<{ document: { id: string }; version: { id: string }; job: { id: string } }>('doc', 'import', path.relative(repo, file), '--title', 'Guide');
    await settled(view.job.id);
    const v = await json<{ items: { id: string }[] }>('doc', 'show', view.version.id);
    await cli(['doc', 'review', view.version.id, 'accepted', ...v.items.map((i) => i.id)]);
    await cli(['doc', 'approve', view.version.id]);
    await cli(['module', 'save', 'svc', '--glob', 'svc/**', '--description', 'api']);
    await cli(['matrix', 'save', 'mini', '--document', view.document.id, '--module', 'svc']);

    expect(await json<string[]>('matrix', 'slice', 'mini')).toHaveLength(4);
    expect(await json<string[]>('matrix', 'slice', 'mini', '--section', 'Output')).toHaveLength(2);
    expect(await json<string[]>('matrix', 'slice', 'mini', '--requirement', 'AUTH-1', '--module', 'svc')).toHaveLength(1);

    await expect(cli(['matrix', 'run', 'mini', '--stage', 'triage'])).rejects.toThrow(/confirmation needed/);
    await expect(cli(['matrix', 'run', 'mini', '--stage', 'triage', '--section', 'Output', '--yes'])).rejects.toThrow(/whole matrix/);
    await expect(cli(['matrix', 'run', 'mini', '--module', 'nope', '--yes'])).rejects.toThrow(/no cells/);
    expect(await json('job', 'list')).toHaveLength(2);

    const before = (await json<Job[]>('job', 'list')).length;
    const started = await json<Job[]>('matrix', 'run', 'mini', '--section', 'Output', '--yes');
    expect(started.length).toBeGreaterThan(0);
    console.log(JSON.stringify((await json<Job[]>('job','list')).map(j=>[j.role,j.title,j.status]),null,0), before, started.length);
    expect((await json<Job[]>('job', 'list')).length).toBe(before + started.length);
    for (const j of started) await settled(j.id);
  });
});

describe('stopping', () => {
  async function start() {
    const s = setup(SLOW);
    const paths = { globalDir: s.home, dataDir: s.data, defaultsDir: DEFAULTS_DIR };
    const core = new Core(paths);
    await core.start();
    const pid = (await core.addProject(s.repo)).id;
    const first = await core.enqueueTask(pid, { prompt: 'x', role: 'task' });
    await waitFor(() => core.store(pid).getJob(first.id)!.lastRunId);
    const next = await core.enqueueTask(pid, { prompt: 'y', role: 'task' });
    return { core, paths, pid, first, next };
  }

  it('the service puts running jobs back in the queue and starts nothing new; the next start continues', async () => {
    const { core, paths, pid, first, next } = await start();
    await core.shutdown({ requeue: true });

    const again = new Core(paths);
    const s = again.store(pid);
    expect(s.getJob(next.id)).toMatchObject({ status: 'queued', lastRunId: null });
    expect(s.getJob(first.id)).toMatchObject({ status: 'queued', error: null });
    expect(s.getRun(s.getJob(first.id)!.lastRunId!)!.status).toBe('cancelled');
    await again.start();
    await waitFor(() => s.listRuns().filter((r) => r.jobId === first.id).length === 2);
    await again.shutdown();
  });

  it('closing the desktop app still cancels running jobs', async () => {
    const { core, paths, pid, first } = await start();
    await core.shutdown();
    expect(new Core(paths).store(pid).getJob(first.id)!.status).toBe('cancelled');
  });
});

describe('without a service', () => {
  it('a client reports that the service is not running', async () => {
    await expect(Client.connect(path.join(tmpDir(), 'none.sock'))).rejects.toBeInstanceOf(NotRunning);
  });

  it('interactive sessions need the desktop app', async () => {
    const s = setup(FAKE);
    const core = new Core({ globalDir: s.home, dataDir: s.data, defaultsDir: DEFAULTS_DIR });
    await core.start();
    const pid = (await core.addProject(s.repo)).id;
    await expect((async () => core.newSession(pid))()).rejects.toThrow(/desktop app/);
    await core.shutdown();
  });
});

describe('terminals', () => {
  it('keeps only the newest ended streams, never a live one', () => {
    const t = new Terminals(undefined, () => 1);
    const ids = ['a', 'b', 'c'].map((r) => t.openStream('p', r, r));
    t.markEnded(ids[0]);
    t.markEnded(ids[1]);
    expect(t.list().map((x) => x.runId)).toEqual(['b', 'c']);
    t.markEnded(ids[2]);
    expect(t.list().map((x) => x.runId)).toEqual(['c']);
  });
});

describe('socket path', () => {
  it('a path the OS would cut is an error', () => {
    expect(socketPath({ dataDir: '/data' })).toBe('/data/aiegis.sock');
    expect(() => socketPath({ dataDir: `/${'d'.repeat(100)}` })).toThrow(/too long/);
  });
});

describe('lock', () => {
  it('a live owner blocks, the release and a stale file free the directory', () => {
    const dir = tmpDir();
    const release = acquireLock(dir);
    expect(() => acquireLock(dir)).toThrow(/already runs/);
    release();
    write(path.join(dir, 'aiegis.lock'), '999999');
    acquireLock(dir)();
    write(path.join(dir, 'aiegis.lock'), 'garbage');
    acquireLock(dir)();
    // A live pid written before this boot belongs to another process.
    write(path.join(dir, 'aiegis.lock'), String(process.pid));
    expect(() => acquireLock(dir)).toThrow(/already runs/);
    fs.utimesSync(path.join(dir, 'aiegis.lock'), new Date(0), new Date(0));
    acquireLock(dir)();
    expect(fs.existsSync(path.join(dir, 'aiegis.lock'))).toBe(false);
  });
});

describe('parsing', () => {
  it('flags, repeats, positionals, optional and variadic arguments', () => {
    const a = parseArgs('<name> --glob <glob>... [--description <text>] [--refresh]', ['m', '--glob', 'a', '--glob=b', '--refresh', '--json']);
    expect(a.pos).toEqual(['m']);
    expect(a.all('glob')).toEqual(['a', 'b']);
    expect(a.one('description')).toBeUndefined();
    expect(a.has('refresh') && a.has('json')).toBe(true);
    expect(parseArgs('<cell...> [--matrix <m>]', ['a', 'b', 'c']).pos).toHaveLength(3);
    expect(() => parseArgs('[--hint <text>]', ['--hint'])).toThrow(/needs a value/);
    expect(parseArgs('[job]', []).pos).toEqual([]);
  });

  it('project: an inner repository wins, a name shared by two is an error', () => {
    const a = fs.realpathSync(tmpDir());
    const inner = path.join(a, 'inner');
    fs.mkdirSync(inner);
    const projects = [
      { id: '1', name: 'x', root: a },
      { id: '2', name: 'x', root: inner },
    ];
    expect(pickProject(projects, undefined, inner).id).toBe('2');
    expect(pickProject(projects, '1', '/').id).toBe('1');
    expect(() => pickProject(projects, 'x', '/')).toThrow(/several projects/);
    expect(() => pickProject([{ id: '3', name: 'y', root: a + '-other' }], undefined, a)).toThrow(/use --project/);
  });

  it('table: aligned columns, nested fields, empty values', () => {
    expect(table([{ id: 'a', current: { status: 'x y' } }, { id: 'bbb', current: null }], ['id', 'current.status'])).toBe('ID   STATUS\na    x y\nbbb  ');
  });
});

describe('the bundle of the service', () => {
  it('holds no Electron, UI packages or native modules', async () => {
    const r = await build({ entryPoints: ['src/cli/main.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, metafile: true, logLevel: 'silent' });
    const inputs = Object.keys(r.metafile.inputs);
    expect(inputs.length).toBeGreaterThan(100);
    expect(inputs.filter((f) => /node_modules\/(electron|react|react-dom|node-pty|@xterm)\/|src\/renderer|src\/preload/.test(f))).toEqual([]);
    expect(Object.values(r.metafile.outputs).flatMap((o) => o.imports).filter((i) => i.external && !i.path.startsWith('node:') && !/^[a-z_]+$/.test(i.path))).toEqual([]);
  });
});
