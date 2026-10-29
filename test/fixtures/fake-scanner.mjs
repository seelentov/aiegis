#!/usr/bin/env node
// Stand-in for a scanner in core tests: Semgrep-like JSON for every line containing "getParameter" in the targets.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('fake-scanner 1.2.3');
  process.exit(0);
}
const targets = args.filter((a) => !a.startsWith('-') && a !== 'scan');
const results = [];
const errors = [];
let slow = false;
const walk = (p) => {
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).isDirectory()) {
    for (const e of fs.readdirSync(p).sort()) if (e !== '.git') walk(path.join(p, e));
    return;
  }
  const text = fs.readFileSync(p, 'utf8');
  if (text.includes('SLOW_SCAN')) slow = true;
  // A file containing BROKEN_SYNTAX is reported the way semgrep reports files it cannot parse (exit code stays 0).
  if (text.includes('BROKEN_SYNTAX')) {
    const rel = path.relative(process.cwd(), p);
    errors.push({ code: 3, level: 'warn', type: ['PartialParsing', []], message: `Syntax error at line ${rel}:1:\n \`%\` was unexpected`, path: rel });
  }
  text
    .split('\n')
    .forEach((line, i) => {
      if (!line.includes('getParameter')) return;
      results.push({
        check_id: 'fake.tainted-input',
        path: path.relative(process.cwd(), p),
        start: { line: i + 1, col: 1 },
        end: { line: i + 1, col: line.length + 1 },
        extra: { message: 'Tainted input reaches a sink', severity: 'WARNING', metadata: { cwe: ['CWE-20: Improper Input Validation'] }, lines: line.trim() },
      });
    });
};
targets.forEach(walk);
// A file containing SLOW_SCAN keeps the scan running for a while (queue ordering tests).
setTimeout(() => process.stdout.write(JSON.stringify({ version: 'fake', results, errors })), slow ? 1500 : 0);
