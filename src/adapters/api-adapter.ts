import type { CognitiveAdapter } from '../adapter.js';
import type { AdapterInput, StreamHandle, StreamChunk, HealthCheckResult, ThoughtResult } from '../types.js';
import { extractWritebacks } from '../continuity.js';

/**
 * Anthropic API adapter (stub).
 * Will use the @anthropic-ai/sdk package for direct API calls.
 * Currently returns a structured error — the CLI adapter should be used as fallback.
 */
export class AnthropicApiAdapter implements CognitiveAdapter {
  readonly name = 'anthropic-api';

  async invoke(input: AdapterInput): Promise<ThoughtResult> {
    const startMs = Date.now();

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        text: '',
        memoryWrites: [],
        cleanText: '',
        mode: this.name,
        modelUsed: input.route.model,
        elapsedMs: Date.now() - startMs,
        error: {
          kind: 'not-configured',
          message: 'ANTHROPIC_API_KEY not set — API adapter unavailable',
          ref: generateErrorRef(),
        },
      };
    }

    // TODO: Implement direct Anthropic API invocation
    // const client = new Anthropic({ apiKey });
    // const response = await client.messages.create({ ... });
    return {
      text: '',
      memoryWrites: [],
      cleanText: '',
      mode: this.name,
      modelUsed: input.route.model,
      elapsedMs: Date.now() - startMs,
      error: {
        kind: 'not-implemented',
        message: 'Anthropic API adapter is a stub — use CLI adapter as fallback',
        ref: generateErrorRef(),
      },
    };
  }

  async invokeStreaming(_input: AdapterInput): Promise<StreamHandle> {
    // Stub: yield a single error chunk
    async function* generate(): AsyncGenerator<StreamChunk, void, unknown> {
      yield {
        type: 'error',
        text: 'Anthropic API streaming is not yet implemented.',
      };
    }

    return {
      chunks: generate(),
      abort: () => {},
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        healthy: false,
        message: 'ANTHROPIC_API_KEY not set',
      };
    }

    // TODO: Make a lightweight API call to verify connectivity
    return {
      healthy: false,
      message: 'API adapter is a stub — not yet functional',
    };
  }
}

function generateErrorRef(): string {
  return Date.now().toString(36).slice(-6);
}
