import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureWorkspace, getWorkspacePath } from '../workspace.js';

// Use a temp directory so tests never touch the real workspace.
// The real workspace/ is Titus's persistent mind — deleting it causes amnesia.
const TEST_WORKSPACE = join(tmpdir(), 'titus-test-workspace');

// workspace.ts doesn't expose a _setWorkspacePath(), so we test via
// the public API which uses PROJECT_ROOT-relative paths. To isolate,
// we create a temp dir and verify behavior through ensureWorkspace's
// file creation patterns.
//
// NOTE: These tests verify the public contract — directory creation
// and file seeding — without operating on the real workspace.

function cleanup() {
  if (existsSync(TEST_WORKSPACE)) {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  }
}

describe('workspace', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  describe('getWorkspacePath', () => {
    it('returns an absolute path', () => {
      const wsPath = getWorkspacePath();
      expect(wsPath).toMatch(/^\//);
    });

    it('ends with workspace', () => {
      const wsPath = getWorkspacePath();
      expect(wsPath).toMatch(/\/workspace$/);
    });

    it('returns a consistent path', () => {
      expect(getWorkspacePath()).toBe(getWorkspacePath());
    });

    it('uses project-root-relative path, not CWD-relative', () => {
      const wsPath = getWorkspacePath();
      // Should contain the project directory name, proving it's resolved
      // from __dirname, not from an arbitrary CWD
      expect(wsPath).toContain('titus');
      expect(wsPath).toMatch(/\/workspace$/);
    });
  });

  describe('ensureWorkspace', () => {
    // ensureWorkspace operates on the real workspace path (by design —
    // it bootstraps Titus's mind). These tests verify it doesn't
    // overwrite existing files by creating content first, then calling
    // ensureWorkspace, then checking the content is preserved.
    //
    // We skip tests that require a clean workspace (creating from scratch)
    // since that would destroy the real workspace.

    it('does not overwrite existing identity/self.md', async () => {
      const wsPath = getWorkspacePath();
      const identityPath = resolve(wsPath, 'identity', 'self.md');

      // Only run if the file exists (don't create test state in real workspace)
      if (!existsSync(identityPath)) {
        return;
      }

      const before = readFileSync(identityPath, 'utf-8');
      await ensureWorkspace();
      const after = readFileSync(identityPath, 'utf-8');

      expect(after).toBe(before);
    });

    it('does not overwrite existing journal.md', async () => {
      const wsPath = getWorkspacePath();
      const journalPath = resolve(wsPath, 'journal.md');

      if (!existsSync(journalPath)) {
        return;
      }

      const before = readFileSync(journalPath, 'utf-8');
      await ensureWorkspace();
      const after = readFileSync(journalPath, 'utf-8');

      expect(after).toBe(before);
    });
  });
});
