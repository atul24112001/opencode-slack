import type { CommandHandler } from './types.js';

export const modelCommand: CommandHandler = {
  description: 'Show or set the model for this thread',
  usage: '/oc model [model-id]',
  run(args, ctx) {
    if (!ctx.threadKey) {
      return {
        kind: 'text',
        text: 'Run `/oc model` from inside a thread to view or set its model.',
      };
    }
    const target = args.trim();
    const session = ctx.sessions.get(ctx.threadKey);

    if (!target) {
      const current =
        session?.modelOverride ??
        '_(default — whatever your `opencode /connect` is set to)_';
      return { kind: 'text', text: `Current model: \`${current}\`` };
    }

    if (!session) {
      return {
        kind: 'error',
        text: 'No session in this thread yet — send a message in this thread first, then set the model.',
      };
    }

    ctx.sessions.upsert(ctx.threadKey, (current) => ({
      ...(current ?? session),
      modelOverride: target,
      lastActiveAt: Date.now(),
    }));

    return {
      kind: 'text',
      text: `Model switched to \`${target}\`. Applies on your next message in this thread.`,
    };
  },
};
