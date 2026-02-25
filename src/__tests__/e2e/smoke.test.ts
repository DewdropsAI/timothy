/**
 * Smoke test for the E2E test harness.
 *
 * Validates that the Claude Agent SDK integration works:
 * - Can create a test workspace
 * - Can send a prompt and receive a response
 * - Can clean up afterward
 *
 * Skipped when no auth token is available (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import {
  createTestWorkspace,
  createTestQuery,
  collectMessages,
  getResultText,
  cleanupWorkspace,
  hasApiKey,
} from './helpers.js';

const workspaces: string[] = [];

afterAll(() => {
  for (const ws of workspaces) {
    cleanupWorkspace(ws);
  }
});

describe.skipIf(!hasApiKey())('E2E smoke test', () => {
  it('sends a prompt and receives a text response', async () => {
    const workspace = createTestWorkspace();
    workspaces.push(workspace);

    const generator = createTestQuery(
      'Reply with exactly the word "pong" and nothing else.',
      {
        cwd: workspace,
        maxTurns: 1,
        tools: [],
      },
    );

    const { messages, result } = await collectMessages(generator);

    // We should have received at least an init system message and a result
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // The result should be a success
    expect(result).toBeDefined();
    expect(result!.type).toBe('result');
    expect(result!.subtype).toBe('success');

    // Should have a text response
    const text = getResultText(result);
    expect(text).toBeTruthy();
    expect(text!.toLowerCase()).toContain('pong');
  });

  it('creates a workspace with expected structure', () => {
    const workspace = createTestWorkspace();
    workspaces.push(workspace);

    expect(existsSync(`${workspace}/identity/self.md`)).toBe(true);
    expect(existsSync(`${workspace}/journal.md`)).toBe(true);
    expect(existsSync(`${workspace}/working-memory/active-context.md`)).toBe(true);
    expect(existsSync(`${workspace}/working-memory/attention-queue.md`)).toBe(true);
    expect(existsSync(`${workspace}/working-memory/pending-actions.md`)).toBe(true);
    expect(existsSync(`${workspace}/ideas`)).toBe(true);
    expect(existsSync(`${workspace}/projects`)).toBe(true);
    expect(existsSync(`${workspace}/memory/facts`)).toBe(true);
  });
});
