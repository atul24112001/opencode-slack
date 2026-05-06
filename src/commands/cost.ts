import type { CommandHandler } from './types.js';

export const costCommand: CommandHandler = {
  description: 'Token + cost summary',
  usage: '/oc cost',
  run(_args, ctx) {
    const lines: string[] = [];

    if (ctx.threadKey) {
      const session = ctx.sessions.get(ctx.threadKey);
      if (session) {
        lines.push(
          `*This thread:* ${session.totalTokens.toLocaleString()} tokens · $${session.totalCostUsd.toFixed(4)}`,
        );
      } else {
        lines.push('*This thread:* no session yet');
      }
    }

    const dayStart = startOfDay();
    const today = ctx.sessions.costForUserSinceMs(ctx.userId, dayStart);
    lines.push(
      `*You today:* ${today.tokens.toLocaleString()} tokens · $${today.costUsd.toFixed(4)}`,
    );

    const monthStart = startOfMonth();
    const month = ctx.sessions.costForAllSinceMs(monthStart);
    lines.push(
      `*Workspace this month:* ${month.tokens.toLocaleString()} tokens · $${month.costUsd.toFixed(4)}`,
    );

    lines.push(
      `*Per-session limit:* $${ctx.config.MAX_COST_PER_SESSION_USD.toFixed(2)}`,
    );

    return { kind: 'text', text: lines.join('\n') };
  },
};

function startOfDay(now: Date = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonth(now: Date = new Date()): number {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
