// ── Shared cognitive types ───────────────────────────────────────────
// This module is a leaf node: no imports from other project modules.
// All types that need to be shared across the codebase are defined here.

// ── Re-exported primitives from session.ts ───────────────────────────

/**
 * Unique identifier for a conversation (Telegram chat ID or CLI session name).
 */
export type ChatId = number | string;

/**
 * A single message in a conversation history.
 */
export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// ── Cognitive mode ──────────────────────────────────────────────────

/**
 * Cognitive mode determines how Titus interacts with the underlying model
 * and what capabilities are communicated via the system prompt.
 *
 * - 'yolo': Full autonomous mode — tools, file access, bash, everything.
 * - 'print': Stateless mode — text generation only, no tool access.
 * - 'api': Direct Anthropic API mode — for future SDK-based adapter.
 */
export type CognitiveMode = 'yolo' | 'print' | 'api';

// ── Routing ─────────────────────────────────────────────────────────

/**
 * Invocation types represent distinct cognitive tasks Titus performs.
 * Each type maps to a specific model, CLI mode, and timeout.
 */
export type InvocationType = 'conversation' | 'reflection' | 'summarization' | 'extraction';

/**
 * Route configuration for a specific invocation type.
 */
export interface RouteConfig {
  model: string;
  mode: CognitiveMode;
  timeoutMs: number;
}

// ── Writeback directives ────────────────────────────────────────────

/**
 * A parsed writeback directive extracted from a model response.
 * Represents a single memory write operation.
 */
export interface WritebackDirective {
  file: string;
  action: 'create' | 'append' | 'update';
  frontmatter?: Record<string, string>;
  content: string;
}

/**
 * Result of applying writeback directives to the workspace.
 */
export interface WritebackResult {
  succeeded: string[];
  failed: { file: string; error: string }[];
}

// ── Streaming ───────────────────────────────────────────────────────

/**
 * A single chunk in a streaming response.
 */
export interface StreamChunk {
  type: 'text' | 'error' | 'done';
  text: string;
}

/**
 * Handle for a streaming cognitive invocation.
 */
export interface StreamHandle {
  chunks: AsyncGenerator<StreamChunk, void, unknown>;
  abort: () => void;
}

// ── Thought input/output ────────────────────────────────────────────

/**
 * Encapsulates all context needed for a cognitive invocation.
 * Assembled once before routing to the appropriate mode adapter.
 */
export interface ThoughtInput {
  message: string;
  chatId: ChatId;
  history: Message[];
  invocationType: InvocationType;
  route: RouteConfig;
  systemPrompt: string;
  memoryContext: string;
  workspacePath: string;
  tokenBudget?: number;
  modeOverride?: CognitiveMode;
}

/**
 * Result of a cognitive invocation.
 * Contains the response text, parsed memory writes, and diagnostic metadata.
 */
export interface ThoughtResult {
  text: string;
  memoryWrites: WritebackDirective[];
  cleanText: string;
  mode: string;
  modelUsed: string;
  tokensUsed?: number;
  elapsedMs: number;
  costEstimate?: { inputTokens: number; outputTokens: number };
  metadata?: Record<string, unknown>;
  error?: { kind: string; message: string; ref: string };
}

// ── Adapter input ───────────────────────────────────────────────────

/**
 * Input specifically for the adapter layer — pre-assembled by the router.
 * The adapter receives this and translates it into the appropriate invocation mechanism.
 */
export interface AdapterInput {
  message: string;
  history: Message[];
  systemPrompt: string;
  route: RouteConfig;
  workspacePath: string;
  effectiveMode: CognitiveMode;
}

// ── Health check ────────────────────────────────────────────────────

/**
 * Result of an adapter health check.
 */
export interface HealthCheckResult {
  healthy: boolean;
  message?: string;
  latencyMs?: number;
}
