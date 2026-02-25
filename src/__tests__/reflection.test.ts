import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setMemoryDir, _setWorkingMemoryDir, serializeMemoryFile } from '../memory.js';
import type { MemoryFrontmatter } from '../memory.js';
import {
  gather,
  decide,
  reflect,
  runHeartbeat,
  startReflectionHeartbeat,
  stopReflectionHeartbeat,
  _setReflectionInvoker,
  _setLastReflectionTime,
  _getLastReflectionTime,
  _isHeartbeatRunning,
  REFLECTION_CHAT_ID,
  type GatherResult,
} from '../reflection.js';

const tmpWm = join(tmpdir(), 'timothy-test-reflection-wm');
const tmpMem = join(tmpdir(), 'timothy-test-reflection-mem');

/** Builds a GatherResult with autonomy defaults for backward-compatible tests */
function makeGatherResult(overrides: Partial<GatherResult> = {}): GatherResult {
  return {
    workingMemory: [],
    activeThreads: [],
    hasAttentionItems: false,
    hasPendingActions: false,
    trustSummary: 'Trust state: not loaded.',
    pendingProposalCount: 0,
    trustScore: 0.5,
    ...overrides,
  };
}

function makeWmContent(body: string): string {
  const fm: MemoryFrontmatter = {
    created: '2026-02-22T00:00:00Z',
    updated: '2026-02-22T00:00:00Z',
    version: 1,
    type: 'working-memory',
    tags: ['working-memory'],
  };
  return serializeMemoryFile(fm, body);
}

beforeEach(() => {
  rmSync(tmpWm, { recursive: true, force: true });
  rmSync(tmpMem, { recursive: true, force: true });
  mkdirSync(tmpWm, { recursive: true });
  mkdirSync(tmpMem, { recursive: true });
  _setWorkingMemoryDir(tmpWm);
  _setMemoryDir(tmpMem);
  _setReflectionInvoker(null);
  _setLastReflectionTime(0);
});

afterEach(async () => {
  _setReflectionInvoker(null);
  _setLastReflectionTime(0);
  await stopReflectionHeartbeat();
  rmSync(tmpWm, { recursive: true, force: true });
  rmSync(tmpMem, { recursive: true, force: true });
});

// ── GATHER tests ─────────────────────────────────────────────────────

describe('gather', () => {
  it('returns empty state when no working memory or threads exist', async () => {
    const result = await gather();
    expect(result.workingMemory).toEqual([]);
    expect(result.activeThreads).toEqual([]);
    expect(result.hasAttentionItems).toBe(false);
    expect(result.hasPendingActions).toBe(false);
  });

  it('loads working memory files', async () => {
    writeFileSync(
      join(tmpWm, 'active-context.md'),
      makeWmContent('Focused on implementing the heartbeat.'),
    );

    const result = await gather();
    expect(result.workingMemory).toHaveLength(1);
    expect(result.workingMemory[0].name).toBe('active-context.md');
  });

  it('detects attention items in non-placeholder content', async () => {
    writeFileSync(
      join(tmpWm, 'attention-queue.md'),
      makeWmContent('## Attention Queue\n\n- HIGH: Review PR #42 by end of day'),
    );

    const result = await gather();
    expect(result.hasAttentionItems).toBe(true);
  });

  it('ignores placeholder attention queue', async () => {
    writeFileSync(
      join(tmpWm, 'attention-queue.md'),
      makeWmContent('## Attention Queue\n\n(No items queued yet.)'),
    );

    const result = await gather();
    expect(result.hasAttentionItems).toBe(false);
  });

  it('detects pending actions', async () => {
    writeFileSync(
      join(tmpWm, 'pending-actions.md'),
      makeWmContent('## Pending Actions\n\n- Follow up with Chris about deployment'),
    );

    const result = await gather();
    expect(result.hasPendingActions).toBe(true);
  });

  it('ignores placeholder pending actions', async () => {
    writeFileSync(
      join(tmpWm, 'pending-actions.md'),
      makeWmContent('## Pending Actions\n\n(No pending actions yet.)'),
    );

    const result = await gather();
    expect(result.hasPendingActions).toBe(false);
  });
});

// ── DECIDE tests ─────────────────────────────────────────────────────

describe('decide', () => {
  it('returns shouldReflect=false when nothing needs attention', () => {
    const gatherResult = makeGatherResult();

    const result = decide(gatherResult);
    expect(result.shouldReflect).toBe(false);
    expect(result.reason).toContain('nothing needs attention');
  });

  it('returns shouldReflect=true when attention queue has items', () => {
    const gatherResult = makeGatherResult({ hasAttentionItems: true });

    const result = decide(gatherResult);
    expect(result.shouldReflect).toBe(true);
    expect(result.reason).toContain('attention queue');
  });

  it('returns shouldReflect=true when pending actions exist', () => {
    const gatherResult = makeGatherResult({ hasPendingActions: true });

    const result = decide(gatherResult);
    expect(result.shouldReflect).toBe(true);
    expect(result.reason).toContain('pending actions');
  });

  it('returns shouldReflect=true when pending proposals exist', () => {
    const gatherResult = makeGatherResult({ pendingProposalCount: 2 });

    const result = decide(gatherResult);
    expect(result.shouldReflect).toBe(true);
    expect(result.reason).toContain('pending proposals');
  });

  it('returns shouldReflect=true for stale threads', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const gatherResult = makeGatherResult({
      activeThreads: [
        { id: 'thread-1', topic: 'old topic', status: 'active', lastActivity: threeHoursAgo },
      ],
    });

    const result = decide(gatherResult);
    expect(result.shouldReflect).toBe(true);
    expect(result.reason).toContain('stale thread');
  });

  it('does not flag recent threads as stale', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const gatherResult = makeGatherResult({
      activeThreads: [
        { id: 'thread-1', topic: 'recent topic', status: 'active', lastActivity: tenMinutesAgo },
      ],
    });

    const result = decide(gatherResult);
    expect(result.shouldReflect).toBe(false);
  });

  it('rate-limits when last reflection was recent', () => {
    _setLastReflectionTime(Date.now() - 60_000); // 1 minute ago

    const gatherResult = makeGatherResult({ hasAttentionItems: true });

    const result = decide(gatherResult);
    expect(result.shouldReflect).toBe(false);
    expect(result.reason).toContain('rate-limited');
  });

  it('allows reflection when enough time has passed since last one', () => {
    _setLastReflectionTime(Date.now() - 600_000); // 10 minutes ago

    const gatherResult = makeGatherResult({ hasAttentionItems: true });

    const result = decide(gatherResult);
    expect(result.shouldReflect).toBe(true);
  });
});

// ── REFLECT tests ────────────────────────────────────────────────────

describe('reflect', () => {
  it('invokes the LLM and returns the response', async () => {
    _setReflectionInvoker(async () => 'Nothing requires attention.');

    const gatherResult = makeGatherResult({ hasAttentionItems: true });

    const result = await reflect(gatherResult);
    expect(result.response).toBe('Nothing requires attention.');
    expect(result.writebacks).toEqual([]);
    expect(result.proactiveMessage).toBeNull();
  });

  it('returns null response when LLM fails', async () => {
    _setReflectionInvoker(async () => null);

    const gatherResult = makeGatherResult({ hasAttentionItems: true });

    const result = await reflect(gatherResult);
    expect(result.response).toBeNull();
    expect(result.writebacks).toEqual([]);
    expect(result.proactiveMessage).toBeNull();
  });

  it('extracts proactive message from response', async () => {
    _setReflectionInvoker(async () =>
      'I noticed something.\n\n<!--timothy-proactive\nHey Chris, just a heads up about the deployment.\n-->',
    );

    const gatherResult = makeGatherResult({ hasAttentionItems: true });

    const result = await reflect(gatherResult);
    expect(result.proactiveMessage).toBe('Hey Chris, just a heads up about the deployment.');
  });

  it('updates lastReflectionTime after reflecting', async () => {
    _setLastReflectionTime(0);
    _setReflectionInvoker(async () => 'Nothing requires attention.');

    const gatherResult = makeGatherResult({ hasAttentionItems: true });

    await reflect(gatherResult);
    expect(_getLastReflectionTime()).toBeGreaterThan(0);
  });

  it('passes working memory and threads to the LLM prompt', async () => {
    let capturedPrompt = '';
    _setReflectionInvoker(async (prompt) => {
      capturedPrompt = prompt;
      return 'Nothing requires attention.';
    });

    const gatherResult = makeGatherResult({
      workingMemory: [
        { name: 'active-context.md', content: 'Currently focused on testing.' },
      ],
      activeThreads: [
        { id: 't-1', topic: 'deployment strategy', status: 'active', lastActivity: '2026-02-22T10:00:00Z' },
      ],
    });

    await reflect(gatherResult);
    expect(capturedPrompt).toContain('Currently focused on testing.');
    expect(capturedPrompt).toContain('deployment strategy');
  });

  it('includes autonomy state in the LLM prompt', async () => {
    let capturedPrompt = '';
    _setReflectionInvoker(async (prompt) => {
      capturedPrompt = prompt;
      return 'Nothing requires attention.';
    });

    const gatherResult = makeGatherResult({
      hasAttentionItems: true,
      trustSummary: '## Autonomy Trust State\n\nOverall trust score: 0.7\nAllowed tiers: autonomous, propose',
      pendingProposalCount: 3,
    });

    await reflect(gatherResult);
    expect(capturedPrompt).toContain('Autonomy State');
    expect(capturedPrompt).toContain('Overall trust score: 0.7');
    expect(capturedPrompt).toContain('Pending proposals: 3');
  });
});

// ── runHeartbeat integration ─────────────────────────────────────────

describe('runHeartbeat', () => {
  it('returns skip when nothing needs attention', async () => {
    const result = await runHeartbeat();
    expect(result.phase).toBe('skip');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.gatherResult).toBeDefined();
    expect(result.decideResult).toBeDefined();
    expect(result.decideResult!.shouldReflect).toBe(false);
  });

  it('reflects when attention queue has items', async () => {
    writeFileSync(
      join(tmpWm, 'attention-queue.md'),
      makeWmContent('## Attention Queue\n\n- HIGH: Review PR #42 by end of day'),
    );

    _setReflectionInvoker(async () => 'Reviewed attention queue. Nothing urgent.');

    const result = await runHeartbeat();
    expect(result.phase).toBe('reflect');
    expect(result.reflectResult).toBeDefined();
    expect(result.reflectResult!.response).toContain('Nothing urgent');
  });

  it('never throws — catches errors gracefully', async () => {
    writeFileSync(
      join(tmpWm, 'attention-queue.md'),
      makeWmContent('## Attention Queue\n\n- HIGH: urgent item'),
    );

    _setReflectionInvoker(async () => {
      throw new Error('LLM exploded');
    });

    // Should not throw
    const result = await runHeartbeat();
    expect(result.phase).toBe('skip');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Lifecycle tests ──────────────────────────────────────────────────

describe('heartbeat lifecycle', () => {
  it('starts and stops cleanly', async () => {
    expect(_isHeartbeatRunning()).toBe(false);

    startReflectionHeartbeat();
    expect(_isHeartbeatRunning()).toBe(true);

    await stopReflectionHeartbeat();
    expect(_isHeartbeatRunning()).toBe(false);
  });

  it('warns when starting while already running', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    startReflectionHeartbeat();
    startReflectionHeartbeat(); // double start

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));

    warnSpy.mockRestore();
  });

  it('stop is idempotent', async () => {
    await stopReflectionHeartbeat();
    await stopReflectionHeartbeat();
    // Should not throw
  });
});

// ── Constants ────────────────────────────────────────────────────────

describe('constants', () => {
  it('REFLECTION_CHAT_ID is _reflection', () => {
    expect(REFLECTION_CHAT_ID).toBe('_reflection');
  });
});
