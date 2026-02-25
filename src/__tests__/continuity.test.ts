import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// NOTE: continuity.ts is a new module being built. These tests define
// the expected interface (TDD style). They will fail until implementation
// is complete, which is intentional.
//
// The module extracts writeback parsing from claude.ts into a reusable
// continuity layer that the adapter framework can share.

// ---------------------------------------------------------------------------
// extractWritebacks (moved from claude.ts to continuity.ts)
// ---------------------------------------------------------------------------

describe('continuity: extractWritebacks', () => {
  // Import will fail until continuity.ts is created — this is expected.
  // The adapter.ts already references: import { extractWritebacks } from './continuity.js';

  it('parses a single directive with file, action, and content', async () => {
    const { extractWritebacks } = await import('../continuity.js');

    const response = [
      'Here is my reply.',
      '<!--timothy-write',
      'file: memory/facts/foo.md',
      'action: create',
      'Some fact content.',
      '-->',
    ].join('\n');

    const { directives, cleanResponse } = extractWritebacks(response);

    expect(directives).toHaveLength(1);
    expect(directives[0].file).toBe('memory/facts/foo.md');
    expect(directives[0].action).toBe('create');
    expect(directives[0].content).toBe('Some fact content.');
  });

  it('parses directive with frontmatter between --- delimiters', async () => {
    const { extractWritebacks } = await import('../continuity.js');

    const response = [
      '<!--timothy-write',
      'file: memory/facts/chris-direct.md',
      'action: create',
      '---',
      'topic: preferences',
      'confidence: 0.9',
      '---',
      'Chris prefers blunt communication.',
      '-->',
    ].join('\n');

    const { directives } = extractWritebacks(response);

    expect(directives).toHaveLength(1);
    expect(directives[0].frontmatter).toBeDefined();
    expect(directives[0].frontmatter!.topic).toBe('preferences');
    expect(directives[0].content).toBe('Chris prefers blunt communication.');
  });

  it('returns empty directives array when no directives present', async () => {
    const { extractWritebacks } = await import('../continuity.js');

    const response = 'Just a normal response with no directives.';
    const { directives, cleanResponse } = extractWritebacks(response);

    expect(directives).toEqual([]);
    expect(cleanResponse).toBe(response);
  });

  it('strips all directives from cleanResponse', async () => {
    const { extractWritebacks } = await import('../continuity.js');

    const response = [
      'Hello!',
      '<!--timothy-write',
      'file: a.md',
      'action: create',
      'Content A.',
      '-->',
      'Goodbye!',
    ].join('\n');

    const { cleanResponse } = extractWritebacks(response);

    expect(cleanResponse).not.toContain('<!--timothy-write');
    expect(cleanResponse).toContain('Hello!');
    expect(cleanResponse).toContain('Goodbye!');
  });
});

// ---------------------------------------------------------------------------
// validateWriteback
// ---------------------------------------------------------------------------

describe('continuity: validateWriteback', () => {
  const workspacePath = '/tmp/fake-workspace';

  it('accepts valid relative path', async () => {
    const { validateWriteback } = await import('../continuity.js');

    const directive = {
      file: 'memory/facts/foo.md',
      action: 'create' as const,
      content: 'test',
    };
    expect(validateWriteback(directive, workspacePath)).toBe(true);
  });

  it('rejects path with ../ traversal', async () => {
    const { validateWriteback } = await import('../continuity.js');

    const directive = {
      file: '../../../etc/passwd',
      action: 'create' as const,
      content: 'test',
    };
    expect(validateWriteback(directive, workspacePath)).toBe(false);
  });

  it('rejects absolute path starting with /', async () => {
    const { validateWriteback } = await import('../continuity.js');

    const directive = {
      file: '/etc/passwd',
      action: 'create' as const,
      content: 'test',
    };
    expect(validateWriteback(directive, workspacePath)).toBe(false);
  });

  it('accepts valid actions: create, append, update', async () => {
    const { validateWriteback } = await import('../continuity.js');

    for (const action of ['create', 'append', 'update'] as const) {
      const directive = { file: 'memory/test.md', action, content: 'test' };
      expect(validateWriteback(directive, workspacePath)).toBe(true);
    }
  });

  it('rejects invalid action', async () => {
    const { validateWriteback } = await import('../continuity.js');

    const directive = {
      file: 'memory/test.md',
      action: 'delete' as any,
      content: 'test',
    };
    expect(validateWriteback(directive, workspacePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyWritebacks (real I/O)
// ---------------------------------------------------------------------------

describe('continuity: applyWritebacks', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'timothy-test-continuity-wb-' + Date.now());
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('create action writes new file with correct content', async () => {
    const { applyWritebacks } = await import('../continuity.js');

    const directives = [
      { file: 'test.md', action: 'create' as const, content: 'Hello world' },
    ];

    const result = await applyWritebacks(directives, testDir);

    const content = readFileSync(join(testDir, 'test.md'), 'utf-8');
    expect(content).toContain('Hello world');
    expect(result.succeeded).toContain('test.md');
    expect(result.failed).toHaveLength(0);
  });

  it('append action appends to existing file', async () => {
    const { applyWritebacks } = await import('../continuity.js');

    writeFileSync(join(testDir, 'existing.md'), 'Original content.\n');

    const directives = [
      { file: 'existing.md', action: 'append' as const, content: 'Appended content.' },
    ];

    await applyWritebacks(directives, testDir);

    const content = readFileSync(join(testDir, 'existing.md'), 'utf-8');
    expect(content).toContain('Original content.');
    expect(content).toContain('Appended content.');
  });

  it('skips directives with path traversal', async () => {
    const { applyWritebacks } = await import('../continuity.js');

    const directives = [
      { file: '../../../etc/evil.md', action: 'create' as const, content: 'evil' },
      { file: 'valid.md', action: 'create' as const, content: 'good' },
    ];

    const result = await applyWritebacks(directives, testDir);

    expect(existsSync(join(testDir, 'valid.md'))).toBe(true);
    expect(result.succeeded).toEqual(['valid.md']);
  });
});

// ---------------------------------------------------------------------------
// ContinuityManager hooks
// ---------------------------------------------------------------------------

describe('continuity: ContinuityManager', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'timothy-test-continuity-mgr-' + Date.now());
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('can be instantiated with a workspace path', async () => {
    const { ContinuityManager } = await import('../continuity.js');

    const manager = new ContinuityManager(testDir);
    expect(manager).toBeDefined();
  });

  it('processResponse extracts writebacks and applies them', async () => {
    const { ContinuityManager } = await import('../continuity.js');

    const manager = new ContinuityManager(testDir);

    const response = [
      'I noted that.',
      '<!--timothy-write',
      'file: memory/facts/test.md',
      'action: create',
      'A test fact.',
      '-->',
      'Anything else?',
    ].join('\n');

    const result = await manager.processResponse(response);

    expect(result.cleanResponse).toContain('I noted that.');
    expect(result.cleanResponse).toContain('Anything else?');
    expect(result.cleanResponse).not.toContain('<!--timothy-write');
    expect(result.writebackResults.succeeded).toContain('memory/facts/test.md');

    const content = readFileSync(join(testDir, 'memory', 'facts', 'test.md'), 'utf-8');
    expect(content).toContain('A test fact.');
  });

  it('processResponse with no directives returns response as-is', async () => {
    const { ContinuityManager } = await import('../continuity.js');

    const manager = new ContinuityManager(testDir);
    const response = 'Just a normal response.';

    const result = await manager.processResponse(response);

    expect(result.cleanResponse).toBe(response);
    expect(result.writebackResults.succeeded).toEqual([]);
    expect(result.writebackResults.failed).toEqual([]);
  });
});
