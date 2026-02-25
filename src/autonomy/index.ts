/**
 * Autonomy module — action classification, trust scoring, proposal queue,
 * action logging, and the cognitive loop that drives self-invocation.
 * @module autonomy
 */

export {
  CognitiveLoop,
  parseConcerns,
  computeUrgencyScore,
  type AttentionState,
  type Concern,
  type CognitiveLoopConfig,
} from './cognitive-loop.js';

export {
  classifyAction,
  requestAction,
  getDefaultTierMap,
  getActionLog,
  _setActionLog,
  _resetActionLog,
  type ActionLogEntry,
} from './action-authority.js';

export {
  type ActionTier,
  type ActionCategory,
  type ActionRequest,
  type ActionResult,
  type TrustSignal,
  type TrustMetrics,
  type ProposalEntry,
  type CognitiveLoopState,
  type AttentionState as AutonomyAttentionState,
} from './types.js';

export {
  TrustManager,
  type TrustSignalInput,
  type TrustSignalRecord,
  type TrustSignalType,
  type TrustState,
} from './trust-metrics.js';

export {
  ProposalQueue,
  type Proposal,
  type ProposalAction,
  type ProposalInput,
  type ProposalStatus,
} from './proposal-queue.js';

export {
  ActionLog,
  type ActionLogEntry as FileActionLogEntry,
  type ActionOutcome,
} from './action-log.js';
