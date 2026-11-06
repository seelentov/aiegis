#!/usr/bin/env node
// Stand-in for a scanner with SARIF output: one result by absolute file:// path, one outside the repository.
if (process.argv[2] === '--version') {
  console.log('fake-sarif 2.0.0');
  process.exit(0);
}
const at = (uri) => ({ ruleId: 'fake/rule', message: { text: 'Found' }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 1 } } }] });
const body = process.argv.includes('--broken')
  ? { version: '2.1.0', runs: [] }
  : { version: '2.1.0', runs: [{ tool: { driver: { name: 'Fake SARIF' } }, results: [at(`file://${process.cwd()}/${process.argv[2]}/Api.java`), at('file:///etc/passwd')] }] };
console.log(JSON.stringify(body));
