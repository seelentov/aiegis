import os from 'node:os';
import path from 'node:path';

export interface AppPaths {
  /** Global defaults (~/.aiegis). */
  globalDir: string;
  /** Centralized app data (~/Library/Application Support/aiegis). */
  dataDir: string;
  /** Shipped default config files. */
  defaultsDir: string;
}

function platformDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'aiegis');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'aiegis');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'aiegis');
}

/** AIEGIS_HOME / AIEGIS_DATA override locations (isolated data for headless runs). */
export function resolveAppPaths(defaultsDir: string): AppPaths {
  return {
    globalDir: process.env.AIEGIS_HOME ?? path.join(os.homedir(), '.aiegis'),
    dataDir: process.env.AIEGIS_DATA ?? platformDataDir(),
    defaultsDir,
  };
}

export function projectDataDir(paths: AppPaths, projectId: string): string {
  return path.join(paths.dataDir, projectId);
}
