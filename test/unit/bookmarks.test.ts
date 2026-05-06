import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookmarkStore, type BookmarkStore } from '../../src/bookmarks.js';
import { applyMigrations } from '../../src/db.js';

let db: Database.Database;
let store: BookmarkStore;

beforeEach(() => {
  db = new Database(':memory:');
  applyMigrations(db);
  store = createBookmarkStore(db);
});

describe('BookmarkStore', () => {
  it('add + listForUser round-trip', () => {
    store.add({
      userId: 'U1',
      channel: 'C1',
      messageTs: '111.222',
      snippet: 'first',
      permalink: 'https://slack.example/p1',
    });
    store.add({
      userId: 'U1',
      channel: 'C1',
      messageTs: '333.444',
      snippet: 'second',
    });
    const list = store.listForUser('U1');
    expect(list).toHaveLength(2);
    // newest first
    expect(list[0]?.messageTs).toBe('333.444');
    expect(list[0]?.permalink).toBeNull();
    expect(list[1]?.snippet).toBe('first');
  });

  it('exists() returns true after add', () => {
    expect(store.exists('U1', 'C1', '111.222')).toBe(false);
    store.add({ userId: 'U1', channel: 'C1', messageTs: '111.222' });
    expect(store.exists('U1', 'C1', '111.222')).toBe(true);
  });

  it('listForUser scopes by user', () => {
    store.add({ userId: 'U1', channel: 'C1', messageTs: '1' });
    store.add({ userId: 'U2', channel: 'C1', messageTs: '2' });
    expect(store.listForUser('U1')).toHaveLength(1);
    expect(store.listForUser('U2')).toHaveLength(1);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 30; i++) {
      store.add({ userId: 'U1', channel: 'C1', messageTs: `${i}.0` });
    }
    expect(store.listForUser('U1', 5)).toHaveLength(5);
  });
});
