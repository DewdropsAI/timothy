/**
 * E2E test helpers for Titus cognitive pipeline tests.
 *
 * Uses the Claude Agent SDK to invoke Claude programmatically,
 * running against isolated temp workspaces so the real workspace
 * (Titus's persistent mind) is never touched.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query, type SDKMessage, type SDKResultMessage, type SDKResultSuccess, type Options } from '@anthropic-ai/claude-agent-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMPLATES_DIR = path.resolve(PROJECT_ROOT, 'templates');

// ── Workspace helpers ─────────────────────────────────────────────────

/**
 * Creates an isolated temp workspace with the same structure as Titus's
 * real workspace. Copies seed templates from templates/ so tests start
 * with a realistic baseline.
 *
 * Returns the absolute path to the temp workspace.
 */
export function createTestWorkspace(): string {
  const id = randomUUID().slice(0, 8);
  const workspace = join(tmpdir(), `titus-e2e-${id}`);

  // Create directory structure matching workspace.ts ensureWorkspace()
  mkdirSync(join(workspace, 'identity'), { recursive: true });
  mkdirSync(join(workspace, 'working-memory'), { recursive: true });
  mkdirSync(join(workspace, 'ideas'), { recursive: true });
  mkdirSync(join(workspace, 'projects'), { recursive: true });
  mkdirSync(join(workspace, 'memory', 'facts'), { recursive: true });

  // Seed files from templates/
  const templateMap: Record<string, string> = {
    'identity-seed.md': 'identity/self.md',
    'journal-seed.md': 'journal.md',
    'working-memory-active-context-seed.md': 'working-memory/active-context.md',
    'working-memory-attention-queue-seed.md': 'working-memory/attention-queue.md',
    'working-memory-pending-actions-seed.md': 'working-memory/pending-actions.md',
  };

  for (const [template, dest] of Object.entries(templateMap)) {
    const src = join(TEMPLATES_DIR, template);
    if (existsSync(src)) {
      writeFileSync(join(workspace, dest), readFileSync(src, 'utf-8'));
    }
  }

  return workspace;
}

// ── Auth helpers ──────────────────────────────────────────────────────

/**
 * Builds the env object for SDK queries. Spreads process.env first (so the
 * spawned Claude Code process inherits PATH, HOME, etc.), then overlays
 * auth tokens. The SDK replaces process.env entirely when `env` is provided,
 * so we must include everything the child process needs.
 */
function buildAuthEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  // Prevent "cannot launch inside another Claude Code session" errors
  delete env.CLAUDECODE;

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }

  return env;
}

// ── Query helpers ─────────────────────────────────────────────────────

/** Default options for E2E test queries. */
const DEFAULT_OPTIONS: Options = {
  model: 'claude-haiku-4-5-20251001',
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  maxTurns: 10,
  maxBudgetUsd: 0.25,
  settingSources: [],
  persistSession: false,
  thinking: { type: 'disabled' },
  env: buildAuthEnv(),
};

/**
 * Creates a query generator with safe defaults for E2E testing.
 * Merges caller overrides on top of the defaults.
 */
export function createTestQuery(prompt: string, overrides?: Partial<Options> & { cwd?: string }) {
  const { cwd, ...rest } = overrides ?? {};
  const options: Options = {
    ...DEFAULT_OPTIONS,
    ...rest,
    cwd: cwd ?? DEFAULT_OPTIONS.cwd,
    env: { ...DEFAULT_OPTIONS.env, ...rest.env },
  };
  return query({ prompt, options });
}

// ── Message collection helpers ────────────────────────────────────────

export interface CollectedResult {
  messages: SDKMessage[];
  result: SDKResultMessage | undefined;
}

/**
 * Drains the async generator returned by query(), collecting all
 * messages. Returns the messages array and the final result message.
 */
export async function collectMessages(generator: AsyncGenerator<SDKMessage, void>): Promise<CollectedResult> {
  const messages: SDKMessage[] = [];
  let result: SDKResultMessage | undefined;

  for await (const msg of generator) {
    messages.push(msg);
    if (msg.type === 'result') {
      result = msg as SDKResultMessage;
    }
  }

  return { messages, result };
}

/**
 * Extracts the final text response from a result message.
 * Returns null if the result is an error or missing.
 */
export function getResultText(result: SDKResultMessage | undefined): string | null {
  if (!result) return null;
  if (result.subtype === 'success') {
    return (result as SDKResultSuccess).result;
  }
  return null;
}

// ── Workspace assertion helpers ───────────────────────────────────────

/**
 * Asserts that a file exists in the workspace and optionally matches
 * a content pattern (string or regex).
 */
export function assertWorkspaceFile(
  workspace: string,
  relativePath: string,
  contentMatcher?: string | RegExp,
): void {
  const fullPath = join(workspace, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Expected workspace file not found: ${relativePath} (looked at ${fullPath})`);
  }

  if (contentMatcher !== undefined) {
    const content = readFileSync(fullPath, 'utf-8');
    if (typeof contentMatcher === 'string') {
      if (!content.includes(contentMatcher)) {
        throw new Error(
          `Workspace file ${relativePath} does not contain expected string: "${contentMatcher}"\n` +
          `Actual content (first 500 chars): ${content.slice(0, 500)}`
        );
      }
    } else {
      if (!contentMatcher.test(content)) {
        throw new Error(
          `Workspace file ${relativePath} does not match pattern: ${contentMatcher}\n` +
          `Actual content (first 500 chars): ${content.slice(0, 500)}`
        );
      }
    }
  }
}

// ── Cleanup helpers ───────────────────────────────────────────────────

/**
 * Removes a temp workspace directory. Safe to call if path doesn't exist.
 */
export function cleanupWorkspace(workspace: string): void {
  if (existsSync(workspace)) {
    rmSync(workspace, { recursive: true, force: true });
  }
}

// ── Skip helpers ──────────────────────────────────────────────────────

/**
 * Returns true if an auth token is available for the Claude Agent SDK.
 * Checks CLAUDE_CODE_OAUTH_TOKEN first (preferred), then ANTHROPIC_API_KEY as fallback.
 * Use with `describe.skipIf(!hasApiKey())` or `it.skipIf(!hasApiKey())`.
 */
export function hasApiKey(): boolean {
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return (typeof oauth === 'string' && oauth.length > 0) ||
         (typeof apiKey === 'string' && apiKey.length > 0);
}

/**
 * Call at the top of a test or describe block to skip if no auth token.
 * Throws to abort the suite. Prefer `describe.skipIf(!hasApiKey())` instead.
 */
export function skipIfNoApiKey(): void {
  if (!hasApiKey()) {
    throw new Error('SKIP: Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set — skipping E2E test');
  }
}
