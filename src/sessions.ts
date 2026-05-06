import type { Db } from './db.js';
import type { Session } from './types.js';

export interface SessionStore {
  get(threadTs: string): Session | undefined;
  set(threadTs: string, session: Session): void;
  upsert(
    threadTs: string,
    updater: (current: Session | undefined) => Session,
  ): Session;
  delete(threadTs: string): boolean;

  costForUserSinceMs(userId: string, sinceMs: number): { tokens: number; costUsd: number };
  costForAllSinceMs(sinceMs: number): { tokens: number; costUsd: number };
  pruneOlderThanMs(cutoffMs: number): number;
}

interface SessionRow {
  thread_ts: string;
  user_id: string;
  opencode_session_id: string | null;
  repo_path: string;
  model_override: string | null;
  agent_override: string | null;
  last_active_at: number;
  total_tokens: number;
  total_cost_usd: number;
}

function rowToSession(row: SessionRow): Session {
  return {
    threadTs: row.thread_ts,
    userId: row.user_id,
    opencodeSessionId: row.opencode_session_id,
    repoPath: row.repo_path,
    modelOverride: row.model_override,
    agentOverride: row.agent_override,
    lastActiveAt: row.last_active_at,
    totalTokens: row.total_tokens,
    totalCostUsd: row.total_cost_usd,
  };
}

export function createSqliteSessionStore(db: Db): SessionStore {
  const selectStmt = db.prepare<[string], SessionRow>(
    `SELECT * FROM sessions WHERE thread_ts = ?`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO sessions
       (thread_ts, user_id, opencode_session_id, repo_path,
        model_override, agent_override, last_active_at,
        total_tokens, total_cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_ts) DO UPDATE SET
       user_id = excluded.user_id,
       opencode_session_id = excluded.opencode_session_id,
       repo_path = excluded.repo_path,
       model_override = excluded.model_override,
       agent_override = excluded.agent_override,
       last_active_at = excluded.last_active_at,
       total_tokens = excluded.total_tokens,
       total_cost_usd = excluded.total_cost_usd`,
  );
  const deleteStmt = db.prepare<[string]>(
    `DELETE FROM sessions WHERE thread_ts = ?`,
  );
  const costUserStmt = db.prepare<[string, number], { tokens: number | null; cost: number | null }>(
    `SELECT SUM(total_tokens) AS tokens, SUM(total_cost_usd) AS cost
     FROM sessions
     WHERE user_id = ? AND last_active_at >= ?`,
  );
  const costAllStmt = db.prepare<[number], { tokens: number | null; cost: number | null }>(
    `SELECT SUM(total_tokens) AS tokens, SUM(total_cost_usd) AS cost
     FROM sessions
     WHERE last_active_at >= ?`,
  );
  const pruneStmt = db.prepare<[number]>(
    `DELETE FROM sessions WHERE last_active_at < ?`,
  );

  function persist(session: Session): void {
    upsertStmt.run(
      session.threadTs,
      session.userId,
      session.opencodeSessionId,
      session.repoPath,
      session.modelOverride,
      session.agentOverride,
      session.lastActiveAt,
      session.totalTokens,
      session.totalCostUsd,
    );
  }

  return {
    get(threadTs) {
      const row = selectStmt.get(threadTs);
      return row ? rowToSession(row) : undefined;
    },
    set(_threadTs, session) {
      persist(session);
    },
    upsert(threadTs, updater) {
      const existing = selectStmt.get(threadTs);
      const current = existing ? rowToSession(existing) : undefined;
      const next = updater(current);
      persist(next);
      return next;
    },
    delete(threadTs) {
      const info = deleteStmt.run(threadTs);
      return info.changes > 0;
    },
    costForUserSinceMs(userId, sinceMs) {
      const row = costUserStmt.get(userId, sinceMs);
      return {
        tokens: row?.tokens ?? 0,
        costUsd: row?.cost ?? 0,
      };
    },
    costForAllSinceMs(sinceMs) {
      const row = costAllStmt.get(sinceMs);
      return {
        tokens: row?.tokens ?? 0,
        costUsd: row?.cost ?? 0,
      };
    },
    pruneOlderThanMs(cutoffMs) {
      const info = pruneStmt.run(cutoffMs);
      return info.changes;
    },
  };
}

export function newSession(
  threadTs: string,
  userId: string,
  repoPath: string,
): Session {
  return {
    threadTs,
    userId,
    opencodeSessionId: null,
    repoPath,
    modelOverride: null,
    agentOverride: null,
    lastActiveAt: Date.now(),
    totalTokens: 0,
    totalCostUsd: 0,
  };
}
