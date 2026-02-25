import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock node:child_process before any imports that use it
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock memory module so buildMemoryContext doesn't interfere with tests
vi.mock('../memory.js', () => ({
  buildMemoryContext: vi.fn().mockResolvedValue({ context: '', tokens: 0 }),
}));

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { buildMemoryContext } from '../memory.js';
import { invokeClaude, getWorkspacePath, getSystemPromptPath, buildModeContext, getCognitiveMode } from '../claude.js';

const mockSpawn = spawn as unknown as Mock;
const mockReadFile = readFile as unknown as Mock;
const mockBuildMemoryContext = buildMemoryContext as unknown as Mock;

function createMockStdin() {
  const stdin = new EventEmitter();
  (stdin as any).write = vi.fn();
  (stdin as any).end = vi.fn();
  return stdin;
}

function createMockChild() {
  const child = new EventEmitter();
  (child as any).stdout = new EventEmitter();
  (child as any).stderr = new EventEmitter();
  (child as any).stdin = createMockStdin();
  (child as any).kill = vi.fn();
  return child;
}

/** Emit a successful response as NDJSON (stream-json format) since invokeClaude delegates to streaming */
function emitSuccess(child: EventEmitter, output: string) {
  process.nextTick(() => {
    const ndjsonLine = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: output },
    });
    (child as any).stdout.emit('data', Buffer.from(ndjsonLine + '\n'));
    child.emit('close', 0);
  });
}

function emitFailure(child: EventEmitter, code: number, stderrOutput?: string) {
  process.nextTick(() => {
    if (stderrOutput) {
      (child as any).stderr.emit('data', Buffer.from(stderrOutput));
    }
    child.emit('close', code);
  });
}

function emitError(child: EventEmitter, error: Error) {
  process.nextTick(() => {
    child.emit('error', error);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('invokeClaude', () => {
  describe('successful invocation', () => {
    it('should return the CLI response on success', async () => {
      mockReadFile.mockResolvedValue('You are Titus.');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Hello', 123);
      emitSuccess(child, 'Hello! How can I help?');

      const result = await promise;
      expect(result).toBe('Hello! How can I help?');
    });

    it('should pass -p --output-format stream-json and --dangerously-skip-permissions in yolo mode (default)', async () => {
      mockReadFile.mockResolvedValue('You are Titus.');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Test', 123);
      emitSuccess(child, 'response');
      await promise;

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('--system-prompt');
      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.anything(),
        expect.objectContaining({
          cwd: expect.stringContaining('workspace'),
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    });

    it('should pass -p --output-format stream-json without --dangerously-skip-permissions in print mode', async () => {
      mockReadFile.mockResolvedValue('You are Titus.');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Test', 123, [], 'print');
      emitSuccess(child, 'response');
      await promise;

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('should pipe the user message via stdin instead of args', async () => {
      mockReadFile.mockResolvedValue('You are Titus.');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('What is 2+2?', 123);
      emitSuccess(child, '4');
      await promise;

      // Input should NOT be in the CLI args
      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain('What is 2+2?');

      // Input should be piped via stdin
      expect((child as any).stdin.end).toHaveBeenCalledWith('What is 2+2?');
    });

    it('should pipe conversation history via stdin', async () => {
      mockReadFile.mockResolvedValue('You are Titus.');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const history = [
        { role: 'user' as const, content: 'Hi' },
        { role: 'assistant' as const, content: 'Hello!' },
      ];

      const promise = invokeClaude('Follow up', 123, history);
      emitSuccess(child, 'response');
      await promise;

      const stdinInput = (child as any).stdin.end.mock.calls[0][0] as string;
      expect(stdinInput).toContain('Human: Hi');
      expect(stdinInput).toContain('Assistant: Hello!');
      expect(stdinInput).toContain('Human: Follow up');
    });

    it('should inject mode context even without system prompt file', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Hello', 123);
      emitSuccess(child, 'response');
      await promise;

      const args = mockSpawn.mock.calls[0][1] as string[];
      // Mode context is always injected, so --system-prompt should be present
      expect(args).toContain('--system-prompt');
      const systemPromptIdx = args.indexOf('--system-prompt');
      const systemPrompt = args[systemPromptIdx + 1];
      expect(systemPrompt).toContain('Cognitive Mode');
    });

    it('should concatenate streaming chunks into full response', async () => {
      mockReadFile.mockResolvedValue('prompt');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Hello', 123);
      // Emit multiple chunks to test concatenation
      process.nextTick(() => {
        const chunk1 = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } });
        const chunk2 = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } });
        (child as any).stdout.emit('data', Buffer.from(chunk1 + '\n' + chunk2 + '\n'));
        child.emit('close', 0);
      });

      const result = await promise;
      expect(result).toBe('Hello world');
    });
  });

  describe('error handling', () => {
    it('should return friendly message on timeout', async () => {
      vi.useFakeTimers();
      mockReadFile.mockResolvedValue('prompt');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Hello', 123);

      // Advance timers past the 120s timeout
      await vi.advanceTimersByTimeAsync(120_000);

      // AbortController fires, which causes an AbortError on the child
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      child.emit('error', abortError);

      const result = await promise;
      expect(result).toContain('Sorry, that took too long. Please try again or simplify your request.');
      expect(result).toMatch(/\(ref: [a-z0-9]+\)$/);

      vi.useRealTimers();
    });

    it('should return friendly message on non-zero exit code', async () => {
      mockReadFile.mockResolvedValue('prompt');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Hello', 123);
      emitFailure(child, 1, 'Some internal error');

      const result = await promise;
      expect(result).toContain('Sorry, something went wrong while processing your message. Please try again.');
      expect(result).toMatch(/\(ref: [a-z0-9]+\)$/);
    });

    it('should return friendly message when CLI not found (ENOENT)', async () => {
      mockReadFile.mockResolvedValue('prompt');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Hello', 123);

      const enoentError: NodeJS.ErrnoException = new Error('spawn claude ENOENT');
      enoentError.code = 'ENOENT';
      emitError(child, enoentError);

      const result = await promise;
      expect(result).toContain('Claude Code CLI is not available right now. Please check the server configuration.');
      expect(result).toMatch(/\(ref: [a-z0-9]+\)$/);
    });

    it('should log errors for debugging', async () => {
      mockReadFile.mockResolvedValue('prompt');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Hello', 123);
      emitFailure(child, 1, 'error details');

      await promise;
      expect(console.error).toHaveBeenCalled();
    });

    it('should never expose raw errors to users', async () => {
      mockReadFile.mockResolvedValue('prompt');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Hello', 123);
      emitFailure(child, 1, 'INTERNAL: secret debug info');

      const result = await promise;
      expect(result).not.toContain('INTERNAL');
      expect(result).not.toContain('secret');
    });

    it('should handle exit with no stderr', async () => {
      mockReadFile.mockResolvedValue('prompt');
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Hello', 123);
      emitFailure(child, 2);

      const result = await promise;
      expect(result).toContain('Sorry, something went wrong while processing your message. Please try again.');
      expect(result).toMatch(/\(ref: [a-z0-9]+\)$/);
    });

    it('should remain operational after error (bot recovery)', async () => {
      mockReadFile.mockResolvedValue('prompt');

      // First call - fails with ENOENT
      const child1 = createMockChild();
      mockSpawn.mockReturnValue(child1);
      const promise1 = invokeClaude('Hello', 123);
      const err1: NodeJS.ErrnoException = new Error('spawn claude ENOENT');
      err1.code = 'ENOENT';
      emitError(child1, err1);
      const result1 = await promise1;
      expect(result1).toContain('not available');

      // Second call - succeeds (bot is still operational)
      const child2 = createMockChild();
      mockSpawn.mockReturnValue(child2);
      const promise2 = invokeClaude('Hello again', 123);
      emitSuccess(child2, 'I am working now');
      const result2 = await promise2;
      expect(result2).toBe('I am working now');
    });
  });

  describe('memory context in system prompt', () => {
    it('should append memory context and mode context to system prompt', async () => {
      mockReadFile.mockResolvedValue('You are Titus.');
      mockBuildMemoryContext.mockResolvedValue({
        context: '### Identity\n\nI am Titus.\n\n### User Profile\n\nName: Chris',
        tokens: 50,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Hello', 123);
      emitSuccess(child, 'response');
      await promise;

      const args = mockSpawn.mock.calls[0][1] as string[];
      const systemPromptIdx = args.indexOf('--system-prompt');
      const systemPrompt = args[systemPromptIdx + 1];
      expect(systemPrompt).toContain('### Identity');
      expect(systemPrompt).toContain('I am Titus.');
      expect(systemPrompt).toContain('### User Profile');
      expect(systemPrompt).toContain('Name: Chris');
      expect(systemPrompt).toContain('Cognitive Mode');
    });

    it('should not append memory separator when memory context is empty', async () => {
      mockReadFile.mockResolvedValue('You are Titus.');
      mockBuildMemoryContext.mockResolvedValue({ context: '', tokens: 0 });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const promise = invokeClaude('Hello', 123);
      emitSuccess(child, 'response');
      await promise;

      const args = mockSpawn.mock.calls[0][1] as string[];
      const systemPromptIdx = args.indexOf('--system-prompt');
      const systemPrompt = args[systemPromptIdx + 1];
      // Base prompt + mode context, but no memory section
      expect(systemPrompt).toContain('You are Titus.');
      expect(systemPrompt).toContain('Cognitive Mode');
      // Should have exactly two separators (base→mode), not three (base→memory→mode)
      const separatorCount = (systemPrompt.match(/\n\n---\n\n/g) || []).length;
      expect(separatorCount).toBe(1);
    });
  });
});

describe('getWorkspacePath', () => {
  it('should return an absolute path containing workspace', () => {
    const p = getWorkspacePath();
    expect(p).toContain('workspace');
    expect(p).toMatch(/^\//);
  });
});

describe('getSystemPromptPath', () => {
  it('should return an absolute path to workspace/identity/self.md', () => {
    const p = getSystemPromptPath();
    expect(p).toContain('workspace/identity/self.md');
    expect(p).toMatch(/^\//);
  });
});

describe('getCognitiveMode', () => {
  it('should return a valid cognitive mode', () => {
    const mode = getCognitiveMode();
    expect(['yolo', 'print']).toContain(mode);
  });
});

describe('buildModeContext', () => {
  it('should return autonomous context for yolo mode', () => {
    const context = buildModeContext('yolo');
    expect(context).toContain('Cognitive Mode: Autonomous');
    expect(context).toContain('full autonomous mode');
    expect(context).toContain('Read and write files');
    expect(context).toContain('Execute shell commands');
    expect(context).toContain('writeback directives');
  });

  it('should return stateless context for print mode', () => {
    const context = buildModeContext('print');
    expect(context).toContain('Cognitive Mode: Stateless');
    expect(context).toContain('stateless print mode');
    expect(context).toContain('cannot use tools');
    expect(context).toContain('writeback directives');
  });

  it('should describe different capabilities per mode', () => {
    const yolo = buildModeContext('yolo');
    const print = buildModeContext('print');
    expect(yolo).not.toEqual(print);
    // Yolo should mention tool access; print should not
    expect(yolo).toContain('Execute shell commands');
    expect(print).not.toContain('Execute shell commands');
  });
});
