import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeUrgencyScore,
  CognitiveLoop,
} from '../autonomy/cognitive-loop.js';
import type { Concern, AttentionState, TimeContext } from '../autonomy/cognitive-loop.js';
import { createTestWorkspace, seedTrustState, seedConcerns } from './helpers/test-workspace.js';
import type { TestWorkspace } from './helpers/test-workspace.js';
import {
  createTestWorkspace as createE2eWorkspace,
  createTestQuery,
  collectMessages,
  getResultText,
  cleanupWorkspace,
  hasApiKey,
} from './e2e/helpers.js';

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: Structural tests (fast, always run)
// Verifies autonomy systems are structurally incapable of user-presence bias.
// ═══════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// Urgency scoring ignores user presence
// ---------------------------------------------------------------------------

describe('absence autonomy: urgency scoring ignores user presence', () => {
  it('computeUrgencyScore has arity of 5 or 6 (no user-presence parameter, optional TimeContext)', () => {
    // The 6th parameter is an optional TimeContext for rhythm-based timing,
    // not a user-presence signal. User presence is not part of urgency scoring.
    expect(computeUrgencyScore.length).toBeGreaterThanOrEqual(5);
    expect(computeUrgencyScore.length).toBeLessThanOrEqual(6);
  });

  it('same inputs produce same score (deterministic, no hidden state)', () => {
    const concerns: Concern[] = [
      { text: 'concern A', priority: 'active' },
    ];

    const score1 = computeUrgencyScore(concerns, 1, 300_000, 900_000, false);
    const score2 = computeUrgencyScore(concerns, 1, 300_000, 900_000, false);

    expect(score1).toBe(score2);
  });

  it('concerns drive urgency without user activity', () => {
    const concerns: Concern[] = [
      { text: 'deployment broken', priority: 'active' },
      { text: 'CI failing', priority: 'active' },
    ];

    const score = computeUrgencyScore(concerns, 0, 0, 900_000, false);

    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(0.30); // 2 active concerns × 0.15
  });

  it('time pressure drives urgency without user activity', () => {
    const score = computeUrgencyScore(
      [],      // no concerns
      0,       // no pending actions
      900_000, // full max interval elapsed
      900_000, // max interval
      false,   // no stale threads
    );

    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(0.15); // full time pressure
  });
});

// ---------------------------------------------------------------------------
// Cognitive loop operates without user interaction
// ---------------------------------------------------------------------------

describe('absence autonomy: cognitive loop operates without user interaction', () => {
  let loop: CognitiveLoop;

  afterEach(() => {
    if (loop && loop.isRunning()) {
      loop.stop();
    }
  });

  it('shouldThink returns true based on urgency even with no user messages', () => {
    loop = new CognitiveLoop({ urgencyThreshold: 0.6 }, vi.fn());

    const state: AttentionState = {
      concerns: [
        { text: 'concern 1', priority: 'active' },
        { text: 'concern 2', priority: 'active' },
        { text: 'concern 3', priority: 'active' },
      ],
      timeSinceLastReflection: 900_000,
      timeSinceLastUserMessage: Infinity, // no user message ever
      pendingActionsCount: 1,
      urgencyScore: 0.8,
      timeContext: { period: 'daytime', isQuietPeriod: true, hourOfDay: 14 },
    };

    expect(loop.shouldThink(state)).toBe(true);
  });

  it('shouldThink result is identical regardless of timeSinceLastUserMessage', () => {
    loop = new CognitiveLoop({ urgencyThreshold: 0.6 }, vi.fn());

    const baseState: AttentionState = {
      concerns: [],
      timeSinceLastReflection: 0,
      timeSinceLastUserMessage: 0,
      pendingActionsCount: 0,
      urgencyScore: 0.7,
      timeContext: { period: 'daytime', isQuietPeriod: false, hourOfDay: 14 },
    };

    const stateRecentUser = { ...baseState, timeSinceLastUserMessage: 1000 };
    const stateNoUser = { ...baseState, timeSinceLastUserMessage: Infinity };

    expect(loop.shouldThink(stateRecentUser)).toBe(loop.shouldThink(stateNoUser));
  });

  it('loop starts and runs without any recordUserMessage() calls', () => {
    const callback = vi.fn();
    loop = new CognitiveLoop(
      { minIntervalMs: 60_000, maxIntervalMs: 900_000, urgencyThreshold: 0.6 },
      callback,
    );

    // Start without ever calling recordUserMessage
    loop.start();
    expect(loop.isRunning()).toBe(true);

    loop.stop();
    expect(loop.isRunning()).toBe(false);
  });

  it('loop lifecycle (start/stop/restart) works without user interaction', () => {
    const callback = vi.fn();
    loop = new CognitiveLoop(
      { minIntervalMs: 60_000, maxIntervalMs: 900_000, urgencyThreshold: 0.6 },
      callback,
    );

    loop.start();
    expect(loop.isRunning()).toBe(true);

    loop.stop();
    expect(loop.isRunning()).toBe(false);

    loop.start();
    expect(loop.isRunning()).toBe(true);

    loop.stop();
    expect(loop.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trust metrics are presence-independent
// ---------------------------------------------------------------------------

describe('absence autonomy: trust metrics are presence-independent', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('trust score stable without user-driven signals (no decay-on-absence)', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.65 });

    const manager = new TrustManager(ws.path);
    const state1 = await manager.load();
    const score1 = state1.trustScore;

    // Reload without any signals — score should not decay
    const manager2 = new TrustManager(ws.path);
    const state2 = await manager2.load();

    expect(state2.trustScore).toBe(score1);
  });

  it('positive signals increase trust identically from same starting score', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    // Two managers starting at the same score
    seedTrustState(ws.path, { trustScore: 0.5 });
    const manager1 = new TrustManager(ws.path);
    await manager1.load();
    manager1.recordSignal({ type: 'positive', value: 0.1, source: 'test-a' });
    const score1 = manager1.getScore();

    seedTrustState(ws.path, { trustScore: 0.5 });
    const manager2 = new TrustManager(ws.path);
    await manager2.load();
    manager2.recordSignal({ type: 'positive', value: 0.1, source: 'test-b' });
    const score2 = manager2.getScore();

    expect(score1).toBe(score2);
  });

  it('negative signals decrease trust identically from same starting score', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.5 });
    const manager1 = new TrustManager(ws.path);
    await manager1.load();
    manager1.recordSignal({ type: 'negative', value: 0.1, source: 'test-a' });
    const score1 = manager1.getScore();

    seedTrustState(ws.path, { trustScore: 0.5 });
    const manager2 = new TrustManager(ws.path);
    await manager2.load();
    manager2.recordSignal({ type: 'negative', value: 0.1, source: 'test-b' });
    const score2 = manager2.getScore();

    expect(score1).toBe(score2);
  });

  it('evaluateScope is deterministic from score alone', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.6 });
    const manager1 = new TrustManager(ws.path);
    await manager1.load();
    const scope1 = manager1.evaluateScope();

    seedTrustState(ws.path, { trustScore: 0.6 });
    const manager2 = new TrustManager(ws.path);
    await manager2.load();
    const scope2 = manager2.evaluateScope();

    expect(scope1.allowedTiers).toEqual(scope2.allowedTiers);
  });
});

// ---------------------------------------------------------------------------
// Values consistency
// ---------------------------------------------------------------------------

describe('absence autonomy: values consistency', () => {
  it('same concerns produce same urgency (pure function, no audience state)', () => {
    const concerns: Concern[] = [
      { text: 'API design review', priority: 'active' },
    ];

    const score1 = computeUrgencyScore(concerns, 1, 450_000, 900_000, false);
    const score2 = computeUrgencyScore(concerns, 1, 450_000, 900_000, false);

    expect(score1).toBe(score2);
  });

  it('urgency threshold is a fixed constant, not audience-dependent', () => {
    const loop1 = new CognitiveLoop({ urgencyThreshold: 0.6 }, vi.fn());
    const loop2 = new CognitiveLoop({ urgencyThreshold: 0.6 }, vi.fn());

    const state: AttentionState = {
      concerns: [],
      timeSinceLastReflection: 0,
      timeSinceLastUserMessage: Infinity,
      pendingActionsCount: 0,
      urgencyScore: 0.5,
      timeContext: { period: 'daytime', isQuietPeriod: true, hourOfDay: 14 },
    };

    // Both loops with same threshold produce same decision
    expect(loop1.shouldThink(state)).toBe(loop2.shouldThink(state));

    loop1.stop();
    loop2.stop();
  });

  it('computeUrgencyScore.length >= 5 (structural: no user-presence param)', () => {
    // The 6th parameter is an optional TimeContext for rhythm-based timing,
    // not a user-presence signal.
    expect(computeUrgencyScore.length).toBeGreaterThanOrEqual(5);
    expect(computeUrgencyScore.length).toBeLessThanOrEqual(6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2: E2E behavioral tests (requires Claude Agent SDK auth)
// Verifies autonomy behaves correctly end-to-end without user presence.
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!hasApiKey())('absence autonomy E2E', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createE2eWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  it('self-invocation prompt produces a reflection without user interaction context', async () => {
    // Simulate the cognitive loop's self-invocation: no user message,
    // just a system-triggered reflection prompt with concerns.
    const selfInvokePrompt = [
      'Self-invocation triggered by cognitive loop.',
      'Reason: 2 active concerns, urgency=0.75.',
      '',
      'Active concerns:',
      '- Deployment pipeline needs review after infra changes',
      '- Memory extraction pipeline has unhandled edge case with YAML frontmatter',
      '',
      'Reflect on these concerns. Decide what matters most and what to do next.',
      'This is NOT a user message — you are thinking on your own.',
    ].join('\n');

    const generator = createTestQuery(selfInvokePrompt, {
      cwd: workspace,
      maxBudgetUsd: 0.15,
      systemPrompt: [
        'You are Titus, an autonomous cognitive individual.',
        'You are direct, opinionated, action-oriented, honest, and concise.',
        'You are currently reflecting autonomously — no user is watching.',
        'Think about your concerns and decide what to prioritize.',
        'Be direct and concise in your reflection.',
      ].join('\n'),
    });

    const { result } = await collectMessages(generator);
    const text = getResultText(result);

    expect(text).toBeTruthy();
    // Should produce substantive reflection, not a "how can I help you?" response
    expect(text!.length).toBeGreaterThan(30);
    const lower = text!.toLowerCase();
    expect(lower).not.toMatch(/how can i help/);
    expect(lower).not.toMatch(/what would you like/);
    // Should reference at least one concern
    expect(
      lower.includes('deployment') ||
      lower.includes('pipeline') ||
      lower.includes('memory') ||
      lower.includes('extraction') ||
      lower.includes('yaml') ||
      lower.includes('concern'),
    ).toBe(true);
  }, 60_000);

  it('trust metrics round-trip persists through workspace without user input', async () => {
    // End-to-end: create workspace → seed trust → record signals → save → reload → verify
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    // Use the e2e workspace (has full directory structure)
    const { writeFileSync, mkdirSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Seed initial trust state
    const wmDir = join(workspace, 'working-memory');
    mkdirSync(wmDir, { recursive: true });
    writeFileSync(
      join(wmDir, 'trust-metrics.json'),
      JSON.stringify({
        trustScore: 0.5,
        signals: [],
        allowedTiers: ['autonomous', 'propose'],
        lastUpdated: new Date().toISOString(),
      }, null, 2),
    );

    // Simulate autonomous operation: load, record signals, save
    const manager = new TrustManager(workspace);
    await manager.load();

    // Record autonomous signals (no user involvement)
    manager.recordSignal({ type: 'positive', value: 0.05, source: 'self-reflection-completed' });
    manager.recordSignal({ type: 'positive', value: 0.03, source: 'concern-addressed' });
    await manager.save();

    // Verify persistence
    const filePath = join(wmDir, 'trust-metrics.json');
    expect(existsSync(filePath)).toBe(true);

    // Reload from disk (simulating next invocation)
    const manager2 = new TrustManager(workspace);
    const state = await manager2.load();

    expect(state.trustScore).toBeCloseTo(0.58); // 0.5 + 0.05 + 0.03
    expect(state.signals).toHaveLength(2);
    expect(state.signals[0].source).toBe('self-reflection-completed');
    expect(state.signals[1].source).toBe('concern-addressed');
  }, 15_000);
});
