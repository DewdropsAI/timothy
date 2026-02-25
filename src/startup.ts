import { AdapterRegistry } from './adapter.js';
import { ClaudeCodeCliAdapter } from './adapters/cli-adapter.js';
import { AnthropicApiAdapter } from './adapters/api-adapter.js';
import type { InvocationType } from './types.js';

/**
 * Default mapping of invocation types to preferred adapter names.
 * Fallback is always 'claude-code-cli' if the preferred adapter isn't available.
 */
const INVOCATION_ADAPTER_MAP: Record<InvocationType, { preferred: string; fallback: string }> = {
  conversation: { preferred: 'claude-code-cli', fallback: 'claude-code-cli' },
  reflection: { preferred: 'anthropic-api', fallback: 'claude-code-cli' },
  summarization: { preferred: 'anthropic-api', fallback: 'claude-code-cli' },
  extraction: { preferred: 'anthropic-api', fallback: 'claude-code-cli' },
};

/**
 * Creates and populates the adapter registry with default adapters.
 * - 'claude-code-cli' is always registered (requires `claude` CLI on PATH).
 * - 'anthropic-api' is registered if ANTHROPIC_API_KEY is set (stub for now).
 */
export function createRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();

  registry.register(new ClaudeCodeCliAdapter());

  if (process.env.ANTHROPIC_API_KEY) {
    registry.register(new AnthropicApiAdapter());
  }

  return registry;
}

/**
 * Resolves the adapter name for a given invocation type.
 * Uses the preferred adapter if registered, otherwise falls back.
 */
export function resolveAdapterName(
  registry: AdapterRegistry,
  invocationType: InvocationType,
): string {
  const mapping = INVOCATION_ADAPTER_MAP[invocationType];
  if (registry.has(mapping.preferred)) {
    return mapping.preferred;
  }
  return mapping.fallback;
}
