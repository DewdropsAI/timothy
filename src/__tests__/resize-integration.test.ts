import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import type { StreamChunk, StreamHandle } from '../claude.js';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('../claude.js', () => ({
  invokeClaude: vi.fn(),
  invokeClaudeStreaming: vi.fn(),
  applyWritebacks: vi.fn().mockResolvedValue({ succeeded: [], failed: [] }),
  getWorkspacePath: vi.fn().mockReturnValue('/tmp/test-workspace'),
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
import App from '../tui/App.js';
import StreamingResponse from '../tui/StreamingResponse.js';
import InputEditor from '../tui/InputEditor.js';
import { invokeClaudeStreaming, applyWritebacks } from '../claude.js';
import { addMessage } from '../session.js';
import { runExtractionPipeline } from '../memory.js';

const mockedStreaming = vi.mocked(invokeClaudeStreaming);
const mockedAddMessage = vi.mocked(addMessage);
const mockedApplyWritebacks = vi.mocked(applyWritebacks);
const mockedExtraction = vi.mocked(runExtractionPipeline);

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** Helper: type a string character-by-character */
function typeChars(stdin: { write: (s: string) => void }, text: string) {
  for (const ch of text) {
    stdin.write(ch);
  }
}

/** Helper: create a StreamHandle that yields given chunks then completes */
function makeStreamHandle(text: string): StreamHandle {
  async function* gen(): AsyncGenerator<StreamChunk> {
    yield { type: 'text', text };
    yield { type: 'done', text: '' };
  }
  return { chunks: gen(), abort: vi.fn() };
}

/** Helper: create a StreamHandle with writeback directives */
function makeWritebackStreamHandle(
  text: string,
  writebackFile: string,
): StreamHandle {
  const withDirective = `${text}<!--titus-write\nfile: ${writebackFile}\naction: create\nTest content.\n-->`;
  async function* gen(): AsyncGenerator<StreamChunk> {
    yield { type: 'text', text: withDirective };
    yield { type: 'done', text: '' };
  }
  return { chunks: gen(), abort: vi.fn() };
}

/** Helper: controllable stream for multi-step tests */
function makeControllableStreamHandle(): {
  handle: StreamHandle;
  sendChunk: (text: string) => void;
  finish: () => void;
} {
  let resolveNext!: (chunk: StreamChunk) => void;
  let done = false;

  async function* gen(): AsyncGenerator<StreamChunk> {
    while (!done) {
      const chunk = await new Promise<StreamChunk>((r) => {
        resolveNext = r;
      });
      yield chunk;
      if (chunk.type === 'done') return;
    }
  }

  return {
    handle: { chunks: gen(), abort: vi.fn() },
    sendChunk: (text: string) => resolveNext({ type: 'text', text }),
    finish: () => {
      done = true;
      resolveNext({ type: 'done', text: '' });
    },
  };
}

// ── Resize handling tests ─────────────────────────────────────────────

describe('Terminal resize handling', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('App renders at default width without errors', () => {
    const instance = render(React.createElement(App));
    const frame = instance.lastFrame()!;
    expect(frame).toContain('Titus CLI');
    expect(frame).toContain('You:');
  });

  it('InputEditor renders without clipping at default width', () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    const frame = instance.lastFrame()!;
    expect(frame).toContain('You:');
    // No line should be unreasonably long (no fixed-width overflow)
    const lines = frame.split('\n');
    for (const line of lines) {
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
      expect(clean.length).toBeLessThan(200);
    }
  });

  it('InputEditor disabled state renders full-width thinking indicator', () => {
    const onSubmit = vi.fn();
    const instance = render(
      React.createElement(InputEditor, { onSubmit, disabled: true }),
    );
    const frame = instance.lastFrame()!;
    expect(frame).toContain('thinking...');
  });

  it('StreamingResponse renders with width prop', async () => {
    async function* gen(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'Hello from streaming' };
      yield { type: 'done', text: '' };
    }

    const handle: StreamHandle = { chunks: gen(), abort: vi.fn() };
    const onComplete = vi.fn();

    const instance = render(
      React.createElement(StreamingResponse, {
        handle,
        onComplete,
        onError: vi.fn(),
        onAborted: vi.fn(),
        width: 40,
      }),
    );

    await tick();
    await tick();

    const frame = instance.lastFrame()!;
    expect(frame).toContain('Titus:');
    expect(frame).toContain('Hello from streaming');
  });

  it('StreamingResponse renders at narrow width without errors', async () => {
    async function* gen(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'A response that might need wrapping at narrow width' };
      yield { type: 'done', text: '' };
    }

    const handle: StreamHandle = { chunks: gen(), abort: vi.fn() };
    const onComplete = vi.fn();

    const instance = render(
      React.createElement(StreamingResponse, {
        handle,
        onComplete,
        onError: vi.fn(),
        onAborted: vi.fn(),
        width: 30,
      }),
    );

    await tick();
    await tick();

    const frame = instance.lastFrame()!;
    expect(frame).toContain('Titus:');
    expect(frame).toContain('response');
  });

  it('streaming continues without interruption across chunks', async () => {
    const { handle, sendChunk, finish } = makeControllableStreamHandle();
    const onComplete = vi.fn();

    const instance = render(
      React.createElement(StreamingResponse, {
        handle,
        onComplete,
        onError: vi.fn(),
        onAborted: vi.fn(),
        width: 120,
      }),
    );

    sendChunk('First part ');
    await tick();
    await tick();

    let frame = instance.lastFrame()!;
    expect(frame).toContain('First part');

    sendChunk('second part.');
    await tick();
    await tick();

    frame = instance.lastFrame()!;
    expect(frame).toContain('First part');
    expect(frame).toContain('second part');

    finish();
    await tick();
    await tick();

    expect(onComplete).toHaveBeenCalledWith('First part second part.');
  });

  it('InputEditor remains functional for typing and submission', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();

    typeChars(instance.stdin, 'before resize');
    await tick();

    let frame = instance.lastFrame()!;
    expect(frame).toContain('before resize');

    typeChars(instance.stdin, ' after resize');
    await tick();

    frame = instance.lastFrame()!;
    expect(frame).toContain('before resize after resize');

    instance.stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('before resize after resize');
  });
});

// ── Integration tests ─────────────────────────────────────────────────

describe('End-to-end integration', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('memory extraction pipeline fires after response completes', async () => {
    mockedStreaming.mockResolvedValue(makeStreamHandle('A thoughtful response'));

    const instance = render(React.createElement(App));
    await tick();

    typeChars(instance.stdin, 'tell me something');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('Titus:');
      expect(frame).toContain('A thoughtful response');
    });

    await vi.waitFor(() => {
      expect(mockedExtraction).toHaveBeenCalledWith(
        'cli-local',
        'tell me something',
        expect.any(String),
      );
    });
  });

  it('memory extraction does NOT fire on stream error', async () => {
    async function* gen(): AsyncGenerator<StreamChunk> {
      yield { type: 'error', text: 'Connection lost' };
    }
    mockedStreaming.mockResolvedValue({ chunks: gen(), abort: vi.fn() });

    const instance = render(React.createElement(App));
    await tick();

    typeChars(instance.stdin, 'trigger error');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('[error]');
    });

    await tick();
    await tick();

    expect(mockedExtraction).not.toHaveBeenCalled();
  });

  it('writeback directives are parsed and applyWritebacks is called', async () => {
    mockedApplyWritebacks.mockResolvedValue({ succeeded: ['memory/facts/test.md'], failed: [] });
    mockedStreaming.mockResolvedValue(
      makeWritebackStreamHandle('Here is my response', 'memory/facts/test.md'),
    );

    const instance = render(React.createElement(App));
    await tick();

    typeChars(instance.stdin, 'remember this');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      expect(mockedApplyWritebacks).toHaveBeenCalled();
    });

    const call = mockedApplyWritebacks.mock.calls[0];
    expect(call[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'memory/facts/test.md',
          action: 'create',
        }),
      ]),
    );
    expect(call[1]).toBe('/tmp/test-workspace');
  });

  it('writeback success shows [memory] wrote system message', async () => {
    mockedApplyWritebacks.mockResolvedValue({ succeeded: ['memory/facts/pref.md'], failed: [] });
    mockedStreaming.mockResolvedValue(
      makeWritebackStreamHandle('Noted. ', 'memory/facts/pref.md'),
    );

    const instance = render(React.createElement(App));
    await tick();

    typeChars(instance.stdin, 'save pref');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('[memory]');
      expect(frame).toContain('wrote');
      expect(frame).toContain('memory/facts/pref.md');
    });
  });

  it('writeback failure shows [memory] failed system message', async () => {
    mockedApplyWritebacks.mockResolvedValue({
      succeeded: [],
      failed: [{ file: 'memory/bad.md', error: 'EACCES: permission denied' }],
    });
    mockedStreaming.mockResolvedValue(
      makeWritebackStreamHandle('Trying. ', 'memory/bad.md'),
    );

    const instance = render(React.createElement(App));
    await tick();

    typeChars(instance.stdin, 'save bad');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('[memory]');
      expect(frame).toContain('failed to write');
      expect(frame).toContain('memory/bad.md');
    });
  });

  it('full conversation flow: send -> stream -> complete -> send follow-up', async () => {
    mockedStreaming.mockResolvedValueOnce(makeStreamHandle('First response'));

    const instance = render(React.createElement(App));
    await tick();

    typeChars(instance.stdin, 'hello');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('First response');
    });

    expect(mockedAddMessage).toHaveBeenCalledWith('cli-local', {
      role: 'user',
      content: 'hello',
    });
    expect(mockedAddMessage).toHaveBeenCalledWith('cli-local', {
      role: 'assistant',
      content: 'First response',
    });

    // Second message (follow-up)
    mockedStreaming.mockResolvedValueOnce(makeStreamHandle('Second response'));

    typeChars(instance.stdin, 'follow up');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('Second response');
    });

    expect(mockedAddMessage).toHaveBeenCalledWith('cli-local', {
      role: 'user',
      content: 'follow up',
    });
    expect(mockedAddMessage).toHaveBeenCalledWith('cli-local', {
      role: 'assistant',
      content: 'Second response',
    });

    // Total: 2 user + 2 assistant = 4 addMessage calls
    expect(mockedAddMessage).toHaveBeenCalledTimes(4);
  });

  it('session persistence: addMessage called for user on submit', async () => {
    mockedStreaming.mockResolvedValue(makeStreamHandle('ack'));

    const instance = render(React.createElement(App));
    await tick();

    typeChars(instance.stdin, 'persist me');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      expect(mockedAddMessage).toHaveBeenCalledWith('cli-local', {
        role: 'user',
        content: 'persist me',
      });
    });
  });

  it('session persistence: addMessage called for assistant on stream complete', async () => {
    mockedStreaming.mockResolvedValue(makeStreamHandle('persisted response'));

    const instance = render(React.createElement(App));
    await tick();

    typeChars(instance.stdin, 'go');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      expect(mockedAddMessage).toHaveBeenCalledWith('cli-local', {
        role: 'assistant',
        content: 'persisted response',
      });
    });
  });

  it('session persistence: addMessage NOT called for assistant on error', async () => {
    async function* gen(): AsyncGenerator<StreamChunk> {
      yield { type: 'error', text: 'boom' };
    }
    mockedStreaming.mockResolvedValue({ chunks: gen(), abort: vi.fn() });

    const instance = render(React.createElement(App));
    await tick();

    typeChars(instance.stdin, 'fail');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('[error]');
    });
    await tick();

    const assistantCalls = mockedAddMessage.mock.calls.filter(
      (call) => call[1].role === 'assistant',
    );
    expect(assistantCalls).toHaveLength(0);
  });

  it('session persistence: addMessage NOT called for assistant on abort', async () => {
    let resolveChunk!: () => void;

    async function* generator(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial' };
      await new Promise<void>((r) => {
        resolveChunk = r;
      });
      yield { type: 'done', text: '' };
    }

    const abortFn = vi.fn();
    mockedStreaming.mockResolvedValue({ chunks: generator(), abort: abortFn });

    const instance = render(React.createElement(App));
    await tick();

    typeChars(instance.stdin, 'abort me');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      expect(mockedStreaming).toHaveBeenCalled();
    });
    await tick();
    await tick();

    // Press Ctrl+C to abort
    instance.stdin.write('\x03');
    await tick();

    expect(abortFn).toHaveBeenCalled();

    // Unblock the generator
    resolveChunk();
    await tick();
    await tick();

    const assistantCalls = mockedAddMessage.mock.calls.filter(
      (call) => call[1].role === 'assistant',
    );
    expect(assistantCalls).toHaveLength(0);
  });

  it('error during streaming shows error and returns to input state', async () => {
    async function* gen(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial' };
      yield { type: 'error', text: 'Connection lost' };
    }
    mockedStreaming.mockResolvedValue({ chunks: gen(), abort: vi.fn() });

    const instance = render(React.createElement(App));
    await tick();

    typeChars(instance.stdin, 'test error');
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('[error]');
      expect(frame).toContain('Connection lost');
    });

    // Should return to input state
    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('You:');
    });
  });
});
