import { describe, it, expect } from 'vitest';
import {
  applyEvent,
  decideOutputMode,
  newStreamState,
  renderProgress,
} from '../../src/formatter.js';

describe('applyEvent', () => {
  it('captures session ID from the first event with one', () => {
    const state = newStreamState(0);
    applyEvent(state, { type: 'step_start', sessionId: 'ses_abc', raw: {} });
    expect(state.sessionId).toBe('ses_abc');
  });

  it('does not overwrite session ID once captured', () => {
    const state = newStreamState(0);
    applyEvent(state, { type: 'step_start', sessionId: 'ses_abc', raw: {} });
    applyEvent(state, { type: 'step_start', sessionId: 'ses_xyz', raw: {} });
    expect(state.sessionId).toBe('ses_abc');
  });

  it('accumulates text from text events', () => {
    const state = newStreamState(0);
    applyEvent(state, { type: 'text', text: 'Hello, ', raw: {} });
    applyEvent(state, { type: 'text', text: 'world!', raw: {} });
    expect(state.textChunks.join('')).toBe('Hello, world!');
  });

  it('counts tool calls and captures the tool description on tool_use', () => {
    const state = newStreamState(0);
    applyEvent(state, {
      type: 'tool_use',
      toolName: 'bash',
      toolDescription: 'Lists files in current directory',
      raw: {},
    });
    expect(state.toolCalls).toBe(1);
    expect(state.currentTool).toBe('Lists files in current directory');
  });

  it('falls back to tool name when description missing', () => {
    const state = newStreamState(0);
    applyEvent(state, { type: 'tool_use', toolName: 'bash', raw: {} });
    expect(state.currentTool).toBe('bash');
  });

  it('accumulates tokens and cost from step_finish events', () => {
    const state = newStreamState(0);
    applyEvent(state, {
      type: 'step_finish',
      tokens: 1000,
      costUsd: 0.01,
      raw: {},
    });
    applyEvent(state, {
      type: 'step_finish',
      tokens: 500,
      costUsd: 0.005,
      raw: {},
    });
    expect(state.totalTokens).toBe(1500);
    expect(state.totalCostUsd).toBeCloseTo(0.015);
  });

  it('marks errored on error event', () => {
    const state = newStreamState(0);
    applyEvent(state, { type: 'error', text: 'Provider error', raw: {} });
    expect(state.errored).toBe(true);
    expect(state.errorMessage).toBe('Provider error');
  });

  it('normalises step-finish underscore variant', () => {
    const state = newStreamState(0);
    applyEvent(state, {
      type: 'step-finish',
      tokens: 100,
      costUsd: 0.001,
      raw: {},
    });
    expect(state.totalTokens).toBe(100);
  });
});

describe('renderProgress', () => {
  it('shows _Thinking..._ initially', () => {
    expect(renderProgress(newStreamState(0), 0)).toBe('🕐 _Thinking..._');
  });

  it('shows tool description while no text yet', () => {
    const state = newStreamState(0);
    state.currentTool = 'Reading package.json';
    expect(renderProgress(state, 0)).toBe('🕐 _Reading package.json_');
  });

  it('shows accumulated text when present', () => {
    const state = newStreamState(0);
    state.textChunks.push('Hello world');
    expect(renderProgress(state, 0)).toBe('🕐 Hello world');
  });

  it('renders ✅ + cost summary when done', () => {
    const state = newStreamState(0);
    state.textChunks.push('Done.');
    state.totalTokens = 1234;
    state.totalCostUsd = 0.05;
    state.done = true;
    expect(renderProgress(state, 5000)).toBe(
      '✅ Done.\n\n_1,234 tokens · $0.0500 · 5.0s_',
    );
  });

  it('omits zero token / zero cost lines from summary', () => {
    const state = newStreamState(0);
    state.textChunks.push('hi');
    state.done = true;
    const out = renderProgress(state, 1000);
    expect(out).toContain('1.0s');
    expect(out).not.toContain('0 tokens');
    expect(out).not.toContain('$0.0000');
  });

  it('renders ❌ on error', () => {
    const state = newStreamState(0);
    state.errored = true;
    state.errorMessage = 'something broke';
    expect(renderProgress(state, 0)).toBe('❌ something broke');
  });

  it('renders 🛑 Cancelled with partial text', () => {
    const state = newStreamState(0);
    state.cancelled = true;
    state.textChunks.push('partial output');
    expect(renderProgress(state, 0)).toBe('🛑 Cancelled.\n\npartial output');
  });

  it('renders bare 🛑 Cancelled when no text', () => {
    const state = newStreamState(0);
    state.cancelled = true;
    expect(renderProgress(state, 0)).toBe('🛑 Cancelled.');
  });
});

describe('decideOutputMode', () => {
  it('chooses inline for short text', () => {
    expect(decideOutputMode('hello').mode).toBe('inline');
  });

  it('chooses file when over the char limit', () => {
    expect(decideOutputMode('a'.repeat(8001)).mode).toBe('file');
  });

  it('chooses file when too many headings push block count over limit', () => {
    const headings = Array(40).fill('# Heading').join('\n');
    expect(decideOutputMode(headings).mode).toBe('file');
  });

  it('chooses inline when right at boundary', () => {
    expect(decideOutputMode('a'.repeat(7999)).mode).toBe('inline');
  });
});
