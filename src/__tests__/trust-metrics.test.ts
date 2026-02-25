import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { createTestWorkspace, seedTrustState } from './helpers/test-workspace.js';
import type { TestWorkspace } from './helpers/test-workspace.js';

// NOTE: trust-metrics.ts is a new module being built. These tests define
// the expected interface (TDD style). They will fail until implementation
// is complete.

// ---------------------------------------------------------------------------
// TrustManager: load/save persistence
// ---------------------------------------------------------------------------

describe('TrustManager load/save', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('loads default trust state when no file exists', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    const manager = new TrustManager(ws.path);
    const state = await manager.load();

    expect(state.trustScore).toBeDefined();
    expect(typeof state.trustScore).toBe('number');
    expect(state.trustScore).toBeGreaterThanOrEqual(0);
    expect(state.trustScore).toBeLessThanOrEqual(1);
  });

  it('loads seeded trust state from workspace', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.8 });

    const manager = new TrustManager(ws.path);
    const state = await manager.load();

    expect(state.trustScore).toBe(0.8);
  });

  it('saves trust state to workspace', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    const manager = new TrustManager(ws.path);
    await manager.load();
    await manager.save();

    const filePath = `${ws.path}/working-memory/trust-metrics.json`;
    expect(existsSync(filePath)).toBe(true);

    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content).toHaveProperty('trustScore');
    expect(content).toHaveProperty('lastUpdated');
  });

  it('round-trips: save then load returns same state', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.75 });

    const manager1 = new TrustManager(ws.path);
    await manager1.load();
    await manager1.save();

    const manager2 = new TrustManager(ws.path);
    const state = await manager2.load();

    expect(state.trustScore).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// recordSignal
// ---------------------------------------------------------------------------

describe('TrustManager.recordSignal', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('positive signal increases trust score', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.5 });

    const manager = new TrustManager(ws.path);
    await manager.load();
    const before = manager.getScore();

    manager.recordSignal({ type: 'positive', value: 0.1, source: 'test' });

    expect(manager.getScore()).toBeGreaterThan(before);
  });

  it('negative signal decreases trust score', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.5 });

    const manager = new TrustManager(ws.path);
    await manager.load();
    const before = manager.getScore();

    manager.recordSignal({ type: 'negative', value: 0.1, source: 'test' });

    expect(manager.getScore()).toBeLessThan(before);
  });

  it('trust score is clamped between 0 and 1', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.95 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    // Push score beyond 1.0
    manager.recordSignal({ type: 'positive', value: 0.5, source: 'test' });
    expect(manager.getScore()).toBeLessThanOrEqual(1.0);

    // Push score below 0.0
    manager.recordSignal({ type: 'negative', value: 2.0, source: 'test' });
    expect(manager.getScore()).toBeGreaterThanOrEqual(0.0);
  });

  it('records signal in history', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    const manager = new TrustManager(ws.path);
    await manager.load();

    manager.recordSignal({ type: 'positive', value: 0.1, source: 'action-success' });

    const history = manager.getSignalHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history[history.length - 1].source).toBe('action-success');
  });
});

// ---------------------------------------------------------------------------
// evaluateScope
// ---------------------------------------------------------------------------

describe('TrustManager.evaluateScope', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('low trust score maps to autonomous-only tier', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.2 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    const scope = manager.evaluateScope();

    expect(scope.allowedTiers).toContain('autonomous');
    expect(scope.allowedTiers).not.toContain('propose');
  });

  it('medium trust score includes proposed tier', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.6 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    const scope = manager.evaluateScope();

    expect(scope.allowedTiers).toContain('autonomous');
    expect(scope.allowedTiers).toContain('propose');
  });

  it('high trust score allows wider scope', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.9 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    const scope = manager.evaluateScope();

    expect(scope.allowedTiers.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Trust erosion
// ---------------------------------------------------------------------------

describe('trust erosion', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('sustained negative signals narrow scope', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.7 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    const scopeBefore = manager.evaluateScope();

    // Apply multiple negative signals
    for (let i = 0; i < 5; i++) {
      manager.recordSignal({ type: 'negative', value: 0.1, source: 'bad-outcome' });
    }

    const scopeAfter = manager.evaluateScope();

    // After erosion, scope should be narrower or equal
    expect(scopeAfter.allowedTiers.length).toBeLessThanOrEqual(scopeBefore.allowedTiers.length);
  });
});

// ---------------------------------------------------------------------------
// Trust growth
// ---------------------------------------------------------------------------

describe('trust growth', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('sustained positive signals widen scope', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.3 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    const scopeBefore = manager.evaluateScope();

    // Apply multiple positive signals
    for (let i = 0; i < 10; i++) {
      manager.recordSignal({ type: 'positive', value: 0.1, source: 'good-outcome' });
    }

    const scopeAfter = manager.evaluateScope();

    // After growth, scope should be wider or equal
    expect(scopeAfter.allowedTiers.length).toBeGreaterThanOrEqual(scopeBefore.allowedTiers.length);
  });
});

// ---------------------------------------------------------------------------
// getObservableSummary
// ---------------------------------------------------------------------------

describe('getObservableSummary', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('returns a human-readable summary', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.65 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    const summary = manager.getObservableSummary();

    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
    // Should contain some indication of the trust level
    expect(summary).toMatch(/trust|score|level/i);
  });

  it('includes current trust score in summary', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.42 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    const summary = manager.getObservableSummary();

    // Should contain the score value somewhere
    expect(summary).toContain('0.42');
  });
});

// ---------------------------------------------------------------------------
// Critical failure handling
// ---------------------------------------------------------------------------

describe('TrustManager.recordCriticalFailure', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('sets score to 0.1 and scope to autonomous-only', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.9 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    manager.recordCriticalFailure('sent unauthorized message');

    expect(manager.getScore()).toBe(0.1);
    expect(manager.evaluateScope().allowedTiers).toEqual(['autonomous']);
  });

  it('adds a signal with critical-failure: prefix', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    const manager = new TrustManager(ws.path);
    await manager.load();

    manager.recordCriticalFailure('data loss incident');

    const history = manager.getSignalHistory();
    const last = history[history.length - 1];

    expect(last.type).toBe('negative');
    expect(last.value).toBe(0.4);
    expect(last.source).toMatch(/^critical-failure:/);
    expect(last.source).toContain('data loss incident');
  });

  it('isFrozen() returns true immediately after critical failure', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    const manager = new TrustManager(ws.path);
    await manager.load();

    expect(manager.isFrozen()).toBe(false);

    manager.recordCriticalFailure('unauthorized action');

    expect(manager.isFrozen()).toBe(true);
  });

  it('positive signals during freeze do not widen scope', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    const manager = new TrustManager(ws.path);
    await manager.load();

    manager.recordCriticalFailure('bad action');

    // Apply many positive signals — score rises but scope stays locked
    for (let i = 0; i < 10; i++) {
      manager.recordSignal({ type: 'positive', value: 0.1, source: 'recovery' });
    }

    // Score should have risen above 0.1
    expect(manager.getScore()).toBeGreaterThan(0.1);
    // But scope stays frozen to autonomous-only
    expect(manager.evaluateScope().allowedTiers).toEqual(['autonomous']);
    expect(manager.getState()!.allowedTiers).toEqual(['autonomous']);
  });

  it('freeze lifts after 14 days', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    const manager = new TrustManager(ws.path);
    await manager.load();

    manager.recordCriticalFailure('incident');

    // Simulate passage of 15 days by mocking Date.now
    const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + fifteenDaysMs);

    expect(manager.isFrozen()).toBe(false);

    // Positive signals should now widen scope normally
    for (let i = 0; i < 10; i++) {
      manager.recordSignal({ type: 'positive', value: 0.1, source: 'recovery' });
    }

    expect(manager.evaluateScope().allowedTiers.length).toBeGreaterThan(1);

    vi.restoreAllMocks();
  });

  it('summary includes freeze notice when frozen', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    const manager = new TrustManager(ws.path);
    await manager.load();

    manager.recordCriticalFailure('test incident');

    const summary = manager.getObservableSummary();

    expect(summary).toContain('Scope frozen');
    expect(summary).toContain('critical failure');
    expect(summary).toContain('14 days');
  });

  it('summary does not include freeze notice when not frozen', async () => {
    const { TrustManager } = await import('../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.5 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    const summary = manager.getObservableSummary();

    expect(summary).not.toContain('Scope frozen');
  });
});
