import bolt from '@slack/bolt';
import type { Logger } from 'pino';
import type { AuditWriter } from './audit.js';
import { commands, parseSlashCommand } from './commands/index.js';
import type { CommandContext } from './commands/index.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { FileUploadClient } from './files.js';
import type { OpencodeRunner, RunHandle } from './opencode.js';
import type { SessionStore } from './sessions.js';
import { createRunStream } from './streaming.js';
import type { StreamingClient } from './streaming.js';

const { App, LogLevel } = bolt;

const CANCEL_REACTION = 'x';

interface SlackClient {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
    }): Promise<{ ok?: boolean; ts?: string }>;
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
}

export function createBot(deps: BotDeps): bolt.App {
  const { config, logger, runner, sessions, audit } = deps;

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
      userId: command.user_id,
      threadKey: slashThreadTs,
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
      try {
        await client.chat.postMessage({
          channel: command.channel_id,
          text: result.text,
          ...(slashThreadTs ? { thread_ts: slashThreadTs } : {}),
        });
      } catch (err) {
        logger.error({ err }, 'postMessage for text result failed');
        await safeEphemeral(
          client,
          command.channel_id,
          command.user_id,
          '❌ Failed to post response.',
          logger,
        );
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
    });
  });

  app.event('reaction_added', async ({ event }) => {
    if (event.reaction !== CANCEL_REACTION) return;
    if (!isAllowed(event.user)) return;
    if (event.item.type !== 'message') return;
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
  });

  app.error(async (err) => {
    logger.error({ err }, 'unhandled bolt error');
  });

  return app;
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
