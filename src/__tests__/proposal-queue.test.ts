import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { createTestWorkspace } from './helpers/test-workspace.js';
import type { TestWorkspace } from './helpers/test-workspace.js';

// NOTE: proposal-queue.ts is a new module being built. These tests define
// the expected interface (TDD style). They will fail until implementation
// is complete.

// ---------------------------------------------------------------------------
// ProposalQueue: enqueue/list/resolve lifecycle
// ---------------------------------------------------------------------------

describe('ProposalQueue lifecycle', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('starts with empty queue', async () => {
    const { ProposalQueue } = await import('../autonomy/proposal-queue.js');

    const queue = new ProposalQueue(ws.path);
    await queue.load();

    expect(queue.list()).toEqual([]);
    expect(queue.pendingCount()).toBe(0);
  });

  it('enqueue adds a proposal to the queue', async () => {
    const { ProposalQueue } = await import('../autonomy/proposal-queue.js');

    const queue = new ProposalQueue(ws.path);
    await queue.load();

    const id = queue.enqueue({
      action: { type: 'send-message', target: 'telegram:12345' },
      reason: 'Chris might want to know about the deployment status',
      context: 'Deployment completed successfully',
    });

    expect(typeof id).toBe('string');
    expect(queue.pendingCount()).toBe(1);
  });

  it('list returns all pending proposals', async () => {
    const { ProposalQueue } = await import('../autonomy/proposal-queue.js');

    const queue = new ProposalQueue(ws.path);
    await queue.load();

    queue.enqueue({
      action: { type: 'send-message', target: 'telegram:12345' },
      reason: 'Notification about deployment',
      context: 'Deploy complete',
    });

    queue.enqueue({
      action: { type: 'send-message', target: 'telegram:67890' },
      reason: 'Follow up on earlier question',
      context: 'Research complete',
    });

    const proposals = queue.list();
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toHaveProperty('id');
    expect(proposals[0]).toHaveProperty('action');
    expect(proposals[0]).toHaveProperty('reason');
    expect(proposals[0]).toHaveProperty('status', 'pending');
  });

  it('resolve marks a proposal as approved or rejected', async () => {
    const { ProposalQueue } = await import('../autonomy/proposal-queue.js');

    const queue = new ProposalQueue(ws.path);
    await queue.load();

    const id = queue.enqueue({
      action: { type: 'send-message', target: 'telegram:12345' },
      reason: 'Test proposal',
      context: 'Test context',
    });

    queue.resolve(id, 'approved');

    const proposals = queue.list();
    expect(proposals[0].status).toBe('approved');
    expect(queue.pendingCount()).toBe(0);
  });

  it('resolve with rejected marks proposal as rejected', async () => {
    const { ProposalQueue } = await import('../autonomy/proposal-queue.js');

    const queue = new ProposalQueue(ws.path);
    await queue.load();

    const id = queue.enqueue({
      action: { type: 'send-message', target: 'telegram:12345' },
      reason: 'Test proposal',
      context: 'Test context',
    });

    queue.resolve(id, 'rejected');

    const proposals = queue.list();
    expect(proposals[0].status).toBe('rejected');
  });

  it('pendingCount only counts unresolved proposals', async () => {
    const { ProposalQueue } = await import('../autonomy/proposal-queue.js');

    const queue = new ProposalQueue(ws.path);
    await queue.load();

    const id1 = queue.enqueue({
      action: { type: 'send-message', target: 'telegram:1' },
      reason: 'First',
      context: '',
    });

    queue.enqueue({
      action: { type: 'send-message', target: 'telegram:2' },
      reason: 'Second',
      context: '',
    });

    expect(queue.pendingCount()).toBe(2);

    queue.resolve(id1, 'approved');

    expect(queue.pendingCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence across instances
// ---------------------------------------------------------------------------

describe('ProposalQueue persistence', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('persists proposals across queue instances', async () => {
    const { ProposalQueue } = await import('../autonomy/proposal-queue.js');

    // Instance 1: enqueue
    const queue1 = new ProposalQueue(ws.path);
    await queue1.load();

    queue1.enqueue({
      action: { type: 'send-message', target: 'telegram:12345' },
      reason: 'Persistent proposal',
      context: 'Should survive reload',
    });

    await queue1.save();

    // Instance 2: load and verify
    const queue2 = new ProposalQueue(ws.path);
    await queue2.load();

    expect(queue2.pendingCount()).toBe(1);
    expect(queue2.list()[0].reason).toBe('Persistent proposal');
  });

  it('persists resolved state across instances', async () => {
    const { ProposalQueue } = await import('../autonomy/proposal-queue.js');

    // Instance 1: enqueue and resolve
    const queue1 = new ProposalQueue(ws.path);
    await queue1.load();

    const id = queue1.enqueue({
      action: { type: 'send-message', target: 'telegram:12345' },
      reason: 'Test',
      context: '',
    });

    queue1.resolve(id, 'approved');
    await queue1.save();

    // Instance 2: verify resolved state
    const queue2 = new ProposalQueue(ws.path);
    await queue2.load();

    expect(queue2.pendingCount()).toBe(0);
    expect(queue2.list()[0].status).toBe('approved');
  });
});
