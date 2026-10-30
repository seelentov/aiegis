import { describe, expect, it } from 'vitest';
import { openDb } from '../src/main/db';
import {
  affectingChanges,
  cellId,
  matchesGlobs,
  parseCellId,
  planBatches,
  quoteFound,
  rankSimilar,
  reqHash,
} from '../src/main/matrix';
import { ProjectStore } from '../src/main/store';
import type { FindingInput } from '../src/shared/types';

const human = { author: 'human', runId: null };
const ai = { author: 'ai:requirements', runId: 'r1' };

function store() {
  return new ProjectStore('p', openDb(':memory:')).audit;
}

/** Document with an approved version of `items` (key -> text). */
function approvedDoc(a: ReturnType<typeof store>, items: Record<string, string>, documentId?: string) {
  const doc = documentId ?? a.createDocument('Guide');
  const v = a.addVersion(doc, { filename: 'g.md', format: 'md', sha256: Math.random().toString() });
  for (const [key, text] of Object.entries(items)) a.upsertItem(v.id, { key, text, section: 'S', quote: text }, ai);
  a.setVersionStatus(v.id, 'review');
  a.reviewItems(v.id, a.listItems(v.id).map((i) => i.id), 'accepted');
  a.approveVersion(v.id, 'human');
  return { doc, version: a.getVersion(v.id)! };
}

const finding = (over: Partial<FindingInput> = {}): FindingInput => ({
  title: 'IDOR',
  description: 'd',
  severity: 'high',
  cwe: 'CWE-639',
  moduleId: 'm1',
  entryPoint: 'http GET /a',
  files: [{ file: 'svc/A.java', line: 3 }],
  recommendation: null,
  ...over,
});

describe('documents and requirements', () => {
  it('review is mandatory before approval; approved versions are frozen', () => {
    const a = store();
    const doc = a.createDocument('Guide');
    const v = a.addVersion(doc, { filename: 'g.md', format: 'md', sha256: 'x' });
    expect(v).toMatchObject({ n: 1, status: 'extracting' });
    a.upsertItem(v.id, { key: 'A-1', text: 'Check authz', section: 'Access', quote: 'Check authz' }, ai);
    const gen = a.upsertItem(v.id, { text: 'No secrets in code', section: 'Secrets', quote: 'q' }, ai);
    expect(gen.key).toBe('R-001');
    expect(a.upsertItem(v.id, { text: 'Validate input', section: 'Input', quote: 'q' }, ai).key).toBe('R-002');
    expect(() => a.approveVersion(v.id, 'human')).toThrow(/in review/);
    a.setVersionStatus(v.id, 'review');
    expect(() => a.approveVersion(v.id, 'human')).toThrow(/items not reviewed: 3/);
    const items = a.listItems(v.id);
    a.reviewItems(v.id, [items[0].id, items[1].id], 'accepted');
    a.reviewItems(v.id, [items[2].id], 'rejected');
    a.approveVersion(v.id, 'human');
    expect(a.getVersion(v.id)).toMatchObject({ status: 'approved', approvedBy: 'human' });
    expect(() => a.upsertItem(v.id, { key: 'A-2', text: 't', section: '', quote: 'q' }, human)).toThrow(/immutable/);
    expect(() => a.setVersionStatus(v.id, 'review')).toThrow(/immutable/);
    expect(a.currentItems([doc]).map((i) => i.key)).toEqual(['A-1', 'R-001']);
    expect(a.listDocuments()[0].current?.id).toBe(v.id);
  });

  it('re-import: diff against the previous approved version keeps requirement identity by key', () => {
    const a = store();
    const { doc, version: v1 } = approvedDoc(a, { 'A-1': 'Check authz', 'A-2': 'No IDOR', 'A-3': 'Old rule' });
    const req1 = a.listItems(v1.id).find((i) => i.key === 'A-1')!.requirementId;
    const v2 = a.addVersion(doc, { filename: 'g2.md', format: 'md', sha256: 'y' });
    expect(v2.n).toBe(2);
    a.upsertItem(v2.id, { key: 'A-1', text: '  Check   authz ', section: 'S', quote: 'q' }, ai);
    a.upsertItem(v2.id, { key: 'A-2', text: 'No IDOR on any object', section: 'S', quote: 'q' }, ai);
    a.upsertItem(v2.id, { key: 'A-4', text: 'New rule', section: 'S', quote: 'q' }, ai);
    const diff = a.versionDiff(a.getVersion(v2.id)!);
    expect(diff.baseline?.id).toBe(v1.id);
    expect(diff.items.map((i) => [i.key, i.change])).toEqual([
      ['A-1', 'same'],
      ['A-2', 'changed'],
      ['A-4', 'added'],
    ]);
    expect(diff.removed.map((i) => i.key)).toEqual(['A-3']);
    expect(a.listItems(v2.id)[0].requirementId).toBe(req1);
    // Until v2 is approved, v1 stays current.
    expect(a.currentItem(req1)?.versionId).toBe(v1.id);
    a.setVersionStatus(v2.id, 'review');
    a.reviewItems(v2.id, a.listItems(v2.id).map((i) => i.id), 'accepted');
    a.approveVersion(v2.id, 'human');
    expect(a.currentItem(req1)?.versionId).toBe(v2.id);
    const retired = a.listItems(v1.id).find((i) => i.key === 'A-3')!.requirementId;
    expect(a.currentItem(retired)).toBeUndefined();
    expect(a.latestItem(retired)?.text).toBe('Old rule');
    expect(a.requirementDocument(retired)).toBe(doc);
  });
});

describe('verdicts, triage and findings', () => {
  it('verdicts and triage are append-only; the latest one is the cell state', () => {
    const a = store();
    const { version } = approvedDoc(a, { 'A-1': 'Check authz' });
    const item = a.listItems(version.id)[0];
    const c = { moduleId: 'm1', requirementId: item.requirementId };
    const base = { ...c, itemId: item.id, reqHash: reqHash(item.text), evidence: [], commitSha: 'c1', touchedFiles: [], moduleGlobs: ['svc/**'] };
    a.addTriage({ ...c, reqHash: reqHash(item.text), applicable: true, reason: 'has HTTP' }, { author: 'ai:matrix-triage', runId: 't1' });
    const v1 = a.addVerdict({ ...base, status: 'needs_human', reason: 'unclear' }, { author: 'ai:matrix', runId: 'r1' });
    const v2 = a.addVerdict({ ...base, status: 'pass', reason: 'ok', evidence: [{ file: 'svc/A.java', line: 1 }] }, human);
    expect(a.latestVerdicts().get(cellId(c))?.id).toBe(v2.id);
    expect(a.verdictHistory(c).map((v) => v.author)).toEqual(['human', 'ai:matrix']);
    expect(a.verdictsOfRuns(['r1']).map((v) => v.id)).toEqual([v1.id]);
    expect(a.latestTriage().get(cellId(c))?.applicable).toBe(true);
    expect(a.triageOfRuns(['t1'])).toHaveLength(1);
    expect(() => a.db.prepare(`UPDATE verdicts SET status = 'finding'`).run()).toThrow(/append-only/);
    expect(() => a.db.prepare('DELETE FROM verdicts').run()).toThrow(/append-only/);
    expect(() => a.db.prepare('DELETE FROM triage').run()).toThrow(/append-only/);
  });

  it('findings: M:N cells, lifecycle, manual merge, events are append-only', () => {
    const a = store();
    const c1 = { moduleId: 'm1', requirementId: 'r1' };
    const c2 = { moduleId: 'm1', requirementId: 'r2' };
    const f1 = a.createFinding(finding(), [c1], { author: 'ai:matrix', runId: 'run1' });
    expect(f1).toMatchObject({ status: 'suspected', cells: [c1], mergedInto: null });
    a.linkFinding(f1.id, c2, { author: 'ai:matrix', runId: 'run2' });
    a.linkFinding(f1.id, c2, { author: 'ai:matrix', runId: 'run2' });
    expect(a.getFinding(f1.id)!.cells).toEqual([c1, c2]);
    expect(a.setFindingStatus(f1.id, 'verified', 'reproduced', human).status).toBe('verified');
    const c3 = { moduleId: 'm2', requirementId: 'r1' };
    const f2 = a.createFinding(finding({ moduleId: 'm2' }), [c3], human);
    const merged = a.mergeFinding(f2.id, f1.id, human);
    expect(merged.cells).toEqual([c1, c2, c3]);
    expect(a.getFinding(f2.id)!.mergedInto).toBe(f1.id);
    expect(() => a.setFindingStatus(f2.id, 'fixed', null, human)).toThrow(/merged into/);
    expect(() => a.mergeFinding(f1.id, f1.id, human)).toThrow(/into itself/);
    // Linking to a merged finding resolves to its target.
    expect(a.linkFinding(f2.id, { moduleId: 'm3', requirementId: 'r9' }, human).id).toBe(f1.id);
    expect(a.findingsOfCell(c3).map((f) => f.id)).toEqual([f1.id]);
    expect(a.findingCounts().get(cellId(c1))).toBe(1);
    expect(a.findingEvents(f1.id).map((e) => e.kind)).toEqual(['created', 'link', 'link', 'status', 'link', 'link']);
    expect(() => a.db.prepare('DELETE FROM finding_events').run()).toThrow(/append-only/);
    expect(() => a.db.prepare(`UPDATE findings SET title = 'x'`).run()).toThrow(/immutable/);
  });

  it('validity cache per entity and commit', () => {
    const a = store();
    expect(a.getValidity('verdict', 'v1', 'h1')).toBeUndefined();
    a.setValidity('verdict', 'v1', 'h1', false, ['svc/A.java']);
    expect(a.getValidity('verdict', 'v1', 'h1')).toEqual({ valid: false, changedFiles: ['svc/A.java'] });
    a.setValidity('verdict', 'v1', 'h1', true, []);
    expect(a.getValidity('verdict', 'v1', 'h1')!.valid).toBe(true);
  });
});

describe('matrix helpers', () => {
  it('cell ids, requirement hash', () => {
    expect(parseCellId(cellId({ moduleId: 'm', requirementId: 'r/x' }))).toEqual({ moduleId: 'm', requirementId: 'r/x' });
    expect(() => parseCellId('nope')).toThrow();
    expect(reqHash('a  b\n c')).toBe(reqHash(' a b c '));
    expect(reqHash('a b c')).not.toBe(reqHash('a b d'));
  });

  it('globs and stale detection by touched files or module files', () => {
    expect(matchesGlobs('svc/src/A.java', ['svc/**', '!svc/test/**'])).toBe(true);
    expect(matchesGlobs('svc/test/T.java', ['svc/**', '!svc/test/**'])).toBe(false);
    expect(matchesGlobs('svc/A.java', ['svc/*.java'])).toBe(true);
    expect(matchesGlobs('svc/x/A.java', ['svc/*.java'])).toBe(false);
    expect(matchesGlobs('svc/x/A.java', ['svc'])).toBe(true);
    const changed = ['svc/A.java', 'lib/Util.java', 'docs/readme.md'];
    expect(affectingChanges(changed, ['lib/Util.java'], ['svc/**'])).toEqual(['svc/A.java', 'lib/Util.java']);
    expect(affectingChanges(changed, [], ['other/**'])).toEqual([]);
  });

  it('batches: module x group up to size; cells with their own level run alone', () => {
    const cells = [
      { moduleId: 'm1', requirementId: 'a', group: 'Access', alone: false },
      { moduleId: 'm2', requirementId: 'a', group: 'Access', alone: false },
      { moduleId: 'm1', requirementId: 'b', group: 'Access', alone: false },
      { moduleId: 'm1', requirementId: 'c', group: 'Access', alone: false },
      { moduleId: 'm1', requirementId: 'd', group: 'Input', alone: false },
      { moduleId: 'm1', requirementId: 'e', group: 'Access', alone: true },
    ];
    const b = planBatches(cells, 2);
    expect(b.map((x) => [x.moduleId, x.group, x.cells.map((c) => c.requirementId).join('')])).toEqual([
      ['m1', 'Access', 'ab'],
      ['m2', 'Access', 'a'],
      ['m1', 'Access', 'c'],
      ['m1', 'Input', 'd'],
      ['m1', 'Access', 'e'],
    ]);
    expect(planBatches(cells.map((c) => ({ ...c, alone: false })), 40, false).map((x) => x.cells.length)).toEqual([5, 1]);
  });

  it('find_similar ranking: same entry point, CWE, shared files', () => {
    const a = store();
    const same = a.createFinding(finding(), [], human);
    a.createFinding(finding({ entryPoint: 'http GET /other', cwe: 'CWE-89', files: [{ file: 'x/Y.java' }] }), [], human);
    const cweAndFile = a.createFinding(finding({ entryPoint: null }), [], human);
    const r = rankSimilar({ entryPoint: 'http GET /a', cwe: 'cwe-639', files: [{ file: 'svc/A.java' }], moduleId: 'm1' }, a.listFindings(), 5);
    expect(r.map((x) => x.finding.id)).toEqual([same.id, cweAndFile.id]);
    expect(r[0].reasons).toEqual(['same entry point', 'same CWE-639', 'shared files: svc/A.java']);
    expect(rankSimilar({ entryPoint: null, cwe: null, files: [{ file: 'none' }], moduleId: null }, a.listFindings(), 5)).toEqual([]);
  });

  it('quotes are checked after normalizing case, whitespace and markdown', () => {
    const doc = '## Access\n\n* **Every** endpoint MUST check   the caller’s role.\n';
    expect(quoteFound(doc, 'every endpoint must check the callers role.')).toBe(true);
    expect(quoteFound(doc, 'endpoints should check')).toBe(false);
    expect(quoteFound(doc, '   ')).toBe(false);
  });
});
