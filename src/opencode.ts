import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Logger } from 'pino';

export interface OpencodeEvent {
  type: string;
  sessionId?: string;
  text?: string;
  tokens?: number;
  costUsd?: number;
  toolName?: string;
  toolDescription?: string;
  raw: Record<string, unknown>;
}

export interface SpawnOptions {
  prompt: string;
  cwd: string;
  sessionId?: string | null;
  agent?: string | null;
  model?: string | null;
}

export interface RunResult {
  exitCode: number | null;
  stderr: string;
  signaled: boolean;
}

export interface RunHandle {
  done: Promise<RunResult>;
  cancel(): Promise<void>;
}

export interface OpencodeRunner {
  run(opts: SpawnOptions, onEvent: (e: OpencodeEvent) => void): RunHandle;
}

const STDERR_TAIL_BYTES = 8192;
const SIGTERM_GRACE_MS = 3000;

export function createOpencodeRunner(
  bin: string,
  logger: Logger,
): OpencodeRunner {
  return {
    run(opts, onEvent): RunHandle {
      const args = buildArgs(opts);
      logger.debug({ bin, args, cwd: opts.cwd }, 'spawn opencode');

      const child = spawn(bin, args, {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderrBuf = '';
      let signaled = false;

      if (child.stdout) {
        const reader = createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });
        reader.on('line', (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          const event = parseLine(trimmed);
          if (event) {
            try {
              onEvent(event);
            } catch (err) {
              logger.error({ err }, 'opencode event handler threw');
            }
          }
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          stderrBuf += chunk.toString();
          if (stderrBuf.length > STDERR_TAIL_BYTES) {
            stderrBuf = stderrBuf.slice(-STDERR_TAIL_BYTES);
          }
        });
      }

      const done = new Promise<RunResult>((resolve) => {
        child.once('exit', (code, signal) => {
          resolve({
            exitCode: code,
            stderr: stderrBuf,
            signaled: signaled || signal !== null,
          });
        });
        child.once('error', (err) => {
          logger.error({ err }, 'opencode subprocess error');
          resolve({
            exitCode: null,
            stderr: stderrBuf || String(err),
            signaled,
          });
        });
      });

      return {
        done,
        async cancel(): Promise<void> {
          if (child.killed || child.exitCode !== null) return;
          signaled = true;
          child.kill('SIGTERM');
          const finished = await Promise.race([
            done.then(() => true),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), SIGTERM_GRACE_MS),
            ),
          ]);
          if (!finished && child.exitCode === null) {
            child.kill('SIGKILL');
          }
        },
      };
    },
  };
}

function buildArgs(opts: SpawnOptions): string[] {
  const args = ['run', '--format', 'json'];
  if (opts.sessionId) args.push('--session', opts.sessionId);
  if (opts.agent) args.push('--agent', opts.agent);
  if (opts.model) args.push('--model', opts.model);
  args.push(opts.prompt);
  return args;
}

export function parseLine(line: string): OpencodeEvent | null {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = typeof raw.type === 'string' ? raw.type : 'unknown';
  const sessionId =
    typeof raw.sessionID === 'string' ? raw.sessionID : undefined;

  const part =
    typeof raw.part === 'object' && raw.part !== null
      ? (raw.part as Record<string, unknown>)
      : {};

  const text = typeof part.text === 'string' ? part.text : undefined;

  let tokens: number | undefined;
  if (typeof part.tokens === 'object' && part.tokens !== null) {
    const t = part.tokens as Record<string, unknown>;
    if (typeof t.total === 'number') tokens = t.total;
  }

  const costUsd = typeof part.cost === 'number' ? part.cost : undefined;

  const toolName = typeof part.tool === 'string' ? part.tool : undefined;
  let toolDescription: string | undefined;
  if (typeof part.state === 'object' && part.state !== null) {
    const s = part.state as Record<string, unknown>;
    if (typeof s.title === 'string') {
      toolDescription = s.title;
    } else if (typeof s.input === 'object' && s.input !== null) {
      const inp = s.input as Record<string, unknown>;
      if (typeof inp.description === 'string') {
        toolDescription = inp.description;
      }
    }
  }

  const event: OpencodeEvent = { type, raw };
  if (sessionId) event.sessionId = sessionId;
  if (text !== undefined) event.text = text;
  if (tokens !== undefined) event.tokens = tokens;
  if (costUsd !== undefined) event.costUsd = costUsd;
  if (toolName !== undefined) event.toolName = toolName;
  if (toolDescription !== undefined) event.toolDescription = toolDescription;
  return event;
}
