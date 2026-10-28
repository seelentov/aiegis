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
