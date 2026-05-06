import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';

export type Db = Database.Database;

const SCHEMA_VERSION = 3;

const MIGRATIONS: string[] = [
  // v1 — original schema. FROZEN: edit by adding a new migration below.
  `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS sessions (
    thread_ts            TEXT    PRIMARY KEY,
    opencode_session_id  TEXT,
    repo_path            TEXT    NOT NULL,
    model_override       TEXT,
    agent_override       TEXT,
    last_active_at       INTEGER NOT NULL,
    total_tokens         INTEGER NOT NULL DEFAULT 0,
    total_cost_usd       REAL    NOT NULL DEFAULT 0.0
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_last_active
    ON sessions(last_active_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    user_id      TEXT    NOT NULL,
    command      TEXT    NOT NULL,
    repo         TEXT,
    exit_code    INTEGER,
    duration_ms  INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_audit_ts   ON audit_log(ts);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
  `,

  // v2 — sessions.user_id (Decisions §6 audit + per-user cost rollups).
  `
  ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT '';

  CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON sessions(user_id);
  `,

  // v3 — meta kv, bookmarks, background_jobs, scheduled_tasks.
  `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT    NOT NULL,
    channel     TEXT    NOT NULL,
    message_ts  TEXT    NOT NULL,
    snippet     TEXT,
    permalink   TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bookmarks_user
    ON bookmarks(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS background_jobs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            TEXT    NOT NULL,
    initiating_channel TEXT    NOT NULL,
    initiating_ts      TEXT    NOT NULL,
    prompt             TEXT    NOT NULL,
    agent              TEXT,
    repo_path          TEXT,
    status             TEXT    NOT NULL DEFAULT 'pending',
    created_at         INTEGER NOT NULL,
    started_at         INTEGER,
    completed_at       INTEGER,
    result_text        TEXT,
    exit_code          INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_bg_status
    ON background_jobs(status, created_at);

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           TEXT    NOT NULL,
    channel           TEXT    NOT NULL,
    schedule_kind     TEXT    NOT NULL,
    schedule_hour     INTEGER,
    schedule_minute   INTEGER,
    schedule_weekday  INTEGER,
    command_text      TEXT    NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    last_run_at       INTEGER,
    next_run_at       INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sched_next
    ON scheduled_tasks(enabled, next_run_at);
  `,
];

export function initDb(config: Config): Db {
  const dbPath = join(config.DATA_DIR, 'state.db');
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `Failed to create DATA_DIR (${config.DATA_DIR}): ${msg}\n` +
        `Set DATA_DIR to an absolute, writable path. Under systemd this typically means /var/lib/opencode-slack-bot.`,
    );
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  applyMigrations(db);

  return db;
}

export function applyMigrations(db: Db): void {
  ensureSchemaVersionTable(db);
  const current = currentVersion(db);

  for (let v = current; v < SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) throw new Error(`Migration ${v + 1} missing`);
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT OR REPLACE INTO schema_version (version) VALUES (?)',
      ).run(v + 1);
    })();
  }
}

function ensureSchemaVersionTable(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)',
  );
}

function currentVersion(db: Db): number {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}
