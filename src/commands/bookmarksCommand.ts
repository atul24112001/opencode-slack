import type { CommandHandler } from './types.js';

const PREVIEW_CHARS = 120;

export const bookmarksCommand: CommandHandler = {
  description: 'List your saved bookmarks',
  usage: '/oc bookmarks',
  run(_args, ctx) {
    const list = ctx.bookmarks.listForUser(ctx.userId, 20);
    if (list.length === 0) {
      return {
        kind: 'text',
        text: 'No bookmarks yet. React 📌 on a bot message to save it.',
      };
    }
    const lines: string[] = [`*Your last ${list.length} bookmark(s):*`];
    for (const b of list) {
      const date = new Date(b.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      const preview = b.snippet
        ? truncate(b.snippet.replace(/\n/g, ' '), PREVIEW_CHARS)
        : '_(no preview)_';
      const ref = b.permalink ? `<${b.permalink}|view>` : '';
      lines.push(`• \`${date}Z\` ${ref} — ${preview}`);
    }
    return { kind: 'text', text: lines.join('\n') };
  },
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
