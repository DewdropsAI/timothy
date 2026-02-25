import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_PATH = path.resolve(PROJECT_ROOT, 'workspace');
const TEMPLATES_DIR = path.resolve(PROJECT_ROOT, 'templates');

/**
 * Loads a seed template from templates/<name>.
 * These are initial-bootstrap-only files — the workspace copies evolve independently.
 */
function loadTemplate(filename: string): string {
  return readFileSync(path.join(TEMPLATES_DIR, filename), 'utf-8');
}

/**
 * Returns the resolved absolute path to the workspace directory.
 */
export function getWorkspacePath(): string {
  return WORKSPACE_PATH;
}

/**
 * Ensures the workspace directory structure exists on disk.
 * Creates directories and initial files if missing; never overwrites existing content.
 * Seed templates are loaded from templates/ — workspace files evolve independently.
 */
export async function ensureWorkspace(): Promise<void> {
  const existed = existsSync(WORKSPACE_PATH);

  mkdirSync(path.resolve(WORKSPACE_PATH, 'ideas'), { recursive: true });
  mkdirSync(path.resolve(WORKSPACE_PATH, 'projects'), { recursive: true });
  mkdirSync(path.resolve(WORKSPACE_PATH, 'identity'), { recursive: true });
  mkdirSync(path.resolve(WORKSPACE_PATH, 'working-memory'), { recursive: true });
  mkdirSync(path.resolve(WORKSPACE_PATH, 'preparations'), { recursive: true });

  const journalPath = path.resolve(WORKSPACE_PATH, 'journal.md');
  if (!existsSync(journalPath)) {
    writeFileSync(journalPath, loadTemplate('journal-seed.md'));
  }

  const identityPath = path.resolve(WORKSPACE_PATH, 'identity', 'self.md');
  if (!existsSync(identityPath)) {
    writeFileSync(identityPath, loadTemplate('identity-seed.md'));
  }

  // Bootstrap working memory seed files
  const wmFiles = [
    { name: 'active-context.md', template: 'working-memory-active-context-seed.md' },
    { name: 'attention-queue.md', template: 'working-memory-attention-queue-seed.md' },
    { name: 'pending-actions.md', template: 'working-memory-pending-actions-seed.md' },
  ];
  for (const wm of wmFiles) {
    const wmPath = path.resolve(WORKSPACE_PATH, 'working-memory', wm.name);
    if (!existsSync(wmPath)) {
      writeFileSync(wmPath, loadTemplate(wm.template));
    }
  }

  // Bootstrap autonomy seed files (trust metrics and action log human-readable seeds)
  mkdirSync(path.resolve(WORKSPACE_PATH, 'memory'), { recursive: true });
  const autonomySeeds = [
    { name: 'trust-metrics-seed.md', dest: 'memory/trust-metrics-seed.md' },
    { name: 'action-log-seed.md', dest: 'memory/action-log-seed.md' },
  ];
  for (const seed of autonomySeeds) {
    const seedPath = path.resolve(WORKSPACE_PATH, seed.dest);
    if (!existsSync(seedPath)) {
      writeFileSync(seedPath, loadTemplate(seed.name));
    }
  }

  if (existed) {
    console.log('Workspace already exists at', WORKSPACE_PATH);
  } else {
    console.log('Workspace created at', WORKSPACE_PATH);
  }
}
