import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

function createMarkedInstance(): Marked {
  const md = new Marked();
  md.use(markedTerminal({
    width: getTerminalWidth(),
    reflowText: true,
    showSectionPrefix: true,
    tab: 2,
  }));
  return md;
}

/**
 * Renders markdown to ANSI-formatted terminal output.
 * Uses a fresh Marked instance with markedTerminal for bold headers,
 * ANSI bold/italic, syntax-highlighted code blocks, distinct inline code,
 * proper list indentation, underlined links, and prefixed blockquotes.
 */
export function renderMarkdown(text: string): string {
  const md = createMarkedInstance();
  return (md.parse(text) as string).trimEnd();
}

/**
 * Identity/passthrough for fallback mode (dumb terminal).
 * Returns the raw markdown text as-is with no ANSI formatting.
 */
export function renderMarkdownRaw(text: string): string {
  return text;
}

// ── MarkdownChunker — block-level chunking for streaming ────────────

const FENCE_OPEN = /^`{3,}/;
const FENCE_CLOSE = /^`{3,}\s*$/;
const HEADER_LINE = /^#{1,6}\s/;
const LIST_ITEM = /^(\s*[-*+]|\s*\d+[.)]) /;

type BufferState = 'idle' | 'fence' | 'paragraph' | 'list';

/**
 * Block-level chunking state machine for streaming markdown.
 * Accepts incremental text via push(), returns arrays of complete
 * rendered markdown blocks ready for display. Call flush() when
 * the stream ends to render any remaining buffered content.
 */
export class MarkdownChunker {
  private md: Marked;
  private remainder = '';
  private buffer = '';
  private state: BufferState = 'idle';
  private fenceMarker = '';

  constructor() {
    this.md = createMarkedInstance();
  }

  /**
   * Returns the raw text currently buffered (incomplete block + partial line).
   * Used for live display of in-progress text during streaming.
   */
  get pending(): string {
    return this.buffer + this.remainder;
  }

  /**
   * Accepts incremental text from a stream.
   * Returns an array of complete rendered markdown blocks.
   */
  push(chunk: string): string[] {
    this.remainder += chunk;
    const results: string[] = [];

    // Process complete lines; keep partial line in remainder
    while (true) {
      const newlineIdx = this.remainder.indexOf('\n');
      if (newlineIdx === -1) break;

      const line = this.remainder.slice(0, newlineIdx);
      this.remainder = this.remainder.slice(newlineIdx + 1);

      const emitted = this.processLine(line);
      if (emitted !== null) {
        results.push(emitted);
      }
    }

    return results;
  }

  /**
   * Called when the stream ends. Renders any remaining buffered content.
   */
  flush(): string {
    // Append any partial line still in remainder
    if (this.remainder.length > 0) {
      this.buffer += this.remainder + '\n';
      this.remainder = '';
    }

    if (this.buffer.length === 0) {
      return '';
    }

    // If we were inside an unclosed fence, emit as a code block anyway
    if (this.state === 'fence') {
      this.buffer += '```\n';
    }

    const rendered = this.render(this.buffer);
    this.buffer = '';
    this.state = 'idle';
    this.fenceMarker = '';
    return rendered;
  }

  private processLine(line: string): string | null {
    if (this.state === 'fence') {
      this.buffer += line + '\n';
      if (FENCE_CLOSE.test(line.trim()) && line.trim().startsWith(this.fenceMarker)) {
        const rendered = this.render(this.buffer);
        this.buffer = '';
        this.state = 'idle';
        this.fenceMarker = '';
        return rendered;
      }
      return null;
    }

    // Check for fence opening
    const fenceMatch = line.match(FENCE_OPEN);
    if (fenceMatch) {
      // Emit anything buffered before the fence
      let emitted: string | null = null;
      if (this.buffer.length > 0) {
        emitted = this.render(this.buffer);
        this.buffer = '';
        this.state = 'idle';
      }
      this.state = 'fence';
      this.fenceMarker = fenceMatch[0];
      this.buffer = line + '\n';
      return emitted;
    }

    // Header — single-line block
    if (HEADER_LINE.test(line)) {
      let emitted: string | null = null;
      if (this.buffer.length > 0) {
        emitted = this.render(this.buffer);
        this.buffer = '';
        this.state = 'idle';
      }
      const headerRendered = this.render(line + '\n');
      if (emitted !== null) {
        // Return prior buffer; header goes into next push via a trick:
        // Actually, just concatenate both since they're separate blocks
        return emitted + '\n' + headerRendered;
      }
      return headerRendered;
    }

    // List item
    if (LIST_ITEM.test(line)) {
      if (this.state !== 'list') {
        // Emit any prior buffer
        let emitted: string | null = null;
        if (this.buffer.length > 0) {
          emitted = this.render(this.buffer);
          this.buffer = '';
        }
        this.state = 'list';
        this.buffer = line + '\n';
        return emitted;
      }
      // Continue accumulating list
      this.buffer += line + '\n';
      return null;
    }

    // Blank line — paragraph boundary
    if (line.trim() === '') {
      if (this.state === 'list' || this.state === 'paragraph') {
        const rendered = this.render(this.buffer);
        this.buffer = '';
        this.state = 'idle';
        return rendered;
      }
      // In idle state, blank line is a no-op
      return null;
    }

    // Regular text line
    if (this.state === 'list') {
      // Non-list line after list — emit the list, start new paragraph
      const rendered = this.render(this.buffer);
      this.buffer = line + '\n';
      this.state = 'paragraph';
      return rendered;
    }

    this.state = 'paragraph';
    this.buffer += line + '\n';
    return null;
  }

  private render(block: string): string {
    const trimmed = block.trim();
    if (trimmed.length === 0) return '';
    return (this.md.parse(trimmed) as string).trimEnd();
  }
}
