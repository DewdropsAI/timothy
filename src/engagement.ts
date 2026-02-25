import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

let stateFilePath = path.resolve(PROJECT_ROOT, 'workspace', 'memory', 'engagement-state.json');

/** @internal Only for testing */
export function _setStateFilePath(filePath: string): void {
  stateFilePath = filePath;
}

export function getStateFilePath(): string {
  return stateFilePath;
}

// --- Types ---

export type Outcome = 'engaged' | 'acknowledged' | 'ignored' | 'rejected';

export interface OutcomeRecord {
  messageId: string;
  behaviorType: string;
  outcome: Outcome;
  timestamp: string;
}

export interface BehaviorProfile {
  behaviorType: string;
  total: number;
  engaged: number;
  acknowledged: number;
  ignored: number;
  rejected: number;
  engagementRate: number;
  consecutiveRejections: number;
  suppressed: boolean;
  suppressionReason: string | null;
}

export interface EngagementState {
  outcomes: OutcomeRecord[];
}

// --- Thresholds ---

/** Engagement rate below this triggers frequency reduction */
export const LOW_ENGAGEMENT_THRESHOLD = 0.20;

/** Number of consecutive rejections that disables a behavior */
export const REJECTION_DISABLE_THRESHOLD = 2;

/** Maximum number of outcome records to retain (oldest are pruned) */
export const MAX_OUTCOME_RECORDS = 500;

// --- State persistence ---

/**
 * Loads engagement state from disk.
 * Returns a fresh empty state if the file doesn't exist or is malformed.
 */
export function loadState(): EngagementState {
  try {
    const raw = readFileSync(stateFilePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.outcomes)) {
      return parsed as EngagementState;
    }
  } catch {
    // File missing or malformed — start fresh
  }
  return { outcomes: [] };
}

/**
 * Saves engagement state to disk using atomic tmp+rename.
 * Creates parent directories if needed.
 */
export function saveState(state: EngagementState): void {
  const dir = path.dirname(stateFilePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = stateFilePath + '.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, stateFilePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp may not exist
    }
    throw err;
  }
}

// --- Core API ---

/**
 * Records the outcome of a proactive message.
 * Appends to the outcomes list, prunes old records if over MAX_OUTCOME_RECORDS,
 * and persists to disk.
 */
export function recordOutcome(
  messageId: string,
  behaviorType: string,
  outcome: Outcome,
): void {
  const state = loadState();

  state.outcomes.push({
    messageId,
    behaviorType,
    outcome,
    timestamp: new Date().toISOString(),
  });

  // Prune oldest records if over limit
  if (state.outcomes.length > MAX_OUTCOME_RECORDS) {
    state.outcomes = state.outcomes.slice(state.outcomes.length - MAX_OUTCOME_RECORDS);
  }

  saveState(state);
}

/**
 * Computes the engagement profile for a specific behavior type.
 * Returns aggregated stats including engagement rate and suppression status.
 *
 * Engagement rate = (engaged + acknowledged) / total.
 * "engaged" means Chris responded substantively. "acknowledged" means he reacted
 * but didn't engage deeply. Both count as positive signals.
 */
export function getEngagementProfile(behaviorType: string): BehaviorProfile {
  const state = loadState();
  const records = state.outcomes.filter((r) => r.behaviorType === behaviorType);

  const counts = { engaged: 0, acknowledged: 0, ignored: 0, rejected: 0 };
  for (const r of records) {
    counts[r.outcome]++;
  }

  const total = records.length;
  const engagementRate = total === 0 ? 1.0 : (counts.engaged + counts.acknowledged) / total;

  // Count consecutive rejections from the end
  let consecutiveRejections = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].outcome === 'rejected') {
      consecutiveRejections++;
    } else {
      break;
    }
  }

  const { suppressed, suppressionReason } = evaluateSuppression(
    engagementRate,
    consecutiveRejections,
    total,
  );

  return {
    behaviorType,
    total,
    ...counts,
    engagementRate,
    consecutiveRejections,
    suppressed,
    suppressionReason,
  };
}

/**
 * Returns true if a behavior type should be suppressed based on engagement data.
 * Suppression happens when:
 * - Engagement rate drops below 20% (with at least 5 data points)
 * - 2+ consecutive rejections
 */
export function shouldSuppress(behaviorType: string): boolean {
  return getEngagementProfile(behaviorType).suppressed;
}

/**
 * Returns all behavior types that have at least one recorded outcome.
 */
export function listTrackedBehaviors(): string[] {
  const state = loadState();
  const types = new Set<string>();
  for (const r of state.outcomes) {
    types.add(r.behaviorType);
  }
  return [...types].sort();
}

/**
 * Generates a human-readable explanation of engagement-based adaptation.
 * Used when the agent tells Chris it's adjusting behavior.
 * Returns null if no adaptation is in effect for the given behavior.
 */
export function explainAdaptation(behaviorType: string): string | null {
  const profile = getEngagementProfile(behaviorType);

  if (!profile.suppressed) {
    return null;
  }

  const label = behaviorType.replace(/-/g, ' ');

  if (profile.consecutiveRejections >= REJECTION_DISABLE_THRESHOLD) {
    return (
      `I've stopped sending ${label} messages — you've declined the last ` +
      `${profile.consecutiveRejections} in a row. I'll resume if you ask me to.`
    );
  }

  if (profile.total >= 5 && profile.engagementRate < LOW_ENGAGEMENT_THRESHOLD) {
    const pct = Math.round(profile.engagementRate * 100);
    return (
      `I'm pulling back on ${label} messages — only ${pct}% have landed well ` +
      `(${profile.engaged + profile.acknowledged} out of ${profile.total}). ` +
      `I'll recalibrate as I learn what's useful.`
    );
  }

  return null;
}

/**
 * Resets engagement data for a specific behavior type.
 * Used when Chris explicitly asks the agent to resume a suppressed behavior.
 */
export function resetBehavior(behaviorType: string): void {
  const state = loadState();
  state.outcomes = state.outcomes.filter((r) => r.behaviorType !== behaviorType);
  saveState(state);
}

// --- Internal helpers ---

function evaluateSuppression(
  engagementRate: number,
  consecutiveRejections: number,
  total: number,
): { suppressed: boolean; suppressionReason: string | null } {
  if (consecutiveRejections >= REJECTION_DISABLE_THRESHOLD) {
    return {
      suppressed: true,
      suppressionReason: `${consecutiveRejections} consecutive rejections`,
    };
  }

  if (total >= 5 && engagementRate < LOW_ENGAGEMENT_THRESHOLD) {
    const pct = Math.round(engagementRate * 100);
    return {
      suppressed: true,
      suppressionReason: `engagement rate ${pct}% (below ${Math.round(LOW_ENGAGEMENT_THRESHOLD * 100)}% threshold)`,
    };
  }

  return { suppressed: false, suppressionReason: null };
}
