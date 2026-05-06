import type { Logger } from 'pino';
import type { BackgroundJobStore, BackgroundJob } from './backgroundJobs.js';
import type { Config } from './config.js';
import { commands, parseSlashCommand } from './commands/index.js';
import type { CommandContext } from './commands/index.js';
import type { BookmarkStore } from './bookmarks.js';
import { maybeRunDailyDigest } from './digest.js';
import type { MetaStore } from './meta.js';
import type { ScheduledTaskStore, ScheduledTask } from './scheduledTasks.js';
import { computeNextRun } from './scheduler.js';
import type { SessionStore } from './sessions.js';
import type { RunStream } from './streaming.js';

const BG_POLL_INTERVAL_MS = 5000;
const SCHEDULER_INTERVAL_MS = 60_000;

interface WorkerClient {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
    }): Promise<{ ok?: boolean; ts?: string }>;
  };
  conversations: {
    open(args: {
      users: string;
    }): Promise<{ ok?: boolean; channel?: { id?: string } }>;
  };
}

export interface WorkerDeps {
  config: Config;
  client: WorkerClient;
  runStream: RunStream;
  sessions: SessionStore;
  bookmarks: BookmarkStore;
  scheduledTasks: ScheduledTaskStore;
  backgroundJobs: BackgroundJobStore;
  meta: MetaStore;
  logger: Logger;
}

export interface WorkerHandles {
  bgInterval: NodeJS.Timeout;
  schedulerInterval: NodeJS.Timeout;
  stop(): void;
}

export function startWorkers(deps: WorkerDeps): WorkerHandles {
  const { logger } = deps;
  let bgBusy = false;

  const bgInterval = setInterval(() => {
    if (bgBusy) return;
    bgBusy = true;
    runOneBgJob(deps)
      .catch((err) => logger.error({ err }, 'bg worker iteration threw'))
      .finally(() => {
        bgBusy = false;
      });
  }, BG_POLL_INTERVAL_MS);
  bgInterval.unref();

  let schedulerBusy = false;
  const schedulerInterval = setInterval(() => {
    if (schedulerBusy) return;
    schedulerBusy = true;
    runSchedulerTick(deps)
      .catch((err) => logger.error({ err }, 'scheduler tick threw'))
      .finally(() => {
        schedulerBusy = false;
      });
  }, SCHEDULER_INTERVAL_MS);
  schedulerInterval.unref();

  return {
    bgInterval,
    schedulerInterval,
    stop: () => {
      clearInterval(bgInterval);
      clearInterval(schedulerInterval);
    },
  };
}

async function runOneBgJob(deps: WorkerDeps): Promise<void> {
  const { backgroundJobs, client, runStream, logger } = deps;
  const job = backgroundJobs.claimOne();
  if (!job) return;
  logger.info({ jobId: job.id, userId: job.userId }, 'running bg job');

  let dmChannel: string;
  try {
    const im = await client.conversations.open({ users: job.userId });
    if (!im.channel?.id) throw new Error('no channel id');
    dmChannel = im.channel.id;
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'bg: failed to open DM');
    backgroundJobs.finish(job.id, {
      resultText: 'failed to open DM',
      exitCode: null,
      failed: true,
    });
    return;
  }

  let ts: string;
  try {
    const post = await client.chat.postMessage({
      channel: dmChannel,
      text: `🟡 _Background job #${job.id}: ${truncate(job.prompt, 80)}_`,
    });
    if (!post.ts) throw new Error('no ts');
    ts = post.ts;
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'bg: failed to post initial DM');
    backgroundJobs.finish(job.id, {
      resultText: 'failed to post DM',
      exitCode: null,
      failed: true,
    });
    return;
  }

  const result = await runStream({
    prompt: job.prompt,
    channel: dmChannel,
    threadKey: ts,
    messageTs: ts,
    userId: job.userId,
    command: 'bg',
    repoOverride: job.repoPath ?? null,
    agentOverride: job.agent ?? null,
  });

  backgroundJobs.finish(job.id, {
    resultText: null,
    exitCode: result.exitCode,
    failed: result.errored,
  });
}

async function runSchedulerTick(deps: WorkerDeps): Promise<void> {
  const { config, client, sessions, meta, logger, scheduledTasks } = deps;

  try {
    await maybeRunDailyDigest({
      config,
      client,
      sessions,
      meta,
      logger,
    });
  } catch (err) {
    logger.warn({ err }, 'digest failed');
  }

  const due = scheduledTasks.due(Date.now());
  for (const task of due) {
    try {
      await runScheduledTask(task, deps);
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'scheduled task threw');
    }
    const nextRun = computeNextRun(task.schedule, new Date());
    scheduledTasks.markRan(task.id, Date.now(), nextRun);
  }
}

async function runScheduledTask(
  task: ScheduledTask,
  deps: WorkerDeps,
): Promise<void> {
  const { client, runStream, config, sessions, bookmarks, scheduledTasks, backgroundJobs, logger } = deps;
  logger.info(
    { taskId: task.id, command: task.commandText },
    'running scheduled task',
  );

  const parsed = parseSlashCommand(task.commandText);
  const handler = commands[parsed.name];
  if (!handler) {
    await safePost(client, {
      channel: task.channel,
      text: `❌ Scheduled #${task.id}: unknown subcommand \`${parsed.name}\``,
    }, logger);
    return;
  }

  const ctx: CommandContext = {
    config,
    sessions,
    bookmarks,
    scheduledTasks,
    backgroundJobs,
    userId: task.userId,
    threadKey: null,
    channel: task.channel,
  };

  let result;
  try {
    result = handler.run(parsed.args, ctx);
  } catch (err) {
    logger.error({ err, taskId: task.id }, 'handler threw');
    await safePost(client, {
      channel: task.channel,
      text: `❌ Scheduled #${task.id}: \`${parsed.name}\` threw an error`,
    }, logger);
    return;
  }

  if (result.kind === 'text') {
    await safePost(client, {
      channel: task.channel,
      text: `_(scheduled #${task.id})_\n${result.text}`,
    }, logger);
    return;
  }
  if (result.kind === 'blocks') {
    await safePost(client, {
      channel: task.channel,
      text: `_(scheduled #${task.id})_\n${result.fallback}`,
    }, logger);
    return;
  }
  if (result.kind === 'error') {
    await safePost(client, {
      channel: task.channel,
      text: `❌ Scheduled #${task.id}: ${result.text}`,
    }, logger);
    return;
  }

  let post: { ts?: string };
  try {
    post = await client.chat.postMessage({
      channel: task.channel,
      text: `🕐 _(scheduled #${task.id}: ${truncate(task.commandText, 80)})_`,
    });
  } catch (err) {
    logger.error({ err, taskId: task.id }, 'scheduled: postMessage failed');
    return;
  }
  if (!post.ts) {
    logger.error({ taskId: task.id }, 'scheduled: postMessage no ts');
    return;
  }

  await runStream({
    prompt: result.spawnPrompt,
    channel: task.channel,
    threadKey: post.ts,
    messageTs: post.ts,
    userId: task.userId,
    command: `scheduled:${parsed.name}`,
    repoOverride: result.repoPath ?? null,
    agentOverride: result.agent ?? null,
    modelOverride: result.model ?? null,
  });
}

async function safePost(
  client: WorkerClient,
  args: { channel: string; text: string },
  logger: Logger,
): Promise<void> {
  try {
    await client.chat.postMessage(args);
  } catch (err) {
    logger.warn({ err, channel: args.channel }, 'safePost failed');
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
