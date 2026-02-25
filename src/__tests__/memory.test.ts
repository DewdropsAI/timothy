import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureMemoryDirs,
  getMemoryPath,
  loadMemoryFile,
  saveMemoryFile,
  extractFacts,
  summarizeHistory,
  loadIdentity,
  _setMemoryDir,
  _setWorkingMemoryDir,
  parseMemoryFile,
  serializeMemoryFile,
  validateFrontmatter,
  assembleContext,
  DEFAULT_RECENT_TURNS,
  loadUserProfile,
  saveUserProfile,
  shouldSummarize,
  loadSummary,
  saveSummary,
  performSummarization,
  extractMemories,
  saveExtractedFact,
  isDuplicateFact,
  runExtractionPipeline,
  estimateTokens,
  buildMemoryContext,
  TOKEN_BUDGET,
  BUDGET_WARNING_THRESHOLD,
  loadFactFiles,
  loadTopicFiles,
  MEMORY_INSTRUCTIONS,
  _setLlmInvoker,
} from '../memory.js';
import type { MemoryFrontmatter } from '../memory.js';

describe('memory directory structure (FEAT-014-US-004)', () => {
  const tmpDir = join(tmpdir(), 'titus-test-memory-dirs');

  beforeEach(() => {
    _setMemoryDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ensureMemoryDirs creates all 4 subdirectories', () => {
    ensureMemoryDirs();

    expect(existsSync(join(tmpDir, 'sessions'))).toBe(true);
    expect(existsSync(join(tmpDir, 'identity'))).toBe(true);
    expect(existsSync(join(tmpDir, 'facts'))).toBe(true);
    expect(existsSync(join(tmpDir, 'topics'))).toBe(true);
  });

  it('ensureMemoryDirs is idempotent — no error when dirs exist', () => {
    ensureMemoryDirs();
    expect(() => ensureMemoryDirs()).not.toThrow();
  });

  it('ensureMemoryDirs completes partial structure (only sessions/ exists)', () => {
    mkdirSync(join(tmpDir, 'sessions'), { recursive: true });

    ensureMemoryDirs();

    expect(existsSync(join(tmpDir, 'sessions'))).toBe(true);
    expect(existsSync(join(tmpDir, 'identity'))).toBe(true);
    expect(existsSync(join(tmpDir, 'facts'))).toBe(true);
    expect(existsSync(join(tmpDir, 'topics'))).toBe(true);
  });

  it('ensureMemoryDirs returns resolved paths object', () => {
    const paths = ensureMemoryDirs();

    expect(paths.sessions).toBe(join(tmpDir, 'sessions'));
    expect(paths.identity).toBe(join(tmpDir, 'identity'));
    expect(paths.facts).toBe(join(tmpDir, 'facts'));
    expect(paths.topics).toBe(join(tmpDir, 'topics'));
  });

  it('getMemoryPath returns the memory directory path', () => {
    expect(getMemoryPath()).toBe(tmpDir);
  });
});

describe('core memory module (FEAT-015-US-009)', () => {
  const tmpDir = join(tmpdir(), 'titus-test-memory-core');

  beforeEach(() => {
    _setMemoryDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadMemoryFile returns content when file exists', async () => {
    writeFileSync(join(tmpDir, 'test.md'), 'hello world');

    const content = await loadMemoryFile('test.md');
    expect(content).toBe('hello world');
  });

  it('loadMemoryFile returns null when file is missing', async () => {
    const content = await loadMemoryFile('nonexistent.md');
    expect(content).toBeNull();
  });

  it('loadMemoryFile returns null when memory dir does not exist', async () => {
    rmSync(tmpDir, { recursive: true, force: true });

    const content = await loadMemoryFile('anything.md');
    expect(content).toBeNull();
  });

  it('saveMemoryFile writes content atomically (no .tmp left)', async () => {
    await saveMemoryFile('test.md', 'saved content');

    expect(existsSync(join(tmpDir, 'test.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'test.md.tmp'))).toBe(false);
  });

  it('saveMemoryFile content is correct after save', async () => {
    await saveMemoryFile('test.md', 'expected content');

    const content = readFileSync(join(tmpDir, 'test.md'), 'utf-8');
    expect(content).toBe('expected content');
  });

  it('saveMemoryFile creates parent directories', async () => {
    await saveMemoryFile('nested/dir/file.md', 'nested content');

    const content = readFileSync(join(tmpDir, 'nested', 'dir', 'file.md'), 'utf-8');
    expect(content).toBe('nested content');
  });

  it('extractFacts extracts from last exchange in history', async () => {
    const facts = await extractFacts([
      { role: 'user', content: 'My name is Chris' },
      { role: 'assistant', content: 'Nice to meet you, Chris!' },
    ]);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].category).toBe('fact');
  });

  it('summarizeHistory formats short history', async () => {
    const history = [
      { role: 'user' as const, content: 'Hi' },
      { role: 'assistant' as const, content: 'Hello!' },
    ];

    const summary = await summarizeHistory(history);
    expect(summary).toContain('Human: Hi');
    expect(summary).toContain('Assistant: Hello!');
  });

  it('summarizeHistory handles longer history with compressed format', async () => {
    _setLlmInvoker(async () => null); // force template fallback
    const history = [
      { role: 'user' as const, content: 'First' },
      { role: 'assistant' as const, content: 'Response 1' },
      { role: 'user' as const, content: 'Second' },
      { role: 'assistant' as const, content: 'Response 2' },
    ];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const summary = await summarizeHistory(history);
    expect(summary).toContain('First');
    expect(summary).toContain('Response 2');
    expect(summary).toContain('4 turns');
    warnSpy.mockRestore();
    _setLlmInvoker(null);
  });
});

describe('identity layer (FEAT-015-US-004)', () => {
  const tmpDir = join(tmpdir(), 'titus-test-memory-identity');

  beforeEach(() => {
    _setMemoryDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadIdentity returns content when identity.md exists', async () => {
    const identityContent = '## Self-Knowledge\n\nI am Titus.';
    writeFileSync(join(tmpDir, 'identity.md'), identityContent);

    const result = await loadIdentity();
    expect(result).toBe(identityContent);
  });

  it('loadIdentity returns null when identity.md is missing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await loadIdentity();
    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('identity.md not found'),
    );

    logSpy.mockRestore();
  });
});

// --- FEAT-014-US-005: YAML frontmatter ---

describe('YAML frontmatter (FEAT-014-US-005)', () => {
  it('parseMemoryFile parses valid frontmatter + body', () => {
    const content = [
      '---',
      'created: 2026-02-17T00:00:00Z',
      'updated: 2026-02-17T00:00:00Z',
      'version: 1',
      'type: fact',
      'tags: [memory, test]',
      '---',
      '',
      'Body content here.',
    ].join('\n');

    const result = parseMemoryFile(content);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.created).toBe('2026-02-17T00:00:00Z');
    expect(result.frontmatter!.updated).toBe('2026-02-17T00:00:00Z');
    expect(result.frontmatter!.version).toBe(1);
    expect(result.frontmatter!.type).toBe('fact');
    expect(result.frontmatter!.tags).toEqual(['memory', 'test']);
    expect(result.body).toBe('Body content here.');
  });

  it('parseMemoryFile returns null frontmatter for content without ---', () => {
    const content = 'Just a plain body with no frontmatter.';
    const result = parseMemoryFile(content);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe(content);
  });

  it('parseMemoryFile gracefully handles malformed YAML (unclosed block)', () => {
    const content = '---\ncreated: 2026-02-17\nno closing delimiter';
    const result = parseMemoryFile(content);
    // Should NOT throw — returns null frontmatter and treats whole content as body
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe(content);
  });

  it('serializeMemoryFile produces valid format', () => {
    const fm: MemoryFrontmatter = {
      created: '2026-02-17T00:00:00Z',
      updated: '2026-02-17T00:00:00Z',
      version: 1,
      type: 'fact',
      tags: ['memory', 'test'],
    };

    const serialized = serializeMemoryFile(fm, 'Body content.');
    expect(serialized).toContain('---');
    expect(serialized).toContain('created: 2026-02-17T00:00:00Z');
    expect(serialized).toContain('tags: [memory, test]');
    expect(serialized).toContain('Body content.');
  });

  it('serializeMemoryFile round-trip: serialize then parse returns same data', () => {
    const fm: MemoryFrontmatter = {
      created: '2026-02-17T00:00:00Z',
      updated: '2026-02-17T12:00:00Z',
      version: 3,
      type: 'topic',
      tags: ['round', 'trip'],
    };
    const body = 'Round-trip body.';

    const serialized = serializeMemoryFile(fm, body);
    const parsed = parseMemoryFile(serialized);

    expect(parsed.frontmatter).not.toBeNull();
    expect(parsed.frontmatter!.created).toBe(fm.created);
    expect(parsed.frontmatter!.updated).toBe(fm.updated);
    expect(parsed.frontmatter!.version).toBe(fm.version);
    expect(parsed.frontmatter!.type).toBe(fm.type);
    expect(parsed.frontmatter!.tags).toEqual(fm.tags);
    expect(parsed.body).toBe(body);
  });

  it('validateFrontmatter throws listing missing required fields', () => {
    expect(() => validateFrontmatter({})).toThrow(/created.*updated.*version.*type.*tags/);
  });

  it('validateFrontmatter passes with all required fields', () => {
    const fm: MemoryFrontmatter = {
      created: '2026-02-17T00:00:00Z',
      updated: '2026-02-17T00:00:00Z',
      version: 1,
      type: 'fact',
      tags: [],
    };
    expect(() => validateFrontmatter(fm)).not.toThrow();
  });

  it('serializeMemoryFile handles empty tags array', () => {
    const fm: MemoryFrontmatter = {
      created: '2026-02-17T00:00:00Z',
      updated: '2026-02-17T00:00:00Z',
      version: 1,
      type: 'identity',
      tags: [],
    };
    const serialized = serializeMemoryFile(fm, 'content');
    expect(serialized).toContain('tags: []');

    const parsed = parseMemoryFile(serialized);
    expect(parsed.frontmatter!.tags).toEqual([]);
  });
});

// --- FEAT-014-US-003: Context partitioning ---

describe('context partitioning (FEAT-014-US-003)', () => {
  function makeTurns(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));
  }

  it('assembleContext — 15 turns with K=10 gives 10 recent, 5 older', () => {
    const history = makeTurns(15);
    const result = assembleContext(history, { recentTurnThreshold: 10 });

    expect(result.recentTurns).toHaveLength(10);
    expect(result.olderTurns).toHaveLength(5);
    expect(result.summarizedCount).toBe(5);
    expect(result.recentTurns[0].content).toBe('message 5');
  });

  it('assembleContext — exactly K turns gives all recent, 0 older', () => {
    const history = makeTurns(10);
    const result = assembleContext(history, { recentTurnThreshold: 10 });

    expect(result.recentTurns).toHaveLength(10);
    expect(result.olderTurns).toHaveLength(0);
    expect(result.summarizedCount).toBe(0);
  });

  it('assembleContext — 0 turns gives empty arrays', () => {
    const result = assembleContext([]);

    expect(result.recentTurns).toHaveLength(0);
    expect(result.olderTurns).toHaveLength(0);
    expect(result.summarizedCount).toBe(0);
  });

  it('assembleContext — K > history.length gives all recent', () => {
    const history = makeTurns(3);
    const result = assembleContext(history, { recentTurnThreshold: 20 });

    expect(result.recentTurns).toHaveLength(3);
    expect(result.olderTurns).toHaveLength(0);
    expect(result.summarizedCount).toBe(0);
  });

  it('assembleContext — K=0 gives all in older', () => {
    const history = makeTurns(5);
    const result = assembleContext(history, { recentTurnThreshold: 0 });

    expect(result.recentTurns).toHaveLength(0);
    expect(result.olderTurns).toHaveLength(5);
    expect(result.summarizedCount).toBe(5);
  });

  it('DEFAULT_RECENT_TURNS is 10', () => {
    expect(DEFAULT_RECENT_TURNS).toBe(10);
  });
});

// --- FEAT-015-US-005: User profile persistence ---

describe('user profile persistence (FEAT-015-US-005)', () => {
  const tmpDir = join(tmpdir(), 'titus-test-memory-profile');

  beforeEach(() => {
    _setMemoryDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadUserProfile returns content when file exists', async () => {
    writeFileSync(join(tmpDir, 'user-profile.md'), 'Name: Chris');

    const result = await loadUserProfile();
    expect(result).toBe('Name: Chris');
  });

  it('loadUserProfile returns null when missing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await loadUserProfile();
    expect(result).toBeNull();

    logSpy.mockRestore();
  });

  it('saveUserProfile writes content to user-profile.md', async () => {
    await saveUserProfile('Name: Chris\nPreferences: dark mode');

    const content = readFileSync(join(tmpDir, 'user-profile.md'), 'utf-8');
    expect(content).toBe('Name: Chris\nPreferences: dark mode');
  });
});

// --- FEAT-014-US-001: Rolling conversation summarization ---

describe('rolling conversation summarization (FEAT-014-US-001)', () => {
  const tmpDir = join(tmpdir(), 'titus-test-memory-summarization');

  beforeEach(() => {
    _setMemoryDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(join(tmpDir, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTurns(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));
  }

  it('shouldSummarize returns true when history > threshold', () => {
    const history = makeTurns(15);
    expect(shouldSummarize(123, history)).toBe(true);
  });

  it('shouldSummarize returns false when history <= threshold', () => {
    const history = makeTurns(10);
    expect(shouldSummarize(123, history)).toBe(false);
  });

  it('shouldSummarize respects custom threshold', () => {
    expect(shouldSummarize(123, makeTurns(6), 5)).toBe(true);
    expect(shouldSummarize(123, makeTurns(5), 5)).toBe(false);
  });

  it('loadSummary returns content when summary file exists', async () => {
    writeFileSync(join(tmpDir, 'sessions', '123-summary.md'), 'Previous summary');

    const result = await loadSummary(123);
    expect(result).toBe('Previous summary');
  });

  it('loadSummary returns null when missing', async () => {
    const result = await loadSummary(999);
    expect(result).toBeNull();
  });

  it('saveSummary writes to correct path', async () => {
    await saveSummary(456, 'Summary content');

    const content = readFileSync(join(tmpDir, 'sessions', '456-summary.md'), 'utf-8');
    expect(content).toBe('Summary content');
  });

  it('performSummarization creates summary file for long history', async () => {
    _setLlmInvoker(async () => null); // force template fallback
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const history = makeTurns(15);
    await performSummarization(123, history, 10);

    const summary = await loadSummary(123);
    expect(summary).not.toBeNull();
    expect(summary).toContain('5 turns');
    warnSpy.mockRestore();
    _setLlmInvoker(null);
  });

  it('performSummarization merges with existing summary', async () => {
    _setLlmInvoker(async () => null); // force template fallback
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(join(tmpDir, 'sessions', '123-summary.md'), 'Old summary');

    const history = makeTurns(15);
    await performSummarization(123, history, 10);

    const summary = await loadSummary(123);
    expect(summary).toContain('Old summary');
    expect(summary).toContain('5 turns');
    warnSpy.mockRestore();
    _setLlmInvoker(null);
  });

  it('summarizeHistory short history (< 3 turns) returns formatted as-is', async () => {
    const history = [
      { role: 'user' as const, content: 'Hi' },
      { role: 'assistant' as const, content: 'Hello!' },
    ];

    const summary = await summarizeHistory(history);
    expect(summary).toContain('Human: Hi');
    expect(summary).toContain('Assistant: Hello!');
    expect(summary).not.toContain('turns compressed');
  });

  it('summarizeHistory longer history produces compressed summary', async () => {
    _setLlmInvoker(async () => null); // force template fallback
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const history = [
      { role: 'user' as const, content: 'First msg' },
      { role: 'assistant' as const, content: 'Reply 1' },
      { role: 'user' as const, content: 'Second msg' },
      { role: 'assistant' as const, content: 'Reply 2' },
    ];

    const summary = await summarizeHistory(history);
    expect(summary).toContain('Conversation Summary');
    expect(summary).toContain('4 turns');
    expect(summary).toContain('First msg');
    expect(summary).toContain('Reply 2');
    warnSpy.mockRestore();
    _setLlmInvoker(null);
  });
});

// --- FEAT-015-US-006: Memory extraction pipeline ---

describe('memory extraction pipeline (FEAT-015-US-006)', () => {
  const tmpDir = join(tmpdir(), 'titus-test-memory-extraction');

  beforeEach(() => {
    _setMemoryDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(join(tmpDir, 'facts'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extractMemories extracts preference from "I prefer TypeScript"', () => {
    const results = extractMemories('I prefer TypeScript over JavaScript', 'Good choice!');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.category === 'preference')).toBe(true);
  });

  it('extractMemories extracts fact from "my name is Chris"', () => {
    const results = extractMemories('my name is Chris', 'Nice to meet you!');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.category === 'fact')).toBe(true);
    expect(results.some((r) => r.content.includes('Chris'))).toBe(true);
  });

  it('extractMemories extracts decision from "let\'s go with REST"', () => {
    const results = extractMemories("let's go with REST for the API", 'Sounds good!');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.category === 'decision')).toBe(true);
  });

  it('extractMemories returns empty for trivial "hey" / "hi" exchange', () => {
    const results = extractMemories('hey', 'hi');
    expect(results).toEqual([]);
  });

  it('saveExtractedFact creates file with YAML frontmatter in facts/ dir', async () => {
    const filePath = await saveExtractedFact({ content: 'User prefers dark mode', category: 'preference' });
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain('type: fact');
    expect(content).toContain('tags: [preference]');
    expect(content).toContain('User prefers dark mode');
  });

  it('isDuplicateFact returns true for duplicate, false for new', () => {
    const existing = ['User prefers dark mode', 'User likes TypeScript'];
    expect(isDuplicateFact('user prefers dark mode', existing)).toBe(true);
    expect(isDuplicateFact('User lives in New York', existing)).toBe(false);
  });

  it('isDuplicateFact does not false-positive on short shared substrings', () => {
    const existing = ['Chris likes coffee', 'meeting at 3'];
    // Unrelated facts sharing a word should NOT be flagged
    expect(isDuplicateFact('coffee ice cream recipe', existing)).toBe(false);
    expect(isDuplicateFact('meeting at 3pm tomorrow with the team', existing)).toBe(false);
  });

  it('isDuplicateFact catches true near-duplicates', () => {
    const existing = ['User prefers dark mode'];
    // Slight superset/subset with >80% length overlap should still match
    expect(isDuplicateFact('User prefers dark mode!', existing)).toBe(true);
    // "prefers dark mode" (17) vs "User prefers dark mode" (22) → 17/22 ≈ 0.77 → NOT duplicate
    expect(isDuplicateFact('prefers dark mode', existing)).toBe(false);
    // Exact case-insensitive match is still caught
    expect(isDuplicateFact('user prefers dark mode', existing)).toBe(true);
  });

  it('runExtractionPipeline saves extracted facts to disk (end-to-end)', async () => {
    const result = await runExtractionPipeline(123, 'I prefer using Vim for editing', 'Noted!');

    expect(result.extracted).toBeGreaterThan(0);
    expect(result.saved.length).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();

    const facts = await loadFactFiles();
    expect(facts.length).toBeGreaterThan(0);
  });

  it('runExtractionPipeline handles errors gracefully (no throw)', async () => {
    // Set memoryDir to a path that will cause issues for reading
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Even with unusual input, should not throw — returns a result object
    const result = await runExtractionPipeline(123, 'I prefer TypeScript for everything', 'Great choice!');
    expect(result).toHaveProperty('extracted');
    expect(result).toHaveProperty('duplicates');
    expect(result).toHaveProperty('saved');

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// --- FEAT-014-US-002: Context budget management ---

describe('context budget management (FEAT-014-US-002)', () => {
  const tmpDir = join(tmpdir(), 'titus-test-memory-budget');
  const tmpWmDir = join(tmpdir(), 'titus-test-memory-budget-wm');

  beforeEach(() => {
    _setMemoryDir(tmpDir);
    _setWorkingMemoryDir(tmpWmDir);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpWmDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpWmDir, { recursive: true, force: true });
  });

  it('estimateTokens returns reasonable estimate', () => {
    const estimate = estimateTokens('hello world');
    expect(estimate).toBeGreaterThan(0);
    // "hello world" is 11 chars, 11/3 = 3.67, ceil = 4
    expect(estimate).toBe(4);
  });

  it('buildMemoryContext returns empty context and 0 tokens when no memory files', async () => {
    const result = await buildMemoryContext(999);
    expect(result.context).toBe('');
    expect(result.tokens).toBe(0);
  });

  it('buildMemoryContext returns tokens count', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    writeFileSync(join(tmpDir, 'identity.md'), 'I am Titus.');

    const result = await buildMemoryContext(123);
    expect(result.tokens).toBeGreaterThan(0);

    logSpy.mockRestore();
  });

  it('buildMemoryContext wraps sections in ## Memory parent with ### subsections', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    writeFileSync(join(tmpDir, 'identity.md'), 'I am Titus.');
    writeFileSync(join(tmpDir, 'user-profile.md'), 'Name: Chris');

    const result = await buildMemoryContext(123);
    expect(result.context).toContain('## Memory');
    expect(result.context).toContain('The following is your persisted memory from past conversations.');
    expect(result.context).toContain('### Identity');
    expect(result.context).toContain('I am Titus.');
    expect(result.context).toContain('### User Profile');
    expect(result.context).toContain('Name: Chris');
    // Should NOT have ## Identity (should be ### now)
    expect(result.context).not.toMatch(/^## Identity/m);
    expect(result.context).not.toMatch(/^## User Profile/m);

    logSpy.mockRestore();
  });

  it('buildMemoryContext includes facts when budget permits', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mkdirSync(join(tmpDir, 'facts'), { recursive: true });
    const fm: MemoryFrontmatter = {
      created: '2026-02-17T00:00:00Z',
      updated: '2026-02-17T00:00:00Z',
      version: 1,
      type: 'fact',
      tags: ['preference'],
    };
    writeFileSync(
      join(tmpDir, 'facts', 'user-prefers-typescript.md'),
      serializeMemoryFile(fm, 'User prefers TypeScript'),
    );

    const result = await buildMemoryContext(123);
    expect(result.context).toContain('### Known Facts');
    expect(result.context).toContain('User prefers TypeScript');

    logSpy.mockRestore();
  });

  it('buildMemoryContext drops conditional items when over budget', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Create a large identity file that fills the budget
    const largeContent = 'X'.repeat(TOKEN_BUDGET * 4);
    writeFileSync(join(tmpDir, 'identity.md'), largeContent);

    mkdirSync(join(tmpDir, 'facts'), { recursive: true });
    const fm: MemoryFrontmatter = {
      created: '2026-02-17T00:00:00Z',
      updated: '2026-02-17T00:00:00Z',
      version: 1,
      type: 'fact',
      tags: [],
    };
    writeFileSync(
      join(tmpDir, 'facts', 'test-fact.md'),
      serializeMemoryFile(fm, 'This fact should be dropped'),
    );

    const result = await buildMemoryContext(123);
    // Identity is always-load, so it must be present
    expect(result.context).toContain('### Identity');
    // Facts should be dropped because budget is exhausted
    expect(result.context).not.toContain('This fact should be dropped');

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('buildMemoryContext always-load tier is never dropped', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeFileSync(join(tmpDir, 'identity.md'), 'I am Titus - always present.');
    writeFileSync(join(tmpDir, 'user-profile.md'), 'Name: Chris - always present.');
    mkdirSync(join(tmpDir, 'sessions'), { recursive: true });
    writeFileSync(join(tmpDir, 'sessions', '123-summary.md'), 'Summary - always present.');

    const result = await buildMemoryContext(123);
    expect(result.context).toContain('I am Titus - always present.');
    expect(result.context).toContain('Name: Chris - always present.');
    expect(result.context).toContain('Summary - always present.');

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// --- Integration tests: extraction + budget ---

describe('memory integration tests', () => {
  const tmpDir = join(tmpdir(), 'titus-test-memory-integration');
  const tmpWmDir = join(tmpdir(), 'titus-test-memory-integration-wm');

  beforeEach(() => {
    _setMemoryDir(tmpDir);
    _setWorkingMemoryDir(tmpWmDir);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpWmDir, { recursive: true, force: true });
    mkdirSync(join(tmpDir, 'facts'), { recursive: true });
    mkdirSync(join(tmpDir, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpWmDir, { recursive: true, force: true });
  });

  it('extraction + save + load round trip', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Extract
    const memories = extractMemories('I prefer Vim for editing code', 'Noted!');
    expect(memories.length).toBeGreaterThan(0);

    // Save
    const savedPath = await saveExtractedFact(memories[0]);
    expect(existsSync(savedPath)).toBe(true);

    // Load
    const facts = await loadFactFiles();
    expect(facts.length).toBe(1);
    const parsed = parseMemoryFile(facts[0].content);
    expect(parsed.body).toBe(memories[0].content);

    logSpy.mockRestore();
  });

  it('saved facts appear in buildMemoryContext output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Save a fact
    await saveExtractedFact({ content: 'User enjoys hiking', category: 'fact' });

    // Build context
    const { context } = await buildMemoryContext(123);
    expect(context).toContain('User enjoys hiking');

    logSpy.mockRestore();
  });
});

// --- FEAT-015-US-010: Memory usage instructions ---

describe('memory usage instructions (FEAT-015-US-010)', () => {
  const tmpDir = join(tmpdir(), 'titus-test-memory-instructions');
  const tmpWmDir = join(tmpdir(), 'titus-test-memory-instructions-wm');

  beforeEach(() => {
    _setMemoryDir(tmpDir);
    _setWorkingMemoryDir(tmpWmDir);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpWmDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpWmDir, { recursive: true, force: true });
  });

  it('MEMORY_INSTRUCTIONS is under 500 tokens', () => {
    const tokens = estimateTokens(MEMORY_INSTRUCTIONS);
    expect(tokens).toBeLessThan(500);
  });

  it('MEMORY_INSTRUCTIONS is included when memory content exists', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    writeFileSync(join(tmpDir, 'identity.md'), 'I am Titus.');

    const { context } = await buildMemoryContext(123);
    expect(context).toContain(MEMORY_INSTRUCTIONS);

    logSpy.mockRestore();
  });

  it('MEMORY_INSTRUCTIONS is NOT included when no memory files exist', async () => {
    const { context } = await buildMemoryContext(999);
    expect(context).toBe('');
    expect(context).not.toContain(MEMORY_INSTRUCTIONS);
  });
});
