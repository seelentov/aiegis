import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Files of the runtime directory, as stored in the executable by scripts/build-sea.mjs. */
export interface RuntimeFile {
  path: string;
  mode: number;
}

export const MANIFEST_ASSET = 'manifest.json';

/**
 * Unpacks what must exist as real files (default configs, the pi extension and its helpers) into
 * `<dataDir>/runtime/<hash of the content>`. A new build gets a new directory, the old ones are removed.
 * Returns the directory.
 */
export function extractRuntime(dataDir: string, asset: (key: string) => ArrayBuffer | string): string {
  const manifest = Buffer.from(asset(MANIFEST_ASSET) as ArrayBuffer);
  const files = JSON.parse(manifest.toString('utf8')) as RuntimeFile[];
  const base = path.join(dataDir, 'runtime');
  const dir = path.join(base, crypto.createHash('sha256').update(manifest).digest('hex').slice(0, 16));
  if (fs.existsSync(dir)) return dir;
  // Renamed when complete: a start interrupted here leaves no half-filled directory.
  const tmp = `${dir}.${process.pid}.tmp`;
  for (const f of files) {
    const file = path.join(tmp, f.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(asset(f.path) as ArrayBuffer), { mode: f.mode });
  }
  for (const old of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    if (path.join(base, old) !== tmp) fs.rmSync(path.join(base, old), { recursive: true, force: true });
  }
  fs.renameSync(tmp, dir);
  return dir;
}
