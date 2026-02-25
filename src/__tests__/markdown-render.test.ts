import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Force color output so marked-terminal emits ANSI codes even in non-TTY (CI/test).
// vi.hoisted runs before ESM imports are evaluated, ensuring chalk sees FORCE_COLOR.
const _originalForceColor = vi.hoisted(() => {
  const orig = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '1';
  return orig;
});

import { renderMarkdown, renderMarkdownRaw, MarkdownChunker } from '../markdown.js';

afterAll(() => {
  if (_originalForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = _originalForceColor;
  }
});

// Helper: detect ANSI escape sequences
const hasAnsi = (s: string) => /\x1b\[/.test(s);

// ── Headers ────────────────────────────────────────────────────────────

describe('renderMarkdown — headers', () => {
  it('renders headers with bold ANSI escape codes', () => {
    const output = renderMarkdown('## Section Header');
    expect(hasAnsi(output)).toBe(true);
    // Bold escape: \x1b[1m
    expect(output).toMatch(/\x1b\[1m/);
    expect(output).toContain('Section Header');
  });
});

// ── Bold & italic ──────────────────────────────────────────────────────

describe('renderMarkdown — bold and italic', () => {
  it('renders **bold** with bold ANSI escape codes', () => {
    const output = renderMarkdown('**bold**');
    expect(hasAnsi(output)).toBe(true);
    expect(output).toMatch(/\x1b\[1m/);
    expect(output).toContain('bold');
  });

  it('renders *italic* with ANSI italic escape code', () => {
    const output = renderMarkdown('*italic*');
    expect(hasAnsi(output)).toBe(true);
    // marked-terminal uses italic \x1b[3m
    expect(output).toMatch(/\x1b\[3m/);
    expect(output).toContain('italic');
  });
});

// ── Code blocks with syntax highlighting ───────────────────────────────

describe('renderMarkdown — code blocks', () => {
  it('renders fenced code blocks with ANSI color codes', () => {
    const input = '```typescript\nconst x = 1;\n```';
    const output = renderMarkdown(input);
    expect(hasAnsi(output)).toBe(true);
    expect(output).toContain('const');
  });
});

// ── Inline code ────────────────────────────────────────────────────────

describe('renderMarkdown — inline code', () => {
  it('renders inline code with distinct ANSI styling', () => {
    const output = renderMarkdown('use `foo` here');
    expect(hasAnsi(output)).toBe(true);
    expect(output).toContain('foo');
  });
});

// ── Lists ──────────────────────────────────────────────────────────────

describe('renderMarkdown — lists', () => {
  it('renders unordered lists with bullet characters and indentation', () => {
    const output = renderMarkdown('- item 1\n- item 2');
    expect(output).toContain('item 1');
    expect(output).toContain('item 2');
    // marked-terminal uses * as list marker with leading spaces for indentation
    expect(output).toMatch(/[●◦▪▸◆\-\*•]/);
  });
});

// ── Streaming: block-level chunking ────────────────────────────────────

describe('MarkdownChunker — streaming block-level chunking', () => {
  it('emits a complete paragraph after double newline', () => {
    const chunker = new MarkdownChunker();
    const blocks = chunker.push('Hello world\n\n');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.join('')).toContain('Hello world');
  });

  it('buffers incomplete code fence (no output until closing ```)', () => {
    const chunker = new MarkdownChunker();
    const blocks = chunker.push('```typescript\nconst x = 1;\n');
    // No closing fence yet — should buffer
    expect(blocks).toEqual([]);
  });

  it('emits rendered block after closing code fence', () => {
    const chunker = new MarkdownChunker();
    // Push open fence
    chunker.push('```typescript\nconst x = 1;\n');
    // Push closing fence + trailing newline
    const blocks = chunker.push('```\n\n');
    expect(blocks.length).toBeGreaterThan(0);
    const joined = blocks.join('');
    expect(joined).toContain('const');
  });

  it('emits header on newline boundary', () => {
    const chunker = new MarkdownChunker();
    const blocks = chunker.push('## Title\n\n');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.join('')).toContain('Title');
  });

  it('handles multiple small pushes that form a complete block', () => {
    const chunker = new MarkdownChunker();
    let allBlocks: string[] = [];
    allBlocks = allBlocks.concat(chunker.push('Hello '));
    allBlocks = allBlocks.concat(chunker.push('world'));
    allBlocks = allBlocks.concat(chunker.push('\n\n'));
    // Once the double newline arrives, we should have output
    expect(allBlocks.length).toBeGreaterThan(0);
    expect(allBlocks.join('')).toContain('Hello world');
  });
});

// ── Unclosed code fence at stream end ──────────────────────────────────

describe('MarkdownChunker — unclosed code fence at flush', () => {
  it('flush() renders buffered content when code fence is never closed', () => {
    const chunker = new MarkdownChunker();
    chunker.push('```typescript\nconst x = 1;\nconst y = 2;\n');
    // No closing ``` — call flush
    const remaining = chunker.flush();
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining).toContain('const');
  });

  it('flush() returns empty string when buffer is empty', () => {
    const chunker = new MarkdownChunker();
    const remaining = chunker.flush();
    expect(remaining).toBe('');
  });
});

// ── Wide code blocks ───────────────────────────────────────────────────

describe('renderMarkdown — wide code blocks', () => {
  it('handles very long code lines without error', () => {
    const longLine = 'x'.repeat(500);
    const input = '```\n' + longLine + '\n```';
    const output = renderMarkdown(input);
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
    // Content should still be present (possibly wrapped)
    expect(output).toContain('x');
  });
});

// ── Links and blockquotes ──────────────────────────────────────────────

describe('renderMarkdown — links and blockquotes', () => {
  it('renders links with ANSI styling and shows URL or text', () => {
    const output = renderMarkdown('[click](https://example.com)');
    expect(hasAnsi(output)).toBe(true);
    // Should contain either the link text or the URL itself
    const hasLink = output.includes('click') || output.includes('example.com');
    expect(hasLink).toBe(true);
  });

  it('renders blockquotes with indentation or styling', () => {
    const output = renderMarkdown('> quote');
    expect(output).toContain('quote');
    // marked-terminal renders blockquotes with italic ANSI and indentation
    const hasFormatting = hasAnsi(output) || /[│|>▌]/.test(output) || /^\s{2,}/.test(output);
    expect(hasFormatting).toBe(true);
  });
});

// ── Fallback mode: renderMarkdownRaw ───────────────────────────────────

describe('renderMarkdownRaw — fallback mode', () => {
  it('returns raw text without any ANSI escape codes', () => {
    const output = renderMarkdownRaw('**bold**');
    expect(hasAnsi(output)).toBe(false);
  });

  it('preserves the text content', () => {
    const output = renderMarkdownRaw('**bold** and *italic*');
    expect(output).toContain('bold');
    expect(output).toContain('italic');
  });

  it('returns plain text for code blocks', () => {
    const output = renderMarkdownRaw('```\ncode\n```');
    expect(hasAnsi(output)).toBe(false);
    expect(output).toContain('code');
  });
});
