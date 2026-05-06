import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { commands, parseSlashCommand } from '../../src/commands/index.js';
import type { CommandContext } from '../../src/commands/index.js';
import type { Config } from '../../src/config.js';
import { applyMigrations } from '../../src/db.js';
import {
  createSqliteSessionStore,
  newSession,
  type SessionStore,
} from '../../src/sessions.js';

const baseConfig: Config = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  SLACK_SIGNING_SECRET: 'secret',
  ALLOWED_USERS: ['U1'],
  ALLOWED_REPOS: ['/repos/alpha', '/repos/beta'],
  OPENCODE_BIN: '/usr/local/bin/opencode',
  DEFAULT_REPO: '/repos/alpha',
  DEFAULT_AGENT: 'general',
  DATA_DIR: ':memory:',
  LOG_LEVEL: 'info',
  MAX_COST_PER_SESSION_USD: 1.0,
};

function makeCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  sessions: SessionStore;
} {
  const db = new Database(':memory:');
  applyMigrations(db);
  const sessions = createSqliteSessionStore(db);
  const ctx: CommandContext = {
    config: baseConfig,
    sessions,
    userId: 'U1',
    threadKey: null,
    ...overrides,
  };
  return { ctx, sessions };
}

describe('parseSlashCommand', () => {
  it('separates name and args', () => {
    expect(parseSlashCommand('review 142')).toEqual({
      name: 'review',
      args: '142',
    });
  });

  it('lowercases the name', () => {
    expect(parseSlashCommand('REVIEW 142').name).toBe('review');
  });

  it('handles whitespace and missing args', () => {
    expect(parseSlashCommand('  cost  ')).toEqual({ name: 'cost', args: '' });
    expect(parseSlashCommand('')).toEqual({ name: '', args: '' });
  });

  it('keeps multi-token args intact', () => {
    expect(parseSlashCommand('ship fix the auth bug')).toEqual({
      name: 'ship',
      args: 'fix the auth bug',
    });
  });
});

describe('command registry', () => {
  it('has exactly the expected ten commands', () => {
    expect(Object.keys(commands).sort()).toEqual(
      [
        'agent',
        'cost',
        'explore',
        'help',
        'model',
        'plan',
        'qa',
        'reset',
        'review',
        'ship',
      ].sort(),
    );
  });
});

describe('review command', () => {
  it('errors when PR number missing', () => {
    const { ctx } = makeCtx();
    const r = commands.review!.run('', ctx);
    expect(r.kind).toBe('error');
  });

  it('returns a stream spec with reviewer agent', () => {
    const { ctx } = makeCtx();
    const r = commands.review!.run('142', ctx);
    expect(r.kind).toBe('stream');
    if (r.kind === 'stream') {
      expect(r.agent).toBe('reviewer');
      expect(r.spawnPrompt).toContain('#142');
    }
  });

  it('resolves repo arg by basename match against ALLOWED_REPOS', () => {
    const { ctx } = makeCtx();
    const r = commands.review!.run('142 beta', ctx);
    expect(r.kind).toBe('stream');
    if (r.kind === 'stream') {
      expect(r.repoPath).toBe('/repos/beta');
    }
  });

  it('errors on unknown repo', () => {
    const { ctx } = makeCtx();
    const r = commands.review!.run('142 unknown', ctx);
    expect(r.kind).toBe('error');
  });
});

describe('model command', () => {
  it('asks for thread context when invoked outside a thread', () => {
    const { ctx } = makeCtx({ threadKey: null });
    const r = commands.model!.run('anthropic/claude', ctx);
    expect(r.kind).toBe('text');
    if (r.kind === 'text') expect(r.text).toContain('inside a thread');
  });

  it('reports current model when called bare', () => {
    const { ctx, sessions } = makeCtx({ threadKey: 't1' });
    sessions.set('t1', newSession('t1', 'U1', '/repos/alpha'));
    const r = commands.model!.run('', ctx);
    expect(r.kind).toBe('text');
  });

  it('sets model and confirms', () => {
    const { ctx, sessions } = makeCtx({ threadKey: 't1' });
    sessions.set('t1', newSession('t1', 'U1', '/repos/alpha'));
    const r = commands.model!.run('anthropic/claude-opus', ctx);
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.text).toContain('next message');
    }
    expect(sessions.get('t1')?.modelOverride).toBe('anthropic/claude-opus');
  });
});

describe('reset command', () => {
  it('forgets the current thread session', () => {
    const { ctx, sessions } = makeCtx({ threadKey: 't1' });
    sessions.set('t1', newSession('t1', 'U1', '/repos/alpha'));
    const r = commands.reset!.run('', ctx);
    expect(r.kind).toBe('text');
    if (r.kind === 'text') expect(r.text).toContain('forgotten');
    expect(sessions.get('t1')).toBeUndefined();
  });
});

describe('cost command', () => {
  it('renders zero-state when there are no sessions', () => {
    const { ctx } = makeCtx({ threadKey: 't1' });
    const r = commands.cost!.run('', ctx);
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.text).toContain('no session yet');
      expect(r.text).toContain('Per-session limit');
    }
  });

  it('shows this thread totals when session exists', () => {
    const { ctx, sessions } = makeCtx({ threadKey: 't1' });
    const s = newSession('t1', 'U1', '/repos/alpha');
    s.totalTokens = 12345;
    s.totalCostUsd = 0.0789;
    sessions.set('t1', s);
    const r = commands.cost!.run('', ctx);
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.text).toContain('12,345 tokens');
      expect(r.text).toContain('$0.0789');
    }
  });
});

describe('help command', () => {
  it('lists every registered command', () => {
    const { ctx } = makeCtx();
    const r = commands.help!.run('', ctx);
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      for (const usage of [
        '/oc review',
        '/oc qa',
        '/oc ship',
        '/oc explore',
        '/oc plan',
        '/oc model',
        '/oc agent',
        '/oc cost',
        '/oc reset',
        '/oc help',
      ]) {
        expect(r.text).toContain(usage);
      }
    }
  });
});
