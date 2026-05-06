import type { CommandHandler } from './types.js';
import { resolveRepoArg, splitArgs } from './util.js';

export const reviewCommand: CommandHandler = {
  description: 'Run reviewer agent on a PR',
  usage: '/oc review <PR-number> [repo]',
  run(args, ctx) {
    const [pr, repo] = splitArgs(args);
    if (!pr) {
      return { kind: 'error', text: `Usage: ${this.usage}` };
    }
    const { repoPath, error } = resolveRepoArg(repo, ctx.config);
    if (error) return { kind: 'error', text: error };
    return {
      kind: 'stream',
      spawnPrompt: `Review pull request #${pr}.`,
      agent: 'reviewer',
      ...(repoPath !== undefined ? { repoPath } : {}),
    };
  },
};
