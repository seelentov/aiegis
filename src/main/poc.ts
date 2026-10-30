import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Settings } from './config/loader';

/** Entity of a PoC tester job and scope of its token (id = finding id). */
export const POC_ENTITY = 'poc';
/** Directory of a run's own files (scripts) inside its checkout. */
export const POC_DIR = '.aiegis-poc';
/** Entity of an env-setup job: one test environment per project. */
export const POC_ENV_ENTITY = 'poc_env';
export const POC_ENV_ID = 'environment';
/** Scripts of the test environment written by env-setup, relative to the project root (next to its config). */
export const POC_SCRIPTS_DIR = path.join('.aiegis', 'poc');

export type SecretRef = { env: string } | { keychain: { service: string; account: string } };

export interface PocAccount {
  username?: string;
  role?: string;
  tenant?: string;
  notes?: string;
  /** Secret values by name (password, token, ...), handed to the tester as env variables. */
  secrets?: Record<string, SecretRef>;
}

/** Test environment of the project (SPEC §4, Q14). */
export interface PocEnvironment {
  start: string;
  healthcheck: string;
  stop: string | null;
  base_url: string;
  accounts: Record<string, PocAccount>;
}

/** The configured test environment, or why the tester is unavailable. */
export function pocEnvironment(poc: Settings['poc']): { env: PocEnvironment } | { reason: string } {
  const e = poc.environment;
  if (!e) return { reason: 'the project config does not describe a test environment (poc.environment)' };
  const missing = (['start', 'healthcheck', 'base_url'] as const).filter((k) => !e[k]?.trim());
  if (missing.length) return { reason: `poc.environment is missing: ${missing.join(', ')}` };
  let url: URL;
  try {
    url = new URL(e.base_url!);
  } catch {
    return { reason: `poc.environment.base_url: invalid URL ${e.base_url}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { reason: 'poc.environment.base_url: http or https is required' };
  return { env: { start: e.start!, healthcheck: e.healthcheck!, stop: e.stop?.trim() || null, base_url: e.base_url!, accounts: e.accounts ?? {} } };
}

/** Project config text with the `poc.environment` commands replaced; accounts and comments are kept. */
export function withEnvironment(text: string, e: { start: string; healthcheck: string; stop: string | null; base_url: string }): string {
  const doc = YAML.parseDocument(text);
  const at = (k: string) => ['poc', 'environment', k];
  for (const k of ['start', 'healthcheck', 'base_url'] as const) doc.setIn(at(k), e[k]);
  if (e.stop) doc.setIn(at('stop'), e.stop);
  else doc.deleteIn(at('stop'));
  return doc.toString();
}

const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Throws unless every name is a plain file name (scripts land in one directory, nowhere else). */
export function checkScriptNames(names: string[]): void {
  const bad = names.find((n) => !SCRIPT_NAME.test(n));
  if (bad !== undefined) throw new Error(`invalid script name ${JSON.stringify(bad)}: a plain file name is required`);
}

export function writeScripts(dir: string, files: { name: string; content: string }[]): void {
  checkScriptNames(files.map((f) => f.name));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const file = path.join(dir, f.name);
    fs.writeFileSync(file, f.content);
    fs.chmodSync(file, 0o755);
  }
}

/**
 * A long array argument that a model wrote into a text argument as tool-call markup (`…</parameter>
 * <parameter name="steps">[…]`): the text before the markup and the parsed value, or null when there is none.
 */
export function splitInlinedArg(text: string, name: string): { text: string; value: unknown } | null {
  const m = new RegExp(`\\s*(?:</[a-z_]+>)?\\s*<parameter name="${name}">\\s*([\\s\\S]*?)\\s*(?:</parameter>)?\\s*$`).exec(text);
  if (!m) return null;
  try {
    return { text: text.slice(0, m.index).trim(), value: JSON.parse(m[1]) };
  } catch {
    return null;
  }
}

/** The named variables of the app's environment (the tester gets no other: SPEC §18). */
export function pickEnv(names: string[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(names.filter((n) => env[n] !== undefined).map((n) => [n, env[n]!]));
}

const envPart = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** Env variable that carries a secret of a test account. */
export const secretEnvName = (account: string, secret: string) => `AIEGIS_POC_${envPart(account)}_${envPart(secret)}`;

function keychain(service: string, account: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('security', ['find-generic-password', '-s', service, '-a', account, '-w'], (err, out) =>
      err ? reject(new Error(`secret not found in keychain (service ${service}, account ${account})`)) : resolve(out.replace(/\n$/, '')),
    ),
  );
}

/** Secrets of the test accounts as env variables; a missing secret is an error (the run would test nothing). */
export async function resolveSecrets(accounts: Record<string, PocAccount>, env = process.env): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, a] of Object.entries(accounts)) {
    for (const [secret, ref] of Object.entries(a.secrets ?? {})) {
      const key = secretEnvName(name, secret);
      if ('env' in ref) {
        const v = env[ref.env];
        if (v === undefined) throw new Error(`account ${name}: environment variable ${ref.env} is not set (${secret})`);
        out[key] = v;
      } else {
        out[key] = await keychain(ref.keychain.service, ref.keychain.account);
      }
    }
  }
  return out;
}

/** Accounts for the prompt: everything but secret values, which are named by their env variables. */
export function accountsText(accounts: Record<string, PocAccount>): string {
  const rows = Object.entries(accounts).map(([name, a]) => {
    const parts = [a.username && `username \`${a.username}\``, a.role && `role ${a.role}`, a.tenant && `tenant ${a.tenant}`];
    const secrets = Object.keys(a.secrets ?? {}).map((s) => `${s} in \`$${secretEnvName(name, s)}\``);
    return `- ${name}: ${[...parts, ...secrets].filter(Boolean).join(', ')}${a.notes ? ` — ${a.notes}` : ''}`;
  });
  return rows.join('\n') || '(no test accounts configured)';
}

/** `host:port` of the base URL as the sandbox network allowlist entry. */
export function allowedHost(baseUrl: string): string {
  const u = new URL(baseUrl);
  return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Claude Code settings (`--settings`) of a tester session: the configured base (OS sandbox) plus the base URL in the
 * sandbox network allowlist and a PreToolUse hook that asks the app about every command (SPEC §3). The hook is a
 * `curl` command, not an `http` hook: Claude Code sends http hooks through the sandbox proxy, which refuses the app's port.
 */
export function testerSettings(base: Record<string, unknown>, baseUrl: string, hook: { url: string; headerFile: string }): Record<string, unknown> {
  const out = structuredClone(base);
  const sandbox = isObject(out.sandbox) ? out.sandbox : (out.sandbox = {});
  const network = isObject(sandbox.network) ? sandbox.network : (sandbox.network = {});
  const domains = Array.isArray(network.allowedDomains) ? network.allowedDomains : [];
  network.allowedDomains = [...new Set([...domains, allowedHost(baseUrl)])];
  const hooks = isObject(out.hooks) ? out.hooks : (out.hooks = {});
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const args = ['-sS', '--fail', '--noproxy', '*', '-X', 'POST', '-H', 'content-type: application/json', '-H', `@${hook.headerFile}`, '--data-binary', '@-', hook.url];
  hooks.PreToolUse = [...pre, { matcher: 'Bash|WebFetch', hooks: [{ type: 'command', command: 'curl', args, onFailure: 'block', timeout: 10 }] }];
  return out;
}

/**
 * Sandbox runtime config (`@anthropic-ai/sandbox-runtime`) of a tester session under pi: the configured base plus the
 * base URL's host:port. A `localhost` base URL also gets 127.0.0.1:port: the runtime checks what a name resolves to and
 * lets a loopback address through only when that literal is listed.
 */
export function piSandboxConfig(base: Record<string, unknown>, baseUrl: string): Record<string, unknown> {
  const out = structuredClone(base);
  const network = isObject(out.network) ? out.network : (out.network = {});
  const domains = Array.isArray(network.allowedDomains) ? network.allowedDomains : [];
  const host = allowedHost(baseUrl);
  const extra = new URL(baseUrl).hostname === 'localhost' ? [host.replace(/^localhost:/, '127.0.0.1:')] : [];
  network.allowedDomains = [...new Set([...domains, host, ...extra])];
  return out;
}

const URL_RE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`\\<>)]+/g;
/** curl options that send the request somewhere else than its URL. */
const REDIRECT_OPTS = /(^|\s)(-x\S*|--proxy|--preproxy|--socks\S*|--connect-to|--resolve|--unix-socket|--abstract-unix-socket|--dns-servers|--doh-url)(?=\s|=|$)/;

/**
 * Decision of the tester's PreToolUse hook: a deny reason, or null to let the normal permission flow decide.
 * First line of defence; the OS sandbox network allowlist is what actually confines scripts.
 */
export function hookDecision(baseUrl: string, input: { tool_name?: string; tool_input?: Record<string, unknown> }): string | null {
  const origin = new URL(baseUrl).origin;
  const ti = input.tool_input ?? {};
  const urls: string[] = [];
  if (input.tool_name === 'WebFetch') urls.push(String(ti.url ?? ''));
  if (input.tool_name === 'Bash') {
    const cmd = String(ti.command ?? '');
    if (ti.dangerouslyDisableSandbox) return 'tester commands run only in the sandbox';
    const opt = REDIRECT_OPTS.exec(cmd);
    if (opt) return `option ${opt[2]} redirects the request; only requests to ${origin} are allowed`;
    urls.push(...(cmd.match(URL_RE) ?? []));
  }
  for (const u of urls) {
    let o: string;
    try {
      o = new URL(u).origin;
    } catch {
      return `cannot parse URL ${u}`;
    }
    if (o !== origin) return `request to ${u} is forbidden: the tester only talks to ${origin}`;
  }
  return null;
}

export interface InstanceOptions {
  cwd: string;
  /** The whole environment of the instance commands. */
  env: Record<string, string>;
  startTimeoutSec: number;
  healthcheckIntervalSec: number;
  stopTimeoutSec: number;
  log: (text: string) => void;
}

const KILL_GRACE_MS = 5000;
const HEAD_LINES = 40;
const TAIL_LINES = 80;
const MAX_LINE = 400;

/**
 * Instance output for an env-setup agent: the first and the last lines, with runs of one line collapsed (a dead tunnel
 * repeats one error for the whole start timeout and would push out the lines that say what happened).
 */
export class OutputLog {
  private head: string[] = [];
  private tail: string[] = [];
  private dropped = 0;
  private partial = '';
  private last: string | null = null;
  private repeats = 0;

  add(text: string): void {
    const parts = (this.partial + text).split('\n');
    this.partial = parts.pop()!;
    for (const l of parts) this.line(l.replace(/\r$/, '').slice(0, MAX_LINE));
  }

  private line(l: string): void {
    if (l === this.last) {
      this.repeats++;
      return;
    }
    if (this.repeats) this.push(repeated(this.repeats));
    this.repeats = 0;
    this.last = l;
    this.push(l);
  }

  private push(l: string): void {
    if (this.head.length < HEAD_LINES) return void this.head.push(l);
    this.tail.push(l);
    if (this.tail.length > TAIL_LINES) {
      this.tail.shift();
      this.dropped++;
    }
  }

  text(): string {
    const skipped = this.dropped ? [`… ${this.dropped} lines skipped`] : [];
    const pending = [...(this.repeats ? [repeated(this.repeats)] : []), ...(this.partial ? [this.partial.slice(0, MAX_LINE)] : [])];
    return [...this.head, ...skipped, ...this.tail, ...pending].join('\n');
  }
}

const repeated = (n: number) => `… (the line above repeated ${n} more times)`;

/** Runs a shell command to completion; resolves with its exit code (null on timeout or abort). */
function runShell(cmd: string, o: InstanceOptions, timeoutMs: number, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d: Buffer) => o.log(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => o.log(d.toString('utf8')));
    child.on('error', (e) => o.log(`${e.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve(code);
    });
  });
}

/**
 * A test instance started by the app from the worktree (SPEC §4, Q14): `start` may keep running (foreground server)
 * or exit after starting it in the background; ready once `healthcheck` exits 0. `stop` runs on the way out, then
 * whatever is left of the start process group is killed.
 */
export class PocInstance {
  private child: ReturnType<typeof spawn> | null = null;
  private exitCode: number | null | undefined = undefined;
  private readonly o: InstanceOptions;
  private readonly out = new OutputLog();

  constructor(
    private readonly env: PocEnvironment,
    o: InstanceOptions,
  ) {
    this.o = {
      ...o,
      log: (t) => {
        this.out.add(t);
        o.log(t);
      },
    };
  }

  /** The instance output, shortened (OutputLog). */
  tail(): string {
    return this.out.text();
  }

  async start(signal: AbortSignal): Promise<void> {
    this.o.log(`$ ${this.env.start}\n`);
    const child = spawn('sh', ['-c', this.env.start], { cwd: this.o.cwd, env: this.o.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout!.on('data', (d: Buffer) => this.o.log(d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => this.o.log(d.toString('utf8')));
    child.on('error', (e) => this.o.log(`${e.message}\n`));
    child.on('exit', (code) => (this.exitCode = code));
    const deadline = Date.now() + this.o.startTimeoutSec * 1000;
    const interval = this.o.healthcheckIntervalSec * 1000;
    for (;;) {
      if (signal.aborted) throw new Error('stopped');
      if (this.exitCode !== undefined && this.exitCode !== 0) throw new Error(`start command exited with code ${this.exitCode}`);
      if ((await runShell(this.env.healthcheck, { ...this.o, log: () => undefined }, interval, signal)) === 0) {
        this.o.log('[aiegis] environment ready\n');
        return;
      }
      if (Date.now() > deadline) throw new Error(`environment did not pass the healthcheck within ${this.o.startTimeoutSec} s`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  async stop(): Promise<void> {
    if (this.env.stop) {
      this.o.log(`$ ${this.env.stop}\n`);
      const code = await runShell(this.env.stop, this.o, this.o.stopTimeoutSec * 1000);
      if (code !== 0) this.o.log(`[aiegis] stop command exited with code ${code}\n`);
    }
    const child = this.child;
    if (!child?.pid) return;
    const group = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        /* already gone */
      }
    };
    // Background leftovers of a `start` that already exited share its process group too.
    group('SIGTERM');
    if (this.exitCode !== undefined) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        group('SIGKILL');
        resolve();
      }, KILL_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export type PocCheckState = 'idle' | 'starting' | 'ready' | 'failed';

/**
 * A test start an env-setup session runs itself through MCP: started in the background and polled, so no tool call
 * outlives the client's timeout; the instance is stopped as soon as it is ready or has failed.
 */
export class PocCheck {
  state: PocCheckState = 'idle';
  error: string | null = null;
  private instance: PocInstance | null = null;
  private ctrl: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly make: () => Promise<PocInstance>,
    private readonly onDone: (error: string | null, output: string) => void,
  ) {}

  async start(): Promise<void> {
    await this.stop();
    const ctrl = (this.ctrl = new AbortController());
    this.state = 'starting';
    this.error = null;
    this.instance = null;
    this.running = (async () => {
      try {
        this.instance = await this.make();
        await this.instance.start(ctrl.signal);
        this.state = 'ready';
      } catch (e) {
        this.state = 'failed';
        this.error = ctrl.signal.aborted ? 'stopped' : (e as Error).message;
      } finally {
        await this.instance?.stop().catch(() => undefined);
      }
      if (!ctrl.signal.aborted) this.onDone(this.error, this.output());
    })();
  }

  output(): string {
    return this.instance?.tail() ?? '';
  }

  /** Resolves when the running start is ready or has failed, or after `ms`. */
  async settled(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.running, new Promise((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
  }

  async stop(): Promise<void> {
    this.ctrl?.abort();
    await this.running;
  }

  /** The environment changed: an earlier result says nothing about it. */
  async reset(): Promise<void> {
    await this.stop();
    this.state = 'idle';
    this.error = null;
  }
}
