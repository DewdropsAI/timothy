import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorkspace, seedTrustState } from '../helpers/test-workspace.js';
import type { TestWorkspace } from '../helpers/test-workspace.js';

// ---------------------------------------------------------------------------
// Integration: trust signal engagement — scope widens, narrows, freezes
// ---------------------------------------------------------------------------

describe('integration: trust signal engagement', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('positive signals widen scope from autonomous to propose', async () => {
    const { TrustManager } = await import('../../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.3 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    const scopeBefore = manager.evaluateScope();
    expect(scopeBefore.allowedTiers).toEqual(['autonomous']);

    // Push score above 0.4 threshold
    for (let i = 0; i < 3; i++) {
      manager.recordSignal({ type: 'positive', value: 0.05, source: 'test-success' });
    }

    const scopeAfter = manager.evaluateScope();
    expect(scopeAfter.allowedTiers).toContain('propose');
  });

  it('positive signals widen scope from propose to restricted', async () => {
    const { TrustManager } = await import('../../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.6 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    const scopeBefore = manager.evaluateScope();
    expect(scopeBefore.allowedTiers).not.toContain('restricted');

    // Push score above 0.7 threshold
    for (let i = 0; i < 5; i++) {
      manager.recordSignal({ type: 'positive', value: 0.05, source: 'test-success' });
    }

    const scopeAfter = manager.evaluateScope();
    expect(scopeAfter.allowedTiers).toContain('restricted');
  });

  it('negative signals narrow scope from restricted to autonomous', async () => {
    const { TrustManager } = await import('../../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.8 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    const scopeBefore = manager.evaluateScope();
    expect(scopeBefore.allowedTiers).toContain('restricted');

    // Hammer trust down below 0.4
    for (let i = 0; i < 10; i++) {
      manager.recordSignal({ type: 'negative', value: 0.05, source: 'test-failure' });
    }

    const scopeAfter = manager.evaluateScope();
    expect(scopeAfter.allowedTiers).toEqual(['autonomous']);
  });

  it('critical failure freezes scope and blocks widening', async () => {
    const { TrustManager } = await import('../../autonomy/trust-metrics.js');

    seedTrustState(ws.path, { trustScore: 0.8 });

    const manager = new TrustManager(ws.path);
    await manager.load();

    // High score should have wide scope
    expect(manager.evaluateScope().allowedTiers).toContain('restricted');

    // Critical failure
    manager.recordCriticalFailure('unauthorized message sent');

    // Immediately restricted
    expect(manager.getScore()).toBe(0.1);
    expect(manager.evaluateScope().allowedTiers).toEqual(['autonomous']);
    expect(manager.isFrozen()).toBe(true);

    // Positive signals raise score but don't widen scope
    for (let i = 0; i < 15; i++) {
      manager.recordSignal({ type: 'positive', value: 0.05, source: 'recovery' });
    }

    expect(manager.getScore()).toBeGreaterThan(0.5);
    expect(manager.evaluateScope().allowedTiers).toEqual(['autonomous']);
  });

  it('critical failure freeze persists across save/load', async () => {
    const { TrustManager } = await import('../../autonomy/trust-metrics.js');

    const manager1 = new TrustManager(ws.path);
    await manager1.load();
    manager1.recordCriticalFailure('data corruption');
    await manager1.save();

    // Load in a fresh manager
    const manager2 = new TrustManager(ws.path);
    await manager2.load();

    expect(manager2.isFrozen()).toBe(true);
    expect(manager2.getScore()).toBe(0.1);
    expect(manager2.evaluateScope().allowedTiers).toEqual(['autonomous']);
  });

  it('signal history is bounded by window size', async () => {
    const { TrustManager } = await import('../../autonomy/trust-metrics.js');

    const manager = new TrustManager(ws.path);
    await manager.load();

    // Record 100+ signals (window size is 50)
    for (let i = 0; i < 100; i++) {
      manager.recordSignal({ type: 'positive', value: 0.001, source: `signal-${i}` });
    }

    const history = manager.getSignalHistory();
    expect(history.length).toBeLessThanOrEqual(50);
    // Most recent signal should be the last one we recorded
    expect(history[history.length - 1].source).toBe('signal-99');
  });

  it('freeze lifts after 14 days and scope resumes normal calculation', async () => {
    const { TrustManager } = await import('../../autonomy/trust-metrics.js');

    const manager = new TrustManager(ws.path);
    await manager.load();

    manager.recordCriticalFailure('incident');

    // Simulate passage of 15 days
    const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + fifteenDaysMs);

    expect(manager.isFrozen()).toBe(false);

    // Pump score up high with positive signals
    for (let i = 0; i < 20; i++) {
      manager.recordSignal({ type: 'positive', value: 0.05, source: 'recovery' });
    }

    // Score should be high enough for wide scope
    expect(manager.getScore()).toBeGreaterThan(0.7);
    expect(manager.evaluateScope().allowedTiers).toContain('restricted');

    vi.restoreAllMocks();
  });
});
