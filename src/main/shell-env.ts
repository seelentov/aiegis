import { execFile } from 'node:child_process';
import path from 'node:path';

const MARK = '__AIEGIS_PATH__';
/** The login shell runs the user's profile; a broken profile must not block startup for long. */
const SHELL_TIMEOUT_MS = 10_000;

/** PATH from `shellPath` first, then entries of `current` it lacks; empty entries and duplicates dropped. */
export function mergePath(shellPath: string, current: string | undefined): string {
  const parts = [...shellPath.split(path.delimiter), ...(current ?? '').split(path.delimiter)].filter(Boolean);
  return [...new Set(parts)].join(path.delimiter);
}

/** PATH printed between markers (profiles may print banners around it), or null. */
export function parseShellPath(output: string): string | null {
  const m = output.match(new RegExp(`${MARK}(.*?)${MARK}`, 's'));
  return m && m[1].trim() ? m[1].trim() : null;
}

/** PATH of the user's interactive login shell (what `claude` and scanners are found by in a terminal), or null. */
export function loginShellPath(shell = process.env.SHELL || '/bin/zsh'): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s' "${MARK}\${PATH}${MARK}"`],
      { timeout: SHELL_TIMEOUT_MS, env: { ...process.env, TERM: 'dumb' } },
      (_err, stdout) => resolve(parseShellPath(String(stdout ?? ''))),
    );
  });
}

/**
 * An app started from Finder/Dock gets launchd's minimal PATH (no /opt/homebrew/bin etc.), so binaries named in
 * the config by name (`claude.binary`, `scanners.*.binary`) would not be found. Adopts the login shell's PATH.
 * Returns the PATH entries that were added.
 */
export async function adoptLoginShellPath(): Promise<string[]> {
  if (process.platform === 'win32') return [];
  const shellPath = await loginShellPath();
  if (!shellPath) return [];
  const before = new Set((process.env.PATH ?? '').split(path.delimiter));
  process.env.PATH = mergePath(shellPath, process.env.PATH);
  return process.env.PATH.split(path.delimiter).filter((p) => !before.has(p));
}
