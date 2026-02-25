import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  parseConcerns,
  computeUrgencyScore,
  getTimeContext,
  CognitiveLoop,
} from '../autonomy/cognitive-loop.js';
import type { Concern, AttentionState, TimeContext } from '../autonomy/cognitive-loop.js';

// ---------------------------------------------------------------------------
// parseConcerns
// ---------------------------------------------------------------------------

describe('parseConcerns', () => {
  it('extracts concerns from markdown list items', () => {
    const content = `# Concerns

- Think about API design for v2
- Review deployment config
`;

    const concerns = parseConcerns(content);

    expect(concerns).toHaveLength(2);
    expect(concerns[0].text).toBe('Think about API design for v2');
    expect(concerns[1].text).toBe('Review deployment config');
  });

  it('defaults to active priority', () => {
    const content = `- First concern
- Second concern
`;

    const concerns = parseConcerns(content);

    expect(concerns).toHaveLength(2);
    expect(concerns[0].priority).toBe('active');
    expect(concerns[1].priority).toBe('active');
  });

  it('parses active and radar sections', () => {
    const content = `# Concerns

**Active:**
- Deployment is failing
- Need to fix CI

**On my radar:**
- Refactor memory module
- Consider new test framework
`;

    const concerns = parseConcerns(content);

    expect(concerns).toHaveLength(4);
    expect(concerns[0]).toEqual({ text: 'Deployment is failing', priority: 'active' });
    expect(concerns[1]).toEqual({ text: 'Need to fix CI', priority: 'active' });
    expect(concerns[2]).toEqual({ text: 'Refactor memory module', priority: 'radar' });
    expect(concerns[3]).toEqual({ text: 'Consider new test framework', priority: 'radar' });
  });

  it('returns empty array for content with no list items', () => {
    const content = `# Concerns

(No concerns yet.)
`;

    const concerns = parseConcerns(content);
    expect(concerns).toHaveLength(0);
  });

  it('returns empty array for empty string', () => {
    expect(parseConcerns('')).toHaveLength(0);
  });

  it('handles content with only radar section', () => {
    const content = `**On my radar:**
- Low priority item
`;

    const concerns = parseConcerns(content);

    expect(concerns).toHaveLength(1);
    expect(concerns[0].priority).toBe('radar');
    expect(concerns[0].text).toBe('Low priority item');
  });

  it('handles interleaved sections correctly', () => {
    const content = `**Active:**
- Urgent issue
**On my radar:**
- Back-burner item
**Active:**
- Another urgent one
`;

    const concerns = parseConcerns(content);

    expect(concerns).toHaveLength(3);
    expect(concerns[0]).toEqual({ text: 'Urgent issue', priority: 'active' });
    expect(concerns[1]).toEqual({ text: 'Back-burner item', priority: 'radar' });
    expect(concerns[2]).toEqual({ text: 'Another urgent one', priority: 'active' });
  });

  it('ignores lines that are not list items', () => {
    const content = `# Concerns
Some paragraph text.
- Actual concern
Another paragraph.
`;

    const concerns = parseConcerns(content);
    expect(concerns).toHaveLength(1);
    expect(concerns[0].text).toBe('Actual concern');
  });
});

// ---------------------------------------------------------------------------
// getTimeContext
// ---------------------------------------------------------------------------

describe('getTimeContext', () => {
  function dateAtHour(hour: number): Date {
    const d = new Date(2026, 1, 25); // Feb 25, 2026
    d.setHours(hour, 0, 0, 0);
    return d;
  }

  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

  // ── Period classification ──

  it('classifies hours 6-9 as morning', () => {
    for (const h of [6, 7, 8, 9]) {
      const ctx = getTimeContext(dateAtHour(h));
      expect(ctx.period).toBe('morning');
      expect(ctx.hourOfDay).toBe(h);
    }
  });

  it('classifies hours 10-17 as daytime', () => {
    for (const h of [10, 12, 15, 17]) {
      const ctx = getTimeContext(dateAtHour(h));
      expect(ctx.period).toBe('daytime');
      expect(ctx.hourOfDay).toBe(h);
    }
  });

  it('classifies hours 18-22 as evening', () => {
    for (const h of [18, 20, 22]) {
      const ctx = getTimeContext(dateAtHour(h));
      expect(ctx.period).toBe('evening');
      expect(ctx.hourOfDay).toBe(h);
    }
  });

  it('classifies hours 23, 0-5 as night', () => {
    for (const h of [23, 0, 1, 3, 5]) {
      const ctx = getTimeContext(dateAtHour(h));
      expect(ctx.period).toBe('night');
      expect(ctx.hourOfDay).toBe(h);
    }
  });

  // ── Period boundary tests ──

  it('hour 6 is morning (not night)', () => {
    expect(getTimeContext(dateAtHour(6)).period).toBe('morning');
  });

  it('hour 10 is daytime (not morning)', () => {
    expect(getTimeContext(dateAtHour(10)).period).toBe('daytime');
  });

  it('hour 18 is evening (not daytime)', () => {
    expect(getTimeContext(dateAtHour(18)).period).toBe('evening');
  });

  it('hour 23 is night (not evening)', () => {
    expect(getTimeContext(dateAtHour(23)).period).toBe('night');
  });

  // ── Quiet period ──

  it('isQuietPeriod is true when timeSinceLastUserMessage > 4 hours', () => {
    const ctx = getTimeContext(dateAtHour(14), FOUR_HOURS_MS + 1);
    expect(ctx.isQuietPeriod).toBe(true);
  });

  it('isQuietPeriod is false when timeSinceLastUserMessage <= 4 hours', () => {
    const ctx = getTimeContext(dateAtHour(14), FOUR_HOURS_MS);
    expect(ctx.isQuietPeriod).toBe(false);
  });

  it('isQuietPeriod is false when timeSinceLastUserMessage is 0', () => {
    const ctx = getTimeContext(dateAtHour(14), 0);
    expect(ctx.isQuietPeriod).toBe(false);
  });

  it('isQuietPeriod defaults to true when no timeSinceLastUserMessage provided (Infinity)', () => {
    const ctx = getTimeContext(dateAtHour(14));
    expect(ctx.isQuietPeriod).toBe(true);
  });

  // ── hourOfDay ──

  it('returns correct hourOfDay', () => {
    const ctx = getTimeContext(dateAtHour(14));
    expect(ctx.hourOfDay).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// computeUrgencyScore
// ---------------------------------------------------------------------------

describe('computeUrgencyScore', () => {
  it('returns 0 when nothing is urgent', () => {
    const score = computeUrgencyScore(
      [],      // no concerns
      0,       // no pending actions
      0,       // no time since last reflection
      900_000, // max interval 15min
      false,   // no stale threads
    );

    expect(score).toBe(0);
  });

  it('increases with active concerns (capped at 3)', () => {
    const activeConcerns: Concern[] = [
      { text: 'concern 1', priority: 'active' },
      { text: 'concern 2', priority: 'active' },
      { text: 'concern 3', priority: 'active' },
    ];

    const score3 = computeUrgencyScore(activeConcerns, 0, 0, 900_000, false);
    expect(score3).toBeCloseTo(0.45);

    // Adding a 4th concern should not increase the score (capped at 3)
    const fourConcerns = [...activeConcerns, { text: 'concern 4', priority: 'active' as const }];
    const score4 = computeUrgencyScore(fourConcerns, 0, 0, 900_000, false);
    expect(score4).toBeCloseTo(0.45);
  });

  it('ignores radar concerns for scoring', () => {
    const radarConcerns: Concern[] = [
      { text: 'radar item', priority: 'radar' },
    ];

    const score = computeUrgencyScore(radarConcerns, 0, 0, 900_000, false);
    expect(score).toBe(0);
  });

  it('increases with pending actions (capped at 2)', () => {
    const score1 = computeUrgencyScore([], 1, 0, 900_000, false);
    expect(score1).toBeCloseTo(0.2);

    const score2 = computeUrgencyScore([], 2, 0, 900_000, false);
    expect(score2).toBeCloseTo(0.4);

    // Capped at 2 contributing
    const score5 = computeUrgencyScore([], 5, 0, 900_000, false);
    expect(score5).toBeCloseTo(0.4);
  });

  it('increases linearly with time since last reflection', () => {
    // At half the max interval
    const scoreHalf = computeUrgencyScore([], 0, 450_000, 900_000, false);
    expect(scoreHalf).toBeCloseTo(0.075);

    // At full max interval
    const scoreFull = computeUrgencyScore([], 0, 900_000, 900_000, false);
    expect(scoreFull).toBeCloseTo(0.15);
  });

  it('adds 0.1 for stale threads', () => {
    const withoutStale = computeUrgencyScore([], 0, 0, 900_000, false);
    const withStale = computeUrgencyScore([], 0, 0, 900_000, true);

    expect(withStale - withoutStale).toBeCloseTo(0.1);
  });

  it('caps at 1.0', () => {
    const activeConcerns: Concern[] = [
      { text: 'c1', priority: 'active' },
      { text: 'c2', priority: 'active' },
      { text: 'c3', priority: 'active' },
    ];

    // 3 concerns (0.45) + 2 pending (0.4) + full time (0.15) + stale (0.1) = 1.1 => capped at 1.0
    const score = computeUrgencyScore(activeConcerns, 5, 900_000, 900_000, true);
    expect(score).toBe(1.0);
  });

  it('handles zero maxIntervalMs without NaN', () => {
    const score = computeUrgencyScore([], 0, 1000, 0, false);
    expect(Number.isNaN(score)).toBe(false);
    expect(score).toBe(0);
  });

  // ── Backward compatibility (no TimeContext) ──

  it('works without TimeContext parameter (backward compatible)', () => {
    const score = computeUrgencyScore(
      [{ text: 'c1', priority: 'active' }],
      1,
      450_000,
      900_000,
      false,
    );
    // 1 concern (0.15) + 1 pending (0.2) + half time (0.075) = 0.425
    expect(score).toBeCloseTo(0.425);
  });

  // ── Rhythm bonuses ──

  describe('rhythm bonuses with TimeContext', () => {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

    it('adds +0.15 morning bonus when timeSinceLastReflection > 6 hours', () => {
      const morning: TimeContext = { period: 'morning', isQuietPeriod: false, hourOfDay: 8 };

      const withoutBonus = computeUrgencyScore([], 0, SIX_HOURS_MS - 1, 900_000, false, morning);
      const withBonus = computeUrgencyScore([], 0, SIX_HOURS_MS + 1, 900_000, false, morning);

      // Without bonus: only time pressure contributes
      // With bonus: time pressure + 0.15 morning bonus
      expect(withBonus - withoutBonus).toBeCloseTo(0.15, 1);
    });

    it('does not add morning bonus when timeSinceLastReflection <= 6 hours', () => {
      const morning: TimeContext = { period: 'morning', isQuietPeriod: false, hourOfDay: 7 };

      const score = computeUrgencyScore([], 0, SIX_HOURS_MS, 900_000, false, morning);
      // Only time pressure: (SIX_HOURS_MS / 900_000) * 0.15 capped at 0.15
      // SIX_HOURS_MS = 21_600_000, ratio = 21_600_000 / 900_000 = 24 => capped at 1.0, so time = 0.15
      // No morning bonus since not > 6h
      expect(score).toBeCloseTo(0.15);
    });

    it('adds +0.10 evening bonus when timeSinceLastReflection > 4 hours', () => {
      const evening: TimeContext = { period: 'evening', isQuietPeriod: false, hourOfDay: 20 };

      const withoutBonus = computeUrgencyScore([], 0, FOUR_HOURS_MS - 1, 900_000, false, evening);
      const withBonus = computeUrgencyScore([], 0, FOUR_HOURS_MS + 1, 900_000, false, evening);

      expect(withBonus - withoutBonus).toBeCloseTo(0.10, 1);
    });

    it('does not add evening bonus when timeSinceLastReflection <= 4 hours', () => {
      const evening: TimeContext = { period: 'evening', isQuietPeriod: false, hourOfDay: 19 };

      const score = computeUrgencyScore([], 0, FOUR_HOURS_MS, 900_000, false, evening);
      // Only time pressure (capped) — no evening bonus since not > 4h
      expect(score).toBeCloseTo(0.15);
    });

    it('adds +0.10 for quiet period', () => {
      const quietDaytime: TimeContext = { period: 'daytime', isQuietPeriod: true, hourOfDay: 14 };
      const activeDaytime: TimeContext = { period: 'daytime', isQuietPeriod: false, hourOfDay: 14 };

      const quietScore = computeUrgencyScore([], 0, 0, 900_000, false, quietDaytime);
      const activeScore = computeUrgencyScore([], 0, 0, 900_000, false, activeDaytime);

      expect(quietScore - activeScore).toBeCloseTo(0.10);
    });

    it('subtracts 0.15 during night period', () => {
      const night: TimeContext = { period: 'night', isQuietPeriod: false, hourOfDay: 2 };
      const daytime: TimeContext = { period: 'daytime', isQuietPeriod: false, hourOfDay: 14 };

      const nightScore = computeUrgencyScore([], 0, 0, 900_000, false, night);
      const dayScore = computeUrgencyScore([], 0, 0, 900_000, false, daytime);

      // Night suppression: -0.15, but clamped at 0
      expect(nightScore).toBe(0);
      expect(dayScore).toBe(0); // daytime with no other factors is also 0
    });

    it('night suppression lowers score but does not go below 0', () => {
      const night: TimeContext = { period: 'night', isQuietPeriod: false, hourOfDay: 1 };

      // Only a small base score (0.1 from stale threads)
      const score = computeUrgencyScore([], 0, 0, 900_000, true, night);
      // 0.1 (stale) - 0.15 (night) = -0.05 => clamped to 0
      expect(score).toBe(0);
    });

    it('night suppression reduces but does not eliminate high urgency', () => {
      const night: TimeContext = { period: 'night', isQuietPeriod: false, hourOfDay: 3 };
      const activeConcerns: Concern[] = [
        { text: 'c1', priority: 'active' },
        { text: 'c2', priority: 'active' },
      ];

      // 2 concerns (0.30) + stale (0.1) - night (0.15) = 0.25
      const score = computeUrgencyScore(activeConcerns, 0, 0, 900_000, true, night);
      expect(score).toBeCloseTo(0.25);
    });

    it('morning bonus and quiet period can stack', () => {
      const morningQuiet: TimeContext = { period: 'morning', isQuietPeriod: true, hourOfDay: 7 };

      // With reflection > 6h: morning (+0.15) + quiet (+0.10) + time pressure (0.15)
      const score = computeUrgencyScore([], 0, SIX_HOURS_MS + 1, 900_000, false, morningQuiet);
      // time pressure is capped at 0.15 since SIX_HOURS_MS + 1 >> 900_000
      expect(score).toBeCloseTo(0.40);
    });

    it('evening bonus and quiet period can stack', () => {
      const eveningQuiet: TimeContext = { period: 'evening', isQuietPeriod: true, hourOfDay: 21 };

      // With reflection > 4h: evening (+0.10) + quiet (+0.10) + time pressure (0.15)
      const score = computeUrgencyScore([], 0, FOUR_HOURS_MS + 1, 900_000, false, eveningQuiet);
      expect(score).toBeCloseTo(0.35);
    });

    it('daytime period adds no rhythm bonus (only quiet if applicable)', () => {
      const daytime: TimeContext = { period: 'daytime', isQuietPeriod: false, hourOfDay: 14 };

      const score = computeUrgencyScore([], 0, SIX_HOURS_MS + 1, 900_000, false, daytime);
      // Only time pressure (0.15), no rhythm bonus
      expect(score).toBeCloseTo(0.15);
    });

    it('night with quiet period: quiet bonus partially offsets night suppression', () => {
      const nightQuiet: TimeContext = { period: 'night', isQuietPeriod: true, hourOfDay: 2 };

      // quiet (+0.10) + night (-0.15) = -0.05 net, plus 0.1 stale
      const score = computeUrgencyScore([], 0, 0, 900_000, true, nightQuiet);
      // 0.1 (stale) + 0.10 (quiet) - 0.15 (night) = 0.05
      expect(score).toBeCloseTo(0.05);
    });
  });
});

// ---------------------------------------------------------------------------
// CognitiveLoop
// ---------------------------------------------------------------------------

describe('CognitiveLoop', () => {
  let loop: CognitiveLoop;

  afterEach(() => {
    loop?.stop();
  });

  function makeLoop(overrides: Partial<ConstructorParameters<typeof CognitiveLoop>[0]> = {}) {
    return new CognitiveLoop(
      { minIntervalMs: 60_000, maxIntervalMs: 900_000, urgencyThreshold: 0.6, ...overrides },
      vi.fn(),
    );
  }

  function makeTimeContext(overrides: Partial<TimeContext> = {}): TimeContext {
    return {
      period: 'daytime',
      isQuietPeriod: false,
      hourOfDay: 14,
      ...overrides,
    };
  }

  function attentionState(urgency: number, tc?: Partial<TimeContext>): AttentionState {
    return {
      concerns: [],
      timeSinceLastReflection: 0,
      timeSinceLastUserMessage: 0,
      pendingActionsCount: 0,
      urgencyScore: urgency,
      timeContext: makeTimeContext(tc),
    };
  }

  // ── Construction ──

  it('creates with partial or empty config', () => {
    loop = new CognitiveLoop({ minIntervalMs: 1000 }, vi.fn());
    expect(loop.isRunning()).toBe(false);

    loop.stop();
    loop = new CognitiveLoop({}, vi.fn());
    expect(loop.isRunning()).toBe(false);
  });

  // ── Lifecycle ──

  it('start/stop toggles running state', () => {
    loop = makeLoop();

    loop.start();
    expect(loop.isRunning()).toBe(true);

    loop.stop();
    expect(loop.isRunning()).toBe(false);
  });

  it('start and stop are both idempotent', () => {
    loop = makeLoop();

    loop.stop(); // stop when not running — no error
    expect(loop.isRunning()).toBe(false);

    loop.start();
    loop.start(); // start when already running — no error
    expect(loop.isRunning()).toBe(true);
  });

  it('can restart after stopping', () => {
    loop = makeLoop();

    loop.start();
    loop.stop();
    loop.start();
    expect(loop.isRunning()).toBe(true);
  });

  // ── shouldThink ──

  it('shouldThink triggers at or above threshold, not below', () => {
    loop = makeLoop({ urgencyThreshold: 0.6 });

    expect(loop.shouldThink(attentionState(0.3))).toBe(false);
    expect(loop.shouldThink(attentionState(0.6))).toBe(true);
    expect(loop.shouldThink(attentionState(0.7))).toBe(true);
  });

  // ── recordUserMessage ──

  it('recordUserMessage does not throw', () => {
    loop = makeLoop();
    loop.recordUserMessage();
  });

  // ── evaluateAttention includes timeContext ──

  it('evaluateAttention returns state with timeContext', async () => {
    loop = makeLoop({ workspacePath: '/tmp/nonexistent-workspace-for-test' });

    const state = await loop.evaluateAttention();

    expect(state.timeContext).toBeDefined();
    expect(state.timeContext.period).toMatch(/^(morning|daytime|evening|night)$/);
    expect(typeof state.timeContext.isQuietPeriod).toBe('boolean');
    expect(typeof state.timeContext.hourOfDay).toBe('number');
    expect(state.timeContext.hourOfDay).toBeGreaterThanOrEqual(0);
    expect(state.timeContext.hourOfDay).toBeLessThanOrEqual(23);
  });

  it('evaluateAttention marks quiet period when no user messages received', async () => {
    loop = makeLoop({ workspacePath: '/tmp/nonexistent-workspace-for-test' });
    // Do not call recordUserMessage — lastUserMessageTime stays at 0 (Infinity)

    const state = await loop.evaluateAttention();

    expect(state.timeContext.isQuietPeriod).toBe(true);
  });

  it('evaluateAttention marks active period when user messaged recently', async () => {
    loop = makeLoop({ workspacePath: '/tmp/nonexistent-workspace-for-test' });
    loop.recordUserMessage(); // just now

    const state = await loop.evaluateAttention();

    expect(state.timeContext.isQuietPeriod).toBe(false);
  });
});
