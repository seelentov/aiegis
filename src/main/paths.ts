import os from 'node:os';
import path from 'node:path';

/** Smallest limit of unix socket paths among the supported systems, without the terminating zero. */
const MAX_SOCKET_PATH = 103;

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

/** Control socket of the service. */
export function socketPath(paths: Pick<AppPaths, 'dataDir'>): string {
  const file = path.join(paths.dataDir, 'aiegis.sock');
  // A longer path is silently cut by the OS: the service would listen where no client looks.
  if (Buffer.byteLength(file) > MAX_SOCKET_PATH) throw new Error(`the path of the control socket is too long, move the data directory (AIEGIS_DATA): ${file}`);
  return file;
}

export function projectDataDir(paths: AppPaths, projectId: string): string {
  return path.join(paths.dataDir, projectId);
}
