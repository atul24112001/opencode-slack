import type { BackgroundJobStore } from '../backgroundJobs.js';
import type { BookmarkStore } from '../bookmarks.js';
import type { Config } from '../config.js';
import type { ScheduledTaskStore } from '../scheduledTasks.js';
import type { SessionStore } from '../sessions.js';

export type CommandResult =
  | { kind: 'text'; text: string }
  | { kind: 'blocks'; blocks: unknown[]; fallback: string }
  | {
      kind: 'stream';
      spawnPrompt: string;
      agent?: string;
      model?: string;
      repoPath?: string;
      opencodeSessionIdOverride?: string | null;
    }
  | { kind: 'error'; text: string };

export interface CommandContext {
  config: Config;
  sessions: SessionStore;
  bookmarks: BookmarkStore;
  scheduledTasks: ScheduledTaskStore;
  backgroundJobs: BackgroundJobStore;
  userId: string;
  threadKey: string | null;
  channel: string;
}

export interface CommandHandler {
  description: string;
  usage: string;
  run(args: string, ctx: CommandContext): CommandResult;
}
