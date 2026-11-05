import path from 'node:path';
import sea from 'node:sea';
import { resolveAppPaths, socketPath } from '../main/paths';
import { setPiExtension } from '../main/pi/args';
import { NotRunning } from './client';
import { runCli } from './cli';
import { extractRuntime } from './runtime';
import { runService } from './service';

// `aiegis watch | head`: the reader went away.
process.stdout.on('error', () => process.exit(0));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    if (!sea.isSea()) return runService(path.join(__dirname, '..', 'defaults'));
    const runtime = extractRuntime(resolveAppPaths('').dataDir, (key) => sea.getRawAsset(key));
    setPiExtension(path.join(runtime, 'pi-extension.mjs'));
    return runService(path.join(runtime, 'defaults'));
  }
  await runCli(argv, {
    socket: socketPath(resolveAppPaths('')),
    out: (text) => console.log(text),
    isTty: Boolean(process.stdin.isTTY),
    cwd: process.cwd(),
    stdin: process.stdin,
  });
}

main().catch((e: Error) => {
  console.error(`aiegis: ${e.message}`);
  // Exit outright: a service that failed to start may hold open handles and would hang without a socket.
  process.exit(e instanceof NotRunning ? 2 : 1);
});
