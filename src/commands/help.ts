import type { CommandHandler } from './types.js';

const HELP_USAGE = '/oc help';
const HELP_DESCRIPTION = 'Show all commands';

export function buildHelpCommand(
  others: Record<string, CommandHandler>,
): CommandHandler {
  return {
    description: HELP_DESCRIPTION,
    usage: HELP_USAGE,
    run() {
      const lines: string[] = ['*OpenCode bot commands:*'];
      for (const cmd of Object.values(others)) {
        lines.push(`• \`${cmd.usage}\` — ${cmd.description}`);
      }
      lines.push(`• \`${HELP_USAGE}\` — ${HELP_DESCRIPTION}`);
      lines.push(
        '',
        '_Free-form DMs run with the default agent. Slash commands are for structured operations._',
        '_React ❌ on a running message to cancel it (best-effort — side effects are not rolled back)._',
      );
      return { kind: 'text', text: lines.join('\n') };
    },
  };
}
