import { describe, it, expect, beforeEach } from 'vitest';
import { AdapterRegistry, collectStreamToResult } from '../adapter.js';
import type { CognitiveAdapter } from '../adapter.js';
import type {
  AdapterInput,
  StreamHandle,
  StreamChunk,
  ThoughtResult,
  HealthCheckResult,
} from '../types.js';
import { MockAdapter } from './helpers/test-adapter.js';

// ── AdapterRegistry ─────────────────────────────────────────────────

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  describe('register', () => {
    it('registers an adapter', () => {
      const adapter = new MockAdapter('cli');
      registry.register(adapter);
      expect(registry.has('cli')).toBe(true);
    });

    it('throws when registering a duplicate name', () => {
      registry.register(new MockAdapter('cli'));
      expect(() => registry.register(new MockAdapter('cli'))).toThrow(
        "Adapter 'cli' is already registered",
      );
    });

    it('sets first registered adapter as default', () => {
      const adapter = new MockAdapter('cli');
      registry.register(adapter);
      expect(registry.getDefault().name).toBe('cli');
    });

    it('does not change default when registering subsequent adapters', () => {
      registry.register(new MockAdapter('cli'));
      registry.register(new MockAdapter('api'));
      expect(registry.getDefault().name).toBe('cli');
    });
  });

  describe('get', () => {
    it('returns the registered adapter by name', () => {
      const adapter = new MockAdapter('cli');
      registry.register(adapter);
      expect(registry.get('cli')).toBe(adapter);
    });

    it('throws for unknown adapter name', () => {
      expect(() => registry.get('nonexistent')).toThrow(
        "Adapter 'nonexistent' is not registered",
      );
    });

    it('lists available adapters in error message', () => {
      registry.register(new MockAdapter('cli'));
      registry.register(new MockAdapter('api'));
      expect(() => registry.get('nope')).toThrow('Available: cli, api');
    });
  });

  describe('has', () => {
    it('returns true for registered adapter', () => {
      registry.register(new MockAdapter('cli'));
      expect(registry.has('cli')).toBe(true);
    });

    it('returns false for unregistered adapter', () => {
      expect(registry.has('cli')).toBe(false);
    });
  });

  describe('getDefault', () => {
    it('throws when no adapters are registered', () => {
      expect(() => registry.getDefault()).toThrow('No adapters registered');
    });

    it('returns first registered adapter by default', () => {
      registry.register(new MockAdapter('cli'));
      registry.register(new MockAdapter('api'));
      expect(registry.getDefault().name).toBe('cli');
    });
  });

  describe('setDefault', () => {
    it('changes the default adapter', () => {
      registry.register(new MockAdapter('cli'));
      registry.register(new MockAdapter('api'));
      registry.setDefault('api');
      expect(registry.getDefault().name).toBe('api');
    });

    it('throws when setting default to unregistered adapter', () => {
      expect(() => registry.setDefault('nope')).toThrow(
        "Cannot set default: adapter 'nope' is not registered",
      );
    });
  });

  describe('list and listNames', () => {
    it('lists all registered adapters', () => {
      registry.register(new MockAdapter('cli'));
      registry.register(new MockAdapter('api'));

      expect(registry.listNames()).toEqual(['cli', 'api']);
      expect(registry.list()).toHaveLength(2);
    });

    it('returns empty arrays when no adapters registered', () => {
      expect(registry.listNames()).toEqual([]);
      expect(registry.list()).toEqual([]);
    });
  });

  describe('unregister', () => {
    it('removes an adapter', async () => {
      registry.register(new MockAdapter('cli'));
      await registry.unregister('cli');
      expect(registry.has('cli')).toBe(false);
    });

    it('calls shutdown on the adapter', async () => {
      const adapter = new MockAdapter('cli');
      let shutdownCalled = false;
      adapter.shutdown = async () => {
        shutdownCalled = true;
      };
      registry.register(adapter);
      await registry.unregister('cli');
      expect(shutdownCalled).toBe(true);
    });

    it('updates default when default is unregistered', async () => {
      registry.register(new MockAdapter('cli'));
      registry.register(new MockAdapter('api'));
      expect(registry.getDefault().name).toBe('cli');

      await registry.unregister('cli');
      expect(registry.getDefault().name).toBe('api');
    });

    it('is a no-op for unknown name', async () => {
      await registry.unregister('nonexistent');
      // Should not throw
    });
  });

  describe('healthCheckAll', () => {
    it('returns health for all adapters', async () => {
      const healthy = new MockAdapter('healthy');
      const unhealthy = new MockAdapter('unhealthy');
      unhealthy.setHealthy(false, 'Connection refused');

      registry.register(healthy);
      registry.register(unhealthy);

      const results = await registry.healthCheckAll();
      expect(results.healthy.healthy).toBe(true);
      expect(results.unhealthy.healthy).toBe(false);
      expect(results.unhealthy.message).toBe('Connection refused');
    });

    it('handles health check exceptions gracefully', async () => {
      const adapter = new MockAdapter('broken');
      adapter.healthCheck = async () => {
        throw new Error('health check exploded');
      };
      registry.register(adapter);

      const results = await registry.healthCheckAll();
      expect(results.broken.healthy).toBe(false);
    });
  });

  describe('shutdownAll', () => {
    it('shuts down all adapters and clears registry', async () => {
      registry.register(new MockAdapter('cli'));
      registry.register(new MockAdapter('api'));

      await registry.shutdownAll();
      expect(registry.listNames()).toEqual([]);
      expect(() => registry.getDefault()).toThrow('No adapters registered');
    });
  });
});

// ── MockAdapter contract (CognitiveAdapter interface) ───────────────

describe('CognitiveAdapter interface via MockAdapter', () => {
  let adapter: MockAdapter;

  const makeInput = (message = 'Hello'): AdapterInput => ({
    message,
    history: [],
    systemPrompt: 'You are Titus.',
    route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
    workspacePath: '/tmp/test-workspace',
    effectiveMode: 'yolo',
  });

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  it('invoke returns a ThoughtResult', async () => {
    const result = await adapter.invoke(makeInput());
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('memoryWrites');
    expect(result).toHaveProperty('cleanText');
    expect(result).toHaveProperty('mode', 'mock');
    expect(result).toHaveProperty('modelUsed', 'claude-sonnet-4-6');
    expect(result).toHaveProperty('elapsedMs');
  });

  it('invoke records invocations', async () => {
    const input = makeInput('Test message');
    await adapter.invoke(input);
    expect(adapter.getInvocations()).toHaveLength(1);
    expect(adapter.getLastInvocation()!.message).toBe('Test message');
  });

  it('invoke uses pattern-matched responses', async () => {
    adapter.setResponse('weather', 'It is sunny today.');
    const result = await adapter.invoke(makeInput('What is the weather?'));
    expect(result.text).toBe('It is sunny today.');
  });

  it('invoke falls back to default response', async () => {
    adapter.setDefaultResponse('Default reply');
    const result = await adapter.invoke(makeInput('Random question'));
    expect(result.text).toBe('Default reply');
  });

  it('invoke throws when error is set', async () => {
    adapter.setError(new Error('Simulated failure'));
    await expect(adapter.invoke(makeInput())).rejects.toThrow('Simulated failure');
  });

  it('invokeStreaming returns a StreamHandle', async () => {
    const handle = await adapter.invokeStreaming(makeInput());
    expect(handle).toHaveProperty('chunks');
    expect(handle).toHaveProperty('abort');

    const chunks: StreamChunk[] = [];
    for await (const chunk of handle.chunks) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.type === 'text')).toBe(true);
  });

  it('healthCheck returns configured status', async () => {
    adapter.setHealthy(true);
    let result = await adapter.healthCheck();
    expect(result.healthy).toBe(true);

    adapter.setHealthy(false, 'Down for maintenance');
    result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.message).toBe('Down for maintenance');
  });

  it('reset clears all state', async () => {
    adapter.setResponse('test', 'matched');
    adapter.setError(new Error('fail'));
    await adapter.invoke(makeInput()).catch(() => {});

    adapter.reset();
    expect(adapter.getInvocations()).toHaveLength(0);

    const result = await adapter.invoke(makeInput());
    expect(result.text).toBe('Mock response');
  });
});

// ── collectStreamToResult ───────────────────────────────────────────

describe('collectStreamToResult', () => {
  it('collects text chunks into a ThoughtResult', async () => {
    async function* textChunks(): AsyncGenerator<StreamChunk, void, unknown> {
      yield { type: 'text', text: 'Hello ' };
      yield { type: 'text', text: 'world' };
      yield { type: 'done', text: '' };
    }

    const handle: StreamHandle = {
      chunks: textChunks(),
      abort: () => {},
    };

    const result = await collectStreamToResult(handle, 'test', 'model-1', Date.now());
    expect(result.text).toBe('Hello world');
    expect(result.cleanText).toBe('Hello world');
    expect(result.mode).toBe('test');
    expect(result.modelUsed).toBe('model-1');
  });

  it('returns error text on error chunk', async () => {
    async function* errorChunks(): AsyncGenerator<StreamChunk, void, unknown> {
      yield { type: 'error', text: 'Something went wrong' };
    }

    const handle: StreamHandle = {
      chunks: errorChunks(),
      abort: () => {},
    };

    const result = await collectStreamToResult(handle, 'test', 'model-1', Date.now());
    expect(result.text).toBe('Something went wrong');
    expect(result.memoryWrites).toEqual([]);
  });

  it('extracts writeback directives from response text', async () => {
    const responseWithDirective = [
      'I will remember that.',
      '<!--titus-write',
      'file: memory/facts/test.md',
      'action: create',
      'A test fact.',
      '-->',
      'Anything else?',
    ].join('\n');

    async function* chunks(): AsyncGenerator<StreamChunk, void, unknown> {
      yield { type: 'text', text: responseWithDirective };
      yield { type: 'done', text: '' };
    }

    const handle: StreamHandle = { chunks: chunks(), abort: () => {} };
    const result = await collectStreamToResult(handle, 'test', 'model-1', Date.now());

    expect(result.memoryWrites).toHaveLength(1);
    expect(result.memoryWrites[0].file).toBe('memory/facts/test.md');
    expect(result.cleanText).not.toContain('<!--titus-write');
    expect(result.cleanText).toContain('I will remember that.');
    expect(result.cleanText).toContain('Anything else?');
  });
});
