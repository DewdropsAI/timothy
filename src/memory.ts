import { mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatId, Message } from './session.js';
import { resolveRoute } from './router.js';
import { identity } from './identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

let memoryDir = path.resolve(PROJECT_ROOT, 'workspace', 'memory');
let workingMemoryDir = path.resolve(PROJECT_ROOT, 'workspace', 'working-memory');

export interface MemoryPaths {
  sessions: string;
  identity: string;
  facts: string;
  topics: string;
}

/**
 * Returns the resolved absolute path to the memory directory.
 */
export function getMemoryPath(): string {
  return memoryDir;
}

/** @internal Only for testing */
export function _setMemoryDir(dir: string): void {
  memoryDir = dir;
}

/**
 * Returns the resolved absolute path to the working memory directory.
 */
export function getWorkingMemoryPath(): string {
  return workingMemoryDir;
}

/** @internal Only for testing */
export function _setWorkingMemoryDir(dir: string): void {
  workingMemoryDir = dir;
}

/**
 * Creates the memory directory structure.
 * Idempotent — safe to call when dirs already exist (including partial structures).
 * Returns resolved absolute paths for each subdirectory.
 */
export function ensureMemoryDirs(): MemoryPaths {
  const paths: MemoryPaths = {
    sessions: path.join(memoryDir, 'sessions'),
    identity: path.join(memoryDir, 'identity'),
    facts: path.join(memoryDir, 'facts'),
    topics: path.join(memoryDir, 'topics'),
  };

  for (const dir of Object.values(paths)) {
    mkdirSync(dir, { recursive: true });
  }

  return paths;
}

/**
 * Reads a file from the memory directory.
 * Returns null if the file does not exist. Never throws on missing files.
 */
export async function loadMemoryFile(relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(memoryDir, relativePath), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Writes content to a file in the memory directory using atomic write (tmp + rename).
 * Creates parent directories if needed. Throws on real I/O errors.
 */
export async function saveMemoryFile(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(memoryDir, relativePath);
  const tmpPath = filePath + '.tmp';

  mkdirSync(path.dirname(filePath), { recursive: true });

  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp file may not exist if writeFileSync failed
    }
    throw err;
  }
}

/**
 * Extracts facts from conversation history using the last user+assistant exchange.
 * // TODO: Upgrade to LLM-based extraction via cognitive router
 */
export async function extractFacts(
  history: Message[],
): Promise<{ content: string; category: string }[]> {
  if (history.length < 2) return [];
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  if (!lastUser || !lastAssistant) return [];
  return extractMemories(lastUser.content, lastAssistant.content);
}

// --- Story 1: FEAT-015-US-006 — Memory extraction pipeline ---

/**
 * Extracts facts from a single exchange (user message + assistant response).
 * Uses heuristic pattern matching as a safety net — the primary memory mechanism
 * is Titus's own writeback directives. Categories: 'fact', 'preference', 'decision', 'context'.
 * Returns empty array for trivial exchanges (greetings, very short messages).
 */
export function extractMemories(
  userMsg: string,
  assistantMsg: string,
): { content: string; category: string }[] {
  const results: { content: string; category: string }[] = [];

  // Extract from both sides of the conversation
  extractFromText(userMsg, 'user', results);
  extractFromText(assistantMsg, 'assistant', results);

  return results;
}

function extractFromText(
  text: string,
  speaker: 'user' | 'assistant',
  results: { content: string; category: string }[],
): void {
  const trimmed = text.trim();
  if (trimmed.length < 15) return;

  // Identity / name patterns — only from user text.
  // Assistant text triggers false positives ("I'm essentially", "I'm not sure", etc.)
  // and assistant self-identification should come through writeback directives, not heuristics.
  if (speaker === 'user') {
    const namePatterns = [
      /my name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
      /(?:call me|i'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
      /(?:his|her|their) name is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    ];
    for (const pattern of namePatterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const name = match[1].trim();
        // Must start with uppercase (the i flag makes [A-Z] match anything)
        if (!/^[A-Z]/.test(name)) break;
        // Skip common false positives
        if (!['Not', 'The', 'This', 'That', 'Just', 'Well', 'Here', 'Sure', 'Yeah', 'Really'].includes(name)) {
          results.push({ content: `User's name is ${name}`, category: 'fact' });
        }
        break;
      }
    }
  }

  // Preference patterns
  const prefPatterns = [
    /i (?:prefer|like|love|enjoy|favor|always use|usually use|tend to use)\s+(.{5,80})/i,
    /(?:my favorite|my go-to|i'm a fan of)\s+(.{3,80})/i,
    /(?:i don't like|i hate|i avoid|i never use)\s+(.{5,80})/i,
  ];
  for (const pattern of prefPatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      results.push({ content: match[0].trim(), category: 'preference' });
      break;
    }
  }

  // Decision patterns
  const decisionPatterns = [
    /(?:let'?s go with|let'?s use|let'?s switch to|let'?s try)\s+(.{3,80})/i,
    /(?:we decided|we agreed|we're going with|we should use)\s+(.{3,80})/i,
    /(?:i chose|i picked|i'm going with|the plan is to)\s+(.{3,80})/i,
  ];
  for (const pattern of decisionPatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      results.push({ content: match[0].trim(), category: 'decision' });
      break;
    }
  }

  // Explicit memory requests
  const memoryPatterns = [
    /(?:remember that|don't forget|keep in mind|note that|fyi)\s+(.{5,120})/i,
    /(?:for (?:future |next )?reference)\s*[,:]\s*(.{5,120})/i,
  ];
  for (const pattern of memoryPatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      results.push({ content: match[1].trim(), category: 'fact' });
      break;
    }
  }

  // Context patterns — work, projects, environment (user text only).
  // Assistant text like "I'm working on your request" triggers false positives.
  if (speaker === 'user') {
    const contextPatterns = [
      /(?:i work (?:on|at|for|with)|i'm (?:working on|building|developing))\s+(.{5,80})/i,
      /(?:the project is|we're building|the app is|the codebase)\s+(.{5,80})/i,
      /(?:my (?:job|role|title) is|i'm a)\s+(.{5,60})/i,
    ];
    for (const pattern of contextPatterns) {
      const match = trimmed.match(pattern);
      if (match) {
        results.push({ content: match[0].trim(), category: 'context' });
        break;
      }
    }
  }
}

/**
 * Derives a slug from content text: lowercase, hyphens, max 50 chars.
 */
function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Saves a fact to workspace/memory/facts/<slug>.md with YAML frontmatter.
 * Returns the file path.
 */
export async function saveExtractedFact(fact: { content: string; category: string }): Promise<string> {
  const now = new Date().toISOString();
  const fm: MemoryFrontmatter = {
    created: now,
    updated: now,
    version: 1,
    type: 'fact',
    tags: [fact.category],
  };
  const content = serializeMemoryFile(fm, fact.content);
  const slug = toSlug(fact.content);
  const relativePath = `facts/${slug}.md`;
  await saveMemoryFile(relativePath, content);
  return path.join(memoryDir, relativePath);
}

/**
 * Duplicate check: returns true if any existing fact is substantially similar.
 * Uses substring matching gated by a length-ratio threshold — the shorter string
 * must be at least 80% the length of the longer string. This prevents false
 * positives like "Chris likes coffee" matching "coffee ice cream recipe".
 */
export function isDuplicateFact(newFact: string, existingFacts: string[]): boolean {
  const lower = newFact.toLowerCase().trim();
  return existingFacts.some((existing) => {
    const existingLower = existing.toLowerCase().trim();
    if (!(existingLower.includes(lower) || lower.includes(existingLower))) {
      return false;
    }
    const shorter = Math.min(lower.length, existingLower.length);
    const longer = Math.max(lower.length, existingLower.length);
    return longer === 0 || shorter / longer >= 0.8;
  });
}

export interface ExtractionResult {
  extracted: number;
  duplicates: number;
  saved: string[];
  error?: string;
}

/**
 * Orchestrates extraction: extracts memories, checks duplicates, saves new facts.
 * Returns a result summary. Never throws — errors are captured in the result.
 */
export async function runExtractionPipeline(
  chatId: ChatId,
  userMsg: string,
  assistantMsg: string,
): Promise<ExtractionResult> {
  const result: ExtractionResult = { extracted: 0, duplicates: 0, saved: [] };

  try {
    // Ensure facts directory exists before writing
    mkdirSync(path.join(memoryDir, 'facts'), { recursive: true });

    const memories = extractMemories(userMsg, assistantMsg);
    result.extracted = memories.length;
    if (memories.length === 0) return result;

    // Load existing facts for duplicate checking
    const existingFacts = await loadFactFiles();
    const existingContents = existingFacts.map((f) => {
      const parsed = parseMemoryFile(f.content);
      return parsed.body;
    });

    for (const memory of memories) {
      if (!isDuplicateFact(memory.content, existingContents)) {
        const savedPath = await saveExtractedFact(memory);
        result.saved.push(savedPath);
        console.log(`[memory] extracted ${memory.category}: ${savedPath}`);
      } else {
        result.duplicates++;
        console.log(`[memory] skipping duplicate: ${memory.content}`);
      }
    }

    console.log(
      `[memory] extraction complete: ${result.extracted} found, ${result.saved.length} saved, ${result.duplicates} duplicates`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.error = msg;
    console.error('[memory] extraction pipeline error:', err);
  }

  return result;
}

// --- Story 1: FEAT-014-US-005 — Markdown format with YAML frontmatter ---

export type MemoryFileType = 'session-summary' | 'fact' | 'topic' | 'identity' | 'user-profile' | 'working-memory';

export interface MemoryFrontmatter {
  created: string;
  updated: string;
  version: number;
  type: MemoryFileType;
  tags: string[];
}

/**
 * Parses a memory file with optional YAML frontmatter delimited by `---`.
 * Returns { frontmatter, body } where frontmatter is null if no block found.
 * Never throws — malformed files are treated as plain content (frontmatter: null)
 * with a warning logged. This prevents bad memory files from crashing the bot.
 */
export function parseMemoryFile(content: string): { frontmatter: MemoryFrontmatter | null; body: string } {
  if (!content.startsWith('---')) {
    return { frontmatter: null, body: content };
  }

  const secondDelimiter = content.indexOf('\n---', 3);
  if (secondDelimiter === -1) {
    // Distinguish a markdown horizontal rule (---\nplain text) from
    // genuinely malformed frontmatter (---\nkey: value\n... missing close).
    // Only warn if the content after `---` looks like YAML (has key: value lines).
    const afterOpener = content.slice(4).trim();
    const looksLikeYaml = afterOpener.split('\n').some((line) => /^\s*\w[\w-]*\s*:/.test(line));
    if (looksLikeYaml) {
      console.warn('[memory] malformed frontmatter: unclosed block (missing closing ---), treating as plain content');
    }
    return { frontmatter: null, body: content };
  }

  const yamlBlock = content.slice(4, secondDelimiter).trim();
  const body = content.slice(secondDelimiter + 4).replace(/^\n+/, '');

  const fm: Record<string, unknown> = {};
  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      console.warn(`[memory] malformed frontmatter: invalid line "${trimmed}" (expected key: value), treating as plain content`);
      return { frontmatter: null, body: content };
    }

    const key = trimmed.slice(0, colonIdx).trim();
    let value: unknown = trimmed.slice(colonIdx + 1).trim();

    if (key === 'tags') {
      const raw = value as string;
      if (raw.startsWith('[') && raw.endsWith(']')) {
        const inner = raw.slice(1, -1).trim();
        if (inner === '') {
          value = [];
        } else {
          value = inner.split(',').map((t) => t.trim());
        }
      } else {
        value = raw === '' ? [] : [raw];
      }
    } else if (key === 'version') {
      value = Number(value);
    }

    fm[key] = value;
  }

  return {
    frontmatter: fm as unknown as MemoryFrontmatter,
    body,
  };
}

/**
 * Serializes a MemoryFrontmatter + body into a memory file string.
 */
export function serializeMemoryFile(frontmatter: MemoryFrontmatter, body: string): string {
  const tagsStr = frontmatter.tags.length === 0
    ? '[]'
    : `[${frontmatter.tags.join(', ')}]`;

  const lines = [
    '---',
    `created: ${frontmatter.created}`,
    `updated: ${frontmatter.updated}`,
    `version: ${frontmatter.version}`,
    `type: ${frontmatter.type}`,
    `tags: ${tagsStr}`,
    '---',
    '',
    body,
  ];
  return lines.join('\n');
}

const REQUIRED_FRONTMATTER_FIELDS: (keyof MemoryFrontmatter)[] = [
  'created', 'updated', 'version', 'type', 'tags',
];

/**
 * Validates that all required frontmatter fields are present.
 * Throws listing missing fields if any are absent.
 */
export function validateFrontmatter(fm: Partial<MemoryFrontmatter>): void {
  const missing = REQUIRED_FRONTMATTER_FIELDS.filter(
    (field) => fm[field] === undefined || fm[field] === null,
  );
  if (missing.length > 0) {
    throw new Error(`Missing required frontmatter fields: ${missing.join(', ')}`);
  }
}

// --- Story 2: FEAT-014-US-003 — Context partitioning ---

export const DEFAULT_RECENT_TURNS = 10;

export interface AssembledContext {
  recentTurns: Message[];
  olderTurns: Message[];
  summarizedCount: number;
}

/**
 * Partitions conversation history into recent and older turns.
 * Pure function — does not perform summarization.
 */
export function assembleContext(
  history: Message[],
  options?: { recentTurnThreshold?: number },
): AssembledContext {
  const k = options?.recentTurnThreshold ?? DEFAULT_RECENT_TURNS;

  if (history.length <= k) {
    return {
      recentTurns: [...history],
      olderTurns: [],
      summarizedCount: 0,
    };
  }

  const splitPoint = history.length - k;
  return {
    recentTurns: history.slice(splitPoint),
    olderTurns: history.slice(0, splitPoint),
    summarizedCount: splitPoint,
  };
}

// --- Story 3: FEAT-015-US-005 — User profile persistence ---

/**
 * Loads user profile from workspace/memory/user-profile.md.
 * Returns null if the file does not exist; logs when absent.
 */
export async function loadUserProfile(): Promise<string | null> {
  const content = await loadMemoryFile('user-profile.md');
  if (content === null) {
    console.log('[memory] user-profile.md not found — profile will emerge through conversations');
  }
  return content;
}

/**
 * Saves user profile to workspace/memory/user-profile.md.
 */
export async function saveUserProfile(content: string): Promise<void> {
  await saveMemoryFile('user-profile.md', content);
}

// --- Story 4: FEAT-014-US-001 — Rolling conversation summarization ---

/**
 * Loads an existing conversation summary for a chat.
 * Returns null if no summary exists yet.
 */
export async function loadSummary(chatId: ChatId): Promise<string | null> {
  return loadMemoryFile(`sessions/${chatId}-summary.md`);
}

/**
 * Saves a conversation summary for a chat.
 */
export async function saveSummary(chatId: ChatId, summary: string): Promise<void> {
  await saveMemoryFile(`sessions/${chatId}-summary.md`, summary);
}

export type LlmInvoker = (prompt: string, invocationType?: 'summarization' | 'extraction') => Promise<string | null>;

/**
 * Default LLM invoker: spawns Claude CLI in print mode with model from router.
 */
function defaultInvokeLlm(
  prompt: string,
  invocationType: 'summarization' | 'extraction' = 'summarization',
): Promise<string | null> {
  const route = resolveRoute(invocationType);

  const args = ['-p', '--model', route.model, '--output-format', 'text'];

  const env = { ...process.env };
  delete env.CLAUDECODE;

  return new Promise<string | null>((resolve) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdin!.on('error', (err) => {
      console.error(`[memory] LLM stdin error: ${err.message}`);
    });
    child.stdin!.end(prompt);

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      console.error(`[memory] LLM invocation timed out after ${route.timeoutMs}ms`);
      resolve(null);
    }, route.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[memory] LLM spawn error: ${err.message}`);
      resolve(null);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[memory] LLM exited with code ${code}: ${stderr.trim()}`);
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

let llmInvoker: LlmInvoker = defaultInvokeLlm;

/**
 * Invokes the Claude CLI in print mode with a specific model for lightweight tasks.
 * Returns the text output. Used for summarization and merge operations.
 * Falls back to null on any error (caller decides how to degrade).
 */
export async function invokeLlm(
  prompt: string,
  invocationType: 'summarization' | 'extraction' = 'summarization',
): Promise<string | null> {
  return llmInvoker(prompt, invocationType);
}

/** @internal Only for testing — inject a mock LLM invoker */
export function _setLlmInvoker(invoker: LlmInvoker | null): void {
  llmInvoker = invoker ?? defaultInvokeLlm;
}

const SUMMARIZE_PROMPT = `You are a conversation summarizer for a cognitive agent named ${identity.agentNameDisplay}. Summarize the following conversation turns into a concise narrative summary.

Your summary MUST capture:
- **Topics discussed** — what was the conversation about
- **Decisions made** — any choices, agreements, or conclusions reached
- **Action items** — things anyone committed to doing
- **Emotional tone** — the overall mood and dynamics of the exchange
- **Open questions** — anything left unresolved or explicitly deferred

Write in third person ("The user asked...", "${identity.agentNameDisplay} explained..."). Be concise but preserve important details. Do NOT use bullet points — write flowing prose paragraphs. Aim for 200-400 words.

Conversation:
`;

/**
 * Summarizes conversation history using Haiku via the Claude CLI.
 * If history has fewer than 3 turns, returns formatted as-is (no compression needed).
 * Falls back to a template-based summary if the LLM call fails.
 */
export async function summarizeHistory(history: Message[]): Promise<string> {
  if (history.length < 3) {
    return history
      .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
  }

  const formatted = history
    .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
    .join('\n\n');

  const llmResult = await invokeLlm(SUMMARIZE_PROMPT + formatted);

  if (llmResult) {
    return llmResult;
  }

  // Fallback: template-based summary when LLM is unavailable
  console.warn('[memory] LLM summarization failed, using template fallback');
  return templateSummary(history);
}

/**
 * Template-based fallback summary when LLM is unavailable.
 */
export function templateSummary(history: Message[]): string {
  const first = history[0];
  const last = history[history.length - 1];
  const turnCount = history.length;

  return [
    `## Conversation Summary (${turnCount} turns)`,
    '',
    `**First message** (${first.role}): ${first.content}`,
    '',
    `**Last message** (${last.role}): ${last.content}`,
    '',
    `*${turnCount} turns compressed*`,
  ].join('\n');
}

const MERGE_PROMPT = `You are a conversation summarizer for a cognitive agent named ${identity.agentNameDisplay}. You have two summaries from the same ongoing conversation that need to be merged into one cohesive narrative.

Merge them into a single summary that:
- Preserves chronological flow (the existing summary covers earlier events)
- Eliminates redundancy — do not repeat the same information
- Retains all decisions, action items, and open questions from both
- Keeps the total length under 800 words

Write in third person. Use flowing prose, not bullet points.

Existing summary:
---
`;

const MERGE_SEPARATOR = `
---

New summary to merge:
---
`;

const MERGE_SUFFIX = `
---

Merged summary:`;

/**
 * Merges two summaries into one using Haiku for narrative coherence.
 * Used for hierarchical compression when summaries exceed ~3K tokens.
 * Falls back to simple concatenation if the LLM call fails.
 */
export async function mergeSummaries(existing: string, newer: string): Promise<string> {
  const combinedTokens = estimateTokens(existing) + estimateTokens(newer);

  // Only merge via LLM when combined summaries are large enough to warrant it
  if (combinedTokens < 3000) {
    return `${existing}\n\n${newer}`;
  }

  const prompt = MERGE_PROMPT + existing + MERGE_SEPARATOR + newer + MERGE_SUFFIX;
  const llmResult = await invokeLlm(prompt);

  if (llmResult) {
    return llmResult;
  }

  // Fallback: simple concatenation
  console.warn('[memory] LLM merge failed, using concatenation fallback');
  return `${existing}\n\n${newer}`;
}

/**
 * Returns true if the conversation history exceeds the summarization threshold.
 */
export function shouldSummarize(chatId: ChatId, history: Message[], threshold?: number): boolean {
  return history.length > (threshold ?? DEFAULT_RECENT_TURNS);
}

/**
 * Orchestrates summarization: partitions history, summarizes older turns,
 * merges with existing summary, saves, and returns the recent turns for
 * callers that want to trim in-memory history.
 */
export async function performSummarization(
  chatId: ChatId,
  history: Message[],
  threshold?: number,
): Promise<{ recentTurns: Message[] }> {
  const { olderTurns, recentTurns } = assembleContext(history, { recentTurnThreshold: threshold });

  if (olderTurns.length === 0) return { recentTurns: history };

  const newSummary = await summarizeHistory(olderTurns);
  const existingSummary = await loadSummary(chatId);

  const merged = existingSummary
    ? await mergeSummaries(existingSummary, newSummary)
    : newSummary;

  await saveSummary(chatId, merged);

  return { recentTurns };
}

const DEFAULT_IDENTITY_TEMPLATE = `---
last_updated: null
version: 1
---

## Self-Knowledge

(Not yet developed — will emerge through conversations.)

## Relationship Context

(Not yet developed — will emerge through conversations.)

## Communication Style

(Not yet developed — will emerge through conversations.)
`;

/**
 * Returns the default identity template constant.
 */
export function getDefaultIdentityTemplate(): string {
  return DEFAULT_IDENTITY_TEMPLATE;
}

/**
 * Loads the evolved identity from workspace/memory/identity.md.
 * Returns null if the file does not exist; logs when missing.
 */
export async function loadIdentity(): Promise<string | null> {
  const content = await loadMemoryFile('identity.md');
  if (content === null) {
    console.log('[memory] identity.md not found — identity will emerge through conversations');
  }
  return content;
}

// --- Story 2: FEAT-014-US-002 — Context budget management ---

/**
 * Conservative token estimation heuristic: ~3 characters per token.
 * Using /3 instead of /4 to avoid underestimating, especially for code,
 * URLs, and non-English text where the chars-per-token ratio is lower.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export const TOKEN_BUDGET = 8000;
export const BUDGET_WARNING_THRESHOLD = 7000;

/**
 * Reads all .md files from workspace/memory/facts/.
 * Returns empty array if directory doesn't exist.
 */
export async function loadFactFiles(): Promise<{ path: string; content: string }[]> {
  const factsDir = path.join(memoryDir, 'facts');
  if (!existsSync(factsDir)) return [];

  const files = readdirSync(factsDir).filter((f) => f.endsWith('.md')).sort().reverse();
  const results: { path: string; content: string }[] = [];
  for (const file of files) {
    const content = await loadMemoryFile(`facts/${file}`);
    if (content !== null) {
      results.push({ path: path.join(factsDir, file), content });
    }
  }
  return results;
}

/**
 * Reads all .md files from workspace/memory/topics/.
 * Returns empty array if directory doesn't exist.
 */
export async function loadTopicFiles(): Promise<{ path: string; content: string }[]> {
  const topicsDir = path.join(memoryDir, 'topics');
  if (!existsSync(topicsDir)) return [];

  const files = readdirSync(topicsDir).filter((f) => f.endsWith('.md')).sort().reverse();
  const results: { path: string; content: string }[] = [];
  for (const file of files) {
    const content = await loadMemoryFile(`topics/${file}`);
    if (content !== null) {
      results.push({ path: path.join(topicsDir, file), content });
    }
  }
  return results;
}

// --- Working memory layer ---

export const WORKING_MEMORY_FILES = [
  'active-context.md',
  'attention-queue.md',
  'pending-actions.md',
] as const;

/**
 * Loads all working memory files from workspace/working-memory/.
 * Returns an array of { name, content } for files that exist and have content.
 * Never throws — missing files are silently skipped.
 */
export async function loadWorkingMemory(): Promise<{ name: string; content: string }[]> {
  const results: { name: string; content: string }[] = [];
  for (const file of WORKING_MEMORY_FILES) {
    try {
      const content = await readFile(path.join(workingMemoryDir, file), 'utf-8');
      if (content.trim()) {
        results.push({ name: file, content });
      }
    } catch {
      // File doesn't exist yet — that's fine
    }
  }
  return results;
}

// --- FEAT-015-US-010: Memory usage instructions ---

export const MEMORY_INSTRUCTIONS = `You have memories from past conversations injected below. Use them naturally — do not say "I checked my memory" or call attention to the retrieval process.

- **Working Memory** is your current cognitive state — active focus, attention queue, and pending actions. Consult it first. Update it via writeback directives when your focus, priorities, or commitments change.
- **Identity** reflects who you have become through conversations — your evolving personality and perspective.
- **User Profile** contains what you know about the user: their name, preferences, and context.
- **Known Facts** and **Topics** are extracted from past conversations — treat them as things you simply know.
- Do not fabricate or hallucinate memories that are not present in the injected content below.
- When you learn new information about the user (name, preferences, decisions, projects), note it clearly in your response so the extraction pipeline can capture it for future memory.
- If the user asks you to forget something, acknowledge it — they can edit memory files directly.`;

/**
 * Assembles all memory sources into a single string within the token budget.
 * Always-load tier: identity, user profile, summary (never dropped).
 * Conditional tier: fact files, topic files (dropped oldest-first if over budget).
 * Returns { context, tokens } where context is wrapped in a ## Memory section
 * with ### subsections, and tokens is the estimated token count.
 */
export async function buildMemoryContext(
  chatId: ChatId,
  userMessage?: string,
): Promise<{ context: string; tokens: number }> {
  const sections: string[] = [];
  let tokenCount = 0;

  // Working memory tier — loaded FIRST, never budget-trimmed
  const workingMemFiles = await loadWorkingMemory();
  if (workingMemFiles.length > 0) {
    const wmParts: string[] = [];
    for (const wm of workingMemFiles) {
      const parsed = parseMemoryFile(wm.content);
      const label = wm.name.replace(/\.md$/, '').replace(/-/g, ' ');
      wmParts.push(`#### ${label}\n\n${parsed.body}`);
    }
    const section = `### Working Memory\n\n${wmParts.join('\n\n')}`;
    sections.push(section);
    tokenCount += estimateTokens(section);
  }

  // Always-load tier
  const identity = await loadIdentity();
  if (identity) {
    const section = `### Identity\n\n${identity}`;
    sections.push(section);
    tokenCount += estimateTokens(section);
  }

  const userProfile = await loadUserProfile();
  if (userProfile) {
    const section = `### User Profile\n\n${userProfile}`;
    sections.push(section);
    tokenCount += estimateTokens(section);
  }

  const summary = await loadSummary(chatId);
  if (summary) {
    const section = `### Conversation Summary\n\n${summary}`;
    sections.push(section);
    tokenCount += estimateTokens(section);
  }

  // Preparations tier — matched against user message keywords
  try {
    const { listActivePreparations, matchPreparations, formatPreparationsContext } = await import('./preparations.js');
    const allPreps = await listActivePreparations();
    const matched = userMessage
      ? matchPreparations(userMessage, allPreps)
      : allPreps;  // If no message, include all (for reflection context)

    if (matched.length > 0) {
      const prepContext = formatPreparationsContext(matched);
      const prepTokens = estimateTokens(prepContext);
      if (tokenCount + prepTokens <= TOKEN_BUDGET) {
        sections.push(prepContext);
        tokenCount += prepTokens;
      }
    }
  } catch {
    // Preparations module not available — degrade gracefully
  }

  // Conditional tier — facts (newest first, drop oldest if over budget)
  const facts = await loadFactFiles();
  const conditionalFacts: string[] = [];
  for (const fact of facts) {
    try {
      const parsed = parseMemoryFile(fact.content);
      const entry = `- ${parsed.body}`;
      const entryTokens = estimateTokens(entry);
      if (tokenCount + entryTokens <= TOKEN_BUDGET) {
        conditionalFacts.push(entry);
        tokenCount += entryTokens;
      }
    } catch (err) {
      console.warn(`[memory] skipping malformed fact file: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (conditionalFacts.length > 0) {
    sections.push(`### Known Facts\n\n${conditionalFacts.join('\n')}`);
  }

  // Conditional tier — topics (newest first, drop oldest if over budget)
  const topics = await loadTopicFiles();
  const conditionalTopics: string[] = [];
  for (const topic of topics) {
    try {
      const parsed = parseMemoryFile(topic.content);
      const entry = `- ${parsed.body}`;
      const entryTokens = estimateTokens(entry);
      if (tokenCount + entryTokens <= TOKEN_BUDGET) {
        conditionalTopics.push(entry);
        tokenCount += entryTokens;
      }
    } catch (err) {
      console.warn(`[memory] skipping malformed topic file: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (conditionalTopics.length > 0) {
    sections.push(`### Topics\n\n${conditionalTopics.join('\n')}`);
  }

  if (tokenCount > BUDGET_WARNING_THRESHOLD) {
    console.warn(`[memory] context budget warning: ${tokenCount} tokens (threshold: ${BUDGET_WARNING_THRESHOLD})`);
  }

  // No content — return empty
  if (sections.length === 0) {
    return { context: '', tokens: 0 };
  }

  // Wrap in parent ## Memory section with instructions
  const memorySections = sections.join('\n\n');
  const memoryHeader = '## Memory\n\nThe following is your persisted memory from past conversations. Use this context naturally.\n\n';
  const context = MEMORY_INSTRUCTIONS + '\n\n' + memoryHeader + memorySections;
  tokenCount += estimateTokens(MEMORY_INSTRUCTIONS) + estimateTokens(memoryHeader);

  return { context, tokens: tokenCount };
}
