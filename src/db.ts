import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';

export type Db = Database.Database;

const SCHEMA_VERSION = 2;

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
