import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const external = ['electron', 'node-pty'];
const common = { bundle: true, sourcemap: true, logLevel: 'info' };

mkdirSync('dist/renderer', { recursive: true });

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external }),
  // The service and its CLI: no Electron, no UI packages.
  build({ ...common, entryPoints: ['src/cli/main.ts'], outfile: 'dist/cli.js', platform: 'node', format: 'cjs' }),
  // Loaded by the pi agent (`pi --extension`), not by Electron.
  build({ ...common, entryPoints: ['src/main/pi/extension.ts'], outfile: 'dist/pi-extension.mjs', platform: 'node', format: 'esm', external: ['@anthropic-ai/sandbox-runtime'] }),
  // Optional local runner, not part of the repository.
  ...(existsSync('e2e/run.ts')
    ? [build({ ...common, entryPoints: ['e2e/run.ts'], outfile: 'dist/e2e.js', platform: 'node', format: 'cjs', external })]
    : []),
  build({
    ...common,
    entryPoints: ['src/renderer/main.tsx'],
    outfile: 'dist/renderer/renderer.js',
    platform: 'browser',
    format: 'iife',
    loader: { '.css': 'css' },
  }),
]);

// The ui kit page (`npm run kit`), a development tool: excluded from the package.
await build({ ...common, entryPoints: ['src/renderer/ui/Kit.tsx'], outfile: 'dist/kit/kit.js', platform: 'browser', format: 'iife', loader: { '.css': 'css' } });
cpSync('src/renderer/ui/kit.html', 'dist/kit/index.html');

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('node_modules/@xterm/xterm/css/xterm.css', 'dist/renderer/xterm.css');
