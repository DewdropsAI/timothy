import type { ActionTier, ActionCategory, ActionRequest, ActionResult, TrustMetrics } from './types.js';

// ── Default tier mapping ──────────────────────────────────────────────

const DEFAULT_TIER_MAP: Map<ActionCategory, ActionTier> = new Map([
  // Autonomous (default: act without asking)
  ['workspace-read', 'autonomous'],
  ['memory-write', 'autonomous'],
  ['context-gather', 'autonomous'],
  ['message-draft', 'autonomous'],
  ['reflection', 'autonomous'],
  // Propose (draft and present for approval)
  ['workspace-write', 'propose'],
  ['workspace-file-create', 'propose'],
  ['outbound-message', 'propose'],
  ['project-decision', 'propose'],
  // Restricted (never autonomous, structurally blocked)
  ['file-delete', 'restricted'],
  ['external-api-side-effect', 'restricted'],
  ['financial-action', 'restricted'],
]);

// ── Action log ────────────────────────────────────────────────────────

/** Record of an action that passed through the authority enforcement pipeline. */
export interface ActionLogEntry {
  category: ActionCategory;
  tier: ActionTier;
  description: string;
  approved: boolean;
  reason?: string;
  timestamp: Date;
}

let actionLog: ActionLogEntry[] = [];
let logFn: ((entry: ActionLogEntry) => void) | null = null;

function appendLog(entry: ActionLogEntry): void {
  if (logFn) {
    logFn(entry);
  }
  actionLog.push(entry);
}

/**
 * Returns a copy of the action log entries.
 * @returns Shallow copy of all recorded action log entries.
 */
export function getActionLog(): ActionLogEntry[] {
  return [...actionLog];
}

/**
 * @internal Test helper — inject a mock action logger.
 */
export function _setActionLog(fn: (entry: ActionLogEntry) => void): void {
  logFn = fn;
}

/**
 * @internal Test helper — clear the action log and reset the custom logger.
 */
export function _resetActionLog(): void {
  actionLog = [];
  logFn = null;
}

// ── Classification ────────────────────────────────────────────────────

/**
 * Returns the tier for an action category. If trust metrics are provided
 * and include a scope override for the category, that override wins.
 * Unknown categories default to 'restricted' (conservative).
 * @param category - The action category to classify.
 * @param trustMetrics - Optional trust metrics with scope overrides.
 * @returns The action tier for the given category.
 */
export function classifyAction(
  category: ActionCategory,
  trustMetrics?: TrustMetrics,
): ActionTier {
  // Trust metrics scope overrides take precedence
  if (trustMetrics?.scopeMap.has(category)) {
    return trustMetrics.scopeMap.get(category)!;
  }

  return DEFAULT_TIER_MAP.get(category) ?? 'restricted';
}

// ── Enforcement entry point ───────────────────────────────────────────

/**
 * Enforcement entry point for action requests.
 *
 * - `autonomous`: log the action and return approved.
 * - `propose`: return not-approved with reason 'pending_proposal' (caller adds to proposal queue).
 * - `restricted`: structurally blocked -- always returns not-approved. There is NO code path
 *   that executes a restricted action.
 *
 * @param request - The action request to evaluate.
 * @returns The action result indicating approval or rejection.
 */
export async function requestAction(request: ActionRequest): Promise<ActionResult> {
  const entry: ActionLogEntry = {
    category: request.category,
    tier: request.tier,
    description: request.description,
    approved: false,
    timestamp: new Date(),
  };

  switch (request.tier) {
    case 'autonomous': {
      entry.approved = true;
      appendLog(entry);
      return { approved: true, executedAt: new Date() };
    }
    case 'propose': {
      entry.reason = 'pending_proposal';
      appendLog(entry);
      return { approved: false, reason: 'pending_proposal' };
    }
    case 'restricted': {
      entry.reason = 'restricted';
      appendLog(entry);
      return { approved: false, reason: 'restricted' };
    }
  }
}

// ── Default map accessor ──────────────────────────────────────────────

/**
 * Returns a copy of the default tier map.
 * @returns A new Map of action categories to their default tiers.
 */
export function getDefaultTierMap(): Map<ActionCategory, ActionTier> {
  return new Map(DEFAULT_TIER_MAP);
}
