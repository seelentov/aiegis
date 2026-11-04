// Builds the service as one executable (Node single executable application) for the OS and architecture it runs on.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const NODE_MAJOR = 24; // as inside Electron 45: the same node:sqlite for the app and the service
if (Number(process.versions.node.split('.')[0]) !== NODE_MAJOR) throw new Error(`Node ${NODE_MAJOR} is required, this is ${process.version}`);
if (process.platform !== 'linux') throw new Error('the service is built for Linux only');

const OUT = 'dist/sea';
const RUNTIME = path.join(OUT, 'runtime');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const arch = process.arch;
const SANDBOX = 'node_modules/@anthropic-ai/sandbox-runtime/vendor';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(RUNTIME, { recursive: true });

await build({ entryPoints: ['src/cli/main.ts'], outfile: path.join(OUT, 'main.js'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'info' });
// With the sandbox runtime inside: the executable has no node_modules next to it.
await build({
  entryPoints: ['src/main/pi/extension.ts'],
  outfile: path.join(RUNTIME, 'pi-extension.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'info',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
cpSync('defaults', path.join(RUNTIME, 'defaults'), { recursive: true });
// The sandbox runtime looks for these next to its bundle.
const seccomp = path.join('vendor', 'seccomp', arch);
cpSync(path.join(SANDBOX, 'seccomp', arch, 'apply-seccomp'), path.join(RUNTIME, seccomp, 'apply-seccomp'), { recursive: true });
cpSync(path.join(SANDBOX, 'java-proxy-agent', 'srt-proxy-agent.jar'), path.join(RUNTIME, 'vendor', 'java-proxy-agent', 'srt-proxy-agent.jar'), { recursive: true });

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else files.push(file);
  }
};
walk(RUNTIME);

const rel = (f) => path.relative(RUNTIME, f).split(path.sep).join('/');
// Holds the content hash: the executable unpacks a changed runtime into a new directory.
const manifest = files.map((f) => ({ path: rel(f), mode: statSync(f).mode & 0o777, sha256: crypto.createHash('sha256').update(readFileSync(f)).digest('hex') }));
const manifestFile = path.join(OUT, 'manifest.json');
writeFileSync(manifestFile, JSON.stringify(manifest));

const blob = path.join(OUT, 'sea.blob');
const config = path.join(OUT, 'sea-config.json');
writeFileSync(
  config,
  JSON.stringify({
    main: path.join(OUT, 'main.js'),
    output: blob,
    disableExperimentalSEAWarning: true,
    assets: { 'manifest.json': manifestFile, ...Object.fromEntries(files.map((f) => [rel(f), f])) },
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

mkdirSync('release', { recursive: true });
const exe = path.join('release', `aiegis-${version}-linux-${arch}`);
copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);
execFileSync(process.execPath, ['node_modules/postject/dist/cli.js', exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit' });
console.log(`${exe}: ${Math.round(statSync(exe).size / 1024 / 1024)} MB`);
