import { execFile, spawn } from 'node:child_process';
import type { ScannerSettings } from '../config/loader';

/** One command line of a scan: scanner args with placeholders filled. */
export interface Invocation {
  args: string[];
  /** Path this invocation scans ("." or relative to the repository root); normalizers resolve reported paths with it. */
  target: string;
  /** Report file the scanner writes ({{report}}), or null when stdout is the report. */
  report: string | null;
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Expands `scanners.<name>.args`: `{{targets}}` (a whole argument) becomes all paths in one invocation,
 * `{{target}}` gives one invocation per path, `{{report}}` is a report file per invocation.
 * Any other placeholder is a configuration error (args are user-editable).
 */
export function buildInvocations(name: string, args: string[], targets: string[], reportFile: (i: number) => string): Invocation[] {
  const used = new Set<string>();
  for (const a of args) for (const m of a.matchAll(PLACEHOLDER)) used.add(m[1]);
  const unknown = [...used].filter((u) => !['targets', 'target', 'report'].includes(u));
  if (unknown.length) throw new Error(`scanners.${name}.args: unknown placeholder {{${unknown[0]}}}, available: targets, target, report`);
  if (used.has('targets') === used.has('target')) throw new Error(`scanners.${name}.args: exactly one of the placeholders {{targets}} or {{target}} is required`);
  if (args.some((a) => a.includes('{{') && /\{\{\s*targets\s*\}\}/.test(a) && a.trim() !== '{{targets}}'))
    throw new Error(`scanners.${name}.args: {{targets}} must be a separate argument`);
  const fill = (target: string, i: number) => {
    const report = used.has('report') ? reportFile(i) : null;
    const out: string[] = [];
    for (const a of args) {
      if (a.trim() === '{{targets}}') out.push(...targets);
      else out.push(a.replace(PLACEHOLDER, (_m, n: string) => (n === 'target' ? target : (report as string))));
    }
    return { args: out, target, report };
  };
  return used.has('targets') ? [fill(targets.length === 1 ? targets[0] : '.', 0)] : targets.map((t, i) => fill(t, i));
}

/** Availability check at startup: the binary runs with `version_args`. */
export function checkScanner(s: Pick<ScannerSettings, 'binary' | 'version_args'>): Promise<{ available: boolean; version: string | null; error: string | null }> {
  return new Promise((resolve) => {
    execFile(s.binary, s.version_args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout}\n${stderr}`.split('\n').map((l) => l.trim()).filter(Boolean);
      // Some tools print an upgrade notice before the version.
      const version = text.find((l) => /\d+\.\d+/.test(l)) ?? text[0] ?? null;
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        resolve({ available: false, version: null, error: code === 'ENOENT' ? `${s.binary} not found in PATH` : err.message.split('\n')[0] });
      } else resolve({ available: true, version: version ? version.replace(/^version:\s*/i, '') : null, error: null });
    });
  });
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Killed by timeout or abort. */
  killed: 'timeout' | 'aborted' | null;
}

/** Runs one scanner invocation in `cwd`; killed on timeout or abort. */
export function runProcess(binary: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    let killed: ProcessResult['killed'] = null;
    let spawnError: string | null = null;
    const kill = (why: 'timeout' | 'aborted') => {
      if (killed) return;
      killed = why;
      child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const onAbort = () => kill('aborted');
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-8000)));
    child.on('error', (e) => (spawnError = e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: spawnError ? `${spawnError}\n${stderr}` : stderr, killed });
    });
  });
}
