import { formatSchedule, parseScheduleAndRemainder } from '../scheduler.js';
import type { CommandHandler } from './types.js';
import { splitArgs } from './util.js';

export const scheduleCommand: CommandHandler = {
  description: 'Schedule a recurring command (list / add / remove)',
  usage:
    '/oc schedule list | /oc schedule remove <id> | /oc schedule <when> <subcommand> [args]',
  run(args, ctx) {
    const tokens = splitArgs(args);
    const head = tokens[0]?.toLowerCase();

    if (!head) {
      return { kind: 'error', text: `Usage: ${this.usage}` };
    }

    if (head === 'list') {
      const list = ctx.scheduledTasks.listForUser(ctx.userId);
      if (list.length === 0) {
        return { kind: 'text', text: 'No scheduled tasks.' };
      }
      const lines: string[] = [`*Your scheduled tasks:*`];
      for (const t of list) {
        const next = new Date(t.nextRunAt).toISOString().slice(0, 16);
        lines.push(
          `• \`#${t.id}\` ${formatSchedule(t.schedule)} — \`${t.commandText}\` _(next: ${next}Z)_`,
        );
      }
      return { kind: 'text', text: lines.join('\n') };
    }

    if (head === 'remove' || head === 'rm' || head === 'delete') {
      const idStr = tokens[1];
      if (!idStr) {
        return { kind: 'error', text: 'Usage: /oc schedule remove <id>' };
      }
      const id = Number.parseInt(idStr, 10);
      if (Number.isNaN(id)) {
        return { kind: 'error', text: `Invalid task id: ${idStr}` };
      }
      const ok = ctx.scheduledTasks.remove(id, ctx.userId);
      return {
        kind: 'text',
        text: ok
          ? `✅ Removed scheduled task #${id}.`
          : `No scheduled task #${id} for you.`,
      };
    }

    const parsed = parseScheduleAndRemainder(args);
    if (parsed.error || !parsed.schedule) {
      return {
        kind: 'error',
        text: parsed.error ?? `Usage: ${this.usage}`,
      };
    }
    if (!parsed.remainder.trim()) {
      return {
        kind: 'error',
        text: 'Missing the inner command. Example: `/oc schedule daily 9am explore what changed yesterday`',
      };
    }
    const task = ctx.scheduledTasks.add({
      userId: ctx.userId,
      channel: ctx.channel,
      schedule: parsed.schedule,
      commandText: parsed.remainder.trim(),
      nowMs: Date.now(),
    });
    const nextStr = new Date(task.nextRunAt).toISOString().slice(0, 16);
    return {
      kind: 'text',
      text: `✅ Scheduled \`#${task.id}\` ${formatSchedule(parsed.schedule)}: \`${task.commandText}\`\n_Next run: ${nextStr}Z_`,
    };
  },
};
