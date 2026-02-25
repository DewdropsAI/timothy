import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────

/** Lifecycle status of a proposal. */
export type ProposalStatus = 'pending' | 'approved' | 'rejected';

/** The action being proposed, with type and target. */
export interface ProposalAction {
  type: string;
  target: string;
  [key: string]: unknown;
}

/** Input for creating a new proposal. */
export interface ProposalInput {
  action: ProposalAction;
  reason: string;
  context: string;
}

/** A proposal stored in the queue, with full metadata and resolution state. */
export interface Proposal {
  id: string;
  action: ProposalAction;
  reason: string;
  context: string;
  status: ProposalStatus;
  createdAt: string;
  resolvedAt?: string;
}

// ── Serialization ───────────────────────────────────────────────────

interface ProposalQueueData {
  proposals: Proposal[];
  lastUpdated: string;
}

// ── Constants ────────────────────────────────────────────────────────

const QUEUE_FILE = 'working-memory/proposal-queue.json';
const MAX_RESOLVED_PROPOSALS = 100;

// ── ProposalQueue ───────────────────────────────────────────────────

/**
 * Manages the queue of proposed actions awaiting Chris's approval.
 * Persisted to workspace/working-memory/proposal-queue.json.
 */
export class ProposalQueue {
  private workspacePath: string;
  private data: ProposalQueueData | null = null;

  /**
   * @param workspacePath - Absolute path to the workspace directory.
   */
  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /**
   * Loads proposal queue from workspace/working-memory/proposal-queue.json.
   * Returns empty queue if file doesn't exist or is malformed.
   */
  async load(): Promise<void> {
    const filePath = path.join(this.workspacePath, QUEUE_FILE);

    try {
      if (!existsSync(filePath)) {
        this.data = this.emptyData();
        return;
      }

      const raw = readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      if (this.isValidData(parsed)) {
        this.data = parsed as ProposalQueueData;
        return;
      }

      console.warn('[proposal-queue] malformed file, returning empty queue');
      this.data = this.emptyData();
    } catch {
      this.data = this.emptyData();
    }
  }

  /**
   * Saves proposal queue to workspace/working-memory/proposal-queue.json using atomic write.
   */
  async save(): Promise<void> {
    if (!this.data) {
      throw new Error('Cannot save: queue not loaded. Call load() first.');
    }

    const filePath = path.join(this.workspacePath, QUEUE_FILE);
    const tmpPath = filePath + '.tmp';

    mkdirSync(path.dirname(filePath), { recursive: true });

    this.data.lastUpdated = new Date().toISOString();

    try {
      writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
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

  /**
   * Adds a proposal to the queue.
   * @param input - The proposal action, reason, and context.
   * @returns The generated proposal ID.
   */
  enqueue(input: ProposalInput): string {
    if (!this.data) {
      throw new Error('Cannot enqueue: queue not loaded. Call load() first.');
    }

    const proposal: Proposal = {
      id: randomUUID(),
      action: input.action,
      reason: input.reason,
      context: input.context,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    this.data.proposals.push(proposal);
    this.data.lastUpdated = new Date().toISOString();

    return proposal.id;
  }

  /**
   * Lists all proposals (pending, approved, rejected).
   * @returns All proposals in the queue.
   */
  list(): Proposal[] {
    if (!this.data) {
      throw new Error('Cannot list: queue not loaded. Call load() first.');
    }
    return this.data.proposals;
  }

  /**
   * Resolves a proposal by ID -- marks it as approved or rejected.
   * @param id - The proposal UUID.
   * @param status - Whether to approve or reject the proposal.
   */
  resolve(id: string, status: 'approved' | 'rejected'): void {
    if (!this.data) {
      throw new Error('Cannot resolve: queue not loaded. Call load() first.');
    }

    const proposal = this.data.proposals.find(p => p.id === id);
    if (!proposal) {
      throw new Error(`Proposal not found: ${id}`);
    }

    if (proposal.status !== 'pending') {
      throw new Error(`Proposal ${id} already resolved (status: ${proposal.status})`);
    }

    proposal.status = status;
    proposal.resolvedAt = new Date().toISOString();
    this.data.lastUpdated = new Date().toISOString();

    // Prune old resolved proposals
    this.pruneResolved();
  }

  /**
   * Returns the count of pending proposals.
   * @returns Number of proposals with status 'pending'.
   */
  pendingCount(): number {
    if (!this.data) {
      throw new Error('Cannot count: queue not loaded. Call load() first.');
    }
    return this.data.proposals.filter(p => p.status === 'pending').length;
  }

  // ── Private ──────────────────────────────────────────────────────

  private emptyData(): ProposalQueueData {
    return { proposals: [], lastUpdated: new Date().toISOString() };
  }

  private pruneResolved(): void {
    if (!this.data) return;

    const resolved = this.data.proposals.filter(p => p.status !== 'pending');
    if (resolved.length > MAX_RESOLVED_PROPOSALS) {
      const toRemove = resolved.length - MAX_RESOLVED_PROPOSALS;
      let removed = 0;
      this.data.proposals = this.data.proposals.filter(p => {
        if (p.status !== 'pending' && removed < toRemove) {
          removed++;
          return false;
        }
        return true;
      });
    }
  }

  private isValidData(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const obj = value as Record<string, unknown>;
    return Array.isArray(obj.proposals);
  }
}
