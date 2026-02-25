import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  _setMemoryDir,
  _setWorkingMemoryDir,
  buildMemoryContext,
  estimateTokens,
  TOKEN_BUDGET,
} from '../memory.js';
import {
  _setPreparationsDir,
  listActivePreparations,
  matchPreparations,
  formatPreparationsContext,
} from '../preparations.js';
import type { Preparation } from '../preparations.js';

function makePrepFile(opts: {
  keywords: string[];
  content: string;
  created?: string;
  expires?: string;
}): string {
  const created = opts.created ?? '2026-02-25T00:00:00Z';
  const expiresLine = opts.expires ? `expires: ${opts.expires}` : 'expires:';
  return [
    '---',
    `keywords: [${opts.keywords.join(', ')}]`,
    `created: ${created}`,
    expiresLine,
    '---',
    '',
    opts.content,
  ].join('\n');
}

describe('preparations module', () => {
  const tmpPrep = join(tmpdir(), 'titus-test-preparations-module');

  beforeEach(() => {
    rmSync(tmpPrep, { recursive: true, force: true });
    mkdirSync(tmpPrep, { recursive: true });
    _setPreparationsDir(tmpPrep);
  });

  afterEach(() => {
    rmSync(tmpPrep, { recursive: true, force: true });
  });

  it('listActivePreparations returns empty when dir does not exist', async () => {
    _setPreparationsDir(join(tmpdir(), 'nonexistent-preps'));
    const result = await listActivePreparations();
    expect(result).toEqual([]);
  });

  it('listActivePreparations returns empty when dir is empty', async () => {
    const result = await listActivePreparations();
    expect(result).toEqual([]);
  });

  it('listActivePreparations parses preparation files', async () => {
    writeFileSync(
      join(tmpPrep, 'project-status.md'),
      makePrepFile({
        keywords: ['project', 'status', 'progress'],
        content: 'The project is on track. Sprint 5 is 80% complete.',
      }),
    );

    const result = await listActivePreparations();
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe('project-status');
    expect(result[0].keywords).toEqual(['project', 'status', 'progress']);
    expect(result[0].content).toContain('Sprint 5 is 80% complete');
  });

  it('listActivePreparations filters expired preparations', async () => {
    writeFileSync(
      join(tmpPrep, 'expired-topic.md'),
      makePrepFile({
        keywords: ['expired', 'topic'],
        content: 'This is expired.',
        expires: '2020-01-01T00:00:00Z',
      }),
    );

    const result = await listActivePreparations();
    expect(result).toEqual([]);
  });

  it('listActivePreparations includes preparations without expiry', async () => {
    writeFileSync(
      join(tmpPrep, 'no-expiry.md'),
      makePrepFile({
        keywords: ['test', 'keyword'],
        content: 'No expiry set.',
      }),
    );

    const result = await listActivePreparations();
    expect(result).toHaveLength(1);
  });

  it('listActivePreparations includes future-expiry preparations', async () => {
    writeFileSync(
      join(tmpPrep, 'future-expiry.md'),
      makePrepFile({
        keywords: ['future', 'topic'],
        content: 'Not expired yet.',
        expires: '2099-12-31T23:59:59Z',
      }),
    );

    const result = await listActivePreparations();
    expect(result).toHaveLength(1);
  });

  it('listActivePreparations skips non-md files', async () => {
    writeFileSync(join(tmpPrep, 'readme.txt'), 'not a prep file');
    writeFileSync(
      join(tmpPrep, 'valid.md'),
      makePrepFile({
        keywords: ['test', 'keyword'],
        content: 'Valid prep.',
      }),
    );

    const result = await listActivePreparations();
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe('valid');
  });

  it('listActivePreparations skips files without valid frontmatter', async () => {
    writeFileSync(join(tmpPrep, 'invalid.md'), 'Just plain text, no frontmatter.');

    const result = await listActivePreparations();
    expect(result).toEqual([]);
  });
});

describe('matchPreparations', () => {
  const preps: Preparation[] = [
    {
      topic: 'router-refactoring',
      keywords: ['router', 'refactoring', 'architecture', 'adapter'],
      content: 'Router refactoring notes.',
      createdAt: '2026-02-25T00:00:00Z',
      expiresAt: '',
    },
    {
      topic: 'deployment-plan',
      keywords: ['deploy', 'production', 'release', 'staging'],
      content: 'Deployment plan details.',
      createdAt: '2026-02-25T00:00:00Z',
      expiresAt: '',
    },
    {
      topic: 'testing-strategy',
      keywords: ['testing', 'vitest', 'coverage', 'integration'],
      content: 'Testing strategy notes.',
      createdAt: '2026-02-25T00:00:00Z',
      expiresAt: '',
    },
  ];

  it('matches preparations with 2+ keyword hits', () => {
    const result = matchPreparations('How is the router refactoring going?', preps);
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe('router-refactoring');
  });

  it('returns empty when fewer than 2 keywords match', () => {
    const result = matchPreparations('Tell me about the router', preps);
    expect(result).toEqual([]);
  });

  it('returns empty for unrelated message', () => {
    const result = matchPreparations('What is the weather like today?', preps);
    expect(result).toEqual([]);
  });

  it('matches are case-insensitive', () => {
    const result = matchPreparations('ROUTER REFACTORING update please', preps);
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe('router-refactoring');
  });

  it('sorts by match count (most matches first)', () => {
    const result = matchPreparations(
      'The router architecture adapter refactoring is for integration testing',
      preps,
    );
    // router-refactoring has 4 matches, testing-strategy has 2
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].topic).toBe('router-refactoring');
  });

  it('can match multiple preparations', () => {
    const result = matchPreparations(
      'We need to deploy the router refactoring to production',
      preps,
    );
    expect(result).toHaveLength(2);
    const topics = result.map(p => p.topic);
    expect(topics).toContain('router-refactoring');
    expect(topics).toContain('deployment-plan');
  });
});

describe('formatPreparationsContext', () => {
  it('returns empty string for empty array', () => {
    expect(formatPreparationsContext([])).toBe('');
  });

  it('formats single preparation', () => {
    const preps: Preparation[] = [
      {
        topic: 'test-topic',
        keywords: ['test', 'keyword'],
        content: 'Prepared content here.',
        createdAt: '2026-02-25T00:00:00Z',
        expiresAt: '',
      },
    ];

    const result = formatPreparationsContext(preps);
    expect(result).toContain('### Preparations (silent context)');
    expect(result).toContain('do not mention that you "prepared"');
    expect(result).toContain('#### test-topic');
    expect(result).toContain('Prepared content here.');
  });

  it('formats multiple preparations', () => {
    const preps: Preparation[] = [
      {
        topic: 'first',
        keywords: ['a', 'b'],
        content: 'First content.',
        createdAt: '2026-02-25T00:00:00Z',
        expiresAt: '',
      },
      {
        topic: 'second',
        keywords: ['c', 'd'],
        content: 'Second content.',
        createdAt: '2026-02-25T00:00:00Z',
        expiresAt: '',
      },
    ];

    const result = formatPreparationsContext(preps);
    expect(result).toContain('#### first');
    expect(result).toContain('First content.');
    expect(result).toContain('#### second');
    expect(result).toContain('Second content.');
  });
});

describe('preparations in buildMemoryContext', () => {
  const tmpMem = join(tmpdir(), 'titus-test-prep-memory');
  const tmpWm = join(tmpdir(), 'titus-test-prep-wm');
  const tmpPrep = join(tmpdir(), 'titus-test-prep-ctx');

  beforeEach(() => {
    rmSync(tmpMem, { recursive: true, force: true });
    rmSync(tmpWm, { recursive: true, force: true });
    rmSync(tmpPrep, { recursive: true, force: true });
    mkdirSync(tmpMem, { recursive: true });
    mkdirSync(tmpWm, { recursive: true });
    mkdirSync(tmpPrep, { recursive: true });
    _setMemoryDir(tmpMem);
    _setWorkingMemoryDir(tmpWm);
    _setPreparationsDir(tmpPrep);
  });

  afterEach(() => {
    rmSync(tmpMem, { recursive: true, force: true });
    rmSync(tmpWm, { recursive: true, force: true });
    rmSync(tmpPrep, { recursive: true, force: true });
  });

  it('buildMemoryContext works without preparations dir (graceful degradation)', async () => {
    _setPreparationsDir(join(tmpdir(), 'nonexistent-prep-dir'));

    writeFileSync(join(tmpMem, 'identity.md'), 'I am Titus.');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { context, tokens } = await buildMemoryContext(123);
    expect(context).toContain('### Identity');
    expect(context).toContain('I am Titus.');
    expect(tokens).toBeGreaterThan(0);

    logSpy.mockRestore();
  });

  it('buildMemoryContext includes preparations when they exist (no userMessage = all preps)', async () => {
    writeFileSync(
      join(tmpPrep, 'meeting-notes.md'),
      makePrepFile({
        keywords: ['meeting', 'standup', 'sync'],
        content: 'The standup is at 9am. Key topics: deployment and testing.',
      }),
    );

    const { context } = await buildMemoryContext(123);
    expect(context).toContain('### Preparations (silent context)');
    expect(context).toContain('#### meeting-notes');
    expect(context).toContain('standup is at 9am');
  });

  it('buildMemoryContext filters preparations by userMessage keywords', async () => {
    writeFileSync(
      join(tmpPrep, 'router-status.md'),
      makePrepFile({
        keywords: ['router', 'refactoring', 'architecture'],
        content: 'Router refactoring is 60% complete.',
      }),
    );
    writeFileSync(
      join(tmpPrep, 'deploy-plan.md'),
      makePrepFile({
        keywords: ['deploy', 'production', 'release'],
        content: 'Deployment scheduled for Friday.',
      }),
    );

    // Message matches router keywords but not deploy keywords
    const { context } = await buildMemoryContext(123, 'How is the router refactoring going?');
    expect(context).toContain('Router refactoring is 60% complete.');
    expect(context).not.toContain('Deployment scheduled for Friday.');
  });

  it('buildMemoryContext includes no preparations when userMessage has no keyword matches', async () => {
    writeFileSync(
      join(tmpPrep, 'router-status.md'),
      makePrepFile({
        keywords: ['router', 'refactoring', 'architecture'],
        content: 'Router refactoring notes.',
      }),
    );

    const { context } = await buildMemoryContext(123, 'What is the weather like?');
    expect(context).not.toContain('### Preparations');
    expect(context).not.toContain('Router refactoring notes.');
  });

  it('token budget is respected when preparations are large', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Create identity that fills most of the budget
    const largeIdentity = 'X'.repeat(TOKEN_BUDGET * 3);
    writeFileSync(join(tmpMem, 'identity.md'), largeIdentity);

    // Create a preparation
    writeFileSync(
      join(tmpPrep, 'big-prep.md'),
      makePrepFile({
        keywords: ['test', 'keyword'],
        content: 'This preparation should be dropped due to budget.',
      }),
    );

    const { context } = await buildMemoryContext(123);
    // Identity is always-load, so it must be present
    expect(context).toContain('### Identity');
    // Preparation should be dropped because budget is exhausted
    expect(context).not.toContain('### Preparations');
    expect(context).not.toContain('This preparation should be dropped');

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('preparations appear after conversation summary and before facts', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Set up identity
    writeFileSync(join(tmpMem, 'identity.md'), 'I am Titus.');

    // Set up summary
    mkdirSync(join(tmpMem, 'sessions'), { recursive: true });
    writeFileSync(join(tmpMem, 'sessions', '123-summary.md'), 'Previous conversation summary.');

    // Set up preparation
    writeFileSync(
      join(tmpPrep, 'status-update.md'),
      makePrepFile({
        keywords: ['status', 'update'],
        content: 'Status update content.',
      }),
    );

    // Set up facts
    mkdirSync(join(tmpMem, 'facts'), { recursive: true });
    writeFileSync(
      join(tmpMem, 'facts', 'test-fact.md'),
      '---\ncreated: 2026-02-25T00:00:00Z\nupdated: 2026-02-25T00:00:00Z\nversion: 1\ntype: fact\ntags: []\n---\n\nA test fact.',
    );

    // No userMessage = include all preparations
    const { context } = await buildMemoryContext(123);

    const summaryIdx = context.indexOf('### Conversation Summary');
    const prepIdx = context.indexOf('### Preparations');
    const factsIdx = context.indexOf('### Known Facts');

    expect(summaryIdx).toBeGreaterThan(-1);
    expect(prepIdx).toBeGreaterThan(-1);
    expect(factsIdx).toBeGreaterThan(-1);
    expect(prepIdx).toBeGreaterThan(summaryIdx);
    expect(prepIdx).toBeLessThan(factsIdx);

    logSpy.mockRestore();
  });

  it('buildMemoryContext still returns empty when no memory or preparations exist', async () => {
    _setPreparationsDir(join(tmpdir(), 'nonexistent-prep-dir'));

    const { context, tokens } = await buildMemoryContext(999);
    expect(context).toBe('');
    expect(tokens).toBe(0);
  });

  it('expired preparations are not included in context', async () => {
    writeFileSync(
      join(tmpPrep, 'expired.md'),
      makePrepFile({
        keywords: ['test', 'expired'],
        content: 'This expired and should not appear.',
        expires: '2020-01-01T00:00:00Z',
      }),
    );

    const { context } = await buildMemoryContext(123);
    expect(context).not.toContain('This expired and should not appear.');
  });
});
