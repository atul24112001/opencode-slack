import type { OpencodeEvent } from './opencode.js';
import { INLINE_BLOCK_LIMIT, INLINE_CHAR_LIMIT } from './types.js';

export interface StreamState {
  textChunks: string[];
  toolCalls: number;
  currentTool: string | null;
  totalTokens: number;
  totalCostUsd: number;
  sessionId: string | null;
  done: boolean;
  errored: boolean;
  errorMessage: string | null;
  cancelled: boolean;
  startedAtMs: number;
}

export function newStreamState(now: number = Date.now()): StreamState {
  return {
    textChunks: [],
    toolCalls: 0,
    currentTool: null,
    totalTokens: 0,
    totalCostUsd: 0,
    sessionId: null,
    done: false,
    errored: false,
    errorMessage: null,
    cancelled: false,
    startedAtMs: now,
  };
}

export function applyEvent(state: StreamState, event: OpencodeEvent): void {
  if (event.sessionId && !state.sessionId) {
    state.sessionId = event.sessionId;
  }
  switch (normalizeType(event.type)) {
    case 'text':
      if (event.text) state.textChunks.push(event.text);
      return;
    case 'tool-use':
      state.toolCalls += 1;
      state.currentTool =
        event.toolDescription ?? event.toolName ?? state.currentTool;
      return;
    case 'step-finish':
      if (typeof event.tokens === 'number') state.totalTokens += event.tokens;
      if (typeof event.costUsd === 'number')
        state.totalCostUsd += event.costUsd;
      return;
    case 'error':
      state.errored = true;
      state.errorMessage = event.text ?? 'Unknown error';
      return;
    default:
      return;
  }
}

function normalizeType(type: string): string {
  return type.replaceAll('_', '-');
}

export function renderProgress(
  state: StreamState,
  now: number = Date.now(),
): string {
  if (state.errored) {
    return `❌ ${state.errorMessage ?? 'Error'}`;
  }
  if (state.cancelled) {
    const body = joinedText(state).trim();
    return body ? `🛑 Cancelled.\n\n${body}` : '🛑 Cancelled.';
  }

  const text = joinedText(state).trim();

  if (state.done) {
    const parts: string[] = [];
    if (state.totalTokens > 0) {
      parts.push(`${state.totalTokens.toLocaleString()} tokens`);
    }
    if (state.totalCostUsd > 0) {
      parts.push(`$${state.totalCostUsd.toFixed(4)}`);
    }
    const elapsed = ((now - state.startedAtMs) / 1000).toFixed(1);
    parts.push(`${elapsed}s`);
    return `✅ ${text || '_(no output)_'}\n\n_${parts.join(' · ')}_`;
  }

  if (text) return `🕐 ${text}`;
  if (state.currentTool) return `🕐 _${state.currentTool}_`;
  return '🕐 _Thinking..._';
}

export interface OutputDecision {
  mode: 'inline' | 'file';
  text: string;
}

export function decideOutputMode(text: string): OutputDecision {
  const blocks = estimateBlockCount(text);
  if (text.length <= INLINE_CHAR_LIMIT && blocks <= INLINE_BLOCK_LIMIT) {
    return { mode: 'inline', text };
  }
  return { mode: 'file', text };
}

function estimateBlockCount(text: string): number {
  if (!text) return 1;
  const codeFences = (text.match(/```/g)?.length ?? 0) / 2;
  const headings = text.match(/^#{1,6}\s/gm)?.length ?? 0;
  const lists = text.match(/^[-*]\s/gm)?.length ?? 0;
  return Math.max(1, Math.ceil(codeFences) + headings + Math.ceil(lists / 5));
}

function joinedText(state: StreamState): string {
  return state.textChunks.join('');
}
