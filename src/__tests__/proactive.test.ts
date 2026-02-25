import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setMemoryDir } from '../memory.js';
import {
  loadProactiveState,
  saveProactiveState,
  pruneSentRecords,
  checkRateLimits,
  isShadowMode,
  buildScoringPrompt,
  parseScoreResponse,
  determineAction,
  evaluateThreadForFollowUp,
  evaluateActiveThreads,
  recordFollowUpSent,
  recordFollowUpIgnored,
  _setReflectionInvoker,
  type ProactiveState,
  type SignificanceScore,
} from '../proactive.js';
import { saveThreads, type Thread, type ThreadsState } from '../threads.js';

const tmpDir = join(tmpdir(), 'timothy-test-proactive');

beforeEach(() => {
  _setMemoryDir(tmpDir);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  // Reset the reflection invoker to a no-op for tests that don't need LLM
  _setReflectionInvoker(null);
});

afterEach(() => {
  _setReflectionInvoker(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── State persistence ────────────────────────────────────────────────

describe('loadProactiveState', () => {
  it('returns empty state when file does not exist', () => {
    const state = loadProactiveState();
    expect(state.sentToday).toEqual([]);
    expect(state.followUpsByThread).toEqual({});
    expect(state.lastUpdated).toBeTruthy();
  });

  it('loads existing state from disk', () => {
    const existing: ProactiveState = {
      sentToday: [{ threadId: 'thread-1', sentAt: '2026-01-01T12:00:00.000Z' }],
      followUpsByThread: {
        'thread-1': { followUpCount: 1, lastFollowUpAt: '2026-01-01T12:00:00.000Z', ignored: false },
      },
      lastUpdated: '2026-01-01T12:00:00.000Z',
    };
    writeFileSync(join(tmpDir, 'proactive-state.json'), JSON.stringify(existing));

    const state = loadProactiveState();
    expect(state.sentToday).toHaveLength(1);
    expect(state.followUpsByThread['thread-1'].followUpCount).toBe(1);
  });

  it('returns empty state for malformed JSON', () => {
    writeFileSync(join(tmpDir, 'proactive-state.json'), 'not json');
    const state = loadProactiveState();
    expect(state.sentToday).toEqual([]);
  });
});

describe('saveProactiveState', () => {
  it('writes state atomically', () => {
    const state: ProactiveState = {
      sentToday: [{ threadId: 't1', sentAt: '2026-01-01T00:00:00.000Z' }],
      followUpsByThread: {},
      lastUpdated: '2026-01-01T00:00:00.000Z',
    };

    saveProactiveState(state);

    const filePath = join(tmpDir, 'proactive-state.json');
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(filePath + '.tmp')).toBe(false);

    const loaded = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(loaded.sentToday).toHaveLength(1);
  });
});

// ── Rate limiting ────────────────────────────────────────────────────

describe('pruneSentRecords', () => {
  it('removes records older than 24 hours', () => {
    const now = new Date('2026-01-02T12:00:00.000Z');
    const state: ProactiveState = {
      sentToday: [
        { threadId: 'old', sentAt: '2026-01-01T10:00:00.000Z' }, // >24h ago
        { threadId: 'recent', sentAt: '2026-01-02T10:00:00.000Z' }, // 2h ago
      ],
      followUpsByThread: {},
      lastUpdated: '2026-01-02T10:00:00.000Z',
    };

    const cleaned = pruneSentRecords(state, now);
    expect(cleaned.sentToday).toHaveLength(1);
    expect(cleaned.sentToday[0].threadId).toBe('recent');
  });
});

describe('checkRateLimits', () => {
  it('allows when no prior messages', () => {
    const state: ProactiveState = {
      sentToday: [],
      followUpsByThread: {},
      lastUpdated: new Date().toISOString(),
    };
    const result = checkRateLimits(state, 'thread-1');
    expect(result.allowed).toBe(true);
  });

  it('blocks when daily limit reached', () => {
    const now = new Date('2026-01-02T12:00:00.000Z');
    const state: ProactiveState = {
      sentToday: [
        { threadId: 'a', sentAt: '2026-01-02T06:00:00.000Z' },
        { threadId: 'b', sentAt: '2026-01-02T08:00:00.000Z' },
        { threadId: 'c', sentAt: '2026-01-02T10:00:00.000Z' },
      ],
      followUpsByThread: {},
      lastUpdated: '2026-01-02T10:00:00.000Z',
    };
    const result = checkRateLimits(state, 'thread-d', now);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('daily limit');
    }
  });

  it('blocks when minimum gap not met', () => {
    const now = new Date('2026-01-02T10:30:00.000Z');
    const state: ProactiveState = {
      sentToday: [
        { threadId: 'a', sentAt: '2026-01-02T10:00:00.000Z' }, // 30min ago, need 2h
      ],
      followUpsByThread: {},
      lastUpdated: '2026-01-02T10:00:00.000Z',
    };
    const result = checkRateLimits(state, 'thread-b', now);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('minimum gap');
    }
  });

  it('blocks when per-thread follow-up limit reached', () => {
    const state: ProactiveState = {
      sentToday: [],
      followUpsByThread: {
        'thread-1': { followUpCount: 1, lastFollowUpAt: '2026-01-01T12:00:00.000Z', ignored: false },
      },
      lastUpdated: new Date().toISOString(),
    };
    const result = checkRateLimits(state, 'thread-1');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('thread follow-up limit');
    }
  });

  it('blocks when previous follow-up was ignored', () => {
    const state: ProactiveState = {
      sentToday: [],
      followUpsByThread: {
        'thread-1': { followUpCount: 0, lastFollowUpAt: null, ignored: true },
      },
      lastUpdated: new Date().toISOString(),
    };
    const result = checkRateLimits(state, 'thread-1');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('ignored');
    }
  });

  it('allows different thread even when another hit its limit', () => {
    const now = new Date('2026-01-02T12:00:00.000Z');
    const state: ProactiveState = {
      sentToday: [
        { threadId: 'thread-1', sentAt: '2026-01-02T08:00:00.000Z' }, // 4h ago, gap ok
      ],
      followUpsByThread: {
        'thread-1': { followUpCount: 1, lastFollowUpAt: '2026-01-02T08:00:00.000Z', ignored: false },
      },
      lastUpdated: '2026-01-02T08:00:00.000Z',
    };
    const result = checkRateLimits(state, 'thread-2', now);
    expect(result.allowed).toBe(true);
  });
});

// ── Score parsing ────────────────────────────────────────────────────

describe('parseScoreResponse', () => {
  it('parses valid JSON response', () => {
    const raw = JSON.stringify({
      importance: 8,
      novelty: 6,
      timing: 7,
      confidence: 5,
      reasoning: 'This thread has a deadline tomorrow.',
      draft_message: 'Hey Chris, just checking on the deployment.',
    });

    const result = parseScoreResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.score.importance).toBe(8);
    expect(result!.score.novelty).toBe(6);
    expect(result!.score.timing).toBe(7);
    expect(result!.score.confidence).toBe(5);
    // weighted = 8*0.4 + 6*0.25 + 7*0.2 + 5*0.15 = 3.2 + 1.5 + 1.4 + 0.75 = 6.85
    expect(result!.score.weighted).toBe(6.85);
    expect(result!.draftMessage).toContain('deployment');
  });

  it('handles markdown code fences', () => {
    const raw = '```json\n{"importance":5,"novelty":5,"timing":5,"confidence":5,"reasoning":"ok","draft_message":""}\n```';
    const result = parseScoreResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.score.weighted).toBe(5);
  });

  it('returns null for invalid JSON', () => {
    const result = parseScoreResponse('not json at all');
    expect(result).toBeNull();
  });

  it('returns null for out-of-range scores', () => {
    const raw = JSON.stringify({
      importance: 15,
      novelty: 5,
      timing: 5,
      confidence: 5,
      reasoning: 'test',
      draft_message: '',
    });
    const result = parseScoreResponse(raw);
    expect(result).toBeNull();
  });

  it('returns null for negative scores', () => {
    const raw = JSON.stringify({
      importance: -1,
      novelty: 5,
      timing: 5,
      confidence: 5,
      reasoning: 'test',
      draft_message: '',
    });
    const result = parseScoreResponse(raw);
    expect(result).toBeNull();
  });
});

describe('determineAction', () => {
  it('returns send for score >= 7.0', () => {
    expect(determineAction(7.0)).toBe('send');
    expect(determineAction(9.5)).toBe('send');
  });

  it('returns note for score >= 4.0 and < 7.0', () => {
    expect(determineAction(4.0)).toBe('note');
    expect(determineAction(6.99)).toBe('note');
  });

  it('returns silence for score < 4.0', () => {
    expect(determineAction(3.99)).toBe('silence');
    expect(determineAction(0)).toBe('silence');
  });
});

// ── Scoring prompt ───────────────────────────────────────────────────

describe('buildScoringPrompt', () => {
  it('includes thread topic and status', () => {
    const thread: Thread = {
      id: 'test-thread',
      topic: 'deployment pipeline configuration',
      status: 'active',
      lastActivity: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      participants: ['user', 'timothy'],
      messageCount: 4,
    };

    const prompt = buildScoringPrompt(thread);
    expect(prompt).toContain('deployment pipeline configuration');
    expect(prompt).toContain('active');
    expect(prompt).toContain('hours ago');
    expect(prompt).toContain('importance');
    expect(prompt).toContain('novelty');
  });
});

// ── Thread evaluation ────────────────────────────────────────────────

describe('evaluateThreadForFollowUp', () => {
  const makeThread = (overrides?: Partial<Thread>): Thread => ({
    id: 'test-thread-1',
    topic: 'deployment pipeline',
    status: 'active',
    lastActivity: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    participants: ['user', 'timothy'],
    messageCount: 4,
    ...overrides,
  });

  it('returns silence when rate limited', async () => {
    // Pre-fill state with max daily sends
    const state: ProactiveState = {
      sentToday: [
        { threadId: 'a', sentAt: new Date(Date.now() - 3600_000).toISOString() },
        { threadId: 'b', sentAt: new Date(Date.now() - 7200_000).toISOString() },
        { threadId: 'c', sentAt: new Date(Date.now() - 10800_000).toISOString() },
      ],
      followUpsByThread: {},
      lastUpdated: new Date().toISOString(),
    };
    saveProactiveState(state);

    const result = await evaluateThreadForFollowUp(makeThread());
    expect(result.action).toBe('silence');
    expect(result.rateLimitReason).toContain('daily limit');
    expect(result.score).toBeNull();
  });

  it('returns silence when LLM returns nothing', async () => {
    _setReflectionInvoker(async () => null);

    const result = await evaluateThreadForFollowUp(makeThread());
    expect(result.action).toBe('silence');
    expect(result.score).toBeNull();
  });

  it('returns silence when LLM returns unparseable response', async () => {
    _setReflectionInvoker(async () => 'not valid json');

    const result = await evaluateThreadForFollowUp(makeThread());
    expect(result.action).toBe('silence');
    expect(result.score).toBeNull();
  });

  it('returns send with draft when score >= 7.0', async () => {
    _setReflectionInvoker(async () =>
      JSON.stringify({
        importance: 9,
        novelty: 7,
        timing: 8,
        confidence: 7,
        reasoning: 'High priority deployment issue.',
        draft_message: 'Hey Chris, the deployment pipeline still needs your attention.',
      }),
    );

    const result = await evaluateThreadForFollowUp(makeThread());
    expect(result.action).toBe('send');
    expect(result.score).not.toBeNull();
    expect(result.score!.weighted).toBeGreaterThanOrEqual(7.0);
    expect(result.draft).not.toBeNull();
    expect(result.draft!.message).toContain('deployment');
  });

  it('returns note when score is between 4.0 and 7.0', async () => {
    _setReflectionInvoker(async () =>
      JSON.stringify({
        importance: 5,
        novelty: 4,
        timing: 5,
        confidence: 4,
        reasoning: 'Moderate interest.',
        draft_message: '',
      }),
    );

    const result = await evaluateThreadForFollowUp(makeThread());
    expect(result.action).toBe('note');
    expect(result.score).not.toBeNull();
    expect(result.draft).toBeNull(); // no draft for 'note' action
  });

  it('returns silence when score < 4.0', async () => {
    _setReflectionInvoker(async () =>
      JSON.stringify({
        importance: 2,
        novelty: 1,
        timing: 3,
        confidence: 2,
        reasoning: 'Not worth following up.',
        draft_message: '',
      }),
    );

    const result = await evaluateThreadForFollowUp(makeThread());
    expect(result.action).toBe('silence');
    expect(result.score).not.toBeNull();
    expect(result.score!.weighted).toBeLessThan(4.0);
  });

  it('reports shadow mode in result', async () => {
    process.env.TIMOTHY_PROACTIVE_SHADOW = 'true';
    _setReflectionInvoker(async () =>
      JSON.stringify({
        importance: 9,
        novelty: 8,
        timing: 9,
        confidence: 8,
        reasoning: 'Important.',
        draft_message: 'Follow up message.',
      }),
    );

    const result = await evaluateThreadForFollowUp(makeThread());
    expect(result.shadow).toBe(true);

    delete process.env.TIMOTHY_PROACTIVE_SHADOW;
  });
});

// ── Record keeping ───────────────────────────────────────────────────

describe('recordFollowUpSent', () => {
  it('adds sent record and updates thread state', () => {
    const now = new Date('2026-01-02T12:00:00.000Z');
    recordFollowUpSent('thread-1', now);

    const state = loadProactiveState();
    expect(state.sentToday).toHaveLength(1);
    expect(state.sentToday[0].threadId).toBe('thread-1');
    expect(state.followUpsByThread['thread-1'].followUpCount).toBe(1);
    expect(state.followUpsByThread['thread-1'].ignored).toBe(false);
  });

  it('increments follow-up count on repeated sends', () => {
    recordFollowUpSent('thread-1');
    recordFollowUpSent('thread-1');

    const state = loadProactiveState();
    expect(state.followUpsByThread['thread-1'].followUpCount).toBe(2);
  });
});

describe('recordFollowUpIgnored', () => {
  it('marks thread as ignored', () => {
    recordFollowUpSent('thread-1');
    recordFollowUpIgnored('thread-1');

    const state = loadProactiveState();
    expect(state.followUpsByThread['thread-1'].ignored).toBe(true);
  });

  it('creates thread entry if not present', () => {
    recordFollowUpIgnored('thread-new');

    const state = loadProactiveState();
    expect(state.followUpsByThread['thread-new'].ignored).toBe(true);
  });
});

// ── Batch evaluation ─────────────────────────────────────────────────

describe('evaluateActiveThreads', () => {
  it('returns empty array when no threads exist', async () => {
    const results = await evaluateActiveThreads();
    expect(results).toEqual([]);
  });

  it('skips threads that are not stale enough', async () => {
    // Create a thread that was active 1 hour ago (below 4h threshold)
    const threads: ThreadsState = {
      threads: [
        {
          id: 'recent-thread',
          topic: 'recent topic for testing purposes',
          status: 'active',
          lastActivity: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
          participants: ['user', 'timothy'],
          messageCount: 2,
        },
      ],
      lastUpdated: new Date().toISOString(),
    };
    saveThreads(threads);

    const results = await evaluateActiveThreads(4);
    expect(results).toEqual([]);
  });

  it('evaluates stale threads', async () => {
    _setReflectionInvoker(async () =>
      JSON.stringify({
        importance: 3,
        novelty: 2,
        timing: 3,
        confidence: 2,
        reasoning: 'Low priority.',
        draft_message: '',
      }),
    );

    const threads: ThreadsState = {
      threads: [
        {
          id: 'stale-thread',
          topic: 'stale topic for testing evaluation',
          status: 'active',
          lastActivity: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
          participants: ['user', 'timothy'],
          messageCount: 4,
        },
      ],
      lastUpdated: new Date().toISOString(),
    };
    saveThreads(threads);

    const results = await evaluateActiveThreads(4);
    expect(results).toHaveLength(1);
    expect(results[0].threadId).toBe('stale-thread');
  });

  it('stops evaluating after hitting a rate limit', async () => {
    // Fill rate limits
    const state: ProactiveState = {
      sentToday: [
        { threadId: 'a', sentAt: new Date(Date.now() - 3600_000).toISOString() },
        { threadId: 'b', sentAt: new Date(Date.now() - 7200_000).toISOString() },
        { threadId: 'c', sentAt: new Date(Date.now() - 10800_000).toISOString() },
      ],
      followUpsByThread: {},
      lastUpdated: new Date().toISOString(),
    };
    saveProactiveState(state);

    const threads: ThreadsState = {
      threads: [
        {
          id: 'stale-1',
          topic: 'first stale topic for batch eval test',
          status: 'active',
          lastActivity: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
          participants: ['user', 'timothy'],
          messageCount: 2,
        },
        {
          id: 'stale-2',
          topic: 'second stale topic for batch eval test',
          status: 'active',
          lastActivity: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
          participants: ['user', 'timothy'],
          messageCount: 2,
        },
      ],
      lastUpdated: new Date().toISOString(),
    };
    saveThreads(threads);

    const results = await evaluateActiveThreads(4);
    // Should stop after the first thread hits rate limit
    expect(results).toHaveLength(1);
    expect(results[0].rateLimitReason).toContain('daily limit');
  });
});

// ── Shadow mode ──────────────────────────────────────────────────────

describe('isShadowMode', () => {
  it('returns false by default', () => {
    delete process.env.TIMOTHY_PROACTIVE_SHADOW;
    expect(isShadowMode()).toBe(false);
  });

  it('returns true when env var is set', () => {
    process.env.TIMOTHY_PROACTIVE_SHADOW = 'true';
    expect(isShadowMode()).toBe(true);
    delete process.env.TIMOTHY_PROACTIVE_SHADOW;
  });

  it('returns false for other values', () => {
    process.env.TIMOTHY_PROACTIVE_SHADOW = 'false';
    expect(isShadowMode()).toBe(false);
    delete process.env.TIMOTHY_PROACTIVE_SHADOW;
  });
});
