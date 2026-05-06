import type { CommandHandler } from './types.js';

export const planCommand: CommandHandler = {
  description: 'Plan a task without writing code',
  usage: '/oc plan <task>',
  run(args) {
    const task = args.trim();
    if (!task) {
      return { kind: 'error', text: `Usage: ${this.usage}` };
    }
    return {
      kind: 'stream',
      spawnPrompt: task,
      agent: 'plan',
    };
  },
};
