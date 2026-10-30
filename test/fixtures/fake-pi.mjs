#!/usr/bin/env node
// Fake `pi --mode json` for tests: echoes what it got and finishes with one assistant message.
import fs from 'node:fs';

const args = process.argv.slice(2);
const at = (f) => args[args.indexOf(f) + 1];
const run = JSON.parse(fs.readFileSync(process.env.AIEGIS_PI_RUN, 'utf8'));
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'session', version: 3, id: at('--session-id'), cwd: process.cwd() });
  const text = `mode=${at('--mode')} tools=${at('--tools')} token=${run.mcp.token ? 'yes' : 'no'} allow=${run.allow.join(',')} prompt=${prompt}`;
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 20, totalTokens: 35, cost: { total: 0.002 } };
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage, stopReason: 'stop' } });
  out({ type: 'agent_settled', aborted: false });
});
