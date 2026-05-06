import { describe, expect, it } from 'vitest';
import { toMrkdwn } from '../../src/mrkdwn.js';

describe('toMrkdwn', () => {
  it('converts **bold** to *bold*', () => {
    expect(toMrkdwn('**hello**')).toBe('*hello*');
  });

  it('converts # heading to *heading*', () => {
    expect(toMrkdwn('# Hello')).toBe('*Hello*');
    expect(toMrkdwn('## Sub')).toBe('*Sub*');
  });

  it('converts [text](url) to <url|text>', () => {
    expect(toMrkdwn('see [docs](https://example.com)')).toBe(
      'see <https://example.com|docs>',
    );
  });

  it('preserves code fences unchanged', () => {
    const input = '**before**\n```\n**inside-fence-stays**\n```\n**after**';
    const out = toMrkdwn(input);
    expect(out).toContain('```\n**inside-fence-stays**\n```');
    expect(out).toContain('*before*');
    expect(out).toContain('*after*');
  });

  it('preserves inline code unchanged', () => {
    expect(toMrkdwn('`**not bold**` and **bold**')).toBe(
      '`**not bold**` and *bold*',
    );
  });

  it('handles empty input', () => {
    expect(toMrkdwn('')).toBe('');
  });
});
