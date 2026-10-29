import { execFile, spawn } from 'node:child_process';
import type { Settings } from './config/loader';

/** Entity of a PoC tester job and scope of its token (id = finding id). */
export const POC_ENTITY = 'poc';
/** Directory of a run's own files (scripts) inside its checkout. */
export const POC_DIR = '.aiegis-poc';

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
  if (!e) return { reason: 'в конфигурации проекта не описано тестовое окружение (poc.environment)' };
  const missing = (['start', 'healthcheck', 'base_url'] as const).filter((k) => !e[k]?.trim());
  if (missing.length) return { reason: `в poc.environment не заданы: ${missing.join(', ')}` };
  let url: URL;
  try {
    url = new URL(e.base_url!);
  } catch {
    return { reason: `poc.environment.base_url: неверный URL ${e.base_url}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { reason: 'poc.environment.base_url: нужен http или https' };
  return { env: { start: e.start!, healthcheck: e.healthcheck!, stop: e.stop?.trim() || null, base_url: e.base_url!, accounts: e.accounts ?? {} } };
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
      err ? reject(new Error(`секрет не найден в keychain (service ${service}, account ${account})`)) : resolve(out.replace(/\n$/, '')),
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
        if (v === undefined) throw new Error(`учётка ${name}: не задана переменная окружения ${ref.env} (${secret})`);
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
    if (ti.dangerouslyDisableSandbox) return 'команды тестировщика выполняются только в песочнице';
    const opt = REDIRECT_OPTS.exec(cmd);
    if (opt) return `опция ${opt[2]} перенаправляет запрос; разрешены только запросы на ${origin}`;
    urls.push(...(cmd.match(URL_RE) ?? []));
  }
  for (const u of urls) {
    let o: string;
    try {
      o = new URL(u).origin;
    } catch {
      return `не удалось разобрать URL ${u}`;
    }
    if (o !== origin) return `запрос на ${u} запрещён: тестировщик обращается только к ${origin}`;
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

  constructor(
    private readonly env: PocEnvironment,
    private readonly o: InstanceOptions,
  ) {}

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
      if (signal.aborted) throw new Error('остановлено');
      if (this.exitCode !== undefined && this.exitCode !== 0) throw new Error(`команда start завершилась с кодом ${this.exitCode}`);
      if ((await runShell(this.env.healthcheck, { ...this.o, log: () => undefined }, interval, signal)) === 0) {
        this.o.log('[aiegis] окружение готово\n');
        return;
      }
      if (Date.now() > deadline) throw new Error(`окружение не прошло healthcheck за ${this.o.startTimeoutSec} с`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  async stop(): Promise<void> {
    if (this.env.stop) {
      this.o.log(`$ ${this.env.stop}\n`);
      const code = await runShell(this.env.stop, this.o, this.o.stopTimeoutSec * 1000);
      if (code !== 0) this.o.log(`[aiegis] команда stop завершилась с кодом ${code}\n`);
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
