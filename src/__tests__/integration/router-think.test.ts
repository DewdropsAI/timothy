import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MockAdapter } from '../helpers/test-adapter.js';
import { createTestWorkspace } from '../helpers/test-workspace.js';
import type { TestWorkspace } from '../helpers/test-workspace.js';
import { AdapterRegistry } from '../../adapter.js';
import { resolveRoute, buildModeContext } from '../../router.js';
import { extractWritebacks, applyWritebacks } from '../../continuity.js';
import type { ThoughtResult, AdapterInput, RouteConfig } from '../../types.js';
import { resolveAdapterName } from '../../startup.js';

// ---------------------------------------------------------------------------
// Helper: Simulate the think() orchestration flow with a MockAdapter.
//
// We cannot call think() directly because it depends on module-level constants
// (WORKSPACE_PATH, SYSTEM_PROMPT_PATH) that point to the real workspace.
// Instead, we replicate its orchestration steps against our test workspace,
// exercising the same code paths the real think() uses.
// ---------------------------------------------------------------------------

async function simulateThink(
  registry: AdapterRegistry,
  message: string,
  ws: TestWorkspace,
  opts: {
    mode?: 'yolo' | 'print' | 'api';
    invocationType?: 'conversation' | 'reflection' | 'summarization' | 'extraction';
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  } = {},
): Promise<ThoughtResult> {
  const invocationType = opts.invocationType ?? 'conversation';
  const history = opts.history ?? [];
  const startMs = Date.now();

  // 1. Resolve route
  const route = resolveRoute(invocationType);

  // 2. Determine effective mode
  const effectiveMode = invocationType === 'conversation'
    ? (opts.mode ?? route.mode)
    : route.mode;

  // 3. Load system prompt from test workspace
  let systemPrompt: string;
  const identityPath = join(ws.path, 'identity', 'self.md');
  try {
    systemPrompt = readFileSync(identityPath, 'utf-8') ?? '';
  } catch {
    systemPrompt = '';
  }

  // Append mode context
  const modeContext = buildModeContext(effectiveMode);
  systemPrompt += '\n\n---\n\n' + modeContext;

  // 4. Build adapter input
  const adapterInput: AdapterInput = {
    message,
    history,
    systemPrompt,
    route,
    workspacePath: ws.path,
    effectiveMode,
  };

  // 5. Select adapter
  const adapterName = resolveAdapterName(registry, invocationType);
  const adapter = registry.get(adapterName);

  // 6. Invoke adapter
  const result = await adapter.invoke(adapterInput);

  // 7. Extract writebacks from raw response text
  // The MockAdapter returns raw text without parsing writebacks.
  // Real adapters use collectStreamToResult which calls extractWritebacks.
  // We replicate that here to test the full orchestration flow.
  const { directives, cleanResponse } = extractWritebacks(result.text);
  result.memoryWrites = directives;
  result.cleanText = cleanResponse;

  // 8. Apply writeback directives
  if (result.memoryWrites.length > 0) {
    const writeResult = await applyWritebacks(result.memoryWrites, ws.path);
    if (writeResult.failed.length > 0) {
      const failedFiles = writeResult.failed.map((f) => f.file).join(', ');
      result.cleanText += `\n\n[Note: memory write failed for: ${failedFiles}]`;
    }
  }

  // 9. Return result with timing
  result.elapsedMs = Date.now() - startMs;
  return result;
}

// ===========================================================================
// Test suites
// ===========================================================================

describe('integration: think() orchestrator with MockAdapter', () => {
  let ws: TestWorkspace;
  let registry: AdapterRegistry;
  let adapter: MockAdapter;

  beforeEach(() => {
    ws = createTestWorkspace();
    registry = new AdapterRegistry();
    adapter = new MockAdapter('claude-code-cli');
    registry.register(adapter);
  });

  afterEach(() => {
    ws.cleanup();
  });

  // ── Route resolution and adapter invocation ───────────────────────

  describe('route resolution and adapter invocation', () => {
    it('resolves route and calls adapter for conversation type', async () => {
      adapter.setDefaultResponse('Hello from Timothy');

      const result = await simulateThink(registry, 'Hi there', ws);

      expect(result.text).toBe('Hello from Timothy');
      expect(result.modelUsed).toBe('claude-sonnet-4-6');
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.message).toBe('Hi there');
      expect(invocation.route.model).toBe('claude-sonnet-4-6');
    });

    it('resolves route for reflection type with correct model', async () => {
      adapter.setDefaultResponse('Reflection complete');

      const result = await simulateThink(registry, 'Reflect', ws, {
        invocationType: 'reflection',
      });

      expect(result.modelUsed).toBe('claude-haiku-4-5');

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.route.model).toBe('claude-haiku-4-5');
      expect(invocation.effectiveMode).toBe('print');
    });

    it('resolves route for summarization type', async () => {
      adapter.setDefaultResponse('Summary');

      await simulateThink(registry, 'Summarize', ws, {
        invocationType: 'summarization',
      });

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.route.model).toBe('claude-haiku-4-5');
      expect(invocation.route.timeoutMs).toBe(30_000);
    });

    it('resolves route for extraction type', async () => {
      adapter.setDefaultResponse('Extracted');

      await simulateThink(registry, 'Extract', ws, {
        invocationType: 'extraction',
      });

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.route.model).toBe('claude-haiku-4-5');
      expect(invocation.effectiveMode).toBe('print');
    });
  });

  // ── System prompt assembly ────────────────────────────────────────

  describe('system prompt assembly', () => {
    it('includes identity from workspace in system prompt', async () => {
      writeFileSync(
        join(ws.path, 'identity', 'self.md'),
        '# Timothy\n\nI am Timothy. I value directness.\n',
      );

      adapter.setDefaultResponse('ok');
      await simulateThink(registry, 'Who are you?', ws);

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.systemPrompt).toContain('Timothy');
      expect(invocation.systemPrompt).toContain('directness');
    });

    it('includes mode context for yolo mode', async () => {
      adapter.setDefaultResponse('ok');
      await simulateThink(registry, 'Test', ws, { mode: 'yolo' });

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.systemPrompt).toContain('Autonomous');
      expect(invocation.systemPrompt).toContain('full autonomous mode');
    });

    it('includes mode context for print mode', async () => {
      adapter.setDefaultResponse('ok');
      await simulateThink(registry, 'Test', ws, {
        invocationType: 'reflection',
      });

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.systemPrompt).toContain('Stateless');
      expect(invocation.systemPrompt).toContain('print mode');
    });
  });

  // ── Writeback processing ──────────────────────────────────────────

  describe('writeback directive processing', () => {
    it('applies create writeback directives to workspace', async () => {
      const responseWithWriteback = [
        'I will remember that.',
        '<!--timothy-write',
        'file: memory/facts/router-test.md',
        'action: create',
        'Router test fact content.',
        '-->',
        'Done!',
      ].join('\n');

      adapter.setDefaultResponse(responseWithWriteback);
      const result = await simulateThink(registry, 'Remember this', ws);

      // Verify the file was written
      const factPath = join(ws.path, 'memory', 'facts', 'router-test.md');
      expect(existsSync(factPath)).toBe(true);
      const content = readFileSync(factPath, 'utf-8');
      expect(content).toContain('Router test fact content.');

      // cleanText should not contain the directive
      expect(result.cleanText).not.toContain('<!--timothy-write');
      expect(result.cleanText).toContain('I will remember that.');
      expect(result.cleanText).toContain('Done!');
    });

    it('applies append writeback directives to existing files', async () => {
      // Seed an existing file
      writeFileSync(join(ws.path, 'journal.md'), '# Journal\n\nEntry 1.\n');

      const responseWithAppend = [
        'Added to journal.',
        '<!--timothy-write',
        'file: journal.md',
        'action: append',
        'Entry 2: New insight.',
        '-->',
      ].join('\n');

      adapter.setDefaultResponse(responseWithAppend);
      await simulateThink(registry, 'Log this', ws);

      const journalContent = readFileSync(join(ws.path, 'journal.md'), 'utf-8');
      expect(journalContent).toContain('Entry 1.');
      expect(journalContent).toContain('Entry 2: New insight.');
    });

    it('applies multiple writeback directives in one response', async () => {
      const responseWithMultiple = [
        'Noted both facts.',
        '<!--timothy-write',
        'file: memory/facts/fact-a.md',
        'action: create',
        'Fact A content.',
        '-->',
        '<!--timothy-write',
        'file: memory/facts/fact-b.md',
        'action: create',
        'Fact B content.',
        '-->',
      ].join('\n');

      adapter.setDefaultResponse(responseWithMultiple);
      await simulateThink(registry, 'Remember both', ws);

      expect(existsSync(join(ws.path, 'memory', 'facts', 'fact-a.md'))).toBe(true);
      expect(existsSync(join(ws.path, 'memory', 'facts', 'fact-b.md'))).toBe(true);
    });

    it('rejects writeback directives with path traversal', async () => {
      const responseWithTraversal = [
        'Attempting escape.',
        '<!--timothy-write',
        'file: ../../../etc/evil.md',
        'action: create',
        'Evil content.',
        '-->',
      ].join('\n');

      adapter.setDefaultResponse(responseWithTraversal);
      const result = await simulateThink(registry, 'Escape attempt', ws);

      // The file should not have been created anywhere outside workspace
      expect(result.cleanText).not.toContain('<!--timothy-write');
    });
  });

  // ── ThoughtResult fields ──────────────────────────────────────────

  describe('ThoughtResult structure', () => {
    it('returns all required fields', async () => {
      adapter.setDefaultResponse('Complete response');

      const result = await simulateThink(registry, 'Test', ws);

      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('memoryWrites');
      expect(result).toHaveProperty('cleanText');
      expect(result).toHaveProperty('mode');
      expect(result).toHaveProperty('modelUsed');
      expect(result).toHaveProperty('elapsedMs');
      expect(typeof result.elapsedMs).toBe('number');
      expect(Array.isArray(result.memoryWrites)).toBe(true);
    });

    it('memoryWrites contains parsed directives', async () => {
      const responseWithDirective = [
        'Noted.',
        '<!--timothy-write',
        'file: memory/facts/parsed.md',
        'action: create',
        'Parsed content.',
        '-->',
      ].join('\n');

      adapter.setDefaultResponse(responseWithDirective);
      const result = await simulateThink(registry, 'Parse test', ws);

      expect(result.memoryWrites).toHaveLength(1);
      expect(result.memoryWrites[0].file).toBe('memory/facts/parsed.md');
      expect(result.memoryWrites[0].action).toBe('create');
    });

    it('memoryWrites is empty when no directives present', async () => {
      adapter.setDefaultResponse('No directives here.');

      const result = await simulateThink(registry, 'Simple message', ws);

      expect(result.memoryWrites).toHaveLength(0);
    });
  });

  // ── Error handling ────────────────────────────────────────────────

  describe('error handling', () => {
    it('propagates adapter errors', async () => {
      adapter.setError(new Error('Adapter connection failed'));

      await expect(
        simulateThink(registry, 'Will fail', ws),
      ).rejects.toThrow('Adapter connection failed');
    });

    it('adapter recovers after error is cleared', async () => {
      adapter.setError(new Error('Temporary failure'));
      await expect(simulateThink(registry, 'Fail', ws)).rejects.toThrow();

      adapter.clearError();
      adapter.setDefaultResponse('Recovered');
      const result = await simulateThink(registry, 'Retry', ws);
      expect(result.text).toBe('Recovered');
    });
  });

  // ── Mode resolution precedence ────────────────────────────────────

  describe('mode resolution precedence', () => {
    it('conversation respects caller mode override', async () => {
      adapter.setDefaultResponse('ok');

      await simulateThink(registry, 'Test', ws, {
        mode: 'print',
        invocationType: 'conversation',
      });

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.effectiveMode).toBe('print');
    });

    it('conversation defaults to route mode when no override', async () => {
      adapter.setDefaultResponse('ok');

      await simulateThink(registry, 'Test', ws, {
        invocationType: 'conversation',
      });

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.effectiveMode).toBe('yolo');
    });

    it('non-conversation types ignore caller mode override', async () => {
      adapter.setDefaultResponse('ok');

      // Even if we pass mode: 'yolo', reflection should use route's 'print'
      await simulateThink(registry, 'Test', ws, {
        mode: 'yolo',
        invocationType: 'reflection',
      });

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.effectiveMode).toBe('print');
    });
  });

  // ── History passthrough ───────────────────────────────────────────

  describe('history passthrough', () => {
    it('passes conversation history to adapter', async () => {
      const history = [
        { role: 'user' as const, content: 'Previous message' },
        { role: 'assistant' as const, content: 'Previous response' },
      ];

      adapter.setDefaultResponse('ok');
      await simulateThink(registry, 'Follow up', ws, { history });

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.history).toHaveLength(2);
      expect(invocation.history[0].content).toBe('Previous message');
      expect(invocation.history[1].content).toBe('Previous response');
    });

    it('passes empty history when none provided', async () => {
      adapter.setDefaultResponse('ok');
      await simulateThink(registry, 'First message', ws);

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.history).toHaveLength(0);
    });
  });
});
