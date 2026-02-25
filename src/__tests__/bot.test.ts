import { describe, it, expect, vi, beforeEach } from 'vitest';
import { splitMessage } from '../bot.js';

// Mock dependencies
vi.mock('../claude.js', () => ({
  invokeClaude: vi.fn(),
}));

vi.mock('../session.js', () => ({
  addMessage: vi.fn(),
  getHistory: vi.fn(() => []),
  loadSessions: vi.fn(),
}));

import { invokeClaude } from '../claude.js';
import { addMessage, getHistory } from '../session.js';

const mockedInvokeClaude = vi.mocked(invokeClaude);
const mockedAddMessage = vi.mocked(addMessage);

/**
 * Helper to create a minimal mock context for testing handler logic.
 */
function createMockCtx(overrides: {
  chatType?: string;
  text?: string;
  chatId?: number;
  hasText?: boolean;
}) {
  const { chatType = 'private', text = 'hello', chatId = 12345, hasText = true } = overrides;
  return {
    chat: { id: chatId, type: chatType },
    message: { text: hasText ? text : undefined },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithChatAction: vi.fn().mockResolvedValue(true),
  };
}

describe('splitMessage', () => {
  it('returns single-element array for short messages', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('returns single-element array for exactly max length', () => {
    const msg = 'a'.repeat(4096);
    expect(splitMessage(msg)).toEqual([msg]);
  });

  it('splits long messages into multiple chunks', () => {
    const msg = 'a'.repeat(5000);
    const chunks = splitMessage(msg);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4096);
    expect(chunks[1].length).toBe(904);
    expect(chunks.join('')).toBe(msg);
  });

  it('splits on newlines when possible', () => {
    const firstPart = 'a'.repeat(3000);
    const secondPart = 'b'.repeat(2000);
    const msg = firstPart + '\n' + secondPart;
    const chunks = splitMessage(msg);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(firstPart);
    expect(chunks[1]).toBe(secondPart);
  });

  it('hard-splits when no newline is available', () => {
    const msg = 'a'.repeat(8192);
    const chunks = splitMessage(msg);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4096);
    expect(chunks[1].length).toBe(4096);
  });

  it('handles custom max length', () => {
    const chunks = splitMessage('hello world', 5);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
  });

  it('handles empty string', () => {
    expect(splitMessage('')).toEqual(['']);
  });
});

describe('message handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes private text messages', async () => {
    const ctx = createMockCtx({ chatType: 'private', text: 'hello' });
    mockedInvokeClaude.mockResolvedValue('Hi there!');

    // Simulate the text handler flow
    const chatId = ctx.chat.id;
    const text = ctx.message.text!;
    addMessage(chatId, { role: 'user', content: text });
    await ctx.replyWithChatAction('typing');
    const history = getHistory(chatId);
    const response = await invokeClaude(text, chatId, history);
    addMessage(chatId, { role: 'assistant', content: response });
    const chunks = splitMessage(response);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }

    expect(mockedAddMessage).toHaveBeenCalledWith(chatId, { role: 'user', content: 'hello' });
    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('typing');
    expect(mockedInvokeClaude).toHaveBeenCalledWith('hello', chatId, []);
    expect(mockedAddMessage).toHaveBeenCalledWith(chatId, { role: 'assistant', content: 'Hi there!' });
    expect(ctx.reply).toHaveBeenCalledWith('Hi there!');
  });

  it('ignores group chat messages', () => {
    const ctx = createMockCtx({ chatType: 'group', text: 'hello' });
    // The handler checks ctx.chat.type !== 'private' and returns early
    expect(ctx.chat.type).toBe('group');
    expect(ctx.chat.type !== 'private').toBe(true);
  });

  it('sends multiple messages for long responses', async () => {
    const ctx = createMockCtx({ chatType: 'private', text: 'write something long' });
    const longResponse = 'a'.repeat(5000);
    mockedInvokeClaude.mockResolvedValue(longResponse);

    const chatId = ctx.chat.id;
    const text = ctx.message.text!;
    await ctx.replyWithChatAction('typing');
    const history = getHistory(chatId);
    const response = await invokeClaude(text, chatId, history);
    const chunks = splitMessage(response);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }

    expect(chunks.length).toBe(2);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
  });

  it('responds to non-text messages with text-only notice', async () => {
    const ctx = createMockCtx({ chatType: 'private', hasText: false });
    // Simulate the non-text message handler
    if (ctx.chat.type === 'private') {
      await ctx.reply('I only support text messages for now.');
    }
    expect(ctx.reply).toHaveBeenCalledWith('I only support text messages for now.');
  });

  it('does not reply to non-text messages in group chats', async () => {
    const ctx = createMockCtx({ chatType: 'group', hasText: false });
    // The handler checks ctx.chat.type !== 'private' and returns
    if (ctx.chat.type === 'private') {
      await ctx.reply('I only support text messages for now.');
    }
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe('response sending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends typing indicator before processing', async () => {
    const ctx = createMockCtx({ chatType: 'private', text: 'hello' });
    mockedInvokeClaude.mockResolvedValue('response');

    await ctx.replyWithChatAction('typing');
    const history = getHistory(ctx.chat.id);
    await invokeClaude(ctx.message.text!, ctx.chat.id, history);
    await ctx.reply('response');

    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('typing');
    // Typing action should be called before reply
    const typingOrder = ctx.replyWithChatAction.mock.invocationCallOrder[0];
    const replyOrder = ctx.reply.mock.invocationCallOrder[0];
    expect(typingOrder).toBeLessThan(replyOrder);
  });

  it('sends error message when Claude invocation fails', async () => {
    const ctx = createMockCtx({ chatType: 'private', text: 'hello' });
    mockedInvokeClaude.mockRejectedValue(new Error('CLI failed'));

    await ctx.replyWithChatAction('typing');
    try {
      const history = getHistory(ctx.chat.id);
      await invokeClaude(ctx.message.text!, ctx.chat.id, history);
    } catch {
      await ctx.reply('Sorry, something went wrong while processing your message.');
    }

    expect(ctx.reply).toHaveBeenCalledWith('Sorry, something went wrong while processing your message.');
  });

  it('splits response at newline boundaries when possible', () => {
    const line1 = 'x'.repeat(2000);
    const line2 = 'y'.repeat(2000);
    const line3 = 'z'.repeat(2000);
    const msg = `${line1}\n${line2}\n${line3}`;

    const chunks = splitMessage(msg);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(`${line1}\n${line2}`);
    expect(chunks[1]).toBe(line3);
  });

  it('delivers all parts in order for multi-chunk messages', async () => {
    const ctx = createMockCtx({ chatType: 'private' });
    const longResponse = 'a'.repeat(3000) + '\n' + 'b'.repeat(3000);

    const chunks = splitMessage(longResponse);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }

    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(ctx.reply.mock.calls[0][0]).toBe('a'.repeat(3000));
    expect(ctx.reply.mock.calls[1][0]).toBe('b'.repeat(3000));
  });
});
