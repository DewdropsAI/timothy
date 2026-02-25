/** Permission level that determines how an action is handled. */
export type ActionTier = 'autonomous' | 'propose' | 'restricted';

/** Category of action that Titus can perform, used to determine its tier. */
export type ActionCategory =
  | 'workspace-read'
  | 'workspace-write'
  | 'memory-write'
  | 'context-gather'
  | 'message-draft'
  | 'reflection'
  | 'workspace-file-create'
  | 'outbound-message'
  | 'project-decision'
  | 'file-delete'
  | 'external-api-side-effect'
  | 'financial-action';

/** A request for Titus to perform an action, including classification and justification. */
export interface ActionRequest {
  category: ActionCategory;
  description: string;
  reasoning: string;
  tier: ActionTier;
  payload?: Record<string, unknown>;
}

/** Outcome of an action request after enforcement. */
export interface ActionResult {
  approved: boolean;
  executedAt?: Date;
  vetoedBy?: string;
  reason?: string;
}

/** Signal from Chris's interaction that affects trust scoring. */
export type TrustSignal = 'engaged' | 'acknowledged' | 'ignored' | 'overridden' | 'rejected';

/** Aggregate trust state including score, scope overrides, and signal history. */
export interface TrustMetrics {
  overallScore: number;  // 0.0 to 1.0
  scopeMap: Map<ActionCategory, ActionTier>;
  signalHistory: Array<{ signal: TrustSignal; context: string; timestamp: Date }>;
  lastUpdated: Date;
}

/** A proposed action awaiting Chris's approval or rejection. */
export interface ProposalEntry {
  id: string;
  action: ActionRequest;
  proposedAt: Date;
  status: 'pending' | 'approved' | 'rejected';
  titusReasoning: string;
  chrisResponse?: string;
}

/** Runtime state of the cognitive loop, exposed for observability. */
export interface CognitiveLoopState {
  isRunning: boolean;
  lastEvaluation: Date | null;
  nextEvaluationAt: Date | null;
  intervalMs: number;
  attentionState: AttentionState | null;
}

/** Snapshot of what Titus is paying attention to, used to compute urgency. */
export interface AttentionState {
  concerns: string[];
  urgencyLevel: number;  // 0.0 to 1.0
  timeSinceLastReflection: number;  // ms
  chrisActivityRecency: number;  // ms since last Chris activity
  pendingProposals: number;
  trustScoreChange: number;  // delta since last check
}
