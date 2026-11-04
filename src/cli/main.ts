import path from 'node:path';
import { resolveAppPaths, socketPath } from '../main/paths';
import { NotRunning } from './client';
import { runCli } from './cli';
import { runService } from './service';

const defaultsDir = path.join(__dirname, '..', 'defaults');

// `aiegis watch | head`: the reader went away.
process.stdout.on('error', () => process.exit(0));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!argv.length) return runService(defaultsDir);
  await runCli(argv, {
    socket: socketPath(resolveAppPaths(defaultsDir)),
    out: (text) => console.log(text),
    isTty: Boolean(process.stdin.isTTY),
    cwd: process.cwd(),
    stdin: process.stdin,
  });
}

main().catch((e: Error) => {
  console.error(`aiegis: ${e.message}`);
  process.exitCode = e instanceof NotRunning ? 2 : 1;
});
