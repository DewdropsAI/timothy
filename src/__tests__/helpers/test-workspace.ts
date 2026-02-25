/**
 * Test workspace helpers for autonomy and cognitive loop testing.
 *
 * Creates complete temporary workspaces with all required files
 * for testing trust metrics, action authority, and cognitive loop.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface TestWorkspace {
  path: string;
  cleanup: () => void;
}

/**
 * Creates a complete temporary workspace with all directories
 * and seed files needed for autonomy testing.
 */
export function createTestWorkspace(): TestWorkspace {
  const id = randomUUID().slice(0, 8);
  const wsPath = join(tmpdir(), `titus-test-ws-${id}`);

  // Create full directory structure
  mkdirSync(join(wsPath, 'identity'), { recursive: true });
  mkdirSync(join(wsPath, 'working-memory'), { recursive: true });
  mkdirSync(join(wsPath, 'memory', 'facts'), { recursive: true });
  mkdirSync(join(wsPath, 'memory', 'sessions'), { recursive: true });
  mkdirSync(join(wsPath, 'memory', 'topics'), { recursive: true });
  mkdirSync(join(wsPath, 'memory', 'identity'), { recursive: true });
  mkdirSync(join(wsPath, 'ideas'), { recursive: true });
  mkdirSync(join(wsPath, 'projects'), { recursive: true });

  // Seed identity
  writeFileSync(
    join(wsPath, 'identity', 'self.md'),
    '# Titus\n\nI am Titus, an autonomous cognitive individual.\n',
  );

  // Seed working memory files
  writeFileSync(
    join(wsPath, 'working-memory', 'active-context.md'),
    '## Active Context\n\n(No active context yet.)\n',
  );
  writeFileSync(
    join(wsPath, 'working-memory', 'attention-queue.md'),
    '## Attention Queue\n\n(No items queued yet.)\n',
  );
  writeFileSync(
    join(wsPath, 'working-memory', 'pending-actions.md'),
    '## Pending Actions\n\n(No pending actions yet.)\n',
  );

  // Seed journal
  writeFileSync(join(wsPath, 'journal.md'), '# Journal\n\n');

  // Seed concerns file
  writeFileSync(join(wsPath, 'concerns.md'), '# Concerns\n\n(No concerns yet.)\n');

  return {
    path: wsPath,
    cleanup: () => {
      if (existsSync(wsPath)) {
        rmSync(wsPath, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Seeds trust state into a test workspace.
 * Creates the trust-metrics.json file used by TrustManager.
 */
export function seedTrustState(
  wsPath: string,
  state: {
    trustScore?: number;
    signals?: Array<{ type: string; value: number; timestamp: string }>;
    allowedTiers?: string[];
  },
): void {
  const trustDir = join(wsPath, 'working-memory');
  mkdirSync(trustDir, { recursive: true });

  const trustState = {
    trustScore: state.trustScore ?? 0.5,
    signals: state.signals ?? [],
    allowedTiers: state.allowedTiers ?? ['autonomous'],
    lastUpdated: new Date().toISOString(),
  };

  writeFileSync(
    join(trustDir, 'trust-metrics.json'),
    JSON.stringify(trustState, null, 2),
  );
}

/**
 * Seeds concerns into a test workspace's concerns file.
 */
export function seedConcerns(wsPath: string, concerns: string[]): void {
  const content = [
    '# Concerns',
    '',
    ...concerns.map((c) => `- ${c}`),
    '',
  ].join('\n');

  writeFileSync(join(wsPath, 'concerns.md'), content);
}

/**
 * Seeds attention items into a test workspace's attention queue.
 */
export function seedAttentionQueue(wsPath: string, items: string[]): void {
  const content = [
    '## Attention Queue',
    '',
    ...items.map((item) => `- ${item}`),
    '',
  ].join('\n');

  writeFileSync(join(wsPath, 'working-memory', 'attention-queue.md'), content);
}

/**
 * Seeds an action log into a test workspace.
 */
export function seedActionLog(
  wsPath: string,
  actions: Array<{ action: string; result: string; timestamp: string }>,
): void {
  const trustDir = join(wsPath, 'working-memory');
  mkdirSync(trustDir, { recursive: true });

  writeFileSync(
    join(trustDir, 'action-log.json'),
    JSON.stringify(actions, null, 2),
  );
}
