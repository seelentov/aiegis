import crypto from 'node:crypto';
import type { DB } from './db';
import type {
  DocFormat,
  DocCheck,
  DocLink,
  DocPlanEntry,
  DocProposal,
  DocProposalKind,
  DocProposalStatus,
  DocSet,
  DocumentSummary,
  DocVersion,
  DocVersionStatus,
  Evidence,
  Finding,
  FindingEvent,
  FindingInput,
  FindingStatus,
  ItemChange,
  Matrix,
  PocResult,
  FindingVerification,
  CitedRequirement,
  DocInfo,
  JudgedEntry,
  RequirementItem,
  ScaItemRef,
  ReviewState,
  TriageMark,
  Verdict,
  VerdictStatus,
} from '../shared/types';
import { citationOf } from './documents';
import { cellId, quoteFound, reqHash, type CellRef } from './matrix';
import { scaItemId } from './sca';
import type { Authorship } from './store';

const now = () => new Date().toISOString();

/** Author of items carried over unchanged from the previous approved version. */
export const CARRIED_AUTHOR = 'auto';

type Row = Record<string, unknown>;

const VERSION_SELECT = `SELECT v.*,
  (SELECT COUNT(*) FROM req_items i WHERE i.version_id = v.id) AS item_count,
  (SELECT COUNT(*) FROM req_items i WHERE i.version_id = v.id AND i.review = 'pending') AS pending_count,
  n.name AS info_name, n.number AS info_number, n.date AS info_date, n.edition AS info_edition
  FROM doc_versions v LEFT JOIN doc_version_info n ON n.version_id = v.id`;

function toVersion(r: Row): DocVersion {
  return {
    id: r.id as string,
    documentId: r.document_id as string,
    n: r.n as number,
    filename: r.filename as string,
    format: r.format as DocFormat,
    sha256: r.sha256 as string,
    status: r.status as DocVersionStatus,
    itemCount: r.item_count as number,
    pendingCount: r.pending_count as number,
    createdAt: r.created_at as string,
    approvedAt: (r.approved_at as string) ?? null,
    approvedBy: (r.approved_by as string) ?? null,
    info: {
      name: (r.info_name as string) ?? '',
      number: (r.info_number as string) ?? '',
      date: (r.info_date as string) ?? '',
      edition: (r.info_edition as string) ?? '',
    },
  };
}

function toSet(r: Row): DocSet {
  return {
    id: r.id as string,
    name: r.name as string,
    scope: r.scope as string,
    links: JSON.parse(r.links as string) as DocLink[],
    generated: Boolean(r.generated),
    createdAt: r.created_at as string,
  };
}

function toProposal(r: Row): DocProposal {
  return {
    id: r.id as string,
    target: r.target as string,
    setId: (r.set_id as string) ?? null,
    documentId: (r.document_id as string) ?? null,
    kind: r.kind as DocProposalKind,
    status: r.status as DocProposalStatus,
    title: (r.title as string) ?? null,
    edition: (r.edition as string) ?? null,
    url: (r.url as string) ?? null,
    reason: r.reason as string,
    quote: (r.quote as string) ?? null,
    quoteUrl: (r.quote_url as string) ?? null,
    unverifiedChannel: Boolean(r.unverified_channel),
    restored: Boolean(r.restored),
    coverage: (r.coverage as number) ?? null,
    incomplete: Boolean(r.incomplete),
    versionId: (r.version_id as string) ?? null,
    resultDocumentId: (r.result_document_id as string) ?? null,
    createdAt: r.created_at as string,
    decidedAt: (r.decided_at as string) ?? null,
    decisionNote: (r.decision_note as string) ?? null,
  };
}

function toItem(r: Row): RequirementItem {
  return {
    id: r.id as string,
    versionId: r.version_id as string,
    requirementId: r.requirement_id as string,
    key: r.key as string,
    text: r.text as string,
    section: r.section as string,
    clause: r.clause as string,
    quote: r.quote as string,
    review: r.review as ReviewState,
    author: r.author as string,
    runId: (r.run_id as string) ?? null,
    updatedAt: r.updated_at as string,
  };
}

function toMatrix(r: Row): Matrix {
  return {
    id: r.id as string,
    name: r.name as string,
    documentIds: JSON.parse(r.documents as string),
    moduleIds: JSON.parse(r.modules as string),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toVerdict(r: Row): Verdict {
  return {
    id: r.id as string,
    moduleId: r.module_id as string,
    requirementId: r.requirement_id as string,
    itemId: r.item_id as string,
    reqHash: r.req_hash as string,
    status: r.status as VerdictStatus,
    reason: r.reason as string,
    evidence: JSON.parse(r.evidence as string),
    commitSha: r.commit_sha as string,
    touchedFiles: JSON.parse(r.touched_files as string),
    moduleGlobs: JSON.parse(r.module_globs as string),
    preliminary: Boolean(r.preliminary),
    runId: (r.run_id as string) ?? null,
    author: r.author as string,
    createdAt: r.created_at as string,
  };
}

function toTriage(r: Row): TriageMark {
  return {
    id: r.id as string,
    moduleId: r.module_id as string,
    requirementId: r.requirement_id as string,
    reqHash: r.req_hash as string,
    applicable: Boolean(r.applicable),
    reason: r.reason as string,
    runId: (r.run_id as string) ?? null,
    createdAt: r.created_at as string,
  };
}

function toEvent(r: Row): FindingEvent {
  return {
    id: r.id as string,
    findingId: r.finding_id as string,
    kind: r.kind as FindingEvent['kind'],
    status: (r.status as FindingStatus) ?? null,
    reason: (r.reason as string) ?? null,
    mergedInto: (r.merged_into as string) ?? null,
    cell: r.module_id && r.requirement_id ? { moduleId: r.module_id as string, requirementId: r.requirement_id as string } : null,
    scaItem: r.module_id && r.package_key ? { moduleId: r.module_id as string, packageKey: r.package_key as string, vulnId: r.vuln_id as string } : null,
    runId: (r.run_id as string) ?? null,
    author: r.author as string,
    createdAt: r.created_at as string,
  };
}

/** Finding row + its events in order -> current state. */
const LATEST_VERIFICATION = '(SELECT outcome FROM finding_verifications v WHERE v.finding_id = findings.id ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1) AS verification';

function toFinding(r: Row, events: FindingEvent[]): Finding {
  let status: FindingStatus = 'suspected';
  let mergedInto: string | null = null;
  const cells = new Map<string, CellRef>();
  const sca = new Map<string, ScaItemRef>();
  let updatedAt = r.created_at as string;
  for (const e of events) {
    if (e.kind === 'status' && e.status) status = e.status;
    if (e.kind === 'merged') mergedInto = e.mergedInto;
    if (e.kind === 'link' && e.cell) cells.set(cellId(e.cell), e.cell);
    if (e.kind === 'link' && e.scaItem) sca.set(scaItemId(e.scaItem), e.scaItem);
    updatedAt = e.createdAt;
  }
  return {
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
    severity: r.severity as Finding['severity'],
    cwe: (r.cwe as string) ?? null,
    moduleId: (r.module_id as string) ?? null,
    entryPoint: (r.entry_point as string) ?? null,
    files: JSON.parse(r.files as string),
    recommendation: (r.recommendation as string) ?? null,
    status,
    mergedInto,
    cells: [...cells.values()],
    scaItems: [...sca.values()],
    verification: (r.verification as Finding['verification']) ?? null,
    runId: (r.run_id as string) ?? null,
    author: r.author as string,
    createdAt: r.created_at as string,
    updatedAt,
  };
}

export interface NewVerdict extends CellRef {
  preliminary?: boolean;
  itemId: string;
  reqHash: string;
  status: VerdictStatus;
  reason: string;
  evidence: Evidence[];
  commitSha: string;
  touchedFiles: string[];
  moduleGlobs: string[];
}

/** Documents, requirements, matrices, verdicts, findings and validity of one project. */
export class AuditStore {
  constructor(readonly db: DB) {}

  // --- documents and versions ---

  createDocument(title: string): string {
    const t = title.trim();
    if (!t) throw new Error('empty document title');
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO documents (id, title, created_at) VALUES (?, ?, ?)').run(id, t, now());
    return id;
  }

  setGenerated(id: string, entry: DocPlanEntry): void {
    this.db.prepare('UPDATE documents SET generated = ? WHERE id = ?').run(JSON.stringify(entry), id);
  }

  getDocument(id: string): DocumentSummary | undefined {
    return this.listDocuments().find((d) => d.id === id);
  }

  setDocumentSet(id: string, setId: string | null): void {
    this.db.prepare('UPDATE documents SET set_id = ? WHERE id = ?').run(setId, id);
  }

  setDocumentSource(id: string, source: DocLink | null): void {
    this.db.prepare('UPDATE documents SET source = ? WHERE id = ?').run(source ? JSON.stringify(source) : null, id);
  }

  setDocumentEdition(id: string, edition: string): void {
    this.db.prepare('UPDATE documents SET edition = ? WHERE id = ?').run(edition, id);
  }

  setDocumentCheck(id: string, check: DocCheck): void {
    this.db.prepare('UPDATE documents SET last_check = ? WHERE id = ?').run(JSON.stringify(check), id);
  }

  setDocumentReplaces(id: string, replaces: string): void {
    this.db.prepare('UPDATE documents SET replaces = ? WHERE id = ?').run(replaces, id);
  }

  /** Out of force or back: requirements follow through `currentItem` and `currentVersion`. */
  setDocumentRetired(id: string, reason: string | null): void {
    this.db.prepare('UPDATE documents SET retired_at = ?, retired_reason = ? WHERE id = ?').run(reason === null ? null : now(), reason, id);
  }

  // --- document sets and refresher proposals (SPEC §24) ---

  listDocSets(): DocSet[] {
    return (this.db.prepare('SELECT * FROM doc_sets ORDER BY name').all() as Row[]).map(toSet);
  }

  getDocSet(id: string): DocSet | undefined {
    const r = this.db.prepare('SELECT * FROM doc_sets WHERE id = ?').get(id) as Row | undefined;
    return r && toSet(r);
  }

  saveDocSet(s: { id?: string; name: string; scope: string; links: DocLink[]; generated?: boolean }): DocSet {
    const name = s.name.trim();
    if (!name) throw new Error('empty set name');
    const clash = this.db.prepare('SELECT id FROM doc_sets WHERE name = ?').get(name) as { id: string } | undefined;
    if (clash && clash.id !== s.id) throw new Error(`set ${name} already exists`);
    const id = s.id ?? crypto.randomUUID();
    if (s.id) {
      if (!this.db.prepare('UPDATE doc_sets SET name = ?, scope = ?, links = ? WHERE id = ?').run(name, s.scope, JSON.stringify(s.links), id).changes) throw new Error(`set ${s.id} not found`);
    } else {
      this.db.prepare('INSERT INTO doc_sets (id, name, scope, links, generated, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, s.scope, JSON.stringify(s.links), s.generated ? 1 : 0, now());
    }
    return this.getDocSet(id)!;
  }

  removeDocSet(id: string): void {
    this.db.prepare('UPDATE documents SET set_id = NULL WHERE set_id = ?').run(id);
    this.db.prepare('DELETE FROM doc_sets WHERE id = ?').run(id);
  }

  listDocProposals(): DocProposal[] {
    return (this.db.prepare('SELECT * FROM doc_proposals ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(toProposal);
  }

  getDocProposal(id: string): (DocProposal & { file: string | null; sha256: string | null }) | undefined {
    const r = this.db.prepare('SELECT * FROM doc_proposals WHERE id = ?').get(id) as Row | undefined;
    return r && { ...toProposal(r), file: (r.file as string) ?? null, sha256: (r.sha256 as string) ?? null };
  }

  /** Newest proposal with the same identity: a change is not proposed twice while the source stays the same. */
  proposalByKey(key: string): DocProposal | undefined {
    const r = this.db.prepare('SELECT * FROM doc_proposals WHERE dedupe_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(key) as Row | undefined;
    return r && toProposal(r);
  }

  proposalOfVersion(versionId: string): DocProposal | null {
    const r = this.db.prepare('SELECT * FROM doc_proposals WHERE version_id = ?').get(versionId) as Row | undefined;
    return r ? toProposal(r) : null;
  }

  addDocProposal(p: {
    id: string;
    target: string;
    setId: string | null;
    documentId: string | null;
    kind: DocProposalKind;
    dedupeKey: string;
    title: string | null;
    edition: string | null;
    url: string | null;
    reason: string;
    quote: string | null;
    quoteUrl: string | null;
    file: string | null;
    sha256: string | null;
    unverifiedChannel: boolean;
    restored: boolean;
    coverage: number | null;
    incomplete: boolean;
    runId: string;
  }): DocProposal {
    this.db
      .prepare(
        `INSERT INTO doc_proposals (id, target, set_id, document_id, kind, status, dedupe_key, title, edition, url, reason, quote, quote_url, file, sha256, unverified_channel, restored, coverage, run_id, created_at, incomplete)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.target, p.setId, p.documentId, p.kind, p.dedupeKey, p.title, p.edition, p.url, p.reason, p.quote, p.quoteUrl, p.file, p.sha256, p.unverifiedChannel ? 1 : 0, p.restored ? 1 : 0, p.coverage, p.runId, now(), p.incomplete ? 1 : 0);
    return this.getDocProposal(p.id)!;
  }

  decideDocProposal(id: string, status: Exclude<DocProposalStatus, 'pending'>, d: { note?: string; versionId?: string | null; resultDocumentId?: string | null } = {}): void {
    this.db
      .prepare('UPDATE doc_proposals SET status = ?, decided_at = ?, decision_note = ?, version_id = ?, result_document_id = ? WHERE id = ?')
      .run(status, now(), d.note ?? null, d.versionId ?? null, d.resultDocumentId ?? null, id);
  }

  /** Proposals made by a run. */
  proposalsOfRun(runId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM doc_proposals WHERE run_id = ?').get(runId) as { n: number }).n;
  }

  refreshBaseline(target: string): { fingerprint: string; sources: { url: string; hash: string | null }[]; results: Record<string, string> } | undefined {
    const r = this.db.prepare('SELECT * FROM doc_refresh_baselines WHERE target = ?').get(target) as Row | undefined;
    return r && { fingerprint: r.fingerprint as string, sources: JSON.parse(r.sources as string), results: JSON.parse(r.results as string) };
  }

  saveRefreshBaseline(target: string, fingerprint: string, sources: { url: string; hash: string | null }[], results: Record<string, string>): void {
    this.db
      .prepare('INSERT INTO doc_refresh_baselines (target, fingerprint, sources, results, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(target) DO UPDATE SET fingerprint = excluded.fingerprint, sources = excluded.sources, results = excluded.results, checked_at = excluded.checked_at')
      .run(target, fingerprint, JSON.stringify(sources), JSON.stringify(results), now());
  }

  deleteRefreshBaseline(target: string): void {
    this.db.prepare('DELETE FROM doc_refresh_baselines WHERE target = ?').run(target);
  }

  getDocumentTitle(id: string): string | undefined {
    return (this.db.prepare('SELECT title FROM documents WHERE id = ?').get(id) as { title: string } | undefined)?.title;
  }

  listDocuments(): DocumentSummary[] {
    const docs = this.db.prepare('SELECT * FROM documents ORDER BY title, created_at').all() as Row[];
    const versions = (this.db.prepare(`${VERSION_SELECT} ORDER BY v.n DESC`).all() as Row[]).map(toVersion);
    return docs.map((d) => {
      const vs = versions.filter((v) => v.documentId === d.id);
      return {
        id: d.id as string,
        title: d.title as string,
        createdAt: d.created_at as string,
        versions: vs,
        current: vs.find((v) => v.status === 'approved') ?? null,
        generated: d.generated ? (JSON.parse(d.generated as string) as DocPlanEntry) : null,
        setId: (d.set_id as string) ?? null,
        source: d.source ? (JSON.parse(d.source as string) as DocLink) : null,
        edition: (d.edition as string) ?? null,
        lastCheck: d.last_check ? (JSON.parse(d.last_check as string) as DocCheck) : null,
        retiredAt: (d.retired_at as string) ?? null,
        retiredReason: (d.retired_reason as string) ?? null,
        replaces: (d.replaces as string) ?? null,
      };
    });
  }

  addVersion(documentId: string, v: { filename: string; format: DocFormat; sha256: string }, id: string = crypto.randomUUID()): DocVersion {
    const n = ((this.db.prepare('SELECT MAX(n) AS n FROM doc_versions WHERE document_id = ?').get(documentId) as { n: number | null }).n ?? 0) + 1;
    this.db
      .prepare(`INSERT INTO doc_versions (id, document_id, n, filename, format, sha256, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'extracting', ?)`)
      .run(id, documentId, n, v.filename, v.format, v.sha256, now());
    return this.getVersion(id)!;
  }

  getVersion(id: string): DocVersion | undefined {
    const r = this.db.prepare(`${VERSION_SELECT} WHERE v.id = ?`).get(id) as Row | undefined;
    return r && toVersion(r);
  }

  setVersionStatus(id: string, status: Exclude<DocVersionStatus, 'approved'>): void {
    this.db.prepare('UPDATE doc_versions SET status = ? WHERE id = ?').run(status, id);
  }

  /** Latest approved version of a document in force. */
  currentVersion(documentId: string): DocVersion | undefined {
    const r = this.db.prepare(`${VERSION_SELECT} WHERE v.document_id = ? AND v.status = 'approved' AND (SELECT retired_at FROM documents WHERE id = v.document_id) IS NULL ORDER BY v.n DESC LIMIT 1`).get(documentId) as
      | Row
      | undefined;
    return r && toVersion(r);
  }

  /** Approved version preceding `version` (baseline of its diff). */
  previousApproved(version: DocVersion): DocVersion | undefined {
    const r = this.db
      .prepare(`${VERSION_SELECT} WHERE v.document_id = ? AND v.status = 'approved' AND v.n < ? ORDER BY v.n DESC LIMIT 1`)
      .get(version.documentId, version.n) as Row | undefined;
    return r && toVersion(r);
  }

  /** Review is mandatory (SPEC §4, Q17): every item must be accepted or rejected first. */
  approveVersion(id: string, by: string): void {
    const v = this.getVersion(id);
    if (!v) throw new Error(`version ${id} not found`);
    if (v.status !== 'review') throw new Error('only a version in review can be approved');
    if (v.pendingCount) throw new Error(`items not reviewed: ${v.pendingCount}`);
    if (!this.listItems(id).some((i) => i.review === 'accepted')) throw new Error('the version has no accepted items');
    this.db.prepare(`UPDATE doc_versions SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?`).run(now(), by, id);
  }

  // --- requirement items ---

  listItems(versionId: string): RequirementItem[] {
    return (this.db.prepare('SELECT * FROM req_items WHERE version_id = ? ORDER BY rowid').all(versionId) as Row[]).map(toItem);
  }

  getItem(id: string): RequirementItem | undefined {
    const r = this.db.prepare('SELECT * FROM req_items WHERE id = ?').get(id) as Row | undefined;
    return r && toItem(r);
  }

  private ensureRequirement(documentId: string, key: string): string {
    const r = this.db.prepare('SELECT id FROM requirements WHERE document_id = ? AND key = ?').get(documentId, key) as { id: string } | undefined;
    if (r) return r.id;
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO requirements (id, document_id, key, created_at) VALUES (?, ?, ?, ?)').run(id, documentId, key, now());
    return id;
  }

  /** Next generated key of a document ("R-001", ...) for requirements without an id in the text. */
  private generatedKey(documentId: string): string {
    const keys = (this.db.prepare(`SELECT key FROM requirements WHERE document_id = ? AND key LIKE 'R-%'`).all(documentId) as { key: string }[]).map(
      (r) => Number(r.key.slice(2)) || 0,
    );
    return `R-${String(Math.max(0, ...keys) + 1).padStart(3, '0')}`;
  }

  /** Adds an item to a version or replaces the one with the same key; review starts over. */
  upsertItem(
    versionId: string,
    it: { key?: string | null; text: string; section: string; clause?: string; quote: string },
    by: Authorship,
    review: ReviewState = 'pending',
  ): RequirementItem {
    const v = this.getVersion(versionId);
    if (!v) throw new Error(`version ${versionId} not found`);
    const text = it.text.trim();
    if (!text) throw new Error('empty requirement text');
    return this.db.transaction(() => {
      const key = it.key?.trim() || this.generatedKey(v.documentId);
      const requirementId = this.ensureRequirement(v.documentId, key);
      this.db
        .prepare(
          `INSERT INTO req_items (id, version_id, requirement_id, key, text, section, clause, quote, review, author, run_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (version_id, key) DO UPDATE SET text = excluded.text, section = excluded.section, clause = excluded.clause, quote = excluded.quote,
             review = excluded.review, author = excluded.author, run_id = excluded.run_id, updated_at = excluded.updated_at`,
        )
        .run(crypto.randomUUID(), versionId, requirementId, key, text, it.section.trim(), it.clause?.trim() ?? '', it.quote.trim(), review, by.author, by.runId, now());
      return toItem(this.db.prepare('SELECT * FROM req_items WHERE version_id = ? AND key = ?').get(versionId, key) as Row);
    })();
  }

  /**
   * Copies accepted items of the previous approved version whose quote is still verbatim in the new `text`:
   * unchanged wording keeps its key, text and split without AI (extraction of compound items is unstable).
   */
  carryOverItems(version: DocVersion, text: string): RequirementItem[] {
    const base = this.previousApproved(version);
    if (!base) return [];
    const by = { author: CARRIED_AUTHOR, runId: null };
    return this.db.transaction(() =>
      this.listItems(base.id)
        .filter((i) => i.review === 'accepted' && quoteFound(text, i.quote))
        .map((i) => this.upsertItem(version.id, i, by, 'accepted')),
    )();
  }

  reviewItems(versionId: string, itemIds: string[], review: ReviewState): number {
    const stmt = this.db.prepare('UPDATE req_items SET review = ?, updated_at = ? WHERE version_id = ? AND id = ?');
    return this.db.transaction(() => itemIds.reduce((n, id) => n + Number(stmt.run(review, now(), versionId, id).changes), 0))();
  }

  /** Items of `version` with changes against the previous approved version (matched by key). */
  versionDiff(version: DocVersion): { baseline: DocVersion | null; items: (RequirementItem & { change: ItemChange })[]; removed: RequirementItem[] } {
    const items = this.listItems(version.id);
    const base = this.previousApproved(version);
    if (!base) return { baseline: null, items: items.map((i) => ({ ...i, change: 'added' })), removed: [] };
    const prev = new Map(this.listItems(base.id).filter((i) => i.review === 'accepted').map((i) => [i.key, i]));
    const keys = new Set(items.map((i) => i.key));
    return {
      baseline: base,
      items: items.map((i) => {
        const p = prev.get(i.key);
        return { ...i, change: !p ? 'added' : reqHash(p.text) === reqHash(i.text) ? 'same' : 'changed' };
      }),
      removed: [...prev.values()].filter((i) => !keys.has(i.key)),
    };
  }

  /** Accepted item of the requirement in its document's current version; undefined if retired. */
  currentItem(requirementId: string): RequirementItem | undefined {
    const r = this.db
      .prepare(
        `SELECT i.* FROM req_items i JOIN doc_versions v ON v.id = i.version_id
         WHERE i.requirement_id = ? AND i.review = 'accepted' AND v.status = 'approved'
           AND (SELECT retired_at FROM documents WHERE id = v.document_id) IS NULL
           AND v.n = (SELECT MAX(n) FROM doc_versions WHERE document_id = v.document_id AND status = 'approved')`,
      )
      .get(requirementId) as Row | undefined;
    return r && toItem(r);
  }

  judgeCatalogueEntry(setId: string, e: Omit<JudgedEntry, 'judgedAt'>, runId: string): void {
    this.db
      .prepare(
        `INSERT INTO doc_catalogue_entries (set_id, url, title, belongs, reason, run_id, judged_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (set_id, url) DO UPDATE SET belongs = excluded.belongs, reason = excluded.reason, run_id = excluded.run_id, judged_at = excluded.judged_at`,
      )
      .run(setId, e.url, e.title, Number(e.belongs), e.reason.trim(), runId, now());
  }

  catalogueEntries(setId: string): JudgedEntry[] {
    return (this.db.prepare('SELECT * FROM doc_catalogue_entries WHERE set_id = ? ORDER BY belongs DESC, title').all(setId) as Row[]).map((r) => ({
      url: r.url as string,
      title: r.title as string,
      belongs: Boolean(r.belongs),
      reason: r.reason as string,
      judgedAt: r.judged_at as string,
    }));
  }

  setVersionInfo(versionId: string, info: DocInfo): void {
    const { name, number, date, edition } = info;
    this.db
      .prepare(
        `INSERT INTO doc_version_info (version_id, name, number, date, edition) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (version_id) DO UPDATE SET name = excluded.name, number = excluded.number, date = excluded.date, edition = excluded.edition`,
      )
      .run(versionId, name.trim(), number.trim(), date.trim(), edition.trim());
  }

  /** An item with the grounds to name it by: its document as of the item's own version. */
  citedItem(item: RequirementItem): CitedRequirement {
    const v = this.getVersion(item.versionId)!;
    const documentTitle = this.getDocumentTitle(v.documentId) ?? '';
    return { ...item, documentTitle, citation: citationOf(documentTitle, v.info, item) };
  }

  /** Current requirements of documents: accepted items of their latest approved versions, in document order. */
  currentItems(documentIds: string[]): CitedRequirement[] {
    const out: CitedRequirement[] = [];
    for (const d of documentIds) {
      const v = this.currentVersion(d);
      if (!v) continue;
      for (const i of this.listItems(v.id)) if (i.review === 'accepted') out.push(this.citedItem(i));
    }
    return out;
  }

  /** Document of a requirement. */
  requirementDocument(requirementId: string): string | undefined {
    return (this.db.prepare('SELECT document_id FROM requirements WHERE id = ?').get(requirementId) as { document_id: string } | undefined)?.document_id;
  }

  /** Newest item of a requirement in any version (labels of retired requirements). */
  latestItem(requirementId: string): RequirementItem | undefined {
    const r = this.db
      .prepare('SELECT i.* FROM req_items i JOIN doc_versions v ON v.id = i.version_id WHERE i.requirement_id = ? ORDER BY v.n DESC LIMIT 1')
      .get(requirementId) as Row | undefined;
    return r && toItem(r);
  }

  // --- matrices ---

  listMatrices(): Matrix[] {
    return (this.db.prepare('SELECT * FROM matrices ORDER BY name').all() as Row[]).map(toMatrix);
  }

  getMatrix(id: string): Matrix | undefined {
    const r = this.db.prepare('SELECT * FROM matrices WHERE id = ?').get(id) as Row | undefined;
    return r && toMatrix(r);
  }

  saveMatrix(m: { id?: string; name: string; documentIds: string[]; moduleIds: string[] }): Matrix {
    const name = m.name.trim();
    if (!name) throw new Error('empty matrix name');
    if (!m.documentIds.length) throw new Error('choose at least one document');
    const clash = this.db.prepare('SELECT id FROM matrices WHERE name = ?').get(name) as { id: string } | undefined;
    if (clash && clash.id !== m.id) throw new Error(`matrix ${name} already exists`);
    const t = now();
    const id = m.id ?? crypto.randomUUID();
    if (m.id) {
      const changes = this.db
        .prepare('UPDATE matrices SET name = ?, documents = ?, modules = ?, updated_at = ? WHERE id = ?')
        .run(name, JSON.stringify(m.documentIds), JSON.stringify(m.moduleIds), t, id).changes;
      if (!changes) throw new Error(`matrix ${m.id} not found`);
    } else {
      this.db
        .prepare('INSERT INTO matrices (id, name, documents, modules, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, name, JSON.stringify(m.documentIds), JSON.stringify(m.moduleIds), t, t);
    }
    return this.getMatrix(id)!;
  }

  // --- verdicts and triage ---

  addVerdict(v: NewVerdict, by: Authorship): Verdict {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO verdicts (id, module_id, requirement_id, item_id, req_hash, status, reason, evidence, commit_sha, touched_files,
                               module_globs, preliminary, run_id, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        v.moduleId,
        v.requirementId,
        v.itemId,
        v.reqHash,
        v.status,
        v.reason,
        JSON.stringify(v.evidence),
        v.commitSha,
        JSON.stringify(v.touchedFiles),
        JSON.stringify(v.moduleGlobs),
        v.preliminary ? 1 : 0,
        by.runId,
        by.author,
        now(),
      );
    return toVerdict(this.db.prepare('SELECT * FROM verdicts WHERE id = ?').get(id) as Row);
  }

  /** Newest first. */
  verdictHistory(c: CellRef): Verdict[] {
    return (
      this.db.prepare('SELECT * FROM verdicts WHERE module_id = ? AND requirement_id = ? ORDER BY created_at DESC, rowid DESC').all(c.moduleId, c.requirementId) as Row[]
    ).map(toVerdict);
  }

  /** Current verdict of every cell that has one, keyed by cell id. */
  latestVerdicts(): Map<string, Verdict> {
    const rows = this.db
      .prepare(`SELECT * FROM verdicts v WHERE rowid = (SELECT MAX(rowid) FROM verdicts WHERE module_id = v.module_id AND requirement_id = v.requirement_id)`)
      .all() as Row[];
    return new Map(rows.map((r) => toVerdict(r)).map((v) => [cellId(v), v]));
  }

  verdictsOfRuns(runIds: string[]): Verdict[] {
    if (!runIds.length) return [];
    return (this.db.prepare(`SELECT * FROM verdicts WHERE run_id IN (${runIds.map(() => '?').join(',')})`).all(...runIds) as Row[]).map(toVerdict);
  }

  addTriage(t: CellRef & { reqHash: string; applicable: boolean; reason: string }, by: Authorship): TriageMark {
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO triage (id, module_id, requirement_id, req_hash, applicable, reason, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, t.moduleId, t.requirementId, t.reqHash, t.applicable ? 1 : 0, t.reason, by.runId, now());
    return toTriage(this.db.prepare('SELECT * FROM triage WHERE id = ?').get(id) as Row);
  }

  triageHistory(c: CellRef): TriageMark[] {
    return (
      this.db.prepare('SELECT * FROM triage WHERE module_id = ? AND requirement_id = ? ORDER BY created_at DESC, rowid DESC').all(c.moduleId, c.requirementId) as Row[]
    ).map(toTriage);
  }

  latestTriage(): Map<string, TriageMark> {
    const rows = this.db
      .prepare(`SELECT * FROM triage t WHERE rowid = (SELECT MAX(rowid) FROM triage WHERE module_id = t.module_id AND requirement_id = t.requirement_id)`)
      .all() as Row[];
    return new Map(rows.map((r) => toTriage(r)).map((t) => [cellId(t), t]));
  }

  triageOfRuns(runIds: string[]): TriageMark[] {
    if (!runIds.length) return [];
    return (this.db.prepare(`SELECT * FROM triage WHERE run_id IN (${runIds.map(() => '?').join(',')})`).all(...runIds) as Row[]).map(toTriage);
  }

  // --- findings ---

  private insertEvent(
    findingId: string,
    e: { kind: FindingEvent['kind']; status?: FindingStatus; reason?: string | null; mergedInto?: string; cell?: CellRef; scaItem?: ScaItemRef },
    by: Authorship,
  ): void {
    this.db
      .prepare(
        `INSERT INTO finding_events (id, finding_id, kind, status, reason, merged_into, module_id, requirement_id, package_key, vuln_id, run_id, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        findingId,
        e.kind,
        e.status ?? null,
        e.reason ?? null,
        e.mergedInto ?? null,
        e.cell?.moduleId ?? e.scaItem?.moduleId ?? null,
        e.cell?.requirementId ?? null,
        e.scaItem?.packageKey ?? null,
        e.scaItem?.vulnId ?? null,
        by.runId,
        by.author,
        now(),
      );
  }

  createFinding(f: FindingInput, cells: CellRef[], by: Authorship, scaItems: ScaItemRef[] = []): Finding {
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO findings (id, title, description, severity, cwe, module_id, entry_point, files, recommendation, run_id, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, f.title, f.description, f.severity, f.cwe, f.moduleId, f.entryPoint, JSON.stringify(f.files), f.recommendation, by.runId, by.author, now());
      this.insertEvent(id, { kind: 'created', status: 'suspected' }, by);
      for (const c of cells) this.insertEvent(id, { kind: 'link', cell: c }, by);
      for (const x of scaItems) this.insertEvent(id, { kind: 'link', scaItem: x }, by);
    })();
    return this.getFinding(id)!;
  }

  findingEvents(id: string): FindingEvent[] {
    return (this.db.prepare('SELECT * FROM finding_events WHERE finding_id = ? ORDER BY created_at, rowid').all(id) as Row[]).map(toEvent);
  }

  getFinding(id: string): Finding | undefined {
    const r = this.db.prepare(`SELECT *, ${LATEST_VERIFICATION} FROM findings WHERE id = ?`).get(id) as Row | undefined;
    return r && toFinding(r, this.findingEvents(id));
  }

  listFindings(): Finding[] {
    const events = new Map<string, FindingEvent[]>();
    for (const r of this.db.prepare('SELECT * FROM finding_events ORDER BY created_at, rowid').all() as Row[]) {
      const e = toEvent(r);
      events.set(e.findingId, [...(events.get(e.findingId) ?? []), e]);
    }
    return (this.db.prepare(`SELECT *, ${LATEST_VERIFICATION} FROM findings ORDER BY created_at DESC`).all() as Row[]).map((r) => toFinding(r, events.get(r.id as string) ?? []));
  }

  /** Live (not merged) findings linked to a cell. */
  findingsOfCell(c: CellRef): Finding[] {
    const ids = (
      this.db.prepare(`SELECT DISTINCT finding_id FROM finding_events WHERE kind = 'link' AND module_id = ? AND requirement_id = ?`).all(c.moduleId, c.requirementId) as {
        finding_id: string;
      }[]
    ).map((r) => r.finding_id);
    return ids.map((id) => this.getFinding(id)!).filter((f) => !f.mergedInto);
  }

  /** Live (not merged) findings linked to an SCA item. */
  findingsOfScaItem(x: ScaItemRef): Finding[] {
    const ids = (
      this.db
        .prepare(`SELECT DISTINCT finding_id FROM finding_events WHERE kind = 'link' AND module_id = ? AND package_key = ? AND vuln_id = ?`)
        .all(x.moduleId, x.packageKey, x.vulnId) as { finding_id: string }[]
    ).map((r) => r.finding_id);
    return ids.map((id) => this.getFinding(id)!).filter((f) => !f.mergedInto);
  }

  /** Links a finding to an SCA item; merged findings resolve to their target. */
  linkScaFinding(id: string, x: ScaItemRef, by: Authorship): Finding {
    let f = this.getFinding(id);
    if (!f) throw new Error(`finding ${id} not found`);
    while (f.mergedInto) f = this.getFinding(f.mergedInto)!;
    if (!f.scaItems.some((y) => scaItemId(y) === scaItemId(x))) this.insertEvent(f.id, { kind: 'link', scaItem: x }, by);
    return this.getFinding(f.id)!;
  }

  setFindingStatus(id: string, status: FindingStatus, reason: string | null, by: Authorship): Finding {
    const f = this.getFinding(id);
    if (!f) throw new Error(`finding ${id} not found`);
    if (f.mergedInto) throw new Error('the finding is merged into another one');
    if (f.status !== status) this.insertEvent(id, { kind: 'status', status, reason }, by);
    return this.getFinding(id)!;
  }

  /** Links a finding to a cell (M:N); merged findings resolve to their target. */
  linkFinding(id: string, c: CellRef, by: Authorship): Finding {
    let f = this.getFinding(id);
    if (!f) throw new Error(`finding ${id} not found`);
    while (f.mergedInto) f = this.getFinding(f.mergedInto)!;
    if (!f.cells.some((x) => cellId(x) === cellId(c))) this.insertEvent(f.id, { kind: 'link', cell: c }, by);
    return this.getFinding(f.id)!;
  }

  /** Manual merge (SPEC §4, Q23): `sourceId` becomes a pointer to `targetId`, its cells move over. */
  mergeFinding(sourceId: string, targetId: string, by: Authorship): Finding {
    if (sourceId === targetId) throw new Error('a finding cannot be merged into itself');
    const src = this.getFinding(sourceId);
    const dst = this.getFinding(targetId);
    if (!src || !dst) throw new Error('finding not found');
    if (src.mergedInto || dst.mergedInto) throw new Error('the finding is already merged into another one');
    this.db.transaction(() => {
      this.insertEvent(sourceId, { kind: 'merged', mergedInto: targetId }, by);
      for (const c of src.cells) if (!dst.cells.some((x) => cellId(x) === cellId(c))) this.insertEvent(targetId, { kind: 'link', cell: c }, by);
      for (const x of src.scaItems) if (!dst.scaItems.some((y) => scaItemId(y) === scaItemId(x))) this.insertEvent(targetId, { kind: 'link', scaItem: x }, by);
    })();
    return this.getFinding(targetId)!;
  }

  /** Number of live findings per SCA item id. */
  scaFindingCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const f of this.listFindings()) {
      if (f.mergedInto) continue;
      for (const x of f.scaItems) out.set(scaItemId(x), (out.get(scaItemId(x)) ?? 0) + 1);
    }
    return out;
  }

  /** Number of live findings per cell id. */
  findingCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const f of this.listFindings()) {
      if (f.mergedInto) continue;
      for (const c of f.cells) out.set(cellId(c), (out.get(cellId(c)) ?? 0) + 1);
    }
    return out;
  }

  // --- PoC tester results ---

  addPocResult(r: Omit<PocResult, 'id' | 'runId' | 'author' | 'createdAt'>, by: Authorship): PocResult {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO poc_results (id, finding_id, outcome, summary, steps, base_url, commit_sha, run_id, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, r.findingId, r.outcome, r.summary, JSON.stringify(r.steps), r.baseUrl, r.commitSha, by.runId, by.author, now());
    return this.pocResults({ id })[0];
  }

  /** Newest first. */
  pocResults(q: { id?: string; findingId?: string; runIds?: string[] }): PocResult[] {
    const runs = q.runIds ?? [];
    const where = q.id ? 'id = ?' : q.findingId ? 'finding_id = ?' : `run_id IN (${runs.map(() => '?').join(',') || 'NULL'})`;
    const args = q.id ? [q.id] : q.findingId ? [q.findingId] : runs;
    return (this.db.prepare(`SELECT * FROM poc_results WHERE ${where} ORDER BY created_at DESC, rowid DESC`).all(...args) as Row[]).map((r) => ({
      id: r.id as string,
      findingId: r.finding_id as string,
      outcome: r.outcome as PocResult['outcome'],
      summary: r.summary as string,
      steps: JSON.parse(r.steps as string),
      baseUrl: r.base_url as string,
      commitSha: r.commit_sha as string,
      runId: (r.run_id as string) ?? null,
      author: r.author as string,
      createdAt: r.created_at as string,
    }));
  }

  // --- independent verification of findings ---

  addFindingVerification(r: Omit<FindingVerification, 'id' | 'runId' | 'author' | 'createdAt'>, by: Authorship): FindingVerification {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO finding_verifications (id, finding_id, outcome, reason, evidence, commit_sha, run_id, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, r.findingId, r.outcome, r.reason, JSON.stringify(r.evidence), r.commitSha, by.runId, by.author, now());
    return this.findingVerifications({ id })[0];
  }

  /** Newest first. */
  findingVerifications(q: { id?: string; findingId?: string; runId?: string }): FindingVerification[] {
    const where = q.id ? 'id = ?' : q.findingId ? 'finding_id = ?' : 'run_id = ?';
    return (this.db.prepare(`SELECT * FROM finding_verifications WHERE ${where} ORDER BY created_at DESC, rowid DESC`).all(q.id ?? q.findingId ?? q.runId ?? null) as Row[]).map((r) => ({
      id: r.id as string,
      findingId: r.finding_id as string,
      outcome: r.outcome as FindingVerification['outcome'],
      reason: r.reason as string,
      evidence: JSON.parse(r.evidence as string),
      commitSha: r.commit_sha as string,
      runId: (r.run_id as string) ?? null,
      author: r.author as string,
      createdAt: r.created_at as string,
    }));
  }

  // --- validity ---

  getValidity(type: string, id: string, sha: string): { valid: boolean; changedFiles: string[] } | undefined {
    const r = this.db.prepare('SELECT * FROM validity WHERE entity_type = ? AND entity_id = ? AND commit_sha = ?').get(type, id, sha) as Row | undefined;
    return r && { valid: Boolean(r.valid), changedFiles: JSON.parse(r.changed_files as string) };
  }

  setValidity(type: string, id: string, sha: string, valid: boolean, changedFiles: string[]): void {
    this.db
      .prepare(
        `INSERT INTO validity (entity_type, entity_id, commit_sha, valid, changed_files, checked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (entity_type, entity_id, commit_sha) DO UPDATE SET valid = excluded.valid, changed_files = excluded.changed_files, checked_at = excluded.checked_at`,
      )
      .run(type, id, sha, valid ? 1 : 0, JSON.stringify(changedFiles), now());
  }
}
