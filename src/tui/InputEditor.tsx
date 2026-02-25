import React, { useState, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

export interface InputEditorProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  maxVisibleLines?: number;
}

/**
 * Multi-line input editor with history for Ink-based TUI.
 *
 * - Enter sends, Shift+Enter or trailing backslash inserts newline
 * - Ctrl+Up/Down for history; plain Up/Down also navigate history when
 *   input is single-line or empty
 * - Paste preserves newlines (no auto-send)
 * - disabled prop: dimmed, "thinking..." placeholder, ignores keystrokes
 */
export default function InputEditor({
  onSubmit,
  disabled = false,
  maxVisibleLines = 10,
}: InputEditorProps): React.ReactElement {
  // Use refs for mutable state that must be current within the useInput handler
  // (useInput fires synchronously for rapid keystrokes before React re-renders)
  const textRef = useRef('');
  const cursorRef = useRef(0);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const draftRef = useRef('');

  // State for triggering re-renders
  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender((n) => n + 1), []);

  const navigateHistory = useCallback(
    (direction: 'up' | 'down') => {
      const history = historyRef.current;
      if (history.length === 0) return;

      let newIndex = historyIndexRef.current;

      if (direction === 'up') {
        if (newIndex === -1) {
          draftRef.current = textRef.current;
          newIndex = history.length - 1;
        } else if (newIndex > 0) {
          newIndex--;
        } else {
          return;
        }
      } else {
        if (newIndex === -1) return;
        if (newIndex < history.length - 1) {
          newIndex++;
        } else {
          historyIndexRef.current = -1;
          textRef.current = draftRef.current;
          cursorRef.current = draftRef.current.length;
          rerender();
          return;
        }
      }

      historyIndexRef.current = newIndex;
      const entry = history[newIndex];
      textRef.current = entry;
      cursorRef.current = entry.length;
      rerender();
    },
    [rerender],
  );

  useInput(
    (input, key) => {
      if (disabled) return;

      const text = textRef.current;
      const cursorPos = cursorRef.current;

      // Ctrl+Up/Down: always history
      if (key.ctrl && key.upArrow) {
        navigateHistory('up');
        return;
      }
      if (key.ctrl && key.downArrow) {
        navigateHistory('down');
        return;
      }

      // Enter handling
      if (key.return) {
        if (key.shift) {
          const before = text.slice(0, cursorPos);
          const after = text.slice(cursorPos);
          textRef.current = before + '\n' + after;
          cursorRef.current = cursorPos + 1;
          rerender();
          return;
        }

        // Trailing backslash fallback
        if (text.length > 0 && text[cursorPos - 1] === '\\') {
          const before = text.slice(0, cursorPos - 1);
          const after = text.slice(cursorPos);
          textRef.current = before + '\n' + after;
          // cursorPos stays the same (backslash replaced by newline, same byte offset)
          rerender();
          return;
        }

        // Submit
        if (text.trim() !== '') {
          historyRef.current.push(text);
        }
        historyIndexRef.current = -1;
        draftRef.current = '';
        const submitted = text;
        textRef.current = '';
        cursorRef.current = 0;
        rerender();
        onSubmit(submitted);
        return;
      }

      // Arrow keys
      if (key.upArrow) {
        if (!text.includes('\n')) {
          navigateHistory('up');
        } else {
          const lines = text.slice(0, cursorPos).split('\n');
          if (lines.length <= 1) {
            navigateHistory('up');
            return;
          }
          const currentLineCol = lines[lines.length - 1].length;
          const prevLine = lines[lines.length - 2];
          const targetCol = Math.min(currentLineCol, prevLine.length);
          const prevLinesLen = lines
            .slice(0, lines.length - 2)
            .reduce((sum, l) => sum + l.length + 1, 0);
          cursorRef.current = prevLinesLen + targetCol;
          rerender();
        }
        return;
      }

      if (key.downArrow) {
        if (!text.includes('\n')) {
          navigateHistory('down');
        } else {
          const beforeCursor = text.slice(0, cursorPos);
          const afterCursor = text.slice(cursorPos);
          const linesBeforeCursor = beforeCursor.split('\n');
          const currentLineCol = linesBeforeCursor[linesBeforeCursor.length - 1].length;
          const afterLines = afterCursor.split('\n');
          if (afterLines.length <= 1) {
            navigateHistory('down');
            return;
          }
          const remainderOfCurrentLine = afterLines[0].length;
          const nextLine = afterLines[1];
          const targetCol = Math.min(currentLineCol, nextLine.length);
          cursorRef.current = cursorPos + remainderOfCurrentLine + 1 + targetCol;
          rerender();
        }
        return;
      }

      if (key.leftArrow) {
        cursorRef.current = Math.max(0, cursorPos - 1);
        rerender();
        return;
      }

      if (key.rightArrow) {
        cursorRef.current = Math.min(text.length, cursorPos + 1);
        rerender();
        return;
      }

      if (key.home) {
        const beforeCursor = text.slice(0, cursorPos);
        const lastNewline = beforeCursor.lastIndexOf('\n');
        cursorRef.current = lastNewline + 1;
        rerender();
        return;
      }

      if (key.end) {
        const nextNewline = text.indexOf('\n', cursorPos);
        cursorRef.current = nextNewline === -1 ? text.length : nextNewline;
        rerender();
        return;
      }

      // Backspace
      if (key.backspace || key.delete) {
        if (cursorPos > 0) {
          const before = text.slice(0, cursorPos - 1);
          const after = text.slice(cursorPos);
          textRef.current = before + after;
          cursorRef.current = cursorPos - 1;
          rerender();
        }
        return;
      }

      // Escape — ignore (handled by parent)
      if (key.escape) return;
      // Ignore other control/meta combos
      if (key.ctrl || key.meta) return;
      // Ignore tab
      if (key.tab) return;

      // Regular input (including multi-char paste)
      if (input) {
        const before = text.slice(0, cursorPos);
        const after = text.slice(cursorPos);
        textRef.current = before + input + after;
        cursorRef.current = cursorPos + input.length;
        rerender();
      }
    },
    { isActive: !disabled },
  );

  if (disabled) {
    return (
      <Box width="100%">
        <Text dimColor color="yellow">thinking...</Text>
      </Box>
    );
  }

  // Read current values for rendering
  const text = textRef.current;
  const cursorPos = cursorRef.current;

  const lines = text.split('\n');
  const totalLines = lines.length;

  // Find which line the cursor is on
  let charCount = 0;
  let cursorLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = charCount + lines[i].length;
    if (cursorPos <= lineEnd) {
      cursorLine = i;
      break;
    }
    charCount += lines[i].length + 1;
  }

  let scrollOffset = 0;
  if (totalLines > maxVisibleLines) {
    const halfVisible = Math.floor(maxVisibleLines / 2);
    scrollOffset = Math.max(0, cursorLine - halfVisible);
    scrollOffset = Math.min(scrollOffset, totalLines - maxVisibleLines);
  }

  const visibleLines = lines.slice(scrollOffset, scrollOffset + maxVisibleLines);

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="single" borderColor="cyan" flexDirection="column" paddingX={1} width="100%">
        {totalLines > maxVisibleLines && scrollOffset > 0 && (
          <Text dimColor>{'...' + scrollOffset + ' more lines above'}</Text>
        )}
        {visibleLines.map((line, idx) => {
          const absoluteLineIdx = scrollOffset + idx;
          const lineStartPos = lines
            .slice(0, absoluteLineIdx)
            .reduce((sum, l) => sum + l.length + 1, 0);

          const isCurrentLine = absoluteLineIdx === cursorLine;
          const cursorCol = cursorPos - lineStartPos;

          const prefix = absoluteLineIdx === 0 ? 'You: ' : '     ';

          if (isCurrentLine) {
            const beforeCursorText = line.slice(0, cursorCol);
            const afterCursorText = line.slice(cursorCol);
            return (
              <Box key={absoluteLineIdx}>
                <Text color="cyan" bold>{prefix}</Text>
                <Text>{beforeCursorText}</Text>
                <Text backgroundColor="white" color="black">
                  {afterCursorText.length > 0 ? afterCursorText[0] : ' '}
                </Text>
                <Text>{afterCursorText.slice(1)}</Text>
              </Box>
            );
          }

          return (
            <Box key={absoluteLineIdx}>
              <Text color="cyan" bold>{prefix}</Text>
              <Text>{line}</Text>
            </Box>
          );
        })}
        {totalLines > maxVisibleLines && scrollOffset + maxVisibleLines < totalLines && (
          <Text dimColor>{'...' + (totalLines - scrollOffset - maxVisibleLines) + ' more lines below'}</Text>
        )}
      </Box>
    </Box>
  );
}
