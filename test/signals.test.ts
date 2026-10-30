import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db';
import { NORMALIZERS, normalizeGitleaks, normalizeSemgrep, normalizeTrivy, repoPath, semgrepRulePrefixes, type NormalizeContext } from '../src/main/scanners/normalize';
import { buildInvocations } from '../src/main/scanners/run';
import {
  covers,
  globTargets,
  groupSameSecret,
  matchesRequirement,
  minimalTargets,
  suppressionApplies,
  suppressionMatches,
  suppressionRelevant,
  suppressionState,
} from '../src/main/signals';
import { ProjectStore } from '../src/main/store';
import type { Suppression } from '../src/shared/types';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'scanners', name), 'utf8');
const ctx = (target: string, existing: string[] = []): NormalizeContext => ({ root: '/wt', target, exists: (p) => existing.includes(p) });

describe('normalizers (fixture outputs of the real tools)', () => {
  it('semgrep: rule, severity, CWE, cwd-relative paths; fingerprints stable without a login', () => {
    const rows = normalizeSemgrep(fixture('semgrep.json'), ctx('.'));
    expect(rows.map((r) => [r.kind, r.ruleId.split('.').pop(), r.severity, r.file, r.line, r.cwe])).toEqual([
      ['secret', 'detected-github-token', 'high', 'app/config.properties', 1, ['CWE-798']],
      ['sast', 'jdbc-sqli', 'medium', 'app/src/Api.java', 6, ['CWE-89']],
      ['sast', 'jdbc-sqli', 'high', 'app/src/Api.java', 9, ['CWE-89']],
    ]);
    // "requires login": no snippet, line-based fingerprint; a known snippet is kept (not for secrets).
    expect(rows[0].snippet).toBeNull();
    expect(rows[1].snippet).toBeNull();
    expect(rows[2].snippet).toContain('executeQuery');
    expect(rows[1].tags).toEqual(expect.arrayContaining(['A03:2021 - Injection', 'category:security', 'confidence:LOW']));
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(3);
    expect(normalizeSemgrep(fixture('semgrep.json'), ctx('.')).map((r) => r.fingerprint)).toEqual(rows.map((r) => r.fingerprint));
    // A snippet-based fingerprint survives a line shift.
    const shifted = fixture('semgrep.json').replace('"line": 9', '"line": 12');
    expect(normalizeSemgrep(shifted, ctx('.'))[2].fingerprint).toBe(rows[2].fingerprint);
    expect(normalizeSemgrep('', ctx('.'))).toEqual([]);
    expect(() => normalizeSemgrep('not json', ctx('.'))).toThrow(/is not JSON/);
  });

  it('semgrep: rule ids do not depend on where an absolute rule file lives; parse errors are warnings', () => {
    const isDir = (p: string) => p.endsWith('/rules');
    expect(
      semgrepRulePrefixes(['scan', '--config', 'p/default', '--config', '/var/folders/_5/T/aiegis-tmp-x/rule.yaml', '-c', '/opt/.team/rules', '--config=/wt/abc123/.aiegis/r.yml', '--config', '.aiegis/rules.yaml'], isDir),
    ).toEqual(['var.folders._5.T.aiegis-tmp-x', 'wt.abc123.aiegis', 'opt.team.rules']);

    const base = normalizeSemgrep(fixture('semgrep.json'), ctx('.'));
    const relocated = (dir: string) => {
      const prefix = dir.split('/').filter(Boolean).map((s) => s.replace(/^\.+/, '')).join('.');
      const doc = JSON.parse(fixture('semgrep.json'));
      for (const r of doc.results) r.check_id = `${prefix}.${r.check_id}`;
      return normalizeSemgrep(JSON.stringify(doc), { ...ctx('.'), args: ['scan', '--config', `${dir}/custom.yaml`, '.'] });
    };
    for (const dir of ['/tmp/aiegis-a1', '/Users/x/Library/aiegis/wt/0123abcd/.aiegis']) {
      const rows = relocated(dir);
      expect(rows.map((r) => r.ruleId)).toEqual(base.map((r) => r.ruleId));
      expect(rows.map((r) => r.fingerprint)).toEqual(base.map((r) => r.fingerprint));
    }

    const warnings: string[] = [];
    const doc = JSON.parse(fixture('semgrep.json'));
    const err = { code: 3, level: 'warn', type: ['PartialParsing', []], message: 'Syntax error at line /wt/mod/post-install.java:10:\n `%` was unexpected', path: 'mod/post-install.java' };
    doc.errors = [err, err, { code: 2, level: 'warn', type: 'Timeout', message: '', path: 'mod/Big.java' }];
    expect(normalizeSemgrep(JSON.stringify(doc), { ...ctx('.'), warn: (w) => warnings.push(w) })).toHaveLength(3);
    expect(warnings).toEqual(['PartialParsing: Syntax error at line mod/post-install.java:10: `%` was unexpected', 'Timeout: mod/Big.java']);
  });

  it('gitleaks: secrets are redacted and never stored, fingerprint does not depend on the line', () => {
    const text = fixture('gitleaks.json');
    const secret = JSON.parse(text)[0].Secret as string;
    const [r] = normalizeGitleaks(text, ctx('app', ['app/config.properties']));
    expect(r).toMatchObject({ kind: 'secret', ruleId: 'github-pat', severity: 'high', file: 'app/config.properties', line: 1, cwe: ['CWE-798'] });
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.snippet).toMatch(/^github\.token=ghp_…\[hidden\]$/);
    const moved = text.replace('"StartLine": 1', '"StartLine": 7');
    expect(normalizeGitleaks(moved, ctx('app'))[0].fingerprint).toBe(r.fingerprint);
  });

  it('trivy: target-relative paths, failed misconfigs only, secrets masked, CVE data kept for SCA', () => {
    const rows = normalizeTrivy(fixture('trivy.json'), ctx('app'));
    const by = (k: string) => rows.filter((r) => r.kind === k);
    expect(by('misconfig').map((r) => [r.ruleId, r.file, r.line, r.severity])).toEqual([
      ['DS-0002', 'app/Dockerfile', null, 'high'],
      ['DS-0017', 'app/Dockerfile', 2, 'high'],
    ]);
    expect(by('secret')).toHaveLength(1);
    expect(by('secret')[0]).toMatchObject({ ruleId: 'github-pat', file: 'app/config.properties', line: 1, severity: 'critical' });
    expect(by('secret')[0].snippet).not.toMatch(/ghp_/);
    const vulns = by('vuln');
    expect(vulns.length).toBe(2);
    expect(vulns[0]).toMatchObject({ ruleId: 'CVE-2020-8203', file: 'app/package-lock.json', severity: 'high', cwe: ['CWE-770', 'CWE-1321'] });
    expect(vulns[0].data).toMatchObject({ package: 'lodash', version: '4.17.15', vulnerability_id: 'CVE-2020-8203', fixed_version: '4.17.19', purl: 'pkg:npm/lodash@4.17.15', pkg_type: 'npm' });
    expect(Object.keys(NORMALIZERS).sort()).toEqual(['gitleaks', 'semgrep', 'trivy']);
  });

  it('repoPath resolves paths reported relative to the cwd or to the target', () => {
    expect(repoPath('src/A.java', ctx('mod', ['mod/src/A.java']))).toBe('mod/src/A.java');
    expect(repoPath('mod/src/A.java', ctx('mod', ['mod/src/A.java']))).toBe('mod/src/A.java');
    expect(repoPath('./x.txt', ctx('.'))).toBe('x.txt');
    expect(repoPath('/wt/mod/B.java', ctx('mod'))).toBe('mod/B.java');
    expect(repoPath('mod/gone.java', ctx('mod'))).toBe('mod/gone.java');
  });
});

describe('scanner invocations and targets', () => {
  it('expands {{targets}}, {{target}} and {{report}}; unknown placeholders are errors', () => {
    expect(buildInvocations('s', ['scan', '--json', '{{targets}}'], ['a', 'b'], () => 'r')).toEqual([{ args: ['scan', '--json', 'a', 'b'], target: '.', report: null }]);
    expect(buildInvocations('g', ['dir', '--report-path', '{{report}}', '{{target}}'], ['a', 'b'], (i) => `/tmp/r${i}`)).toEqual([
      { args: ['dir', '--report-path', '/tmp/r0', 'a'], target: 'a', report: '/tmp/r0' },
      { args: ['dir', '--report-path', '/tmp/r1', 'b'], target: 'b', report: '/tmp/r1' },
    ]);
    expect(() => buildInvocations('s', ['{{paths}}'], ['a'], () => 'r')).toThrow(/unknown placeholder \{\{paths\}\}/);
    expect(() => buildInvocations('s', ['scan'], ['a'], () => 'r')).toThrow(/exactly one/);
    expect(() => buildInvocations('s', ['--x={{targets}}'], ['a'], () => 'r')).toThrow(/separate argument/);
  });

  it('module globs -> scan targets; coverage of targets', () => {
    expect(globTargets(['auth/**', '!auth/src/test/**'])).toEqual(['auth']);
    expect(globTargets(['svc/src/*.java', 'svc/**', 'lib/a.txt'])).toEqual(['lib/a.txt', 'svc']);
    expect(globTargets(['**/*.java'])).toEqual(['.']);
    expect(minimalTargets(['b', 'a/x', 'a', 'b/'])).toEqual(['a', 'b']);
    expect(covers(['.'], ['a', 'b'])).toBe(true);
    expect(covers(['a', 'b'], ['a/x', 'b'])).toBe(true);
    expect(covers(['a'], ['a', 'b'])).toBe(false);
    expect(covers(['ab'], ['a'])).toBe(false);
  });
});

const sup = (over: Partial<Suppression>): Suppression => ({
  id: 's1',
  scope: 'finding',
  scanner: 'semgrep',
  ruleId: 'r1',
  fingerprint: 'fp1',
  globs: [],
  file: 'svc/A.java',
  line: 3,
  requirementId: null,
  moduleId: null,
  reason: 'test code',
  author: 'me',
  commitSha: 'c1',
  touchedFiles: ['svc/A.java'],
  moduleGlobs: [],
  expiresAt: null,
  replaces: null,
  createdAt: '2026-01-01',
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
  ...over,
});

describe('suppressions', () => {
  const f = { scanner: 'semgrep', ruleId: 'r1', fingerprint: 'fp1', file: 'svc/test/A.java' };
  it('match by scope: finding, rule × glob, requirement × module', () => {
    expect(suppressionMatches(sup({}), f)).toBe(true);
    expect(suppressionMatches(sup({ fingerprint: 'other' }), f)).toBe(false);
    expect(suppressionMatches(sup({ scanner: 'gitleaks' }), f)).toBe(false);
    const rg = sup({ scope: 'rule_glob', fingerprint: null, globs: ['svc/test/**'] });
    expect(suppressionMatches(rg, f)).toBe(true);
    expect(suppressionMatches(rg, { ...f, file: 'svc/main/A.java' })).toBe(false);
    expect(suppressionMatches({ ...rg, ruleId: 'r2' }, f)).toBe(false);
    const rm = sup({ scope: 'requirement_module', scanner: null, ruleId: null, fingerprint: null, moduleId: 'm1', requirementId: 'q1' });
    expect(suppressionMatches(rm, f)).toBe(false);
    expect(suppressionMatches(rm, f, { moduleId: 'm1', requirementId: 'q1' })).toBe(true);
    expect(suppressionMatches(rm, f, { moduleId: 'm1', requirementId: 'q2' })).toBe(false);
  });

  it('state: revoked > expired > stale; stale applies only when configured', () => {
    expect(suppressionState(sup({}), true, '2026-05-01')).toBe('active');
    expect(suppressionState(sup({}), false, '2026-05-01')).toBe('stale');
    expect(suppressionState(sup({ expiresAt: '2026-04-30' }), true, '2026-05-01')).toBe('expired');
    expect(suppressionState(sup({ expiresAt: '2026-05-01' }), true, '2026-05-01')).toBe('active');
    expect(suppressionState(sup({ revokedAt: 'x', expiresAt: '2000-01-01' }), false, '2026-05-01')).toBe('revoked');
    expect(suppressionApplies('stale', false)).toBe(false);
    expect(suppressionApplies('stale', true)).toBe(true);
    expect(suppressionApplies('expired', true)).toBe(false);
  });

  it('few-shot relevance to a module and its cells', () => {
    const mod = { id: 'm1', globs: ['svc/**'] };
    expect(suppressionRelevant(sup({}), mod, [])).toBe(true);
    expect(suppressionRelevant(sup({ file: 'lib/A.java' }), mod, [])).toBe(false);
    expect(suppressionRelevant(sup({ scope: 'rule_glob', globs: ['**/test/**'], touchedFiles: ['svc/test/A.java'] }), mod, [])).toBe(true);
    expect(suppressionRelevant(sup({ scope: 'rule_glob', globs: ['lib/**'], touchedFiles: [] }), mod, [])).toBe(false);
    const rm = sup({ scope: 'requirement_module', moduleId: 'm1', requirementId: 'q1' });
    expect(suppressionRelevant(rm, mod, ['q1'])).toBe(true);
    expect(suppressionRelevant(rm, mod, ['q2'])).toBe(false);
  });

  it('requirement relevance mapping: kinds, CWE, rule regexps', () => {
    const row = { kind: 'sast' as const, cwe: ['CWE-89'], ruleId: 'java.sqli.jdbc' };
    expect(matchesRequirement(row, { cwe: ['89'] })).toBe(true);
    expect(matchesRequirement(row, { kinds: ['secret'] })).toBe(false);
    expect(matchesRequirement(row, { rules: ['sqli'] })).toBe(true);
    expect(matchesRequirement(row, { rules: ['(bad'] })).toBe(false);
  });
});

describe('signal store', () => {
  it('scan results are frozen once the scan is finalized; suppressions are revoked once', () => {
    const s = new ProjectStore('p', openDb(':memory:')).signals;
    const scan = s.startScan({ scanner: 'semgrep', format: 'semgrep', commitSha: 'c1', targets: ['svc'], jobId: null });
    const rows = normalizeSemgrep(fixture('semgrep.json'), ctx('.'));
    s.addFindings(scan.id, rows);
    s.finishScan(scan.id, 'complete', { toolVersion: '1.0', commands: [['semgrep', 'scan']], error: null });
    expect(s.getScan(scan.id)).toMatchObject({ status: 'complete', findingCount: 3, toolVersion: '1.0', commands: [['semgrep', 'scan']] });
    expect(() => s.addFindings(scan.id, rows)).toThrow(/immutable/);
    expect(() => s.finishScan(scan.id, 'failed', { toolVersion: null, commands: [], error: 'x' })).not.toThrow();
    expect(s.getScan(scan.id)!.status).toBe('complete');
    expect(() => s.db.prepare('DELETE FROM raw_findings').run()).toThrow(/append-only/);
    expect(s.completeScans('c1').map((x) => x.id)).toEqual([scan.id]);
    expect(s.scanFindings(scan.id)[0]).toMatchObject({ scanner: 'semgrep', kind: 'secret' });

    const running = s.startScan({ scanner: 'trivy', format: 'trivy', commitSha: 'c1', targets: ['.'], jobId: null });
    expect(s.recoverScans()).toBe(1);
    expect(s.getScan(running.id)!.status).toBe('failed');

    const { id: _id, createdAt: _c, revokedAt: _r, revokedBy: _b, revokeReason: _x, ...rec } = sup({});
    const x = s.addSuppression(rec);
    expect(() => s.db.prepare('UPDATE suppressions SET reason = ? WHERE id = ?').run('other', x.id)).toThrow(/append-only/);
    expect(s.revokeSuppression(x.id, 'me', 'wrong').revokeReason).toBe('wrong');
    expect(() => s.revokeSuppression(x.id, 'me', 'again')).toThrow(/already revoked/);
    expect(() => s.db.prepare('UPDATE suppressions SET revoke_reason = ? WHERE id = ?').run('z', x.id)).toThrow(/append-only/);
    expect(() => s.db.prepare('DELETE FROM suppressions').run()).toThrow(/append-only/);
  });
});

describe('groupSameSecret', () => {
  it('merges secrets of several scanners on one line; other signals stay apart', () => {
    const r = (id: string, kind: 'secret' | 'sast', file: string, line: number | null) => ({ id, kind, file, line });
    const groups = groupSameSecret([r('g', 'secret', 'a.env', 3), r('s', 'sast', 'a.env', 3), r('t', 'secret', 'a.env', 3), r('u', 'secret', 'a.env', null), r('v', 'secret', 'a.env', null), r('w', 'secret', 'b.env', 3)]);
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([['g', 't'], ['s'], ['u'], ['v'], ['w']]);
  });
});
