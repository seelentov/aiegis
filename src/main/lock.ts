import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function alive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One Core per data directory: a second one would mark live runs interrupted and start their jobs again (SPEC §23).
 * Returns the release function.
 * shortcut: a stale lock whose pid was reused since the same boot looks taken, the error names the file to delete.
 */
export function acquireLock(dataDir: string): () => void {
  const file = path.join(dataDir, 'aiegis.lock');
  fs.mkdirSync(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const pid = Number(fs.readFileSync(file, 'utf8'));
    // Written before this boot: its pid now belongs to someone else, and a service must come up after a power loss.
    const stale = fs.statSync(file).mtimeMs < Date.now() - os.uptime() * 1000;
    if (!stale && alive(pid)) throw new Error(`aiegis already runs on this data directory (pid ${pid}); stop it first, or delete ${file} if that is another program`);
    fs.rmSync(file, { force: true });
  }
  throw new Error(`cannot take the lock ${file}`);
}
