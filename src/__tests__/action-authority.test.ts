import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyAction,
  requestAction,
  getDefaultTierMap,
  getActionLog,
  _resetActionLog,
} from '../autonomy/action-authority.js';
import type { ActionCategory, ActionTier, ActionRequest, TrustMetrics } from '../autonomy/types.js';

// ---------------------------------------------------------------------------
// classifyAction
// ---------------------------------------------------------------------------

describe('classifyAction', () => {
  it('classifies autonomous categories correctly', () => {
    const autonomousCategories: ActionCategory[] = [
      'workspace-read',
      'memory-write',
      'context-gather',
      'message-draft',
      'reflection',
    ];

    for (const category of autonomousCategories) {
      expect(classifyAction(category)).toBe('autonomous');
    }
  });

  it('classifies propose categories correctly', () => {
    const proposeCategories: ActionCategory[] = [
      'workspace-write',
      'workspace-file-create',
      'outbound-message',
      'project-decision',
    ];

    for (const category of proposeCategories) {
      expect(classifyAction(category)).toBe('propose');
    }
  });

  it('classifies restricted categories correctly', () => {
    const restrictedCategories: ActionCategory[] = [
      'file-delete',
      'external-api-side-effect',
      'financial-action',
    ];

    for (const category of restrictedCategories) {
      expect(classifyAction(category)).toBe('restricted');
    }
  });

  it('defaults to restricted for unknown categories', () => {
    const tier = classifyAction('unknown-category' as ActionCategory);
    expect(tier).toBe('restricted');
  });

  it('uses trust metrics scope override when provided', () => {
    const trustMetrics: TrustMetrics = {
      overallScore: 0.9,
      scopeMap: new Map<ActionCategory, ActionTier>([
        ['file-delete', 'propose'], // override restricted -> propose
      ]),
      signalHistory: [],
      lastUpdated: new Date(),
    };

    // With trust override, file-delete becomes propose instead of restricted
    expect(classifyAction('file-delete', trustMetrics)).toBe('propose');
  });

  it('falls back to default tier when trust metrics has no override for category', () => {
    const trustMetrics: TrustMetrics = {
      overallScore: 0.9,
      scopeMap: new Map<ActionCategory, ActionTier>([
        ['file-delete', 'propose'],
      ]),
      signalHistory: [],
      lastUpdated: new Date(),
    };

    // workspace-read not in scopeMap, so uses default
    expect(classifyAction('workspace-read', trustMetrics)).toBe('autonomous');
  });
});

// ---------------------------------------------------------------------------
// requestAction
// ---------------------------------------------------------------------------

describe('requestAction', () => {
  beforeEach(() => {
    _resetActionLog();
  });

  it('approves autonomous tier actions', async () => {
    const request: ActionRequest = {
      category: 'workspace-read',
      description: 'Read identity file',
      reasoning: 'Need to check current identity',
      tier: 'autonomous',
    };

    const result = await requestAction(request);

    expect(result.approved).toBe(true);
    expect(result.executedAt).toBeInstanceOf(Date);
    expect(result.reason).toBeUndefined();
  });

  it('denies propose tier actions with pending_proposal reason', async () => {
    const request: ActionRequest = {
      category: 'outbound-message',
      description: 'Send message to user',
      reasoning: 'User asked a question',
      tier: 'propose',
    };

    const result = await requestAction(request);

    expect(result.approved).toBe(false);
    expect(result.reason).toBe('pending_proposal');
    expect(result.executedAt).toBeUndefined();
  });

  it('denies restricted tier actions with restricted reason', async () => {
    const request: ActionRequest = {
      category: 'file-delete',
      description: 'Delete a workspace file',
      reasoning: 'Cleanup',
      tier: 'restricted',
    };

    const result = await requestAction(request);

    expect(result.approved).toBe(false);
    expect(result.reason).toBe('restricted');
    expect(result.executedAt).toBeUndefined();
  });

  it('records action in the action log', async () => {
    const request: ActionRequest = {
      category: 'workspace-read',
      description: 'Read journal',
      reasoning: 'Check recent entries',
      tier: 'autonomous',
    };

    await requestAction(request);

    const log = getActionLog();
    expect(log).toHaveLength(1);
    expect(log[0].category).toBe('workspace-read');
    expect(log[0].tier).toBe('autonomous');
    expect(log[0].approved).toBe(true);
    expect(log[0].description).toBe('Read journal');
    expect(log[0].timestamp).toBeInstanceOf(Date);
  });

  it('records denied actions in the log', async () => {
    const request: ActionRequest = {
      category: 'financial-action',
      description: 'Transfer funds',
      reasoning: 'User requested',
      tier: 'restricted',
    };

    await requestAction(request);

    const log = getActionLog();
    expect(log).toHaveLength(1);
    expect(log[0].approved).toBe(false);
    expect(log[0].reason).toBe('restricted');
  });

  it('accumulates multiple log entries', async () => {
    await requestAction({
      category: 'workspace-read',
      description: 'Read file 1',
      reasoning: 'Need data',
      tier: 'autonomous',
    });

    await requestAction({
      category: 'outbound-message',
      description: 'Send message',
      reasoning: 'Reply to user',
      tier: 'propose',
    });

    await requestAction({
      category: 'file-delete',
      description: 'Delete file',
      reasoning: 'Cleanup',
      tier: 'restricted',
    });

    const log = getActionLog();
    expect(log).toHaveLength(3);
    expect(log[0].approved).toBe(true);
    expect(log[1].approved).toBe(false);
    expect(log[2].approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getDefaultTierMap
// ---------------------------------------------------------------------------

describe('getDefaultTierMap', () => {
  it('returns all 12 action categories', () => {
    const tierMap = getDefaultTierMap();
    expect(tierMap.size).toBe(12);
  });

  it('returns a copy (not the internal map)', () => {
    const map1 = getDefaultTierMap();
    const map2 = getDefaultTierMap();

    // Modifying one should not affect the other
    map1.set('workspace-read', 'restricted');
    expect(map2.get('workspace-read')).toBe('autonomous');
  });

  it('contains all expected categories', () => {
    const tierMap = getDefaultTierMap();
    const expectedCategories: ActionCategory[] = [
      'workspace-read',
      'workspace-write',
      'memory-write',
      'context-gather',
      'message-draft',
      'reflection',
      'workspace-file-create',
      'outbound-message',
      'project-decision',
      'file-delete',
      'external-api-side-effect',
      'financial-action',
    ];

    for (const cat of expectedCategories) {
      expect(tierMap.has(cat)).toBe(true);
    }
  });

  it('maps categories to expected tiers', () => {
    const tierMap = getDefaultTierMap();

    expect(tierMap.get('workspace-read')).toBe('autonomous');
    expect(tierMap.get('workspace-write')).toBe('propose');
    expect(tierMap.get('file-delete')).toBe('restricted');
  });
});

// ---------------------------------------------------------------------------
// Action log reset
// ---------------------------------------------------------------------------

describe('action log management', () => {
  beforeEach(() => {
    _resetActionLog();
  });

  it('_resetActionLog clears all entries', async () => {
    await requestAction({
      category: 'workspace-read',
      description: 'Read file',
      reasoning: 'Need info',
      tier: 'autonomous',
    });

    expect(getActionLog()).toHaveLength(1);

    _resetActionLog();

    expect(getActionLog()).toHaveLength(0);
  });

  it('getActionLog returns a copy of the log', async () => {
    await requestAction({
      category: 'workspace-read',
      description: 'Read file',
      reasoning: 'Need info',
      tier: 'autonomous',
    });

    const log1 = getActionLog();
    const log2 = getActionLog();

    // They should be equal but different array instances
    expect(log1).toEqual(log2);
    expect(log1).not.toBe(log2);
  });
});
