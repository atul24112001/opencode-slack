import { agentCommand } from './agent.js';
import { costCommand } from './cost.js';
import { exploreCommand } from './explore.js';
import { buildHelpCommand } from './help.js';
import { modelCommand } from './model.js';
import { planCommand } from './plan.js';
import { qaCommand } from './qa.js';
import { resetCommand } from './reset.js';
import { reviewCommand } from './review.js';
import { shipCommand } from './ship.js';
import type { CommandHandler } from './types.js';

const baseCommands: Record<string, CommandHandler> = {
  review: reviewCommand,
  qa: qaCommand,
  ship: shipCommand,
  explore: exploreCommand,
  plan: planCommand,
  model: modelCommand,
  agent: agentCommand,
  cost: costCommand,
  reset: resetCommand,
};

export const commands: Record<string, CommandHandler> = {
  ...baseCommands,
  help: buildHelpCommand(baseCommands),
};

export interface ParsedSlash {
  name: string;
  args: string;
}

export function parseSlashCommand(text: string): ParsedSlash {
  const trimmed = text.trim();
  const idx = trimmed.search(/\s/);
  if (idx === -1) {
    return { name: trimmed.toLowerCase(), args: '' };
  }
  return {
    name: trimmed.slice(0, idx).toLowerCase(),
    args: trimmed.slice(idx + 1),
  };
}

export type { CommandHandler, CommandResult, CommandContext } from './types.js';
