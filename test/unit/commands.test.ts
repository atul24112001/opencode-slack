import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createBackgroundJobStore } from '../../src/backgroundJobs.js';
import { createBookmarkStore } from '../../src/bookmarks.js';
import { commands, parseSlashCommand } from '../../src/commands/index.js';
import type { CommandContext } from '../../src/commands/index.js';
import type { Config } from '../../src/config.js';
import { applyMigrations } from '../../src/db.js';
import { createScheduledTaskStore } from '../../src/scheduledTasks.js';
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
  const bookmarks = createBookmarkStore(db);
  const scheduledTasks = createScheduledTaskStore(db);
  const backgroundJobs = createBackgroundJobStore(db);
  const ctx: CommandContext = {
    config: baseConfig,
    sessions,
    bookmarks,
    scheduledTasks,
    backgroundJobs,
    userId: 'U1',
    threadKey: null,
    channel: 'C1',
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
  it('has every expected command', () => {
    expect(Object.keys(commands).sort()).toEqual(
      [
        'agent',
        'bg',
        'bookmarks',
        'continue',
        'cost',
        'explore',
        'help',
        'model',
        'plan',
        'qa',
        'reset',
        'review',
        'schedule',
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

describe('continue command', () => {
  it('errors when no prior session exists', () => {
    const { ctx } = makeCtx();
    const r = commands.continue!.run('keep going', ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.text).toContain('No prior session');
  });

  it('errors when prompt is empty', () => {
    const { ctx } = makeCtx();
    const r = commands.continue!.run('', ctx);
    expect(r.kind).toBe('error');
  });

  it('returns stream spec carrying prior repo + session id', () => {
    const { ctx, sessions } = makeCtx();
    const prior = newSession('t-old', 'U1', '/repos/beta');
    prior.opencodeSessionId = 'ses_abc';
    prior.modelOverride = 'anthropic/claude';
    prior.lastActiveAt = Date.now();
    sessions.set('t-old', prior);

    const r = commands.continue!.run('next step', ctx);
    expect(r.kind).toBe('stream');
    if (r.kind === 'stream') {
      expect(r.repoPath).toBe('/repos/beta');
      expect(r.opencodeSessionIdOverride).toBe('ses_abc');
      expect(r.model).toBe('anthropic/claude');
      expect(r.spawnPrompt).toBe('next step');
    }
  });
});

describe('ship --plan-only', () => {
  it('routes to plan agent when --plan-only is present', () => {
    const { ctx } = makeCtx();
    const r = commands.ship!.run('--plan-only refactor auth module', ctx);
    expect(r.kind).toBe('stream');
    if (r.kind === 'stream') {
      expect(r.agent).toBe('plan');
      expect(r.spawnPrompt).toBe('refactor auth module');
    }
  });

  it('uses ship agent without the flag', () => {
    const { ctx } = makeCtx();
    const r = commands.ship!.run('refactor auth', ctx);
    expect(r.kind).toBe('stream');
    if (r.kind === 'stream') expect(r.agent).toBe('ship');
  });
});

describe('bg command', () => {
  it('enqueues a job', () => {
    const { ctx } = makeCtx();
    const r = commands.bg!.run('audit the auth module', ctx);
    expect(r.kind).toBe('text');
    expect(ctx.backgroundJobs.listPendingForUser('U1')).toHaveLength(1);
  });

  it('errors on empty prompt', () => {
    const { ctx } = makeCtx();
    expect(commands.bg!.run('', ctx).kind).toBe('error');
  });
});

describe('schedule command', () => {
  it('adds a daily schedule', () => {
    const { ctx } = makeCtx();
    const r = commands.schedule!.run('daily 9am explore what changed', ctx);
    expect(r.kind).toBe('text');
    expect(ctx.scheduledTasks.listForUser('U1')).toHaveLength(1);
  });

  it('lists existing schedules', () => {
    const { ctx } = makeCtx();
    commands.schedule!.run('daily 9am explore what changed', ctx);
    const r = commands.schedule!.run('list', ctx);
    expect(r.kind).toBe('text');
    if (r.kind === 'text') expect(r.text).toContain('explore what changed');
  });

  it('removes a schedule by id', () => {
    const { ctx } = makeCtx();
    commands.schedule!.run('daily 9am explore', ctx);
    const tasks = ctx.scheduledTasks.listForUser('U1');
    const id = tasks[0]?.id;
    expect(id).toBeDefined();
    const r = commands.schedule!.run(`remove ${id}`, ctx);
    expect(r.kind).toBe('text');
    expect(ctx.scheduledTasks.listForUser('U1')).toHaveLength(0);
  });

  it('errors on bad time', () => {
    const { ctx } = makeCtx();
    expect(commands.schedule!.run('daily wat explore', ctx).kind).toBe(
      'error',
    );
  });
});

describe('bookmarks command', () => {
  it('returns empty-state message when no bookmarks', () => {
    const { ctx } = makeCtx();
    const r = commands.bookmarks!.run('', ctx);
    expect(r.kind).toBe('text');
    if (r.kind === 'text') expect(r.text).toContain('No bookmarks');
  });

  it('lists saved bookmarks', () => {
    const { ctx } = makeCtx();
    ctx.bookmarks.add({
      userId: 'U1',
      channel: 'C1',
      messageTs: '111.222',
      snippet: 'remember this',
      permalink: 'https://slack.example/p1',
    });
    const r = commands.bookmarks!.run('', ctx);
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.text).toContain('remember this');
      expect(r.text).toContain('https://slack.example/p1');
    }
  });
});

describe('help command', () => {
  it('returns Block Kit blocks with a text fallback that lists every command', () => {
    const { ctx } = makeCtx();
    const r = commands.help!.run('', ctx);
    expect(r.kind).toBe('blocks');
    if (r.kind === 'blocks') {
      expect(Array.isArray(r.blocks)).toBe(true);
      expect(r.blocks.length).toBeGreaterThan(0);
      for (const usage of [
        '/oc review',
        '/oc qa',
        '/oc ship',
        '/oc explore',
        '/oc plan',
        '/oc bg',
        '/oc continue',
        '/oc model',
        '/oc agent',
        '/oc cost',
        '/oc reset',
        '/oc schedule',
        '/oc bookmarks',
        '/oc help',
      ]) {
        expect(r.fallback).toContain(usage);
      }
    }
  });
});
