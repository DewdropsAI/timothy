import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CognitiveMode, InvocationType, RouteConfig, ThoughtResult, AdapterInput, ChatId, Message } from './types.js';
import type { AdapterRegistry } from './adapter.js';
import { applyWritebacks } from './continuity.js';
import { buildMemoryContext } from './memory.js';
import { resolveAdapterName } from './startup.js';
import { identity } from './identity.js';

export type { InvocationType, RouteConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_PATH = path.resolve(PROJECT_ROOT, 'workspace');
const SYSTEM_PROMPT_PATH = path.join(WORKSPACE_PATH, 'identity', 'self.md');

const DEFAULT_ROUTES: Record<InvocationType, RouteConfig> = {
  conversation: {
    model: 'claude-sonnet-4-6',
    mode: 'yolo',
    timeoutMs: 300_000,
  },
  reflection: {
    model: 'claude-haiku-4-5',
    mode: 'print',
    timeoutMs: 60_000,
  },
  summarization: {
    model: 'claude-haiku-4-5',
    mode: 'print',
    timeoutMs: 30_000,
  },
  extraction: {
    model: 'claude-haiku-4-5',
    mode: 'print',
    timeoutMs: 30_000,
  },
};

/**
 * Environment variable names for per-invocation-type model overrides.
 * e.g. TITUS_CONVERSATION_MODEL=claude-opus-4-6
 */
const PREFIX = identity.agentName.toUpperCase();

const ENV_MODEL_KEYS: Record<InvocationType, string> = {
  conversation: `${PREFIX}_CONVERSATION_MODEL`,
  reflection: `${PREFIX}_REFLECTION_MODEL`,
  summarization: `${PREFIX}_SUMMARIZATION_MODEL`,
  extraction: `${PREFIX}_EXTRACTION_MODEL`,
};

const ENV_TIMEOUT_KEYS: Record<InvocationType, string> = {
  conversation: `${PREFIX}_CONVERSATION_TIMEOUT_MS`,
  reflection: `${PREFIX}_REFLECTION_TIMEOUT_MS`,
  summarization: `${PREFIX}_SUMMARIZATION_TIMEOUT_MS`,
  extraction: `${PREFIX}_EXTRACTION_TIMEOUT_MS`,
};

/**
 * Resolves the route configuration for a given invocation type.
 * Env vars override defaults: <PREFIX>_<TYPE>_MODEL and <PREFIX>_<TYPE>_TIMEOUT_MS.
 */
export function resolveRoute(type: InvocationType): RouteConfig {
  const defaults = DEFAULT_ROUTES[type];

  const envModel = process.env[ENV_MODEL_KEYS[type]];
  const envTimeout = process.env[ENV_TIMEOUT_KEYS[type]];

  const model = envModel?.trim() || defaults.model;

  let timeoutMs = defaults.timeoutMs;
  if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      timeoutMs = parsed;
    }
  }

  return {
    model,
    mode: defaults.mode,
    timeoutMs,
  };
}

/**
 * Returns the full default routing table (for diagnostics/logging).
 */
export function getDefaultRoutes(): Record<InvocationType, RouteConfig> {
  return { ...DEFAULT_ROUTES };
}

// ── System prompt and mode context ──────────────────────────────────

async function loadSystemPrompt(): Promise<string | null> {
  try {
    return await readFile(SYSTEM_PROMPT_PATH, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Returns a system prompt section describing the current cognitive mode.
 */
export function buildModeContext(mode: CognitiveMode): string {
  if (mode === 'yolo') {
    return [
      '## Cognitive Mode: Autonomous',
      '',
      'You are running in **full autonomous mode** with complete tool access.',
      'You can:',
      '- Read and write files directly in your workspace',
      '- Execute shell commands',
      '- Use any available Claude Code tool',
      '',
      `You also have **writeback directives** (\`<!--${identity.agentName}-write ... -->\`) as a structured`,
      'memory mechanism — the system strips them from your response and applies them.',
      'Use whichever approach fits: direct tool access for immediate actions,',
      'writeback directives for structured memory persistence.',
    ].join('\n');
  }

  return [
    '## Cognitive Mode: Stateless',
    '',
    'You are running in **stateless print mode** — single-shot, text only.',
    'You cannot use tools or write files directly.',
    `To persist memories, embed writeback directives (\`<!--${identity.agentName}-write ... -->\`)`,
    'in your response. The system strips them before delivery and applies the writes.',
  ].join('\n');
}

/**
 * Assembles the full system prompt with identity, memory context, and mode context.
 */
export async function assembleSystemPrompt(
  chatId: ChatId,
  effectiveMode: CognitiveMode,
  userMessage?: string,
): Promise<{ systemPrompt: string; memoryContext: string }> {
  let systemPrompt = await loadSystemPrompt();

  const { context: memoryContext } = await buildMemoryContext(chatId, userMessage);
  if (systemPrompt && memoryContext) {
    systemPrompt += '\n\n---\n\n' + memoryContext;
  }

  const modeContext = buildModeContext(effectiveMode);
  if (systemPrompt) {
    systemPrompt += '\n\n---\n\n' + modeContext;
  } else {
    systemPrompt = modeContext;
  }

  return { systemPrompt, memoryContext };
}

// ── think() — the cognitive orchestrator ────────────────────────────

function generateErrorRef(): string {
  return Date.now().toString(36).slice(-6);
}

/**
 * Central cognitive orchestrator. Assembles context, selects an adapter,
 * invokes it, applies writeback directives, and returns a ThoughtResult.
 *
 * This is the primary entry point for all cognitive invocations.
 * `invokeClaude()` in claude.ts wraps this for backward compatibility.
 */
export async function think(
  registry: AdapterRegistry,
  message: string,
  chatId: ChatId,
  history: Message[],
  mode?: CognitiveMode,
  invocationType: InvocationType = 'conversation',
): Promise<ThoughtResult> {
  const startMs = Date.now();

  try {
    // 1. Resolve route
    const route = resolveRoute(invocationType);

    // 2. Determine effective mode
    // Conversation: caller override wins (if provided). Other types: route's mode wins.
    const effectiveMode = invocationType === 'conversation'
      ? (mode ?? route.mode)
      : route.mode;

    // 3. Assemble system prompt with memory context and mode context
    const { systemPrompt, memoryContext } = await assembleSystemPrompt(chatId, effectiveMode, message);

    // 4. Build adapter input
    const adapterInput: AdapterInput = {
      message,
      history,
      systemPrompt,
      route,
      workspacePath: WORKSPACE_PATH,
      effectiveMode,
    };

    // 5. Select adapter from registry
    const adapterName = resolveAdapterName(registry, invocationType);
    const adapter = registry.get(adapterName);

    // 6. Invoke adapter
    const result = await adapter.invoke(adapterInput);

    // 7. Apply writeback directives
    if (result.memoryWrites.length > 0) {
      try {
        const writeResult = await applyWritebacks(result.memoryWrites, WORKSPACE_PATH);
        if (writeResult.failed.length > 0) {
          const failedFiles = writeResult.failed.map((f) => f.file).join(', ');
          console.error(
            `[think] chat=${chatId} memory_write_failed files=[${failedFiles}] errors=${JSON.stringify(writeResult.failed)}`,
          );
          result.cleanText += `\n\n[Note: I tried to save something to memory but the write failed for: ${failedFiles}. I may not remember this next time.]`;
        }
      } catch (err) {
        console.error(`[think] chat=${chatId} unexpected_writeback_error:`, err);
        result.cleanText += '\n\n[Note: I tried to save something to memory but encountered an error. I may not remember this next time.]';
      }
    }

    // 8. Return result with timing
    result.elapsedMs = Date.now() - startMs;
    return result;
  } catch (err) {
    const ref = generateErrorRef();
    console.error(`[think] ref=${ref} chat=${chatId} type=${invocationType} error:`, err);
    return {
      text: '',
      memoryWrites: [],
      cleanText: `Sorry, something went wrong while processing your message. Please try again. (ref: ${ref})`,
      mode: 'unknown',
      modelUsed: 'unknown',
      elapsedMs: Date.now() - startMs,
      error: {
        kind: 'unexpected',
        message: err instanceof Error ? err.message : String(err),
        ref,
      },
    };
  }
}
