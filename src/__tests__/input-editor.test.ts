import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import InputEditor from '../tui/InputEditor.js';

/** Wait for Ink's hooks to settle */
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** Helper: type a string character-by-character */
function typeChars(stdin: { write: (s: string) => void }, text: string) {
  for (const ch of text) {
    stdin.write(ch);
  }
}

/** ANSI escape sequences for terminal key events */
const KEYS = {
  enter: '\r',
  shiftEnter: '\x1b[13;2u', // Kitty protocol Shift+Enter
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  ctrlUp: '\x1b[1;5A',
  ctrlDown: '\x1b[1;5B',
  escape: '\x1b',
};

describe('InputEditor component', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders with prompt and cursor', () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    const frame = instance.lastFrame()!;
    expect(frame).toContain('You:');
  });

  it('Enter sends single-line message', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();
    typeChars(instance.stdin, 'hello world');
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hello world');
  });

  it('clears input after submit', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();
    typeChars(instance.stdin, 'test');
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();
    const frame = instance.lastFrame()!;
    expect(frame).not.toContain('test');
  });

  it('sends empty string on Enter with no input (caller decides to ignore)', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('');
  });

  it('Shift+Enter inserts newline (does not send)', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();
    typeChars(instance.stdin, 'line1');
    await tick();
    instance.stdin.write(KEYS.shiftEnter);
    await tick();
    typeChars(instance.stdin, 'line2');
    await tick();
    // Should NOT have submitted
    expect(onSubmit).not.toHaveBeenCalled();
    // Frame should show both lines
    const frame = instance.lastFrame()!;
    expect(frame).toContain('line1');
    expect(frame).toContain('line2');
  });

  it('backslash-newline fallback inserts newline instead of sending', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();
    typeChars(instance.stdin, 'hello\\');
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();
    // Should NOT have submitted — the backslash was converted to a newline
    expect(onSubmit).not.toHaveBeenCalled();
    const frame = instance.lastFrame()!;
    expect(frame).toContain('hello');
  });

  it('multi-line message sends full text on Enter', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();
    typeChars(instance.stdin, 'line1');
    await tick();
    instance.stdin.write(KEYS.shiftEnter);
    await tick();
    typeChars(instance.stdin, 'line2');
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('line1\nline2');
  });

  it('Up arrow recalls previous input when input is empty', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();

    // Send a message first to populate history
    typeChars(instance.stdin, 'previous message');
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();

    // Now press up arrow with empty input
    instance.stdin.write(KEYS.up);
    await tick();
    const frame = instance.lastFrame()!;
    expect(frame).toContain('previous message');
  });

  it('Down arrow navigates forward through history', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();

    // Send two messages
    typeChars(instance.stdin, 'first');
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();

    typeChars(instance.stdin, 'second');
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();

    // Go up twice to get to 'first'
    instance.stdin.write(KEYS.up);
    await tick();
    instance.stdin.write(KEYS.up);
    await tick();
    let frame = instance.lastFrame()!;
    expect(frame).toContain('first');

    // Go down once to get to 'second'
    instance.stdin.write(KEYS.down);
    await tick();
    frame = instance.lastFrame()!;
    expect(frame).toContain('second');
  });

  it('Down past newest entry restores empty input', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();

    typeChars(instance.stdin, 'msg');
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();

    // Go up then down past newest
    instance.stdin.write(KEYS.up);
    await tick();
    instance.stdin.write(KEYS.down);
    await tick();
    const frame = instance.lastFrame()!;
    // Should not contain the history entry text in the input line
    expect(frame).not.toContain('msg');
  });

  it('Ctrl+Up/Down navigates history in multi-line mode', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();

    // Send a message
    typeChars(instance.stdin, 'recalled');
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();

    // Type multi-line content
    typeChars(instance.stdin, 'line1');
    await tick();
    instance.stdin.write(KEYS.shiftEnter);
    await tick();
    typeChars(instance.stdin, 'line2');
    await tick();

    // Ctrl+Up should recall history even though we have multi-line content
    instance.stdin.write(KEYS.ctrlUp);
    await tick();
    const frame = instance.lastFrame()!;
    expect(frame).toContain('recalled');
  });

  it('input disabled during streaming (keystrokes ignored)', async () => {
    const onSubmit = vi.fn();
    const instance = render(
      React.createElement(InputEditor, { onSubmit, disabled: true }),
    );
    await tick();

    // Try to type — should be ignored
    typeChars(instance.stdin, 'should not appear');
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();

    expect(onSubmit).not.toHaveBeenCalled();
    const frame = instance.lastFrame()!;
    expect(frame).toContain('thinking...');
    expect(frame).not.toContain('should not appear');
  });

  it('shows thinking... placeholder when disabled', () => {
    const onSubmit = vi.fn();
    const instance = render(
      React.createElement(InputEditor, { onSubmit, disabled: true }),
    );
    const frame = instance.lastFrame()!;
    expect(frame).toContain('thinking...');
  });

  it('pasted multi-line text is preserved (not auto-sent)', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();

    // Simulate paste by writing multiple characters at once (including newlines)
    instance.stdin.write('pasted line 1\npasted line 2\npasted line 3');
    await tick();

    // Should NOT have submitted
    expect(onSubmit).not.toHaveBeenCalled();
    const frame = instance.lastFrame()!;
    expect(frame).toContain('pasted line 1');
    expect(frame).toContain('pasted line 2');
    expect(frame).toContain('pasted line 3');
  });

  it('editing recalled message and sending creates new history entry', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();

    // Send original message
    typeChars(instance.stdin, 'original');
    await tick();
    instance.stdin.write(KEYS.enter);
    await tick();

    // Recall it
    instance.stdin.write(KEYS.up);
    await tick();

    // Edit by adding text
    typeChars(instance.stdin, ' edited');
    await tick();

    // Send the edited version
    instance.stdin.write(KEYS.enter);
    await tick();
    expect(onSubmit).toHaveBeenLastCalledWith('original edited');

    // Go up should get the edited version (most recent)
    instance.stdin.write(KEYS.up);
    await tick();
    let frame = instance.lastFrame()!;
    expect(frame).toContain('original edited');

    // Go up again should get the original
    instance.stdin.write(KEYS.up);
    await tick();
    frame = instance.lastFrame()!;
    expect(frame).toContain('original');
  });

  it('backspace removes character before cursor', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();

    typeChars(instance.stdin, 'helo');
    await tick();
    instance.stdin.write(KEYS.backspace);
    await tick();
    typeChars(instance.stdin, 'lo');
    await tick();

    const frame = instance.lastFrame()!;
    expect(frame).toContain('hello');
  });

  it('left/right arrow keys move cursor', async () => {
    const onSubmit = vi.fn();
    const instance = render(React.createElement(InputEditor, { onSubmit }));
    await tick();

    typeChars(instance.stdin, 'abc');
    await tick();

    // Move left twice, then type 'X'
    instance.stdin.write(KEYS.left);
    await tick();
    instance.stdin.write(KEYS.left);
    await tick();
    typeChars(instance.stdin, 'X');
    await tick();

    // Should now be 'aXbc'
    instance.stdin.write(KEYS.enter);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('aXbc');
  });
});
