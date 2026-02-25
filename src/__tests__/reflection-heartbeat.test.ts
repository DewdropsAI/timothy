import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setMemoryDir, _setWorkingMemoryDir } from '../memory.js';
import {
  startReflectionHeartbeat,
  stopReflectionHeartbeat,
  _isHeartbeatRunning,
  _getInFlightReflection,
  _setReflectionInvoker,
  _setLastReflectionTime,
  recordUserActivity,
} from '../reflection.js';

const tmpWm = join(tmpdir(), 'titus-test-rh-wm');
const tmpMem = join(tmpdir(), 'titus-test-rh-mem');

beforeEach(() => {
  rmSync(tmpWm, { recursive: true, force: true });
  rmSync(tmpMem, { recursive: true, force: true });
  mkdirSync(tmpWm, { recursive: true });
  mkdirSync(tmpMem, { recursive: true });
  _setWorkingMemoryDir(tmpWm);
  _setMemoryDir(tmpMem);
  _setReflectionInvoker(null);
  _setLastReflectionTime(0);
});

afterEach(async () => {
  _setReflectionInvoker(null);
  _setLastReflectionTime(0);
  await stopReflectionHeartbeat();
  rmSync(tmpWm, { recursive: true, force: true });
  rmSync(tmpMem, { recursive: true, force: true });
});

describe('reflection heartbeat (CognitiveLoop)', () => {
  it('startReflectionHeartbeat creates a cognitive loop and marks it running', () => {
    expect(_isHeartbeatRunning()).toBe(false);

    startReflectionHeartbeat();
    expect(_isHeartbeatRunning()).toBe(true);
  });

  it('calling startReflectionHeartbeat twice warns and stays running', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    startReflectionHeartbeat();
    startReflectionHeartbeat(); // second call should warn

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('already running'),
    );
    expect(_isHeartbeatRunning()).toBe(true);

    warnSpy.mockRestore();
  });

  it('stopReflectionHeartbeat stops the loop', async () => {
    startReflectionHeartbeat();
    expect(_isHeartbeatRunning()).toBe(true);

    await stopReflectionHeartbeat();
    expect(_isHeartbeatRunning()).toBe(false);
  });

  it('stopReflectionHeartbeat is idempotent', async () => {
    await stopReflectionHeartbeat();
    await stopReflectionHeartbeat();
    // Should not throw
    expect(_isHeartbeatRunning()).toBe(false);
  });

  it('_isHeartbeatRunning returns false before start', () => {
    expect(_isHeartbeatRunning()).toBe(false);
  });

  it('_isHeartbeatRunning returns false after stop', async () => {
    startReflectionHeartbeat();
    await stopReflectionHeartbeat();
    expect(_isHeartbeatRunning()).toBe(false);
  });

  it('recordUserActivity does not throw when no loop is running', () => {
    // No loop started — should silently do nothing
    expect(() => recordUserActivity()).not.toThrow();
  });

  it('recordUserActivity does not throw when loop is running', () => {
    startReflectionHeartbeat();
    expect(() => recordUserActivity()).not.toThrow();
  });

  it('_getInFlightReflection returns null when idle', () => {
    startReflectionHeartbeat();
    expect(_getInFlightReflection()).toBeNull();
  });

  it('can restart after stopping', async () => {
    startReflectionHeartbeat();
    expect(_isHeartbeatRunning()).toBe(true);

    await stopReflectionHeartbeat();
    expect(_isHeartbeatRunning()).toBe(false);

    startReflectionHeartbeat();
    expect(_isHeartbeatRunning()).toBe(true);
  });
});
