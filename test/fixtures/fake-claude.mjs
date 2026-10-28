#!/usr/bin/env node
// Stand-in for `claude` in core integration tests: emits stream-json and talks to the aiegis MCP server.
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');

async function mcp(name, a) {
  const cfg = JSON.parse(fs.readFileSync(arg('--mcp-config'), 'utf8')).mcpServers.aiegis;
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { ...cfg.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: a } }),
  });
  return (await res.json()).result;
}

if (!args.includes('-p')) {
  // Interactive mode: echo args, exit on "q".
  process.stdout.write(`fake interactive ${args.slice(0, 2).join(' ')}\r\n`);
  process.stdin.on('data', (d) => d.toString().includes('q') && process.exit(0));
} else {
  let prompt = '';
  process.stdin.on('data', (d) => (prompt += d));
  process.stdin.on('end', async () => {
    const sid = arg('--session-id');
    emit({ type: 'system', subtype: 'init', session_id: sid, model: arg('--model'), cwd: process.cwd() });
    if (prompt.includes('SLEEP')) {
      emit({ type: 'assistant', message: { id: 'm0', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 1, output_tokens: 1 } } });
      setInterval(() => undefined, 1000);
      return;
    }
    if (prompt.includes('RATELIMIT')) {
      emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 4102444800 } });
      emit({ type: 'result', subtype: 'success', is_error: true, result: 'usage limit reached', usage: {} });
      process.exit(1);
    }
    if (prompt.includes('TOKENS')) {
      emit({ type: 'assistant', message: { id: 'm1', content: [], usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 999999 } } });
      setInterval(() => undefined, 1000);
      return;
    }
    const done = (text) => emit({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 7 } });
    if (prompt.includes('Mark up the repository')) {
      const r = await mcp('upsert_module', { name: 'svc', globs: ['svc/**'], description: 'demo service' });
      return done(r.content[0].text);
    }
    if (prompt.includes('Build the entry point map')) {
      const moduleId = /module_id `([^`]+)`/.exec(prompt)[1];
      const r = await mcp('upsert_entry_point', {
        module_id: moduleId, kind: 'http', method: 'GET', name: '/api', handler_file: 'svc/Api.java', handler_line: 1,
        auth: 'none found', call_chain: [{ file: 'svc/Api.java', function: 'get', sink: 'SQL' }],
      });
      return done(r.content[0].text);
    }
    const who = JSON.parse((await mcp('whoami', {})).content[0].text);
    const own = who.writable_entities[0];
    await mcp('submit_result', { entity_type: own.type, entity_id: own.id, summary: `cwd=${process.cwd()}` });
    const denied = await mcp('submit_result', { entity_type: 'task', entity_id: 'not-mine', summary: 'x' });
    emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: denied.content[0].text }], usage: { input_tokens: 5, output_tokens: 7 } } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 7 } });
  });
}
