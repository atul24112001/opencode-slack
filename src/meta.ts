import type { Db } from './db.js';

export interface MetaStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export function createMetaStore(db: Db): MetaStore {
  const getStmt = db.prepare<[string], { value: string }>(
    `SELECT value FROM meta WHERE key = ?`,
  );
  const setStmt = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  return {
    get(key) {
      return getStmt.get(key)?.value;
    },
    set(key, value) {
      setStmt.run(key, value);
    },
  };
}
