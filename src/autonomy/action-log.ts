import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ActionTier } from './types.js';

// Re-define the Action shape used by the log (matches the existing codebase Action)
interface Action {
  id: string;
  type: string;
  description: string;
  tier: ActionTier;
  reasoning: string;
  timestamp: Date;
}

// ── Types ────────────────────────────────────────────────────────────

/** Result of executing an action. */
export type ActionOutcome = 'success' | 'failure' | 'partial';

/** A log entry recording an action and its outcome. */
export interface ActionLogEntry {
  action: Action;
  outcome: ActionOutcome;
  timestamp: Date;
  details?: string;
}

// ── Serialization types ──────────────────────────────────────────────

interface SerializedAction {
  id: string;
  type: string;
  description: string;
  tier: string;
  reasoning: string;
  timestamp: string;
}

interface SerializedLogEntry {
  action: SerializedAction;
  outcome: ActionOutcome;
  timestamp: string;
  details?: string;
}

interface ActionLogData {
  entries: SerializedLogEntry[];
  lastUpdated: string;
}

// ── Constants ────────────────────────────────────────────────────────

const LOG_FILE = 'memory/action-log.json';
const MAX_LOG_ENTRIES = 500;

// ── ActionLog ───────────────────────────────────────────────────────

/**
 * Persistent log of actions the agent has taken, stored in workspace/memory/action-log.json.
 * Used for observability and trust signal analysis.
 */
export class ActionLog {
  private workspacePath: string;

  /**
   * @param workspacePath - Absolute path to the workspace directory.
   */
  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /**
   * Records an action log entry. Appends to the log and persists.
   * @param entry - The action and outcome to record.
   */
  async record(entry: ActionLogEntry): Promise<void> {
    const data = this.loadData();

    data.entries.push(this.serializeEntry(entry));

    // Prune oldest entries if over limit
    if (data.entries.length > MAX_LOG_ENTRIES) {
      data.entries = data.entries.slice(data.entries.length - MAX_LOG_ENTRIES);
    }

    data.lastUpdated = new Date().toISOString();
    this.saveData(data);

    console.log(
      `[action-log] recorded: id=${entry.action.id} type=${entry.action.type} ` +
      `outcome=${entry.outcome}`
    );
  }

  /**
   * Returns the most recent log entries, newest first.
   * @param count - Maximum number of entries to return (default 20).
   * @returns Recent log entries in reverse chronological order.
   */
  async getRecent(count: number = 20): Promise<ActionLogEntry[]> {
    const data = this.loadData();
    const entries = data.entries
      .slice(-count)
      .reverse()
      .map(e => this.deserializeEntry(e));
    return entries;
  }

  /**
   * Returns log entries filtered by action type, newest first.
   * @param type - The action type string to filter by.
   * @returns Matching log entries in reverse chronological order.
   */
  async getByType(type: string): Promise<ActionLogEntry[]> {
    const data = this.loadData();
    return data.entries
      .filter(e => e.action.type === type)
      .reverse()
      .map(e => this.deserializeEntry(e));
  }

  /**
   * Returns total entry count.
   * @returns Number of entries in the log.
   */
  async getCount(): Promise<number> {
    const data = this.loadData();
    return data.entries.length;
  }

  // ── Private ──────────────────────────────────────────────────────

  private getFilePath(): string {
    return path.join(this.workspacePath, LOG_FILE);
  }

  private loadData(): ActionLogData {
    const filePath = this.getFilePath();

    try {
      if (!existsSync(filePath)) {
        return { entries: [], lastUpdated: new Date().toISOString() };
      }
      const raw = readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      if (
        typeof parsed === 'object' && parsed !== null &&
        'entries' in parsed && Array.isArray((parsed as ActionLogData).entries)
      ) {
        return parsed as ActionLogData;
      }

      console.warn('[action-log] malformed file, returning empty log');
      return { entries: [], lastUpdated: new Date().toISOString() };
    } catch {
      return { entries: [], lastUpdated: new Date().toISOString() };
    }
  }

  private saveData(data: ActionLogData): void {
    const filePath = this.getFilePath();
    const tmpPath = filePath + '.tmp';

    mkdirSync(path.dirname(filePath), { recursive: true });

    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2));
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

  private serializeEntry(entry: ActionLogEntry): SerializedLogEntry {
    return {
      action: {
        id: entry.action.id,
        type: entry.action.type,
        description: entry.action.description,
        tier: entry.action.tier,
        reasoning: entry.action.reasoning,
        timestamp: entry.action.timestamp.toISOString(),
      },
      outcome: entry.outcome,
      timestamp: entry.timestamp.toISOString(),
      details: entry.details,
    };
  }

  private deserializeEntry(serialized: SerializedLogEntry): ActionLogEntry {
    return {
      action: {
        id: serialized.action.id,
        type: serialized.action.type,
        description: serialized.action.description,
        tier: serialized.action.tier as Action['tier'],
        reasoning: serialized.action.reasoning,
        timestamp: new Date(serialized.action.timestamp),
      },
      outcome: serialized.outcome,
      timestamp: new Date(serialized.timestamp),
      details: serialized.details,
    };
  }
}
