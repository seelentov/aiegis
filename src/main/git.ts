import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from './log';

const execFileAsync = promisify(execFile);
const log = getLogger('git');

export async function git(cwd: string, args: string[]): Promise<string> {
  log.debug('git %s in %s', args.join(' '), cwd);
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

export async function repoRoot(dir: string): Promise<string> {
  return git(dir, ['rev-parse', '--show-toplevel']);
}

export async function headSha(dir: string): Promise<string> {
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Local and remote-tracking branches; symbolic refs such as origin/HEAD are left out. */
export async function listBranches(dir: string): Promise<string[]> {
  const out = await git(dir, ['for-each-ref', '--format=%(if)%(symref)%(then)%(else)%(refname:short)%(end)', 'refs/heads', 'refs/remotes']);
  return out.split('\n').filter(Boolean);
}

/** Commit of a user-given ref; `--end-of-options` keeps a ref from being read as a flag. */
export async function commitOf(dir: string, ref: string): Promise<string> {
  return git(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).catch(() => {
    throw new Error(`branch ${ref} not found`);
  });
}

/** Where two commits forked; what a pull request shows is the diff from here to its branch. */
export async function mergeBase(dir: string, a: string, b: string): Promise<string> {
  return git(dir, ['merge-base', a, b]).catch(() => {
    throw new Error(`commits ${a.slice(0, 8)} and ${b.slice(0, 8)} have no common history`);
  });
}

/** Text of a diff; null if it cannot be read (unknown commit, more than the output limit of `git`). */
/** `exclude` are pathspec globs left out of the text. */
export async function diffText(dir: string, from: string, to: string, exclude: string[] = []): Promise<string | null> {
  const paths = exclude.length ? ['.', ...exclude.map((g) => `:(exclude,glob)${g}`)] : [];
  return git(dir, ['diff', '--no-ext-diff', from, to, '--', ...paths]).catch((e: Error) => {
    log.warn('diff %s..%s failed: %s', from, to, e.message);
    return null;
  });
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
