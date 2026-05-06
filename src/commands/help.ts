import type { CommandHandler } from './types.js';

const HELP_USAGE = '/oc help';
const HELP_DESCRIPTION = 'Show all commands';

const STREAM_BLOCK = [
  '*Run opencode against a repo:*',
  '• `/oc review <PR> [repo]` — review a pull request',
  '• `/oc qa <file> [repo]` — generate tests for a file',
  '• `/oc ship [--plan-only] <task>` — implement (`--plan-only` = plan, no code)',
  '• `/oc explore <question>` — read-only exploration',
  '• `/oc plan <task>` — plan without writing code',
  '• `/oc bg <prompt>` — run in background, DM you when done',
].join('\n');

const SESSION_BLOCK = [
  '*Thread / session:*',
  '• `/oc continue <prompt>` — resume your most recent session',
  '• `/oc model [id]` — show or set model for this thread',
  '• `/oc agent [name]` — show or set agent for this thread',
  '• `/oc cost` — token / cost summary',
  '• `/oc reset` — forget this thread\'s session',
].join('\n');

const OTHER_BLOCK = [
  '*Other:*',
  '• `/oc schedule <when> <subcommand>` — recurring task (also `list`, `remove <id>`)',
  '• `/oc bookmarks` — list your saved messages',
  '• `/oc help` — show this',
].join('\n');

const FOOTER =
  'React 📌 on a bot message to bookmark it · React ❌ to cancel a running task';

export function buildHelpCommand(_others: Record<string, CommandHandler>): CommandHandler {
  return {
    description: HELP_DESCRIPTION,
    usage: HELP_USAGE,
    run() {
      const blocks = [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'OpenCode bot', emoji: false },
        },
        { type: 'section', text: { type: 'mrkdwn', text: STREAM_BLOCK } },
        { type: 'section', text: { type: 'mrkdwn', text: SESSION_BLOCK } },
        { type: 'section', text: { type: 'mrkdwn', text: OTHER_BLOCK } },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: FOOTER }],
        },
      ];
      const fallback = [
        '*OpenCode bot commands*',
        '',
        STREAM_BLOCK,
        '',
        SESSION_BLOCK,
        '',
        OTHER_BLOCK,
        '',
        FOOTER,
      ].join('\n');
      return { kind: 'blocks', blocks, fallback };
    },
  };
}
