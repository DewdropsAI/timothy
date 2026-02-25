import type { WritebackDirective } from './types.js';
import { identity } from './identity.js';

export interface WritebackEvent {
  directive: WritebackDirective;
}

export interface ParseResult {
  text: string;
  events: WritebackEvent[];
}

const OPENING_TAG = `<!--${identity.agentName}-write\n`;
const CLOSING_TAG = '-->';
const VALID_ACTIONS = new Set(['create', 'append', 'update']);

type ParserState = 'text' | 'directive';

/**
 * Stateful streaming parser for `<!--<agentName>-write ... -->` directives.
 * Accepts incremental text chunks via push(), returns clean text
 * with directives stripped and events for each completed directive.
 * Call flush() when the stream ends.
 */
export class WritebackStreamParser {
  private state: ParserState = 'text';
  private buffer = '';
  private directiveAccum = '';

  push(chunk: string): ParseResult {
    this.buffer += chunk;
    let text = '';
    const events: WritebackEvent[] = [];

    while (this.buffer.length > 0) {
      if (this.state === 'text') {
        const tagIdx = this.buffer.indexOf(OPENING_TAG);

        if (tagIdx !== -1) {
          // Found full opening tag — emit text before it
          text += this.buffer.slice(0, tagIdx);
          this.buffer = this.buffer.slice(tagIdx + OPENING_TAG.length);
          this.directiveAccum = '';
          this.state = 'directive';
          continue;
        }

        // Check if the buffer ends with a potential partial opening tag.
        // The partial match is any suffix of the buffer that matches a
        // prefix of OPENING_TAG.
        const held = partialMatchLength(this.buffer, OPENING_TAG);
        if (held > 0) {
          // Emit everything except the potential partial match
          text += this.buffer.slice(0, this.buffer.length - held);
          this.buffer = this.buffer.slice(this.buffer.length - held);
        } else {
          // No partial match — emit everything
          text += this.buffer;
          this.buffer = '';
        }
        break;
      }

      // state === 'directive'
      const closeIdx = this.buffer.indexOf(CLOSING_TAG);
      if (closeIdx !== -1) {
        this.directiveAccum += this.buffer.slice(0, closeIdx);
        this.buffer = this.buffer.slice(closeIdx + CLOSING_TAG.length);
        this.state = 'text';

        const parsed = parseDirectiveBlock(this.directiveAccum);
        if (parsed) {
          events.push({ directive: parsed });
        }
        this.directiveAccum = '';
        continue;
      }

      // No closing tag yet — check for partial closing match at end
      const held = partialMatchLength(this.buffer, CLOSING_TAG);
      if (held > 0) {
        this.directiveAccum += this.buffer.slice(0, this.buffer.length - held);
        this.buffer = this.buffer.slice(this.buffer.length - held);
      } else {
        this.directiveAccum += this.buffer;
        this.buffer = '';
      }
      break;
    }

    return { text, events };
  }

  flush(): ParseResult {
    // Any incomplete directive is discarded
    // Any partial opening tag in the buffer is also discarded
    const text = this.state === 'text' ? this.buffer : '';
    this.buffer = '';
    this.directiveAccum = '';
    this.state = 'text';
    return { text, events: [] };
  }
}

/**
 * Returns the length of the longest suffix of `str` that matches
 * a prefix of `tag`. Used to detect partial opening/closing tags
 * at chunk boundaries.
 */
function partialMatchLength(str: string, tag: string): number {
  const maxCheck = Math.min(str.length, tag.length - 1);
  for (let len = maxCheck; len >= 1; len--) {
    if (str.endsWith(tag.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Parses a directive block (the content between `<!--<agentName>-write\n` and `-->`)
 * into a WritebackDirective. Returns null if malformed.
 * Uses the same header/frontmatter/content parsing as extractWritebacks().
 */
function parseDirectiveBlock(block: string): WritebackDirective | null {
  const lines = block.split('\n');

  let file = '';
  let action = '';
  let headerEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('file:')) {
      file = line.slice(5).trim();
      headerEnd = i + 1;
    } else if (line.startsWith('action:')) {
      action = line.slice(7).trim();
      headerEnd = i + 1;
    } else if (line === '---' || line === '') {
      if (file && action) break;
      if (line === '') {
        headerEnd = i + 1;
        continue;
      }
      break;
    }
  }

  if (!file || !action || !VALID_ACTIONS.has(action)) {
    return null;
  }

  // Parse optional frontmatter (between --- delimiters)
  let frontmatter: Record<string, string> | undefined;
  let contentStart = headerEnd;

  const remaining = lines.slice(headerEnd);
  if (remaining.length > 0 && remaining[0].trim() === '---') {
    const fmLines: string[] = [];
    let closingIdx = -1;
    for (let i = 1; i < remaining.length; i++) {
      if (remaining[i].trim() === '---') {
        closingIdx = i;
        break;
      }
      fmLines.push(remaining[i]);
    }
    if (closingIdx !== -1) {
      frontmatter = {};
      for (const fmLine of fmLines) {
        const colonIdx = fmLine.indexOf(':');
        if (colonIdx !== -1) {
          const key = fmLine.slice(0, colonIdx).trim();
          const value = fmLine.slice(colonIdx + 1).trim();
          frontmatter[key] = value;
        }
      }
      contentStart = headerEnd + closingIdx + 1;
    }
  }

  const content = lines.slice(contentStart).join('\n').trim();

  return {
    file,
    action: action as WritebackDirective['action'],
    frontmatter: frontmatter || undefined,
    content,
  };
}
