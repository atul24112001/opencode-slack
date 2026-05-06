import type { Db } from './db.js';

export interface Bookmark {
  id: number;
  userId: string;
  channel: string;
  messageTs: string;
  snippet: string | null;
  permalink: string | null;
  createdAt: number;
}

export interface BookmarkStore {
  add(b: {
    userId: string;
    channel: string;
    messageTs: string;
    snippet?: string | null;
    permalink?: string | null;
  }): void;
  listForUser(userId: string, limit?: number): Bookmark[];
  exists(userId: string, channel: string, messageTs: string): boolean;
}

interface BookmarkRow {
  id: number;
  user_id: string;
  channel: string;
  message_ts: string;
  snippet: string | null;
  permalink: string | null;
  created_at: number;
}

function rowToBookmark(row: BookmarkRow): Bookmark {
  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    messageTs: row.message_ts,
    snippet: row.snippet,
    permalink: row.permalink,
    createdAt: row.created_at,
  };
}

export function createBookmarkStore(db: Db): BookmarkStore {
  const insertStmt = db.prepare(
    `INSERT INTO bookmarks (user_id, channel, message_ts, snippet, permalink, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const listStmt = db.prepare<[string, number], BookmarkRow>(
    `SELECT * FROM bookmarks
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  );
  const existsStmt = db.prepare<[string, string, string], { c: number }>(
    `SELECT COUNT(*) AS c FROM bookmarks
     WHERE user_id = ? AND channel = ? AND message_ts = ?`,
  );
  return {
    add(b) {
      insertStmt.run(
        b.userId,
        b.channel,
        b.messageTs,
        b.snippet ?? null,
        b.permalink ?? null,
        Date.now(),
      );
    },
    listForUser(userId, limit = 20) {
      return listStmt.all(userId, limit).map(rowToBookmark);
    },
    exists(userId, channel, messageTs) {
      const row = existsStmt.get(userId, channel, messageTs);
      return (row?.c ?? 0) > 0;
    },
  };
}
