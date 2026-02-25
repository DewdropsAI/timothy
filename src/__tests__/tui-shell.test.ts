import { describe, it, test, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

// --- Detection tests (pure unit, no mocking of external modules) ---

describe('shouldUseTUI detection', () => {
  let originalIsTTY: boolean | undefined;
  let originalTERM: string | undefined;
  let originalNO_COLOR: string | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    originalTERM = process.env.TERM;
    originalNO_COLOR = process.env.NO_COLOR;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    if (originalTERM === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTERM;
    }
    if (originalNO_COLOR === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNO_COLOR;
    }
    vi.resetModules();
  });

  it('returns true when stdout.isTTY is true and TERM is not dumb', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    process.env.TERM = 'xterm-256color';
    const { shouldUseTUI } = await import('../tui/detection.js');
    expect(shouldUseTUI()).toBe(true);
  });

  it('returns false when stdout.isTTY is false (piped)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true, configurable: true });
    process.env.TERM = 'xterm-256color';
    const { shouldUseTUI } = await import('../tui/detection.js');
    expect(shouldUseTUI()).toBe(false);
  });

  it('returns false when stdout.isTTY is undefined (piped)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, writable: true, configurable: true });
    process.env.TERM = 'xterm-256color';
    const { shouldUseTUI } = await import('../tui/detection.js');
    expect(shouldUseTUI()).toBe(false);
  });

  it('returns false when TERM is dumb', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    process.env.TERM = 'dumb';
    const { shouldUseTUI } = await import('../tui/detection.js');
    expect(shouldUseTUI()).toBe(false);
  });

  it('returns true when TERM is unset (defaults to TUI mode)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    delete process.env.TERM;
    const { shouldUseTUI } = await import('../tui/detection.js');
    expect(shouldUseTUI()).toBe(true);
  });

  it('returns true when NO_COLOR=1 is set (TUI still runs, just without colors)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    process.env.TERM = 'xterm-256color';
    process.env.NO_COLOR = '1';
    const { shouldUseTUI } = await import('../tui/detection.js');
    expect(shouldUseTUI()).toBe(true);
  });
});

// --- Ink App component tests ---

vi.mock('../claude.js', () => ({
  invokeClaude: vi.fn(),
  invokeClaudeStreaming: vi.fn(),
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

import { render, cleanup } from 'ink-testing-library';
import App from '../tui/App.js';
import { invokeClaude, invokeClaudeStreaming, type StreamChunk, type StreamHandle } from '../claude.js';
import { addMessage, getHistory } from '../session.js';

const mockedInvokeClaude = vi.mocked(invokeClaude);
const mockedStreaming = vi.mocked(invokeClaudeStreaming);
const mockedGetHistory = vi.mocked(getHistory);
const mockedAddMessage = vi.mocked(addMessage);

/** Helper: create a StreamHandle that yields given chunks then completes */
function makeStreamHandle(text: string): StreamHandle {
  async function* gen(): AsyncGenerator<StreamChunk> {
    yield { type: 'text', text };
    yield { type: 'done', text: '' };
  }
  return { chunks: gen(), abort: vi.fn() };
}

/** Helper: create a StreamHandle from a controllable promise */
function makePendingStreamHandle(): {
  handle: StreamHandle;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
} {
  let resolveOuter!: (text: string) => void;
  let rejectOuter!: (err: Error) => void;
  const pending = new Promise<string>((res, rej) => {
    resolveOuter = res;
    rejectOuter = rej;
  });

  async function* gen(): AsyncGenerator<StreamChunk> {
    const text = await pending;
    yield { type: 'text', text };
    yield { type: 'done', text: '' };
  }
  return {
    handle: { chunks: gen(), abort: vi.fn() },
    resolve: resolveOuter,
    reject: rejectOuter,
  };
}

/** Helper: create a StreamHandle that yields an error */
function makeErrorStreamHandle(errorText: string): StreamHandle {
  async function* gen(): AsyncGenerator<StreamChunk> {
    yield { type: 'error', text: errorText };
  }
  return { chunks: gen(), abort: vi.fn() };
}

/** Wait for Ink's useEffect hooks to fire (setRawMode, event listener setup) */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('TUI App component', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the banner on startup', () => {
    const instance = render(React.createElement(App));
    const frame = instance.lastFrame()!;
    expect(frame).toContain('Titus CLI');
    expect(frame).toContain('Type a message to begin');
  });

  it('shows prompt cursor when idle', () => {
    const instance = render(React.createElement(App));
    const frame = instance.lastFrame()!;
    expect(frame).toContain('You:');
  });

  it('accepts text input and displays it', async () => {
    const instance = render(React.createElement(App));
    await tick();
    // Write characters individually as useInput parses keypresses
    for (const ch of 'hello') {
      instance.stdin.write(ch);
    }
    await tick();
    const frame = instance.lastFrame()!;
    expect(frame).toContain('hello');
  });

  it('backspace removes last character', async () => {
    const instance = render(React.createElement(App));
    await tick();
    for (const ch of 'helo') {
      instance.stdin.write(ch);
    }
    instance.stdin.write('\x7F'); // backspace
    for (const ch of 'lo') {
      instance.stdin.write(ch);
    }
    await tick();
    const frame = instance.lastFrame()!;
    expect(frame).toContain('hello');
  });

  it('ignores empty input on Enter', async () => {
    const instance = render(React.createElement(App));
    await tick();
    instance.stdin.write('\r');
    await tick();
    const frame = instance.lastFrame()!;
    expect(frame).toContain('You:');
    expect(mockedAddMessage).not.toHaveBeenCalled();
  });

  it('submits input to invokeClaudeStreaming on Enter and shows response', async () => {
    mockedStreaming.mockResolvedValue(makeStreamHandle('Hello from Titus'));
    mockedGetHistory.mockReturnValue([]);

    const instance = render(React.createElement(App));
    await tick();
    for (const ch of 'Hi there') {
      instance.stdin.write(ch);
    }
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('Titus:');
      expect(frame).toContain('Hello from Titus');
    });

    expect(mockedStreaming).toHaveBeenCalledWith('Hi there', 'cli-local', expect.any(Array));
  });

  it('shows Thinking indicator while processing', async () => {
    const { handle, resolve } = makePendingStreamHandle();
    mockedStreaming.mockResolvedValue(handle);

    const instance = render(React.createElement(App));
    await tick();
    for (const ch of 'test') {
      instance.stdin.write(ch);
    }
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('Thinking...');
    });

    resolve('Done');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).not.toContain('Thinking...');
    });
  });

  it('displays user message in chat history after submission', async () => {
    mockedStreaming.mockResolvedValue(makeStreamHandle('response'));

    const instance = render(React.createElement(App));
    await tick();
    for (const ch of 'my message') {
      instance.stdin.write(ch);
    }
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('You:');
      expect(frame).toContain('my message');
    });
  });

  it('displays error message on streaming error', async () => {
    mockedStreaming.mockResolvedValue(makeErrorStreamHandle('Claude failed'));

    const instance = render(React.createElement(App));
    await tick();
    for (const ch of 'fail') {
      instance.stdin.write(ch);
    }
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      expect(frame).toContain('[error]');
      expect(frame).toContain('Claude failed');
    });
  });

  it('exit command triggers app exit', async () => {
    const instance = render(React.createElement(App));
    await tick();
    for (const ch of 'exit') {
      instance.stdin.write(ch);
    }
    await tick();

    // Verify text was captured before submitting
    expect(instance.lastFrame()).toContain('exit');

    instance.stdin.write('\r');

    // exit() unmounts the component before React re-renders, so we wait
    // for the unmount to settle and verify side-effects instead of frame content.
    await vi.waitFor(() => {
      // The exit branch must NOT invoke Claude or record session messages
      expect(mockedStreaming).not.toHaveBeenCalled();
      expect(mockedAddMessage).not.toHaveBeenCalled();
    });

    // Verify the app did not enter the normal submit path (no Thinking indicator)
    expect(instance.lastFrame()).not.toContain('Thinking...');
  });

  it('quit command triggers app exit', async () => {
    const instance = render(React.createElement(App));
    await tick();
    for (const ch of 'quit') {
      instance.stdin.write(ch);
    }
    await tick();

    expect(instance.lastFrame()).toContain('quit');

    instance.stdin.write('\r');

    // exit() unmounts the component before React re-renders, so we wait
    // for the unmount to settle and verify side-effects instead of frame content.
    await vi.waitFor(() => {
      expect(mockedStreaming).not.toHaveBeenCalled();
      expect(mockedAddMessage).not.toHaveBeenCalled();
    });

    expect(instance.lastFrame()).not.toContain('Thinking...');
  });

  it('renders system-role messages in chat (e.g. errors, goodbye)', async () => {
    // System messages use the dimColor text path in App.tsx.
    // Trigger via streaming error to produce a system-role "[error]" message.
    mockedStreaming.mockResolvedValue(makeErrorStreamHandle('system msg test'));

    const instance = render(React.createElement(App));
    await tick();
    for (const ch of 'trigger') {
      instance.stdin.write(ch);
    }
    await tick();
    instance.stdin.write('\r');

    await vi.waitFor(() => {
      const frame = instance.lastFrame()!;
      // Verifies system-role messages render (same path used by goodbye, auth results, etc.)
      expect(frame).toContain('[error] system msg test');
    });
  });
});

// --- Integration test gaps (documented) ---

describe('TUI integration coverage gaps', () => {
  test.todo(
    'TUI initialization failure falls back to plain REPL — ' +
    'cli.ts main() wraps runTUI() in try/catch and calls runPlainREPL() on failure (lines 143-148). ' +
    'Cannot unit test cleanly because: (1) main() auto-executes on import via main().catch() at module scope, ' +
    '(2) runTUI and runPlainREPL are private functions not exported, ' +
    '(3) would require mocking the ink import to throw on render() and verifying runPlainREPL activates, ' +
    'which needs either heavy module-graph mocking or refactoring cli.ts to export a testable entry point. ' +
    'Verified manually: when ink.render() throws, the catch block logs to stderr and starts the readline REPL.'
  );

  test.todo(
    'Console output routes through Ink via patchConsole: true — ' +
    'cli.ts line 130 passes { patchConsole: true } to ink.render(), which intercepts console.log/warn/error ' +
    'so background output (memory extraction, summarization) does not corrupt the Ink render tree. ' +
    'This is an Ink framework feature, not application logic. Testing would require a real Ink render instance ' +
    '(ink-testing-library does not support patchConsole). The App component handles system-role messages in ' +
    'chat history (covered by the error display and system message tests above). ' +
    'Verified manually: console.log during TUI mode appears as patched output without corrupting the display.'
  );
});
