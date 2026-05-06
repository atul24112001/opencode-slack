import type { CommandHandler } from './types.js';
import { resolveRepoArg, splitArgs } from './util.js';

export const qaCommand: CommandHandler = {
  description: 'Generate tests for a file',
  usage: '/oc qa <file-path> [repo]',
  run(args, ctx) {
    const [file, repo] = splitArgs(args);
    if (!file) {
      return { kind: 'error', text: `Usage: ${this.usage}` };
    }
    const { repoPath, error } = resolveRepoArg(repo, ctx.config);
    if (error) return { kind: 'error', text: error };
    return {
      kind: 'stream',
      spawnPrompt: `Generate tests for the file ${file}.`,
      agent: 'qa',
      ...(repoPath !== undefined ? { repoPath } : {}),
    };
  },
};
