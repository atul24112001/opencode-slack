import type { Db } from './db.js';

export interface AuditEntryInput {
  ts: number;
  userId: string;
  command: string;
  repo: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

export interface AuditWriter {
  log(entry: AuditEntryInput): void;
}

export function createAuditWriter(db: Db): AuditWriter {
  const stmt = db.prepare(
    `INSERT INTO audit_log (ts, user_id, command, repo, exit_code, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return {
    log(entry) {
      stmt.run(
        entry.ts,
        entry.userId,
        entry.command,
        entry.repo,
        entry.exitCode,
        entry.durationMs,
      );
    },
  };
}
