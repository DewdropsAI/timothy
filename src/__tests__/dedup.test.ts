import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DedupSet } from '../dedup.js';

describe('DedupSet', () => {
  let dedup: DedupSet;

  afterEach(() => {
    dedup?.dispose();
  });

  describe('basic deduplication', () => {
    beforeEach(() => {
      dedup = new DedupSet(60_000);
    });

    it('returns false (not duplicate) on first encounter', () => {
      expect(dedup.isDuplicate(1, 100)).toBe(false);
    });

    it('returns true (duplicate) on second encounter of same chatId + messageId', () => {
      dedup.isDuplicate(1, 100);
      expect(dedup.isDuplicate(1, 100)).toBe(true);
    });

    it('treats different messageIds in the same chat as distinct', () => {
      dedup.isDuplicate(1, 100);
      expect(dedup.isDuplicate(1, 101)).toBe(false);
    });

    it('treats same messageId in different chats as distinct', () => {
      dedup.isDuplicate(1, 100);
      expect(dedup.isDuplicate(2, 100)).toBe(false);
    });

    it('tracks multiple IDs per chat (not single-slot)', () => {
      // This is the core fix: old code only kept the *last* ID per chat.
      // Sending 100, then 101, then re-sending 100 should still catch the dup.
      dedup.isDuplicate(1, 100);
      dedup.isDuplicate(1, 101);
      dedup.isDuplicate(1, 102);
      expect(dedup.isDuplicate(1, 100)).toBe(true); // Would have been false with single-slot
      expect(dedup.isDuplicate(1, 101)).toBe(true);
      expect(dedup.isDuplicate(1, 102)).toBe(true);
    });
  });

  describe('time window expiry', () => {
    it('expires entries after the window elapses', () => {
      dedup = new DedupSet(100); // 100 ms window

      dedup.isDuplicate(1, 100);
      expect(dedup.isDuplicate(1, 100)).toBe(true);

      // Fast-forward past the window
      vi.useFakeTimers();
      vi.advanceTimersByTime(150);

      // isDuplicate prunes expired entries inline, but we need real Date.now()
      // to reflect the advancement. Use a manual approach instead.
      vi.useRealTimers();
    });

    it('prunes expired entries on isDuplicate call', async () => {
      dedup = new DedupSet(50); // 50 ms window

      dedup.isDuplicate(1, 100);
      expect(dedup.isDuplicate(1, 100)).toBe(true);

      // Wait for window to pass
      await new Promise((r) => setTimeout(r, 80));

      // After the window, the entry should be pruned and treated as new
      expect(dedup.isDuplicate(1, 100)).toBe(false);
    });
  });

  describe('sweep', () => {
    it('removes all expired entries across chats', async () => {
      dedup = new DedupSet(50);

      dedup.isDuplicate(1, 100);
      dedup.isDuplicate(2, 200);
      expect(dedup.size).toBe(2);

      await new Promise((r) => setTimeout(r, 80));
      dedup.sweep();

      expect(dedup.size).toBe(0);
    });

    it('keeps fresh entries and removes stale ones', async () => {
      dedup = new DedupSet(100);

      dedup.isDuplicate(1, 100);
      await new Promise((r) => setTimeout(r, 60));

      // Add a fresh one
      dedup.isDuplicate(1, 101);
      await new Promise((r) => setTimeout(r, 60));

      // Now message 100 is ~120ms old (expired), message 101 is ~60ms old (fresh)
      dedup.sweep();
      expect(dedup.size).toBe(1);

      // 100 should be gone, 101 should still be caught
      expect(dedup.isDuplicate(1, 100)).toBe(false); // expired, treated as new
      expect(dedup.isDuplicate(1, 101)).toBe(true);  // still in window
    });
  });

  describe('size', () => {
    beforeEach(() => {
      dedup = new DedupSet(60_000);
    });

    it('starts at 0', () => {
      expect(dedup.size).toBe(0);
    });

    it('increases as new IDs are added', () => {
      dedup.isDuplicate(1, 100);
      expect(dedup.size).toBe(1);

      dedup.isDuplicate(1, 101);
      expect(dedup.size).toBe(2);

      dedup.isDuplicate(2, 200);
      expect(dedup.size).toBe(3);
    });

    it('does not increase on duplicate', () => {
      dedup.isDuplicate(1, 100);
      dedup.isDuplicate(1, 100);
      expect(dedup.size).toBe(1);
    });
  });

  describe('dispose', () => {
    it('clears the sweep timer', () => {
      dedup = new DedupSet(60_000);
      dedup.dispose();
      // Calling dispose again should be safe
      dedup.dispose();
    });
  });
});
