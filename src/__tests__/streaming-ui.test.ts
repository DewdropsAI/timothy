import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import type { StreamChunk, StreamHandle } from '../claude.js';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('../claude.js', () => ({
  invokeClaudeStreaming: vi.fn(),
  invokeClaude: vi.fn(),
  extractWritebacks: vi.fn().mockReturnValue({ directives: [], cleanResponse: '' }),
}));

vi.mock('../workspace.js', () => ({
  ensureWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../memory.js', () => ({
  ensureMemoryDirs: vi.fn(),
  shouldSummarize: vi.fn().mockReturnValue(false),
  performSummarization: vi.fn().mockResolvedValue(undefined),
  runExtractionPipeline: vi.fn().mockResolvedValue({ extracted: 0, duplicates: 0, saved: [] }),
  buildMemoryContext: vi.fn().mockResolvedValue({ context: '', tokens: 0 }),
}));

vi.mock('../auth.js', () => ({
  loadAuth: vi.fn(),
  verifyCode: vi.fn().mockReturnValue({ success: false }),
}));

vi.mock('../session.js', () => ({
  addMessage: vi.fn(),
  getHistory: vi.fn().mockReturnValue([]),
  clearHistory: vi.fn(),
  loadSessions: vi.fn(),
  _setSessionsDir: vi.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────

import { render, cleanup } from 'ink-testing-library';
import StreamingResponse from '../tui/StreamingResponse.js';
import App from '../tui/App.js';
import { invokeClaudeStreaming } from '../claude.js';
import { addMessage } from '../session.js';

const mockedStreaming = vi.mocked(invokeClaudeStreaming);
const mockedAddMessage = vi.mocked(addMessage);

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// ── StreamingResponse component tests ──────────────────────────────────

describe('StreamingResponse component', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows thinking indicator with elapsed time before first chunk', async () => {
    // Create an async generator that never yields (simulates waiting)
    async function* neverYield(): AsyncGenerator<StreamChunk> {
      await new Promise(() => {}); // Never resolves
    }

    const handle: StreamHandle = { chunks: neverYield(), abort: vi.fn() };

    const instance = render(
      React.createElement(StreamingResponse, {
        handle,
        onComplete: vi.fn(),
        onError: vi.fn(),
        onAborted: vi.fn(),
      }),
    );

    const frame = instance.lastFrame()!;
    expect(frame).toContain('Thinking...');
    expect(frame).toContain('0s');
  });

  it('replaces thinking indicator with streamed text on first chunk', async () => {
    let resolveChunk!: (
      value: IteratorResult<StreamChunk>,
    ) => void;

    async function* controlledGenerator(): AsyncGenerator<StreamChunk> {
      const chunk = await new Promise<IteratorResult<StreamChunk>>(
        (resolve) => {
          resolveChunk = resolve;
        },
      );
      if (!chunk.done) {
        yield chunk.value;
      }
      yield { type: 'done', text: '' };
    }

    const onComplete = vi.fn();
    const handle: StreamHandle = { chunks: controlledGenerator(), abort: vi.fn() };

    const instance = render(
      React.createElement(StreamingResponse, {
        handle,
        onComplete,
        onError: vi.fn(),
        onAborted: vi.fn(),
      }),
    );

    // Initially should show thinking
    expect(instance.lastFrame()!).toContain('Thinking...');

    // Send a text chunk
    resolveChunk({ value: { type: 'text', text: 'Hello' }, done: false });
    await tick();
    await tick();

    const frame = instance.lastFrame()!;
    expect(frame).not.toContain('Thinking...');
    expect(frame).toContain('Titus:');
    expect(frame).toContain('Hello');
  });

  it('accumulates text chunks incrementally', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      { type: 'done', text: '' },
    ];

    let chunkIndex = 0;
    let resolveNext!: () => void;

    async function* generator(): AsyncGenerator<StreamChunk> {
      while (chunkIndex < chunks.length) {
        await new Promise<void>((r) => {
          resolveNext = r;
        });
        yield chunks[chunkIndex++]!;
      }
    }

    const onComplete = vi.fn();
    const handle: StreamHandle = { chunks: generator(), abort: vi.fn() };

    const instance = render(
      React.createElement(StreamingResponse, {
        handle,
        onComplete,
        onError: vi.fn(),
        onAborted: vi.fn(),
      }),
    );

    // Send first chunk
    resolveNext();
    await tick();
    await tick();
    expect(instance.lastFrame()!).toContain('Hello');

    // Send second chunk
    resolveNext();
    await tick();
    await tick();
    expect(instance.lastFrame()!).toContain('Hello world');

    // Send done
    resolveNext();
    await tick();
    await tick();
    expect(onComplete).toHaveBeenCalledWith('Hello world');
  });

  it('calls onError when error chunk arrives', async () => {
    async function* generator(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial' };
      yield { type: 'error', text: 'Something went wrong' };
    }

    const onError = vi.fn();
    const handle: StreamHandle = { chunks: generator(), abort: vi.fn() };

    render(
      React.createElement(StreamingResponse, {
        handle,
        onComplete: vi.fn(),
        onError,
        onAborted: vi.fn(),
      }),
    );

    // Wait for the generator to run through
    await tick();
    await tick();
    await tick();

    expect(onError).toHaveBeenCalledWith('Something went wrong', 'partial');
  });
});

// ── App integration with streaming ─────────────────────────────────────

describe('App with streaming integration', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows streaming response and completes to static message', async () => {
    async function* generator(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'Streamed response' };
      yield { type: 'done', text: '' };
    }

    mockedStreaming.mockResolvedValue({
      chunks: generator(),
      abort: vi.fn(),
    });

    const instance = render(React.createElement(App));
    await tick();

    // Type and submit
    for (const ch of 'Hi') {
      instance.stdin.write(ch);
    }
    await tick();
    instance.stdin.write('\r');

    // Wait for streaming to complete
    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('Titus:');
      expect(frame).toContain('Streamed response');
    });

    // Session history should have the response added
    expect(mockedAddMessage).toHaveBeenCalledWith('cli-local', {
      role: 'assistant',
      content: 'Streamed response',
    });
  });

  it('shows error from streaming and returns to input state', async () => {
    async function* generator(): AsyncGenerator<StreamChunk> {
      yield { type: 'error', text: 'Claude failed badly' };
    }

    mockedStreaming.mockResolvedValue({
      chunks: generator(),
      abort: vi.fn(),
    });

    const instance = render(React.createElement(App));
    await tick();

    for (const ch of 'test') {
      instance.stdin.write(ch);
    }
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('[error]');
      expect(frame).toContain('Claude failed badly');
    });
  });

  it('Ctrl+C during streaming aborts and does not save to session', async () => {
    let resolveChunk!: () => void;

    async function* generator(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial response' };
      // Wait forever (simulates ongoing stream)
      await new Promise<void>((r) => {
        resolveChunk = r;
      });
      yield { type: 'done', text: '' };
    }

    const abortFn = vi.fn();
    mockedStreaming.mockResolvedValue({
      chunks: generator(),
      abort: abortFn,
    });

    const instance = render(React.createElement(App));
    await tick();

    for (const ch of 'go') {
      instance.stdin.write(ch);
    }
    await tick();
    instance.stdin.write('\r');

    // Wait for streaming to start
    await vi.waitFor(() => {
      expect(mockedStreaming).toHaveBeenCalled();
    });
    await tick();
    await tick();

    // Press Ctrl+C
    instance.stdin.write('\x03');
    await tick();

    expect(abortFn).toHaveBeenCalled();

    // Unblock the generator so it can finish
    resolveChunk();
    await tick();
    await tick();

    // The session should NOT have the assistant message saved
    const assistantCalls = mockedAddMessage.mock.calls.filter(
      (call) => call[1].role === 'assistant',
    );
    expect(assistantCalls).toHaveLength(0);
  });
});
