import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractWritebacks,
  applyWritebacks,
} from '../claude.js';
import type { WritebackDirective, WritebackResult } from '../claude.js';

// ---------------------------------------------------------------------------
// Integration: end-to-end writeback flow
// ---------------------------------------------------------------------------

describe('writeback end-to-end integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'titus-test-wb-e2e-' + Date.now());
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('extract → apply → verify: single create directive with frontmatter', async () => {
    const rawResponse = [
      'I will remember that for you.',
      '<!--titus-write',
      'file: memory/facts/likes-coffee.md',
      'action: create',
      '---',
      'topic: preferences',
      'confidence: 0.95',
      '---',
      'Chris enjoys morning coffee.',
      '-->',
      'Is there anything else?',
    ].join('\n');

    // Step 1: Extract
    const { directives, cleanResponse } = extractWritebacks(rawResponse);

    expect(directives).toHaveLength(1);
    expect(directives[0].file).toBe('memory/facts/likes-coffee.md');
    expect(directives[0].action).toBe('create');
    expect(directives[0].frontmatter).toBeDefined();
    expect(directives[0].frontmatter!.topic).toBe('preferences');
    expect(directives[0].frontmatter!.confidence).toBe('0.95');
    expect(directives[0].content).toBe('Chris enjoys morning coffee.');

    // Step 2: Clean response is free of directives
    expect(cleanResponse).not.toContain('<!--titus-write');
    expect(cleanResponse).not.toContain('-->');
    expect(cleanResponse).toContain('I will remember that for you.');
    expect(cleanResponse).toContain('Is there anything else?');

    // Step 3: Apply
    await applyWritebacks(directives, testDir);

    // Step 4: Verify file on disk
    const filePath = join(testDir, 'memory', 'facts', 'likes-coffee.md');
    expect(existsSync(filePath)).toBe(true);

    const fileContent = readFileSync(filePath, 'utf-8');
    expect(fileContent).toContain('topic: preferences');
    expect(fileContent).toContain('confidence: 0.95');
    expect(fileContent).toContain('Chris enjoys morning coffee.');
  });

  it('extract → apply → verify: multiple directives (create + append)', async () => {
    // Pre-create a file for the append directive
    const journalDir = join(testDir);
    writeFileSync(join(journalDir, 'journal.md'), 'Previous entry.\n');

    const rawResponse = [
      'Noted. I have updated my memory.',
      '<!--titus-write',
      'file: memory/facts/uses-vim.md',
      'action: create',
      'Chris uses Vim as his primary editor.',
      '-->',
      'I also updated the journal.',
      '<!--titus-write',
      'file: journal.md',
      'action: append',
      '2026-02-17: Chris mentioned he uses Vim.',
      '-->',
      'All done!',
    ].join('\n');

    const { directives, cleanResponse } = extractWritebacks(rawResponse);

    expect(directives).toHaveLength(2);
    expect(directives[0].action).toBe('create');
    expect(directives[1].action).toBe('append');

    // Clean response should contain only the visible text
    expect(cleanResponse).toContain('Noted. I have updated my memory.');
    expect(cleanResponse).toContain('I also updated the journal.');
    expect(cleanResponse).toContain('All done!');
    expect(cleanResponse).not.toContain('<!--titus-write');

    await applyWritebacks(directives, testDir);

    // Verify create
    const factsPath = join(testDir, 'memory', 'facts', 'uses-vim.md');
    expect(existsSync(factsPath)).toBe(true);
    expect(readFileSync(factsPath, 'utf-8')).toContain('Chris uses Vim as his primary editor.');

    // Verify append
    const journalPath = join(testDir, 'journal.md');
    const journalContent = readFileSync(journalPath, 'utf-8');
    expect(journalContent).toContain('Previous entry.');
    expect(journalContent).toContain('2026-02-17: Chris mentioned he uses Vim.');
  });

  it('extract → apply → verify: update action replaces existing content', async () => {
    // Pre-create the file to be updated
    mkdirSync(join(testDir, 'memory'), { recursive: true });
    writeFileSync(join(testDir, 'memory', 'profile.md'), 'Old profile content.');

    const rawResponse = [
      'Updated your profile.',
      '<!--titus-write',
      'file: memory/profile.md',
      'action: update',
      'New profile content with latest info.',
      '-->',
    ].join('\n');

    const { directives } = extractWritebacks(rawResponse);
    await applyWritebacks(directives, testDir);

    const content = readFileSync(join(testDir, 'memory', 'profile.md'), 'utf-8');
    expect(content).toContain('New profile content with latest info.');
    expect(content).not.toContain('Old profile content.');
  });

  it('mixed valid and invalid directives: valid ones applied, invalid skipped', async () => {
    const rawResponse = [
      'Processing.',
      '<!--titus-write',
      'file: ../../../etc/evil.md',
      'action: create',
      'Should not be written.',
      '-->',
      '<!--titus-write',
      'file: memory/valid.md',
      'action: create',
      'This is valid.',
      '-->',
      '<!--titus-write',
      'file: memory/malformed.md',
      'action: delete',
      'Invalid action.',
      '-->',
    ].join('\n');

    const { directives, cleanResponse } = extractWritebacks(rawResponse);

    // delete action is invalid so it should be skipped during extraction
    expect(directives).toHaveLength(2); // path traversal + valid (delete is skipped at extract)

    await applyWritebacks(directives, testDir);

    // Valid file should exist
    expect(existsSync(join(testDir, 'memory', 'valid.md'))).toBe(true);
    expect(readFileSync(join(testDir, 'memory', 'valid.md'), 'utf-8')).toContain('This is valid.');

    // Traversal path should NOT have been written
    expect(existsSync(join(testDir, '..', '..', '..', 'etc', 'evil.md'))).toBe(false);

    // Clean response should not have any directives
    expect(cleanResponse).not.toContain('<!--titus-write');
    expect(cleanResponse).toContain('Processing.');
  });

  it('no directives: response passes through unchanged', async () => {
    const rawResponse = 'Just a normal response without any directives.';

    const { directives, cleanResponse } = extractWritebacks(rawResponse);

    expect(directives).toHaveLength(0);
    expect(cleanResponse).toBe(rawResponse);

    // applyWritebacks with empty array should be a no-op
    await applyWritebacks(directives, testDir);
  });
});

// ---------------------------------------------------------------------------
// Promise chain resilience: writeback failures must not block response
// ---------------------------------------------------------------------------

describe('writeback failure resilience', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'titus-test-wb-resilience-' + Date.now());
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('applyWritebacks does not throw when a single directive fails and reports it in result', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Create a regular file where the directive expects a directory,
    // so mkdirSync will fail (ENOTDIR) even as root
    writeFileSync(join(testDir, 'blocker'), 'I am a file, not a directory');

    const directives: WritebackDirective[] = [
      { file: 'blocker/sub/blocked.md', action: 'create', content: 'Should fail.' },
      { file: 'success.md', action: 'create', content: 'Should succeed.' },
    ];

    // Should not throw
    const result = await applyWritebacks(directives, testDir);

    // The successful directive should still have been applied
    expect(existsSync(join(testDir, 'success.md'))).toBe(true);
    expect(readFileSync(join(testDir, 'success.md'), 'utf-8')).toContain('Should succeed.');
    expect(result.succeeded).toContain('success.md');

    // The failed directive should be reported
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].file).toBe('blocker/sub/blocked.md');
    expect(result.failed[0].error).toBeTruthy();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('extractWritebacks + applyWritebacks: failure in apply returns result with failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const rawResponse = [
      'I remembered something.',
      '<!--titus-write',
      'file: blocker-file/fail.md',
      'action: create',
      'This write will fail.',
      '-->',
      'But you still get this response.',
    ].join('\n');

    const { directives, cleanResponse } = extractWritebacks(rawResponse);

    // Verify clean response is available regardless of apply outcome
    expect(cleanResponse).toContain('I remembered something.');
    expect(cleanResponse).toContain('But you still get this response.');
    expect(cleanResponse).not.toContain('<!--titus-write');

    // Create a regular file where the directive expects a directory (ENOTDIR)
    writeFileSync(join(testDir, 'blocker-file'), 'I am a file, not a directory');

    // applyWritebacks should not throw — errors are reported in result
    const result = await applyWritebacks(directives, testDir);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].file).toBe('blocker-file/fail.md');
    expect(result.succeeded).toHaveLength(0);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('simulates invokeClaude promise chain: writeback failure appends notice to response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Simulate exactly what invokeClaude does on success:
    // 1. Extract writebacks from raw response
    // 2. Apply writebacks and check result
    // 3. If failures, append notice to response

    const rawResponse = [
      'Hello! I noted your preference.',
      '<!--titus-write',
      'file: blocker/pref.md',
      'action: create',
      'User prefers dark mode.',
      '-->',
    ].join('\n');

    const { directives, cleanResponse } = extractWritebacks(rawResponse);

    // Create a regular file where the directive expects a directory (ENOTDIR)
    writeFileSync(join(testDir, 'blocker'), 'I am a file, not a directory');

    // Simulate the promise chain from invokeClaude
    const chatId = 'test-chat';
    const responsePromise = new Promise<string>((resolve) => {
      if (directives.length > 0) {
        (async () => {
          try {
            const writeResult = await applyWritebacks(directives, testDir);
            if (writeResult.failed.length > 0) {
              const failedFiles = writeResult.failed.map((f) => f.file).join(', ');
              console.error(
                `[writeback] chat=${chatId} memory_write_failed files=[${failedFiles}] errors=${JSON.stringify(writeResult.failed)}`,
              );
              const notice = `\n\n[Note: I tried to save something to memory but the write failed for: ${failedFiles}. I may not remember this next time.]`;
              resolve(cleanResponse + notice);
            } else {
              resolve(cleanResponse);
            }
          } catch (err) {
            console.error(`[writeback] chat=${chatId} unexpected_writeback_error:`, err);
            resolve(cleanResponse + '\n\n[Note: I tried to save something to memory but encountered an error. I may not remember this next time.]');
          }
        })();
      } else {
        resolve(cleanResponse);
      }
    });

    const result = await responsePromise;
    expect(result).toContain('Hello! I noted your preference.');
    expect(result).toContain('[Note: I tried to save something to memory but the write failed for: blocker/pref.md');
    expect(result).not.toContain('<!--titus-write');

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('applyWritebacks handles all directives being validation-rejected gracefully', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const directives: WritebackDirective[] = [
      { file: '../traversal.md', action: 'create', content: 'Skip me.' },
      { file: '/absolute/path.md', action: 'create', content: 'Skip me too.' },
    ];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Should not throw even when all directives are invalid
    const result = await applyWritebacks(directives, testDir);
    expect(result.succeeded).toHaveLength(0);
    // Validation-skipped directives are not in the failed list (they never attempted I/O)
    expect(result.failed).toHaveLength(0);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
