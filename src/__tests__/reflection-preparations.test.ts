import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setMemoryDir, _setWorkingMemoryDir, serializeMemoryFile } from '../memory.js';
import type { MemoryFrontmatter } from '../memory.js';
import {
  reflect,
  _setReflectionInvoker,
  _setLastReflectionTime,
  type GatherResult,
} from '../reflection.js';
import { _setPreparationsDir } from '../preparations.js';

const tmpWm = join(tmpdir(), 'titus-test-reflprep-wm');
const tmpMem = join(tmpdir(), 'titus-test-reflprep-mem');
const tmpPrep = join(tmpdir(), 'titus-test-reflprep-prep');

function makeGatherResult(overrides: Partial<GatherResult> = {}): GatherResult {
  return {
    workingMemory: [],
    activeThreads: [],
    hasAttentionItems: false,
    hasPendingActions: false,
    trustSummary: 'Trust state: not loaded.',
    pendingProposalCount: 0,
    trustScore: 0.5,
    ...overrides,
  };
}

function makeWmContent(body: string): string {
  const fm: MemoryFrontmatter = {
    created: '2026-02-25T00:00:00Z',
    updated: '2026-02-25T00:00:00Z',
    version: 1,
    type: 'working-memory',
    tags: ['working-memory'],
  };
  return serializeMemoryFile(fm, body);
}

beforeEach(() => {
  rmSync(tmpWm, { recursive: true, force: true });
  rmSync(tmpMem, { recursive: true, force: true });
  rmSync(tmpPrep, { recursive: true, force: true });
  mkdirSync(tmpWm, { recursive: true });
  mkdirSync(tmpMem, { recursive: true });
  mkdirSync(tmpPrep, { recursive: true });
  _setWorkingMemoryDir(tmpWm);
  _setMemoryDir(tmpMem);
  _setPreparationsDir(tmpPrep);
  _setReflectionInvoker(null);
  _setLastReflectionTime(0);
});

afterEach(() => {
  _setReflectionInvoker(null);
  _setLastReflectionTime(0);
  rmSync(tmpWm, { recursive: true, force: true });
  rmSync(tmpMem, { recursive: true, force: true });
  rmSync(tmpPrep, { recursive: true, force: true });
});

describe('preparation directive parsing', () => {
  it('parses a single preparation directive from the response', async () => {
    const response = [
      'I should prepare context for the deployment discussion.',
      '',
      '<!--titus-prepare',
      'topic: deployment-strategy',
      'keywords: [deploy, kubernetes, rollback]',
      '---',
      'Chris mentioned wanting to review the deployment strategy.',
      'Current setup uses rolling deployments with 3 replicas.',
      'Options: blue-green, canary, or keep rolling.',
      '-->',
    ].join('\n');

    _setReflectionInvoker(async () => response);

    const result = await reflect(makeGatherResult({ hasAttentionItems: true }));

    expect(result.preparations).toEqual(['deployment-strategy']);
  });

  it('parses multiple preparation directives', async () => {
    const response = [
      'Preparing for a few things.',
      '',
      '<!--titus-prepare',
      'topic: ci-pipeline',
      'keywords: [ci, github-actions, tests]',
      '---',
      'The CI pipeline has been flaky on the integration tests.',
      '-->',
      '',
      '<!--titus-prepare',
      'topic: router-refactor',
      'keywords: [router, adapter, refactoring]',
      '---',
      'Router refactoring is in phase 3 of 5.',
      'Next step is updating claude.ts to wrap think().',
      '-->',
    ].join('\n');

    _setReflectionInvoker(async () => response);

    const result = await reflect(makeGatherResult({ hasAttentionItems: true }));

    expect(result.preparations).toHaveLength(2);
    expect(result.preparations).toContain('ci-pipeline');
    expect(result.preparations).toContain('router-refactor');
  });

  it('saves preparations to disk', async () => {
    const response = [
      'Preparing deployment context.',
      '',
      '<!--titus-prepare',
      'topic: deployment-review',
      'keywords: [deploy, review]',
      '---',
      'Deployment is scheduled for Friday.',
      'Need to verify rollback procedures.',
      '-->',
    ].join('\n');

    _setReflectionInvoker(async () => response);

    await reflect(makeGatherResult({ hasAttentionItems: true }));

    const savedFile = join(tmpPrep, 'deployment-review.md');
    expect(existsSync(savedFile)).toBe(true);

    const content = readFileSync(savedFile, 'utf-8');
    expect(content).toContain('keywords: [deploy, review]');
    expect(content).toContain('Deployment is scheduled for Friday.');
    expect(content).toContain('Need to verify rollback procedures.');
    expect(content).toContain('created:');
    expect(content).toContain('expires:');
  });

  it('strips preparation directives from the clean response', async () => {
    const response = [
      'I noticed something in the attention queue.',
      '',
      '<!--titus-prepare',
      'topic: test-topic',
      'keywords: [test]',
      '---',
      'Some prepared content here.',
      '-->',
      '',
      'Nothing else requires attention.',
    ].join('\n');

    _setReflectionInvoker(async () => response);

    const result = await reflect(makeGatherResult({ hasAttentionItems: true }));

    expect(result.response).not.toContain('<!--titus-prepare');
    expect(result.response).not.toContain('Some prepared content here.');
    expect(result.response).toContain('I noticed something in the attention queue.');
    expect(result.response).toContain('Nothing else requires attention.');
  });

  it('returns preparations: [] when LLM returns null', async () => {
    _setReflectionInvoker(async () => null);

    const result = await reflect(makeGatherResult({ hasAttentionItems: true }));

    expect(result.preparations).toEqual([]);
    expect(result.response).toBeNull();
  });

  it('returns preparations: [] when response has no prepare directives', async () => {
    _setReflectionInvoker(async () => 'Nothing requires attention.');

    const result = await reflect(makeGatherResult({ hasAttentionItems: true }));

    expect(result.preparations).toEqual([]);
  });

  it('skips malformed directives missing topic', async () => {
    const response = [
      'Thinking about stuff.',
      '',
      '<!--titus-prepare',
      'keywords: [something]',
      '---',
      'Content without a topic.',
      '-->',
    ].join('\n');

    _setReflectionInvoker(async () => response);

    const result = await reflect(makeGatherResult({ hasAttentionItems: true }));

    expect(result.preparations).toEqual([]);
  });

  it('skips directives with empty content', async () => {
    const response = [
      'Thinking.',
      '',
      '<!--titus-prepare',
      'topic: empty-content',
      'keywords: [test]',
      '---',
      '-->',
    ].join('\n');

    _setReflectionInvoker(async () => response);

    const result = await reflect(makeGatherResult({ hasAttentionItems: true }));

    expect(result.preparations).toEqual([]);
  });

  it('handles keywords without brackets', async () => {
    const response = [
      'Preparing.',
      '',
      '<!--titus-prepare',
      'topic: no-bracket-keywords',
      'keywords: alpha, beta, gamma',
      '---',
      'Content for keyword test.',
      '-->',
    ].join('\n');

    _setReflectionInvoker(async () => response);

    const result = await reflect(makeGatherResult({ hasAttentionItems: true }));

    expect(result.preparations).toEqual(['no-bracket-keywords']);

    const savedFile = join(tmpPrep, 'no-bracket-keywords.md');
    expect(existsSync(savedFile)).toBe(true);

    const content = readFileSync(savedFile, 'utf-8');
    expect(content).toContain('keywords: [alpha, beta, gamma]');
  });

  it('degrades gracefully when preparations module import fails', async () => {
    // We can test this indirectly by setting preparations dir to an invalid path
    // The dynamic import itself won't fail since the module exists,
    // but we can test the error path by making the directory unwritable
    const response = [
      'Preparing.',
      '',
      '<!--titus-prepare',
      'topic: will-fail',
      'keywords: [test]',
      '---',
      'This should fail gracefully.',
      '-->',
    ].join('\n');

    // Set to a path that can't be written to
    _setPreparationsDir('/dev/null/impossible-path');

    _setReflectionInvoker(async () => response);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw — degrades gracefully
    const result = await reflect(makeGatherResult({ hasAttentionItems: true }));

    // The directive was parsed successfully (topic returned)
    // but saving failed, so preparations list may be populated
    // because the topic extraction happens before save
    expect(result.preparations).toEqual(['will-fail']);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[reflection] failed to save preparations:'),
      expect.anything(),
    );

    errorSpy.mockRestore();
  });

  it('coexists with proactive message and writeback directives', async () => {
    const response = [
      'Reflection complete.',
      '',
      '<!--titus-proactive',
      'Hey Chris, the CI pipeline needs attention.',
      '-->',
      '',
      '<!--titus-prepare',
      'topic: ci-fix-options',
      'keywords: [ci, fix, pipeline]',
      '---',
      'Three options to fix CI:',
      '1. Retry flaky tests',
      '2. Increase timeout',
      '3. Fix the underlying race condition',
      '-->',
    ].join('\n');

    _setReflectionInvoker(async () => response);

    const result = await reflect(makeGatherResult({ hasAttentionItems: true }));

    expect(result.proactiveMessage).toBe('Hey Chris, the CI pipeline needs attention.');
    expect(result.preparations).toEqual(['ci-fix-options']);
    expect(result.response).not.toContain('<!--titus-proactive');
    expect(result.response).not.toContain('<!--titus-prepare');
    expect(result.response).toContain('Reflection complete.');
  });

  it('sets expiry to 3 days from creation', async () => {
    const response = [
      'Preparing.',
      '',
      '<!--titus-prepare',
      'topic: expiry-test',
      'keywords: [test]',
      '---',
      'Testing expiry dates.',
      '-->',
    ].join('\n');

    _setReflectionInvoker(async () => response);

    const beforeMs = Date.now();
    await reflect(makeGatherResult({ hasAttentionItems: true }));
    const afterMs = Date.now();

    const savedFile = join(tmpPrep, 'expiry-test.md');
    const content = readFileSync(savedFile, 'utf-8');

    // Extract the created and expires dates from the file
    const createdMatch = content.match(/created: (\S+)/);
    const expiresMatch = content.match(/expires: (\S+)/);

    expect(createdMatch).not.toBeNull();
    expect(expiresMatch).not.toBeNull();

    const created = new Date(createdMatch![1]).getTime();
    const expires = new Date(expiresMatch![1]).getTime();

    // Created should be within the test window
    expect(created).toBeGreaterThanOrEqual(beforeMs - 1000);
    expect(created).toBeLessThanOrEqual(afterMs + 1000);

    // Expires should be exactly 3 days after created
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    expect(expires - created).toBe(threeDaysMs);
  });
});
