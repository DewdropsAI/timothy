/**
 * Time-windowed deduplication set.
 *
 * Keeps a set of recently-seen message IDs per chat, each stamped with the
 * time it was recorded.  `hasSeen(chatId, messageId)` returns true if the
 * ID was already recorded within the window; otherwise it records the ID and
 * returns false.
 *
 * A periodic sweep removes entries older than `windowMs` so the map never
 * grows without bound.
 */

interface TimestampedId {
  messageId: number;
  seenAt: number;
}

export class DedupSet {
  private readonly windowMs: number;
  private readonly map = new Map<number, TimestampedId[]>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param windowMs  How long (in ms) an ID is considered "recent". Default 60 000 (60 s).
   * @param sweepIntervalMs  How often to prune stale entries. Default equal to windowMs.
   */
  constructor(windowMs = 60_000, sweepIntervalMs?: number) {
    this.windowMs = windowMs;
    this.sweepTimer = setInterval(
      () => this.sweep(),
      sweepIntervalMs ?? windowMs,
    );
    // Allow the process to exit even if the timer is pending.
    if (this.sweepTimer && typeof this.sweepTimer === 'object' && 'unref' in this.sweepTimer) {
      this.sweepTimer.unref();
    }
  }

  /**
   * Check whether `messageId` has been seen for `chatId` within the window.
   * If not, record it and return `false` (meaning "not a duplicate").
   * If yes, return `true` (meaning "duplicate — skip it").
   */
  isDuplicate(chatId: number, messageId: number): boolean {
    const now = Date.now();
    let entries = this.map.get(chatId);

    if (entries) {
      // Prune expired entries for this chat while we're here.
      entries = entries.filter((e) => now - e.seenAt < this.windowMs);

      if (entries.some((e) => e.messageId === messageId)) {
        // Already seen within the window.
        this.map.set(chatId, entries);
        return true;
      }

      entries.push({ messageId, seenAt: now });
      this.map.set(chatId, entries);
    } else {
      this.map.set(chatId, [{ messageId, seenAt: now }]);
    }

    return false;
  }

  /** Remove entries older than the window across all chats. */
  sweep(): void {
    const now = Date.now();
    for (const [chatId, entries] of this.map) {
      const fresh = entries.filter((e) => now - e.seenAt < this.windowMs);
      if (fresh.length === 0) {
        this.map.delete(chatId);
      } else {
        this.map.set(chatId, fresh);
      }
    }
  }

  /** Total number of tracked IDs across all chats (useful for tests). */
  get size(): number {
    let total = 0;
    for (const entries of this.map.values()) {
      total += entries.length;
    }
    return total;
  }

  /** Stop the background sweep timer. */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
