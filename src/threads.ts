import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getMemoryPath } from './memory.js';
import type { Message } from './session.js';
import { identity } from './identity.js';

// ── Types ────────────────────────────────────────────────────────────

export type ThreadStatus = 'active' | 'awaiting-response' | 'resolved' | 'parked';

export interface Thread {
  id: string;
  topic: string;
  status: ThreadStatus;
  lastActivity: string; // ISO timestamp
  participants: string[]; // e.g. ['user', '<agentName>']
  messageCount: number;
}

export interface ThreadsState {
  threads: Thread[];
  lastUpdated: string; // ISO timestamp
}

// ── Paths ────────────────────────────────────────────────────────────

function getThreadsPath(): string {
  return path.join(getMemoryPath(), 'threads.json');
}

// ── Persistence ──────────────────────────────────────────────────────

/**
 * Loads threads state from workspace/memory/threads.json.
 * Returns a default empty state if the file doesn't exist or is malformed.
 */
export function loadThreads(): ThreadsState {
  const filePath = getThreadsPath();
  try {
    if (!existsSync(filePath)) {
      return { threads: [], lastUpdated: new Date().toISOString() };
    }
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'threads' in parsed &&
      Array.isArray((parsed as ThreadsState).threads)
    ) {
      return parsed as ThreadsState;
    }
    console.warn('[threads] malformed threads.json, returning empty state');
    return { threads: [], lastUpdated: new Date().toISOString() };
  } catch {
    return { threads: [], lastUpdated: new Date().toISOString() };
  }
}

/**
 * Saves threads state to workspace/memory/threads.json using atomic write.
 */
export function saveThreads(state: ThreadsState): void {
  const filePath = getThreadsPath();
  const tmpPath = filePath + '.tmp';

  mkdirSync(path.dirname(filePath), { recursive: true });

  try {
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp file may not exist
    }
    throw err;
  }
}

// ── Topic extraction ─────────────────────────────────────────────────

/**
 * Extracts a topic from a user message using heuristic patterns.
 * Returns a short topic string or null if the message is too generic.
 */
export function extractTopic(userMsg: string): string | null {
  const trimmed = userMsg.trim();
  if (trimmed.length < 10) return null;

  // Explicit topic markers
  const topicPatterns = [
    /(?:let's talk about|let's discuss|can we discuss|i want to talk about|about)\s+(.{5,80})/i,
    /(?:question about|help with|need help with|issue with|problem with)\s+(.{5,80})/i,
    /(?:how (?:do|can|should|would) (?:i|we|you))\s+(.{5,80})/i,
    /(?:what (?:is|are|do you think about))\s+(.{5,80})/i,
    /(?:can you|could you|would you|please)\s+(.{5,80})/i,
  ];

  for (const pattern of topicPatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      // Clean up and truncate the topic
      return cleanTopic(match[1]);
    }
  }

  // Fallback: use the first sentence or first 60 chars
  const firstSentence = trimmed.match(/^[^.!?\n]+/);
  if (firstSentence && firstSentence[0].length >= 10) {
    return cleanTopic(firstSentence[0]);
  }

  return cleanTopic(trimmed.slice(0, 60));
}

/**
 * Cleans and truncates a topic string.
 */
function cleanTopic(raw: string): string {
  return raw
    .replace(/[.!?,;:]+$/, '')
    .trim()
    .slice(0, 80);
}

// ── Thread ID generation ─────────────────────────────────────────────

/**
 * Generates a thread ID from a topic using a slug + timestamp suffix.
 */
export function generateThreadId(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  const suffix = Date.now().toString(36).slice(-4);
  return `${slug}-${suffix}`;
}

// ── Status inference ─────────────────────────────────────────────────

/**
 * Infers thread status from the last exchange in a conversation.
 *
 * - If the last message is from the user, the thread is 'awaiting-response'
 * - If the assistant asks a question, the thread is 'active'
 * - If the assistant gives a conclusive answer, the thread is 'resolved'
 * - Default is 'active'
 */
export function inferStatus(
  userMsg: string,
  assistantMsg: string,
  lastRole: 'user' | 'assistant',
): ThreadStatus {
  if (lastRole === 'user') {
    return 'awaiting-response';
  }

  // Check for resolution signals in assistant response
  const resolutionPatterns = [
    /\b(?:hope that helps|let me know if you (?:need|have) (?:anything|any)|glad I could help)\b/i,
    /\b(?:that should (?:do it|work|fix)|you're all set|done|completed)\b/i,
    /\b(?:here's the (?:answer|solution|result)|in summary)\b/i,
  ];

  for (const pattern of resolutionPatterns) {
    if (pattern.test(assistantMsg)) {
      return 'resolved';
    }
  }

  // Check for question patterns (thread is active, waiting for user input)
  const questionPatterns = [
    /\?\s*$/m,
    /\b(?:what do you think|would you like|shall I|should I|do you want)\b/i,
    /\b(?:which (?:one|option)|any preference)\b/i,
  ];

  for (const pattern of questionPatterns) {
    if (pattern.test(assistantMsg)) {
      return 'active';
    }
  }

  return 'active';
}

// ── Topic similarity ─────────────────────────────────────────────────

/**
 * Checks if two topics are similar enough to be the same thread.
 * Uses word overlap: if 50%+ of the shorter topic's words appear in the longer, it's a match.
 */
export function topicsSimilar(a: string, b: string): boolean {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));

  if (wordsA.size === 0 || wordsB.size === 0) return false;

  const smaller = wordsA.size <= wordsB.size ? wordsA : wordsB;
  const larger = wordsA.size <= wordsB.size ? wordsB : wordsA;

  let overlap = 0;
  for (const word of smaller) {
    if (larger.has(word)) overlap++;
  }

  return smaller.size > 0 && overlap / smaller.size >= 0.5;
}

// ── Main pipeline ────────────────────────────────────────────────────

/**
 * Updates thread tracking state based on a new user+assistant exchange.
 * Finds an existing thread with a similar topic or creates a new one.
 * Updates status based on the exchange content.
 *
 * This runs silently during memory writeback — no proactive sending.
 */
export function updateThreads(
  userMsg: string,
  assistantMsg: string,
): ThreadsState {
  const now = new Date().toISOString();
  const state = loadThreads();

  const topic = extractTopic(userMsg);
  if (!topic) {
    // Message too short/generic to track as a thread
    return state;
  }

  // Look for an existing thread with a similar topic that isn't resolved
  const existingIdx = state.threads.findIndex(
    (t) => t.status !== 'resolved' && topicsSimilar(t.topic, topic),
  );

  if (existingIdx !== -1) {
    // Update existing thread
    const thread = state.threads[existingIdx];
    thread.lastActivity = now;
    thread.messageCount += 2; // user + assistant
    thread.status = inferStatus(userMsg, assistantMsg, 'assistant');

    // Move to front (most recent first)
    state.threads.splice(existingIdx, 1);
    state.threads.unshift(thread);
  } else {
    // Create new thread
    const newThread: Thread = {
      id: generateThreadId(topic),
      topic,
      status: inferStatus(userMsg, assistantMsg, 'assistant'),
      lastActivity: now,
      participants: ['user', identity.agentName],
      messageCount: 2,
    };
    state.threads.unshift(newThread);
  }

  // Cap at 50 threads — drop oldest resolved first, then oldest overall
  if (state.threads.length > 50) {
    // Find the last resolved thread and remove it
    let lastResolvedIdx = -1;
    for (let i = state.threads.length - 1; i >= 0; i--) {
      if (state.threads[i].status === 'resolved') {
        lastResolvedIdx = i;
        break;
      }
    }
    if (lastResolvedIdx !== -1) {
      state.threads.splice(lastResolvedIdx, 1);
    } else {
      state.threads.pop();
    }
  }

  state.lastUpdated = now;

  try {
    saveThreads(state);
    console.log(`[threads] updated: topic="${topic}" threads=${state.threads.length}`);
  } catch (err) {
    console.error('[threads] failed to save:', err);
  }

  return state;
}

/**
 * Returns active (non-resolved) threads, sorted by last activity (newest first).
 */
export function getActiveThreads(): Thread[] {
  const state = loadThreads();
  return state.threads.filter((t) => t.status !== 'resolved');
}

/**
 * Marks a thread as parked by ID. Returns true if the thread was found and updated.
 */
export function parkThread(threadId: string): boolean {
  const state = loadThreads();
  const thread = state.threads.find((t) => t.id === threadId);
  if (!thread) return false;

  thread.status = 'parked';
  thread.lastActivity = new Date().toISOString();
  state.lastUpdated = thread.lastActivity;
  saveThreads(state);
  return true;
}

/**
 * Marks a thread as resolved by ID. Returns true if the thread was found and updated.
 */
export function resolveThread(threadId: string): boolean {
  const state = loadThreads();
  const thread = state.threads.find((t) => t.id === threadId);
  if (!thread) return false;

  thread.status = 'resolved';
  thread.lastActivity = new Date().toISOString();
  state.lastUpdated = thread.lastActivity;
  saveThreads(state);
  return true;
}
