#!/usr/bin/env node
// Stand-in for `claude` in core integration tests: emits stream-json and talks to the aiegis MCP server.
import { execFileSync } from 'node:child_process';
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
    if (prompt.includes('DECLINE')) {
      emit({ type: 'assistant', message: { id: 'm0', stop_reason: 'refusal', content: [], usage: { input_tokens: 1, output_tokens: 1 } } });
      emit({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy', usage: {} });
      process.exit(0);
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
    if (prompt.includes('into text. The file is')) {
      if (prompt.includes('UNREADABLE')) return done('no text');
      await mcp('append_document_text', { part: 2, text: 'too early', last: false });
      await mcp('append_document_text', { part: 1, text: 'R-1: Read rule must hold.', last: false });
      const r = await mcp('append_document_text', { part: 2, text: 'R-2: Second rule must hold.', last: true });
      return done(r.content[0].text);
    }
    if (prompt.includes('Judge part of a catalogue')) {
      const entries = [...prompt.matchAll(/^- (https?:\S+) (.*)$/gm)].filter((m) => m[1].includes('/e'));
      const judged = entries.filter((m) => m[2] !== 'LEFT' || entries.length === 1);
      const r = await mcp('judge_catalogue_entries', { entries: judged.map((m) => ({ url: m[1], belongs: m[2] === 'One', reason: 'by its name' })) });
      return done(r.content[0].text);
    }
    if (prompt.includes('Check documents of project')) {
      const out = [];
      const call = async (n, a) => {
        const r = await mcp(n, a);
        const text = r?.content?.[0]?.text ?? 'no such tool';
        out.push(`${n}: ${text.slice(0, 200)}`);
        return { error: Boolean(r?.isError) || !r, text };
      };
      const json = (r) => JSON.parse(r.text);
      await call('list_documents', {});
      await call('fetch_url', { url: 'https://not-allowed.example/x' });
      const links = [...prompt.matchAll(/^- (https?:\S+)$/gm)].map((m) => m[1]);
      const docs = [...prompt.matchAll(/^- document_id `([^`]+)`/gm)].map((m) => m[1]);
      let changed = false;
      let last = null;
      for (const url of links) {
        const f = await call('fetch_url', { url });
        if (f.error) continue;
        last = json(f);
        const text = last.text_file ? fs.readFileSync(last.text_file, 'utf8') : '';
        const quote_fetch_id = last.fetch_id;
        const first = docs[0];
        const own = last.links?.find((l) => l.text.startsWith('OWN'));
        if (own) {
          changed = true;
          const g = json(await call('fetch_url', { url: own.url }));
          await call('request_document_review', { document_id: docs[0], fetch_ids: [999], reason: 'bad fetch' });
          await call('request_document_review', { document_id: docs[0], fetch_ids: [g.fetch_id], reason: 'its own page' });
        }
        if (text.includes('LIST PAGE')) await call('request_catalogue_review', { fetch_id: last.fetch_id });
        if (text.includes('CUT SHORT')) {
          changed = true;
          await call('propose_document_change', { kind: 'update', document_id: docs[0], edition: 'c1', reason: 'cut', quote: 'CUT SHORT', quote_fetch_id, source_fetch_ids: [last.fetch_id], start_phrase: 'CUT SHORT', end_phrase: 'CUT SHORT' });
        }
        if (text.includes('PART ONLY')) {
          changed = true;
          await call('propose_document_change', { kind: 'update', document_id: docs[0], edition: 'p1', reason: 'cut', quote: 'PART ONLY', quote_fetch_id, source_fetch_ids: [last.fetch_id], start_phrase: 'PART ONLY', end_phrase: 'PART ONLY' });
          await call('propose_document_change', { kind: 'update', document_id: docs[0], edition: 'p1', reason: 'only a part is public', quote: 'PART ONLY', quote_fetch_id, incomplete: true });
        }
        if (text.includes('AMENDS')) {
          changed = true;
          const held = fs.readFileSync(`current/${docs[0]}/text.md`, 'utf8');
          await call('propose_document_change', { kind: 'update', document_id: docs[0], edition: 'a1', reason: 'consolidated', quote: 'AMENDS', quote_fetch_id, source_fetch_ids: [last.fetch_id], restored_text: `${held}\nAMENDS clause` });
        }
        if (text.includes('NEW EDITION')) {
          changed = true;
          await call('propose_document_change', { kind: 'update', document_id: first, reason: 'no edition', source_fetch_ids: [last.fetch_id], start_phrase: 'NEW EDITION', end_phrase: 'END' });
          await call('propose_document_change', { kind: 'update', document_id: first, reason: 'made up', edition: 'made up', quote: 'not on the page at all', quote_fetch_id, source_fetch_ids: [last.fetch_id], start_phrase: 'NEW EDITION', end_phrase: 'END' });
          const edition = /NEW EDITION (\S+)/.exec(text)[1];
          const r = await call('propose_document_change', { kind: 'update', document_id: first, reason: 'the page states a new edition', edition, quote: `NEW EDITION ${edition}`, quote_fetch_id, source_fetch_ids: [last.fetch_id], start_phrase: 'NEW EDITION', end_phrase: 'END' });
          if (r.error) await call('report_document_check', { document_id: first, status: 'unverifiable', note: r.text });
        }
        if (text.includes('CANCELLED')) {
          changed = true;
          await call('propose_document_change', { kind: 'retire', document_id: first, reason: 'no quote' });
          await call('propose_document_change', { kind: 'retire', document_id: first, reason: 'the page cancels it', quote: 'CANCELLED', quote_fetch_id });
        }
        if (text.includes('REPLACED BY')) {
          changed = true;
          await call('propose_document_change', { kind: 'replace', document_id: first, title: 'Successor', reason: 'the page says so', quote: 'REPLACED BY', quote_fetch_id, source_fetch_ids: [last.fetch_id], start_phrase: 'REPLACED BY', end_phrase: 'END' });
        }
        if (text.includes('RESTORED')) {
          changed = true;
          await call('propose_document_change', { kind: 'update', document_id: first, edition: 'r1', reason: 'bad', quote: 'RESTORED', quote_fetch_id, source_fetch_ids: [last.fetch_id], restored_text: 'Invented paragraph.\nAnother invented one.' });
          await call('propose_document_change', { kind: 'update', document_id: first, edition: 'r1', reason: 'broken conversion', quote: 'RESTORED', quote_fetch_id, source_fetch_ids: [last.fetch_id], restored_text: text });
        }
        const add = last.links?.find((l) => l.text.startsWith('ADD'));
        if (add) {
          changed = true;
          const g = json(await call('fetch_url', { url: add.url }));
          await call('propose_document_change', { kind: 'add', title: add.text.slice(4), reason: 'belongs to the set', quote: add.text, quote_fetch_id, source_fetch_ids: [g.fetch_id] });
        }
      }
      if (!changed) for (const document_id of docs) await call('report_document_check', last ? { document_id, status: 'current', note: 'edition unchanged', fetch_id: last.fetch_id, edition: 'first' } : { document_id, status: 'unverifiable', note: 'site down' });
      return done(out.join('\n'));
    }
    if (prompt.includes('Plan the security requirement documents')) {
      const bad = await mcp('plan_security_documents', { documents: [{ slug: 'x', title: 'X', key_prefix: 'XX', scope: 's', modules: ['nope'], sections: ['A'] }], set_name: 'Demo security' });
      const r = await mcp('plan_security_documents', {
        documents: [
          { slug: 'authn', title: 'Authentication', key_prefix: 'AUTHN', scope: 'login of svc', modules: ['svc'], sections: ['Login', 'Sessions'] },
          { slug: 'data', title: 'Data protection', key_prefix: 'DATA', scope: 'stored data', modules: [], sections: ['Storage'] },
        ],
        set_name: 'Demo security',
      });
      return done(`${bad.content[0].text} ${r.content[0].text}`);
    }
    if (prompt.includes('Write the security requirement document')) {
      const slug = /\(slug `([^`]+)`/.exec(prompt)[1];
      const prefix = /requirement ids `([A-Z0-9]+)-<n>`/.exec(prompt)[1];
      const changed = prompt.includes(`**${prefix}-1** [First]`) ? 'v2' : 'v1';
      const md = `# Doc ${slug}\n\nScope.\n\n## First\n\n- **${prefix}-1** Every request must be authenticated.\n  Why: context.\n- **${prefix}-2** Tokens must expire (${changed}).\n\n## Second\n\n- **${prefix}-3** Secrets must not be logged.\n`;
      const bad = await mcp('save_security_document', { slug, markdown: '# T\n\n- **ZZ-1** no section' });
      const r = await mcp('save_security_document', { slug, markdown: md });
      return done(`${bad.content[0].text} ${r.content[0].text}`);
    }
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
    if (prompt.includes('Build the dependency inventory')) {
      const module_id = moduleOf();
      const out = /Your run directory[^`]*`([^`]+)`/.exec(prompt)[1];
      const inputs = fs.readdirSync(`${out}/inputs`);
      const report = `${out}/report.json`;
      fs.writeFileSync(
        report,
        JSON.stringify({
          Results: [
            { Target: 'svc/gradle.lockfile', Vulnerabilities: [
              { VulnerabilityID: 'CVE-1', PkgName: 'com.acme:json', InstalledVersion: '1.0' },
              { VulnerabilityID: 'CVE-2', PkgName: 'com.acme:json', InstalledVersion: '1.0' },
              { VulnerabilityID: 'CVE-3', PkgName: 'org.unused:lib', InstalledVersion: '2.0' },
              { VulnerabilityID: 'CVE-4', PkgName: 'net.mystery:x', InstalledVersion: '3.0' },
            ] },
          ],
        }),
      );
      const add = async (name, version, import_names, ids, extra = {}) =>
        (await mcp('add_vulnerable_package', {
          module_id, report, ecosystem: 'Maven', name, version, import_names, manifest: 'svc/build.gradle',
          vulnerabilities: ids.map((id) => ({ id, severity: 'high', title: `bug ${id}`, fixed_version: '9.9' })), ...extra,
        })).content[0].text;
      const res = [
        await add('com.acme:json', '1.0', ['com.acme.json'], ['CVE-1', 'CVE-2'], { direct: true }),
        await add('org.unused:lib', '2.0', ['org.unused'], ['CVE-3']),
        await add('net.mystery:x', '3.0', [], ['CVE-4']),
        await add('com.acme:json', '1.0', ['com.acme.json'], ['CVE-1', 'CVE-404']),
        await add('com.acme:json', '1.0', ['com.acme.json'], ['CVE-1'], { report: '../outside.json' }),
      ];
      fs.writeFileSync('svc/gradle.lockfile', 'com.acme:json:1.0=runtimeClasspath\n');
      const untracked = await mcp('set_inventory_summary', { module_id, ecosystems: ['maven'], tools: ['x'], dependencies_total: 1, manifests: ['svc/gradle.lockfile'] });
      res.push(`untracked manifest: ${untracked.content[0].text}`);
      if (!prompt.includes('NO_SUMMARY')) {
        await mcp('set_inventory_summary', { module_id, ecosystems: ['maven'], tools: ['fake-gradle', 'fake-trivy'], dependencies_total: 12, manifests: ['svc/build.gradle'] });
      }
      return done(`inputs: ${inputs.join(',')}\n${res.join('\n')}`);
    }
    const hunting = /Hunt for vulnerabilities in module "[^"]*" \(id (\S+)\)/.exec(prompt);
    if (hunting) {
      const module_id = hunting[1];
      const batch = prompt.split('Your batch')[1].split('Steps:')[0];
      const files = [...batch.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
      const sim = JSON.parse((await mcp('find_similar', { module_id, files: [files[0]], cwe: 'CWE-89' })).content[0].text);
      const evidence = [{ file: files[0], line: 1, note: 'query built from input' }];
      await mcp('create_hunt_finding', {
        module_id, check_id: sim.check_id, title: `SQL injection in ${files[0]}`, description: 'request field concatenated into SQL',
        severity: 'high', cwe: 'CWE-89', files: evidence, trace: [{ file: files[0], line: 1, note: 'input' }, { file: files[0], line: 2, note: 'sink' }],
      });
      const outside = await mcp('mark_files_reviewed', { module_id, files: [{ file: 'README.md' }] });
      // The first run of a partial batch leaves its last file unread, so that a retry has something left.
      const read = prompt.includes('HUNT_PARTIAL') && files.length > 1 ? files.slice(0, -1) : files;
      await mcp('mark_files_reviewed', { module_id, files: read.map((file) => ({ file, note: 'checked' })) });
      return done(`outside: ${outside.content[0].text}`);
    }
    if (prompt.includes('Decide whether the vulnerabilities')) {
      const module_id = moduleOf();
      const package_key = /package_key `([^`]+)`/.exec(prompt)[1];
      const vulns = [...prompt.matchAll(/^- `([^`]+)` \[/gm)].map((m) => m[1]);
      const evidence = [{ file: 'svc/Api.java', line: 1, note: 'uses the parser' }];
      const out = [];
      for (const vuln_id of vulns) {
        const v = { module_id, package_key, vuln_id };
        if (vuln_id === 'CVE-1') {
          const early = await mcp('set_sca_verdict', { ...v, status: 'reachable', reason: 'parses request body', evidence });
          const sim = JSON.parse((await mcp('find_similar', { module_id, files: ['svc/Api.java'], cwe: 'CWE-502' })).content[0].text);
          await mcp('create_sca_finding', {
            module_id, package_key, vuln_ids: [vuln_id], check_id: sim.check_id, title: 'Vulnerable JSON parser reachable',
            description: 'request body goes to Parser.parse', severity: 'high', cwe: 'CWE-502', files: evidence,
          });
          out.push(`early: ${early.isError ? 'rejected' : 'accepted'}`);
          out.push((await mcp('set_sca_verdict', { ...v, status: 'reachable', reason: 'parses request body', evidence })).content[0].text);
        } else if (vuln_id === 'CVE-4') {
          out.push((await mcp('set_sca_verdict', { ...v, status: 'needs_human', reason: 'description too vague' })).content[0].text);
        } else {
          const noEvidence = await mcp('set_sca_verdict', { ...v, status: 'not_reachable', reason: 'other API used' });
          out.push(`no evidence: ${noEvidence.isError ? 'rejected' : 'accepted'}`);
          out.push((await mcp('set_sca_verdict', { ...v, status: 'not_reachable', reason: 'only Parser.format is used', evidence })).content[0].text);
        }
      }
      return done(out.join('\n'));
    }
    if (prompt.includes('Check the changes of branch')) {
      const check_id = /Check id: `([^`]+)`/.exec(prompt)[1];
      const items = [...prompt.matchAll(/^- item_id `([^`]+)` — (.*)$/gm)].map((m) => ({ item_id: m[1], text: m[2] }));
      const out = [];
      const set = (item_ids, v) => mcp('set_diff_verdicts', { check_id, verdicts: [{ item_ids, ...v }] });
      const open = items.filter((i) => !(i.text.includes('SKIP_ONCE') && items.length > 1));
      const idor = open.filter((i) => i.text.includes('IDOR')).map((i) => i.item_id);
      if (idor.length) {
        const evidence = [{ file: 'svc/Gone.java', note: 'the branch deletes the owner check' }];
        const outside = await set(idor, { status: 'finding', severity: 'high', reason: 'x', evidence: [{ file: 'lib/Util.java' }] });
        const noSeverity = await set(idor, { status: 'finding', reason: 'x', evidence });
        out.push(`outside=${Boolean(outside.isError)} no_severity=${Boolean(noSeverity.isError)}`);
        await set(idor, { status: 'finding', severity: 'high', reason: 'owner check removed', evidence });
      }
      const rest = open.filter((i) => !idor.includes(i.item_id)).map((i) => i.item_id);
      if (rest.length) {
        const r = JSON.parse((await set([...rest, 'not-mine'], { status: 'n/a', reason: 'not touched by the changes' })).content[0].text);
        out.push(`saved=${r.saved} foreign_rejected=${r.rejected.map((x) => x.item_id).join()}`);
      }
      return done(out.join('\n') || 'checked');
    }
    if (prompt.includes('Check the modules of project')) {
      // Merged sessions list cells as "- requirement_id `<id>` [M1,M2] <key> (<section>): <text>".
      const ids = Object.fromEntries([...prompt.matchAll(/^- (M\d+): "[^"]*", module_id `([^`]+)`/gm)].map((m) => [m[1], m[2]]));
      const rows = [...prompt.matchAll(/^- requirement_id `([^`]+)` \[([^\]]+)\] [^:]+: (.*)$/gm)];
      const entries = [];
      for (const [, id, mods, text] of rows) {
        if (text.includes('SKIP_ONCE') && rows.length > 1) continue;
        for (const m of mods.split(',')) entries.push({ module_id: ids[m], requirement_ids: [id], status: 'pass', reason: 'checked in code', evidence: [{ file: 'svc/Api.java', line: 1 }] });
      }
      const res = JSON.parse((await mcp('set_verdicts', { verdicts: [...entries, { module_id: ids.M1, requirement_ids: ['not-mine'], status: 'n/a', reason: 'x' }] })).content[0].text);
      return done(`saved=${res.saved} rejected=${res.rejected.length}`);
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
    if (prompt.includes('Set up the PoC test environment')) {
      // Saves a start script that fails and checks it; with FIX_IN_SESSION it then fixes and re-checks it itself,
      // otherwise a re-run sees the failure in its prompt and saves the fixed script without checking.
      const base = `http://127.0.0.1:${process.env.TEST_POC_PORT}`;
      const good = `#!/bin/sh\nPORT=${process.env.TEST_POC_PORT} exec node srv.js\n`;
      const bad = '#!/bin/sh\necho local config is missing >&2\nexit 3\n';
      const env = { start: 'sh "$AIEGIS_POC_SCRIPTS/start.sh"', healthcheck: `curl -sf ${base}/`, base_url: base };
      const save = (content) => mcp('set_poc_environment', { ...env, files: [{ name: 'start.sh', content }] });
      const check = async (action, wait_sec) => JSON.parse((await mcp('check_poc_environment', { action, wait_sec })).content[0].text);
      const started = async () => {
        await check('start');
        for (;;) {
          const st = await check('status', 5);
          if (st.state !== 'starting') return st;
        }
      };
      const out = [(await mcp('set_poc_environment', { ...env, files: [{ name: '../escape.sh', content: 'x' }] })).content[0].text];
      if (prompt.includes('local config is missing')) out.push((await save(good)).content[0].text);
      else {
        await save(bad);
        const first = await started();
        out.push(`check1=${first.state} saw=${first.output.includes('local config is missing')}`);
        if (prompt.includes('FIX_IN_SESSION')) {
          await save(good);
          out.push(`after save=${(await check('status')).state}`);
          out.push(`check2=${(await started()).state}`);
        }
      }
      out.push(
        `secret=${process.env.AIEGIS_POC_ALICE_PASSWORD ?? 'absent'}`,
        `shell token=${process.env.TEST_POC_SHELL_TOKEN ?? 'absent'}`,
        `scripts=${process.env.AIEGIS_POC_SCRIPTS}`,
        `add-dir=${arg('--add-dir')}`,
      );
      return done(out.join('\n'));
    }
    if (prompt.includes('Reproduce suspected finding')) {
      // Asks the app's PreToolUse hook (from --settings) about commands, then tests the instance it started.
      const settings = JSON.parse(fs.readFileSync(arg('--settings'), 'utf8'));
      const hook = settings.hooks.PreToolUse.at(-1).hooks[0];
      const ask = async (command) => {
        const out = execFileSync(hook.command, hook.args, { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
        return JSON.parse(out).hookSpecificOutput?.permissionDecision ?? 'none';
      };
      const base = process.env.AIEGIS_POC_BASE_URL;
      const findingId = /finding (\S+) of project/.exec(prompt)[1];
      const body = await (await fetch(`${base}/orders/2`)).text();
      if (prompt.includes('NO_RESULT')) return done('no result');
      const out = [
        `allowed=${settings.sandbox.network.allowedDomains.join(',')}`,
        `hook base=${await ask(`curl -s ${base}/orders/2`)}`,
        `hook other=${await ask('curl -s https://example.com/x')}`,
        `secret=${process.env.AIEGIS_POC_ALICE_PASSWORD === 'pw-alice'}`,
        `shell token=${process.env.TEST_POC_SHELL_TOKEN ?? 'absent'}`,
        `scripts dir=${fs.existsSync(/Directory for your scripts: `([^`]+)\/`/.exec(prompt)[1])}`,
      ];
      const steps = [{ action: `curl -s ${base}/orders/2`, result: body }];
      out.push((await mcp('set_poc_result', { finding_id: findingId, outcome: 'reproduced', summary: 'no steps' })).content[0].text);
      out.push((await mcp('set_poc_result', { finding_id: findingId, outcome: 'reproduced', summary: 'alice reads order 2 of bob', steps })).content[0].text);
      return done(out.join('\n'));
    }
    const fixing = /Check whether the finding (\S+) of project/.exec(prompt);
    if (fixing) {
      const done = (text) => emit({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 7 } });
      if (prompt.includes('FIX_REFUSED')) return done('I cannot help with that.');
      const id = fixing[1];
      const out = [
        `other tool=${(await mcp('set_finding_verification', { finding_id: id, outcome: 'refuted', reason: 'r' }))?.content?.[0]?.text ?? 'no such tool'}`,
        `no evidence=${(await mcp('set_fix_verification', { finding_id: id, outcome: 'closed', reason: 'r' })).content[0].text}`,
        `missing file=${(await mcp('set_fix_verification', { finding_id: id, outcome: 'closed', reason: 'r', evidence: [{ file: 'nope.js' }] })).content[0].text}`,
        `other finding=${(await mcp('set_fix_verification', { finding_id: 'other', outcome: 'undetermined', reason: 'r' })).content[0].text}`,
      ];
      const outcome = prompt.includes('FIX_UNDETERMINED') ? 'undetermined' : 'closed';
      await mcp('set_fix_verification', { finding_id: id, outcome, reason: `prompt:${prompt}\n${out.join('\n')}`, evidence: [{ file: 'deleted.js' }] });
      return done('checked');
    }
    const verifying = /Try to refute the finding (\S+) /.exec(prompt);
    if (verifying) {
      const done = (text) => emit({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 7 } });
      if (prompt.includes('VERIFY_REFUSED')) return done('I cannot help with that.');
      const id = verifying[1];
      const out = [
        `other tool=${(await mcp('list_findings', {}))?.content?.[0]?.text ?? 'no such tool'}`,
        `no evidence=${(await mcp('set_finding_verification', { finding_id: id, outcome: 'refuted', reason: 'r' })).content[0].text}`,
        `missing file=${(await mcp('set_finding_verification', { finding_id: id, outcome: 'refuted', reason: 'r', evidence: [{ file: 'nope.js' }] })).content[0].text}`,
        `other finding=${(await mcp('set_finding_verification', { finding_id: 'other', outcome: 'undetermined', reason: 'r' })).content[0].text}`,
      ];
      await mcp('set_finding_verification', { finding_id: id, outcome: 'refuted', reason: `prompt:${prompt}\ncwd:${process.cwd()}\n${out.join('\n')}`, evidence: [{ file: 'srv.js', line: 1 }] });
      return done('verified');
    }
    const who = JSON.parse((await mcp('whoami', {})).content[0].text);
    const own = who.writable_entities[0];
    await mcp('submit_result', { entity_type: own.type, entity_id: own.id, summary: `cwd=${process.cwd()}` });
    const denied = await mcp('submit_result', { entity_type: 'task', entity_id: 'not-mine', summary: 'x' });
    emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: denied.content[0].text }], usage: { input_tokens: 5, output_tokens: 7 } } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 7 } });
  });
}
