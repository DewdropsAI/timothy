import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomInt } from 'node:crypto';
import { identity } from './identity.js';

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

interface PendingChallenge {
  code: string;
  chatId: number;
  createdAt: number;
}

interface AuthData {
  verifiedChatIds: number[];
  pendingChallenges: PendingChallenge[];
}

export interface VerifyResult {
  success: boolean;
  chatId?: number;
}

let authDir = join(homedir(), identity.configDir);
const AUTH_FILENAME = 'auth.json';

// In-memory cache
let verifiedChatIds: Set<number> = new Set();
let pendingChallenges: PendingChallenge[] = [];

/** @internal Only for testing */
export function _setAuthDir(dir: string): void {
  authDir = dir;
}

/** @internal Only for testing — reset in-memory state */
export function _resetAuthState(): void {
  verifiedChatIds = new Set();
  pendingChallenges = [];
}

function authFilePath(): string {
  return join(authDir, AUTH_FILENAME);
}

function persistAuth(): void {
  mkdirSync(authDir, { recursive: true });
  const data: AuthData = {
    verifiedChatIds: [...verifiedChatIds],
    pendingChallenges,
  };
  const filePath = authFilePath();
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmpPath, filePath);
}

function pruneExpired(): void {
  const now = Date.now();
  pendingChallenges = pendingChallenges.filter((c) => now - c.createdAt < EXPIRY_MS);
}

/**
 * Load auth state from disk into memory.
 * Handles missing file and corrupted JSON gracefully.
 */
export function loadAuth(): void {
  try {
    const raw = readFileSync(authFilePath(), 'utf8');
    const data: unknown = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      if (Array.isArray(d.verifiedChatIds)) {
        verifiedChatIds = new Set(
          (d.verifiedChatIds as unknown[]).filter((id): id is number => typeof id === 'number'),
        );
      }
      if (Array.isArray(d.pendingChallenges)) {
        pendingChallenges = (d.pendingChallenges as unknown[]).filter(
          (c): c is PendingChallenge =>
            c !== null &&
            typeof c === 'object' &&
            typeof (c as PendingChallenge).code === 'string' &&
            typeof (c as PendingChallenge).chatId === 'number' &&
            typeof (c as PendingChallenge).createdAt === 'number',
        );
      }
    }
  } catch {
    // Missing file or bad JSON — start fresh
  }
  pruneExpired();
}

/**
 * Returns all verified (authenticated) chat IDs.
 * Used by the proactive pipeline to know where to send follow-up messages.
 */
export function getVerifiedChatIds(): number[] {
  return [...verifiedChatIds];
}

/**
 * Check if a chat ID is authenticated.
 * Fast path: in-memory set lookup.
 * On cache miss: reload from disk in case another process verified.
 */
export function isAuthenticated(chatId: number): boolean {
  if (verifiedChatIds.has(chatId)) return true;
  // Cache miss — reload from disk (cheap for unauthenticated users)
  loadAuth();
  return verifiedChatIds.has(chatId);
}

/**
 * Generate a challenge code for a Telegram chat ID.
 * Replaces any existing challenge for the same chatId.
 */
export function createChallenge(chatId: number): string {
  pruneExpired();

  // Remove existing challenge for this chatId
  pendingChallenges = pendingChallenges.filter((c) => c.chatId !== chatId);

  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CHARSET[randomInt(CHARSET.length)];
  }

  pendingChallenges.push({ code, chatId, createdAt: Date.now() });
  persistAuth();
  return code;
}

/**
 * Verify a challenge code.
 * On success: moves the chatId to verified, removes the challenge.
 */
export function verifyCode(code: string): VerifyResult {
  // Reload from disk in case bot process wrote a new challenge
  loadAuth();
  pruneExpired();

  const normalized = code.toUpperCase().trim();
  const idx = pendingChallenges.findIndex((c) => c.code === normalized);
  if (idx === -1) {
    return { success: false };
  }

  const challenge = pendingChallenges[idx];
  pendingChallenges.splice(idx, 1);
  verifiedChatIds.add(challenge.chatId);
  persistAuth();

  return { success: true, chatId: challenge.chatId };
}
