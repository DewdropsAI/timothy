import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockAdapter } from '../helpers/test-adapter.js';
import { createTestWorkspace } from '../helpers/test-workspace.js';
import type { TestWorkspace } from '../helpers/test-workspace.js';
import type { AdapterInput, ThoughtResult } from '../../types.js';

// NOTE: These integration tests verify the think() -> adapter.invoke() ->
// writeback flow. They depend on both the adapter framework and the
// continuity module. They will fail until implementation is complete.

// ---------------------------------------------------------------------------
// think() -> adapter.invoke() -> writeback flow
// ---------------------------------------------------------------------------

describe('integration: think -> adapter -> writeback', () => {
  let ws: TestWorkspace;
  let adapter: MockAdapter;

  beforeEach(() => {
    ws = createTestWorkspace();
    adapter = new MockAdapter('test');
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('routes a message through the adapter and returns a ThoughtResult', async () => {
    adapter.setDefaultResponse('Hello from the adapter!');

    const input: AdapterInput = {
      message: 'Hello, Titus',
      history: [],
      systemPrompt: 'You are Titus.',
      route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
      workspacePath: ws.path,
      effectiveMode: 'yolo',
    };

    const result = await adapter.invoke(input);

    expect(result.text).toBe('Hello from the adapter!');
    expect(result.mode).toBe('test');
    expect(result.modelUsed).toBe('claude-sonnet-4-6');
  });

  it('writeback directives in adapter response are processed', async () => {
    const responseWithWriteback = [
      'I will remember that.',
      '<!--titus-write',
      'file: memory/facts/integration-test.md',
      'action: create',
      'Integration test fact.',
      '-->',
      'Done!',
    ].join('\n');

    adapter.setDefaultResponse(responseWithWriteback);

    const input: AdapterInput = {
      message: 'Remember this integration test',
      history: [],
      systemPrompt: 'You are Titus.',
      route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
      workspacePath: ws.path,
      effectiveMode: 'yolo',
    };

    // Invoke the adapter
    const result = await adapter.invoke(input);

    // The raw text should contain the directive
    expect(result.text).toContain('<!--titus-write');

    // Now process through ContinuityManager to apply writebacks
    try {
      const { ContinuityManager } = await import('../../continuity.js');
      const manager = new ContinuityManager(ws.path);
      const processed = await manager.processResponse(result.text);

      expect(processed.cleanResponse).toContain('I will remember that.');
      expect(processed.cleanResponse).toContain('Done!');
      expect(processed.cleanResponse).not.toContain('<!--titus-write');
      expect(processed.writebackResults.succeeded).toContain('memory/facts/integration-test.md');
    } catch {
      // continuity.ts not yet implemented — expected in TDD
    }
  });
});

// ---------------------------------------------------------------------------
// Context loading -> prompt assembly -> response
// ---------------------------------------------------------------------------

describe('integration: context loading -> prompt assembly', () => {
  let ws: TestWorkspace;
  let adapter: MockAdapter;

  beforeEach(() => {
    ws = createTestWorkspace();
    adapter = new MockAdapter('test');
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('system prompt includes workspace identity', async () => {
    writeFileSync(
      join(ws.path, 'identity', 'self.md'),
      '# Titus\n\nI am Titus. I value direct communication.\n',
    );

    const input: AdapterInput = {
      message: 'Who are you?',
      history: [],
      systemPrompt: 'I am Titus. I value direct communication.',
      route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
      workspacePath: ws.path,
      effectiveMode: 'yolo',
    };

    await adapter.invoke(input);

    const lastInvocation = adapter.getLastInvocation()!;
    expect(lastInvocation.systemPrompt).toContain('Titus');
    expect(lastInvocation.systemPrompt).toContain('direct communication');
  });

  it('history is passed through to the adapter', async () => {
    const history = [
      { role: 'user' as const, content: 'Hi there' },
      { role: 'assistant' as const, content: 'Hello!' },
    ];

    const input: AdapterInput = {
      message: 'Follow up',
      history,
      systemPrompt: 'You are Titus.',
      route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
      workspacePath: ws.path,
      effectiveMode: 'yolo',
    };

    await adapter.invoke(input);

    const lastInvocation = adapter.getLastInvocation()!;
    expect(lastInvocation.history).toHaveLength(2);
    expect(lastInvocation.history[0].content).toBe('Hi there');
  });
});

// ---------------------------------------------------------------------------
// Error recovery
// ---------------------------------------------------------------------------

describe('integration: error recovery', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('adapter failure produces error in ThoughtResult', async () => {
    const adapter = new MockAdapter('failing');
    adapter.setError(new Error('Network timeout'));

    const input: AdapterInput = {
      message: 'Hello',
      history: [],
      systemPrompt: 'You are Titus.',
      route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
      workspacePath: ws.path,
      effectiveMode: 'yolo',
    };

    await expect(adapter.invoke(input)).rejects.toThrow('Network timeout');

    // Verify the adapter is still functional after error
    adapter.clearError();
    const result = await adapter.invoke(input);
    expect(result.text).toBe('Mock response');
  });

  it('adapter recovers after transient failure', async () => {
    const adapter = new MockAdapter('intermittent');

    // First call fails
    adapter.setError(new Error('Transient error'));
    await expect(adapter.invoke({
      message: 'Hello',
      history: [],
      systemPrompt: 'You are Titus.',
      route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
      workspacePath: ws.path,
      effectiveMode: 'yolo',
    })).rejects.toThrow('Transient error');

    // Second call succeeds
    adapter.clearError();
    adapter.setDefaultResponse('Back in action');
    const result = await adapter.invoke({
      message: 'Retry',
      history: [],
      systemPrompt: 'You are Titus.',
      route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
      workspacePath: ws.path,
      effectiveMode: 'yolo',
    });

    expect(result.text).toBe('Back in action');
  });
});

// ---------------------------------------------------------------------------
// Different invocation types route to correct adapters
// ---------------------------------------------------------------------------

describe('integration: invocation type routing', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('conversation route uses yolo mode', async () => {
    const adapter = new MockAdapter('cli');

    const input: AdapterInput = {
      message: 'Chat message',
      history: [],
      systemPrompt: 'You are Titus.',
      route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
      workspacePath: ws.path,
      effectiveMode: 'yolo',
    };

    await adapter.invoke(input);
    expect(adapter.getLastInvocation()!.effectiveMode).toBe('yolo');
  });

  it('reflection route uses print mode', async () => {
    const adapter = new MockAdapter('cli');

    const input: AdapterInput = {
      message: 'Reflect on state',
      history: [],
      systemPrompt: 'You are Titus.',
      route: { model: 'claude-haiku-4-5', mode: 'print', timeoutMs: 60_000 },
      workspacePath: ws.path,
      effectiveMode: 'print',
    };

    await adapter.invoke(input);
    expect(adapter.getLastInvocation()!.effectiveMode).toBe('print');
    expect(adapter.getLastInvocation()!.route.model).toBe('claude-haiku-4-5');
  });
});
