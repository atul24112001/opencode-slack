import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { MetaStore } from './meta.js';
import type { SessionStore } from './sessions.js';

export interface DigestClient {
  conversations: {
    open(args: {
      users: string;
    }): Promise<{ ok?: boolean; channel?: { id?: string } }>;
  };
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
    }): Promise<{ ok?: boolean }>;
  };
}

const DIGEST_HOUR_UTC = 9;
const META_KEY = 'last_digest_date_utc';

export async function maybeRunDailyDigest(deps: {
  config: Config;
  client: DigestClient;
  sessions: SessionStore;
  meta: MetaStore;
  logger: Logger;
  now?: Date;
}): Promise<boolean> {
  const { config, client, sessions, meta, logger } = deps;
  const now = deps.now ?? new Date();

  if (now.getUTCHours() < DIGEST_HOUR_UTC) return false;

  const today = todayUTC(now);
  const last = meta.get(META_KEY);
  if (last === today) return false;

  const yesterdayStart = startOfYesterdayUTC(now);
  const yesterdayEnd = startOfTodayUTC(now);

  for (const userId of config.ALLOWED_USERS) {
    const stats = sessions.costForUserBetween(
      userId,
      yesterdayStart,
      yesterdayEnd,
    );
    if (stats.tokens === 0) continue;
    const text =
      `*Yesterday's opencode usage*\n` +
      `${stats.tokens.toLocaleString()} tokens · $${stats.costUsd.toFixed(4)}\n` +
      `_(workspace cap: $${config.MAX_COST_PER_SESSION_USD.toFixed(2)} per thread)_`;
    try {
      const im = await client.conversations.open({ users: userId });
      const channel = im.channel?.id;
      if (!channel) {
        logger.warn({ userId }, 'conversations.open returned no channel id');
        continue;
      }
      await client.chat.postMessage({ channel, text });
      logger.info({ userId, ...stats }, 'sent daily digest');
    } catch (err) {
      logger.warn({ err, userId }, 'failed to send digest');
    }
  }

  meta.set(META_KEY, today);
  return true;
}

function todayUTC(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function startOfTodayUTC(now: Date): number {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return d.getTime();
}

function startOfYesterdayUTC(now: Date): number {
  return startOfTodayUTC(now) - 24 * 60 * 60 * 1000;
}
