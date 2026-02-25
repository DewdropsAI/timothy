/**
 * Per-key mutex / serialisation queue.
 *
 * Ensures that for a given key (e.g. a chat ID) only one async operation
 * runs at a time.  Additional calls while the lock is held are queued in
 * FIFO order and executed sequentially once the previous one resolves (or
 * rejects).
 *
 * Usage:
 *   const mutex = new KeyedMutex();
 *   await mutex.run(chatId, async () => { ... });
 */

export class KeyedMutex {
  private readonly locks = new Map<string | number, Promise<void>>();

  /**
   * Run `fn` exclusively for `key`.
   * If another `fn` is already running for the same key, this call waits
   * until the earlier one settles before starting.
   *
   * Returns whatever `fn` returns (or rejects with its error).
   */
  async run<T>(key: string | number, fn: () => Promise<T>): Promise<T> {
    // Wait for the previous task on this key (if any) to finish.
    const prev = this.locks.get(key) ?? Promise.resolve();

    // Build a new tail that resolves once *our* fn settles.
    let releaseFn: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    this.locks.set(key, gate);

    // Wait for the predecessor, then run.
    await prev;

    try {
      return await fn();
    } finally {
      releaseFn!();
      // If nothing else has queued behind us, clean up.
      if (this.locks.get(key) === gate) {
        this.locks.delete(key);
      }
    }
  }

  /** Number of keys that currently have a pending or active task. */
  get size(): number {
    return this.locks.size;
  }
}
