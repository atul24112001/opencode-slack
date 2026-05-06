import type { CommandHandler } from './types.js';

export const bgCommand: CommandHandler = {
  description: 'Run a long task in the background — DM you when done',
  usage: '/oc bg <prompt>',
  run(args, ctx) {
    const prompt = args.trim();
    if (!prompt) {
      return { kind: 'error', text: `Usage: ${this.usage}` };
    }
    const job = ctx.backgroundJobs.enqueue({
      userId: ctx.userId,
      initiatingChannel: ctx.channel,
      initiatingTs: '',
      prompt,
    });
    const truncated = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;
    return {
      kind: 'text',
      text: `🟡 Background job #${job.id} queued: \`${truncated}\`. I'll DM you when it's done.`,
    };
  },
};
