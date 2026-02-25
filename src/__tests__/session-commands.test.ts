import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { addMessage, getHistory, clearHistory, _setSessionsDir } from '../session.js';
import { parseCommand } from '../tui/commands.js';

/* ── Command parser ────────────────────────────────────── */

describe('parseCommand', () => {
  it('recognizes /new', () => {
    const r = parseCommand('/new');
    expect(r.handled).toBe(true);
    expect(r.action).toBe('new');
  });

  it('recognizes /clear', () => {
    const r = parseCommand('/clear');
    expect(r.handled).toBe(true);
    expect(r.action).toBe('clear');
  });

  it('recognizes /history', () => {
    const r = parseCommand('/history');
    expect(r.handled).toBe(true);
    expect(r.action).toBe('history');
  });

  it('recognizes /auth with code', () => {
    const r = parseCommand('/auth ABC123');
    expect(r.handled).toBe(true);
    expect(r.action).toBe('auth');
    expect(r.args).toEqual({ code: 'ABC123' });
  });

  it('/auth without argument returns usage message', () => {
    const r = parseCommand('/auth');
    expect(r.handled).toBe(true);
    expect(r.action).toBe('auth');
    expect(r.output).toBeDefined();
    expect(r.output![0]).toContain('/auth <code>');
  });

  it('is case-insensitive', () => {
    expect(parseCommand('/NEW').handled).toBe(true);
    expect(parseCommand('/NEW').action).toBe('new');
    expect(parseCommand('/Clear').handled).toBe(true);
    expect(parseCommand('/Clear').action).toBe('clear');
    expect(parseCommand('/HISTORY').handled).toBe(true);
    expect(parseCommand('/HISTORY').action).toBe('history');
    expect(parseCommand('/AUTH code').handled).toBe(true);
    expect(parseCommand('/AUTH code').action).toBe('auth');
  });

  it('unknown slash command is not handled', () => {
    const r = parseCommand('/unknown-command');
    expect(r.handled).toBe(false);
  });

  it('regular text is not handled', () => {
    expect(parseCommand('hello world').handled).toBe(false);
    expect(parseCommand('just a message').handled).toBe(false);
  });

  it('empty string is not handled', () => {
    expect(parseCommand('').handled).toBe(false);
  });

  it('whitespace-only is not handled', () => {
    expect(parseCommand('   ').handled).toBe(false);
  });

  it('handles /auth with extra whitespace', () => {
    const r = parseCommand('/auth   ABC123  ');
    expect(r.handled).toBe(true);
    expect(r.args).toEqual({ code: 'ABC123' });
  });

  it('handles leading/trailing whitespace on command', () => {
    const r = parseCommand('  /new  ');
    expect(r.handled).toBe(true);
    expect(r.action).toBe('new');
  });
});

/* ── Session integration ───────────────────────────────── */

describe('session commands integration', () => {
  const testDir = join(tmpdir(), `titus-test-session-cmds-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    _setSessionsDir(testDir);
    clearHistory('cli-local');
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('/new clears session history', () => {
    addMessage('cli-local', { role: 'user', content: 'hello' });
    addMessage('cli-local', { role: 'assistant', content: 'hi there' });
    expect(getHistory('cli-local')).toHaveLength(2);

    clearHistory('cli-local');
    expect(getHistory('cli-local')).toEqual([]);
  });

  it('/clear preserves session history (only clears display)', () => {
    addMessage('cli-local', { role: 'user', content: 'hello' });
    addMessage('cli-local', { role: 'assistant', content: 'hi there' });

    // /clear does NOT call clearHistory — it only resets the display
    // So session history should remain intact
    const history = getHistory('cli-local');
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe('hello');
    expect(history[1].content).toBe('hi there');
  });

  it('/history with empty conversation returns empty array', () => {
    const history = getHistory('cli-local');
    expect(history).toEqual([]);
  });

  it('/history with messages returns them in order', () => {
    addMessage('cli-local', { role: 'user', content: 'first' });
    addMessage('cli-local', { role: 'assistant', content: 'second' });
    addMessage('cli-local', { role: 'user', content: 'third' });

    const history = getHistory('cli-local');
    expect(history).toHaveLength(3);
    expect(history[0]).toEqual({ role: 'user', content: 'first' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'second' });
    expect(history[2]).toEqual({ role: 'user', content: 'third' });
  });
});
