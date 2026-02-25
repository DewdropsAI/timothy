import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatId = number | string;

const sessions: Map<ChatId, Message[]> = new Map();

let sessionsDir = path.resolve(PROJECT_ROOT, 'workspace', 'memory', 'sessions');

export function getSessionsDir(): string {
  return sessionsDir;
}

/** @internal Only for testing */
export function _setSessionsDir(dir: string): void {
  sessionsDir = dir;
}

function ensureSessionsDir(): void {
  mkdirSync(sessionsDir, { recursive: true });
}

function saveSession(chatId: ChatId): void {
  try {
    ensureSessionsDir();
    const filePath = path.join(sessionsDir, `${chatId}.json`);
    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(getHistory(chatId), null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`[session] failed to save session ${chatId}:`, err);
  }
}

export function getHistory(chatId: ChatId): Message[] {
  return sessions.get(chatId) ?? [];
}

export function addMessage(chatId: ChatId, message: Message): void {
  const history = sessions.get(chatId);
  if (history) {
    history.push(message);
  } else {
    sessions.set(chatId, [message]);
  }
  saveSession(chatId);
}

export function clearHistory(chatId: ChatId): void {
  sessions.delete(chatId);
}

/**
 * Replaces the in-memory history for a chat with the given messages.
 * Used after summarization to trim older turns from working memory.
 * Persists the replacement to disk.
 */
export function replaceHistory(chatId: ChatId, messages: Message[]): void {
  sessions.set(chatId, messages);
  saveSession(chatId);
}

/**
 * Load all saved sessions from disk into the in-memory store.
 * Skips files that are missing, unreadable, or contain invalid JSON.
 */
export function loadSessions(): void {
  let files: string[];
  try {
    ensureSessionsDir();
    files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const rawId = file.replace('.json', '');
    const chatId: ChatId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;

    try {
      const raw = readFileSync(path.join(sessionsDir, file), 'utf8');
      const data: unknown = JSON.parse(raw);
      if (!Array.isArray(data)) {
        console.warn(`[session] skipping ${file}: not an array`);
        continue;
      }
      sessions.set(chatId, data as Message[]);
    } catch (err) {
      console.warn(`[session] skipping ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
