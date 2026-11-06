import type { DB } from './db';
import type { DiffCheck, DiffCheckTarget, DiffVerdict, Evidence, Severity, VerdictStatus } from '../shared/types';
import type { Authorship } from './store';
import crypto from 'node:crypto';

type Row = Record<string, unknown>;

function toCheck(r: Row): DiffCheck {
  return {
    id: r.id as string,
    baseRef: r.base_ref as string,
    headRef: r.head_ref as string,
    baseSha: r.base_sha as string,
    headSha: r.head_sha as string,
    target: JSON.parse(r.target as string) as DiffCheckTarget,
    title: r.title as string,
    versionIds: JSON.parse(r.version_ids as string) as string[],
    files: JSON.parse(r.files as string) as string[],
    author: r.author as string,
    createdAt: r.created_at as string,
  };
}

function toVerdict(r: Row): DiffVerdict {
  return {
    id: r.id as string,
    checkId: r.check_id as string,
    itemId: r.item_id as string,
    status: r.status as VerdictStatus,
    severity: (r.severity as Severity) ?? null,
    reason: r.reason as string,
    evidence: JSON.parse(r.evidence as string) as Evidence[],
    runId: (r.run_id as string) ?? null,
    author: r.author as string,
    createdAt: r.created_at as string,
  };
}

/** Branch checks and their verdicts (SPEC §26). */
export class DiffStore {
  constructor(private readonly db: DB) {}

  add(c: DiffCheck): void {
    this.db
      .prepare(
        `INSERT INTO diff_checks (id, base_ref, head_ref, base_sha, head_sha, target, title, version_ids, files, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.baseRef, c.headRef, c.baseSha, c.headSha, JSON.stringify(c.target), c.title, JSON.stringify(c.versionIds), JSON.stringify(c.files), c.author, c.createdAt);
  }

  get(id: string): DiffCheck | undefined {
    const r = this.db.prepare('SELECT * FROM diff_checks WHERE id = ?').get(id) as Row | undefined;
    return r && toCheck(r);
  }

  list(): DiffCheck[] {
    return (this.db.prepare('SELECT * FROM diff_checks ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(toCheck);
  }

  /** An earlier check of the same changes against the same document versions (sorted). */
  find(baseSha: string, headSha: string, versionIds: string[]): DiffCheck | undefined {
    const r = this.db.prepare('SELECT * FROM diff_checks WHERE base_sha = ? AND head_sha = ? AND version_ids = ? LIMIT 1').get(baseSha, headSha, JSON.stringify(versionIds)) as Row | undefined;
    return r && toCheck(r);
  }

  addVerdict(v: { checkId: string; itemId: string; status: VerdictStatus; severity: Severity | null; reason: string; evidence: Evidence[] }, by: Authorship): DiffVerdict {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO diff_verdicts (id, check_id, item_id, status, severity, reason, evidence, run_id, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, v.checkId, v.itemId, v.status, v.severity, v.reason, JSON.stringify(v.evidence), by.runId ?? null, by.author, new Date().toISOString());
    return toVerdict(this.db.prepare('SELECT * FROM diff_verdicts WHERE id = ?').get(id) as Row);
  }

  /** Current verdicts of a check by requirement item: the latest record wins. */
  verdicts(checkId: string): Map<string, DiffVerdict> {
    const rows = this.db.prepare('SELECT * FROM diff_verdicts WHERE check_id = ? ORDER BY rowid').all(checkId) as Row[];
    return new Map(rows.map(toVerdict).map((v) => [v.itemId, v]));
  }
}
