import type { CommandHandler } from './types.js';

export const continueCommand: CommandHandler = {
  description: "Continue your most recent session with a new prompt",
  usage: '/oc continue <prompt>',
  run(args, ctx) {
    const prompt = args.trim();
    if (!prompt) {
      return { kind: 'error', text: `Usage: ${this.usage}` };
    }
    const last = ctx.sessions.getMostRecentForUser(ctx.userId);
    if (!last) {
      return {
        kind: 'error',
        text: 'No prior session found for you. Start one with a DM or `/oc explore <q>`.',
      };
    }
    return {
      kind: 'stream',
      spawnPrompt: prompt,
      ...(last.agentOverride ? { agent: last.agentOverride } : {}),
      ...(last.modelOverride ? { model: last.modelOverride } : {}),
      repoPath: last.repoPath,
      opencodeSessionIdOverride: last.opencodeSessionId,
    };
  },
};
