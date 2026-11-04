import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from './log';

const exec = promisify(execFile);
const log = getLogger('git');

export async function git(cwd: string, args: string[]): Promise<string> {
  log.debug('git %s in %s', args.join(' '), cwd);
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

export async function repoRoot(dir: string): Promise<string> {
  return git(dir, ['rev-parse', '--show-toplevel']);
}

export async function headSha(dir: string): Promise<string> {
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Files changed between two commits; null if the diff cannot be computed (unknown commit). */
export async function changedFiles(dir: string, from: string, to: string): Promise<string[] | null> {
  if (from === to) return [];
  try {
    const out = await git(dir, ['diff', '--name-only', '-z', from, to, '--']);
    return out.split('\0').filter(Boolean);
  } catch (e) {
    log.warn('diff %s..%s failed: %s', from, to, (e as Error).message);
    return null;
  }
}
