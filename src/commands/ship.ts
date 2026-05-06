import type { CommandHandler } from './types.js';

const PLAN_ONLY_FLAG = '--plan-only';

export const shipCommand: CommandHandler = {
  description: 'Implement + branch + test + open PR (use --plan-only for dry-run)',
  usage: '/oc ship [--plan-only] <task description>',
  run(args) {
    let task = args.trim();
    let agent = 'ship';
    if (task.startsWith(PLAN_ONLY_FLAG)) {
      task = task.slice(PLAN_ONLY_FLAG.length).trim();
      agent = 'plan';
    }
    if (!task) {
      return { kind: 'error', text: `Usage: ${this.usage}` };
    }
    return {
      kind: 'stream',
      spawnPrompt: task,
      agent,
    };
  },
};
