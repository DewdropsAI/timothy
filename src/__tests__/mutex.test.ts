import { describe, it, expect } from 'vitest';
import { KeyedMutex } from '../mutex.js';

describe('KeyedMutex', () => {
  it('runs a single task immediately', async () => {
    const mutex = new KeyedMutex();
    const result = await mutex.run('a', async () => 42);
    expect(result).toBe(42);
  });

  it('serialises concurrent tasks on the same key', async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];

    const task = (id: number, delayMs: number) =>
      mutex.run('chat-1', async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(id * 10);
      });

    // Fire three tasks concurrently — they should execute in FIFO order
    await Promise.all([task(1, 30), task(2, 10), task(3, 10)]);

    // Task 1 starts and finishes, then 2, then 3
    expect(order).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it('allows concurrent tasks on different keys', async () => {
    const mutex = new KeyedMutex();
    const running: string[] = [];

    const task = (key: string) =>
      mutex.run(key, async () => {
        running.push(`start-${key}`);
        await new Promise((r) => setTimeout(r, 20));
        running.push(`end-${key}`);
      });

    await Promise.all([task('a'), task('b')]);

    // Both should start before either ends (parallel execution)
    expect(running.indexOf('start-a')).toBeLessThan(running.indexOf('end-a'));
    expect(running.indexOf('start-b')).toBeLessThan(running.indexOf('end-b'));
    // Both started before any ended
    expect(running.indexOf('start-b')).toBeLessThan(running.indexOf('end-a'));
  });

  it('propagates errors from the task', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.run('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('releases the lock even when a task throws', async () => {
    const mutex = new KeyedMutex();

    // First task throws
    await mutex
      .run('a', async () => {
        throw new Error('boom');
      })
      .catch(() => {});

    // Second task on the same key should still run
    const result = await mutex.run('a', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('cleans up the lock map after the last task finishes', async () => {
    const mutex = new KeyedMutex();

    await mutex.run('a', async () => 'done');
    expect(mutex.size).toBe(0);
  });

  it('works with numeric keys', async () => {
    const mutex = new KeyedMutex();
    const result = await mutex.run(12345, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('returns the value from the wrapped function', async () => {
    const mutex = new KeyedMutex();
    const result = await mutex.run('a', async () => ({ status: 'success', count: 7 }));
    expect(result).toEqual({ status: 'success', count: 7 });
  });
});
