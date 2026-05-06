import type { CommandHandler } from './types.js';

export const agentCommand: CommandHandler = {
  description: 'Show or set the agent for this thread',
  usage: '/oc agent [agent-name]',
  run(args, ctx) {
    if (!ctx.threadKey) {
      return {
        kind: 'text',
        text: 'Run `/oc agent` from inside a thread to view or set its agent.',
      };
    }
    const target = args.trim();
    const session = ctx.sessions.get(ctx.threadKey);

    if (!target) {
      const current = session?.agentOverride ?? ctx.config.DEFAULT_AGENT;
      return { kind: 'text', text: `Current agent: \`${current}\`` };
    }

    if (!session) {
      return {
        kind: 'error',
        text: 'No session in this thread yet — send a message in this thread first, then set the agent.',
      };
    }

    ctx.sessions.upsert(ctx.threadKey, (current) => ({
      ...(current ?? session),
      agentOverride: target,
      lastActiveAt: Date.now(),
    }));

    return {
      kind: 'text',
      text: `Agent switched to \`${target}\`. Applies on your next message in this thread.`,
    };
  },
};
