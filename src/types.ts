export interface Session {
  threadTs: string;
  userId: string;
  opencodeSessionId: string | null;
  repoPath: string;
  modelOverride: string | null;
  agentOverride: string | null;
  lastActiveAt: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  userId: string;
  command: string;
  repo: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

export const INLINE_BLOCK_LIMIT = 35;
export const INLINE_CHAR_LIMIT = 8000;
