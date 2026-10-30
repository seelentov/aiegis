import crypto from 'node:crypto';
import type { DB } from './db';
import type { RawFinding, Scan, ScanStatus, SignalKind, Severity, Suppression, SuppressionScope } from '../shared/types';
import type { NormalizedFinding } from './scanners/normalize';

const now = () => new Date().toISOString();

type Row = Record<string, unknown>;

const SCAN_SELECT = `SELECT s.*, (SELECT COUNT(*) FROM raw_findings f WHERE f.scan_id = s.id) AS finding_count FROM scans s`;

function toScan(r: Row): Scan {
  return {
    id: r.id as string,
    scanner: r.scanner as string,
    format: r.format as string,
    commitSha: r.commit_sha as string,
    targets: JSON.parse(r.targets as string),
    status: r.status as ScanStatus,
    toolVersion: (r.tool_version as string) ?? null,
    commands: JSON.parse(r.commands as string),
    error: (r.error as string) ?? null,
    warnings: JSON.parse((r.warnings as string) ?? '[]'),
    findingCount: r.finding_count as number,
    jobId: (r.job_id as string) ?? null,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

function toRawFinding(r: Row): RawFinding {
  return {
    id: r.id as string,
    scanId: r.scan_id as string,
    scanner: r.scanner as string,
    kind: r.kind as SignalKind,
    ruleId: r.rule_id as string,
    severity: r.severity as Severity,
    title: r.title as string,
    message: r.message as string,
    file: r.file as string,
    line: (r.line as number) ?? null,
    endLine: (r.end_line as number) ?? null,
    cwe: JSON.parse(r.cwe as string),
    tags: JSON.parse(r.tags as string),
    fingerprint: r.fingerprint as string,
    snippet: (r.snippet as string) ?? null,
    data: JSON.parse(r.data as string),
  };
}

function toSuppression(r: Row): Suppression {
  return {
    id: r.id as string,
    scope: r.scope as SuppressionScope,
    scanner: (r.scanner as string) ?? null,
    ruleId: (r.rule_id as string) ?? null,
    fingerprint: (r.fingerprint as string) ?? null,
    globs: JSON.parse(r.globs as string),
    file: (r.file as string) ?? null,
    line: (r.line as number) ?? null,
    requirementId: (r.requirement_id as string) ?? null,
    moduleId: (r.module_id as string) ?? null,
    reason: r.reason as string,
    author: r.author as string,
    commitSha: r.commit_sha as string,
    touchedFiles: JSON.parse(r.touched_files as string),
    moduleGlobs: JSON.parse(r.module_globs as string),
    expiresAt: (r.expires_at as string) ?? null,
    replaces: (r.replaces as string) ?? null,
    createdAt: r.created_at as string,
    revokedAt: (r.revoked_at as string) ?? null,
    revokedBy: (r.revoked_by as string) ?? null,
    revokeReason: (r.revoke_reason as string) ?? null,
  };
}

export type NewSuppression = Omit<Suppression, 'id' | 'createdAt' | 'revokedAt' | 'revokedBy' | 'revokeReason'>;

/** Scans, normalized scanner results (`raw_findings`) and suppressions of one project. */
export class SignalStore {
  constructor(readonly db: DB) {}

  // --- scans ---

  startScan(s: { scanner: string; format: string; commitSha: string; targets: string[]; jobId: string | null }, id: string = crypto.randomUUID()): Scan {
    this.db
      .prepare(`INSERT INTO scans (id, scanner, format, commit_sha, targets, status, commands, job_id, started_at) VALUES (?, ?, ?, ?, ?, 'running', '[]', ?, ?)`)
      .run(id, s.scanner, s.format, s.commitSha, JSON.stringify(s.targets), s.jobId, now());
    return this.getScan(id)!;
  }

  addFindings(scanId: string, rows: NormalizedFinding[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO raw_findings (id, scan_id, scanner, kind, rule_id, severity, title, message, file, line, end_line, cwe, tags, fingerprint, snippet, data)
       VALUES (?, ?, (SELECT scanner FROM scans WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const f of rows) {
        stmt.run(
          crypto.randomUUID(),
          scanId,
          scanId,
          f.kind,
          f.ruleId,
          f.severity,
          f.title,
          f.message,
          f.file,
          f.line,
          f.endLine,
          JSON.stringify(f.cwe),
          JSON.stringify(f.tags),
          f.fingerprint,
          f.snippet,
          JSON.stringify(f.data),
        );
      }
    })();
  }

  /** Finalizes a running scan; afterwards the scan and its findings are immutable. */
  finishScan(
    id: string,
    status: Exclude<ScanStatus, 'running'>,
    o: { toolVersion: string | null; commands: string[][]; error: string | null; warnings?: string[] },
  ): void {
    this.db
      .prepare(`UPDATE scans SET status = ?, tool_version = ?, commands = ?, error = ?, warnings = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
      .run(status, o.toolVersion, JSON.stringify(o.commands), o.error, JSON.stringify(o.warnings ?? []), now(), id);
  }

  getScan(id: string): Scan | undefined {
    const r = this.db.prepare(`${SCAN_SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
    return r && toScan(r);
  }

  /** Newest first. */
  listScans(limit = 500): Scan[] {
    return (this.db.prepare(`${SCAN_SELECT} ORDER BY s.started_at DESC, s.rowid DESC LIMIT ?`).all(limit) as Row[]).map(toScan);
  }

  /** Complete scans, newest first; optionally of one commit. */
  completeScans(commitSha?: string): Scan[] {
    const rows = commitSha
      ? this.db.prepare(`${SCAN_SELECT} WHERE s.status = 'complete' AND s.commit_sha = ? ORDER BY s.finished_at DESC, s.rowid DESC`).all(commitSha)
      : this.db.prepare(`${SCAN_SELECT} WHERE s.status = 'complete' ORDER BY s.finished_at DESC, s.rowid DESC`).all();
    return (rows as Row[]).map(toScan);
  }

  scanFindings(scanId: string): RawFinding[] {
    return (this.db.prepare('SELECT * FROM raw_findings WHERE scan_id = ? ORDER BY file, line, rowid').all(scanId) as Row[]).map(toRawFinding);
  }

  getFinding(id: string): RawFinding | undefined {
    const r = this.db.prepare('SELECT * FROM raw_findings WHERE id = ?').get(id) as Row | undefined;
    return r && toRawFinding(r);
  }

  /** After a crash, scans left running are finalized as failed. */
  recoverScans(): number {
    return this.db
      .prepare(`UPDATE scans SET status = 'failed', error = 'interrupted: the app exited during the scan', finished_at = ? WHERE status = 'running'`)
      .run(now()).changes;
  }

  // --- suppressions ---

  addSuppression(s: NewSuppression): Suppression {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO suppressions (id, scope, scanner, rule_id, fingerprint, globs, file, line, requirement_id, module_id, reason, author,
                                   commit_sha, touched_files, module_globs, expires_at, replaces, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        s.scope,
        s.scanner,
        s.ruleId,
        s.fingerprint,
        JSON.stringify(s.globs),
        s.file,
        s.line,
        s.requirementId,
        s.moduleId,
        s.reason,
        s.author,
        s.commitSha,
        JSON.stringify(s.touchedFiles),
        JSON.stringify(s.moduleGlobs),
        s.expiresAt,
        s.replaces,
        now(),
      );
    return this.getSuppression(id)!;
  }

  getSuppression(id: string): Suppression | undefined {
    const r = this.db.prepare('SELECT * FROM suppressions WHERE id = ?').get(id) as Row | undefined;
    return r && toSuppression(r);
  }

  /** Newest first. */
  listSuppressions(): Suppression[] {
    return (this.db.prepare('SELECT * FROM suppressions ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(toSuppression);
  }

  revokeSuppression(id: string, by: string, reason: string): Suppression {
    const s = this.getSuppression(id);
    if (!s) throw new Error(`suppression ${id} not found`);
    if (s.revokedAt) throw new Error('suppression already revoked');
    this.db.prepare('UPDATE suppressions SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?').run(now(), by, reason, id);
    return this.getSuppression(id)!;
  }
}
