import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addMessage, getHistory, clearHistory, loadSessions, _setSessionsDir, type ChatId } from '../session.js';

describe('session persistence', () => {
  const tmpDir = join(tmpdir(), 'titus-test-sessions');

  beforeEach(() => {
    _setSessionsDir(tmpDir);
    // Clean up any existing test dir
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    clearHistory(12345);
    clearHistory(67890);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves session to disk after addMessage', () => {
    addMessage(12345, { role: 'user', content: 'Hello' });

    const filePath = join(tmpDir, '12345.json');
    expect(existsSync(filePath)).toBe(true);

    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(data).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('creates sessions directory if missing', () => {
    expect(existsSync(tmpDir)).toBe(false);
    addMessage(12345, { role: 'user', content: 'Hello' });
    expect(existsSync(tmpDir)).toBe(true);
  });

  it('writes valid JSON with full history', () => {
    addMessage(12345, { role: 'user', content: 'Hello' });
    addMessage(12345, { role: 'assistant', content: 'Hi there!' });

    const filePath = join(tmpDir, '12345.json');
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(data).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
  });

  it('uses atomic write (tmp + rename)', () => {
    addMessage(12345, { role: 'user', content: 'Hello' });

    // After save, the .tmp file should not exist (renamed away)
    const tmpPath = join(tmpDir, '12345.json.tmp');
    expect(existsSync(tmpPath)).toBe(false);

    // But the final file should exist and be valid
    const filePath = join(tmpDir, '12345.json');
    expect(existsSync(filePath)).toBe(true);
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(data).toEqual([{ role: 'user', content: 'Hello' }]);
  });
});

describe('session loading (US-003)', () => {
  const tmpDir = join(tmpdir(), 'titus-test-load');

  beforeEach(() => {
    _setSessionsDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    clearHistory(111);
    clearHistory(222);
    clearHistory(333);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads saved sessions into memory on loadSessions', () => {
    const messages = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ];
    writeFileSync(join(tmpDir, '111.json'), JSON.stringify(messages));

    loadSessions();

    expect(getHistory(111)).toEqual(messages);
  });

  it('loads multiple independent sessions', () => {
    writeFileSync(join(tmpDir, '111.json'), JSON.stringify([{ role: 'user', content: 'Chat A' }]));
    writeFileSync(join(tmpDir, '222.json'), JSON.stringify([{ role: 'user', content: 'Chat B' }]));

    loadSessions();

    expect(getHistory(111)).toEqual([{ role: 'user', content: 'Chat A' }]);
    expect(getHistory(222)).toEqual([{ role: 'user', content: 'Chat B' }]);
  });

  it('sessions are isolated — chat 111 does not see chat 222', () => {
    writeFileSync(join(tmpDir, '111.json'), JSON.stringify([{ role: 'user', content: 'Secret A' }]));
    writeFileSync(join(tmpDir, '222.json'), JSON.stringify([{ role: 'user', content: 'Secret B' }]));

    loadSessions();

    const histA = getHistory(111);
    const histB = getHistory(222);
    expect(histA.some((m) => m.content === 'Secret B')).toBe(false);
    expect(histB.some((m) => m.content === 'Secret A')).toBe(false);
  });

  it('works when sessions directory does not exist', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    expect(() => loadSessions()).not.toThrow();
  });
});

describe('graceful degradation (US-005)', () => {
  const tmpDir = join(tmpdir(), 'titus-test-graceful');

  beforeEach(() => {
    _setSessionsDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    clearHistory(111);
    clearHistory(999);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips corrupted JSON files without crashing', () => {
    writeFileSync(join(tmpDir, '999.json'), '{"not": "valid');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => loadSessions()).not.toThrow();
    expect(getHistory(999)).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('skips non-array JSON without crashing', () => {
    writeFileSync(join(tmpDir, '999.json'), JSON.stringify({ not: 'an array' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => loadSessions()).not.toThrow();
    expect(getHistory(999)).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('loads valid sessions even when some files are corrupted', () => {
    writeFileSync(join(tmpDir, '111.json'), JSON.stringify([{ role: 'user', content: 'Good' }]));
    writeFileSync(join(tmpDir, '999.json'), 'CORRUPTED DATA!!!');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadSessions();

    expect(getHistory(111)).toEqual([{ role: 'user', content: 'Good' }]);
    expect(getHistory(999)).toEqual([]);

    warnSpy.mockRestore();
  });

  it('new messages save correctly after recovery from corruption', () => {
    writeFileSync(join(tmpDir, '999.json'), 'BAD JSON');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadSessions();
    warnSpy.mockRestore();

    // Now send a new message — it should save correctly
    addMessage(999, { role: 'user', content: 'Fresh start' });
    const filePath = join(tmpDir, '999.json');
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(data).toEqual([{ role: 'user', content: 'Fresh start' }]);
  });
});

describe('string chatId persistence', () => {
  const tmpDir = join(tmpdir(), 'titus-test-string-persist');
  const stringId: ChatId = 'cli-local';

  beforeEach(() => {
    _setSessionsDir(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    clearHistory(stringId);
    clearHistory(111);
  });

  afterEach(() => {
    clearHistory(stringId);
    clearHistory(111);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadSessions loads string-keyed files (e.g., cli-local.json)', () => {
    const messages = [
      { role: 'user', content: 'CLI hello' },
      { role: 'assistant', content: 'CLI response' },
    ];
    writeFileSync(join(tmpDir, 'cli-local.json'), JSON.stringify(messages));

    loadSessions();

    expect(getHistory(stringId)).toEqual(messages);
  });

  it('mixed numeric and string session files coexist', () => {
    writeFileSync(join(tmpDir, '111.json'), JSON.stringify([{ role: 'user', content: 'Telegram msg' }]));
    writeFileSync(join(tmpDir, 'cli-local.json'), JSON.stringify([{ role: 'user', content: 'CLI msg' }]));

    loadSessions();

    expect(getHistory(111)).toEqual([{ role: 'user', content: 'Telegram msg' }]);
    expect(getHistory(stringId)).toEqual([{ role: 'user', content: 'CLI msg' }]);
  });

  it('string chatId sessions persist to disk (cli-local.json exists after addMessage)', () => {
    addMessage(stringId, { role: 'user', content: 'Persisted via string ID' });

    const filePath = join(tmpDir, 'cli-local.json');
    expect(existsSync(filePath)).toBe(true);

    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(data).toEqual([{ role: 'user', content: 'Persisted via string ID' }]);
  });
});
