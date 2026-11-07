import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { CoreMethod } from '../shared/api';
import type { AppEvent, Job, ProjectInfo, Page } from '../shared/types';
import { Client } from './client';
import { COMMANDS, type Command, type Ctx, type Input } from './commands';

/** Flags of every command. */
const GLOBAL_FLAGS = { project: true, json: false, yes: false } as const;

const BUILTINS = [
  ['status', 'Show that the service runs, its queue and projects'],
  ['watch [job]', 'Follow the output of a job until it ends; without a job, the feed of events. Ctrl+C stops watching only'],
  ['log-level [category] <level>', 'Change a log level until the service restarts'],
  ['call <method> [json args]', 'Call any API method with a JSON array of arguments'],
  ['help', 'Show this text'],
] as const;

export interface Io {
  socket: string;
  out(text: string): void;
  isTty: boolean;
  cwd: string;
  stdin: NodeJS.ReadableStream;
}

/** Parses a command line by the command's usage string. */
export function parseArgs(usage: string, argv: string[], stdin: NodeJS.ReadableStream = process.stdin): Input {
  const known = new Map<string, boolean>(Object.entries(GLOBAL_FLAGS));
  for (const m of usage.matchAll(/--([a-z-]+)( <)?/g)) known.set(m[1], Boolean(m[2]));
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(argv[i]);
    if (!m) {
      pos.push(argv[i]);
      continue;
    }
    const takesValue = known.get(m[1]);
    if (takesValue === undefined) throw new Error(`unknown flag --${m[1]}`);
    const value = takesValue ? (m[2] ?? argv[++i]) : '';
    if (value === undefined) throw new Error(`--${m[1]} needs a value`);
    flags.set(m[1], [...(flags.get(m[1]) ?? []), value]);
  }
  const positional = usage.replace(/\[?--[a-z-]+( <[^>]*>(\.\.\.)?)?\]?/g, '');
  const needed = [...positional.matchAll(/<[^>]*>/g)].length;
  const most = /\.\.\./.test(positional) ? Infinity : needed + [...positional.matchAll(/\[[^\]]*\]/g)].length;
  if (pos.length < needed || pos.length > most) throw new Error(`usage: ${usage.trim() || '(no arguments)'}`);
  return {
    pos,
    one: (f) => flags.get(f)?.at(-1),
    all: (f) => flags.get(f) ?? [],
    has: (f) => flags.has(f),
    stdin: async () => {
      let text = '';
      for await (const chunk of stdin) text += String(chunk);
      return text;
    },
  };
}

/** Project of a command: `--project`, else the registered project around the working directory. */
export function pickProject(projects: ProjectInfo[], ref: string | undefined, cwd: string): ProjectInfo {
  const list = projects.map((p) => `${p.name} (${p.id})`).join(', ') || 'none';
  if (ref !== undefined) {
    const found = projects.filter((p) => p.id === ref || p.name === ref);
    if (found.length === 1) return found[0];
    throw new Error(`${found.length ? 'several projects match' : 'no project matches'} "${ref}"; projects: ${list}`);
  }
  const dir = fs.realpathSync(cwd);
  const around = projects.filter((p) => dir === p.root || dir.startsWith(p.root + path.sep)).sort((a, b) => b.root.length - a.root.length);
  if (!around[0]) throw new Error(`cannot tell the project, use --project; projects: ${list}`);
  return around[0];
}

const field = (row: unknown, dotted: string): string => {
  const v = dotted.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null | undefined)?.[k], row);
  return v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ');
};

export function table(rows: unknown[], columns: string[]): string {
  const cells = [columns.map((c) => c.split('.').at(-1)!.toUpperCase()), ...rows.map((r) => columns.map((c) => field(r, c)))];
  const width = columns.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  return cells.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(width[i]))).join('  ')).join('\n');
}

const isPage = (r: unknown): r is Page<unknown> => typeof r === 'object' && r !== null && 'rows' in r && 'total' in r;

function print(io: Io, a: Input, result: unknown, columns?: string[]): void {
  if (result === undefined) return;
  if (columns && !a.has('json') && Array.isArray(result)) return io.out(table(result, columns));
  if (columns && !a.has('json') && isPage(result)) {
    const shown = result.rows.length ? `${result.offset + 1}-${result.offset + result.rows.length}` : '0';
    return io.out(`${table(result.rows, columns)}\n${shown} of ${result.total}`);
  }
  // Plain text (a path, a config file) reads better bare.
  if (typeof result === 'string' && !a.has('json')) return io.out(result);
  io.out(JSON.stringify(result, null, 2));
}

async function confirm(io: Io, a: Input, estimate: unknown): Promise<void> {
  if (a.has('yes')) return;
  io.out(JSON.stringify(estimate, null, 2));
  if (!io.isTty) throw new Error('confirmation needed: run in a terminal or pass --yes');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Start? [y/N] ');
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error('cancelled');
}

function help(): string {
  const groups = Object.values(COMMANDS).map((c) => `  ${`${c.name} ${c.usage}`.trim()}\n      ${c.help}`);
  return [
    'aiegis                      run the service until SIGTERM or SIGINT',
    'aiegis <command> [options]  talk to the running service',
    '',
    'Options of every command: --project <name or id>, --json, --yes',
    '',
    'Commands:',
    ...BUILTINS.map(([name, text]) => `  ${name}\n      ${text}`),
    ...groups,
  ].join('\n');
}

const JOB_ENDED: Job['status'][] = ['done', 'failed', 'cancelled', 'taken_over'];

function describe(ev: AppEvent): string | null {
  if (ev.type === 'terminal-data') return null;
  if (ev.type === 'notice') return `${ev.level}: ${ev.text}`;
  if (ev.type === 'queue-changed') return `queue: ${ev.state.running} running${ev.state.pausedUntil ? `, paused until ${new Date(ev.state.pausedUntil).toISOString()}` : ''}`;
  return 'projectId' in ev ? `${ev.type}: ${ev.projectId}` : ev.type;
}

/** Runs until the service goes away or the process is interrupted. */
function watchEvents(client: Client, io: Io, a: Input): Promise<void> {
  return new Promise((resolve, reject) => {
    client.onClose = resolve;
    client
      .subscribe((ev) => {
        const line = a.has('json') ? JSON.stringify(ev) : describe(ev);
        if (line) io.out(line);
      })
      .catch(reject);
  });
}

/** Prints the output of a job's run as it appears; returns when the job ends. */
async function watchJob(client: Client, io: Io, pid: string, jobId: string): Promise<void> {
  const job = async () => {
    return (await client.request('getJob', [pid, jobId])) as Job;
  };
  const write = (data: string) => process.stdout.write(data);
  await new Promise<void>((resolve, reject) => {
    let terminal: string | undefined;
    let busy = false;
    let again = false;
    client.onClose = resolve;
    const check = async () => {
      if (busy) {
        // The job may end during a check: the event must not be lost.
        again = true;
        return;
      }
      busy = true;
      try {
        const j = await job();
        if (!terminal && j.lastRunId) {
          const list = (await client.request('listTerminals')) as { id: string; runId: string }[];
          terminal = list.find((t) => t.runId === j.lastRunId)?.id;
          if (terminal) write(await client.subscribe(onEvent, terminal));
        }
        if (JOB_ENDED.includes(j.status)) {
          io.out(`job ${j.status}${j.error ? `: ${j.error}` : ''}`);
          resolve();
        }
      } catch (e) {
        reject(e as Error);
      } finally {
        busy = false;
        if (again) {
          again = false;
          void check();
        }
      }
    };
    const onEvent = (ev: AppEvent) => {
      if (ev.type === 'terminal-data') write(ev.data);
      else if (ev.type === 'jobs-changed' || ev.type === 'terminals-changed') void check();
    };
    client.subscribe(onEvent).then(check, reject);
  });
}

function makeCtx(client: Client, io: Io, a: Input, project: ProjectInfo | Error): Ctx {
  return {
    call: ((method: CoreMethod, ...args: unknown[]) => client.request(method, args)) as Ctx['call'],
    pid: () => {
      if (project instanceof Error) throw project;
      return project.id;
    },
    scope: () => (a.has('global') || project instanceof Error ? null : project.id),
    abs: (file) => path.resolve(io.cwd, file),
    confirm: (estimate) => confirm(io, a, estimate),
  };
}

function findCommand(argv: string[]): { command: Command; rest: string[] } | null {
  const all = Object.values(COMMANDS);
  const two = all.find((c) => c.name === argv.slice(0, 2).join(' '));
  return two ? { command: two, rest: argv.slice(2) } : null;
}

const projectOf = (projects: ProjectInfo[], a: Input, cwd: string): ProjectInfo | Error => {
  try {
    return pickProject(projects, a.one('project'), cwd);
  } catch (e) {
    return e as Error;
  }
};

/** One client command. Throws `NotRunning` when there is no service. */
export async function runCli(argv: string[], io: Io): Promise<void> {
  const [head, ...tail] = argv;
  if (head === 'help' || head === '--help' || head === '-h') return io.out(help());

  const found = findCommand(argv);
  const builtin = ['status', 'watch', 'log-level', 'call'].includes(head);
  if (!found && !builtin) throw new Error(`unknown command "${argv.join(' ')}", see aiegis help`);

  const usage = found?.command.usage ?? { status: '', watch: '[job]', 'log-level': '<level> [level]', call: '<method> [args]' }[head]!;
  const a = parseArgs(usage, found?.rest ?? tail, io.stdin);

  const client = await Client.connect(io.socket);
  try {
    const projects = (await client.request('listProjects')) as ProjectInfo[];
    const project = projectOf(projects, a, io.cwd);
    if (found) {
      print(io, a, await found.command.run(a, makeCtx(client, io, a, project)), found.command.columns);
    } else if (head === 'status') {
      print(io, a, { running: true, socket: io.socket, queue: await client.request('queueState'), projects: projects.map((p) => p.name) });
    } else if (head === 'log-level') {
      const [level, category] = a.pos.length === 2 ? [a.pos[1], a.pos[0]] : [a.pos[0], undefined];
      await client.request('logLevel', [level, category]);
    } else if (head === 'call') {
      const args = a.pos[1] === undefined ? [] : (JSON.parse(a.pos[1]) as unknown);
      if (!Array.isArray(args)) throw new Error('arguments must be a JSON array');
      print(io, a, await client.request(a.pos[0], args));
    } else if (a.pos[0]) {
      if (project instanceof Error) throw project;
      await watchJob(client, io, project.id, a.pos[0]);
    } else {
      await watchEvents(client, io, a);
    }
  } finally {
    client.close();
  }
}
