/**
 * E2E tests for the heartbeat -> proactive -> engagement pipeline.
 *
 * These tests wire REAL modules together with real filesystem I/O.
 * LLM calls are injected via _setXxx() to avoid real API costs,
 * but all module boundaries are real — no mocking of inter-module calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Real module imports — no mocking
import { _setMemoryDir, _setWorkingMemoryDir, serializeMemoryFile } from '../../memory.js';
import type { MemoryFrontmatter } from '../../memory.js';
import {
  gather,
  decide,
  reflect,
  runHeartbeat,
  onProactiveMessage,
  _clearProactiveCallback,
  _setReflectionInvoker as _setHeartbeatReflectionInvoker,
  _setLastReflectionTime,
  type GatherResult,
} from '../../reflection.js';
import {
  evaluateActiveThreads,
  evaluateThreadForFollowUp,
  recordFollowUpSent,
  loadProactiveState,
  saveProactiveState,
  checkRateLimits,
  _setReflectionInvoker as _setProactiveReflectionInvoker,
  type ProactiveState,
} from '../../proactive.js';
import { saveThreads, type Thread, type ThreadsState } from '../../threads.js';
import {
  _setStateFilePath as _setEngagementStateFilePath,
  recordOutcome,
  shouldSuppress,
  getEngagementProfile,
  loadState as loadEngagementState,
} from '../../engagement.js';

// ── Test workspace setup ──────────────────────────────────────────────

const BASE_TMP = join(tmpdir(), 'titus-e2e-heartbeat');

let tmpWorkingMemory: string;
let tmpMemory: string;
let tmpEngagementState: string;

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

function createTestWorkspace(): void {
  tmpWorkingMemory = join(BASE_TMP, `wm-${Date.now()}`);
  tmpMemory = join(BASE_TMP, `mem-${Date.now()}`);
  tmpEngagementState = join(BASE_TMP, `eng-${Date.now()}`, 'engagement-state.json');

  rmSync(tmpWorkingMemory, { recursive: true, force: true });
  rmSync(tmpMemory, { recursive: true, force: true });
  rmSync(join(BASE_TMP, `eng-${Date.now()}`), { recursive: true, force: true });

  mkdirSync(tmpWorkingMemory, { recursive: true });
  mkdirSync(tmpMemory, { recursive: true });
  mkdirSync(join(tmpEngagementState, '..'), { recursive: true });

  _setWorkingMemoryDir(tmpWorkingMemory);
  _setMemoryDir(tmpMemory);
  _setEngagementStateFilePath(tmpEngagementState);
}

function cleanupWorkspace(): void {
  _setHeartbeatReflectionInvoker(null);
  _setProactiveReflectionInvoker(null);
  _setLastReflectionTime(0);
  _clearProactiveCallback();
  delete process.env.TITUS_PROACTIVE_SHADOW;
  delete process.env.TITUS_MIN_REFLECTION_GAP_MS;

  rmSync(BASE_TMP, { recursive: true, force: true });
}

function makeStaleThread(overrides?: Partial<Thread>): Thread {
  return {
    id: `stale-thread-${Date.now()}`,
    topic: 'deployment pipeline configuration',
    status: 'active',
    lastActivity: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    participants: ['user', 'titus'],
    messageCount: 4,
    ...overrides,
  };
}

function makeHighScoreLlmResponse(): string {
  return JSON.stringify({
    importance: 9,
    novelty: 7,
    timing: 8,
    confidence: 8,
    reasoning: 'Deployment pipeline needs attention urgently.',
    draft_message: 'Hey Chris, the deployment pipeline still needs your review.',
  });
}

function makeLowScoreLlmResponse(): string {
  return JSON.stringify({
    importance: 2,
    novelty: 1,
    timing: 2,
    confidence: 2,
    reasoning: 'Not worth following up.',
    draft_message: '',
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Heartbeat Pipeline E2E', () => {
  beforeEach(() => {
    createTestWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace();
  });

  // ── Test 1: Heartbeat gather with real workspace ──────────────────

  describe('heartbeat gather with real workspace', () => {
    it('reads populated working memory files and detects attention items', async () => {
      // Populate real working memory files
      writeFileSync(
        join(tmpWorkingMemory, 'active-context.md'),
        makeWmContent('Currently focused on implementing the heartbeat pipeline for Titus.'),
      );
      writeFileSync(
        join(tmpWorkingMemory, 'attention-queue.md'),
        makeWmContent('## Attention Queue\n\n- HIGH: Review PR #42 by end of day\n- MEDIUM: Follow up on deployment config'),
      );
      writeFileSync(
        join(tmpWorkingMemory, 'pending-actions.md'),
        makeWmContent('## Pending Actions\n\n- Send Chris the updated API docs'),
      );

      // Create threads.json with real thread data
      const threads: ThreadsState = {
        threads: [
          makeStaleThread({ id: 'thread-deploy', topic: 'deployment strategy' }),
          {
            id: 'thread-recent',
            topic: 'API documentation updates',
            status: 'active',
            lastActivity: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
            participants: ['user', 'titus'],
            messageCount: 2,
          },
        ],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      // Gather reads real files
      const result = await gather();

      // Verify all working memory files were loaded
      expect(result.workingMemory).toHaveLength(3);
      const names = result.workingMemory.map((f) => f.name);
      expect(names).toContain('active-context.md');
      expect(names).toContain('attention-queue.md');
      expect(names).toContain('pending-actions.md');

      // Verify attention items detected from real content
      expect(result.hasAttentionItems).toBe(true);
      expect(result.hasPendingActions).toBe(true);

      // Verify active threads loaded
      expect(result.activeThreads).toHaveLength(2);
      expect(result.activeThreads.some((t) => t.topic === 'deployment strategy')).toBe(true);
    }, 10_000);

    it('returns empty state for fresh workspace with no content', async () => {
      const result = await gather();

      expect(result.workingMemory).toEqual([]);
      expect(result.activeThreads).toEqual([]);
      expect(result.hasAttentionItems).toBe(false);
      expect(result.hasPendingActions).toBe(false);
    }, 10_000);
  });

  // ── Test 2: Heartbeat decide with real state ─────────────────────

  describe('heartbeat decide with real state', () => {
    it('triggers reflection when attention queue and stale threads exist', async () => {
      // Populate attention queue
      writeFileSync(
        join(tmpWorkingMemory, 'attention-queue.md'),
        makeWmContent('## Attention Queue\n\n- HIGH: Review PR #42 by end of day'),
      );

      // Create stale thread
      const threads: ThreadsState = {
        threads: [makeStaleThread()],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      const gatherResult = await gather();
      const decideResult = decide(gatherResult);

      expect(decideResult.shouldReflect).toBe(true);
      expect(decideResult.reason).toContain('attention queue');
    }, 10_000);

    it('triggers reflection for stale threads even without attention items', async () => {
      const threads: ThreadsState = {
        threads: [makeStaleThread()],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      const gatherResult = await gather();
      const decideResult = decide(gatherResult);

      expect(decideResult.shouldReflect).toBe(true);
      expect(decideResult.reason).toContain('stale thread');
    }, 10_000);

    it('skips reflection when rate-limited even with attention items', async () => {
      _setLastReflectionTime(Date.now() - 60_000); // 1 min ago (within 5-min gap)

      writeFileSync(
        join(tmpWorkingMemory, 'attention-queue.md'),
        makeWmContent('## Attention Queue\n\n- HIGH: Urgent item'),
      );

      const gatherResult = await gather();
      const decideResult = decide(gatherResult);

      expect(decideResult.shouldReflect).toBe(false);
      expect(decideResult.reason).toContain('rate-limited');
    }, 10_000);
  });

  // ── Test 3: Heartbeat full cycle with mock LLM ───────────────────

  describe('heartbeat full cycle with mock LLM', () => {
    it('runs gather -> decide -> reflect and applies writebacks to real workspace', async () => {
      // Populate workspace with attention items to trigger reflection
      writeFileSync(
        join(tmpWorkingMemory, 'attention-queue.md'),
        makeWmContent('## Attention Queue\n\n- HIGH: Review PR #42 by end of day'),
      );
      writeFileSync(
        join(tmpWorkingMemory, 'active-context.md'),
        makeWmContent('Focused on heartbeat pipeline.'),
      );

      // Inject LLM that produces a writeback directive
      _setHeartbeatReflectionInvoker(async () => {
        return [
          'Reviewed attention queue. PR #42 is time-sensitive.',
          '',
          '<!--titus-write',
          'file: working-memory/active-context.md',
          'action: update',
          '---',
          'Focused on heartbeat pipeline. PR #42 review is urgent — needs attention today.',
          '-->',
        ].join('\n');
      });

      const result = await runHeartbeat();

      expect(result.phase).toBe('write');
      expect(result.gatherResult).toBeDefined();
      expect(result.gatherResult!.hasAttentionItems).toBe(true);
      expect(result.decideResult).toBeDefined();
      expect(result.decideResult!.shouldReflect).toBe(true);
      expect(result.reflectResult).toBeDefined();
      expect(result.reflectResult!.writebacks.length).toBeGreaterThan(0);
    }, 15_000);

    it('produces message phase when proactive message is flagged', async () => {
      writeFileSync(
        join(tmpWorkingMemory, 'attention-queue.md'),
        makeWmContent('## Attention Queue\n\n- HIGH: Deployment deadline tomorrow'),
      );

      _setHeartbeatReflectionInvoker(async () => {
        return [
          'The deployment deadline is tomorrow.',
          '',
          '<!--titus-proactive',
          'Hey Chris, just a reminder that the deployment deadline is tomorrow. Want me to help prepare?',
          '-->',
        ].join('\n');
      });

      const result = await runHeartbeat();

      expect(result.phase).toBe('message');
      expect(result.reflectResult).toBeDefined();
      expect(result.reflectResult!.proactiveMessage).toContain('deployment deadline');
    }, 15_000);

    it('degrades gracefully when LLM returns null', async () => {
      writeFileSync(
        join(tmpWorkingMemory, 'attention-queue.md'),
        makeWmContent('## Attention Queue\n\n- HIGH: Something important'),
      );

      _setHeartbeatReflectionInvoker(async () => null);

      const result = await runHeartbeat();

      // Reflection was attempted (decide said yes) but LLM failed
      expect(result.phase).toBe('reflect');
      expect(result.reflectResult).toBeDefined();
      expect(result.reflectResult!.response).toBeNull();
      expect(result.reflectResult!.writebacks).toEqual([]);
    }, 15_000);
  });

  // ── Test 4: Proactive evaluation with real threads ───────────────

  describe('proactive evaluation with real threads', () => {
    it('scores stale threads and determines action via injected LLM', async () => {
      // Create real threads.json with stale threads
      const threads: ThreadsState = {
        threads: [
          makeStaleThread({
            id: 'deploy-config',
            topic: 'deployment pipeline configuration',
          }),
        ],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      // Inject LLM that returns high significance score
      _setProactiveReflectionInvoker(async () => makeHighScoreLlmResponse());

      const results = await evaluateActiveThreads(4);

      expect(results).toHaveLength(1);
      expect(results[0].threadId).toBe('deploy-config');
      expect(results[0].action).toBe('send');
      expect(results[0].score).not.toBeNull();
      expect(results[0].score!.weighted).toBeGreaterThanOrEqual(7.0);
      expect(results[0].draft).not.toBeNull();
      expect(results[0].draft!.message).toContain('deployment');
    }, 15_000);

    it('returns silence for threads scored below threshold', async () => {
      const threads: ThreadsState = {
        threads: [
          makeStaleThread({ id: 'low-pri', topic: 'casual discussion about weather' }),
        ],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      _setProactiveReflectionInvoker(async () => makeLowScoreLlmResponse());

      const results = await evaluateActiveThreads(4);

      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('silence');
      expect(results[0].draft).toBeNull();
    }, 15_000);

    it('filters out threads that are not stale enough', async () => {
      const threads: ThreadsState = {
        threads: [
          {
            id: 'recent-thread',
            topic: 'just discussed this an hour ago',
            status: 'active',
            lastActivity: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
            participants: ['user', 'titus'],
            messageCount: 3,
          },
        ],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      _setProactiveReflectionInvoker(async () => makeHighScoreLlmResponse());

      const results = await evaluateActiveThreads(4);
      expect(results).toEqual([]);
    }, 10_000);
  });

  // ── Test 5: Rate limiting integration ────────────────────────────

  describe('rate limiting integration', () => {
    it('enforces daily cap across multiple evaluations', async () => {
      // Pre-fill with 3 sent records (daily cap)
      const now = new Date();
      const state: ProactiveState = {
        sentToday: [
          { threadId: 'a', sentAt: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString() },
          { threadId: 'b', sentAt: new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString() },
          { threadId: 'c', sentAt: new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString() },
        ],
        followUpsByThread: {},
        lastUpdated: now.toISOString(),
      };
      saveProactiveState(state);

      const threads: ThreadsState = {
        threads: [
          makeStaleThread({ id: 'new-thread', topic: 'new important topic for rate limit test' }),
        ],
        lastUpdated: now.toISOString(),
      };
      saveThreads(threads);

      _setProactiveReflectionInvoker(async () => makeHighScoreLlmResponse());

      const results = await evaluateActiveThreads(4);

      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('silence');
      expect(results[0].rateLimitReason).toContain('daily limit');
      // LLM should NOT have been called — rate limit check is first
      expect(results[0].score).toBeNull();
    }, 15_000);

    it('enforces minimum 2-hour gap between proactive messages', async () => {
      // One message sent 30 minutes ago
      const now = new Date();
      const state: ProactiveState = {
        sentToday: [
          { threadId: 'recent-send', sentAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString() },
        ],
        followUpsByThread: {},
        lastUpdated: now.toISOString(),
      };
      saveProactiveState(state);

      const rateCheck = checkRateLimits(state, 'new-thread', now);
      expect(rateCheck.allowed).toBe(false);
      if (!rateCheck.allowed) {
        expect(rateCheck.reason).toContain('minimum gap');
      }
    }, 10_000);

    it('enforces per-thread follow-up limit', async () => {
      // Thread already received its one allowed follow-up
      const state: ProactiveState = {
        sentToday: [],
        followUpsByThread: {
          'thread-1': { followUpCount: 1, lastFollowUpAt: new Date().toISOString(), ignored: false },
        },
        lastUpdated: new Date().toISOString(),
      };
      saveProactiveState(state);

      const rateCheck = checkRateLimits(state, 'thread-1');
      expect(rateCheck.allowed).toBe(false);
      if (!rateCheck.allowed) {
        expect(rateCheck.reason).toContain('thread follow-up limit');
      }
    }, 10_000);

    it('recordFollowUpSent persists state across calls', () => {
      recordFollowUpSent('thread-a');
      recordFollowUpSent('thread-b');
      recordFollowUpSent('thread-a');

      const state = loadProactiveState();
      expect(state.sentToday).toHaveLength(3);
      expect(state.followUpsByThread['thread-a'].followUpCount).toBe(2);
      expect(state.followUpsByThread['thread-b'].followUpCount).toBe(1);
    });
  });

  // ── Test 6: Shadow mode E2E ──────────────────────────────────────

  describe('shadow mode E2E', () => {
    it('creates drafts but does NOT invoke send callback in shadow mode', async () => {
      process.env.TITUS_PROACTIVE_SHADOW = 'true';

      const threads: ThreadsState = {
        threads: [
          makeStaleThread({ id: 'shadow-test', topic: 'shadow mode testing topic for pipeline' }),
        ],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      _setProactiveReflectionInvoker(async () => makeHighScoreLlmResponse());

      const results = await evaluateActiveThreads(4);

      expect(results).toHaveLength(1);
      expect(results[0].shadow).toBe(true);
      expect(results[0].action).toBe('send');
      expect(results[0].draft).not.toBeNull();
      expect(results[0].draft!.message).toBeTruthy();
    }, 15_000);

    it('heartbeat skips sending proactive messages in shadow mode', async () => {
      process.env.TITUS_PROACTIVE_SHADOW = 'true';

      writeFileSync(
        join(tmpWorkingMemory, 'attention-queue.md'),
        makeWmContent('## Attention Queue\n\n- HIGH: Test shadow mode'),
      );

      const threads: ThreadsState = {
        threads: [
          makeStaleThread({ id: 'shadow-heartbeat', topic: 'shadow heartbeat test topic for pipeline' }),
        ],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      // Track whether send callback is invoked
      let sendCalled = false;
      onProactiveMessage(async () => {
        sendCalled = true;
      });

      _setHeartbeatReflectionInvoker(async () => 'Reviewed. Nothing requires attention.');
      _setProactiveReflectionInvoker(async () => makeHighScoreLlmResponse());

      const result = await runHeartbeat();

      // Proactive evaluation ran (results exist)
      expect(result.proactiveResults).toBeDefined();
      if (result.proactiveResults && result.proactiveResults.length > 0) {
        // Shadow results have shadow=true; send callback should NOT have been invoked
        for (const r of result.proactiveResults) {
          if (r.action === 'send') {
            expect(r.shadow).toBe(true);
          }
        }
      }
      expect(sendCalled).toBe(false);
    }, 15_000);
  });

  // ── Test 7: Engagement feedback loop ─────────────────────────────

  describe('engagement feedback loop', () => {
    it('records outcomes and computes suppression thresholds', () => {
      // Record a series of outcomes via real engagement.ts
      recordOutcome('msg-1', 'stale-thread-followup', 'engaged');
      recordOutcome('msg-2', 'stale-thread-followup', 'rejected');
      recordOutcome('msg-3', 'stale-thread-followup', 'rejected');

      // After 2 consecutive rejections, shouldSuppress returns true
      expect(shouldSuppress('stale-thread-followup')).toBe(true);

      const profile = getEngagementProfile('stale-thread-followup');
      expect(profile.total).toBe(3);
      expect(profile.consecutiveRejections).toBe(2);
      expect(profile.suppressed).toBe(true);
    });

    it('low engagement rate triggers suppression after enough data', () => {
      // 1 engaged, 5 ignored = 16.7% engagement rate (below 20% threshold)
      recordOutcome('msg-1', 'stale-thread-followup', 'engaged');
      recordOutcome('msg-2', 'stale-thread-followup', 'ignored');
      recordOutcome('msg-3', 'stale-thread-followup', 'ignored');
      recordOutcome('msg-4', 'stale-thread-followup', 'ignored');
      recordOutcome('msg-5', 'stale-thread-followup', 'ignored');
      recordOutcome('msg-6', 'stale-thread-followup', 'ignored');

      expect(shouldSuppress('stale-thread-followup')).toBe(true);

      const profile = getEngagementProfile('stale-thread-followup');
      expect(profile.engagementRate).toBeLessThan(0.20);
    });

    it('engagement state persists to real filesystem', () => {
      recordOutcome('msg-1', 'test-behavior', 'engaged');
      recordOutcome('msg-2', 'test-behavior', 'ignored');

      // Verify the state file was written
      expect(existsSync(tmpEngagementState)).toBe(true);

      // Read it back directly
      const raw = readFileSync(tmpEngagementState, 'utf-8');
      const state = JSON.parse(raw);
      expect(state.outcomes).toHaveLength(2);
    });

    it('suppression prevents proactive evaluation in heartbeat pipeline', async () => {
      // Pre-seed enough rejections to trigger suppression
      recordOutcome('msg-1', 'stale-thread-followup', 'rejected');
      recordOutcome('msg-2', 'stale-thread-followup', 'rejected');

      expect(shouldSuppress('stale-thread-followup')).toBe(true);

      // Now run heartbeat with attention items (to trigger reflection)
      writeFileSync(
        join(tmpWorkingMemory, 'attention-queue.md'),
        makeWmContent('## Attention Queue\n\n- HIGH: Check suppression'),
      );

      const threads: ThreadsState = {
        threads: [
          makeStaleThread({ id: 'suppressed-thread', topic: 'suppressed thread testing' }),
        ],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      let llmCallCount = 0;
      _setHeartbeatReflectionInvoker(async () => {
        llmCallCount++;
        return 'Reviewed. Nothing requires attention.';
      });
      _setProactiveReflectionInvoker(async () => {
        llmCallCount++;
        return makeHighScoreLlmResponse();
      });

      const result = await runHeartbeat();

      // Heartbeat ran reflection but proactive evaluation was suppressed
      expect(result.reflectResult).toBeDefined();
      // Proactive results should be empty because shouldSuppress blocked evaluation
      expect(result.proactiveResults).toBeDefined();
      expect(result.proactiveResults!).toEqual([]);
    }, 15_000);
  });

  // ── Test 8: Full pipeline integration ────────────────────────────

  describe('full pipeline integration', () => {
    it('wires heartbeat + proactive + engagement with real workspace', async () => {
      // Set up a realistic workspace
      writeFileSync(
        join(tmpWorkingMemory, 'active-context.md'),
        makeWmContent('Focused on the proactive messaging system.'),
      );
      writeFileSync(
        join(tmpWorkingMemory, 'attention-queue.md'),
        makeWmContent('## Attention Queue\n\n- MEDIUM: Review follow-up logic'),
      );
      writeFileSync(
        join(tmpWorkingMemory, 'pending-actions.md'),
        makeWmContent('## Pending Actions\n\n(No pending actions yet.)'),
      );

      // Create stale threads
      const threads: ThreadsState = {
        threads: [
          makeStaleThread({
            id: 'full-pipeline-thread',
            topic: 'full pipeline integration testing topic',
          }),
        ],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      // Track proactive message delivery
      const sentMessages: { message: string; threadId: string }[] = [];
      onProactiveMessage(async (message, threadId) => {
        sentMessages.push({ message, threadId });
      });

      // Wire reflection LLM: returns a simple response
      _setHeartbeatReflectionInvoker(async () => {
        return 'Reviewed attention queue. Follow-up logic looks good, no action needed.';
      });

      // Wire proactive LLM: returns high-scoring evaluation
      _setProactiveReflectionInvoker(async () => makeHighScoreLlmResponse());

      const result = await runHeartbeat();

      // Verify the full pipeline ran
      expect(result.gatherResult).toBeDefined();
      expect(result.gatherResult!.hasAttentionItems).toBe(true);
      expect(result.decideResult).toBeDefined();
      expect(result.decideResult!.shouldReflect).toBe(true);
      expect(result.reflectResult).toBeDefined();

      // Verify proactive evaluation ran and a message was sent
      expect(result.proactiveResults).toBeDefined();
      expect(result.proactiveResults!.length).toBeGreaterThan(0);

      const sendResult = result.proactiveResults!.find((r) => r.action === 'send');
      if (sendResult) {
        expect(sendResult.draft).not.toBeNull();
        // The send callback should have been invoked
        expect(sentMessages.length).toBeGreaterThan(0);
        expect(sentMessages[0].message).toContain('deployment');

        // Verify engagement was recorded (runHeartbeat records 'engaged' optimistically)
        const engState = loadEngagementState();
        expect(engState.outcomes.length).toBeGreaterThan(0);
        const lastOutcome = engState.outcomes[engState.outcomes.length - 1];
        expect(lastOutcome.behaviorType).toBe('stale-thread-followup');

        // Verify proactive state was updated (follow-up recorded)
        const proState = loadProactiveState();
        expect(proState.sentToday.length).toBeGreaterThan(0);
      }
    }, 20_000);

    it('full pipeline skips entirely when workspace is empty', async () => {
      // No working memory, no threads, no attention items
      _setHeartbeatReflectionInvoker(async () => 'Should not be called');

      const result = await runHeartbeat();

      expect(result.phase).toBe('skip');
      expect(result.decideResult!.shouldReflect).toBe(false);
      expect(result.reflectResult).toBeUndefined();
      expect(result.proactiveResults).toBeUndefined();
    }, 10_000);

    it('full pipeline completes even when proactive LLM fails', async () => {
      writeFileSync(
        join(tmpWorkingMemory, 'attention-queue.md'),
        makeWmContent('## Attention Queue\n\n- HIGH: Important task'),
      );

      const threads: ThreadsState = {
        threads: [
          makeStaleThread({ id: 'failing-llm-thread', topic: 'thread for LLM failure testing' }),
        ],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      _setHeartbeatReflectionInvoker(async () => 'Reviewed. All good.');
      // Proactive LLM returns null (failure)
      _setProactiveReflectionInvoker(async () => null);

      const result = await runHeartbeat();

      // Heartbeat still completes
      expect(result.phase).toBeDefined();
      expect(result.reflectResult).toBeDefined();
      expect(result.reflectResult!.response).toContain('All good');

      // Proactive evaluation ran but produced silence due to LLM failure
      expect(result.proactiveResults).toBeDefined();
      if (result.proactiveResults!.length > 0) {
        expect(result.proactiveResults![0].action).toBe('silence');
        expect(result.proactiveResults![0].score).toBeNull();
      }
    }, 15_000);

    it('engagement suppression feeds back to block future proactive evaluation', async () => {
      // Step 1: Run heartbeat successfully — proactive message gets sent
      writeFileSync(
        join(tmpWorkingMemory, 'attention-queue.md'),
        makeWmContent('## Attention Queue\n\n- HIGH: Step 1 trigger'),
      );

      const threads: ThreadsState = {
        threads: [
          makeStaleThread({
            id: 'feedback-thread',
            topic: 'engagement feedback loop testing topic',
          }),
        ],
        lastUpdated: new Date().toISOString(),
      };
      saveThreads(threads);

      onProactiveMessage(async () => {
        // Simulate delivery
      });

      _setHeartbeatReflectionInvoker(async () => 'Reviewed.');
      _setProactiveReflectionInvoker(async () => makeHighScoreLlmResponse());

      await runHeartbeat();

      // Step 2: Record that Chris rejected the proactive messages
      recordOutcome('feedback-1', 'stale-thread-followup', 'rejected');
      recordOutcome('feedback-2', 'stale-thread-followup', 'rejected');

      // Step 3: Verify suppression is active
      expect(shouldSuppress('stale-thread-followup')).toBe(true);

      // Step 4: Run heartbeat again — proactive evaluation should be suppressed
      _setLastReflectionTime(0); // Clear rate limit from previous run

      const result2 = await runHeartbeat();

      // Proactive results should be empty due to suppression
      expect(result2.proactiveResults).toBeDefined();
      expect(result2.proactiveResults!).toEqual([]);
    }, 20_000);
  });
});
