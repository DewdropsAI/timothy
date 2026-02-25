import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  _setPreparationsDir,
  savePreparation,
  loadPreparation,
  listActivePreparations,
  matchPreparations,
  formatPreparationsContext,
  deletePreparation,
  type Preparation,
} from '../preparations.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'titus-test-preparations-'));

beforeAll(() => {
  _setPreparationsDir(tmpDir);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makePreparation(overrides: Partial<Preparation> = {}): Preparation {
  return {
    topic: 'router-refactoring',
    keywords: ['router', 'refactoring', 'cognitive', 'architecture'],
    content: 'The router refactoring separates routing from adapters.',
    createdAt: '2026-02-25T10:00:00.000Z',
    expiresAt: '2026-02-28T10:00:00.000Z',
    ...overrides,
  };
}

describe('savePreparation', () => {
  it('creates a file with correct frontmatter and content', async () => {
    const prep = makePreparation();
    const filePath = await savePreparation(prep);

    expect(filePath).toBe(join(tmpDir, 'router-refactoring.md'));
    expect(existsSync(filePath)).toBe(true);

    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).toContain('---');
    expect(raw).toContain('keywords: [router, refactoring, cognitive, architecture]');
    expect(raw).toContain('created: 2026-02-25T10:00:00.000Z');
    expect(raw).toContain('expires: 2026-02-28T10:00:00.000Z');
    expect(raw).toContain('The router refactoring separates routing from adapters.');
  });

  it('overwrites an existing preparation for the same topic', async () => {
    const prep1 = makePreparation({ content: 'Version 1' });
    await savePreparation(prep1);

    const prep2 = makePreparation({ content: 'Version 2' });
    await savePreparation(prep2);

    const loaded = await loadPreparation('router-refactoring');
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe('Version 2');
  });

  it('returns the file path', async () => {
    const prep = makePreparation({ topic: 'path-test' });
    const filePath = await savePreparation(prep);

    expect(filePath).toBe(join(tmpDir, 'path-test.md'));
  });
});

describe('loadPreparation', () => {
  it('loads a saved preparation correctly', async () => {
    const prep = makePreparation({ topic: 'load-test' });
    await savePreparation(prep);

    const loaded = await loadPreparation('load-test');
    expect(loaded).not.toBeNull();
    expect(loaded!.topic).toBe('load-test');
    expect(loaded!.keywords).toEqual(['router', 'refactoring', 'cognitive', 'architecture']);
    expect(loaded!.content).toBe('The router refactoring separates routing from adapters.');
    expect(loaded!.createdAt).toBe('2026-02-25T10:00:00.000Z');
    expect(loaded!.expiresAt).toBe('2026-02-28T10:00:00.000Z');
  });

  it('returns null for a non-existent topic', async () => {
    const loaded = await loadPreparation('nonexistent-topic');
    expect(loaded).toBeNull();
  });

  it('handles empty keywords', async () => {
    const prep = makePreparation({ topic: 'empty-keywords', keywords: [] });
    await savePreparation(prep);

    const loaded = await loadPreparation('empty-keywords');
    expect(loaded).not.toBeNull();
    expect(loaded!.keywords).toEqual([]);
  });
});

describe('listActivePreparations', () => {
  it('returns non-expired preparations', async () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString(); // +1 day
    const prep = makePreparation({
      topic: 'active-prep',
      expiresAt: futureDate,
    });
    await savePreparation(prep);

    const active = await listActivePreparations();
    const found = active.find((p) => p.topic === 'active-prep');
    expect(found).toBeDefined();
  });

  it('filters out and deletes expired preparations', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // -1 day
    const prep = makePreparation({
      topic: 'expired-prep',
      expiresAt: pastDate,
    });
    await savePreparation(prep);

    const active = await listActivePreparations();
    const found = active.find((p) => p.topic === 'expired-prep');
    expect(found).toBeUndefined();

    // File should be deleted
    const filePath = join(tmpDir, 'expired-prep.md');
    expect(existsSync(filePath)).toBe(false);
  });

  it('returns empty array when directory does not exist', async () => {
    const origDir = join(tmpdir(), 'nonexistent-prep-dir-' + Date.now());
    _setPreparationsDir(origDir);

    const active = await listActivePreparations();
    expect(active).toEqual([]);

    // Restore
    _setPreparationsDir(tmpDir);
  });
});

describe('matchPreparations', () => {
  const preps: Preparation[] = [
    makePreparation({
      topic: 'router-design',
      keywords: ['router', 'refactoring', 'cognitive', 'architecture'],
    }),
    makePreparation({
      topic: 'telegram-bot',
      keywords: ['telegram', 'bot', 'grammy', 'messaging'],
    }),
    makePreparation({
      topic: 'testing-strategy',
      keywords: ['testing', 'vitest', 'coverage', 'mocking'],
    }),
  ];

  it('returns preparations with 2+ keyword matches', () => {
    const result = matchPreparations('What about the router architecture?', preps);
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe('router-design');
  });

  it('returns empty array when fewer than 2 keywords match', () => {
    const result = matchPreparations('Tell me about the router', preps);
    // Only 'router' matches — need 2+
    expect(result).toEqual([]);
  });

  it('returns empty array when no keywords match', () => {
    const result = matchPreparations('What is the weather today?', preps);
    expect(result).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const result = matchPreparations('ROUTER ARCHITECTURE design', preps);
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe('router-design');
  });

  it('sorts by match count (best match first)', () => {
    const result = matchPreparations(
      'The router refactoring improves cognitive architecture significantly',
      preps,
    );
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe('router-design');
  });

  it('returns multiple matching preparations sorted by match count', () => {
    const result = matchPreparations(
      'testing the router refactoring with vitest coverage',
      preps,
    );
    // router-design: router + refactoring = 2 matches
    // testing-strategy: testing + vitest + coverage = 3 matches
    expect(result).toHaveLength(2);
    expect(result[0].topic).toBe('testing-strategy'); // 3 matches
    expect(result[1].topic).toBe('router-design');    // 2 matches
  });

  it('returns empty array for empty preparations list', () => {
    const result = matchPreparations('router architecture', []);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty message', () => {
    const result = matchPreparations('', preps);
    expect(result).toEqual([]);
  });
});

describe('formatPreparationsContext', () => {
  it('returns empty string for empty array', () => {
    const result = formatPreparationsContext([]);
    expect(result).toBe('');
  });

  it('formats a single preparation', () => {
    const preps = [makePreparation({ topic: 'my-topic', content: 'Some prepared content.' })];
    const result = formatPreparationsContext(preps);

    expect(result).toContain('### Preparations (silent context)');
    expect(result).toContain('do not mention that you "prepared" these');
    expect(result).toContain('#### my-topic');
    expect(result).toContain('Some prepared content.');
  });

  it('formats multiple preparations', () => {
    const preps = [
      makePreparation({ topic: 'topic-a', content: 'Content A' }),
      makePreparation({ topic: 'topic-b', content: 'Content B' }),
    ];
    const result = formatPreparationsContext(preps);

    expect(result).toContain('#### topic-a');
    expect(result).toContain('Content A');
    expect(result).toContain('#### topic-b');
    expect(result).toContain('Content B');
  });

  it('header appears exactly once even with multiple preparations', () => {
    const preps = [
      makePreparation({ topic: 'x', content: 'X' }),
      makePreparation({ topic: 'y', content: 'Y' }),
    ];
    const result = formatPreparationsContext(preps);

    const headerCount = result.split('### Preparations (silent context)').length - 1;
    expect(headerCount).toBe(1);
  });
});

describe('deletePreparation', () => {
  it('deletes an existing preparation and returns true', async () => {
    const prep = makePreparation({ topic: 'to-delete' });
    await savePreparation(prep);

    const filePath = join(tmpDir, 'to-delete.md');
    expect(existsSync(filePath)).toBe(true);

    const result = await deletePreparation('to-delete');
    expect(result).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it('returns false for a non-existent preparation', async () => {
    const result = await deletePreparation('does-not-exist');
    expect(result).toBe(false);
  });

  it('deleted preparation cannot be loaded', async () => {
    const prep = makePreparation({ topic: 'delete-then-load' });
    await savePreparation(prep);

    await deletePreparation('delete-then-load');

    const loaded = await loadPreparation('delete-then-load');
    expect(loaded).toBeNull();
  });
});
