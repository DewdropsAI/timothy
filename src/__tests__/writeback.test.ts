import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractWritebacks,
  applyWritebacks,
  validateWriteback,
} from '../claude.js';
import type { WritebackDirective, WritebackResult } from '../claude.js';

// ---------------------------------------------------------------------------
// extractWritebacks
// ---------------------------------------------------------------------------

describe('extractWritebacks', () => {
  it('parses a single directive with file, action, and content', () => {
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

  it('parses directive with frontmatter between --- delimiters', () => {
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
    expect(directives[0].frontmatter!.confidence).toBe('0.9');
    expect(directives[0].content).toBe('Chris prefers blunt communication.');
  });

  it('parses directive without frontmatter', () => {
    const response = [
      '<!--timothy-write',
      'file: memory/facts/simple.md',
      'action: create',
      'Just plain content here.',
      '-->',
    ].join('\n');

    const { directives } = extractWritebacks(response);

    expect(directives).toHaveLength(1);
    expect(directives[0].frontmatter).toBeUndefined();
    expect(directives[0].content).toBe('Just plain content here.');
  });

  it('parses multiple directives from one response', () => {
    const response = [
      'Some intro text.',
      '<!--timothy-write',
      'file: memory/facts/a.md',
      'action: create',
      'Fact A.',
      '-->',
      'Middle text.',
      '<!--timothy-write',
      'file: journal.md',
      'action: append',
      'Journal entry.',
      '-->',
      'Closing text.',
    ].join('\n');

    const { directives } = extractWritebacks(response);

    expect(directives).toHaveLength(2);
    expect(directives[0].file).toBe('memory/facts/a.md');
    expect(directives[0].action).toBe('create');
    expect(directives[1].file).toBe('journal.md');
    expect(directives[1].action).toBe('append');
  });

  it('returns empty directives array when no directives present', () => {
    const response = 'Just a normal response with no directives.';

    const { directives, cleanResponse } = extractWritebacks(response);

    expect(directives).toEqual([]);
    expect(cleanResponse).toBe(response);
  });

  it('skips malformed directives missing file', () => {
    const response = [
      '<!--timothy-write',
      'action: create',
      'Content without a file field.',
      '-->',
    ].join('\n');

    const { directives } = extractWritebacks(response);

    expect(directives).toHaveLength(0);
  });

  it('skips malformed directives missing action', () => {
    const response = [
      '<!--timothy-write',
      'file: memory/facts/foo.md',
      'Content without an action field.',
      '-->',
    ].join('\n');

    const { directives } = extractWritebacks(response);

    expect(directives).toHaveLength(0);
  });

  it('preserves response text around directives in cleanResponse', () => {
    const response = [
      'Before directive.',
      '<!--timothy-write',
      'file: memory/facts/foo.md',
      'action: create',
      'Some content.',
      '-->',
      'After directive.',
    ].join('\n');

    const { cleanResponse } = extractWritebacks(response);

    expect(cleanResponse).toContain('Before directive.');
    expect(cleanResponse).toContain('After directive.');
  });

  it('strips all directives from cleanResponse', () => {
    const response = [
      'Hello!',
      '<!--timothy-write',
      'file: a.md',
      'action: create',
      'Content A.',
      '-->',
      'Middle.',
      '<!--timothy-write',
      'file: b.md',
      'action: append',
      'Content B.',
      '-->',
      'Goodbye!',
    ].join('\n');

    const { cleanResponse } = extractWritebacks(response);

    expect(cleanResponse).not.toContain('<!--timothy-write');
    expect(cleanResponse).not.toContain('Content A.');
    expect(cleanResponse).not.toContain('Content B.');
    expect(cleanResponse).toContain('Hello!');
    expect(cleanResponse).toContain('Middle.');
    expect(cleanResponse).toContain('Goodbye!');
  });

  it('handles directive with extra whitespace and newlines', () => {
    const response = [
      '<!--timothy-write',
      '  file:   memory/facts/spaced.md  ',
      '  action:   create  ',
      '',
      'Content with leading blank line.',
      '',
      '-->',
    ].join('\n');

    const { directives } = extractWritebacks(response);

    expect(directives).toHaveLength(1);
    expect(directives[0].file).toBe('memory/facts/spaced.md');
    expect(directives[0].action).toBe('create');
  });
});

// ---------------------------------------------------------------------------
// validateWriteback
// ---------------------------------------------------------------------------

describe('validateWriteback', () => {
  const workspacePath = '/tmp/fake-workspace';

  it('accepts valid relative path', () => {
    const directive: WritebackDirective = {
      file: 'memory/facts/foo.md',
      action: 'create',
      content: 'test',
    };
    expect(validateWriteback(directive, workspacePath)).toBe(true);
  });

  it('accepts nested subdirectory path', () => {
    const directive: WritebackDirective = {
      file: 'memory/facts/nested/deep/file.md',
      action: 'create',
      content: 'test',
    };
    expect(validateWriteback(directive, workspacePath)).toBe(true);
  });

  it('rejects path with ../ traversal', () => {
    const directive: WritebackDirective = {
      file: '../../../etc/passwd',
      action: 'create',
      content: 'test',
    };
    expect(validateWriteback(directive, workspacePath)).toBe(false);
  });

  it('rejects absolute path starting with /', () => {
    const directive: WritebackDirective = {
      file: '/etc/passwd',
      action: 'create',
      content: 'test',
    };
    expect(validateWriteback(directive, workspacePath)).toBe(false);
  });

  it('rejects path with .. component in middle', () => {
    const directive: WritebackDirective = {
      file: 'memory/../../../etc/passwd',
      action: 'create',
      content: 'test',
    };
    expect(validateWriteback(directive, workspacePath)).toBe(false);
  });

  it('accepts valid actions: create, append, update', () => {
    for (const action of ['create', 'append', 'update'] as const) {
      const directive: WritebackDirective = {
        file: 'memory/test.md',
        action,
        content: 'test',
      };
      expect(validateWriteback(directive, workspacePath)).toBe(true);
    }
  });

  it('rejects invalid action', () => {
    const directive = {
      file: 'memory/test.md',
      action: 'delete' as any,
      content: 'test',
    };
    expect(validateWriteback(directive, workspacePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyWritebacks (real I/O tests)
// ---------------------------------------------------------------------------

describe('applyWritebacks', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'timothy-test-writeback-' + Date.now());
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('create action writes new file with correct content', async () => {
    const directives: WritebackDirective[] = [
      { file: 'test.md', action: 'create', content: 'Hello world' },
    ];

    const result = await applyWritebacks(directives, testDir);

    const content = readFileSync(join(testDir, 'test.md'), 'utf-8');
    expect(content).toContain('Hello world');
    expect(result.succeeded).toContain('test.md');
    expect(result.failed).toHaveLength(0);
  });

  it('create action with frontmatter includes YAML block', async () => {
    const directives: WritebackDirective[] = [
      {
        file: 'facts/chris.md',
        action: 'create',
        frontmatter: { topic: 'preferences', confidence: '0.9' },
        content: 'Chris prefers direct communication.',
      },
    ];

    await applyWritebacks(directives, testDir);

    const content = readFileSync(join(testDir, 'facts', 'chris.md'), 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain('topic: preferences');
    expect(content).toContain('confidence: 0.9');
    expect(content).toContain('Chris prefers direct communication.');
  });

  it('create action creates parent directories automatically', async () => {
    const directives: WritebackDirective[] = [
      {
        file: 'deep/nested/dir/file.md',
        action: 'create',
        content: 'Nested file content.',
      },
    ];

    await applyWritebacks(directives, testDir);

    expect(existsSync(join(testDir, 'deep', 'nested', 'dir', 'file.md'))).toBe(true);
    const content = readFileSync(join(testDir, 'deep', 'nested', 'dir', 'file.md'), 'utf-8');
    expect(content).toContain('Nested file content.');
  });

  it('append action appends to existing file', async () => {
    const filePath = join(testDir, 'existing.md');
    writeFileSync(filePath, 'Original content.\n');

    const directives: WritebackDirective[] = [
      { file: 'existing.md', action: 'append', content: 'Appended content.' },
    ];

    await applyWritebacks(directives, testDir);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('Original content.');
    expect(content).toContain('Appended content.');
  });

  it('update action replaces file content entirely', async () => {
    const filePath = join(testDir, 'update-me.md');
    writeFileSync(filePath, 'Old content that should be replaced.');

    const directives: WritebackDirective[] = [
      { file: 'update-me.md', action: 'update', content: 'Brand new content.' },
    ];

    await applyWritebacks(directives, testDir);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('Brand new content.');
    expect(content).not.toContain('Old content');
  });

  it('skips directives with invalid paths (path traversal)', async () => {
    const directives: WritebackDirective[] = [
      { file: '../../../etc/evil.md', action: 'create', content: 'Should not be written.' },
      { file: 'valid.md', action: 'create', content: 'This should be written.' },
    ];

    const result = await applyWritebacks(directives, testDir);

    expect(existsSync(join(testDir, 'valid.md'))).toBe(true);
    // The traversal file should not exist anywhere accessible
    expect(existsSync(join(testDir, '..', '..', '..', 'etc', 'evil.md'))).toBe(false);
    // Validation-skipped directives don't appear in succeeded or failed
    expect(result.succeeded).toEqual(['valid.md']);
    expect(result.failed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: full round-trip
// ---------------------------------------------------------------------------

describe('integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'timothy-test-writeback-integ-' + Date.now());
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('full round-trip: extract directives, apply writes, verify files and clean response', async () => {
    const response = [
      'I will remember that for you.',
      '<!--timothy-write',
      'file: memory/facts/likes-hiking.md',
      'action: create',
      '---',
      'topic: hobbies',
      'source: conversation',
      '---',
      'Chris enjoys hiking on weekends.',
      '-->',
      'Is there anything else you would like to discuss?',
    ].join('\n');

    // Step 1: Extract
    const { directives, cleanResponse } = extractWritebacks(response);

    expect(directives).toHaveLength(1);
    expect(directives[0].file).toBe('memory/facts/likes-hiking.md');
    expect(directives[0].action).toBe('create');
    expect(directives[0].frontmatter).toBeDefined();
    expect(directives[0].frontmatter!.topic).toBe('hobbies');
    expect(directives[0].content).toBe('Chris enjoys hiking on weekends.');

    // Step 2: Clean response has no directives
    expect(cleanResponse).not.toContain('<!--timothy-write');
    expect(cleanResponse).not.toContain('-->');
    expect(cleanResponse).toContain('I will remember that for you.');
    expect(cleanResponse).toContain('Is there anything else you would like to discuss?');

    // Step 3: Apply
    const result = await applyWritebacks(directives, testDir);

    // Step 4: Verify file exists with correct content
    const filePath = join(testDir, 'memory', 'facts', 'likes-hiking.md');
    expect(existsSync(filePath)).toBe(true);

    const fileContent = readFileSync(filePath, 'utf-8');
    expect(fileContent).toContain('topic: hobbies');
    expect(fileContent).toContain('source: conversation');
    expect(fileContent).toContain('Chris enjoys hiking on weekends.');

    // Step 5: Verify result reports success
    expect(result.succeeded).toContain('memory/facts/likes-hiking.md');
    expect(result.failed).toHaveLength(0);
  });
});
