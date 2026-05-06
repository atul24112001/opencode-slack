import type { Db } from './db.js';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BackgroundJob {
  id: number;
  userId: string;
  initiatingChannel: string;
  initiatingTs: string;
  prompt: string;
  agent: string | null;
  repoPath: string | null;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  resultText: string | null;
  exitCode: number | null;
}

export interface BackgroundJobStore {
  enqueue(args: {
    userId: string;
    initiatingChannel: string;
    initiatingTs: string;
    prompt: string;
    agent?: string | null;
    repoPath?: string | null;
  }): BackgroundJob;
  claimOne(): BackgroundJob | undefined;
  finish(
    id: number,
    args: { resultText: string | null; exitCode: number | null; failed: boolean },
  ): void;
  listPendingForUser(userId: string, limit?: number): BackgroundJob[];
}

interface Row {
  id: number;
  user_id: string;
  initiating_channel: string;
  initiating_ts: string;
  prompt: string;
  agent: string | null;
  repo_path: string | null;
  status: JobStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result_text: string | null;
  exit_code: number | null;
}

function rowToJob(row: Row): BackgroundJob {
  return {
    id: row.id,
    userId: row.user_id,
    initiatingChannel: row.initiating_channel,
    initiatingTs: row.initiating_ts,
    prompt: row.prompt,
    agent: row.agent,
    repoPath: row.repo_path,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    resultText: row.result_text,
    exitCode: row.exit_code,
  };
}

export function createBackgroundJobStore(db: Db): BackgroundJobStore {
  const insert = db.prepare(
    `INSERT INTO background_jobs
       (user_id, initiating_channel, initiating_ts, prompt, agent, repo_path,
        status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
  const select = db.prepare<[number], Row>(
    `SELECT * FROM background_jobs WHERE id = ?`,
  );
  const findPending = db.prepare<[], Row>(
    `SELECT * FROM background_jobs
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT 1`,
  );
  const claim = db.prepare(
    `UPDATE background_jobs
     SET status = 'running', started_at = ?
     WHERE id = ? AND status = 'pending'`,
  );
  const finish = db.prepare(
    `UPDATE background_jobs
     SET status = ?, completed_at = ?, result_text = ?, exit_code = ?
     WHERE id = ?`,
  );
  const listPending = db.prepare<[string, number], Row>(
    `SELECT * FROM background_jobs
     WHERE user_id = ? AND status IN ('pending', 'running')
     ORDER BY created_at DESC
     LIMIT ?`,
  );

  return {
    enqueue({ userId, initiatingChannel, initiatingTs, prompt, agent, repoPath }) {
      const info = insert.run(
        userId,
        initiatingChannel,
        initiatingTs,
        prompt,
        agent ?? null,
        repoPath ?? null,
        Date.now(),
      );
      const row = select.get(Number(info.lastInsertRowid));
      if (!row) throw new Error('failed to read back enqueued job');
      return rowToJob(row);
    },
    claimOne() {
      const row = findPending.get();
      if (!row) return undefined;
      const info = claim.run(Date.now(), row.id);
      if (info.changes === 0) return undefined;
      const claimed = select.get(row.id);
      return claimed ? rowToJob(claimed) : undefined;
    },
    finish(id, { resultText, exitCode, failed }) {
      finish.run(
        failed ? 'failed' : 'completed',
        Date.now(),
        resultText,
        exitCode,
        id,
      );
    },
    listPendingForUser(userId, limit = 10) {
      return listPending.all(userId, limit).map(rowToJob);
    },
  };
}
