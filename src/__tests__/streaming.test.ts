import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock child_process.spawn to return a controllable fake process
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('../memory.js', () => ({
  ensureMemoryDirs: vi.fn(),
  shouldSummarize: vi.fn().mockReturnValue(false),
  performSummarization: vi.fn().mockResolvedValue(undefined),
  runExtractionPipeline: vi.fn().mockResolvedValue({ extracted: 0, duplicates: 0, saved: [] }),
  buildMemoryContext: vi.fn().mockResolvedValue({ context: '', tokens: 0 }),
}));

vi.mock('../session.js', () => ({
  addMessage: vi.fn(),
  getHistory: vi.fn().mockReturnValue([]),
  clearHistory: vi.fn(),
  loadSessions: vi.fn(),
  _setSessionsDir: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────

/** Create a fake ChildProcess with controllable stdout/stderr */
function createFakeChild(): {
  child: ChildProcess;
  stdout: EventEmitter;
  stderr: EventEmitter;
  emitClose: (code: number) => void;
  emitError: (err: Error) => void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as unknown as ChildProcess;
  const procAny = proc as unknown as Record<string, unknown>;

  const stdin = new EventEmitter();
  const stdinAny = stdin as unknown as Record<string, unknown>;
  stdinAny.end = vi.fn();
  stdinAny.on = vi.fn().mockReturnThis();

  procAny.stdin = stdin;
  procAny.stdout = stdout;
  procAny.stderr = stderr;
  procAny.killed = false;
  procAny.pid = 12345;
  procAny.kill = vi.fn((_signal?: string) => {
    procAny.killed = true;
    return true;
  });

  return {
    child: proc,
    stdout,
    stderr,
    emitClose: (code: number) => proc.emit('close', code),
    emitError: (err: Error) => proc.emit('error', err),
  };
}

/** Build an NDJSON line for a content_block_delta event */
function textDelta(text: string): string {
  return JSON.stringify({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text },
  });
}

/** Build an NDJSON line for an assistant message event */
function assistantMessage(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

/** Build an NDJSON line for a result event */
function resultMessage(text: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// ── Import the module under test (uses the mocked spawn) ──────────────

import {
  invokeClaudeStreaming,
  invokeClaude,
  type StreamChunk,
} from '../claude.js';

// ── Tests ──────────────────────────────────────────────────────────────

describe('invokeClaudeStreaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('yields text chunks from content_block_delta events', async () => {
    const fake = createFakeChild();
    mockSpawn.mockReturnValue(fake.child);

    const handle = await invokeClaudeStreaming('hello', 'test-chat');

    // Emit chunks asynchronously
    setTimeout(() => {
      fake.stdout.emit('data', Buffer.from(textDelta('Hello') + '\n'));
      fake.stdout.emit('data', Buffer.from(textDelta(' world') + '\n'));
      fake.emitClose(0);
    }, 10);

    const chunks: string[] = [];
    for await (const chunk of handle.chunks) {
      if (chunk.type === 'text') {
        chunks.push(chunk.text);
      }
    }

    expect(chunks).toEqual(['Hello', ' world']);
  });

  it('extracts text from assistant message events (CLI 2.x --print format)', async () => {
    const fake = createFakeChild();
    mockSpawn.mockReturnValue(fake.child);

    const handle = await invokeClaudeStreaming('hello', 'test-chat');

    setTimeout(() => {
      fake.stdout.emit('data', Buffer.from(assistantMessage('Full response') + '\n'));
      fake.emitClose(0);
    }, 10);

    const chunks: string[] = [];
    for await (const chunk of handle.chunks) {
      if (chunk.type === 'text') {
        chunks.push(chunk.text);
      }
    }

    expect(chunks).toEqual(['Full response']);
  });

  it('handles lines split across multiple data events', async () => {
    const fake = createFakeChild();
    mockSpawn.mockReturnValue(fake.child);

    const handle = await invokeClaudeStreaming('hello', 'test-chat');

    const fullLine = textDelta('split-test');
    const mid = Math.floor(fullLine.length / 2);

    setTimeout(() => {
      fake.stdout.emit('data', Buffer.from(fullLine.slice(0, mid)));
      fake.stdout.emit('data', Buffer.from(fullLine.slice(mid) + '\n'));
      fake.emitClose(0);
    }, 10);

    const chunks: string[] = [];
    for await (const chunk of handle.chunks) {
      if (chunk.type === 'text') {
        chunks.push(chunk.text);
      }
    }

    expect(chunks).toEqual(['split-test']);
  });

  it('yields error on non-zero exit code', async () => {
    const fake = createFakeChild();
    mockSpawn.mockReturnValue(fake.child);

    const handle = await invokeClaudeStreaming('hello', 'test-chat');

    setTimeout(() => {
      fake.stderr.emit('data', Buffer.from('something went wrong'));
      fake.emitClose(1);
    }, 10);

    const results: StreamChunk[] = [];
    for await (const chunk of handle.chunks) {
      results.push(chunk);
    }

    const errorChunk = results.find((c) => c.type === 'error');
    expect(errorChunk).toBeDefined();
    expect(errorChunk!.text).toContain('Sorry');
  });

  it('yields error chunk on subprocess spawn error', async () => {
    const fake = createFakeChild();
    mockSpawn.mockReturnValue(fake.child);

    const handle = await invokeClaudeStreaming('hello', 'test-chat');

    setTimeout(() => {
      fake.stdout.emit('data', Buffer.from(textDelta('partial') + '\n'));
    }, 10);

    setTimeout(() => {
      const err = new Error('not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      fake.emitError(err);
    }, 30);

    const results: StreamChunk[] = [];
    for await (const chunk of handle.chunks) {
      results.push(chunk);
    }

    expect(results.some((c) => c.type === 'text' && c.text === 'partial')).toBe(true);
    expect(results.some((c) => c.type === 'error')).toBe(true);
  });

  it('abort() sends SIGTERM to subprocess', async () => {
    const fake = createFakeChild();
    mockSpawn.mockReturnValue(fake.child);

    const handle = await invokeClaudeStreaming('hello', 'test-chat');

    // Start consuming in background
    const consuming = (async () => {
      const results: StreamChunk[] = [];
      for await (const chunk of handle.chunks) {
        results.push(chunk);
      }
      return results;
    })();

    await tick();

    // Emit some data then abort
    fake.stdout.emit('data', Buffer.from(textDelta('partial') + '\n'));
    await tick();
    handle.abort();
    await tick();
    fake.emitClose(0);

    const results = await consuming;
    expect(fake.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(results.some((c) => c.type === 'text' && c.text === 'partial')).toBe(true);
  });

  it('emits done chunk on successful completion', async () => {
    const fake = createFakeChild();
    mockSpawn.mockReturnValue(fake.child);

    const handle = await invokeClaudeStreaming('hello', 'test-chat');

    setTimeout(() => {
      fake.stdout.emit('data', Buffer.from(textDelta('ok') + '\n'));
      fake.emitClose(0);
    }, 10);

    const results: StreamChunk[] = [];
    for await (const chunk of handle.chunks) {
      results.push(chunk);
    }

    expect(results.at(-1)?.type).toBe('done');
  });

  it('passes -p --output-format stream-json flags', async () => {
    const fake = createFakeChild();
    mockSpawn.mockReturnValue(fake.child);

    await invokeClaudeStreaming('hello', 'test-chat');

    // Close the process so the generator can finish
    setTimeout(() => fake.emitClose(0), 10);

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']),
      expect.any(Object),
    );
  });
});

describe('invokeClaude (batch wrapper over streaming)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns full text by collecting all stream chunks', async () => {
    const fake = createFakeChild();
    mockSpawn.mockReturnValue(fake.child);

    const promise = invokeClaude('hello', 'test-chat');

    // invokeClaude delegates to invokeClaudeStreaming — emits NDJSON
    setTimeout(() => {
      fake.stdout.emit('data', Buffer.from(textDelta('Hello') + '\n'));
      fake.stdout.emit('data', Buffer.from(textDelta(' from Titus') + '\n'));
      fake.emitClose(0);
    }, 10);

    const result = await promise;
    expect(result).toBe('Hello from Titus');
  });

  it('returns friendly error message on failure', async () => {
    const fake = createFakeChild();
    mockSpawn.mockReturnValue(fake.child);

    const promise = invokeClaude('hello', 'test-chat');

    setTimeout(() => {
      fake.stderr.emit('data', Buffer.from('bad things'));
      fake.emitClose(1);
    }, 10);

    const result = await promise;
    expect(result).toContain('Sorry');
  });
});
