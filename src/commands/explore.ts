import type { CommandHandler } from './types.js';

export const exploreCommand: CommandHandler = {
  description: 'Read-only codebase exploration',
  usage: '/oc explore <question>',
  run(args) {
    const q = args.trim();
    if (!q) {
      return { kind: 'error', text: `Usage: ${this.usage}` };
    }
    return {
      kind: 'stream',
      spawnPrompt: q,
      agent: 'explore',
    };
  },
};
