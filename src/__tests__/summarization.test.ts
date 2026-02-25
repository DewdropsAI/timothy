import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  summarizeHistory,
  templateSummary,
  mergeSummaries,
  invokeLlm,
  performSummarization,
  loadSummary,
  _setMemoryDir,
  _setLlmInvoker,
} from '../memory.js';
import {
  addMessage,
  getHistory,
  clearHistory,
  replaceHistory,
  _setSessionsDir,
  type Message,
} from '../session.js';

// --- replaceHistory ---

describe('replaceHistory', () => {
  const tmpDir = join(tmpdir(), 'titus-test-replace-history');

  beforeEach(() => {
    _setSessionsDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    clearHistory(42);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces in-memory history with given messages', () => {
    addMessage(42, { role: 'user', content: 'old message 1' });
    addMessage(42, { role: 'assistant', content: 'old response 1' });
    addMessage(42, { role: 'user', content: 'old message 2' });

    const newHistory: Message[] = [
      { role: 'user', content: 'recent only' },
      { role: 'assistant', content: 'recent response' },
    ];

    replaceHistory(42, newHistory);

    expect(getHistory(42)).toEqual(newHistory);
    expect(getHistory(42)).toHaveLength(2);
  });

  it('persists replaced history to disk', () => {
    addMessage(42, { role: 'user', content: 'old' });

    replaceHistory(42, [{ role: 'user', content: 'new' }]);

    const diskContent = readFileSync(join(tmpDir, '42.json'), 'utf-8');
    const parsed = JSON.parse(diskContent);
    expect(parsed).toEqual([{ role: 'user', content: 'new' }]);
  });

  it('replaces with empty array to clear history', () => {
    addMessage(42, { role: 'user', content: 'something' });

    replaceHistory(42, []);

    expect(getHistory(42)).toEqual([]);
  });

  it('does not affect other chat IDs', () => {
    addMessage(42, { role: 'user', content: 'chat 42' });
    addMessage(99, { role: 'user', content: 'chat 99' });

    replaceHistory(42, [{ role: 'user', content: 'replaced' }]);

    expect(getHistory(42)).toEqual([{ role: 'user', content: 'replaced' }]);
    expect(getHistory(99)).toEqual([{ role: 'user', content: 'chat 99' }]);

    clearHistory(99);
  });
});

// --- templateSummary ---

describe('templateSummary', () => {
  it('produces a template summary with turn count', () => {
    const history: Message[] = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Follow-up' },
      { role: 'assistant', content: 'Another answer' },
    ];

    const result = templateSummary(history);

    expect(result).toContain('Conversation Summary (4 turns)');
    expect(result).toContain('First question');
    expect(result).toContain('Another answer');
    expect(result).toContain('4 turns compressed');
  });
});

// --- summarizeHistory ---

describe('summarizeHistory', () => {
  afterEach(() => {
    _setLlmInvoker(null); // restore default
  });

  it('returns formatted as-is for short history (< 3 turns)', async () => {
    const history: Message[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ];

    const result = await summarizeHistory(history);

    expect(result).toContain('Human: Hi');
    expect(result).toContain('Assistant: Hello!');
  });

  it('returns LLM result when invokeLlm succeeds', async () => {
    _setLlmInvoker(async () => 'The user and Titus discussed project architecture.');

    const history: Message[] = [
      { role: 'user', content: 'What tech stack?' },
      { role: 'assistant', content: 'I suggest TypeScript.' },
      { role: 'user', content: 'Sounds good.' },
      { role: 'assistant', content: 'Great, let us proceed.' },
    ];

    const result = await summarizeHistory(history);

    expect(result).toBe('The user and Titus discussed project architecture.');
  });

  it('falls back to template when invokeLlm returns null', async () => {
    _setLlmInvoker(async () => null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const history: Message[] = [
      { role: 'user', content: 'First msg' },
      { role: 'assistant', content: 'Reply 1' },
      { role: 'user', content: 'Second msg' },
      { role: 'assistant', content: 'Reply 2' },
    ];

    const result = await summarizeHistory(history);

    expect(result).toContain('Conversation Summary');
    expect(result).toContain('4 turns');
    expect(result).toContain('First msg');
    expect(result).toContain('Reply 2');

    warnSpy.mockRestore();
  });

  it('passes conversation text to the LLM invoker', async () => {
    let capturedPrompt = '';
    _setLlmInvoker(async (prompt) => {
      capturedPrompt = prompt;
      return 'Summary result';
    });

    const history: Message[] = [
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'How are you?' },
    ];

    await summarizeHistory(history);

    expect(capturedPrompt).toContain('Human: Hello there');
    expect(capturedPrompt).toContain('Assistant: Hi!');
    expect(capturedPrompt).toContain('Human: How are you?');
    expect(capturedPrompt).toContain('Topics discussed');
  });
});

// --- mergeSummaries ---

describe('mergeSummaries', () => {
  afterEach(() => {
    _setLlmInvoker(null);
  });

  it('concatenates when combined tokens are below threshold', async () => {
    const existing = 'Earlier conversation about project setup.';
    const newer = 'Later discussion about deployment.';

    const result = await mergeSummaries(existing, newer);

    expect(result).toBe(`${existing}\n\n${newer}`);
  });

  it('does not invoke LLM for small summaries', async () => {
    let invoked = false;
    _setLlmInvoker(async () => {
      invoked = true;
      return 'Should not be called';
    });

    const existing = 'Short summary one.';
    const newer = 'Short summary two.';
    await mergeSummaries(existing, newer);

    expect(invoked).toBe(false);
  });

  it('uses LLM merge for large summaries when LLM succeeds', async () => {
    _setLlmInvoker(async () => 'Merged narrative covering both discussions.');

    const existing = 'A'.repeat(5000);
    const newer = 'B'.repeat(5000);

    const result = await mergeSummaries(existing, newer);

    expect(result).toBe('Merged narrative covering both discussions.');
  });

  it('falls back to concatenation when LLM fails for large summaries', async () => {
    _setLlmInvoker(async () => null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const existing = 'A'.repeat(5000);
    const newer = 'B'.repeat(5000);

    const result = await mergeSummaries(existing, newer);

    expect(result).toBe(`${existing}\n\n${newer}`);

    warnSpy.mockRestore();
  });

  it('passes both summaries to the LLM invoker', async () => {
    let capturedPrompt = '';
    _setLlmInvoker(async (prompt) => {
      capturedPrompt = prompt;
      return 'Merged result';
    });

    const existing = 'X'.repeat(5000);
    const newer = 'Y'.repeat(5000);

    await mergeSummaries(existing, newer);

    expect(capturedPrompt).toContain(existing);
    expect(capturedPrompt).toContain(newer);
    expect(capturedPrompt).toContain('Existing summary');
    expect(capturedPrompt).toContain('New summary to merge');
  });
});

// --- performSummarization ---

describe('performSummarization returns recentTurns', () => {
  const tmpDir = join(tmpdir(), 'titus-test-perf-summarization');

  beforeEach(() => {
    _setMemoryDir(tmpDir);
    _setLlmInvoker(async () => null); // default to template fallback in tests
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(join(tmpDir, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    _setLlmInvoker(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTurns(count: number): Message[] {
    return Array.from({ length: count }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));
  }

  it('returns recentTurns after summarization', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const history = makeTurns(15);
    const result = await performSummarization(123, history, 10);

    expect(result.recentTurns).toHaveLength(10);
    expect(result.recentTurns[0].content).toBe('message 5');

    warnSpy.mockRestore();
  });

  it('returns full history when nothing to summarize', async () => {
    const history = makeTurns(5);
    const result = await performSummarization(123, history, 10);

    expect(result.recentTurns).toHaveLength(5);
  });

  it('creates summary file on disk with template fallback', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const history = makeTurns(15);
    await performSummarization(123, history, 10);

    const summary = await loadSummary(123);
    expect(summary).not.toBeNull();
    expect(summary).toContain('5 turns');

    warnSpy.mockRestore();
  });

  it('saves LLM summary when available', async () => {
    _setLlmInvoker(async () => 'The conversation covered five exchanges about project setup.');

    const history = makeTurns(15);
    await performSummarization(123, history, 10);

    const summary = await loadSummary(123);
    expect(summary).toBe('The conversation covered five exchanges about project setup.');
  });

  it('merges with existing summary via concatenation for small summaries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeFileSync(join(tmpDir, 'sessions', '123-summary.md'), 'Old summary content');

    const history = makeTurns(15);
    await performSummarization(123, history, 10);

    const summary = await loadSummary(123);
    expect(summary).toContain('Old summary content');
    expect(summary).toContain('5 turns');

    warnSpy.mockRestore();
  });

  it('uses LLM-produced summary when merged with existing', async () => {
    _setLlmInvoker(async () => 'New summary from LLM.');

    writeFileSync(join(tmpDir, 'sessions', '123-summary.md'), 'Previous summary.');

    const history = makeTurns(15);
    await performSummarization(123, history, 10);

    const summary = await loadSummary(123);
    // Small combined size => concatenation (not LLM merge)
    expect(summary).toBe('Previous summary.\n\nNew summary from LLM.');
  });
});
