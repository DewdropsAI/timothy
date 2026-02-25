import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { identity } from './identity.js';

const STATUS_DIR = join(homedir(), identity.configDir);
const STATUS_FILE = join(STATUS_DIR, 'status.json');

export interface StatusData {
  status: 'running' | 'stopped';
  pid?: number;
  started_at?: string;
  stopped_at?: string;
  last_heartbeat?: string;
  memory_mb?: number;
  uptime_seconds?: number;
  messages_today?: number;
  last_message_at?: string;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

let currentStatus: StatusData | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// Conversation stats tracked in memory
let messagesToday = 0;
let lastMessageAt: string | null = null;
let currentDateUTC: string | null = null;

function getUTCDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns the path to the status file.
 */
export function getStatusFilePath(): string {
  return STATUS_FILE;
}

/**
 * Returns the current in-memory status data.
 */
export function getCurrentStatus(): StatusData | null {
  return currentStatus;
}

/**
 * Write status data to ~/<configDir>/status.json.
 * Creates the directory if it doesn't exist.
 */
export function writeStatus(data: StatusData): void {
  mkdirSync(STATUS_DIR, { recursive: true });
  currentStatus = data;
  writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Write the "running" status on bot startup.
 */
export function writeStartupStatus(): void {
  writeStatus({
    status: 'running',
    pid: process.pid,
    started_at: new Date().toISOString(),
  });
}

/**
 * Write a heartbeat update to the status file.
 * Preserves existing fields and adds health metrics.
 */
export function writeHeartbeat(): void {
  if (!currentStatus) return;

  const now = new Date();
  const startedAt = currentStatus.started_at
    ? new Date(currentStatus.started_at)
    : now;
  const uptimeSeconds = Math.floor((now.getTime() - startedAt.getTime()) / 1000);
  const memoryMb = Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100;

  writeStatus({
    ...currentStatus,
    last_heartbeat: now.toISOString(),
    memory_mb: memoryMb,
    uptime_seconds: uptimeSeconds,
  });
}

/**
 * Start the periodic heartbeat timer.
 * Uses unref() so the timer doesn't prevent Node.js from exiting.
 */
export function startHeartbeat(): void {
  // Write initial heartbeat immediately
  writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

/**
 * Stop the periodic heartbeat timer.
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Record a message for conversation statistics.
 * Increments the daily message counter and updates last_message_at.
 * Resets the counter on a new UTC calendar day.
 */
export function recordMessage(): void {
  const now = new Date();
  const todayUTC = getUTCDateString(now);

  if (currentDateUTC !== todayUTC) {
    messagesToday = 0;
    currentDateUTC = todayUTC;
  }

  messagesToday++;
  lastMessageAt = now.toISOString();

  // Update in-memory status so next heartbeat picks up stats
  if (currentStatus) {
    currentStatus.messages_today = messagesToday;
    currentStatus.last_message_at = lastMessageAt;
  }
}

/**
 * Returns the current conversation stats.
 */
export function getConversationStats(): { messages_today: number; last_message_at: string | null } {
  return { messages_today: messagesToday, last_message_at: lastMessageAt };
}

/**
 * Update the status file to "stopped" on bot shutdown.
 */
export function writeShutdownStatus(): void {
  stopHeartbeat();
  const now = new Date().toISOString();
  const data: StatusData = {
    status: 'stopped',
    stopped_at: now,
  };
  if (currentStatus) {
    data.pid = currentStatus.pid;
    data.started_at = currentStatus.started_at;
  }
  writeStatus(data);
}
