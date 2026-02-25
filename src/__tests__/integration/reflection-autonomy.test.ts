import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setMemoryDir, _setWorkingMemoryDir, serializeMemoryFile } from '../../memory.js';
import type { MemoryFrontmatter } from '../../memory.js';
import {
  gather,
  decide,
  reflect,
  _setReflectionInvoker,
  _setLastReflectionTime,
  type GatherResult,
} from '../../reflection.js';
import { createTestWorkspace, seedTrustState } from '../helpers/test-workspace.js';
import type { TestWorkspace } from '../helpers/test-workspace.js';

const tmpWm = join(tmpdir(), 'titus-test-intg-reflection-wm');
const tmpMem = join(tmpdir(), 'titus-test-intg-reflection-mem');

function makeWmContent(body: string): string {
  const fm: MemoryFrontmatter = {
    created: '2026-02-23T00:00:00Z',
    updated: '2026-02-23T00:00:00Z',
    version: 1,
    type: 'working-memory',
    tags: ['working-memory'],
  };
  return serializeMemoryFile(fm, body);
}

/** Builds a GatherResult with autonomy defaults */
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

// ---------------------------------------------------------------------------
// Integration: gather returns trust and proposal data
// ---------------------------------------------------------------------------

describe('integration: gather includes trust state', () => {
  it('gather returns trustSummary and trustScore', async () => {
    const result = await gather();

    expect(result).toHaveProperty('trustSummary');
    expect(result).toHaveProperty('trustScore');
    expect(typeof result.trustSummary).toBe('string');
    expect(typeof result.trustScore).toBe('number');
    expect(result.trustScore).toBeGreaterThanOrEqual(0);
    expect(result.trustScore).toBeLessThanOrEqual(1);
  });

  it('gather returns pendingProposalCount', async () => {
    const result = await gather();

    expect(result).toHaveProperty('pendingProposalCount');
    expect(typeof result.pendingProposalCount).toBe('number');
    expect(result.pendingProposalCount).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: decide triggers on pending proposals
// ---------------------------------------------------------------------------

describe('integration: decide triggers on proposals', () => {
  it('returns shouldReflect=true when pendingProposalCount > 0', () => {
    const gatherResult = makeGatherResult({ pendingProposalCount: 2 });

    const result = decide(gatherResult);
    expect(result.shouldReflect).toBe(true);
    expect(result.reason).toContain('pending proposals');
  });

  it('returns shouldReflect=false when no proposals and nothing else triggers', () => {
    const gatherResult = makeGatherResult({ pendingProposalCount: 0 });

    const result = decide(gatherResult);
    expect(result.shouldReflect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: reflection prompt includes autonomy context
// ---------------------------------------------------------------------------

describe('integration: reflection prompt includes autonomy context', () => {
  it('prompt contains Autonomy State section with trust summary', async () => {
    let capturedPrompt = '';
    _setReflectionInvoker(async (prompt) => {
      capturedPrompt = prompt;
      return 'Nothing requires attention.';
    });

    const gatherResult = makeGatherResult({
      hasAttentionItems: true,
      trustSummary: '## Autonomy Trust State\n\nOverall trust score: 0.65\nAllowed tiers: autonomous, propose',
      pendingProposalCount: 1,
      trustScore: 0.65,
    });

    await reflect(gatherResult);

    expect(capturedPrompt).toContain('Autonomy State');
    expect(capturedPrompt).toContain('Overall trust score: 0.65');
    expect(capturedPrompt).toContain('autonomous, propose');
    expect(capturedPrompt).toContain('Pending proposals: 1');
  });

  it('prompt contains freeze notice when trust is frozen', async () => {
    let capturedPrompt = '';
    _setReflectionInvoker(async (prompt) => {
      capturedPrompt = prompt;
      return 'Nothing requires attention.';
    });

    const gatherResult = makeGatherResult({
      hasAttentionItems: true,
      trustSummary: '## Autonomy Trust State\n\nOverall trust score: 0.1\nAllowed tiers: autonomous\n\nScope frozen: critical failure detected on 2026-02-23. Freeze lifts after 14 days of recovery.',
      pendingProposalCount: 0,
      trustScore: 0.1,
    });

    await reflect(gatherResult);

    expect(capturedPrompt).toContain('Scope frozen');
    expect(capturedPrompt).toContain('critical failure');
  });
});

// ---------------------------------------------------------------------------
// Integration: full gather -> decide -> reflect with trust context
// ---------------------------------------------------------------------------

describe('integration: full gather-decide-reflect with trust', () => {
  it('gather result flows through decide and reflect without error', async () => {
    writeFileSync(
      join(tmpWm, 'attention-queue.md'),
      makeWmContent('## Attention Queue\n\n- HIGH: Review deployment status'),
    );

    _setReflectionInvoker(async () => 'Reviewed attention queue. Nothing urgent now.');

    const gatherResult = await gather();
    expect(gatherResult.hasAttentionItems).toBe(true);
    expect(gatherResult.trustSummary).toBeDefined();

    const decideResult = decide(gatherResult);
    expect(decideResult.shouldReflect).toBe(true);

    const reflectResult = await reflect(gatherResult);
    expect(reflectResult.response).toContain('Nothing urgent');
  });
});
