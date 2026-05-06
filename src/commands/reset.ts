import type { CommandHandler } from './types.js';

export const resetCommand: CommandHandler = {
  description: 'Forget this thread\'s session',
  usage: '/oc reset',
  run(_args, ctx) {
    if (!ctx.threadKey) {
      return {
        kind: 'text',
        text: 'Run `/oc reset` from inside a thread to forget that thread\'s session.',
      };
    }
    const ok = ctx.sessions.delete(ctx.threadKey);
    return {
      kind: 'text',
      text: ok ? '✅ Session forgotten for this thread.' : 'No session to reset.',
    };
  },
};
