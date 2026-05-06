import type { Db } from './db.js';
import type { ParsedSchedule, ScheduleKind } from './scheduler.js';
import { computeNextRun } from './scheduler.js';

export interface ScheduledTask {
  id: number;
  userId: string;
  channel: string;
  schedule: ParsedSchedule;
  commandText: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number;
  createdAt: number;
}

export interface ScheduledTaskStore {
  add(args: {
    userId: string;
    channel: string;
    schedule: ParsedSchedule;
    commandText: string;
    nowMs: number;
  }): ScheduledTask;
  listForUser(userId: string): ScheduledTask[];
  remove(id: number, userId: string): boolean;
  due(nowMs: number): ScheduledTask[];
  markRan(id: number, ranAtMs: number, nextRunMs: number): void;
}

interface Row {
  id: number;
  user_id: string;
  channel: string;
  schedule_kind: string;
  schedule_hour: number | null;
  schedule_minute: number | null;
  schedule_weekday: number | null;
  command_text: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number;
  created_at: number;
}

function rowToTask(row: Row): ScheduledTask {
  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    schedule: {
      kind: row.schedule_kind as ScheduleKind,
      hour: row.schedule_hour,
      minute: row.schedule_minute,
      weekday: row.schedule_weekday,
    },
    commandText: row.command_text,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  };
}

export function createScheduledTaskStore(db: Db): ScheduledTaskStore {
  const insert = db.prepare(
    `INSERT INTO scheduled_tasks
       (user_id, channel, schedule_kind, schedule_hour, schedule_minute,
        schedule_weekday, command_text, enabled, next_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  const list = db.prepare<[string], Row>(
    `SELECT * FROM scheduled_tasks
     WHERE user_id = ?
     ORDER BY next_run_at ASC`,
  );
  const dueStmt = db.prepare<[number], Row>(
    `SELECT * FROM scheduled_tasks
     WHERE enabled = 1 AND next_run_at <= ?
     ORDER BY next_run_at ASC
     LIMIT 50`,
  );
  const remove = db.prepare<[number, string]>(
    `DELETE FROM scheduled_tasks WHERE id = ? AND user_id = ?`,
  );
  const update = db.prepare(
    `UPDATE scheduled_tasks
     SET last_run_at = ?, next_run_at = ?
     WHERE id = ?`,
  );
  const select = db.prepare<[number], Row>(
    `SELECT * FROM scheduled_tasks WHERE id = ?`,
  );

  return {
    add({ userId, channel, schedule, commandText, nowMs }) {
      const next = computeNextRun(schedule, new Date(nowMs));
      const info = insert.run(
        userId,
        channel,
        schedule.kind,
        schedule.hour,
        schedule.minute,
        schedule.weekday,
        commandText,
        next,
        nowMs,
      );
      const row = select.get(Number(info.lastInsertRowid));
      if (!row) throw new Error('failed to read back inserted task');
      return rowToTask(row);
    },
    listForUser(userId) {
      return list.all(userId).map(rowToTask);
    },
    remove(id, userId) {
      return remove.run(id, userId).changes > 0;
    },
    due(nowMs) {
      return dueStmt.all(nowMs).map(rowToTask);
    },
    markRan(id, ranAtMs, nextRunMs) {
      update.run(ranAtMs, nextRunMs, id);
    },
  };
}
