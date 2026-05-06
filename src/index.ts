import { pino } from 'pino';
import { createAuditWriter } from './audit.js';
import { createBot } from './bot.js';
import { loadConfig } from './config.js';
import { initDb } from './db.js';
import { createOpencodeRunner } from './opencode.js';
import { createSqliteSessionStore } from './sessions.js';

const SESSION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SESSION_PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const db = initDb(config);
  const sessions = createSqliteSessionStore(db);
  const audit = createAuditWriter(db);
  const runner = createOpencodeRunner(config.OPENCODE_BIN, logger);
  const bot = createBot({ config, db, logger, runner, sessions, audit });

  await bot.start();
  logger.info(
    {
      allowedUsers: config.ALLOWED_USERS.length,
      allowedRepos: config.ALLOWED_REPOS.length,
      defaultRepo: config.DEFAULT_REPO,
      defaultAgent: config.DEFAULT_AGENT,
    },
    'opencode-slack-bot started',
  );

  const pruneTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_PRUNE_AGE_MS;
    const removed = sessions.pruneOlderThanMs(cutoff);
    if (removed > 0) logger.info({ removed }, 'pruned old sessions');
  }, SESSION_PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(pruneTimer);
    try {
      await bot.stop();
      db.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', (sig) => void shutdown(sig));
  process.on('SIGINT', (sig) => void shutdown(sig));
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
