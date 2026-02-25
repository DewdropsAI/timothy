import { spawn } from 'node:child_process';
import type { CognitiveAdapter } from '../adapter.js';
import { collectStreamToResult } from '../adapter.js';
import type { AdapterInput, StreamHandle, StreamChunk, HealthCheckResult, ThoughtResult } from '../types.js';

type ErrorKind = 'timeout' | 'cli-not-found' | 'non-zero-exit' | 'spawn-error';

class ClaudeCliError extends Error {
  constructor(public readonly kind: ErrorKind, message: string) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

function generateErrorRef(): string {
  return Date.now().toString(36).slice(-6);
}

function friendlyMessage(kind: ErrorKind, ref: string): string {
  const suffix = ` (ref: ${ref})`;
  switch (kind) {
    case 'timeout':
      return `Sorry, that took too long. Please try again or simplify your request.${suffix}`;
    case 'cli-not-found':
      return `Claude Code CLI is not available right now. Please check the server configuration.${suffix}`;
    case 'non-zero-exit':
      return `Sorry, something went wrong while processing your message. Please try again.${suffix}`;
    case 'spawn-error':
      return `Sorry, I couldn't start the Claude Code process. Please try again later.${suffix}`;
  }
}

/**
 * Extract text from a parsed NDJSON line emitted by `--output-format stream-json`.
 *
 * Handles two formats:
 * - `content_block_delta` events (incremental text deltas, older CLI versions)
 * - `assistant` events (full response in message.content[], CLI 2.x with --print)
 *
 * Also falls back to the `result` event's `.result` field as a last resort.
 */
function extractTextDelta(parsed: Record<string, unknown>): string | null {
  if (parsed.type === 'content_block_delta') {
    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
      return delta.text;
    }
  }

  if (parsed.type === 'assistant') {
    const message = parsed.message as Record<string, unknown> | undefined;
    if (message && Array.isArray(message.content)) {
      const texts = (message.content as Array<Record<string, unknown>>)
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string);
      if (texts.length > 0) {
        return texts.join('');
      }
    }
  }

  if (parsed.type === 'result' && typeof parsed.result === 'string' && parsed.result.length > 0) {
    return parsed.result;
  }

  return null;
}

function buildInput(message: string, history: Array<{ role: string; content: string }>): string {
  if (history.length === 0) {
    return message;
  }
  const formatted = history
    .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
    .join('\n\n');

  return `${formatted}\n\nHuman: ${message}`;
}

/**
 * Claude Code CLI adapter.
 * Spawns the `claude` CLI as a subprocess with streaming NDJSON output.
 */
export class ClaudeCodeCliAdapter implements CognitiveAdapter {
  readonly name = 'claude-code-cli';

  async invoke(input: AdapterInput): Promise<ThoughtResult> {
    const startMs = Date.now();
    const handle = await this.invokeStreaming(input);
    return collectStreamToResult(handle, this.name, input.route.model, startMs);
  }

  async invokeStreaming(input: AdapterInput): Promise<StreamHandle> {
    const { route, effectiveMode, workspacePath } = input;
    const timeoutMs = route.timeoutMs;

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', route.model];
    if (effectiveMode === 'yolo') {
      args.push('--dangerously-skip-permissions');
    }
    if (input.systemPrompt) {
      args.push('--system-prompt', input.systemPrompt);
    }

    const stdinInput = buildInput(input.message, input.history);

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn('claude', args, {
      cwd: workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    child.stdin!.on('error', (err) => {
      console.error(`[claude-cli] stdin error: ${err.message}`);
    });
    child.stdin!.end(stdinInput);

    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    function abort(): void {
      if (aborted) return;
      aborted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 3000);
    }

    const timeoutTimer = setTimeout(() => abort(), timeoutMs);

    async function* generate(): AsyncGenerator<StreamChunk, void, unknown> {
      let buffer = '';
      let stderr = '';
      let spawnError: ClaudeCliError | null = null;
      let exitCode: number | null = null;
      let exited = false;

      const queue: Array<StreamChunk | null> = [];
      let resolveWait: (() => void) | null = null;

      function enqueue(item: StreamChunk | null): void {
        queue.push(item);
        if (resolveWait) {
          const r = resolveWait;
          resolveWait = null;
          r();
        }
      }

      function waitForItem(): Promise<void> {
        if (queue.length > 0) return Promise.resolve();
        return new Promise<void>((resolve) => { resolveWait = resolve; });
      }

      let gotFullResponse = false;

      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;

            if (parsed.type === 'result' && gotFullResponse) continue;

            const text = extractTextDelta(parsed);
            if (text) {
              if (parsed.type === 'assistant' || parsed.type === 'result') {
                gotFullResponse = true;
              }
              enqueue({ type: 'text', text });
            }
          } catch {
            // Non-JSON line, skip
          }
        }
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          spawnError = new ClaudeCliError('cli-not-found', 'Claude Code CLI is not installed or not on PATH.');
        } else if (err.name === 'AbortError') {
          spawnError = new ClaudeCliError('timeout', `Request timed out after ${timeoutMs / 1000} seconds.`);
        } else {
          spawnError = new ClaudeCliError('spawn-error', `Failed to start Claude CLI: ${err.message}`);
        }
        enqueue(null);
      });

      child.on('close', (code) => {
        exited = true;
        exitCode = code;
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        enqueue(null);
      });

      while (true) {
        await waitForItem();

        while (queue.length > 0) {
          const item = queue.shift()!;
          if (item === null) {
            if (spawnError) {
              const err = spawnError as unknown as ClaudeCliError;
              const ref = generateErrorRef();
              console.error(`[claude-cli] ref=${ref} ${err.kind}: ${err.message}`);
              yield { type: 'error', text: friendlyMessage(err.kind, ref) };
              return;
            }
            if (exited) {
              if (exitCode !== 0 && exitCode !== null) {
                const ref = generateErrorRef();
                const detail = stderr.trim() || `exit code ${exitCode}`;
                console.error(`[claude-cli] ref=${ref} non-zero-exit: Claude CLI exited with code ${exitCode}: ${detail}`);
                yield { type: 'error', text: friendlyMessage('non-zero-exit', ref) };
                return;
              }
              yield { type: 'done', text: '' };
              return;
            }
            continue;
          }
          yield item;
        }
      }
    }

    return { chunks: generate(), abort };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const startMs = Date.now();
    return new Promise<HealthCheckResult>((resolve) => {
      const child = spawn('claude', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          healthy: false,
          message: 'Health check timed out',
          latencyMs: Date.now() - startMs,
        });
      }, 5000);

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          healthy: false,
          message: err instanceof Error ? err.message : 'Spawn failed',
          latencyMs: Date.now() - startMs,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          healthy: code === 0,
          message: code === 0 ? stdout.trim() : `Exit code ${code}`,
          latencyMs: Date.now() - startMs,
        });
      });
    });
  }
}
