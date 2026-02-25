import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setMemoryDir, _setWorkingMemoryDir, serializeMemoryFile } from '../memory.js';
import type { MemoryFrontmatter } from '../memory.js';
import {
  REFLECTION_SYSTEM_PROMPT,
  reflect,
  _setReflectionInvoker,
  _setLastReflectionTime,
  type GatherResult,
} from '../reflection.js';

const tmpWm = join(tmpdir(), 'timothy-test-reflection-prompt-wm');
const tmpMem = join(tmpdir(), 'timothy-test-reflection-prompt-mem');

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
    created: '2026-02-25T00:00:00Z',
    updated: '2026-02-25T00:00:00Z',
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

afterEach(() => {
  _setReflectionInvoker(null);
  _setLastReflectionTime(0);
  rmSync(tmpWm, { recursive: true, force: true });
  rmSync(tmpMem, { recursive: true, force: true });
});

// ── REFLECTION_SYSTEM_PROMPT content tests ────────────────────────────

describe('REFLECTION_SYSTEM_PROMPT self-revision content', () => {
  it('contains the self-revision step', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Self-revision');
  });

  it('encourages letting things go', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Let it go');
  });

  it('frames changing your mind as good judgment', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Changing your mind');
  });

  it('asks about stale concerns', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('concerns are stale');
  });

  it('asks about revising conclusions', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('What conclusions should I revise');
  });

  it('asks about reordering priorities', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('priorities need reordering');
  });

  it('warns against rigidity', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('rigidity');
  });

  it('instructs to persist revisions via writeback', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('persist the change');
  });

  it('explains how to remove stale concerns', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('remove a stale concern');
    expect(REFLECTION_SYSTEM_PROMPT).toContain('action: update');
  });

  it('asks about Chris\'s behavior', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Chris\'s behavior');
  });

  it('retains original reflection steps', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Review your attention queue');
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Review pending actions');
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Review active threads');
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Review your autonomy trust state');
    expect(REFLECTION_SYSTEM_PROMPT).toContain('Review pending proposals');
  });

  it('retains writeback directive format', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('<!--timothy-write');
  });

  it('retains proactive message format', () => {
    expect(REFLECTION_SYSTEM_PROMPT).toContain('<!--timothy-proactive');
  });
});

// ── Time context in reflect() ─────────────────────────────────────────

describe('reflect() time context', () => {
  it('includes Time Context section in the prompt', async () => {
    let capturedPrompt = '';
    _setReflectionInvoker(async (prompt) => {
      capturedPrompt = prompt;
      return 'Nothing requires attention.';
    });

    const gatherResult = makeGatherResult({ hasAttentionItems: true });
    await reflect(gatherResult);

    expect(capturedPrompt).toContain('## Time Context');
    expect(capturedPrompt).toContain('Current time:');
    expect(capturedPrompt).toContain('Period:');
  });

  it('includes a recognized period value', async () => {
    let capturedPrompt = '';
    _setReflectionInvoker(async (prompt) => {
      capturedPrompt = prompt;
      return 'Nothing requires attention.';
    });

    const gatherResult = makeGatherResult({ hasAttentionItems: true });
    await reflect(gatherResult);

    // The period must be one of the four defined values
    const periodMatch = capturedPrompt.match(/Period: (morning|daytime|evening|night)/);
    expect(periodMatch).not.toBeNull();
  });

  it('time context appears after autonomy state', async () => {
    let capturedPrompt = '';
    _setReflectionInvoker(async (prompt) => {
      capturedPrompt = prompt;
      return 'Nothing requires attention.';
    });

    const gatherResult = makeGatherResult({
      hasAttentionItems: true,
      trustSummary: 'Trust score: 0.8',
      pendingProposalCount: 1,
    });

    await reflect(gatherResult);

    const autonomyIdx = capturedPrompt.indexOf('## Autonomy State');
    const timeIdx = capturedPrompt.indexOf('## Time Context');
    expect(autonomyIdx).toBeGreaterThan(-1);
    expect(timeIdx).toBeGreaterThan(-1);
    expect(timeIdx).toBeGreaterThan(autonomyIdx);
  });
});
