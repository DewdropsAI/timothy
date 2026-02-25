import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  _setMemoryDir,
  _setWorkingMemoryDir,
  loadWorkingMemory,
  buildMemoryContext,
  serializeMemoryFile,
  WORKING_MEMORY_FILES,
  estimateTokens,
  TOKEN_BUDGET,
} from '../memory.js';
import type { MemoryFrontmatter } from '../memory.js';

function makeWmContent(body: string): string {
  const fm: MemoryFrontmatter = {
    created: '2026-02-22T00:00:00Z',
    updated: '2026-02-22T00:00:00Z',
    version: 1,
    type: 'working-memory',
    tags: ['working-memory'],
  };
  return serializeMemoryFile(fm, body);
}

describe('working memory loading', () => {
  const tmpWm = join(tmpdir(), 'titus-test-working-memory');
  const tmpMem = join(tmpdir(), 'titus-test-wm-memory');

  beforeEach(() => {
    rmSync(tmpWm, { recursive: true, force: true });
    rmSync(tmpMem, { recursive: true, force: true });
    mkdirSync(tmpWm, { recursive: true });
    mkdirSync(tmpMem, { recursive: true });
    _setWorkingMemoryDir(tmpWm);
    _setMemoryDir(tmpMem);
  });

  afterEach(() => {
    rmSync(tmpWm, { recursive: true, force: true });
    rmSync(tmpMem, { recursive: true, force: true });
  });

  it('WORKING_MEMORY_FILES contains the three expected files', () => {
    expect(WORKING_MEMORY_FILES).toEqual([
      'active-context.md',
      'attention-queue.md',
      'pending-actions.md',
    ]);
  });

  it('loadWorkingMemory returns empty array when no files exist', async () => {
    const result = await loadWorkingMemory();
    expect(result).toEqual([]);
  });

  it('loadWorkingMemory returns empty array when directory does not exist', async () => {
    _setWorkingMemoryDir(join(tmpdir(), 'nonexistent-wm-dir'));
    const result = await loadWorkingMemory();
    expect(result).toEqual([]);
  });

  it('loadWorkingMemory loads existing files', async () => {
    writeFileSync(
      join(tmpWm, 'active-context.md'),
      makeWmContent('Currently focused on implementing the heartbeat.'),
    );
    writeFileSync(
      join(tmpWm, 'pending-actions.md'),
      makeWmContent('- Follow up on API design review'),
    );

    const result = await loadWorkingMemory();
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('active-context.md');
    expect(result[0].content).toContain('heartbeat');
    expect(result[1].name).toBe('pending-actions.md');
    expect(result[1].content).toContain('API design review');
  });

  it('loadWorkingMemory skips files with only whitespace', async () => {
    writeFileSync(join(tmpWm, 'active-context.md'), '   \n\n  ');

    const result = await loadWorkingMemory();
    expect(result).toEqual([]);
  });

  it('loadWorkingMemory loads files in defined order', async () => {
    writeFileSync(join(tmpWm, 'pending-actions.md'), makeWmContent('action'));
    writeFileSync(join(tmpWm, 'active-context.md'), makeWmContent('context'));
    writeFileSync(join(tmpWm, 'attention-queue.md'), makeWmContent('queue'));

    const result = await loadWorkingMemory();
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('active-context.md');
    expect(result[1].name).toBe('attention-queue.md');
    expect(result[2].name).toBe('pending-actions.md');
  });
});

describe('working memory in buildMemoryContext', () => {
  const tmpWm = join(tmpdir(), 'titus-test-wm-build-context');
  const tmpMem = join(tmpdir(), 'titus-test-wm-build-memory');

  beforeEach(() => {
    rmSync(tmpWm, { recursive: true, force: true });
    rmSync(tmpMem, { recursive: true, force: true });
    mkdirSync(tmpWm, { recursive: true });
    mkdirSync(tmpMem, { recursive: true });
    _setWorkingMemoryDir(tmpWm);
    _setMemoryDir(tmpMem);
  });

  afterEach(() => {
    rmSync(tmpWm, { recursive: true, force: true });
    rmSync(tmpMem, { recursive: true, force: true });
  });

  it('includes working memory in context when files exist', async () => {
    writeFileSync(
      join(tmpWm, 'active-context.md'),
      makeWmContent('Focused on working memory implementation.'),
    );

    const { context } = await buildMemoryContext(999);
    expect(context).toContain('### Working Memory');
    expect(context).toContain('Focused on working memory implementation.');
  });

  it('working memory appears before identity in context', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    writeFileSync(
      join(tmpWm, 'active-context.md'),
      makeWmContent('Working memory content.'),
    );
    writeFileSync(join(tmpMem, 'identity.md'), 'I am Titus.');

    const { context } = await buildMemoryContext(999);
    const wmIndex = context.indexOf('### Working Memory');
    const idIndex = context.indexOf('### Identity');
    expect(wmIndex).toBeGreaterThan(-1);
    expect(idIndex).toBeGreaterThan(-1);
    expect(wmIndex).toBeLessThan(idIndex);

    logSpy.mockRestore();
  });

  it('working memory is never budget-trimmed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Create large identity that fills the budget
    const largeContent = 'X'.repeat(TOKEN_BUDGET * 4);
    writeFileSync(join(tmpMem, 'identity.md'), largeContent);

    // Create working memory with identifiable content
    writeFileSync(
      join(tmpWm, 'active-context.md'),
      makeWmContent('CRITICAL: This must survive budget trimming.'),
    );

    const { context } = await buildMemoryContext(999);
    expect(context).toContain('### Working Memory');
    expect(context).toContain('CRITICAL: This must survive budget trimming.');

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('context is empty when no memory or working memory files exist', async () => {
    const { context, tokens } = await buildMemoryContext(999);
    expect(context).toBe('');
    expect(tokens).toBe(0);
  });

  it('renders working memory file names as readable labels', async () => {
    writeFileSync(
      join(tmpWm, 'active-context.md'),
      makeWmContent('Context content.'),
    );
    writeFileSync(
      join(tmpWm, 'attention-queue.md'),
      makeWmContent('Queue content.'),
    );
    writeFileSync(
      join(tmpWm, 'pending-actions.md'),
      makeWmContent('Actions content.'),
    );

    const { context } = await buildMemoryContext(999);
    expect(context).toContain('#### active context');
    expect(context).toContain('#### attention queue');
    expect(context).toContain('#### pending actions');
  });

  it('strips frontmatter from working memory files in context', async () => {
    writeFileSync(
      join(tmpWm, 'active-context.md'),
      makeWmContent('Just the body content.'),
    );

    const { context } = await buildMemoryContext(999);
    expect(context).toContain('Just the body content.');
    // Should not contain frontmatter delimiters in the rendered section
    // (they appear in MEMORY_INSTRUCTIONS markdown code block, so check Working Memory section only)
    const wmSection = context.slice(context.indexOf('### Working Memory'));
    expect(wmSection).not.toContain('type: working-memory');
  });
});
