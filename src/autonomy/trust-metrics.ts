import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ActionTier } from './types.js';

// ── Types ────────────────────────────────────────────────────────────

/** Direction of a trust signal -- positive increases trust, negative decreases it. */
export type TrustSignalType = 'positive' | 'negative';

/** Input for recording a trust signal. */
export interface TrustSignalInput {
  type: TrustSignalType;
  value: number;  // magnitude of change (positive number)
  source: string;
}

/** Persisted trust signal with timestamp. */
export interface TrustSignalRecord {
  type: TrustSignalType;
  value: number;
  source: string;
  timestamp: string;
}

/** Full trust state persisted to workspace/working-memory/trust-metrics.json. */
export interface TrustState {
  trustScore: number;         // 0.0 to 1.0
  signals: TrustSignalRecord[];
  allowedTiers: ActionTier[];
  lastUpdated: string;
}

// ── Constants ────────────────────────────────────────────────────────

const TRUST_FILE = 'working-memory/trust-metrics.json';
const SIGNAL_WINDOW_SIZE = 50;
const FREEZE_DURATION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const DEFAULT_TRUST_SCORE = 0.5;

// ── TrustManager ────────────────────────────────────────────────────

/**
 * Manages trust scoring and persistence. Trust evolves over time based on
 * Chris's responses to the agent's actions, controlling which action tiers are allowed.
 */
export class TrustManager {
  private workspacePath: string;
  private state: TrustState | null = null;

  /**
   * @param workspacePath - Absolute path to the workspace directory.
   */
  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /**
   * Loads trust state from workspace/working-memory/trust-metrics.json.
   * Returns default state if file doesn't exist or is malformed.
   * @returns The loaded or default trust state.
   */
  async load(): Promise<TrustState> {
    const filePath = path.join(this.workspacePath, TRUST_FILE);

    try {
      if (!existsSync(filePath)) {
        this.state = this.defaultState();
        return this.state;
      }

      const raw = readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      if (this.isValidState(parsed)) {
        this.state = parsed as TrustState;
        // Recalculate allowed tiers from loaded score, respecting freeze
        this.state.allowedTiers = this.isFrozen()
          ? ['autonomous']
          : this.calculateAllowedTiers(this.state.trustScore);
        return this.state;
      }

      console.warn('[trust] malformed trust-metrics.json, returning default state');
      this.state = this.defaultState();
      return this.state;
    } catch {
      this.state = this.defaultState();
      return this.state;
    }
  }

  /**
   * Saves current trust state to workspace/working-memory/trust-metrics.json using atomic write.
   */
  async save(): Promise<void> {
    if (!this.state) {
      throw new Error('Cannot save: trust state not loaded. Call load() first.');
    }

    const filePath = path.join(this.workspacePath, TRUST_FILE);
    const tmpPath = filePath + '.tmp';

    mkdirSync(path.dirname(filePath), { recursive: true });

    try {
      writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
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
   * Records a critical failure: immediately drops trust to 0.1 and
   * freezes scope to autonomous-only for 14 days.
   * @param reason - Description of the critical failure.
   */
  recordCriticalFailure(reason: string): void {
    if (!this.state) {
      throw new Error('Cannot record critical failure: trust state not loaded. Call load() first.');
    }

    const now = new Date().toISOString();

    this.state.trustScore = 0.1;
    this.state.allowedTiers = ['autonomous'];

    const record: TrustSignalRecord = {
      type: 'negative',
      value: 0.4,
      source: `critical-failure: ${reason}`,
      timestamp: now,
    };

    this.state.signals.push(record);

    // Prune to window size (keep most recent)
    if (this.state.signals.length > SIGNAL_WINDOW_SIZE) {
      this.state.signals = this.state.signals.slice(
        this.state.signals.length - SIGNAL_WINDOW_SIZE,
      );
    }

    this.state.lastUpdated = now;
  }

  /**
   * Returns true if the system is in a critical-failure freeze.
   * Freeze is active when the most recent critical-failure signal
   * was recorded within the last 14 days.
   * @returns Whether a freeze is currently active.
   */
  isFrozen(): boolean {
    if (!this.state) return false;

    const criticalSignals = this.state.signals.filter(
      s => s.source.startsWith('critical-failure:'),
    );
    if (criticalSignals.length === 0) return false;

    const latest = criticalSignals[criticalSignals.length - 1];
    const elapsed = Date.now() - new Date(latest.timestamp).getTime();
    return elapsed < FREEZE_DURATION_MS;
  }

  /**
   * Records a trust signal and updates the score.
   * Positive signals increase trust, negative signals decrease it.
   * During a freeze, positive signals are recorded but scope stays restricted.
   * @param signal - The trust signal to record.
   */
  recordSignal(signal: TrustSignalInput): void {
    if (!this.state) {
      throw new Error('Cannot record signal: trust state not loaded. Call load() first.');
    }

    const record: TrustSignalRecord = {
      type: signal.type,
      value: signal.value,
      source: signal.source,
      timestamp: new Date().toISOString(),
    };

    this.state.signals.push(record);

    // Prune to window size (keep most recent)
    if (this.state.signals.length > SIGNAL_WINDOW_SIZE) {
      this.state.signals = this.state.signals.slice(
        this.state.signals.length - SIGNAL_WINDOW_SIZE,
      );
    }

    // Apply signal to trust score
    const delta = signal.type === 'positive' ? signal.value : -signal.value;
    this.state.trustScore = Math.max(0, Math.min(1, this.state.trustScore + delta));

    // Recalculate scope — but if frozen, cap at autonomous-only
    if (this.isFrozen()) {
      this.state.allowedTiers = ['autonomous'];
    } else {
      this.state.allowedTiers = this.calculateAllowedTiers(this.state.trustScore);
    }
    this.state.lastUpdated = new Date().toISOString();
  }

  /**
   * Returns the current trust score (0.0 to 1.0).
   * @returns The trust score.
   */
  getScore(): number {
    if (!this.state) {
      throw new Error('Trust state not loaded. Call load() first.');
    }
    return this.state.trustScore;
  }

  /**
   * Returns the signal history.
   * @returns Array of recorded trust signals.
   */
  getSignalHistory(): TrustSignalRecord[] {
    if (!this.state) {
      throw new Error('Trust state not loaded. Call load() first.');
    }
    return this.state.signals;
  }

  /**
   * Evaluates which action tiers are allowed based on the current trust score.
   * During a freeze, always returns autonomous-only regardless of score.
   *
   * - Score < 0.4: autonomous only
   * - Score 0.4-0.7: autonomous + proposed
   * - Score > 0.7: autonomous + proposed + restricted
   *
   * @returns Object containing the array of currently allowed tiers.
   */
  evaluateScope(): { allowedTiers: ActionTier[] } {
    if (!this.state) {
      throw new Error('Trust state not loaded. Call load() first.');
    }
    if (this.isFrozen()) {
      return { allowedTiers: ['autonomous'] };
    }
    return { allowedTiers: this.calculateAllowedTiers(this.state.trustScore) };
  }

  /**
   * Returns a human-readable summary of trust state.
   * Suitable for injection into the system prompt.
   * @returns Markdown-formatted trust state summary.
   */
  getObservableSummary(): string {
    if (!this.state) {
      return 'Trust state: not loaded.';
    }

    const lines: string[] = [
      `## Autonomy Trust State`,
      '',
      `Overall trust score: ${this.state.trustScore}`,
      `Allowed tiers: ${this.state.allowedTiers.join(', ')}`,
    ];

    if (this.isFrozen()) {
      const criticalSignals = this.state.signals.filter(
        s => s.source.startsWith('critical-failure:'),
      );
      const latest = criticalSignals[criticalSignals.length - 1];
      const failureDate = latest.timestamp.split('T')[0];
      lines.push('', `Scope frozen: critical failure detected on ${failureDate}. Freeze lifts after 14 days of recovery.`);
    }

    const signalCount = this.state.signals.length;
    if (signalCount > 0) {
      const positive = this.state.signals.filter(s => s.type === 'positive').length;
      const negative = this.state.signals.filter(s => s.type === 'negative').length;
      lines.push('', `Recent signals: ${signalCount} (${positive} positive, ${negative} negative)`);
    }

    return lines.join('\n');
  }

  /** @internal For testing */
  getState(): TrustState | null {
    return this.state;
  }

  // ── Private ──────────────────────────────────────────────────────

  private defaultState(): TrustState {
    return {
      trustScore: DEFAULT_TRUST_SCORE,
      signals: [],
      allowedTiers: this.calculateAllowedTiers(DEFAULT_TRUST_SCORE),
      lastUpdated: new Date().toISOString(),
    };
  }

  private calculateAllowedTiers(score: number): ActionTier[] {
    if (score > 0.7) {
      return ['autonomous', 'propose', 'restricted'];
    }
    if (score >= 0.4) {
      return ['autonomous', 'propose'];
    }
    return ['autonomous'];
  }

  private isValidState(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const obj = value as Record<string, unknown>;
    return (
      typeof obj.trustScore === 'number' &&
      Array.isArray(obj.signals) &&
      typeof obj.lastUpdated === 'string'
    );
  }
}
