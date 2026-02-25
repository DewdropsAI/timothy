import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { getHistory, addMessage, clearHistory, _setSessionsDir, type Message, type ChatId } from '../session.js';

const tmpDir = join(tmpdir(), 'titus-test-sessions-unit');

describe('session history', () => {
  const chatId = 12345;

  beforeEach(() => {
    _setSessionsDir(tmpDir);
    clearHistory(chatId);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for new chat ID', () => {
    expect(getHistory(99999)).toEqual([]);
  });

  it('adds and retrieves messages', () => {
    const msg1: Message = { role: 'user', content: 'Hello' };
    const msg2: Message = { role: 'assistant', content: 'Hi there' };

    addMessage(chatId, msg1);
    addMessage(chatId, msg2);

    expect(getHistory(chatId)).toEqual([msg1, msg2]);
  });

  it('maintains history keyed by chat ID (isolation between chats)', () => {
    const chatA = 100;
    const chatB = 200;

    addMessage(chatA, { role: 'user', content: 'Topic X' });
    addMessage(chatB, { role: 'user', content: 'Topic Y' });

    expect(getHistory(chatA)).toEqual([{ role: 'user', content: 'Topic X' }]);
    expect(getHistory(chatB)).toEqual([{ role: 'user', content: 'Topic Y' }]);

    clearHistory(chatA);
    clearHistory(chatB);
  });

  it('clears history for a specific chat', () => {
    addMessage(chatId, { role: 'user', content: 'Hello' });
    expect(getHistory(chatId)).toHaveLength(1);

    clearHistory(chatId);
    expect(getHistory(chatId)).toEqual([]);
  });

  it('preserves message order', () => {
    const messages: Message[] = [
      { role: 'user', content: 'My project is called Alpha' },
      { role: 'assistant', content: 'Got it, your project is Alpha.' },
      { role: 'user', content: "What's the project name?" },
      { role: 'assistant', content: 'Your project is called Alpha.' },
    ];

    for (const msg of messages) {
      addMessage(chatId, msg);
    }

    expect(getHistory(chatId)).toEqual(messages);
  });
});

describe('string chatId support', () => {
  const stringId: ChatId = 'cli-local';
  const numericId: ChatId = 99999;

  beforeEach(() => {
    _setSessionsDir(tmpDir);
    clearHistory(stringId);
    clearHistory(numericId);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('addMessage works with a string chatId', () => {
    addMessage(stringId, { role: 'user', content: 'Hello from CLI' });
    expect(getHistory(stringId)).toEqual([{ role: 'user', content: 'Hello from CLI' }]);
  });

  it('getHistory returns empty array for unknown string chatId', () => {
    expect(getHistory('nonexistent-chat')).toEqual([]);
  });

  it('clearHistory clears a string chatId session', () => {
    addMessage(stringId, { role: 'user', content: 'To be cleared' });
    expect(getHistory(stringId)).toHaveLength(1);

    clearHistory(stringId);
    expect(getHistory(stringId)).toEqual([]);
  });

  it('string and numeric chatIds are isolated from each other', () => {
    addMessage(stringId, { role: 'user', content: 'String session' });
    addMessage(numericId, { role: 'user', content: 'Numeric session' });

    expect(getHistory(stringId)).toEqual([{ role: 'user', content: 'String session' }]);
    expect(getHistory(numericId)).toEqual([{ role: 'user', content: 'Numeric session' }]);

    // Clearing one does not affect the other
    clearHistory(stringId);
    expect(getHistory(stringId)).toEqual([]);
    expect(getHistory(numericId)).toEqual([{ role: 'user', content: 'Numeric session' }]);

    clearHistory(numericId);
  });
});
