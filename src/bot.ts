import bolt from '@slack/bolt';
import type { Logger } from 'pino';
import type { AuditWriter } from './audit.js';
import type { BackgroundJobStore } from './backgroundJobs.js';
import type { BookmarkStore } from './bookmarks.js';
import { commands, parseSlashCommand } from './commands/index.js';
import type { CommandContext } from './commands/index.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { FileUploadClient } from './files.js';
import type { OpencodeRunner, RunHandle } from './opencode.js';
import type { ScheduledTaskStore } from './scheduledTasks.js';
import type { SessionStore } from './sessions.js';
import { createRunStream } from './streaming.js';
import type { RunStream, StreamingClient } from './streaming.js';

const { App, LogLevel } = bolt;

const CANCEL_REACTION = 'x';
const BOOKMARK_REACTION = 'pushpin';

interface SlackClient {
  chat: {
    postMessage(args: {
      channel: string;
      text?: string;
      blocks?: unknown[];
      thread_ts?: string;
    }): Promise<{ ok?: boolean; ts?: string; channel?: string }>;
    postEphemeral(args: {
      channel: string;
      user: string;
      text: string;
    }): Promise<{ ok?: boolean }>;
    update(args: {
      channel: string;
      ts: string;
      text: string;
    }): Promise<unknown>;
    getPermalink(args: {
      channel: string;
      message_ts: string;
    }): Promise<{ ok?: boolean; permalink?: string }>;
  };
  conversations: {
    open(args: {
      users: string;
    }): Promise<{ ok?: boolean; channel?: { id?: string } }>;
    history(args: {
      channel: string;
      latest?: string;
      oldest?: string;
      inclusive?: boolean;
      limit?: number;
    }): Promise<{
      ok?: boolean;
      messages?: Array<{ text?: string; ts?: string }>;
    }>;
  };
  files: FileUploadClient['files'];
}

export interface BotDeps {
  config: Config;
  db: Db;
  logger: Logger;
  runner: OpencodeRunner;
  sessions: SessionStore;
  audit: AuditWriter;
  bookmarks: BookmarkStore;
  scheduledTasks: ScheduledTaskStore;
  backgroundJobs: BackgroundJobStore;
}

export interface BotHandles {
  app: bolt.App;
  client: SlackClient;
  runStream: RunStream;
  activeStreams: Map<string, RunHandle>;
}

export function createBot(deps: BotDeps): BotHandles {
  const {
    config,
    logger,
    runner,
    sessions,
    audit,
    bookmarks,
    scheduledTasks,
    backgroundJobs,
  } = deps;

  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    signingSecret: config.SLACK_SIGNING_SECRET,
    socketMode: true,
    logLevel: mapLogLevel(config.LOG_LEVEL),
  });

  const client = app.client as unknown as SlackClient;
  const activeStreams = new Map<string, RunHandle>();

  const runStream = createRunStream({
    config,
    client: client as unknown as StreamingClient,
    runner,
    sessions,
    audit,
    logger,
    activeStreams,
  });

  const isAllowed = (userId: string | undefined): boolean =>
    !!userId && config.ALLOWED_USERS.includes(userId);

  app.event('app_mention', async ({ event }) => {
    if (!isAllowed(event.user)) {
      logger.warn(
        { user: event.user, channel: event.channel },
        'rejected app_mention',
      );
      return;
    }
    const userId = event.user;
    if (!userId) return;
    const prompt = stripMention(event.text ?? '').trim();
    if (!prompt) return;

    const threadKey = event.thread_ts ?? event.ts;
    logger.info({ user: userId, channel: event.channel }, 'app_mention');

    const initial = await postInitial(client, {
      channel: event.channel,
      threadTs: threadKey,
      logger,
    });
    if (!initial) return;

    await runStream({
      prompt,
      channel: event.channel,
      threadKey,
      messageTs: initial,
      userId,
      command: 'mention',
    });
  });

  app.message(async ({ message }) => {
    if ('subtype' in message && message.subtype !== undefined) return;
    if (!('user' in message) || !message.user) return;
    if (message.channel_type !== 'im') return;
    if (!isAllowed(message.user)) {
      logger.warn(
        { user: message.user, channel: message.channel },
        'rejected DM',
      );
      return;
    }
    if (!('text' in message) || !message.text) return;

    const threadKey =
      'thread_ts' in message && message.thread_ts
        ? message.thread_ts
        : message.ts;
    logger.info({ user: message.user, channel: message.channel }, 'dm');

    const initial = await postInitial(client, {
      channel: message.channel,
      logger,
    });
    if (!initial) return;

    await runStream({
      prompt: message.text,
      channel: message.channel,
      threadKey,
      messageTs: initial,
      userId: message.user,
      command: 'dm',
    });
  });

  app.command('/oc', async ({ command, ack }) => {
    await ack();

    if (!isAllowed(command.user_id)) {
      logger.warn({ user: command.user_id }, 'rejected slash command');
      await safeEphemeral(
        client,
        command.channel_id,
        command.user_id,
        'You are not authorized to use this bot.',
        logger,
      );
      return;
    }

    const parsed = parseSlashCommand(command.text ?? '');
    if (!parsed.name) {
      await safeEphemeral(
        client,
        command.channel_id,
        command.user_id,
        'Try `/oc help` to see what is available.',
        logger,
      );
      return;
    }
    const handler = commands[parsed.name];
    if (!handler) {
      await safeEphemeral(
        client,
        command.channel_id,
        command.user_id,
        `Unknown subcommand: \`${parsed.name}\`. Try \`/oc help\`.`,
        logger,
      );
      return;
    }

    const slashThreadTs = command.thread_ts ?? null;
    const ctx: CommandContext = {
      config,
      sessions,
      bookmarks,
      scheduledTasks,
      backgroundJobs,
      userId: command.user_id,
      threadKey: slashThreadTs,
      channel: command.channel_id,
    };

    let result;
    try {
      result = handler.run(parsed.args, ctx);
    } catch (err) {
      logger.error({ err, command: parsed.name }, 'command handler threw');
      await safeEphemeral(
        client,
        command.channel_id,
        command.user_id,
        `❌ Internal error running \`${parsed.name}\`.`,
        logger,
      );
      return;
    }

    logger.info({ user: command.user_id, command: parsed.name }, 'slash');

    if (result.kind === 'text') {
      await safePostMessage(client, {
        channel: command.channel_id,
        text: result.text,
        ...(slashThreadTs ? { threadTs: slashThreadTs } : {}),
        logger,
      });
      audit.log({
        ts: Date.now(),
        userId: command.user_id,
        command: parsed.name,
        repo: null,
        exitCode: 0,
        durationMs: 0,
      });
      return;
    }

    if (result.kind === 'blocks') {
      try {
        await client.chat.postMessage({
          channel: command.channel_id,
          text: result.fallback,
          blocks: result.blocks,
          ...(slashThreadTs ? { thread_ts: slashThreadTs } : {}),
        });
      } catch (err) {
        logger.warn({ err }, 'postMessage with blocks failed');
        await safePostMessage(client, {
          channel: command.channel_id,
          text: result.fallback,
          ...(slashThreadTs ? { threadTs: slashThreadTs } : {}),
          logger,
        });
      }
      audit.log({
        ts: Date.now(),
        userId: command.user_id,
        command: parsed.name,
        repo: null,
        exitCode: 0,
        durationMs: 0,
      });
      return;
    }

    if (result.kind === 'error') {
      await safeEphemeral(
        client,
        command.channel_id,
        command.user_id,
        result.text,
        logger,
      );
      audit.log({
        ts: Date.now(),
        userId: command.user_id,
        command: parsed.name,
        repo: null,
        exitCode: 2,
        durationMs: 0,
      });
      return;
    }

    const initialTs = await postInitial(client, {
      channel: command.channel_id,
      ...(slashThreadTs ? { threadTs: slashThreadTs } : {}),
      logger,
    });
    if (!initialTs) {
      await safeEphemeral(
        client,
        command.channel_id,
        command.user_id,
        '❌ Failed to start the run.',
        logger,
      );
      return;
    }
    const threadKey = slashThreadTs ?? initialTs;

    await runStream({
      prompt: result.spawnPrompt,
      channel: command.channel_id,
      threadKey,
      messageTs: initialTs,
      userId: command.user_id,
      command: parsed.name,
      repoOverride: result.repoPath ?? null,
      agentOverride: result.agent ?? null,
      modelOverride: result.model ?? null,
      opencodeSessionIdOverride: result.opencodeSessionIdOverride ?? null,
    });
  });

  app.event('reaction_added', async ({ event }) => {
    if (!isAllowed(event.user)) return;
    if (event.item.type !== 'message') return;

    if (event.reaction === CANCEL_REACTION) {
      const handle = activeStreams.get(event.item.ts);
      if (!handle) return;
      logger.info(
        { user: event.user, ts: event.item.ts },
        'cancelling stream via ❌ reaction',
      );
      try {
        await handle.cancel();
      } catch (err) {
        logger.warn({ err }, 'cancel threw');
      }
      return;
    }

    if (event.reaction === BOOKMARK_REACTION) {
      if (bookmarks.exists(event.user, event.item.channel, event.item.ts))
        return;

      let snippet: string | null = null;
      try {
        const hist = await client.conversations.history({
          channel: event.item.channel,
          latest: event.item.ts,
          oldest: event.item.ts,
          inclusive: true,
          limit: 1,
        });
        const text = hist.messages?.[0]?.text;
        if (typeof text === 'string') snippet = text.slice(0, 500);
      } catch (err) {
        logger.debug({ err }, 'conversations.history for bookmark failed');
      }

      let permalink: string | null = null;
      try {
        const link = await client.chat.getPermalink({
          channel: event.item.channel,
          message_ts: event.item.ts,
        });
        if (link.permalink) permalink = link.permalink;
      } catch (err) {
        logger.debug({ err }, 'getPermalink for bookmark failed');
      }

      bookmarks.add({
        userId: event.user,
        channel: event.item.channel,
        messageTs: event.item.ts,
        snippet,
        permalink,
      });
      logger.info(
        { user: event.user, ts: event.item.ts },
        'bookmarked message',
      );
      await safeEphemeral(
        client,
        event.item.channel,
        event.user,
        '📌 Bookmarked. View with `/oc bookmarks`.',
        logger,
      );
    }
  });

  app.error(async (err) => {
    logger.error({ err }, 'unhandled bolt error');
  });

  return { app, client, runStream, activeStreams };
}

async function postInitial(
  client: SlackClient,
  args: { channel: string; threadTs?: string; logger: Logger },
): Promise<string | null> {
  try {
    const res = await client.chat.postMessage({
      channel: args.channel,
      text: '🕐 _Thinking..._',
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    });
    if (!res.ts) {
      args.logger.error({ channel: args.channel }, 'postMessage returned no ts');
      return null;
    }
    return res.ts;
  } catch (err) {
    args.logger.error({ err, channel: args.channel }, 'postMessage failed');
    return null;
  }
}

async function safePostMessage(
  client: SlackClient,
  args: { channel: string; text: string; threadTs?: string; logger: Logger },
): Promise<void> {
  try {
    await client.chat.postMessage({
      channel: args.channel,
      text: args.text,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    });
  } catch (err) {
    args.logger.warn({ err, channel: args.channel }, 'postMessage failed');
  }
}

async function safeEphemeral(
  client: SlackClient,
  channel: string,
  user: string,
  text: string,
  logger: Logger,
): Promise<void> {
  try {
    await client.chat.postEphemeral({ channel, user, text });
  } catch (err) {
    logger.warn({ err, channel, user }, 'postEphemeral failed');
  }
}

function stripMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/, '');
}

function mapLogLevel(level: Config['LOG_LEVEL']): bolt.LogLevel {
  switch (level) {
    case 'debug':
      return LogLevel.DEBUG;
    case 'info':
      return LogLevel.INFO;
    case 'warn':
      return LogLevel.WARN;
    case 'error':
      return LogLevel.ERROR;
  }
}
