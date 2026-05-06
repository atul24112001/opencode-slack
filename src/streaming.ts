import { existsSync } from 'node:fs';
import type { Logger } from 'pino';
import type { AuditWriter } from './audit.js';
import type { Config } from './config.js';
import type { FileUploadClient } from './files.js';
import { fileNameFor, uploadAsFile } from './files.js';
import {
  applyEvent,
  decideOutputMode,
  newStreamState,
  renderProgress,
} from './formatter.js';
import type { OpencodeRunner, RunHandle, SpawnOptions } from './opencode.js';
import { newSession } from './sessions.js';
import type { SessionStore } from './sessions.js';

const STREAM_UPDATE_INTERVAL_MS = 1000;

export interface UpdateClient {
  chat: {
    update(args: {
      channel: string;
      ts: string;
      text: string;
    }): Promise<unknown>;
  };
}

export type StreamingClient = UpdateClient & FileUploadClient;

export interface RunStreamArgs {
  prompt: string;
  channel: string;
  threadKey: string;
  messageTs: string;
  userId: string;
  command: string;
  repoOverride?: string | null;
  agentOverride?: string | null;
  modelOverride?: string | null;
}

export interface RunStreamResult {
  exitCode: number | null;
  durationMs: number;
  cancelled: boolean;
  errored: boolean;
}

export interface RunStreamDeps {
  config: Config;
  client: StreamingClient;
  runner: OpencodeRunner;
  sessions: SessionStore;
  audit: AuditWriter;
  logger: Logger;
  activeStreams: Map<string, RunHandle>;
}

export type RunStream = (args: RunStreamArgs) => Promise<RunStreamResult>;

export function createRunStream(deps: RunStreamDeps): RunStream {
  const { config, client, runner, sessions, audit, logger, activeStreams } =
    deps;

  return async function runStream(
    args: RunStreamArgs,
  ): Promise<RunStreamResult> {
    const startMs = Date.now();
    const repoPath = args.repoOverride ?? config.DEFAULT_REPO;

    if (!existsSync(repoPath)) {
      const text = `❌ Repo path not found on disk: \`${repoPath}\``;
      await safeUpdate(client, args.channel, args.messageTs, text, logger);
      audit.log({
        ts: startMs,
        userId: args.userId,
        command: args.command,
        repo: repoPath,
        exitCode: null,
        durationMs: Date.now() - startMs,
      });
      return {
        exitCode: null,
        durationMs: Date.now() - startMs,
        cancelled: false,
        errored: true,
      };
    }

    const session = sessions.upsert(args.threadKey, (current) => {
      if (current) {
        return { ...current, repoPath, lastActiveAt: startMs };
      }
      return newSession(args.threadKey, args.userId, repoPath);
    });

    if (session.totalCostUsd >= config.MAX_COST_PER_SESSION_USD) {
      const text = `❌ This thread has hit the per-session cost cap of $${config.MAX_COST_PER_SESSION_USD.toFixed(2)}. Use \`/oc reset\` to start fresh.`;
      await safeUpdate(client, args.channel, args.messageTs, text, logger);
      audit.log({
        ts: startMs,
        userId: args.userId,
        command: args.command,
        repo: repoPath,
        exitCode: null,
        durationMs: Date.now() - startMs,
      });
      return {
        exitCode: null,
        durationMs: Date.now() - startMs,
        cancelled: false,
        errored: true,
      };
    }

    const state = newStreamState(startMs);
    let pendingText: string | null = null;
    let inFlight = false;

    const flush = async (): Promise<void> => {
      while (pendingText !== null) {
        inFlight = true;
        const text = pendingText;
        pendingText = null;
        await safeUpdate(client, args.channel, args.messageTs, text, logger);
        await sleep(STREAM_UPDATE_INTERVAL_MS);
        inFlight = false;
      }
    };

    const spawnOpts: SpawnOptions = {
      prompt: args.prompt,
      cwd: repoPath,
      sessionId: session.opencodeSessionId,
      agent:
        args.agentOverride ?? session.agentOverride ?? config.DEFAULT_AGENT,
      model: args.modelOverride ?? session.modelOverride,
    };

    const handle = runner.run(spawnOpts, (event) => {
      applyEvent(state, event);
      pendingText = renderProgress(state);
      if (!inFlight) void flush();
    });
    activeStreams.set(args.messageTs, handle);

    let result;
    try {
      result = await handle.done;
    } finally {
      activeStreams.delete(args.messageTs);
    }

    if (result.exitCode === 0) {
      state.done = true;
    } else if (result.signaled) {
      state.cancelled = true;
    } else {
      state.errored = true;
      const tail = result.stderr.slice(-500).trim();
      state.errorMessage =
        `opencode exited with code ${result.exitCode}` +
        (tail ? `: ${tail}` : '');
    }

    while (inFlight) await sleep(50);

    sessions.upsert(args.threadKey, (current) => {
      const base = current ?? session;
      return {
        ...base,
        opencodeSessionId: state.sessionId ?? base.opencodeSessionId,
        totalTokens: base.totalTokens + state.totalTokens,
        totalCostUsd: base.totalCostUsd + state.totalCostUsd,
        lastActiveAt: Date.now(),
      };
    });

    const fullText = state.textChunks.join('');
    const decision = decideOutputMode(fullText);

    if (state.done && decision.mode === 'file' && fullText.trim().length > 0) {
      const filename = fileNameFor(args.command, Date.now());
      const summary = renderFileSummary(state, filename, fullText.length);
      await safeUpdate(client, args.channel, args.messageTs, summary, logger);
      try {
        await uploadAsFile(client, {
          channel: args.channel,
          threadTs: args.threadKey,
          content: fullText,
          filename,
          title: filename,
        });
      } catch (err) {
        logger.error({ err }, 'file upload failed; falling back to inline');
        const truncated = fullText.slice(0, 7500) + '\n\n_(truncated)_';
        await safeUpdate(
          client,
          args.channel,
          args.messageTs,
          `❌ File upload failed; truncated output below.\n\n${truncated}`,
          logger,
        );
      }
    } else {
      await safeUpdate(
        client,
        args.channel,
        args.messageTs,
        renderProgress(state),
        logger,
      );
    }

    audit.log({
      ts: startMs,
      userId: args.userId,
      command: args.command,
      repo: repoPath,
      exitCode: result.exitCode,
      durationMs: Date.now() - startMs,
    });

    return {
      exitCode: result.exitCode,
      durationMs: Date.now() - startMs,
      cancelled: state.cancelled,
      errored: state.errored,
    };
  };
}

function renderFileSummary(
  state: ReturnType<typeof newStreamState>,
  filename: string,
  charCount: number,
  now: number = Date.now(),
): string {
  const elapsed = ((now - state.startedAtMs) / 1000).toFixed(1);
  const parts: string[] = [];
  if (state.totalTokens > 0)
    parts.push(`${state.totalTokens.toLocaleString()} tokens`);
  if (state.totalCostUsd > 0) parts.push(`$${state.totalCostUsd.toFixed(4)}`);
  parts.push(`${elapsed}s`);
  return `✅ Output too long for inline — uploaded as \`${filename}\` (${charCount.toLocaleString()} chars)\n\n_${parts.join(' · ')}_`;
}

async function safeUpdate(
  client: UpdateClient,
  channel: string,
  ts: string,
  text: string,
  logger: Logger,
): Promise<void> {
  try {
    await client.chat.update({ channel, ts, text });
  } catch (err) {
    logger.warn({ err, channel, ts }, 'chat.update failed');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
