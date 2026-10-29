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
  if (!args[0].startsWith('--')) process.stdout.write(`initial prompt: ${args[0].split('\n')[0]}\r\n`);
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
    // Matrix prompts list cells as "- requirement_id `<id>` — <key> (<section>): <text>".
    const reqLines = [...prompt.matchAll(/^- requirement_id `([^`]+)` — [^:]+: (.*)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
    const moduleOf = () => /module_id `([^`]+)`/.exec(prompt)[1];
    if (prompt.includes('Extract the requirements')) {
      const versionId = /document_version id `([^`]+)`/.exec(prompt)[1];
      const file = /the file `([^`]+)`/.exec(prompt)[1];
      let section = '';
      const out = [];
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.startsWith('#')) section = line.replace(/^#+\s*/, '');
        const m = /^([A-Z]+-\d+): (.+)$/.exec(line);
        if (m) out.push((await mcp('add_requirement', { version_id: versionId, key: m[1], text: m[2], section, quote: m[2] })).content[0].text);
      }
      const bad = await mcp('add_requirement', { version_id: versionId, text: 'made up', section, quote: 'not in the document' });
      return done(`${out.length} ${bad.content[0].text}`);
    }
    if (prompt.includes('Triage the applicability')) {
      const module_id = moduleOf();
      for (const r of reqLines) {
        await mcp('triage_cell', { module_id, requirement_id: r.id, applicable: !r.text.includes('XSS'), reason: 'looked at the build file' });
      }
      return done('triaged');
    }
    if (prompt.includes('Check module')) {
      const module_id = moduleOf();
      let signals = '';
      if (prompt.includes('get_signals') && reqLines.length) {
        const res = await mcp('get_signals', { module_id, requirement_id: reqLines[0].id });
        const slice = JSON.parse(res.content[0].text);
        signals = ` (signals: ${slice.total}, suppressed: ${slice.suppressed})`;
      }
      for (const r of reqLines) {
        // Leaves this cell without a verdict while it shares the session with others (cell-level atomicity).
        if (r.text.includes('SKIP_ONCE') && reqLines.length > 1) continue;
        const cell = { module_id, requirement_id: r.id };
        const evidence = [{ file: 'svc/Api.java', line: 1, note: 'checked' }];
        if (r.text.includes('IDOR')) {
          const early = await mcp('set_verdict', { ...cell, status: 'finding', reason: 'no owner check', evidence });
          const sim = JSON.parse((await mcp('find_similar', { module_id, files: ['svc/Api.java'], cwe: 'CWE-639', entry_point: 'http GET /api' })).content[0].text);
          if (sim.candidates.length) await mcp('link_finding', { ...cell, finding_id: sim.candidates[0].finding_id });
          else {
            await mcp('create_finding', {
              ...cell, check_id: sim.check_id, title: 'IDOR in /api', description: 'Object id is not checked against the caller',
              severity: 'high', cwe: 'CWE-639', entry_point: 'http GET /api', files: evidence,
            });
          }
          await mcp('set_verdict', { ...cell, status: 'finding', reason: `no owner check (${early.isError ? 'needed a finding first' : 'unexpected'})`, evidence });
        } else {
          await mcp('set_verdict', { ...cell, status: 'pass', reason: `checked in code${signals}`, evidence });
        }
      }
      return done('verdicts');
    }
    const who = JSON.parse((await mcp('whoami', {})).content[0].text);
    const own = who.writable_entities[0];
    await mcp('submit_result', { entity_type: own.type, entity_id: own.id, summary: `cwd=${process.cwd()}` });
    const denied = await mcp('submit_result', { entity_type: 'task', entity_id: 'not-mine', summary: 'x' });
    emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: denied.content[0].text }], usage: { input_tokens: 5, output_tokens: 7 } } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 7 } });
  });
}
