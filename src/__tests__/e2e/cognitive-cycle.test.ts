/**
 * E2E tests for the full cognitive cycle: think -> writeback -> memory persistence.
 *
 * These tests wire REAL modules together (continuity, adapter registry,
 * cognitive loop) with real filesystem I/O. LLM calls are replaced via
 * MockAdapter to avoid API costs while exercising all module boundaries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterRegistry, collectStreamToResult } from '../../adapter.js';
import { extractWritebacks, applyWritebacks, ContinuityManager } from '../../continuity.js';
import { resolveRoute, buildModeContext } from '../../router.js';
import { MockAdapter } from '../helpers/test-adapter.js';
import {
  createTestWorkspace,
  seedConcerns,
  seedAttentionQueue,
} from '../helpers/test-workspace.js';
import type { TestWorkspace } from '../helpers/test-workspace.js';
import type { ThoughtResult, AdapterInput } from '../../types.js';
import {
  CognitiveLoop,
  computeUrgencyScore,
  parseConcerns,
} from '../../autonomy/cognitive-loop.js';

// ---------------------------------------------------------------------------
// Helper: simulate a think() cycle against a test workspace
// ---------------------------------------------------------------------------

async function thinkCycle(
  adapter: MockAdapter,
  ws: TestWorkspace,
  message: string,
  opts: {
    invocationType?: 'conversation' | 'reflection' | 'summarization' | 'extraction';
    mode?: 'yolo' | 'print' | 'api';
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  } = {},
): Promise<ThoughtResult> {
  const invocationType = opts.invocationType ?? 'conversation';
  const route = resolveRoute(invocationType);
  const effectiveMode = invocationType === 'conversation'
    ? (opts.mode ?? route.mode)
    : route.mode;

  let systemPrompt = '';
  try {
    systemPrompt = readFileSync(join(ws.path, 'identity', 'self.md'), 'utf-8');
  } catch {
    systemPrompt = 'You are Titus.';
  }
  systemPrompt += '\n\n---\n\n' + buildModeContext(effectiveMode);

  const input: AdapterInput = {
    message,
    history: opts.history ?? [],
    systemPrompt,
    route,
    workspacePath: ws.path,
    effectiveMode,
  };

  const result = await adapter.invoke(input);

  // Extract writebacks from raw response text (MockAdapter returns raw text)
  const { directives, cleanResponse } = extractWritebacks(result.text);
  result.memoryWrites = directives;
  result.cleanText = cleanResponse;

  // Apply writebacks to test workspace
  if (result.memoryWrites.length > 0) {
    await applyWritebacks(result.memoryWrites, ws.path);
  }

  return result;
}

// ===========================================================================
// Test suites
// ===========================================================================

describe('E2E: full cognitive cycle', () => {
  let ws: TestWorkspace;
  let adapter: MockAdapter;

  beforeEach(() => {
    ws = createTestWorkspace();
    adapter = new MockAdapter('claude-code-cli');
  });

  afterEach(() => {
    ws.cleanup();
  });

  // ── think() -> writeback -> memory files updated ──────────────────

  describe('think -> writeback -> memory persistence', () => {
    it('creates a new memory file from writeback directive', async () => {
      adapter.setDefaultResponse([
        'I noted your preference.',
        '<!--titus-write',
        'file: memory/facts/user-preference.md',
        'action: create',
        '---',
        'topic: preferences',
        'confidence: 0.9',
        '---',
        'User prefers TypeScript over JavaScript.',
        '-->',
        'Anything else?',
      ].join('\n'));

      const result = await thinkCycle(adapter, ws, 'I prefer TypeScript');

      // Verify response is clean
      expect(result.cleanText).toContain('I noted your preference.');
      expect(result.cleanText).toContain('Anything else?');
      expect(result.cleanText).not.toContain('<!--titus-write');

      // Verify memory file was created with frontmatter
      const factPath = join(ws.path, 'memory', 'facts', 'user-preference.md');
      expect(existsSync(factPath)).toBe(true);
      const content = readFileSync(factPath, 'utf-8');
      expect(content).toContain('topic: preferences');
      expect(content).toContain('confidence: 0.9');
      expect(content).toContain('TypeScript over JavaScript');
    });

    it('appends to an existing memory file', async () => {
      // Seed existing journal
      writeFileSync(join(ws.path, 'journal.md'), '# Journal\n\n## Day 1\nFirst entry.\n');

      adapter.setDefaultResponse([
        'Journal updated.',
        '<!--titus-write',
        'file: journal.md',
        'action: append',
        '',
        '## Day 2',
        'Second entry from cognitive cycle.',
        '-->',
      ].join('\n'));

      await thinkCycle(adapter, ws, 'Add to journal');

      const journal = readFileSync(join(ws.path, 'journal.md'), 'utf-8');
      expect(journal).toContain('First entry.');
      expect(journal).toContain('Second entry from cognitive cycle.');
    });

    it('handles multiple writebacks in a single response', async () => {
      adapter.setDefaultResponse([
        'Noted both facts.',
        '<!--titus-write',
        'file: memory/facts/fact-one.md',
        'action: create',
        'First fact.',
        '-->',
        '<!--titus-write',
        'file: memory/facts/fact-two.md',
        'action: create',
        'Second fact.',
        '-->',
      ].join('\n'));

      const result = await thinkCycle(adapter, ws, 'Remember two things');

      expect(result.memoryWrites).toHaveLength(2);
      expect(existsSync(join(ws.path, 'memory', 'facts', 'fact-one.md'))).toBe(true);
      expect(existsSync(join(ws.path, 'memory', 'facts', 'fact-two.md'))).toBe(true);
    });
  });

  // ── Workspace state persists across multiple think() calls ────────

  describe('workspace state persists across think() calls', () => {
    it('memory written in first call is visible to second call assertions', async () => {
      // First think: create a fact
      adapter.setDefaultResponse([
        'Created fact.',
        '<!--titus-write',
        'file: memory/facts/persistent-fact.md',
        'action: create',
        'The capital of France is Paris.',
        '-->',
      ].join('\n'));

      await thinkCycle(adapter, ws, 'Capital of France');

      // Verify the fact persists
      const factPath = join(ws.path, 'memory', 'facts', 'persistent-fact.md');
      expect(existsSync(factPath)).toBe(true);

      // Second think: a different response, but fact still exists
      adapter.setDefaultResponse('Just a chat, no writebacks.');
      const result2 = await thinkCycle(adapter, ws, 'How are you?');

      expect(result2.memoryWrites).toHaveLength(0);
      // The file from the first cycle should still be there
      expect(existsSync(factPath)).toBe(true);
      expect(readFileSync(factPath, 'utf-8')).toContain('Paris');
    });

    it('multiple cycles accumulate workspace state', async () => {
      // Cycle 1: create
      adapter.setDefaultResponse([
        'ok',
        '<!--titus-write',
        'file: memory/facts/accumulate.md',
        'action: create',
        'Line 1.',
        '-->',
      ].join('\n'));
      await thinkCycle(adapter, ws, 'First');

      // Cycle 2: append
      adapter.setDefaultResponse([
        'ok',
        '<!--titus-write',
        'file: memory/facts/accumulate.md',
        'action: append',
        'Line 2.',
        '-->',
      ].join('\n'));
      await thinkCycle(adapter, ws, 'Second');

      // Cycle 3: append again
      adapter.setDefaultResponse([
        'ok',
        '<!--titus-write',
        'file: memory/facts/accumulate.md',
        'action: append',
        'Line 3.',
        '-->',
      ].join('\n'));
      await thinkCycle(adapter, ws, 'Third');

      const content = readFileSync(
        join(ws.path, 'memory', 'facts', 'accumulate.md'),
        'utf-8',
      );
      expect(content).toContain('Line 1.');
      expect(content).toContain('Line 2.');
      expect(content).toContain('Line 3.');
    });

    it('update action replaces file content', async () => {
      // Create initial content
      adapter.setDefaultResponse([
        'ok',
        '<!--titus-write',
        'file: working-memory/active-context.md',
        'action: create',
        'Original context.',
        '-->',
      ].join('\n'));
      await thinkCycle(adapter, ws, 'Set context');

      // Update replaces it
      adapter.setDefaultResponse([
        'ok',
        '<!--titus-write',
        'file: working-memory/active-context.md',
        'action: update',
        'Updated context with new information.',
        '-->',
      ].join('\n'));
      await thinkCycle(adapter, ws, 'Update context');

      const content = readFileSync(
        join(ws.path, 'working-memory', 'active-context.md'),
        'utf-8',
      );
      expect(content).toContain('Updated context with new information.');
      expect(content).not.toContain('Original context.');
    });
  });

  // ── ContinuityManager processResponse end-to-end ──────────────────

  describe('ContinuityManager processResponse end-to-end', () => {
    it('extracts writebacks and applies them in one step', async () => {
      const manager = new ContinuityManager(ws.path);

      const rawResponse = [
        'I will remember that.',
        '<!--titus-write',
        'file: memory/facts/cm-test.md',
        'action: create',
        'ContinuityManager test fact.',
        '-->',
        'Done.',
      ].join('\n');

      const processed = await manager.processResponse(rawResponse);

      expect(processed.cleanResponse).toContain('I will remember that.');
      expect(processed.cleanResponse).toContain('Done.');
      expect(processed.cleanResponse).not.toContain('<!--titus-write');
      expect(processed.writebackResults.succeeded).toContain('memory/facts/cm-test.md');

      const content = readFileSync(join(ws.path, 'memory', 'facts', 'cm-test.md'), 'utf-8');
      expect(content).toContain('ContinuityManager test fact.');
    });

    it('returns clean response when no directives present', async () => {
      const manager = new ContinuityManager(ws.path);
      const result = await manager.processResponse('Just a normal reply.');

      expect(result.cleanResponse).toBe('Just a normal reply.');
      expect(result.writebackResults.succeeded).toEqual([]);
      expect(result.writebackResults.failed).toEqual([]);
    });
  });

  // ── collectStreamToResult integration ─────────────────────────────

  describe('collectStreamToResult extracts writebacks from stream', () => {
    it('collects streaming chunks and parses directives', async () => {
      const responseWithDirective = [
        'Streamed reply.',
        '<!--titus-write',
        'file: memory/facts/streamed.md',
        'action: create',
        'Streamed fact.',
        '-->',
        'End.',
      ].join('\n');

      const handle = await adapter.invokeStreaming({
        message: responseWithDirective,
        history: [],
        systemPrompt: 'You are Titus.',
        route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
        workspacePath: ws.path,
        effectiveMode: 'yolo',
      });

      // Adapter returns responseWithDirective as pattern-matched response
      // But default mock just returns the default, so set it
      adapter.setDefaultResponse(responseWithDirective);

      // Use collectStreamToResult from adapter module
      const handle2 = await adapter.invokeStreaming({
        message: 'test',
        history: [],
        systemPrompt: 'You are Titus.',
        route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
        workspacePath: ws.path,
        effectiveMode: 'yolo',
      });

      const result = await collectStreamToResult(handle2, 'mock', 'claude-sonnet-4-6', Date.now());

      expect(result.memoryWrites).toHaveLength(1);
      expect(result.memoryWrites[0].file).toBe('memory/facts/streamed.md');
      expect(result.cleanText).not.toContain('<!--titus-write');
      expect(result.cleanText).toContain('End.');
    });
  });

  // ── CognitiveLoop evaluates attention and triggers invocation ──────

  describe('CognitiveLoop attention evaluation', () => {
    it('evaluateAttention computes urgency from workspace state', async () => {
      // Seed workspace with concerns
      seedConcerns(ws.path, ['Deployment is failing', 'API review needed']);

      // Seed attention queue with items
      seedAttentionQueue(ws.path, [
        'HIGH: Review PR by end of day',
        'MEDIUM: Update documentation',
      ]);

      // CognitiveLoop reads from its workspacePath
      const selfInvoked = vi.fn();
      const loop = new CognitiveLoop(
        {
          workspacePath: ws.path,
          urgencyThreshold: 0.3,
          minIntervalMs: 100,
          maxIntervalMs: 1000,
        },
        selfInvoked,
      );

      const state = await loop.evaluateAttention();

      // Should detect the concerns
      expect(state.concerns.length).toBeGreaterThan(0);
      expect(state.concerns.some((c) => c.text.includes('Deployment'))).toBe(true);

      // Urgency should be elevated due to active concerns
      expect(state.urgencyScore).toBeGreaterThan(0);

      loop.stop();
    });

    it('shouldThink returns true when urgency exceeds threshold', async () => {
      seedConcerns(ws.path, [
        'Critical production issue',
        'Security vulnerability found',
        'Customer escalation pending',
      ]);

      const selfInvoked = vi.fn();
      const loop = new CognitiveLoop(
        {
          workspacePath: ws.path,
          urgencyThreshold: 0.3,
          minIntervalMs: 100,
          maxIntervalMs: 1000,
        },
        selfInvoked,
      );

      // Force first evaluation to have maximal time pressure
      loop._setLastEvaluationTime(0);

      const state = await loop.evaluateAttention();
      const shouldThink = loop.shouldThink(state);

      // 3 active concerns = 0.45, plus time pressure = should exceed 0.3
      expect(shouldThink).toBe(true);
      expect(state.urgencyScore).toBeGreaterThanOrEqual(0.3);

      loop.stop();
    });

    it('shouldThink returns false when workspace is calm', async () => {
      // Default test workspace has no concerns, no attention items
      const selfInvoked = vi.fn();
      const loop = new CognitiveLoop(
        {
          workspacePath: ws.path,
          urgencyThreshold: 0.6,
          minIntervalMs: 100,
          maxIntervalMs: 1000,
        },
        selfInvoked,
      );

      // Set last evaluation to very recent (no time pressure)
      loop._setLastEvaluationTime(Date.now() - 10);

      const state = await loop.evaluateAttention();
      const shouldThink = loop.shouldThink(state);

      expect(shouldThink).toBe(false);
      expect(state.urgencyScore).toBeLessThan(0.6);

      loop.stop();
    });
  });

  // ── CognitiveLoop start/stop lifecycle ────────────────────────────

  describe('CognitiveLoop lifecycle', () => {
    it('starts and stops cleanly', () => {
      const selfInvoked = vi.fn();
      const loop = new CognitiveLoop(
        {
          workspacePath: ws.path,
          minIntervalMs: 60_000,
          maxIntervalMs: 900_000,
          urgencyThreshold: 0.6,
        },
        selfInvoked,
      );

      expect(loop.isRunning()).toBe(false);

      loop.start();
      expect(loop.isRunning()).toBe(true);

      loop.stop();
      expect(loop.isRunning()).toBe(false);
    });

    it('records user messages for timing calculations', () => {
      const selfInvoked = vi.fn();
      const loop = new CognitiveLoop(
        { workspacePath: ws.path },
        selfInvoked,
      );

      // Should not throw
      loop.recordUserMessage();

      loop.stop();
    });
  });

  // ── Full cycle: think -> write -> read back -> verify ─────────────

  describe('full cycle: multi-step with verification', () => {
    it('complete cognitive cycle with identity, memory write, and verification', async () => {
      // Step 1: Set up identity
      writeFileSync(
        join(ws.path, 'identity', 'self.md'),
        '# Titus\n\nI am Titus. I remember everything.\n',
      );

      // Step 2: Think and write a memory
      adapter.setDefaultResponse([
        'I will remember your name.',
        '<!--titus-write',
        'file: memory/facts/user-name.md',
        'action: create',
        '---',
        'topic: identity',
        'confidence: 1.0',
        '---',
        "The user's name is Chris.",
        '-->',
      ].join('\n'));

      const result1 = await thinkCycle(adapter, ws, 'My name is Chris');

      expect(result1.cleanText).toContain('remember your name');
      expect(result1.memoryWrites).toHaveLength(1);

      // Step 3: Verify memory was persisted
      const nameFact = join(ws.path, 'memory', 'facts', 'user-name.md');
      expect(existsSync(nameFact)).toBe(true);
      const nameContent = readFileSync(nameFact, 'utf-8');
      expect(nameContent).toContain('Chris');
      expect(nameContent).toContain('topic: identity');

      // Step 4: Second think cycle - no writebacks
      adapter.setDefaultResponse('Hello Chris! Yes, I remember you.');
      const result2 = await thinkCycle(adapter, ws, 'Do you remember my name?');

      expect(result2.cleanText).toContain('Hello Chris');
      expect(result2.memoryWrites).toHaveLength(0);

      // Step 5: Verify identity is passed through
      const lastInvocation = adapter.getLastInvocation()!;
      expect(lastInvocation.systemPrompt).toContain('Titus');
      expect(lastInvocation.systemPrompt).toContain('remember everything');

      // Step 6: Memory file still exists unchanged after second cycle
      expect(existsSync(nameFact)).toBe(true);
      expect(readFileSync(nameFact, 'utf-8')).toContain('Chris');
    });

    it('reflection cycle writes to workspace and persists', async () => {
      // Simulate a reflection cycle (print mode)
      adapter.setDefaultResponse([
        'Reflecting on workspace state.',
        '<!--titus-write',
        'file: working-memory/active-context.md',
        'action: update',
        'Currently thinking about the deployment pipeline.',
        '-->',
      ].join('\n'));

      const result = await thinkCycle(adapter, ws, 'What should I focus on?', {
        invocationType: 'reflection',
      });

      const invocation = adapter.getLastInvocation()!;
      expect(invocation.effectiveMode).toBe('print');
      expect(invocation.route.model).toBe('claude-haiku-4-5');

      // Verify workspace was updated
      const contextPath = join(ws.path, 'working-memory', 'active-context.md');
      expect(existsSync(contextPath)).toBe(true);
      const content = readFileSync(contextPath, 'utf-8');
      expect(content).toContain('deployment pipeline');
    });
  });
});
