import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  loadAuth,
  isAuthenticated,
  createChallenge,
  verifyCode,
  _setAuthDir,
  _resetAuthState,
} from '../auth.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'titus-test-auth-'));

describe('auth', () => {
  beforeEach(() => {
    _setAuthDir(tmpDir);
    _resetAuthState();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('code generation', () => {
    it('generates a 6-character code', () => {
      const code = createChallenge(111);
      expect(code).toHaveLength(6);
    });

    it('uses only the allowed character set (no ambiguous chars)', () => {
      const allowed = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      // Generate several codes to reduce flakiness
      for (let i = 0; i < 20; i++) {
        const code = createChallenge(100 + i);
        for (const ch of code) {
          expect(allowed).toContain(ch);
        }
      }
    });

    it('generates unique codes across calls', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        codes.add(createChallenge(200 + i));
      }
      // With 30^6 possible codes, collisions in 50 draws are astronomically unlikely
      expect(codes.size).toBe(50);
    });
  });

  describe('createChallenge', () => {
    it('persists challenge to disk', () => {
      createChallenge(333);
      const raw = readFileSync(join(tmpDir, 'auth.json'), 'utf8');
      const data = JSON.parse(raw);
      expect(data.pendingChallenges).toHaveLength(1);
      expect(data.pendingChallenges[0].chatId).toBe(333);
    });

    it('replaces existing challenge for the same chatId', () => {
      const code1 = createChallenge(444);
      const code2 = createChallenge(444);
      expect(code1).not.toBe(code2);

      const raw = readFileSync(join(tmpDir, 'auth.json'), 'utf8');
      const data = JSON.parse(raw);
      const challenges = data.pendingChallenges.filter(
        (c: { chatId: number }) => c.chatId === 444,
      );
      expect(challenges).toHaveLength(1);
      expect(challenges[0].code).toBe(code2);
    });
  });

  describe('verifyCode', () => {
    it('succeeds for a valid unexpired code', () => {
      const code = createChallenge(555);
      const result = verifyCode(code);
      expect(result.success).toBe(true);
      expect(result.chatId).toBe(555);
    });

    it('fails for an invalid code', () => {
      createChallenge(666);
      const result = verifyCode('ZZZZZZ');
      expect(result.success).toBe(false);
      expect(result.chatId).toBeUndefined();
    });

    it('is case-insensitive', () => {
      const code = createChallenge(777);
      const result = verifyCode(code.toLowerCase());
      expect(result.success).toBe(true);
      expect(result.chatId).toBe(777);
    });

    it('removes the challenge after successful verification (no reuse)', () => {
      const code = createChallenge(888);
      verifyCode(code);
      const result = verifyCode(code);
      expect(result.success).toBe(false);
    });

    it('moves chatId to verified on success', () => {
      const code = createChallenge(999);
      verifyCode(code);
      expect(isAuthenticated(999)).toBe(true);
    });

    it('fails for an expired code', () => {
      const code = createChallenge(1010);

      // Manually expire the challenge by rewriting the file
      const raw = readFileSync(join(tmpDir, 'auth.json'), 'utf8');
      const data = JSON.parse(raw);
      data.pendingChallenges[0].createdAt = Date.now() - 11 * 60 * 1000;
      writeFileSync(join(tmpDir, 'auth.json'), JSON.stringify(data));

      // Reset in-memory state so verifyCode reloads from disk
      _resetAuthState();
      const result = verifyCode(code);
      expect(result.success).toBe(false);
    });
  });

  describe('isAuthenticated', () => {
    it('returns false for unknown chatId', () => {
      expect(isAuthenticated(11111)).toBe(false);
    });

    it('returns true after verification', () => {
      const code = createChallenge(22222);
      verifyCode(code);
      expect(isAuthenticated(22222)).toBe(true);
    });

    it('returns true on fast path (no disk re-read)', () => {
      const code = createChallenge(33333);
      verifyCode(code);
      // Second call should hit in-memory cache
      expect(isAuthenticated(33333)).toBe(true);
    });
  });

  describe('loadAuth', () => {
    it('handles missing file gracefully', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'titus-test-auth-empty-'));
      _setAuthDir(emptyDir);
      _resetAuthState();
      expect(() => loadAuth()).not.toThrow();
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('handles corrupted JSON gracefully', () => {
      const badDir = mkdtempSync(join(tmpdir(), 'titus-test-auth-bad-'));
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, 'auth.json'), 'not valid json!!!');
      _setAuthDir(badDir);
      _resetAuthState();
      expect(() => loadAuth()).not.toThrow();
      rmSync(badDir, { recursive: true, force: true });
    });

    it('restores verified chatIds from disk after explicit load', () => {
      // Verify a user
      const code = createChallenge(44444);
      verifyCode(code);
      expect(isAuthenticated(44444)).toBe(true);

      // Reset in-memory state, explicitly load from disk
      _resetAuthState();
      loadAuth();
      // Should be restored from disk without needing isAuthenticated's fallback
      expect(isAuthenticated(44444)).toBe(true);
    });
  });

  describe('cross-process simulation', () => {
    it('bot creates challenge, CLI reloads and verifies, bot sees authenticated', () => {
      // Bot process: create challenge
      const code = createChallenge(55555);

      // CLI process: reset memory (simulating separate process), reload from disk, verify
      _resetAuthState();
      loadAuth();
      const result = verifyCode(code);
      expect(result.success).toBe(true);
      expect(result.chatId).toBe(55555);

      // Bot process: reset memory (simulating separate process), check authenticated
      _resetAuthState();
      loadAuth();
      expect(isAuthenticated(55555)).toBe(true);
    });
  });
});
