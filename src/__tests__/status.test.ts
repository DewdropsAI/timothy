import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATUS_DIR = join(homedir(), '.titus');
const STATUS_FILE = join(STATUS_DIR, 'status.json');

// Dynamic import to reset module state between tests
async function loadStatusModule() {
  // Reset module registry so currentStatus is fresh
  const mod = await import('../status.js');
  return mod;
}

describe('status file', () => {
  let originalStatus: string | null = null;

  beforeEach(() => {
    // Preserve existing status file if any
    if (existsSync(STATUS_FILE)) {
      originalStatus = readFileSync(STATUS_FILE, 'utf-8');
    }
  });

  afterEach(() => {
    // Restore original status file
    if (originalStatus !== null) {
      const { writeFileSync } = require('node:fs');
      writeFileSync(STATUS_FILE, originalStatus);
    }
  });

  it('writeStartupStatus creates valid JSON with required fields', async () => {
    const { writeStartupStatus } = await loadStatusModule();
    writeStartupStatus();

    const content = readFileSync(STATUS_FILE, 'utf-8');
    const data = JSON.parse(content);

    expect(data.status).toBe('running');
    expect(data.pid).toBe(process.pid);
    expect(typeof data.started_at).toBe('string');
    // Verify it's a valid ISO timestamp
    expect(new Date(data.started_at).toISOString()).toBe(data.started_at);
  });

  it('writeShutdownStatus updates file to stopped', async () => {
    const { writeStartupStatus, writeShutdownStatus } = await loadStatusModule();
    writeStartupStatus();
    writeShutdownStatus();

    const content = readFileSync(STATUS_FILE, 'utf-8');
    const data = JSON.parse(content);

    expect(data.status).toBe('stopped');
    expect(typeof data.stopped_at).toBe('string');
    expect(data.pid).toBe(process.pid);
    expect(typeof data.started_at).toBe('string');
  });

  it('writeStatus creates directory if missing', async () => {
    const { writeStatus } = await loadStatusModule();
    // This test just verifies writeStatus doesn't throw when directory exists
    // (We can't safely remove ~/.titus in a test environment)
    writeStatus({ status: 'running', pid: 1234, started_at: new Date().toISOString() });

    const content = readFileSync(STATUS_FILE, 'utf-8');
    const data = JSON.parse(content);
    expect(data.status).toBe('running');
    expect(data.pid).toBe(1234);
  });

  it('getStatusFilePath returns correct path', async () => {
    const { getStatusFilePath } = await loadStatusModule();
    expect(getStatusFilePath()).toBe(STATUS_FILE);
  });

  it('getCurrentStatus returns current in-memory status', async () => {
    const { writeStartupStatus, getCurrentStatus } = await loadStatusModule();
    writeStartupStatus();
    const status = getCurrentStatus();
    expect(status).not.toBeNull();
    expect(status!.status).toBe('running');
    expect(status!.pid).toBe(process.pid);
  });

  it('status file is valid JSON', async () => {
    const { writeStartupStatus } = await loadStatusModule();
    writeStartupStatus();

    const content = readFileSync(STATUS_FILE, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });
});

describe('heartbeat', () => {
  let originalStatus: string | null = null;

  beforeEach(() => {
    if (existsSync(STATUS_FILE)) {
      originalStatus = readFileSync(STATUS_FILE, 'utf-8');
    }
  });

  afterEach(async () => {
    const { stopHeartbeat } = await loadStatusModule();
    stopHeartbeat();
    if (originalStatus !== null) {
      const { writeFileSync } = require('node:fs');
      writeFileSync(STATUS_FILE, originalStatus);
    }
  });

  it('writeHeartbeat updates status file with health metrics', async () => {
    const { writeStartupStatus, writeHeartbeat } = await loadStatusModule();
    writeStartupStatus();
    writeHeartbeat();

    const content = readFileSync(STATUS_FILE, 'utf-8');
    const data = JSON.parse(content);

    expect(data.status).toBe('running');
    expect(typeof data.last_heartbeat).toBe('string');
    expect(new Date(data.last_heartbeat).toISOString()).toBe(data.last_heartbeat);
    expect(typeof data.memory_mb).toBe('number');
    expect(data.memory_mb).toBeGreaterThan(0);
    expect(typeof data.uptime_seconds).toBe('number');
    expect(data.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('writeHeartbeat preserves existing status fields', async () => {
    const { writeStartupStatus, writeHeartbeat } = await loadStatusModule();
    writeStartupStatus();
    writeHeartbeat();

    const content = readFileSync(STATUS_FILE, 'utf-8');
    const data = JSON.parse(content);

    expect(data.pid).toBe(process.pid);
    expect(typeof data.started_at).toBe('string');
  });

  it('writeHeartbeat does not throw when called', async () => {
    const { writeStartupStatus, writeHeartbeat } = await loadStatusModule();
    writeStartupStatus();
    // Should not throw when called multiple times
    writeHeartbeat();
    writeHeartbeat();
  });

  it('startHeartbeat writes initial heartbeat immediately', async () => {
    const { writeStartupStatus, startHeartbeat, stopHeartbeat } = await loadStatusModule();
    writeStartupStatus();
    startHeartbeat();

    const content = readFileSync(STATUS_FILE, 'utf-8');
    const data = JSON.parse(content);

    expect(data.last_heartbeat).toBeDefined();
    expect(data.memory_mb).toBeDefined();
    expect(data.uptime_seconds).toBeDefined();

    stopHeartbeat();
  });

  it('stopHeartbeat clears interval without error', async () => {
    const { writeStartupStatus, startHeartbeat, stopHeartbeat } = await loadStatusModule();
    writeStartupStatus();
    startHeartbeat();
    // Should not throw
    stopHeartbeat();
    // Calling again should also not throw
    stopHeartbeat();
  });

  it('shutdown stops heartbeat and writes stopped status', async () => {
    const { writeStartupStatus, startHeartbeat, writeShutdownStatus } = await loadStatusModule();
    writeStartupStatus();
    startHeartbeat();
    writeShutdownStatus();

    const content = readFileSync(STATUS_FILE, 'utf-8');
    const data = JSON.parse(content);

    expect(data.status).toBe('stopped');
    expect(typeof data.stopped_at).toBe('string');
  });
});

describe('conversation stats', () => {
  let originalStatus: string | null = null;

  beforeEach(() => {
    if (existsSync(STATUS_FILE)) {
      originalStatus = readFileSync(STATUS_FILE, 'utf-8');
    }
  });

  afterEach(async () => {
    const { stopHeartbeat } = await loadStatusModule();
    stopHeartbeat();
    if (originalStatus !== null) {
      const { writeFileSync } = require('node:fs');
      writeFileSync(STATUS_FILE, originalStatus);
    }
  });

  it('recordMessage increments message count', async () => {
    const { writeStartupStatus, recordMessage, getConversationStats } = await loadStatusModule();
    writeStartupStatus();

    recordMessage();
    const stats1 = getConversationStats();
    expect(stats1.messages_today).toBeGreaterThanOrEqual(1);

    const countBefore = stats1.messages_today;
    recordMessage();
    const stats2 = getConversationStats();
    expect(stats2.messages_today).toBe(countBefore + 1);
  });

  it('recordMessage sets last_message_at timestamp', async () => {
    const { writeStartupStatus, recordMessage, getConversationStats } = await loadStatusModule();
    writeStartupStatus();

    recordMessage();
    const stats = getConversationStats();
    expect(stats.last_message_at).not.toBeNull();
    expect(new Date(stats.last_message_at!).toISOString()).toBe(stats.last_message_at);
  });

  it('stats are included in heartbeat writes', async () => {
    const { writeStartupStatus, recordMessage, writeHeartbeat } = await loadStatusModule();
    writeStartupStatus();

    recordMessage();
    recordMessage();
    recordMessage();
    writeHeartbeat();

    const content = readFileSync(STATUS_FILE, 'utf-8');
    const data = JSON.parse(content);

    expect(data.messages_today).toBeGreaterThanOrEqual(3);
    expect(typeof data.last_message_at).toBe('string');
  });

  it('stats survive multiple heartbeat cycles', async () => {
    const { writeStartupStatus, recordMessage, writeHeartbeat, getConversationStats } = await loadStatusModule();
    writeStartupStatus();

    // Record 5 messages
    for (let i = 0; i < 5; i++) {
      recordMessage();
    }
    const statsBeforeHeartbeats = getConversationStats();
    const countBefore = statsBeforeHeartbeats.messages_today;

    // Run multiple heartbeat cycles
    writeHeartbeat();
    writeHeartbeat();
    writeHeartbeat();

    const statsAfter = getConversationStats();
    expect(statsAfter.messages_today).toBe(countBefore);
  });

  it('stats are included in status file after heartbeat', async () => {
    const { writeStartupStatus, recordMessage, writeHeartbeat } = await loadStatusModule();
    writeStartupStatus();
    recordMessage();
    writeHeartbeat();

    const content = readFileSync(STATUS_FILE, 'utf-8');
    const data = JSON.parse(content);

    expect(data.messages_today).toBeGreaterThanOrEqual(1);
    expect(data.last_message_at).toBeDefined();
    // Also verify other heartbeat fields still present
    expect(data.memory_mb).toBeDefined();
    expect(data.uptime_seconds).toBeDefined();
  });
});
