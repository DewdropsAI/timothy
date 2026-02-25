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
import { WritebackStreamParser } from '../writeback-parser.js';
import WritebackNotification from '../tui/WritebackNotification.js';
import StreamingResponse from '../tui/StreamingResponse.js';
import type { WritebackEvent } from '../writeback-parser.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// ── WritebackStreamParser unit tests ──────────────────────────────────

describe('WritebackStreamParser', () => {
  it('parses a single directive in one chunk', () => {
    const parser = new WritebackStreamParser();
    const input = '<!--timothy-write\nfile: memory/facts/foo.md\naction: create\nSome content.\n-->';
    const result = parser.push(input);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].directive.file).toBe('memory/facts/foo.md');
    expect(result.events[0].directive.action).toBe('create');
    expect(result.events[0].directive.content).toBe('Some content.');
    expect(result.text).toBe('');
  });

  it('suppresses directive text from returned text', () => {
    const parser = new WritebackStreamParser();
    const input = 'Hello <!--timothy-write\nfile: a.md\naction: create\ncontent\n--> world';
    const result = parser.push(input);

    expect(result.text).toBe('Hello  world');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].directive.file).toBe('a.md');
  });

  it('handles opening tag split across two chunks', () => {
    const parser = new WritebackStreamParser();

    const r1 = parser.push('text <!--tim');
    const r2 = parser.push('othy-write\nfile: a.md\naction: create\ncontent\n-->');

    const combinedText = r1.text + r2.text;
    const allEvents = [...r1.events, ...r2.events];

    expect(combinedText).toBe('text ');
    expect(allEvents).toHaveLength(1);
    expect(allEvents[0].directive.file).toBe('a.md');
  });

  it('handles closing tag split across chunks', () => {
    const parser = new WritebackStreamParser();

    const r1 = parser.push('<!--timothy-write\nfile: a.md\naction: create\ncontent\n-');
    const r2 = parser.push('->');

    const allEvents = [...r1.events, ...r2.events];

    expect(allEvents).toHaveLength(1);
    expect(allEvents[0].directive.file).toBe('a.md');
    expect(allEvents[0].directive.action).toBe('create');
  });

  it('parses multiple directives in one response', () => {
    const parser = new WritebackStreamParser();
    const input = [
      'Before ',
      '<!--timothy-write\nfile: a.md\naction: create\nContent A.\n-->',
      ' middle ',
      '<!--timothy-write\nfile: b.md\naction: append\nContent B.\n-->',
      ' after',
    ].join('');

    const result = parser.push(input);

    expect(result.events).toHaveLength(2);
    expect(result.events[0].directive.file).toBe('a.md');
    expect(result.events[1].directive.file).toBe('b.md');
    expect(result.text).toBe('Before  middle  after');
  });

  it('discards malformed directive (no closing tag) via flush()', () => {
    const parser = new WritebackStreamParser();

    const r1 = parser.push('text <!--timothy-write\nfile: a.md\naction: create\ncontent');
    const r2 = parser.flush();

    // The incomplete directive is discarded, no events
    const allEvents = [...r1.events, ...r2.events];
    expect(allEvents).toHaveLength(0);
    // flush returns empty text when in directive state (incomplete directive discarded)
    expect(r2.text).toBe('');
  });

  it('preserves normal text between directives', () => {
    const parser = new WritebackStreamParser();
    const input = [
      'Before ',
      '<!--timothy-write\nfile: x.md\naction: create\nX\n-->',
      ' middle ',
      '<!--timothy-write\nfile: y.md\naction: update\nY\n-->',
      ' after',
    ].join('');

    const result = parser.push(input);

    expect(result.text).toBe('Before  middle  after');
  });

  it('parses directive with frontmatter correctly', () => {
    const parser = new WritebackStreamParser();
    const input = [
      '<!--timothy-write',
      'file: memory/facts/chris.md',
      'action: create',
      '---',
      'topic: preferences',
      'confidence: 0.9',
      '---',
      'Chris prefers blunt communication.',
      '-->',
    ].join('\n');

    const result = parser.push(input);

    expect(result.events).toHaveLength(1);
    const d = result.events[0].directive;
    expect(d.file).toBe('memory/facts/chris.md');
    expect(d.action).toBe('create');
    expect(d.frontmatter).toBeDefined();
    expect(d.frontmatter!.topic).toBe('preferences');
    expect(d.frontmatter!.confidence).toBe('0.9');
    expect(d.content).toBe('Chris prefers blunt communication.');
  });
});

// ── WritebackNotification component tests ─────────────────────────────

describe('WritebackNotification', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders success notification with file path', () => {
    const instance = render(
      React.createElement(WritebackNotification, {
        file: 'memory/facts/foo.md',
        status: 'success',
      }),
    );

    const frame = instance.lastFrame()!;
    expect(frame).toContain('[memory]');
    expect(frame).toContain('wrote');
    expect(frame).toContain('memory/facts/foo.md');
  });

  it('renders error notification with error message', () => {
    const instance = render(
      React.createElement(WritebackNotification, {
        file: 'memory/facts/foo.md',
        status: 'error',
        error: 'Permission denied',
      }),
    );

    const frame = instance.lastFrame()!;
    expect(frame).toContain('[memory]');
    expect(frame).toContain('failed to write');
    expect(frame).toContain('memory/facts/foo.md');
    expect(frame).toContain('Permission denied');
  });

  it('renders writing notification', () => {
    const instance = render(
      React.createElement(WritebackNotification, {
        file: 'memory/facts/foo.md',
        status: 'writing',
      }),
    );

    const frame = instance.lastFrame()!;
    expect(frame).toContain('[memory]');
    expect(frame).toContain('writing');
    expect(frame).toContain('memory/facts/foo.md');
  });
});

// ── StreamingResponse with writeback integration ──────────────────────

describe('StreamingResponse with writeback integration', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('strips directive text from display and calls onWriteback', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: '<!--timothy-write\nfile: memory/facts/foo.md\naction: create\nSome fact.\n-->' },
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
    const onWriteback = vi.fn();
    const handle: StreamHandle = { chunks: generator(), abort: vi.fn() };

    const instance = render(
      React.createElement(StreamingResponse, {
        handle,
        onComplete,
        onError: vi.fn(),
        onAborted: vi.fn(),
        onWriteback,
      }),
    );

    // Send first text chunk
    resolveNext();
    await tick();
    await tick();

    // Send directive chunk
    resolveNext();
    await tick();
    await tick();

    // Verify directive text is not visible
    let frame = instance.lastFrame()!;
    expect(frame).not.toContain('<!--timothy-write');
    expect(frame).not.toContain('timothy-write');

    // Verify onWriteback was called
    expect(onWriteback).toHaveBeenCalledTimes(1);
    expect(onWriteback.mock.calls[0][0].directive.file).toBe('memory/facts/foo.md');

    // Send trailing text
    resolveNext();
    await tick();
    await tick();

    // Send done
    resolveNext();
    await tick();
    await tick();

    frame = instance.lastFrame()!;
    expect(frame).toContain('Hello');
    expect(frame).toContain('world');
    expect(frame).not.toContain('<!--timothy-write');

    expect(onComplete).toHaveBeenCalledWith('Hello  world');
  });

  it('triggers separate callbacks for multiple writebacks', async () => {
    const input = [
      'Before ',
      '<!--timothy-write\nfile: a.md\naction: create\nA\n-->',
      ' middle ',
      '<!--timothy-write\nfile: b.md\naction: append\nB\n-->',
      ' after',
    ].join('');

    async function* generator(): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: input };
      yield { type: 'done', text: '' };
    }

    const onWriteback = vi.fn();
    const onComplete = vi.fn();
    const handle: StreamHandle = { chunks: generator(), abort: vi.fn() };

    render(
      React.createElement(StreamingResponse, {
        handle,
        onComplete,
        onError: vi.fn(),
        onAborted: vi.fn(),
        onWriteback,
      }),
    );

    await tick();
    await tick();
    await tick();

    expect(onWriteback).toHaveBeenCalledTimes(2);
    expect(onWriteback.mock.calls[0][0].directive.file).toBe('a.md');
    expect(onWriteback.mock.calls[1][0].directive.file).toBe('b.md');
    expect(onComplete).toHaveBeenCalledWith('Before  middle  after');
  });

  it('handles directive split across chunks correctly', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text', text: 'Hello <!--tim' },
      { type: 'text', text: 'othy-write\nfile: split.md\naction: create\nSplit content.\n-' },
      { type: 'text', text: '->' },
      { type: 'text', text: ' done' },
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

    const onWriteback = vi.fn();
    const onComplete = vi.fn();
    const handle: StreamHandle = { chunks: generator(), abort: vi.fn() };

    const instance = render(
      React.createElement(StreamingResponse, {
        handle,
        onComplete,
        onError: vi.fn(),
        onAborted: vi.fn(),
        onWriteback,
      }),
    );

    // Feed all chunks
    for (let i = 0; i < chunks.length; i++) {
      resolveNext();
      await tick();
      await tick();
    }

    expect(onWriteback).toHaveBeenCalledTimes(1);
    expect(onWriteback.mock.calls[0][0].directive.file).toBe('split.md');

    const frame = instance.lastFrame()!;
    expect(frame).not.toContain('<!--timothy-write');
    expect(frame).toContain('Hello');
    expect(frame).toContain('done');

    expect(onComplete).toHaveBeenCalledWith('Hello  done');
  });
});
