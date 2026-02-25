import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  _setStateFilePath,
  loadState,
  saveState,
  recordOutcome,
  getEngagementProfile,
  shouldSuppress,
  listTrackedBehaviors,
  explainAdaptation,
  resetBehavior,
  LOW_ENGAGEMENT_THRESHOLD,
  REJECTION_DISABLE_THRESHOLD,
  MAX_OUTCOME_RECORDS,
} from '../engagement.js';
import type { EngagementState, Outcome } from '../engagement.js';

const tmpDir = join(tmpdir(), 'titus-test-engagement');
const stateFile = join(tmpDir, 'engagement-state.json');

function cleanup(): void {
  rmSync(tmpDir, { recursive: true, force: true });
}

describe('engagement state persistence', () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(tmpDir, { recursive: true });
    _setStateFilePath(stateFile);
  });

  afterEach(cleanup);

  it('loadState returns empty state when file does not exist', () => {
    const state = loadState();
    expect(state.outcomes).toEqual([]);
  });

  it('loadState returns empty state when file is malformed JSON', () => {
    mkdirSync(tmpDir, { recursive: true });
    require('node:fs').writeFileSync(stateFile, 'not json');
    const state = loadState();
    expect(state.outcomes).toEqual([]);
  });

  it('loadState returns empty state when JSON lacks outcomes array', () => {
    require('node:fs').writeFileSync(stateFile, '{"foo": "bar"}');
    const state = loadState();
    expect(state.outcomes).toEqual([]);
  });

  it('saveState writes valid JSON to disk atomically', () => {
    const state: EngagementState = {
      outcomes: [
        {
          messageId: 'msg-1',
          behaviorType: 'stale-thread-follow-up',
          outcome: 'engaged',
          timestamp: '2026-02-22T00:00:00Z',
        },
      ],
    };
    saveState(state);

    expect(existsSync(stateFile)).toBe(true);
    expect(existsSync(stateFile + '.tmp')).toBe(false);

    const raw = readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.outcomes).toHaveLength(1);
    expect(parsed.outcomes[0].messageId).toBe('msg-1');
  });

  it('saveState creates parent directories if missing', () => {
    const nested = join(tmpDir, 'deep', 'nested', 'state.json');
    _setStateFilePath(nested);
    saveState({ outcomes: [] });
    expect(existsSync(nested)).toBe(true);
  });

  it('saveState + loadState round-trip preserves data', () => {
    const state: EngagementState = {
      outcomes: [
        {
          messageId: 'msg-1',
          behaviorType: 'follow-up',
          outcome: 'ignored',
          timestamp: '2026-02-22T01:00:00Z',
        },
        {
          messageId: 'msg-2',
          behaviorType: 'follow-up',
          outcome: 'engaged',
          timestamp: '2026-02-22T02:00:00Z',
        },
      ],
    };
    saveState(state);
    const loaded = loadState();
    expect(loaded).toEqual(state);
  });
});

describe('recordOutcome', () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(tmpDir, { recursive: true });
    _setStateFilePath(stateFile);
  });

  afterEach(cleanup);

  it('appends an outcome to the state file', () => {
    recordOutcome('msg-1', 'stale-thread-follow-up', 'engaged');

    const state = loadState();
    expect(state.outcomes).toHaveLength(1);
    expect(state.outcomes[0].messageId).toBe('msg-1');
    expect(state.outcomes[0].behaviorType).toBe('stale-thread-follow-up');
    expect(state.outcomes[0].outcome).toBe('engaged');
    expect(state.outcomes[0].timestamp).toBeTruthy();
  });

  it('appends multiple outcomes sequentially', () => {
    recordOutcome('msg-1', 'follow-up', 'engaged');
    recordOutcome('msg-2', 'follow-up', 'ignored');
    recordOutcome('msg-3', 'check-in', 'rejected');

    const state = loadState();
    expect(state.outcomes).toHaveLength(3);
  });

  it('prunes oldest records when exceeding MAX_OUTCOME_RECORDS', () => {
    // Seed state with MAX_OUTCOME_RECORDS entries
    const state: EngagementState = { outcomes: [] };
    for (let i = 0; i < MAX_OUTCOME_RECORDS; i++) {
      state.outcomes.push({
        messageId: `old-${i}`,
        behaviorType: 'test',
        outcome: 'ignored',
        timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      });
    }
    saveState(state);

    // Record one more
    recordOutcome('new-msg', 'test', 'engaged');

    const loaded = loadState();
    expect(loaded.outcomes).toHaveLength(MAX_OUTCOME_RECORDS);
    // Oldest should have been pruned; newest should be present
    expect(loaded.outcomes[loaded.outcomes.length - 1].messageId).toBe('new-msg');
    expect(loaded.outcomes[0].messageId).toBe('old-1');
  });
});

describe('getEngagementProfile', () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(tmpDir, { recursive: true });
    _setStateFilePath(stateFile);
  });

  afterEach(cleanup);

  it('returns default profile (rate 1.0, not suppressed) for unknown behavior', () => {
    const profile = getEngagementProfile('nonexistent');
    expect(profile.total).toBe(0);
    expect(profile.engagementRate).toBe(1.0);
    expect(profile.suppressed).toBe(false);
    expect(profile.suppressionReason).toBeNull();
  });

  it('computes engagement rate as (engaged + acknowledged) / total', () => {
    recordOutcome('1', 'test', 'engaged');
    recordOutcome('2', 'test', 'acknowledged');
    recordOutcome('3', 'test', 'ignored');
    recordOutcome('4', 'test', 'ignored');

    const profile = getEngagementProfile('test');
    expect(profile.total).toBe(4);
    expect(profile.engaged).toBe(1);
    expect(profile.acknowledged).toBe(1);
    expect(profile.ignored).toBe(2);
    expect(profile.engagementRate).toBe(0.5);
  });

  it('tracks consecutive rejections from the end', () => {
    recordOutcome('1', 'test', 'engaged');
    recordOutcome('2', 'test', 'rejected');
    recordOutcome('3', 'test', 'rejected');

    const profile = getEngagementProfile('test');
    expect(profile.consecutiveRejections).toBe(2);
  });

  it('resets consecutive rejection count on non-rejection', () => {
    recordOutcome('1', 'test', 'rejected');
    recordOutcome('2', 'test', 'rejected');
    recordOutcome('3', 'test', 'engaged');
    recordOutcome('4', 'test', 'rejected');

    const profile = getEngagementProfile('test');
    expect(profile.consecutiveRejections).toBe(1);
  });

  it('isolates behavior types — different types have independent profiles', () => {
    recordOutcome('1', 'follow-up', 'engaged');
    recordOutcome('2', 'check-in', 'rejected');
    recordOutcome('3', 'check-in', 'rejected');

    const followUp = getEngagementProfile('follow-up');
    expect(followUp.total).toBe(1);
    expect(followUp.engaged).toBe(1);
    expect(followUp.suppressed).toBe(false);

    const checkIn = getEngagementProfile('check-in');
    expect(checkIn.total).toBe(2);
    expect(checkIn.rejected).toBe(2);
    expect(checkIn.suppressed).toBe(true);
  });
});

describe('shouldSuppress', () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(tmpDir, { recursive: true });
    _setStateFilePath(stateFile);
  });

  afterEach(cleanup);

  it('returns false for unknown behavior (no data)', () => {
    expect(shouldSuppress('unknown')).toBe(false);
  });

  it('returns false when engagement rate is above threshold', () => {
    recordOutcome('1', 'test', 'engaged');
    recordOutcome('2', 'test', 'engaged');
    recordOutcome('3', 'test', 'ignored');
    recordOutcome('4', 'test', 'engaged');
    recordOutcome('5', 'test', 'engaged');

    expect(shouldSuppress('test')).toBe(false);
  });

  it('returns true after 2+ consecutive rejections', () => {
    recordOutcome('1', 'test', 'engaged');
    recordOutcome('2', 'test', 'rejected');
    recordOutcome('3', 'test', 'rejected');

    expect(shouldSuppress('test')).toBe(true);
  });

  it('returns true when engagement rate drops below 20% with enough data', () => {
    // 1 engaged, 4 ignored = 20% — at boundary, not suppressed
    recordOutcome('1', 'test', 'engaged');
    recordOutcome('2', 'test', 'ignored');
    recordOutcome('3', 'test', 'ignored');
    recordOutcome('4', 'test', 'ignored');
    recordOutcome('5', 'test', 'ignored');

    // 1/5 = 20% — not below threshold
    expect(shouldSuppress('test')).toBe(false);

    // Add one more ignored to push below
    recordOutcome('6', 'test', 'ignored');
    // 1/6 ≈ 16.7% — below threshold
    expect(shouldSuppress('test')).toBe(true);
  });

  it('does not suppress on low engagement rate with fewer than 5 data points', () => {
    // 0 engaged out of 4 = 0% but not enough data
    recordOutcome('1', 'test', 'ignored');
    recordOutcome('2', 'test', 'ignored');
    recordOutcome('3', 'test', 'ignored');
    recordOutcome('4', 'test', 'ignored');

    expect(shouldSuppress('test')).toBe(false);
  });
});

describe('listTrackedBehaviors', () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(tmpDir, { recursive: true });
    _setStateFilePath(stateFile);
  });

  afterEach(cleanup);

  it('returns empty array when no outcomes recorded', () => {
    expect(listTrackedBehaviors()).toEqual([]);
  });

  it('returns sorted unique behavior types', () => {
    recordOutcome('1', 'check-in', 'engaged');
    recordOutcome('2', 'follow-up', 'ignored');
    recordOutcome('3', 'check-in', 'rejected');
    recordOutcome('4', 'daily-digest', 'acknowledged');

    expect(listTrackedBehaviors()).toEqual([
      'check-in',
      'daily-digest',
      'follow-up',
    ]);
  });
});

describe('explainAdaptation', () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(tmpDir, { recursive: true });
    _setStateFilePath(stateFile);
  });

  afterEach(cleanup);

  it('returns null when behavior is not suppressed', () => {
    recordOutcome('1', 'test', 'engaged');
    expect(explainAdaptation('test')).toBeNull();
  });

  it('returns null for unknown behavior', () => {
    expect(explainAdaptation('nonexistent')).toBeNull();
  });

  it('explains rejection-based suppression', () => {
    recordOutcome('1', 'stale-thread-follow-up', 'engaged');
    recordOutcome('2', 'stale-thread-follow-up', 'rejected');
    recordOutcome('3', 'stale-thread-follow-up', 'rejected');

    const explanation = explainAdaptation('stale-thread-follow-up');
    expect(explanation).not.toBeNull();
    expect(explanation).toContain('stopped sending');
    expect(explanation).toContain('stale thread follow up');
    expect(explanation).toContain('declined the last 2');
  });

  it('explains low-engagement-rate suppression', () => {
    recordOutcome('1', 'check-in', 'engaged');
    recordOutcome('2', 'check-in', 'ignored');
    recordOutcome('3', 'check-in', 'ignored');
    recordOutcome('4', 'check-in', 'ignored');
    recordOutcome('5', 'check-in', 'ignored');
    recordOutcome('6', 'check-in', 'ignored');

    const explanation = explainAdaptation('check-in');
    expect(explanation).not.toBeNull();
    expect(explanation).toContain('pulling back');
    expect(explanation).toContain('check in');
    expect(explanation).toContain('1 out of 6');
  });
});

describe('resetBehavior', () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(tmpDir, { recursive: true });
    _setStateFilePath(stateFile);
  });

  afterEach(cleanup);

  it('removes all outcomes for a specific behavior', () => {
    recordOutcome('1', 'follow-up', 'rejected');
    recordOutcome('2', 'follow-up', 'rejected');
    recordOutcome('3', 'check-in', 'engaged');

    resetBehavior('follow-up');

    const state = loadState();
    expect(state.outcomes).toHaveLength(1);
    expect(state.outcomes[0].behaviorType).toBe('check-in');
  });

  it('makes a previously suppressed behavior active again', () => {
    recordOutcome('1', 'test', 'rejected');
    recordOutcome('2', 'test', 'rejected');
    expect(shouldSuppress('test')).toBe(true);

    resetBehavior('test');
    expect(shouldSuppress('test')).toBe(false);
  });

  it('is safe to call for nonexistent behavior', () => {
    recordOutcome('1', 'other', 'engaged');
    resetBehavior('nonexistent');
    const state = loadState();
    expect(state.outcomes).toHaveLength(1);
  });
});

describe('threshold constants', () => {
  it('LOW_ENGAGEMENT_THRESHOLD is 0.20', () => {
    expect(LOW_ENGAGEMENT_THRESHOLD).toBe(0.20);
  });

  it('REJECTION_DISABLE_THRESHOLD is 2', () => {
    expect(REJECTION_DISABLE_THRESHOLD).toBe(2);
  });

  it('MAX_OUTCOME_RECORDS is 500', () => {
    expect(MAX_OUTCOME_RECORDS).toBe(500);
  });
});
