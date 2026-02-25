import { describe, it, expect, beforeEach } from 'vitest';
import { AdapterRegistry } from '../../adapter.js';
import { MockAdapter } from '../helpers/test-adapter.js';
import type { AdapterInput } from '../../types.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal AdapterInput
// ---------------------------------------------------------------------------

function makeInput(message = 'Hello'): AdapterInput {
  return {
    message,
    history: [],
    systemPrompt: 'You are Titus.',
    route: { model: 'claude-sonnet-4-6', mode: 'yolo', timeoutMs: 300_000 },
    workspacePath: '/tmp/test-workspace',
    effectiveMode: 'yolo',
  };
}

// ===========================================================================
// Registry resilience tests
// ===========================================================================

describe('integration: adapter registry resilience', () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  // ── Fallback when preferred adapter unavailable ────────────────────

  describe('fallback when preferred adapter unavailable', () => {
    it('falls back to registered adapter when preferred is missing', () => {
      const fallback = new MockAdapter('claude-code-cli');
      registry.register(fallback);

      // 'anthropic-api' is not registered, so we should fall back
      const hasPreferred = registry.has('anthropic-api');
      expect(hasPreferred).toBe(false);

      const adapterName = registry.has('anthropic-api')
        ? 'anthropic-api'
        : 'claude-code-cli';

      expect(adapterName).toBe('claude-code-cli');
      expect(() => registry.get(adapterName)).not.toThrow();
    });

    it('invocation through fallback adapter succeeds', async () => {
      const fallback = new MockAdapter('claude-code-cli');
      fallback.setDefaultResponse('Fallback response');
      registry.register(fallback);

      const adapterName = registry.has('anthropic-api')
        ? 'anthropic-api'
        : 'claude-code-cli';

      const adapter = registry.get(adapterName);
      const result = await adapter.invoke(makeInput());

      expect(result.text).toBe('Fallback response');
      expect(fallback.getInvocations()).toHaveLength(1);
    });

    it('prefers preferred adapter when both are registered', async () => {
      const cli = new MockAdapter('claude-code-cli');
      cli.setDefaultResponse('CLI response');
      const api = new MockAdapter('anthropic-api');
      api.setDefaultResponse('API response');

      registry.register(cli);
      registry.register(api);

      // Preferred for reflection/summarization/extraction is 'anthropic-api'
      const adapterName = registry.has('anthropic-api')
        ? 'anthropic-api'
        : 'claude-code-cli';

      const adapter = registry.get(adapterName);
      const result = await adapter.invoke(makeInput());

      expect(result.text).toBe('API response');
    });
  });

  // ── healthCheckAll reports status of all adapters ─────────────────

  describe('healthCheckAll reports status', () => {
    it('reports healthy status for all healthy adapters', async () => {
      const healthy1 = new MockAdapter('adapter-a');
      const healthy2 = new MockAdapter('adapter-b');
      registry.register(healthy1);
      registry.register(healthy2);

      const results = await registry.healthCheckAll();

      expect(results['adapter-a'].healthy).toBe(true);
      expect(results['adapter-b'].healthy).toBe(true);
    });

    it('reports unhealthy status for failing adapters', async () => {
      const healthy = new MockAdapter('healthy-adapter');
      const unhealthy = new MockAdapter('unhealthy-adapter');
      unhealthy.setHealthy(false, 'Connection refused');

      registry.register(healthy);
      registry.register(unhealthy);

      const results = await registry.healthCheckAll();

      expect(results['healthy-adapter'].healthy).toBe(true);
      expect(results['unhealthy-adapter'].healthy).toBe(false);
      expect(results['unhealthy-adapter'].message).toBe('Connection refused');
    });

    it('handles health check exceptions without crashing', async () => {
      const broken = new MockAdapter('broken-adapter');
      broken.healthCheck = async () => {
        throw new Error('health check exploded');
      };
      registry.register(broken);

      const results = await registry.healthCheckAll();

      expect(results['broken-adapter'].healthy).toBe(false);
    });

    it('returns empty object when no adapters registered', async () => {
      const results = await registry.healthCheckAll();
      expect(Object.keys(results)).toHaveLength(0);
    });
  });

  // ── shutdownAll ───────────────────────────────────────────────────

  describe('shutdownAll calls shutdown on all adapters', () => {
    it('shuts down all registered adapters and clears registry', async () => {
      const shutdownLog: string[] = [];

      const adapterA = new MockAdapter('adapter-a');
      adapterA.shutdown = async () => {
        shutdownLog.push('a');
      };
      const adapterB = new MockAdapter('adapter-b');
      adapterB.shutdown = async () => {
        shutdownLog.push('b');
      };

      registry.register(adapterA);
      registry.register(adapterB);

      await registry.shutdownAll();

      expect(shutdownLog).toContain('a');
      expect(shutdownLog).toContain('b');
      expect(registry.listNames()).toEqual([]);
    });

    it('handles shutdown errors gracefully', async () => {
      const broken = new MockAdapter('broken');
      broken.shutdown = async () => {
        throw new Error('shutdown failed');
      };
      const healthy = new MockAdapter('healthy');
      let healthyShutdown = false;
      healthy.shutdown = async () => {
        healthyShutdown = true;
      };

      registry.register(broken);
      registry.register(healthy);

      // Should not throw even though one adapter's shutdown fails
      await registry.shutdownAll();

      expect(healthyShutdown).toBe(true);
      expect(registry.listNames()).toEqual([]);
    });
  });

  // ── Unregistered adapter name ─────────────────────────────────────

  describe('unregistered adapter name throws descriptive error', () => {
    it('throws with available adapter names listed', () => {
      registry.register(new MockAdapter('claude-code-cli'));
      registry.register(new MockAdapter('anthropic-api'));

      expect(() => registry.get('nonexistent-adapter')).toThrow(
        /nonexistent-adapter.*not registered/,
      );
      expect(() => registry.get('nonexistent-adapter')).toThrow(
        /Available: claude-code-cli, anthropic-api/,
      );
    });

    it('throws with empty available list when no adapters registered', () => {
      expect(() => registry.get('anything')).toThrow(
        /anything.*not registered/,
      );
    });
  });

  // ── Adapter invocation error does not corrupt registry ────────────

  describe('adapter error does not corrupt registry', () => {
    it('registry remains functional after adapter throws', async () => {
      const adapter = new MockAdapter('claude-code-cli');
      registry.register(adapter);

      // Make it throw
      adapter.setError(new Error('Simulated failure'));
      await expect(adapter.invoke(makeInput())).rejects.toThrow('Simulated failure');

      // Registry should still work
      expect(registry.has('claude-code-cli')).toBe(true);
      expect(registry.get('claude-code-cli')).toBe(adapter);

      // Adapter should work after clearing error
      adapter.clearError();
      adapter.setDefaultResponse('Recovered');
      const result = await adapter.invoke(makeInput());
      expect(result.text).toBe('Recovered');
    });

    it('can unregister and re-register adapter after failure', async () => {
      const adapter = new MockAdapter('claude-code-cli');
      registry.register(adapter);

      adapter.setError(new Error('Failure'));
      await expect(adapter.invoke(makeInput())).rejects.toThrow();

      await registry.unregister('claude-code-cli');
      expect(registry.has('claude-code-cli')).toBe(false);

      const fresh = new MockAdapter('claude-code-cli');
      fresh.setDefaultResponse('Fresh adapter');
      registry.register(fresh);

      const result = await fresh.invoke(makeInput());
      expect(result.text).toBe('Fresh adapter');
    });
  });

  // ── Default adapter management ────────────────────────────────────

  describe('default adapter management under fallback scenarios', () => {
    it('default shifts to next adapter when default is unregistered', async () => {
      registry.register(new MockAdapter('primary'));
      registry.register(new MockAdapter('secondary'));

      expect(registry.getDefault().name).toBe('primary');

      await registry.unregister('primary');

      expect(registry.getDefault().name).toBe('secondary');
    });

    it('throws when getting default after all adapters removed', async () => {
      registry.register(new MockAdapter('only'));

      await registry.unregister('only');

      expect(() => registry.getDefault()).toThrow('No adapters registered');
    });
  });
});
