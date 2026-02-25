import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';

// Mock external modules that the CLI depends on
vi.mock('../claude.js', () => ({
  invokeClaude: vi.fn(),
}));

vi.mock('../workspace.js', () => ({
  ensureWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../memory.js', () => ({
  ensureMemoryDirs: vi.fn(),
  shouldSummarize: vi.fn().mockReturnValue(false),
  performSummarization: vi.fn().mockResolvedValue(undefined),
  runExtractionPipeline: vi.fn().mockResolvedValue({ extracted: 0, duplicates: 0, saved: [] }),
  buildMemoryContext: vi.fn().mockResolvedValue({ context: '', tokens: 0 }),
}));

import { invokeClaude } from '../claude.js';
import { addMessage, getHistory, clearHistory, loadSessions, _setSessionsDir, type ChatId } from '../session.js';

const mockedInvokeClaude = vi.mocked(invokeClaude);

const CLI_CHAT_ID: ChatId = 'cli-local';

describe('CLI session identity', () => {
  const tmpDir = join(tmpdir(), 'titus-test-cli-identity');

  beforeEach(() => {
    _setSessionsDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    clearHistory(CLI_CHAT_ID);
  });

  it('addMessage with cli-local creates cli-local.json on disk', () => {
    addMessage(CLI_CHAT_ID, { role: 'user', content: 'Hello from CLI' });

    const filePath = join(tmpDir, 'cli-local.json');
    expect(existsSync(filePath)).toBe(true);
  });

  it('loadSessions loads cli-local.json files', () => {
    addMessage(CLI_CHAT_ID, { role: 'user', content: 'Persisted message' });
    clearHistory(CLI_CHAT_ID);

    // History cleared from memory, but file remains on disk
    expect(getHistory(CLI_CHAT_ID)).toEqual([]);

    loadSessions();

    expect(getHistory(CLI_CHAT_ID)).toEqual([{ role: 'user', content: 'Persisted message' }]);
  });

  it('CLI sessions are isolated from numeric Telegram sessions', () => {
    const telegramChatId = 12345;

    addMessage(CLI_CHAT_ID, { role: 'user', content: 'CLI message' });
    addMessage(telegramChatId, { role: 'user', content: 'Telegram message' });

    expect(getHistory(CLI_CHAT_ID)).toEqual([{ role: 'user', content: 'CLI message' }]);
    expect(getHistory(telegramChatId)).toEqual([{ role: 'user', content: 'Telegram message' }]);

    // CLI messages do not leak into Telegram sessions
    expect(getHistory(telegramChatId).some((m) => m.content === 'CLI message')).toBe(false);
    expect(getHistory(CLI_CHAT_ID).some((m) => m.content === 'Telegram message')).toBe(false);

    clearHistory(telegramChatId);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('CLI pipeline', () => {
  const tmpDir = join(tmpdir(), 'titus-test-cli-pipeline');

  beforeEach(() => {
    vi.clearAllMocks();
    _setSessionsDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    clearHistory(CLI_CHAT_ID);
  });

  it('user input calls invokeClaude and response is stored in history', async () => {
    mockedInvokeClaude.mockResolvedValue('Hello from Titus');

    // Simulate the CLI handleInput flow
    const input = 'Hi there';
    addMessage(CLI_CHAT_ID, { role: 'user', content: input });
    const history = getHistory(CLI_CHAT_ID);
    const response = await invokeClaude(input, CLI_CHAT_ID, history);
    addMessage(CLI_CHAT_ID, { role: 'assistant', content: response });

    expect(mockedInvokeClaude).toHaveBeenCalledWith('Hi there', CLI_CHAT_ID, expect.any(Array));
    expect(getHistory(CLI_CHAT_ID)).toEqual([
      { role: 'user', content: 'Hi there' },
      { role: 'assistant', content: 'Hello from Titus' },
    ]);
  });

  it('multi-turn history accumulates across exchanges', async () => {
    mockedInvokeClaude.mockResolvedValueOnce('First response');
    mockedInvokeClaude.mockResolvedValueOnce('Second response');

    // Turn 1
    addMessage(CLI_CHAT_ID, { role: 'user', content: 'Turn 1' });
    const response1 = await invokeClaude('Turn 1', CLI_CHAT_ID, getHistory(CLI_CHAT_ID));
    addMessage(CLI_CHAT_ID, { role: 'assistant', content: response1 });

    // Turn 2
    addMessage(CLI_CHAT_ID, { role: 'user', content: 'Turn 2' });
    const response2 = await invokeClaude('Turn 2', CLI_CHAT_ID, getHistory(CLI_CHAT_ID));
    addMessage(CLI_CHAT_ID, { role: 'assistant', content: response2 });

    const history = getHistory(CLI_CHAT_ID);
    expect(history).toHaveLength(4);
    expect(history).toEqual([
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'First response' },
      { role: 'user', content: 'Turn 2' },
      { role: 'assistant', content: 'Second response' },
    ]);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('CLI exit command recognition', () => {
  // Mirror the isExitCommand logic from cli.ts
  function isExitCommand(input: string): boolean {
    const lower = input.toLowerCase().trim();
    return lower === 'exit' || lower === 'quit';
  }

  it.each([
    ['exit', true],
    ['quit', true],
    ['EXIT', true],
    ['Quit', true],
    ['Exit', true],
    ['QUIT', true],
    ['  exit  ', true],
    ['hello', false],
    ['exiting', false],
    ['quitter', false],
    ['', false],
  ])('isExitCommand(%j) returns %s', (input, expected) => {
    expect(isExitCommand(input)).toBe(expected);
  });
});
