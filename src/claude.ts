import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatId, Message } from './session.js';
import { resolveRoute, assembleSystemPrompt, buildModeContext, think } from './router.js';
import { AdapterRegistry } from './adapter.js';
import { ClaudeCodeCliAdapter } from './adapters/cli-adapter.js';
import {
  extractWritebacks as _extractWritebacks,
  validateWriteback as _validateWriteback,
  applyWritebacks as _applyWritebacks,
} from './continuity.js';
import type { AdapterInput, CognitiveMode, InvocationType, StreamHandle } from './types.js';
import { identity } from './identity.js';

export type { InvocationType } from './types.js';
export type { CognitiveMode } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const WORKSPACE_PATH = path.resolve(PROJECT_ROOT, 'workspace');
const SYSTEM_PROMPT_PATH = path.join(WORKSPACE_PATH, 'identity', 'self.md');

const COGNITIVE_MODE: CognitiveMode =
  (process.env[`${identity.agentName.toUpperCase()}_COGNITIVE_MODE`] as CognitiveMode) ?? 'yolo';

export function getCognitiveMode(): CognitiveMode {
  return COGNITIVE_MODE;
}

export function getWorkspacePath(): string {
  return WORKSPACE_PATH;
}

export function getSystemPromptPath(): string {
  return SYSTEM_PROMPT_PATH;
}

// ── Writeback and streaming type re-exports (backward compatibility) ─
// Canonical definitions live in types.ts and continuity.ts.

export type { WritebackDirective, WritebackResult, StreamChunk, StreamHandle } from './types.js';

/** @deprecated Import from './continuity.js' instead */
export const extractWritebacks = _extractWritebacks;

/** @deprecated Import from './continuity.js' instead */
export const validateWriteback = _validateWriteback;

/** @deprecated Import from './continuity.js' instead */
export const applyWritebacks = _applyWritebacks;

// ── Re-export prompt helpers from router (backward compatibility) ────

export { buildModeContext, assembleSystemPrompt } from './router.js';

// ── Adapter registry ────────────────────────────────────────────────

const registry = new AdapterRegistry();
registry.register(new ClaudeCodeCliAdapter());

/** Returns the global adapter registry for diagnostic and extension use. */
export function getAdapterRegistry(): AdapterRegistry {
  return registry;
}

// ── Public API (unchanged signatures for bot.ts / cli.ts) ───────────

/**
 * Batch API — delegates to think(), which orchestrates adapter selection,
 * system prompt assembly, invocation, and writeback application.
 * Returns the clean response text as a string.
 */
export async function invokeClaude(
  message: string,
  chatId: ChatId,
  history: Message[] = [],
  mode: CognitiveMode = COGNITIVE_MODE,
  invocationType: InvocationType = 'conversation',
): Promise<string> {
  const result = await think(registry, message, chatId, history, mode, invocationType);
  return result.cleanText;
}

/**
 * Streaming API — delegates to the CLI adapter.
 * Returns a handle with the async generator and an abort function.
 */
export async function invokeClaudeStreaming(
  message: string,
  chatId: ChatId,
  history: Message[] = [],
  mode: CognitiveMode = COGNITIVE_MODE,
  invocationType: InvocationType = 'conversation',
): Promise<StreamHandle> {
  const adapter = registry.getDefault();
  const adapterInput = await buildAdapterInput(message, chatId, history, mode, invocationType);
  return adapter.invokeStreaming(adapterInput);
}

// ── Internal helpers ────────────────────────────────────────────────

async function buildAdapterInput(
  message: string,
  chatId: ChatId,
  history: Message[],
  mode: CognitiveMode,
  invocationType: InvocationType,
): Promise<AdapterInput> {
  const route = resolveRoute(invocationType);
  const effectiveMode = invocationType === 'conversation' ? mode : route.mode;

  const { systemPrompt } = await assembleSystemPrompt(chatId, effectiveMode);

  return {
    message,
    history,
    systemPrompt,
    route,
    workspacePath: WORKSPACE_PATH,
    effectiveMode,
  };
}
