import type { CommandHandler } from './types.js';

export const shipCommand: CommandHandler = {
  description: 'Implement + branch + test + open PR',
  usage: '/oc ship <task description>',
  run(args) {
    const task = args.trim();
    if (!task) {
      return { kind: 'error', text: `Usage: ${this.usage}` };
    }
    return {
      kind: 'stream',
      spawnPrompt: task,
      agent: 'ship',
    };
  },
};
