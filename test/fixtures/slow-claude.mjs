#!/usr/bin/env node
// Stand-in for `claude` that keeps working until it is stopped.
process.stdin.resume();
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', cwd: process.cwd() }) + '\n');
setInterval(() => undefined, 1000);
