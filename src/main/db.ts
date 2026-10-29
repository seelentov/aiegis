import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

/** Ordered schema migrations; index + 1 = user_version after applying. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    role TEXT NOT NULL,
    title TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    last_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX jobs_status ON jobs(status);

  -- Append-only history (SPEC §6): a run is inserted when it starts and finalized exactly once.
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    parent_run_id TEXT,
    kind TEXT NOT NULL,
    role TEXT NOT NULL,
    author TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    config_snapshot TEXT NOT NULL,
    log_path TEXT,
    status TEXT NOT NULL,
    error TEXT,
    tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX runs_job ON runs(job_id);
  CREATE INDEX runs_entity ON runs(entity_type, entity_id);
  CREATE INDEX runs_session ON runs(session_id);
  CREATE TRIGGER runs_immutable BEFORE UPDATE ON runs WHEN OLD.finished_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'run is finalized and immutable'); END;
  CREATE TRIGGER runs_no_delete BEFORE DELETE ON runs
  BEGIN SELECT RAISE(ABORT, 'runs are append-only'); END;

  -- Results written by agents through MCP (stage 1: generic task results).
  CREATE TABLE results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX results_entity ON results(entity_type, entity_id);
  CREATE TRIGGER results_no_update BEFORE UPDATE ON results
  BEGIN SELECT RAISE(ABORT, 'results are append-only'); END;
  CREATE TRIGGER results_no_delete BEFORE DELETE ON results
  BEGIN SELECT RAISE(ABORT, 'results are append-only'); END;
  `,
  `
  -- Modules (SPEC §4, Q7): append-only revisions; the current module is its latest revision unless deleted.
  CREATE TABLE module_revisions (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    name TEXT NOT NULL,
    globs TEXT NOT NULL,
    description TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    run_id TEXT,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX module_revisions_module ON module_revisions(module_id);
  CREATE TRIGGER module_revisions_no_update BEFORE UPDATE ON module_revisions
  BEGIN SELECT RAISE(ABORT, 'module revisions are append-only'); END;
  CREATE TRIGGER module_revisions_no_delete BEFORE DELETE ON module_revisions
  BEGIN SELECT RAISE(ABORT, 'module revisions are append-only'); END;

  -- Entry point map snapshots (SPEC §4, Q12): one per run and module, immutable once finalized.
  CREATE TABLE ep_snapshots (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    globs TEXT NOT NULL,
    status TEXT NOT NULL,
    touched_files TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE (run_id, module_id)
  );
  CREATE INDEX ep_snapshots_module ON ep_snapshots(module_id);
  CREATE TRIGGER ep_snapshots_immutable BEFORE UPDATE ON ep_snapshots WHEN OLD.status <> 'building'
  BEGIN SELECT RAISE(ABORT, 'snapshot is finalized and immutable'); END;
  CREATE TRIGGER ep_snapshots_no_delete BEFORE DELETE ON ep_snapshots
  BEGIN SELECT RAISE(ABORT, 'snapshots are append-only'); END;

  CREATE TABLE entry_points (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES ep_snapshots(id),
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    method TEXT,
    name TEXT NOT NULL,
    handler_file TEXT NOT NULL,
    handler_line INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (snapshot_id, key)
  );
  CREATE TRIGGER entry_points_frozen_insert BEFORE INSERT ON entry_points
  WHEN (SELECT status FROM ep_snapshots WHERE id = NEW.snapshot_id) <> 'building'
  BEGIN SELECT RAISE(ABORT, 'snapshot is finalized and immutable'); END;
  CREATE TRIGGER entry_points_frozen_update BEFORE UPDATE ON entry_points
  WHEN (SELECT status FROM ep_snapshots WHERE id = OLD.snapshot_id) <> 'building'
  BEGIN SELECT RAISE(ABORT, 'snapshot is finalized and immutable'); END;
  CREATE TRIGGER entry_points_frozen_delete BEFORE DELETE ON entry_points
  WHEN (SELECT status FROM ep_snapshots WHERE id = OLD.snapshot_id) <> 'building'
  BEGIN SELECT RAISE(ABORT, 'snapshot is finalized and immutable'); END;
  `,
  `
  -- Scope of the run's token (JSON array of {type, id}); resumed sessions get the same scope.
  ALTER TABLE runs ADD COLUMN scope TEXT;

  -- Documents (SPEC §4, Q17): each import is a version; the latest approved version feeds matrices.
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE doc_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    n INTEGER NOT NULL,
    filename TEXT NOT NULL,
    format TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    approved_by TEXT,
    UNIQUE (document_id, n)
  );
  CREATE TRIGGER doc_versions_frozen BEFORE UPDATE ON doc_versions WHEN OLD.status = 'approved'
  BEGIN SELECT RAISE(ABORT, 'approved version is immutable'); END;
  CREATE TRIGGER doc_versions_no_delete BEFORE DELETE ON doc_versions
  BEGIN SELECT RAISE(ABORT, 'document versions are append-only'); END;

  -- Stable identity of a requirement across versions: document + key.
  CREATE TABLE requirements (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (document_id, key)
  );
  CREATE TABLE req_items (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES doc_versions(id),
    requirement_id TEXT NOT NULL REFERENCES requirements(id),
    key TEXT NOT NULL,
    text TEXT NOT NULL,
    section TEXT NOT NULL,
    quote TEXT NOT NULL,
    review TEXT NOT NULL,
    author TEXT NOT NULL,
    run_id TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (version_id, key)
  );
  CREATE TRIGGER req_items_frozen_insert BEFORE INSERT ON req_items
  WHEN (SELECT status FROM doc_versions WHERE id = NEW.version_id) = 'approved'
  BEGIN SELECT RAISE(ABORT, 'approved version is immutable'); END;
  CREATE TRIGGER req_items_frozen_update BEFORE UPDATE ON req_items
  WHEN (SELECT status FROM doc_versions WHERE id = OLD.version_id) = 'approved'
  BEGIN SELECT RAISE(ABORT, 'approved version is immutable'); END;
  CREATE TRIGGER req_items_frozen_delete BEFORE DELETE ON req_items
  WHEN (SELECT status FROM doc_versions WHERE id = OLD.version_id) = 'approved'
  BEGIN SELECT RAISE(ABORT, 'approved version is immutable'); END;

  CREATE TABLE matrices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    documents TEXT NOT NULL,
    modules TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Cell verdicts (SPEC §4, Q8/Q9): append-only; the latest verdict of (module, requirement) is the cell status.
  CREATE TABLE verdicts (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL REFERENCES requirements(id),
    item_id TEXT NOT NULL REFERENCES req_items(id),
    req_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    touched_files TEXT NOT NULL,
    module_globs TEXT NOT NULL,
    run_id TEXT,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX verdicts_cell ON verdicts(module_id, requirement_id);
  CREATE INDEX verdicts_run ON verdicts(run_id);
  CREATE TRIGGER verdicts_no_update BEFORE UPDATE ON verdicts
  BEGIN SELECT RAISE(ABORT, 'verdicts are append-only'); END;
  CREATE TRIGGER verdicts_no_delete BEFORE DELETE ON verdicts
  BEGIN SELECT RAISE(ABORT, 'verdicts are append-only'); END;

  -- Applicability triage (stage 1 of the matrix); n/a also writes a verdict.
  CREATE TABLE triage (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    req_hash TEXT NOT NULL,
    applicable INTEGER NOT NULL,
    reason TEXT NOT NULL,
    run_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX triage_cell ON triage(module_id, requirement_id);
  CREATE INDEX triage_run ON triage(run_id);
  CREATE TRIGGER triage_no_update BEFORE UPDATE ON triage
  BEGIN SELECT RAISE(ABORT, 'triage is append-only'); END;
  CREATE TRIGGER triage_no_delete BEFORE DELETE ON triage
  BEGIN SELECT RAISE(ABORT, 'triage is append-only'); END;

  -- Findings (SPEC §4, Q9/Q23): immutable record + append-only events (status, merge, links).
  CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL,
    cwe TEXT,
    module_id TEXT,
    entry_point TEXT,
    files TEXT NOT NULL,
    recommendation TEXT,
    run_id TEXT,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER findings_no_update BEFORE UPDATE ON findings
  BEGIN SELECT RAISE(ABORT, 'findings are immutable'); END;
  CREATE TRIGGER findings_no_delete BEFORE DELETE ON findings
  BEGIN SELECT RAISE(ABORT, 'findings are append-only'); END;
  CREATE TABLE finding_events (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL REFERENCES findings(id),
    kind TEXT NOT NULL,
    status TEXT,
    reason TEXT,
    merged_into TEXT,
    module_id TEXT,
    requirement_id TEXT,
    run_id TEXT,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX finding_events_finding ON finding_events(finding_id);
  CREATE INDEX finding_events_cell ON finding_events(module_id, requirement_id);
  CREATE TRIGGER finding_events_no_update BEFORE UPDATE ON finding_events
  BEGIN SELECT RAISE(ABORT, 'finding events are append-only'); END;
  CREATE TRIGGER finding_events_no_delete BEFORE DELETE ON finding_events
  BEGIN SELECT RAISE(ABORT, 'finding events are append-only'); END;

  -- Validity (SPEC §5): whether a verdict or snapshot still holds at a commit; computed without AI.
  CREATE TABLE validity (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    valid INTEGER NOT NULL,
    changed_files TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (entity_type, entity_id, commit_sha)
  );
  `,
  `
  -- Scanner runs (SPEC §4, Q10): one scanner at a commit over a set of paths; immutable once finalized.
  CREATE TABLE scans (
    id TEXT PRIMARY KEY,
    scanner TEXT NOT NULL,
    format TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    targets TEXT NOT NULL,
    status TEXT NOT NULL,
    tool_version TEXT,
    commands TEXT NOT NULL,
    error TEXT,
    job_id TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX scans_commit ON scans(commit_sha, scanner);
  CREATE TRIGGER scans_immutable BEFORE UPDATE ON scans WHEN OLD.status <> 'running'
  BEGIN SELECT RAISE(ABORT, 'scan is finalized and immutable'); END;
  CREATE TRIGGER scans_no_delete BEFORE DELETE ON scans
  BEGIN SELECT RAISE(ABORT, 'scans are append-only'); END;

  -- Normalized scanner results; written only while their scan is running.
  -- Dependency CVEs (kind 'vuln') keep package data in "data" for SCA.
  CREATE TABLE raw_findings (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL REFERENCES scans(id),
    scanner TEXT NOT NULL,
    kind TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER,
    end_line INTEGER,
    cwe TEXT NOT NULL,
    tags TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    snippet TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX raw_findings_scan ON raw_findings(scan_id);
  CREATE INDEX raw_findings_fingerprint ON raw_findings(scanner, fingerprint);
  CREATE TRIGGER raw_findings_frozen_insert BEFORE INSERT ON raw_findings
  WHEN (SELECT status FROM scans WHERE id = NEW.scan_id) <> 'running'
  BEGIN SELECT RAISE(ABORT, 'scan is finalized and immutable'); END;
  CREATE TRIGGER raw_findings_no_update BEFORE UPDATE ON raw_findings
  BEGIN SELECT RAISE(ABORT, 'raw findings are immutable'); END;
  CREATE TRIGGER raw_findings_no_delete BEFORE DELETE ON raw_findings
  BEGIN SELECT RAISE(ABORT, 'raw findings are append-only'); END;

  -- Suppressions (SPEC §4, Q18): append-only; revocation is recorded once.
  CREATE TABLE suppressions (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    scanner TEXT,
    rule_id TEXT,
    fingerprint TEXT,
    globs TEXT NOT NULL,
    file TEXT,
    line INTEGER,
    requirement_id TEXT,
    module_id TEXT,
    reason TEXT NOT NULL,
    author TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    touched_files TEXT NOT NULL,
    module_globs TEXT NOT NULL,
    expires_at TEXT,
    replaces TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by TEXT,
    revoke_reason TEXT
  );
  CREATE TRIGGER suppressions_revoke_once BEFORE UPDATE ON suppressions
  WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
    OR NEW.id IS NOT OLD.id OR NEW.scope IS NOT OLD.scope OR NEW.scanner IS NOT OLD.scanner OR NEW.rule_id IS NOT OLD.rule_id
    OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.globs IS NOT OLD.globs OR NEW.requirement_id IS NOT OLD.requirement_id
    OR NEW.module_id IS NOT OLD.module_id OR NEW.reason IS NOT OLD.reason OR NEW.author IS NOT OLD.author
    OR NEW.commit_sha IS NOT OLD.commit_sha OR NEW.touched_files IS NOT OLD.touched_files OR NEW.expires_at IS NOT OLD.expires_at
  BEGIN SELECT RAISE(ABORT, 'suppressions are append-only; only a single revocation is allowed'); END;
  CREATE TRIGGER suppressions_no_delete BEFORE DELETE ON suppressions
  BEGIN SELECT RAISE(ABORT, 'suppressions are append-only'); END;
  `,
  `
  -- Non-fatal scanner problems (files the tool could not parse), JSON array; set when the scan is finalized.
  ALTER TABLE scans ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]';
  `,
  `
  -- SCA inputs (SPEC §4, Q11): ready-made dependency files uploaded by a human (lock files, SBOMs, scanner reports)
  -- for a module or the whole project; removal is recorded once.
  CREATE TABLE sca_inputs (
    id TEXT PRIMARY KEY,
    module_id TEXT,
    filename TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    note TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL,
    removed_at TEXT,
    removed_by TEXT
  );
  CREATE TRIGGER sca_inputs_remove_once BEFORE UPDATE ON sca_inputs
  WHEN OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NEW.id IS NOT OLD.id OR NEW.module_id IS NOT OLD.module_id
    OR NEW.filename IS NOT OLD.filename OR NEW.sha256 IS NOT OLD.sha256 OR NEW.note IS NOT OLD.note OR NEW.author IS NOT OLD.author
  BEGIN SELECT RAISE(ABORT, 'sca inputs are append-only; only a single removal is allowed'); END;
  CREATE TRIGGER sca_inputs_no_delete BEFORE DELETE ON sca_inputs
  BEGIN SELECT RAISE(ABORT, 'sca inputs are append-only'); END;

  -- Dependency inventory of a module built by an AI run (one per run and module), immutable once finalized.
  CREATE TABLE sca_inventories (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    globs TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE (run_id, module_id)
  );
  CREATE INDEX sca_inventories_module ON sca_inventories(module_id);
  CREATE TRIGGER sca_inventories_immutable BEFORE UPDATE ON sca_inventories WHEN OLD.status <> 'building'
  BEGIN SELECT RAISE(ABORT, 'inventory is finalized and immutable'); END;
  CREATE TRIGGER sca_inventories_no_delete BEFORE DELETE ON sca_inventories
  BEGIN SELECT RAISE(ABORT, 'inventories are append-only'); END;

  -- Tool reports the inventory agent produced; copied out of the worktree, vulnerabilities must be found in them.
  CREATE TABLE sca_reports (
    id TEXT PRIMARY KEY,
    inventory_id TEXT NOT NULL REFERENCES sca_inventories(id),
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (inventory_id, path, sha256)
  );

  -- Vulnerable packages of an inventory (package@version) and their vulnerabilities.
  CREATE TABLE sca_packages (
    id TEXT PRIMARY KEY,
    inventory_id TEXT NOT NULL REFERENCES sca_inventories(id),
    key TEXT NOT NULL,
    ecosystem TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    data TEXT NOT NULL,
    UNIQUE (inventory_id, key)
  );
  CREATE TABLE sca_vulns (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL REFERENCES sca_packages(id),
    vuln_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    report_id TEXT NOT NULL REFERENCES sca_reports(id),
    data TEXT NOT NULL,
    UNIQUE (package_id, vuln_id)
  );
  CREATE TRIGGER sca_reports_frozen BEFORE INSERT ON sca_reports
  WHEN (SELECT status FROM sca_inventories WHERE id = NEW.inventory_id) <> 'building'
  BEGIN SELECT RAISE(ABORT, 'inventory is finalized and immutable'); END;
  CREATE TRIGGER sca_packages_frozen_insert BEFORE INSERT ON sca_packages
  WHEN (SELECT status FROM sca_inventories WHERE id = NEW.inventory_id) <> 'building'
  BEGIN SELECT RAISE(ABORT, 'inventory is finalized and immutable'); END;
  CREATE TRIGGER sca_packages_frozen_update BEFORE UPDATE ON sca_packages
  WHEN (SELECT status FROM sca_inventories WHERE id = OLD.inventory_id) <> 'building'
  BEGIN SELECT RAISE(ABORT, 'inventory is finalized and immutable'); END;
  CREATE TRIGGER sca_packages_frozen_delete BEFORE DELETE ON sca_packages
  WHEN (SELECT status FROM sca_inventories WHERE id = OLD.inventory_id) <> 'building'
  BEGIN SELECT RAISE(ABORT, 'inventory is finalized and immutable'); END;
  CREATE TRIGGER sca_vulns_frozen_insert BEFORE INSERT ON sca_vulns
  WHEN (SELECT i.status FROM sca_packages p JOIN sca_inventories i ON i.id = p.inventory_id WHERE p.id = NEW.package_id) <> 'building'
  BEGIN SELECT RAISE(ABORT, 'inventory is finalized and immutable'); END;
  CREATE TRIGGER sca_vulns_frozen_delete BEFORE DELETE ON sca_vulns
  WHEN (SELECT i.status FROM sca_packages p JOIN sca_inventories i ON i.id = p.inventory_id WHERE p.id = OLD.package_id) <> 'building'
  BEGIN SELECT RAISE(ABORT, 'inventory is finalized and immutable'); END;
  CREATE TRIGGER sca_vulns_no_update BEFORE UPDATE ON sca_vulns
  BEGIN SELECT RAISE(ABORT, 'vulnerabilities are replaced, not updated'); END;

  -- Reachability verdicts of SCA items (module x package@version x vulnerability): append-only, latest = status.
  CREATE TABLE sca_verdicts (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL,
    package_key TEXT NOT NULL,
    vuln_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    touched_files TEXT NOT NULL,
    module_globs TEXT NOT NULL,
    run_id TEXT,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX sca_verdicts_item ON sca_verdicts(module_id, package_key, vuln_id);
  CREATE INDEX sca_verdicts_run ON sca_verdicts(run_id);
  CREATE TRIGGER sca_verdicts_no_update BEFORE UPDATE ON sca_verdicts
  BEGIN SELECT RAISE(ABORT, 'sca verdicts are append-only'); END;
  CREATE TRIGGER sca_verdicts_no_delete BEFORE DELETE ON sca_verdicts
  BEGIN SELECT RAISE(ABORT, 'sca verdicts are append-only'); END;

  -- Findings link to SCA items too (a reachable CVE gives a finding): link events with package and vulnerability.
  ALTER TABLE finding_events ADD COLUMN package_key TEXT;
  ALTER TABLE finding_events ADD COLUMN vuln_id TEXT;
  `,
  `
  -- PoC tester results of findings (SPEC §4, Q14): append-only, latest = current; the status stays a human decision.
  CREATE TABLE poc_results (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL REFERENCES findings(id),
    outcome TEXT NOT NULL,
    summary TEXT NOT NULL,
    steps TEXT NOT NULL,
    base_url TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    run_id TEXT,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX poc_results_finding ON poc_results(finding_id);
  CREATE TRIGGER poc_results_no_update BEFORE UPDATE ON poc_results
  BEGIN SELECT RAISE(ABORT, 'poc results are append-only'); END;
  CREATE TRIGGER poc_results_no_delete BEFORE DELETE ON poc_results
  BEGIN SELECT RAISE(ABORT, 'poc results are append-only'); END;
  `,
];

export function migrate(db: DB): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
