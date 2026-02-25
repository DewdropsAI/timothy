import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkingMemory } from '../memory.js';
import { getActiveThreads } from '../threads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const WORKSPACE_PATH = path.resolve(PROJECT_ROOT, 'workspace');

// ── Types ────────────────────────────────────────────────────────────

/** A concern parsed from workspace/concerns.md. */
export interface Concern {
  text: string;
  priority: 'active' | 'radar';
}

/** Time-of-day context for rhythm-based reflection timing. */
export interface TimeContext {
  period: 'morning' | 'daytime' | 'evening' | 'night';
  isQuietPeriod: boolean;  // true when user hasn't messaged in >4 hours
  hourOfDay: number;       // 0-23
}

/** Snapshot of attention factors gathered from workspace state. */
export interface AttentionState {
  concerns: Concern[];
  timeSinceLastReflection: number;
  timeSinceLastUserMessage: number;
  pendingActionsCount: number;
  urgencyScore: number;
  timeContext: TimeContext;
}

/** Configuration for the cognitive loop's timing and urgency thresholds. */
export interface CognitiveLoopConfig {
  minIntervalMs: number;       // Minimum time between evaluations (default 60s)
  maxIntervalMs: number;       // Maximum time between evaluations (default 15min)
  urgencyThreshold: number;    // Score above which self-invocation triggers
  workspacePath?: string;      // Override workspace path (for testing)
}

const DEFAULT_CONFIG: CognitiveLoopConfig = {
  minIntervalMs: 60_000,
  maxIntervalMs: 900_000,
  urgencyThreshold: 0.6,
};

// ── Concern parsing ──────────────────────────────────────────────────

/**
 * Parses workspace/concerns.md into structured concerns.
 * Handles the format with **Active:** and **On my radar:** sections.
 * @param content - Raw markdown content of concerns.md.
 * @returns Parsed concerns with priority classification.
 */
export function parseConcerns(content: string): Concern[] {
  const concerns: Concern[] = [];
  let currentPriority: 'active' | 'radar' = 'active';

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (/\*\*active/i.test(trimmed)) {
      currentPriority = 'active';
      continue;
    }
    if (/\*\*on my radar/i.test(trimmed)) {
      currentPriority = 'radar';
      continue;
    }

    if (trimmed.startsWith('- ')) {
      concerns.push({
        text: trimmed.slice(2).trim(),
        priority: currentPriority,
      });
    }
  }

  return concerns;
}

/**
 * Loads and parses concerns from workspace/concerns.md.
 * Returns empty array if file doesn't exist.
 */
async function loadConcerns(workspacePath: string): Promise<Concern[]> {
  try {
    const content = await readFile(path.join(workspacePath, 'concerns.md'), 'utf-8');
    return parseConcerns(content);
  } catch {
    return [];
  }
}

// ── Time context ─────────────────────────────────────────────────────

/**
 * Computes a TimeContext for rhythm-based reflection timing.
 * Pure function — accepts a Date and quiet-period flag for testability.
 *
 * Period definitions (user's local time):
 *   morning: 6-10, daytime: 10-18, evening: 18-23, night: 23-6
 *
 * @param now - The current date/time (defaults to new Date()).
 * @param timeSinceLastUserMessageMs - Milliseconds since the last user message (Infinity if none).
 * @returns TimeContext with period, quiet-period flag, and hour of day.
 */
export function getTimeContext(
  now: Date = new Date(),
  timeSinceLastUserMessageMs: number = Infinity,
): TimeContext {
  const hour = now.getHours();

  let period: TimeContext['period'];
  if (hour >= 6 && hour < 10) {
    period = 'morning';
  } else if (hour >= 10 && hour < 18) {
    period = 'daytime';
  } else if (hour >= 18 && hour < 23) {
    period = 'evening';
  } else {
    period = 'night';
  }

  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const isQuietPeriod = timeSinceLastUserMessageMs > FOUR_HOURS_MS;

  return { period, isQuietPeriod, hourOfDay: hour };
}

// ── Substantive content check ────────────────────────────────────────

/**
 * Returns a count of substantive items in working memory content.
 * Checks for list items and meaningful paragraphs (mirrors reflection.ts logic).
 */
function countSubstantiveItems(content: string): number {
  let count = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed === '---') continue;
    if (/^\(.*\)$/.test(trimmed)) continue;
    if (/^[a-z]+:/.test(trimmed)) continue;
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('1.')) {
      count++;
    } else if (trimmed.length > 20 && !trimmed.includes(':')) {
      count++;
    }
  }
  return count;
}

// ── Urgency scoring ──────────────────────────────────────────────────

/**
 * Computes an urgency score from 0.0 to 1.0 based on attention state.
 * Pure heuristic -- no LLM calls.
 *
 * Factors:
 * - Active concerns: 0.15 each (max 0.45)
 * - Pending actions: 0.2 per item (max 0.4)
 * - Time since last reflection: ramps from 0 to 0.15 over maxInterval
 * - Stale threads: 0.1 if any active thread is >2h old
 *
 * Rhythm bonuses (when TimeContext is provided):
 * - Morning period: +0.15 if timeSinceLastReflection > 6 hours (morning review)
 * - Evening period: +0.10 if timeSinceLastReflection > 4 hours (evening review)
 * - Quiet period:   +0.10 (good time to think)
 * - Night period:   -0.15 (suppress reflections during sleep hours unless urgency is already high)
 *
 * @param concerns - Parsed concerns from workspace.
 * @param pendingActionsCount - Number of pending action items.
 * @param timeSinceLastReflectionMs - Milliseconds since last evaluation.
 * @param maxIntervalMs - Maximum evaluation interval for time-pressure scaling.
 * @param hasStaleThreads - Whether any active thread is older than 2 hours.
 * @param timeContext - Optional time-of-day context for rhythm bonuses.
 * @returns Urgency score clamped to [0.0, 1.0].
 */
export function computeUrgencyScore(
  concerns: Concern[],
  pendingActionsCount: number,
  timeSinceLastReflectionMs: number,
  maxIntervalMs: number,
  hasStaleThreads: boolean,
  timeContext?: TimeContext,
): number {
  let score = 0;

  // Active concerns (capped at 3 contributing)
  const activeConcerns = concerns.filter(c => c.priority === 'active');
  score += Math.min(activeConcerns.length, 3) * 0.15;

  // Pending actions (capped at 2 contributing)
  score += Math.min(pendingActionsCount, 2) * 0.2;

  // Time pressure — ramp linearly over maxInterval
  if (maxIntervalMs > 0) {
    const timeRatio = Math.min(timeSinceLastReflectionMs / maxIntervalMs, 1.0);
    score += timeRatio * 0.15;
  }

  // Stale threads
  if (hasStaleThreads) {
    score += 0.1;
  }

  // Rhythm bonuses (only when TimeContext is provided)
  if (timeContext) {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

    if (timeContext.period === 'morning' && timeSinceLastReflectionMs > SIX_HOURS_MS) {
      score += 0.15;
    }

    if (timeContext.period === 'evening' && timeSinceLastReflectionMs > FOUR_HOURS_MS) {
      score += 0.10;
    }

    if (timeContext.isQuietPeriod) {
      score += 0.10;
    }

    if (timeContext.period === 'night') {
      score -= 0.15;
    }
  }

  return Math.max(0, Math.min(score, 1.0));
}

// ── CognitiveLoop class ─────────────────────────────────────────────

/**
 * Periodic evaluation loop that decides when Titus should self-invoke a reflection.
 * Reads workspace state, computes urgency, and triggers the callback when the threshold is met.
 */
export class CognitiveLoop {
  private config: CognitiveLoopConfig;
  private onSelfInvoke: (reason: string) => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastEvaluationTime = 0;
  private lastUserMessageTime = 0;
  private workspacePath: string;

  /**
   * @param config - Partial config merged with defaults.
   * @param onSelfInvoke - Callback invoked when urgency exceeds the threshold.
   */
  constructor(
    config: Partial<CognitiveLoopConfig>,
    onSelfInvoke: (reason: string) => Promise<void>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onSelfInvoke = onSelfInvoke;
    this.workspacePath = this.config.workspacePath ?? WORKSPACE_PATH;
  }

  /** Starts the periodic evaluation loop. */
  start(): void {
    if (this.running) {
      console.warn('[cognitive-loop] already running');
      return;
    }

    this.running = true;
    console.log(
      `[cognitive-loop] starting (min=${this.config.minIntervalMs}ms, ` +
      `max=${this.config.maxIntervalMs}ms, threshold=${this.config.urgencyThreshold})`
    );

    this.scheduleNext(this.config.minIntervalMs);
  }

  /** Stops the evaluation loop and clears the pending timer. */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[cognitive-loop] stopped');
  }

  /**
   * Records that a user message was received.
   * Used for timeSinceLastUserMessage in attention evaluation.
   */
  recordUserMessage(): void {
    this.lastUserMessageTime = Date.now();
  }

  /**
   * Gathers attention state from workspace and conversation state.
   * Zero LLM cost -- reads files and computes heuristics.
   * @returns Snapshot of current attention factors and computed urgency.
   */
  async evaluateAttention(): Promise<AttentionState> {
    const now = Date.now();
    const concerns = await loadConcerns(this.workspacePath);
    const workingMemory = await loadWorkingMemory();

    // Count pending action items
    const pendingFile = workingMemory.find(f => f.name === 'pending-actions.md');
    const pendingActionsCount = pendingFile ? countSubstantiveItems(pendingFile.content) : 0;

    // Check for stale threads (>2h inactive)
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const activeThreads = getActiveThreads();
    const hasStaleThreads = activeThreads.some(t => {
      return now - new Date(t.lastActivity).getTime() > TWO_HOURS_MS;
    });

    const timeSinceLastReflection = this.lastEvaluationTime > 0
      ? now - this.lastEvaluationTime
      : this.config.maxIntervalMs; // Treat first run as maximally stale

    const timeSinceLastUserMessage = this.lastUserMessageTime > 0
      ? now - this.lastUserMessageTime
      : Infinity;

    const timeContext = getTimeContext(new Date(now), timeSinceLastUserMessage);

    const urgencyScore = computeUrgencyScore(
      concerns,
      pendingActionsCount,
      timeSinceLastReflection,
      this.config.maxIntervalMs,
      hasStaleThreads,
      timeContext,
    );

    return {
      concerns,
      timeSinceLastReflection,
      timeSinceLastUserMessage,
      pendingActionsCount,
      urgencyScore,
      timeContext,
    };
  }

  /**
   * Determines whether the system should invoke a reflection cycle.
   * Pure heuristic -- no LLM calls.
   * @param state - Current attention state from evaluateAttention().
   * @returns True if urgency meets or exceeds the configured threshold.
   */
  shouldThink(state: AttentionState): boolean {
    return state.urgencyScore >= this.config.urgencyThreshold;
  }

  /** @internal For testing */
  isRunning(): boolean {
    return this.running;
  }

  /** @internal For testing */
  _setLastEvaluationTime(time: number): void {
    this.lastEvaluationTime = time;
  }

  /** @internal For testing */
  _setLastUserMessageTime(time: number): void {
    this.lastUserMessageTime = time;
  }

  // ── Private ──────────────────────────────────────────────────────

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;

    this.timer = setTimeout(async () => {
      if (!this.running) return;

      try {
        const state = await this.evaluateAttention();
        this.lastEvaluationTime = Date.now();

        if (this.shouldThink(state)) {
          const reason = this.buildReason(state);
          console.log(`[cognitive-loop] self-invoking: ${reason}`);

          try {
            await this.onSelfInvoke(reason);
          } catch (err) {
            console.error('[cognitive-loop] self-invocation failed:', err);
          }
        } else {
          console.log(
            `[cognitive-loop] tick: urgency=${state.urgencyScore.toFixed(2)} ` +
            `(threshold=${this.config.urgencyThreshold}), skipping`
          );
        }

        // Adapt interval based on urgency
        const nextDelay = this.adaptInterval(state.urgencyScore);
        this.scheduleNext(nextDelay);
      } catch (err) {
        console.error('[cognitive-loop] evaluation error:', err);
        // On error, schedule at max interval
        this.scheduleNext(this.config.maxIntervalMs);
      }
    }, delayMs);

    this.timer.unref();
  }

  /**
   * Adapts the next evaluation interval based on current urgency.
   * Higher urgency = shorter interval (more frequent checks).
   */
  private adaptInterval(urgency: number): number {
    const { minIntervalMs, maxIntervalMs } = this.config;
    // Linear interpolation: urgency 0 -> maxInterval, urgency 1 -> minInterval
    const range = maxIntervalMs - minIntervalMs;
    return Math.round(maxIntervalMs - urgency * range);
  }

  private buildReason(state: AttentionState): string {
    const parts: string[] = [];

    const activeConcerns = state.concerns.filter(c => c.priority === 'active');
    if (activeConcerns.length > 0) {
      parts.push(`${activeConcerns.length} active concern(s)`);
    }
    if (state.pendingActionsCount > 0) {
      parts.push(`${state.pendingActionsCount} pending action(s)`);
    }
    if (state.urgencyScore >= this.config.urgencyThreshold) {
      parts.push(`urgency=${state.urgencyScore.toFixed(2)}`);
    }

    // Rhythm context
    const tc = state.timeContext;
    if (tc) {
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

      if (tc.period === 'morning' && state.timeSinceLastReflection > SIX_HOURS_MS) {
        parts.push('morning review');
      }
      if (tc.period === 'evening' && state.timeSinceLastReflection > FOUR_HOURS_MS) {
        parts.push('evening review');
      }
      if (tc.isQuietPeriod) {
        parts.push('quiet period');
      }
    }

    return parts.length > 0 ? parts.join(', ') : 'periodic evaluation';
  }
}
