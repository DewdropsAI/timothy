import type {
  AdapterInput,
  StreamHandle,
  StreamChunk,
  HealthCheckResult,
  ThoughtResult,
} from './types.js';
import { extractWritebacks } from './continuity.js';

/**
 * A pluggable cognitive mode adapter.
 * Implementations handle invocation details (spawning CLI, calling API, etc.)
 * while conforming to the agent's input/output contract.
 */
export interface CognitiveAdapter {
  readonly name: string;
  invoke(input: AdapterInput): Promise<ThoughtResult>;
  invokeStreaming(input: AdapterInput): Promise<StreamHandle>;
  healthCheck(): Promise<HealthCheckResult>;
  shutdown?(): Promise<void>;
}

/**
 * Global registry for cognitive mode adapters.
 * Allows plugins to register new modes at runtime.
 */
export class AdapterRegistry {
  private adapters = new Map<string, CognitiveAdapter>();
  private defaultName: string | null = null;

  register(adapter: CognitiveAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter '${adapter.name}' is already registered`);
    }
    this.adapters.set(adapter.name, adapter);
    if (this.defaultName === null) {
      this.defaultName = adapter.name;
    }
  }

  get(name: string): CognitiveAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Adapter '${name}' is not registered. Available: ${this.listNames().join(', ')}`);
    }
    return adapter;
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  getDefault(): CognitiveAdapter {
    if (this.defaultName === null) {
      throw new Error('No adapters registered');
    }
    return this.get(this.defaultName);
  }

  setDefault(name: string): void {
    if (!this.adapters.has(name)) {
      throw new Error(`Cannot set default: adapter '${name}' is not registered`);
    }
    this.defaultName = name;
  }

  list(): CognitiveAdapter[] {
    return [...this.adapters.values()];
  }

  listNames(): string[] {
    return [...this.adapters.keys()];
  }

  async unregister(name: string): Promise<void> {
    const adapter = this.adapters.get(name);
    if (adapter) {
      await adapter.shutdown?.();
      this.adapters.delete(name);
      if (this.defaultName === name) {
        const remaining = [...this.adapters.keys()];
        this.defaultName = remaining.length > 0 ? remaining[0] : null;
      }
    }
  }

  async healthCheckAll(): Promise<Record<string, HealthCheckResult>> {
    const results: Record<string, HealthCheckResult> = {};
    const entries = [...this.adapters.entries()];
    const checks = await Promise.allSettled(
      entries.map(([name, adapter]) =>
        adapter.healthCheck().then((r) => ({ name, result: r })),
      ),
    );
    for (const check of checks) {
      if (check.status === 'fulfilled') {
        results[check.value.name] = check.value.result;
      } else {
        const name = entries[checks.indexOf(check)][0];
        results[name] = { healthy: false, message: String(check.reason) };
      }
    }
    return results;
  }

  async shutdownAll(): Promise<void> {
    const adapters = [...this.adapters.values()];
    await Promise.allSettled(adapters.map((a) => a.shutdown?.()));
    this.adapters.clear();
    this.defaultName = null;
  }
}

/**
 * Helper: collect a streaming response into a ThoughtResult.
 * Used by adapter.invoke() implementations that delegate to invokeStreaming().
 */
export async function collectStreamToResult(
  handle: StreamHandle,
  adapterName: string,
  model: string,
  startMs: number,
): Promise<ThoughtResult> {
  const parts: string[] = [];

  for await (const chunk of handle.chunks) {
    if (chunk.type === 'text') {
      parts.push(chunk.text);
    } else if (chunk.type === 'error') {
      return {
        text: chunk.text,
        memoryWrites: [],
        cleanText: chunk.text,
        mode: adapterName,
        modelUsed: model,
        elapsedMs: Date.now() - startMs,
      };
    }
  }

  const text = parts.join('');
  const { directives, cleanResponse } = extractWritebacks(text);

  return {
    text,
    memoryWrites: directives,
    cleanText: cleanResponse,
    mode: adapterName,
    modelUsed: model,
    elapsedMs: Date.now() - startMs,
  };
}
