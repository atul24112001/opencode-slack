import type { Config } from '../config.js';
import type { SessionStore } from '../sessions.js';

export type CommandResult =
  | { kind: 'text'; text: string }
  | {
      kind: 'stream';
      spawnPrompt: string;
      agent?: string;
      model?: string;
      repoPath?: string;
    }
  | { kind: 'error'; text: string };

export interface CommandContext {
  config: Config;
  sessions: SessionStore;
  userId: string;
  threadKey: string | null;
}

export interface CommandHandler {
  description: string;
  usage: string;
  run(args: string, ctx: CommandContext): CommandResult;
}
