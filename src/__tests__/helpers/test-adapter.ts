/**
 * Mock CognitiveAdapter for testing.
 *
 * Configurable responses, error simulation, and invocation recording.
 * Follows the CognitiveAdapter interface from adapter.ts.
 */

import type { CognitiveAdapter } from '../../adapter.js';
import type {
  AdapterInput,
  StreamHandle,
  StreamChunk,
  ThoughtResult,
  HealthCheckResult,
} from '../../types.js';

export class MockAdapter implements CognitiveAdapter {
  readonly name: string;
  private responses: Map<string, string> = new Map();
  private defaultResponse = 'Mock response';
  private _invocations: AdapterInput[] = [];
  private _healthy = true;
  private _healthMessage?: string;
  private _latencyMs = 0;
  private _shouldThrow = false;
  private _throwError?: Error;

  constructor(name = 'mock') {
    this.name = name;
  }

  /** Set a response for a specific message pattern (substring match). */
  setResponse(pattern: string, response: string): void {
    this.responses.set(pattern, response);
  }

  /** Set the default response when no pattern matches. */
  setDefaultResponse(response: string): void {
    this.defaultResponse = response;
  }

  /** Configure the adapter to throw on invoke. */
  setError(error: Error): void {
    this._shouldThrow = true;
    this._throwError = error;
  }

  /** Clear the error state. */
  clearError(): void {
    this._shouldThrow = false;
    this._throwError = undefined;
  }

  /** Set simulated latency in milliseconds. */
  setLatency(ms: number): void {
    this._latencyMs = ms;
  }

  /** Set health check result. */
  setHealthy(healthy: boolean, message?: string): void {
    this._healthy = healthy;
    this._healthMessage = message;
  }

  /** Get all recorded invocations for assertion. */
  getInvocations(): AdapterInput[] {
    return [...this._invocations];
  }

  /** Get the last invocation, or undefined if none. */
  getLastInvocation(): AdapterInput | undefined {
    return this._invocations[this._invocations.length - 1];
  }

  /** Clear recorded invocations. */
  clearInvocations(): void {
    this._invocations = [];
  }

  /** Reset all state. */
  reset(): void {
    this.responses.clear();
    this.defaultResponse = 'Mock response';
    this._invocations = [];
    this._healthy = true;
    this._healthMessage = undefined;
    this._latencyMs = 0;
    this._shouldThrow = false;
    this._throwError = undefined;
  }

  private resolveResponse(message: string): string {
    for (const [pattern, response] of this.responses) {
      if (message.includes(pattern)) {
        return response;
      }
    }
    return this.defaultResponse;
  }

  async invoke(input: AdapterInput): Promise<ThoughtResult> {
    this._invocations.push(input);

    if (this._latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this._latencyMs));
    }

    if (this._shouldThrow) {
      throw this._throwError ?? new Error('Mock adapter error');
    }

    const text = this.resolveResponse(input.message);

    return {
      text,
      memoryWrites: [],
      cleanText: text,
      mode: this.name,
      modelUsed: input.route.model,
      elapsedMs: this._latencyMs,
    };
  }

  async invokeStreaming(input: AdapterInput): Promise<StreamHandle> {
    this._invocations.push(input);

    if (this._shouldThrow) {
      throw this._throwError ?? new Error('Mock adapter error');
    }

    const text = this.resolveResponse(input.message);
    const latency = this._latencyMs;

    async function* generateChunks(): AsyncGenerator<StreamChunk, void, unknown> {
      if (latency > 0) {
        await new Promise((resolve) => setTimeout(resolve, latency));
      }
      yield { type: 'text', text };
      yield { type: 'done', text: '' };
    }

    return {
      chunks: generateChunks(),
      abort: () => {},
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      healthy: this._healthy,
      message: this._healthMessage,
      latencyMs: this._latencyMs,
    };
  }

  async shutdown(): Promise<void> {
    // No-op for mock
  }
}
