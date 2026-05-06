import { join } from 'node:path';
import { pino } from 'pino';
import { createAuditWriter } from './audit.js';
import { createBackgroundJobStore } from './backgroundJobs.js';
import { createBookmarkStore } from './bookmarks.js';
import { createBot } from './bot.js';
import { loadConfig } from './config.js';
import { initDb } from './db.js';
import { createMetaStore } from './meta.js';
import { createOpencodeRunner } from './opencode.js';
import { createScheduledTaskStore } from './scheduledTasks.js';
import { createSqliteSessionStore } from './sessions.js';
import { startWorkers } from './worker.js';

const SESSION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SESSION_PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const db = initDb(config);
  const sessions = createSqliteSessionStore(db);
  const audit = createAuditWriter(db);
  const bookmarks = createBookmarkStore(db);
  const scheduledTasks = createScheduledTaskStore(db);
  const backgroundJobs = createBackgroundJobStore(db);
  const meta = createMetaStore(db);
  const runner = createOpencodeRunner(config.OPENCODE_BIN, logger);

  const { app, client, runStream } = createBot({
    config,
    db,
    logger,
    runner,
    sessions,
    audit,
    bookmarks,
    scheduledTasks,
    backgroundJobs,
  });

  await app.start();
  logger.info(
    {
      allowedUsers: config.ALLOWED_USERS.length,
      allowedRepos: config.ALLOWED_REPOS.length,
      defaultRepo: config.DEFAULT_REPO,
      defaultAgent: config.DEFAULT_AGENT,
    },
    'opencode-slack-bot started',
  );

  const workers = startWorkers({
    config,
    client,
    runStream,
    sessions,
    bookmarks,
    scheduledTasks,
    backgroundJobs,
    meta,
    logger,
  });

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
    workers.stop();
    try {
      await app.stop();
      try {
        const backupPath = join(config.DATA_DIR, 'state.db.backup');
        await db.backup(backupPath);
        logger.info({ backupPath }, 'sqlite backup written');
      } catch (err) {
        logger.warn({ err }, 'sqlite backup failed (continuing shutdown)');
      }
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
