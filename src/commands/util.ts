import type { Config } from '../config.js';

export interface RepoResolution {
  repoPath?: string;
  error?: string;
}

export function resolveRepoArg(
  arg: string | undefined,
  config: Config,
): RepoResolution {
  if (!arg) return {};
  const matches = config.ALLOWED_REPOS.filter(
    (p) => p === arg || p.endsWith(`/${arg}`),
  );
  if (matches.length === 0) {
    return { error: `Repo "${arg}" is not in ALLOWED_REPOS.` };
  }
  if (matches.length > 1) {
    return { error: `Repo "${arg}" is ambiguous — multiple matches in ALLOWED_REPOS.` };
  }
  const first = matches[0];
  if (!first) return { error: `Repo "${arg}" is not in ALLOWED_REPOS.` };
  return { repoPath: first };
}

export function splitArgs(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}
