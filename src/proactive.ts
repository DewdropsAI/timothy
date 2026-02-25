import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMemoryPath } from './memory.js';
import { getActiveThreads, type Thread } from './threads.js';
import { resolveRoute } from './router.js';
import { getAdapterRegistry } from './claude.js';
import { resolveAdapterName } from './startup.js';
import type { AdapterInput } from './types.js';
import { identity } from './identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_PATH = path.resolve(PROJECT_ROOT, 'workspace');

// ── Types ────────────────────────────────────────────────────────────

export interface SignificanceScore {
  importance: number;   // 0-10, weight 40%
  novelty: number;      // 0-10, weight 25%
  timing: number;       // 0-10, weight 20%
  confidence: number;   // 0-10, weight 15%
  weighted: number;     // final weighted score
  reasoning: string;    // LLM's explanation
}

export interface FollowUpDraft {
  threadId: string;
  topic: string;
  message: string;
  score: SignificanceScore;
  draftedAt: string; // ISO timestamp
}

export type FollowUpAction = 'send' | 'note' | 'silence';

export interface ProactiveState {
  sentToday: SentRecord[];
  followUpsByThread: Record<string, ThreadFollowUpState>;
  lastUpdated: string;
}

export interface SentRecord {
  threadId: string;
  sentAt: string; // ISO timestamp
}

export interface ThreadFollowUpState {
  followUpCount: number;
  lastFollowUpAt: string | null;
  ignored: boolean; // true if the last follow-up was ignored
}

// ── Configuration ────────────────────────────────────────────────────

const MAX_PROACTIVE_PER_DAY = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_FOLLOWUPS_PER_THREAD = 1;
const SEND_THRESHOLD = 7.0;
const NOTE_THRESHOLD = 4.0;

export function isShadowMode(): boolean {
  return process.env[`${identity.agentName.toUpperCase()}_PROACTIVE_SHADOW`] === 'true';
}

// ── State persistence ────────────────────────────────────────────────

function getStatePath(): string {
  return path.join(getMemoryPath(), 'proactive-state.json');
}

export function loadProactiveState(): ProactiveState {
  const filePath = getStatePath();
  try {
    if (!existsSync(filePath)) {
      return { sentToday: [], followUpsByThread: {}, lastUpdated: new Date().toISOString() };
    }
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'sentToday' in parsed &&
      Array.isArray((parsed as ProactiveState).sentToday)
    ) {
      return parsed as ProactiveState;
    }
    console.warn('[proactive] malformed proactive-state.json, returning empty state');
    return { sentToday: [], followUpsByThread: {}, lastUpdated: new Date().toISOString() };
  } catch {
    return { sentToday: [], followUpsByThread: {}, lastUpdated: new Date().toISOString() };
  }
}

export function saveProactiveState(state: ProactiveState): void {
  const filePath = getStatePath();
  const tmpPath = filePath + '.tmp';

  mkdirSync(path.dirname(filePath), { recursive: true });

  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp may not exist
    }
    throw err;
  }
}

// ── Rate limiting ────────────────────────────────────────────────────

/**
 * Prunes sentToday records older than 24 hours and returns the cleaned state.
 */
export function pruneSentRecords(state: ProactiveState, now: Date = new Date()): ProactiveState {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  state.sentToday = state.sentToday.filter((r) => new Date(r.sentAt).getTime() > cutoff);
  return state;
}

/**
 * Checks whether a proactive message can be sent right now.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function checkRateLimits(
  state: ProactiveState,
  threadId: string,
  now: Date = new Date(),
): { allowed: true } | { allowed: false; reason: string } {
  const cleaned = pruneSentRecords(state, now);

  // Daily cap
  if (cleaned.sentToday.length >= MAX_PROACTIVE_PER_DAY) {
    return { allowed: false, reason: `daily limit reached (${MAX_PROACTIVE_PER_DAY}/day)` };
  }

  // Minimum gap
  if (cleaned.sentToday.length > 0) {
    const lastSent = cleaned.sentToday.reduce((latest, r) => {
      const t = new Date(r.sentAt).getTime();
      return t > latest ? t : latest;
    }, 0);
    if (now.getTime() - lastSent < MIN_GAP_MS) {
      const remainingMin = Math.ceil((MIN_GAP_MS - (now.getTime() - lastSent)) / 60_000);
      return { allowed: false, reason: `minimum gap not met (${remainingMin}min remaining)` };
    }
  }

  // Per-thread limit
  const threadState = cleaned.followUpsByThread[threadId];
  if (threadState) {
    if (threadState.followUpCount >= MAX_FOLLOWUPS_PER_THREAD) {
      return { allowed: false, reason: `thread follow-up limit reached (${MAX_FOLLOWUPS_PER_THREAD} max)` };
    }
    if (threadState.ignored) {
      return { allowed: false, reason: 'previous follow-up on this thread was ignored' };
    }
  }

  return { allowed: true };
}

// ── LLM invocation for scoring ───────────────────────────────────────

export type ReflectionInvoker = (prompt: string) => Promise<string | null>;

let reflectionInvoker: ReflectionInvoker = defaultReflectionInvoker;

async function defaultReflectionInvoker(prompt: string): Promise<string | null> {
  try {
    const registry = getAdapterRegistry();
    const adapterName = resolveAdapterName(registry, 'reflection');
    const adapter = registry.get(adapterName);
    const route = resolveRoute('reflection');

    const input: AdapterInput = {
      message: prompt,
      history: [],
      systemPrompt: '',
      route,
      workspacePath: WORKSPACE_PATH,
      effectiveMode: route.mode,
    };

    const result = await adapter.invoke(input);

    if (result.error) {
      console.error(`[proactive] LLM adapter error: ${result.error.message}`);
      return null;
    }

    return result.text.trim() || null;
  } catch (err) {
    console.error(`[proactive] LLM invocation failed:`, err);
    return null;
  }
}

/** @internal Only for testing — inject a mock reflection invoker */
export function _setReflectionInvoker(invoker: ReflectionInvoker | null): void {
  reflectionInvoker = invoker ?? defaultReflectionInvoker;
}

// ── Significance scoring ─────────────────────────────────────────────

const SCORING_PROMPT = `You are evaluating whether a stale conversation thread deserves a proactive follow-up message from ${identity.agentNameDisplay} (an autonomous cognitive agent) to Chris (his human collaborator).

Score the thread on four dimensions (each 0-10):

1. **importance** (weight 40%): How much does this matter to Chris? Consider: Is it blocking other work? Does it have a deadline? Is it a commitment ${identity.agentNameDisplay} made?
2. **novelty** (weight 25%): Would a follow-up add value beyond what Chris already knows? A follow-up that just restates the thread topic scores low.
3. **timing** (weight 20%): Is now a good time to follow up? Consider how long the thread has been stale, whether it's business hours, and whether Chris seems busy.
4. **confidence** (weight 15%): How confident is ${identity.agentNameDisplay} that following up is the right call? Low confidence = uncertain whether this needs attention.

CRITICAL: Respond ONLY with valid JSON matching this exact schema (no markdown fencing, no extra text):
{
  "importance": <number 0-10>,
  "novelty": <number 0-10>,
  "timing": <number 0-10>,
  "confidence": <number 0-10>,
  "reasoning": "<one sentence explaining the score>",
  "draft_message": "<the follow-up message ${identity.agentNameDisplay} would send, or empty string if score is too low>"
}

Thread to evaluate:
`;

/**
 * Builds the scoring prompt for a thread.
 */
export function buildScoringPrompt(thread: Thread): string {
  const staleHours = Math.round(
    (Date.now() - new Date(thread.lastActivity).getTime()) / (1000 * 60 * 60),
  );

  return (
    SCORING_PROMPT +
    `- Topic: ${thread.topic}\n` +
    `- Status: ${thread.status}\n` +
    `- Last activity: ${thread.lastActivity} (${staleHours} hours ago)\n` +
    `- Message count: ${thread.messageCount}\n` +
    `- Participants: ${thread.participants.join(', ')}\n`
  );
}

/**
 * Parses the LLM's JSON response into a SignificanceScore.
 * Returns null if parsing fails.
 */
export function parseScoreResponse(raw: string): { score: SignificanceScore; draftMessage: string } | null {
  try {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const importance = Number(parsed.importance);
    const novelty = Number(parsed.novelty);
    const timing = Number(parsed.timing);
    const confidence = Number(parsed.confidence);
    const reasoning = String(parsed.reasoning ?? '');
    const draftMessage = String(parsed.draft_message ?? '');

    if ([importance, novelty, timing, confidence].some((n) => Number.isNaN(n) || n < 0 || n > 10)) {
      console.warn('[proactive] score out of range, rejecting');
      return null;
    }

    const weighted =
      importance * 0.4 +
      novelty * 0.25 +
      timing * 0.2 +
      confidence * 0.15;

    return {
      score: {
        importance,
        novelty,
        timing,
        confidence,
        weighted: Math.round(weighted * 100) / 100,
        reasoning,
      },
      draftMessage,
    };
  } catch (err) {
    console.warn('[proactive] failed to parse score response:', err);
    return null;
  }
}

/**
 * Determines the action based on the weighted score.
 */
export function determineAction(weighted: number): FollowUpAction {
  if (weighted >= SEND_THRESHOLD) return 'send';
  if (weighted >= NOTE_THRESHOLD) return 'note';
  return 'silence';
}

// ── Main evaluation pipeline ─────────────────────────────────────────

export interface EvaluationResult {
  threadId: string;
  topic: string;
  action: FollowUpAction;
  score: SignificanceScore | null;
  draft: FollowUpDraft | null;
  rateLimitReason: string | null;
  shadow: boolean;
}

/**
 * Evaluates a single thread for potential follow-up.
 * Returns an EvaluationResult describing what action should be taken.
 *
 * This is the core function the heartbeat's REFLECT phase calls.
 */
export async function evaluateThreadForFollowUp(
  thread: Thread,
): Promise<EvaluationResult> {
  const state = loadProactiveState();
  const shadow = isShadowMode();
  const now = new Date();

  // Check rate limits first (cheap, no LLM call)
  const rateCheck = checkRateLimits(state, thread.id, now);
  if (!rateCheck.allowed) {
    console.log(`[proactive] skipping thread="${thread.topic}": ${rateCheck.reason}`);
    return {
      threadId: thread.id,
      topic: thread.topic,
      action: 'silence',
      score: null,
      draft: null,
      rateLimitReason: rateCheck.reason,
      shadow,
    };
  }

  // Invoke LLM for significance scoring
  const prompt = buildScoringPrompt(thread);
  const llmResponse = await reflectionInvoker(prompt);

  if (!llmResponse) {
    console.warn(`[proactive] LLM returned no response for thread="${thread.topic}"`);
    return {
      threadId: thread.id,
      topic: thread.topic,
      action: 'silence',
      score: null,
      draft: null,
      rateLimitReason: null,
      shadow,
    };
  }

  const parsed = parseScoreResponse(llmResponse);
  if (!parsed) {
    console.warn(`[proactive] failed to parse LLM score for thread="${thread.topic}"`);
    return {
      threadId: thread.id,
      topic: thread.topic,
      action: 'silence',
      score: null,
      draft: null,
      rateLimitReason: null,
      shadow,
    };
  }

  const action = determineAction(parsed.score.weighted);

  const draft: FollowUpDraft | null =
    action === 'send' && parsed.draftMessage
      ? {
          threadId: thread.id,
          topic: thread.topic,
          message: parsed.draftMessage,
          score: parsed.score,
          draftedAt: now.toISOString(),
        }
      : null;

  console.log(
    `[proactive] thread="${thread.topic}" score=${parsed.score.weighted} action=${action}` +
      (shadow ? ' (shadow mode)' : ''),
  );

  return {
    threadId: thread.id,
    topic: thread.topic,
    action,
    score: parsed.score,
    draft,
    rateLimitReason: null,
    shadow,
  };
}

// ── Sending / recording ──────────────────────────────────────────────

/**
 * Callback type for sending a proactive message.
 * The heartbeat or bot wires in the actual Telegram send function.
 */
export type SendCallback = (chatId: number | string, message: string) => Promise<void>;

/**
 * Records that a follow-up was sent for a thread.
 * Updates rate limit state and per-thread tracking.
 */
export function recordFollowUpSent(threadId: string, now: Date = new Date()): void {
  const state = loadProactiveState();

  state.sentToday.push({ threadId, sentAt: now.toISOString() });

  if (!state.followUpsByThread[threadId]) {
    state.followUpsByThread[threadId] = { followUpCount: 0, lastFollowUpAt: null, ignored: false };
  }
  state.followUpsByThread[threadId].followUpCount++;
  state.followUpsByThread[threadId].lastFollowUpAt = now.toISOString();
  state.lastUpdated = now.toISOString();

  saveProactiveState(state);
}

/**
 * Records that a follow-up was ignored (Chris didn't respond).
 * Future follow-ups to this thread will be suppressed.
 */
export function recordFollowUpIgnored(threadId: string): void {
  const state = loadProactiveState();

  if (!state.followUpsByThread[threadId]) {
    state.followUpsByThread[threadId] = { followUpCount: 0, lastFollowUpAt: null, ignored: false };
  }
  state.followUpsByThread[threadId].ignored = true;
  state.lastUpdated = new Date().toISOString();

  saveProactiveState(state);
}

// ── Batch evaluation (heartbeat entry point) ─────────────────────────

/**
 * Evaluates all active threads for potential follow-ups.
 * Returns results for each thread. The heartbeat uses this to decide
 * which follow-ups to send (or log in shadow mode).
 *
 * Only evaluates threads that are not resolved and have been stale
 * for at least the minimum staleness threshold (default: 4 hours).
 */
export async function evaluateActiveThreads(
  minStaleHours: number = 4,
): Promise<EvaluationResult[]> {
  const threads = getActiveThreads();
  const now = Date.now();
  const minStaleMs = minStaleHours * 60 * 60 * 1000;

  // Filter to threads stale enough to consider
  const staleThreads = threads.filter((t) => {
    const age = now - new Date(t.lastActivity).getTime();
    return age >= minStaleMs;
  });

  if (staleThreads.length === 0) {
    return [];
  }

  console.log(`[proactive] evaluating ${staleThreads.length} stale threads`);

  const results: EvaluationResult[] = [];
  for (const thread of staleThreads) {
    const result = await evaluateThreadForFollowUp(thread);
    results.push(result);

    // Stop if we hit a rate limit — no point evaluating more threads
    if (result.rateLimitReason) {
      break;
    }
  }

  return results;
}
