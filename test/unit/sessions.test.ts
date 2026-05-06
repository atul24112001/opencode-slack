import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/db.js';
import {
  createSqliteSessionStore,
  newSession,
  type SessionStore,
} from '../../src/sessions.js';

let store: SessionStore;
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyMigrations(db);
  store = createSqliteSessionStore(db);
});

describe('SqliteSessionStore', () => {
  it('round-trips a fresh session', () => {
    const s = newSession('1234.5678', 'U1', '/repo');
    store.set('1234.5678', s);
    expect(store.get('1234.5678')).toEqual(s);
  });

  it('returns undefined for unknown thread', () => {
    expect(store.get('nope')).toBeUndefined();
  });

  it('upsert creates if missing, updates if present', () => {
    store.upsert('t1', () => newSession('t1', 'U1', '/repo'));
    expect(store.get('t1')?.userId).toBe('U1');

    store.upsert('t1', (current) => ({
      ...current!,
      modelOverride: 'anthropic/claude-sonnet',
    }));
    expect(store.get('t1')?.modelOverride).toBe('anthropic/claude-sonnet');
  });

  it('deletes return true only when a row was removed', () => {
    store.set('t1', newSession('t1', 'U1', '/repo'));
    expect(store.delete('t1')).toBe(true);
    expect(store.delete('t1')).toBe(false);
  });

  it('costForUserSinceMs sums tokens and cost for a single user', () => {
    const a = newSession('t1', 'U1', '/r');
    a.totalTokens = 1000;
    a.totalCostUsd = 0.01;
    a.lastActiveAt = 100;
    const b = newSession('t2', 'U1', '/r');
    b.totalTokens = 500;
    b.totalCostUsd = 0.005;
    b.lastActiveAt = 200;
    const c = newSession('t3', 'U2', '/r');
    c.totalTokens = 9999;
    c.totalCostUsd = 0.99;
    c.lastActiveAt = 200;
    store.set('t1', a);
    store.set('t2', b);
    store.set('t3', c);

    const got = store.costForUserSinceMs('U1', 0);
    expect(got.tokens).toBe(1500);
    expect(got.costUsd).toBeCloseTo(0.015);
  });

  it('costForUserSinceMs respects the cutoff', () => {
    const old = newSession('t1', 'U1', '/r');
    old.totalTokens = 1000;
    old.totalCostUsd = 0.01;
    old.lastActiveAt = 100;
    const recent = newSession('t2', 'U1', '/r');
    recent.totalTokens = 500;
    recent.totalCostUsd = 0.005;
    recent.lastActiveAt = 200;
    store.set('t1', old);
    store.set('t2', recent);

    const got = store.costForUserSinceMs('U1', 150);
    expect(got.tokens).toBe(500);
  });

  it('pruneOlderThanMs deletes only rows below the cutoff', () => {
    const a = newSession('t1', 'U1', '/r');
    a.lastActiveAt = 100;
    const b = newSession('t2', 'U1', '/r');
    b.lastActiveAt = 200;
    store.set('t1', a);
    store.set('t2', b);

    expect(store.pruneOlderThanMs(150)).toBe(1);
    expect(store.get('t1')).toBeUndefined();
    expect(store.get('t2')).toBeDefined();
  });

  it('costForAllSinceMs sums across users', () => {
    const a = newSession('t1', 'U1', '/r');
    a.totalCostUsd = 0.01;
    a.lastActiveAt = 200;
    const b = newSession('t2', 'U2', '/r');
    b.totalCostUsd = 0.02;
    b.lastActiveAt = 200;
    store.set('t1', a);
    store.set('t2', b);

    expect(store.costForAllSinceMs(0).costUsd).toBeCloseTo(0.03);
  });
});
