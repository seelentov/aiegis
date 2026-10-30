import crypto from 'node:crypto';
import type { DB } from './db';
import type {
  Evidence,
  InventoryStatus,
  InventorySummary,
  Run,
  ScaInput,
  ScaInventory,
  ScaItemRef,
  ScaPackage,
  ScaReport,
  ScaVerdict,
  ScaVerdictStatus,
  ScaVuln,
  Severity,
} from '../shared/types';
import { packageKey, scaItemId } from './sca';
import type { Authorship } from './store';

const now = () => new Date().toISOString();

type Row = Record<string, unknown>;

const INVENTORY_SELECT = `SELECT i.*,
  (SELECT COUNT(*) FROM sca_packages p WHERE p.inventory_id = i.id) AS package_count,
  (SELECT COUNT(*) FROM sca_vulns v JOIN sca_packages p ON p.id = v.package_id WHERE p.inventory_id = i.id) AS vuln_count
  FROM sca_inventories i`;

function toInput(r: Row): ScaInput {
  return {
    id: r.id as string,
    moduleId: (r.module_id as string) ?? null,
    filename: r.filename as string,
    sha256: r.sha256 as string,
    note: r.note as string,
    author: r.author as string,
    createdAt: r.created_at as string,
    removedAt: (r.removed_at as string) ?? null,
    removedBy: (r.removed_by as string) ?? null,
  };
}

function toInventory(r: Row): ScaInventory {
  return {
    id: r.id as string,
    moduleId: r.module_id as string,
    runId: r.run_id as string,
    commitSha: r.commit_sha as string,
    globs: JSON.parse(r.globs as string),
    status: r.status as InventoryStatus,
    summary: r.summary ? JSON.parse(r.summary as string) : null,
    packageCount: r.package_count as number,
    vulnCount: r.vuln_count as number,
    createdAt: r.created_at as string,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

function toReport(r: Row): ScaReport {
  return {
    id: r.id as string,
    inventoryId: r.inventory_id as string,
    path: r.path as string,
    sha256: r.sha256 as string,
    size: r.size as number,
    createdAt: r.created_at as string,
  };
}

function toVuln(r: Row): ScaVuln {
  const d = JSON.parse(r.data as string);
  return {
    id: r.id as string,
    packageId: r.package_id as string,
    vulnId: r.vuln_id as string,
    aliases: d.aliases ?? [],
    severity: r.severity as Severity,
    title: d.title ?? null,
    fixedVersion: d.fixedVersion ?? null,
    reportId: r.report_id as string,
  };
}

function toVerdict(r: Row): ScaVerdict {
  return {
    id: r.id as string,
    moduleId: r.module_id as string,
    packageKey: r.package_key as string,
    vulnId: r.vuln_id as string,
    status: r.status as ScaVerdictStatus,
    reason: r.reason as string,
    evidence: JSON.parse(r.evidence as string),
    commitSha: r.commit_sha as string,
    touchedFiles: JSON.parse(r.touched_files as string),
    moduleGlobs: JSON.parse(r.module_globs as string),
    runId: (r.run_id as string) ?? null,
    author: r.author as string,
    createdAt: r.created_at as string,
  };
}

export interface NewScaPackage {
  ecosystem: string;
  name: string;
  version: string;
  direct: boolean | null;
  importNames: string[];
  manifest: string | null;
  purl: string | null;
  vulns: { id: string; aliases: string[]; severity: Severity; title: string | null; fixedVersion: string | null }[];
}

export interface NewScaVerdict extends ScaItemRef {
  status: ScaVerdictStatus;
  reason: string;
  evidence: Evidence[];
  commitSha: string;
  touchedFiles: string[];
  moduleGlobs: string[];
}

/** SCA inputs, dependency inventories and reachability verdicts of one project. */
export class ScaStore {
  constructor(readonly db: DB) {}

  // --- inputs ---

  addInput(i: { moduleId: string | null; filename: string; sha256: string; note: string; author: string }, id: string = crypto.randomUUID()): ScaInput {
    this.db
      .prepare('INSERT INTO sca_inputs (id, module_id, filename, sha256, note, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, i.moduleId, i.filename, i.sha256, i.note, i.author, now());
    return this.getInput(id)!;
  }

  getInput(id: string): ScaInput | undefined {
    const r = this.db.prepare('SELECT * FROM sca_inputs WHERE id = ?').get(id) as Row | undefined;
    return r && toInput(r);
  }

  /** Newest first; removed ones too. */
  listInputs(): ScaInput[] {
    return (this.db.prepare('SELECT * FROM sca_inputs ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(toInput);
  }

  /** Live inputs of a module: its own and the project-wide ones. */
  inputsFor(moduleId: string): ScaInput[] {
    return this.listInputs().filter((i) => !i.removedAt && (i.moduleId === null || i.moduleId === moduleId));
  }

  removeInput(id: string, by: string): ScaInput {
    const i = this.getInput(id);
    if (!i) throw new Error(`file ${id} not found`);
    if (i.removedAt) throw new Error('file already excluded');
    this.db.prepare('UPDATE sca_inputs SET removed_at = ?, removed_by = ? WHERE id = ?').run(now(), by, id);
    return this.getInput(id)!;
  }

  // --- inventories ---

  getInventory(id: string): ScaInventory | undefined {
    const r = this.db.prepare(`${INVENTORY_SELECT} WHERE i.id = ?`).get(id) as Row | undefined;
    return r && toInventory(r);
  }

  inventoryOf(runId: string, moduleId: string): ScaInventory | undefined {
    const r = this.db.prepare(`${INVENTORY_SELECT} WHERE i.run_id = ? AND i.module_id = ?`).get(runId, moduleId) as Row | undefined;
    return r && toInventory(r);
  }

  /** Newest first. */
  listInventories(moduleId: string): ScaInventory[] {
    return (this.db.prepare(`${INVENTORY_SELECT} WHERE i.module_id = ? ORDER BY i.created_at DESC, i.rowid DESC`).all(moduleId) as Row[]).map(toInventory);
  }

  /** Current inventory of a module = its latest complete one. */
  latestInventory(moduleId: string): ScaInventory | undefined {
    return this.listInventories(moduleId).find((i) => i.status === 'complete');
  }

  /** Inventory a run writes into, created on first write; a resumed session starts from its parent run's inventory. */
  ensureInventory(run: Run, mod: { id: string; globs: string[] }): ScaInventory {
    const existing = this.inventoryOf(run.id, mod.id);
    if (existing) return existing;
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO sca_inventories (id, module_id, run_id, commit_sha, globs, status, created_at) VALUES (?, ?, ?, ?, ?, 'building', ?)`)
        .run(id, mod.id, run.id, run.commitSha, JSON.stringify(mod.globs), now());
      const parent = run.parentRunId ? this.inventoryOf(run.parentRunId, mod.id) : undefined;
      if (!parent) return;
      const reportIds = new Map<string, string>();
      for (const r of this.listReports(parent.id)) reportIds.set(r.id, this.addReport(id, { path: r.path, sha256: r.sha256, size: r.size }).id);
      for (const p of this.listPackages(parent.id)) {
        this.upsertPackage(id, p, (v) => reportIds.get(p.vulns.find((x) => x.vulnId === v)!.reportId)!);
      }
      if (parent.summary) this.setSummary(id, parent.summary);
    })();
    return this.getInventory(id)!;
  }

  setSummary(inventoryId: string, s: InventorySummary): void {
    this.db.prepare(`UPDATE sca_inventories SET summary = ? WHERE id = ?`).run(JSON.stringify(s), inventoryId);
  }

  /** Finalizes the inventories a run was building: complete on success with a summary, failed otherwise. */
  finalizeInventories(runId: string, ok: boolean): void {
    this.db
      .prepare(
        `UPDATE sca_inventories SET status = CASE WHEN ? AND summary IS NOT NULL THEN 'complete' ELSE 'failed' END, finished_at = ?
         WHERE run_id = ? AND status = 'building'`,
      )
      .run(ok ? 1 : 0, now(), runId);
  }

  /** After a crash, inventories of finalized runs that are still building are marked failed. */
  recoverInventories(): number {
    return this.db
      .prepare(
        `UPDATE sca_inventories SET status = 'failed', finished_at = ?
         WHERE status = 'building' AND run_id IN (SELECT id FROM runs WHERE finished_at IS NOT NULL)`,
      )
      .run(now()).changes;
  }

  // --- reports, packages, vulnerabilities ---

  /** Registers a report (same path and content once per inventory). */
  addReport(inventoryId: string, r: { path: string; sha256: string; size: number }): ScaReport {
    const existing = this.db.prepare('SELECT * FROM sca_reports WHERE inventory_id = ? AND path = ? AND sha256 = ?').get(inventoryId, r.path, r.sha256) as
      | Row
      | undefined;
    if (existing) return toReport(existing);
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO sca_reports (id, inventory_id, path, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, inventoryId, r.path, r.sha256, r.size, now());
    return toReport(this.db.prepare('SELECT * FROM sca_reports WHERE id = ?').get(id) as Row);
  }

  getReport(id: string): ScaReport | undefined {
    const r = this.db.prepare('SELECT * FROM sca_reports WHERE id = ?').get(id) as Row | undefined;
    return r && toReport(r);
  }

  listReports(inventoryId: string): ScaReport[] {
    return (this.db.prepare('SELECT * FROM sca_reports WHERE inventory_id = ? ORDER BY rowid').all(inventoryId) as Row[]).map(toReport);
  }

  /** Adds a vulnerable package to an inventory or replaces the one with the same key (vulnerabilities too). */
  upsertPackage(inventoryId: string, p: NewScaPackage | ScaPackage, reportOf: (vulnId: string) => string): ScaPackage {
    const key = packageKey(p.ecosystem, p.name, p.version);
    const data = JSON.stringify({ direct: p.direct, importNames: p.importNames, manifest: p.manifest, purl: p.purl });
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT id FROM sca_packages WHERE inventory_id = ? AND key = ?').get(inventoryId, key) as { id: string } | undefined;
      let id = old?.id;
      if (id) {
        this.db.prepare('DELETE FROM sca_vulns WHERE package_id = ?').run(id);
        this.db.prepare('UPDATE sca_packages SET data = ? WHERE id = ?').run(data, id);
      } else {
        id = crypto.randomUUID();
        this.db
          .prepare('INSERT INTO sca_packages (id, inventory_id, key, ecosystem, name, version, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, inventoryId, key, p.ecosystem.trim().toLowerCase(), p.name.trim(), p.version.trim(), data);
      }
      const stmt = this.db.prepare('INSERT INTO sca_vulns (id, package_id, vuln_id, severity, report_id, data) VALUES (?, ?, ?, ?, ?, ?)');
      for (const v of p.vulns) {
        const vulnId = 'vulnId' in v ? v.vulnId : v.id;
        stmt.run(crypto.randomUUID(), id, vulnId, v.severity, reportOf(vulnId), JSON.stringify({ aliases: v.aliases, title: v.title, fixedVersion: v.fixedVersion }));
      }
      return this.getPackage(id)!;
    })();
  }

  private vulnsOf(packageIds: string[]): Map<string, ScaVuln[]> {
    const out = new Map<string, ScaVuln[]>();
    if (!packageIds.length) return out;
    const rows = this.db.prepare(`SELECT * FROM sca_vulns WHERE package_id IN (${packageIds.map(() => '?').join(',')}) ORDER BY vuln_id`).all(...packageIds) as Row[];
    for (const v of rows.map(toVuln)) out.set(v.packageId, [...(out.get(v.packageId) ?? []), v]);
    return out;
  }

  private toPackage(r: Row, vulns: ScaVuln[]): ScaPackage {
    const d = JSON.parse(r.data as string);
    return {
      id: r.id as string,
      inventoryId: r.inventory_id as string,
      key: r.key as string,
      ecosystem: r.ecosystem as string,
      name: r.name as string,
      version: r.version as string,
      direct: d.direct ?? null,
      importNames: d.importNames ?? [],
      manifest: d.manifest ?? null,
      purl: d.purl ?? null,
      vulns,
    };
  }

  getPackage(id: string): ScaPackage | undefined {
    const r = this.db.prepare('SELECT * FROM sca_packages WHERE id = ?').get(id) as Row | undefined;
    return r && this.toPackage(r, this.vulnsOf([id]).get(id) ?? []);
  }

  listPackages(inventoryId: string): ScaPackage[] {
    const rows = this.db.prepare('SELECT * FROM sca_packages WHERE inventory_id = ? ORDER BY name, version').all(inventoryId) as Row[];
    const vulns = this.vulnsOf(rows.map((r) => r.id as string));
    return rows.map((r) => this.toPackage(r, vulns.get(r.id as string) ?? []));
  }

  removePackage(inventoryId: string, key: string): boolean {
    const p = this.db.prepare('SELECT id FROM sca_packages WHERE inventory_id = ? AND key = ?').get(inventoryId, key) as { id: string } | undefined;
    if (!p) return false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM sca_vulns WHERE package_id = ?').run(p.id);
      this.db.prepare('DELETE FROM sca_packages WHERE id = ?').run(p.id);
    })();
    return true;
  }

  // --- verdicts ---

  addVerdict(v: NewScaVerdict, by: Authorship): ScaVerdict {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO sca_verdicts (id, module_id, package_key, vuln_id, status, reason, evidence, commit_sha, touched_files, module_globs, run_id, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        v.moduleId,
        v.packageKey,
        v.vulnId,
        v.status,
        v.reason,
        JSON.stringify(v.evidence),
        v.commitSha,
        JSON.stringify(v.touchedFiles),
        JSON.stringify(v.moduleGlobs),
        by.runId,
        by.author,
        now(),
      );
    return toVerdict(this.db.prepare('SELECT * FROM sca_verdicts WHERE id = ?').get(id) as Row);
  }

  /** Newest first. */
  verdictHistory(x: ScaItemRef): ScaVerdict[] {
    return (
      this.db
        .prepare('SELECT * FROM sca_verdicts WHERE module_id = ? AND package_key = ? AND vuln_id = ? ORDER BY created_at DESC, rowid DESC')
        .all(x.moduleId, x.packageKey, x.vulnId) as Row[]
    ).map(toVerdict);
  }

  /** Current verdict of every SCA item that has one, keyed by item id. */
  latestVerdicts(): Map<string, ScaVerdict> {
    const rows = this.db
      .prepare(
        `SELECT * FROM sca_verdicts v WHERE rowid = (SELECT MAX(rowid) FROM sca_verdicts
           WHERE module_id = v.module_id AND package_key = v.package_key AND vuln_id = v.vuln_id)`,
      )
      .all() as Row[];
    return new Map(rows.map(toVerdict).map((v) => [scaItemId(v), v]));
  }

  verdictsOfRuns(runIds: string[]): ScaVerdict[] {
    if (!runIds.length) return [];
    return (this.db.prepare(`SELECT * FROM sca_verdicts WHERE run_id IN (${runIds.map(() => '?').join(',')})`).all(...runIds) as Row[]).map(toVerdict);
  }
}
