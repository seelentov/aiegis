import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db';
import { fileInside, findImports, importPattern, missingInReport, packageKey, parseScaItemId, scaItemId, scaTouched } from '../src/main/sca';
import { ProjectStore } from '../src/main/store';
import { tmpDir, write } from './helpers';

describe('SCA helpers', () => {
  it('package keys and item ids round-trip, scoped npm names included', () => {
    expect(packageKey(' Maven ', 'com.acme:json', '1.0 ')).toBe('maven:com.acme:json@1.0');
    const ref = { moduleId: 'm1', packageKey: 'npm:@scope/pkg@1.2.3', vulnId: 'GHSA-xxxx' };
    expect(parseScaItemId(scaItemId(ref))).toEqual(ref);
    expect(() => parseScaItemId('m1/pkg')).toThrow();
  });

  it('import pattern is language-agnostic and respects identifier boundaries', () => {
    const re = importPattern(['com.acme.json', 'lodash'])!;
    expect(re.test('import com.acme.json.Parser;')).toBe(true);
    expect(re.test('import static com.acme.json.*;')).toBe(true);
    expect(re.test("const _ = require('lodash/fp')")).toBe(true);
    expect(re.test('from lodash import x')).toBe(true);
    expect(re.test('import com.acme.jsonx.Parser;')).toBe(false);
    expect(re.test('import xcom.acme.json.Parser;')).toBe(false);
    expect(re.test('my_lodash = 1')).toBe(false);
    expect(importPattern([' ', ''])).toBeNull();
  });

  it('prefilter finds referring files, skips binary and oversized ones', () => {
    const root = tmpDir();
    write(path.join(root, 'a.java'), 'import com.acme.json.Parser;');
    write(path.join(root, 'b.java'), 'class B {}');
    write(path.join(root, 'big.java'), `${'x'.repeat(2000)} com.acme.json`);
    write(path.join(root, 'bin.dat'), 'com.acme.json\0\0');
    expect(findImports(root, ['a.java', 'b.java', 'big.java', 'bin.dat', 'gone.java'], ['com.acme.json'], 1000)).toEqual(['a.java']);
    expect(findImports(root, ['a.java'], [], 1000)).toEqual([]);
  });

  it('report check: package and every vulnerability (or an alias) must be in the report', () => {
    const report = JSON.stringify({ PkgName: 'com.acme:json', VulnerabilityID: 'CVE-1', Aliases: ['GHSA-1'] });
    expect(missingInReport(report, { name: 'com.acme:json' }, [{ id: 'CVE-1' }, { id: 'OSV-9', aliases: ['GHSA-1'] }])).toEqual({ package: false, vulns: [] });
    expect(missingInReport(report, { name: 'com.acme:json' }, [{ id: 'CVE-2' }])).toEqual({ package: false, vulns: ['CVE-2'] });
    expect(missingInReport(report, { name: 'org.other:lib' }, []).package).toBe(true);
    // Reports may name a Maven package by its artifact only.
    expect(missingInReport('jackson-databind 2.1', { name: 'com.fasterxml.jackson.core:jackson-databind' }, []).package).toBe(false);
  });

  it('report paths stay inside the run checkout', () => {
    const root = tmpDir();
    write(path.join(root, '.aiegis-sca', 'r.json'), '{}');
    expect(fileInside(root, '.aiegis-sca/r.json')).toBe(path.join(root, '.aiegis-sca', 'r.json'));
    expect(fileInside(root, '../r.json')).toBeNull();
    expect(fileInside(root, '/etc/passwd')).toBeNull();
    expect(fileInside(root, '.aiegis-sca')).toBeNull();
  });

  it('touched files of a verdict: evidence, manifest, finding files', () => {
    expect(scaTouched([{ file: 'b' }], { manifest: 'build.gradle' }, [{ files: [{ file: 'a' }, { file: 'b' }] }])).toEqual(['a', 'b', 'build.gradle']);
  });
});

describe('SCA store', () => {
  const store = new ProjectStore('p', openDb(':memory:'));
  const run = store.startRun({ kind: 'background', role: 'sca-inventory', author: 'ai', sessionId: 's', cwd: '/', commitSha: 'c1', configSnapshot: {} });
  const mod = { id: 'm1', globs: ['svc/**'] };
  const pkg = (vulns: string[]) => ({
    ecosystem: 'maven',
    name: 'com.acme:json',
    version: '1.0',
    direct: true,
    importNames: ['com.acme.json'],
    manifest: 'build.gradle',
    purl: null,
    vulns: vulns.map((id) => ({ id, aliases: [], severity: 'high' as const, title: null, fixedVersion: null })),
  });

  it('inventory is writable while building, replaced packages drop old vulnerabilities, frozen after finalization', () => {
    const inv = store.sca.ensureInventory(run, mod);
    expect(store.sca.ensureInventory(run, mod).id).toBe(inv.id);
    const rep = store.sca.addReport(inv.id, { path: 'r.json', sha256: 'h', size: 1 });
    expect(store.sca.addReport(inv.id, { path: 'r.json', sha256: 'h', size: 1 }).id).toBe(rep.id);
    store.sca.upsertPackage(inv.id, pkg(['CVE-1', 'CVE-2']), () => rep.id);
    const p = store.sca.upsertPackage(inv.id, pkg(['CVE-3']), () => rep.id);
    expect(p.vulns.map((v) => v.vulnId)).toEqual(['CVE-3']);
    expect(store.sca.getInventory(inv.id)).toMatchObject({ packageCount: 1, vulnCount: 1 });

    store.sca.finalizeInventories(run.id, true);
    expect(store.sca.getInventory(inv.id)!.status).toBe('failed');
    expect(store.sca.latestInventory('m1')).toBeUndefined();
    expect(() => store.sca.upsertPackage(inv.id, pkg(['CVE-4']), () => rep.id)).toThrow(/immutable/);
    expect(() => store.sca.removePackage(inv.id, p.key)).toThrow(/immutable/);
    expect(() => store.db.prepare(`UPDATE sca_inventories SET status = 'complete' WHERE id = ?`).run(inv.id)).toThrow(/immutable/);
  });

  it('a summary makes the inventory complete; a resumed session starts from its parent inventory', () => {
    const r2 = store.startRun({ kind: 'background', role: 'sca-inventory', author: 'ai', sessionId: 's2', cwd: '/', commitSha: 'c2', configSnapshot: {} });
    const inv = store.sca.ensureInventory(r2, mod);
    const rep = store.sca.addReport(inv.id, { path: 'r.json', sha256: 'h', size: 1 });
    store.sca.upsertPackage(inv.id, pkg(['CVE-1']), () => rep.id);
    store.sca.setSummary(inv.id, { ecosystems: ['maven'], tools: ['t'], dependenciesTotal: 3, manifests: ['build.gradle'], notes: null });
    store.sca.finalizeInventories(r2.id, true);
    expect(store.sca.latestInventory('m1')?.id).toBe(inv.id);

    const r3 = store.startRun({ parentRunId: r2.id, kind: 'interactive', role: 'sca-inventory', author: 'human', sessionId: 's2', cwd: '/', commitSha: 'c2', configSnapshot: {} });
    const copy = store.sca.ensureInventory(r3, mod);
    expect(copy).toMatchObject({ status: 'building', packageCount: 1, vulnCount: 1, summary: { dependenciesTotal: 3 } });
    expect(store.sca.listReports(copy.id)).toHaveLength(1);
    expect(store.sca.listPackages(copy.id)[0].vulns[0].reportId).toBe(store.sca.listReports(copy.id)[0].id);
  });

  it('verdicts are append-only; the latest one is the item status', () => {
    const ref = { moduleId: 'm1', packageKey: 'maven:com.acme:json@1.0', vulnId: 'CVE-1' };
    const base = { ...ref, reason: 'r', evidence: [], commitSha: 'c', touchedFiles: [], moduleGlobs: [] };
    store.sca.addVerdict({ ...base, status: 'not_reachable' }, { author: 'auto', runId: null });
    const v2 = store.sca.addVerdict({ ...base, status: 'reachable' }, { author: 'human', runId: null });
    expect(store.sca.latestVerdicts().get(scaItemId(ref))?.id).toBe(v2.id);
    expect(store.sca.verdictHistory(ref).map((v) => v.status)).toEqual(['reachable', 'not_reachable']);
    expect(() => store.db.prepare('DELETE FROM sca_verdicts').run()).toThrow(/append-only/);
    expect(() => store.db.prepare(`UPDATE sca_verdicts SET status = 'x'`).run()).toThrow(/append-only/);
  });

  it('inputs are removed once and never deleted', () => {
    const i = store.sca.addInput({ moduleId: null, filename: 'a.lock', sha256: 'h', note: '', author: 'me' });
    expect(store.sca.inputsFor('any').map((x) => x.id)).toEqual([i.id]);
    store.sca.removeInput(i.id, 'me');
    expect(() => store.db.prepare('UPDATE sca_inputs SET removed_at = NULL').run()).toThrow(/append-only/);
    expect(() => store.db.prepare('DELETE FROM sca_inputs').run()).toThrow(/append-only/);
    expect(store.sca.inputsFor('any')).toEqual([]);
  });

  it('findings link to SCA items without counting as matrix cells', () => {
    const ref = { moduleId: 'm1', packageKey: 'maven:com.acme:json@1.0', vulnId: 'CVE-1' };
    const by = { author: 'ai:sca', runId: null };
    const f = store.audit.createFinding({ title: 't', description: 'd', severity: 'high', cwe: null, moduleId: 'm1', entryPoint: null, files: [], recommendation: null }, [], by, [ref]);
    expect(f.scaItems).toEqual([ref]);
    expect(f.cells).toEqual([]);
    expect(store.audit.findingsOfScaItem(ref).map((x) => x.id)).toEqual([f.id]);
    expect(store.audit.findingsOfCell({ moduleId: 'm1', requirementId: 'r' })).toEqual([]);
    expect(store.audit.linkScaFinding(f.id, ref, by).scaItems).toHaveLength(1);
    expect(store.audit.scaFindingCounts().get(scaItemId(ref))).toBe(1);
    expect(store.audit.findingCounts().size).toBe(0);
  });
});
