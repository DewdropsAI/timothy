import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { WritebackDirective, WritebackResult } from './types.js';
import { identity } from './identity.js';

export type { WritebackDirective, WritebackResult } from './types.js';

const VALID_ACTIONS = new Set(['create', 'append', 'update']);

/**
 * Parses `<!--<agentName>-write ... -->` blocks from a response string.
 * Returns parsed directives and the response with all directive blocks removed.
 */
export function extractWritebacks(response: string): { directives: WritebackDirective[]; cleanResponse: string } {
  const directives: WritebackDirective[] = [];
  const pattern = new RegExp(`<!--${identity.agentName}-write\\n([\\s\\S]*?)-->`, 'g');

  let match;
  while ((match = pattern.exec(response)) !== null) {
    try {
      const block = match[1];
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
        console.warn('[writeback] skipping malformed directive: missing file or invalid action');
        continue;
      }

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

      directives.push({
        file,
        action: action as WritebackDirective['action'],
        frontmatter,
        content,
      });
    } catch (err) {
      console.warn('[writeback] skipping malformed directive:', err);
    }
  }

  const cleanResponse = response.replace(pattern, '').trim();
  return { directives, cleanResponse };
}

/**
 * Validates that a writeback directive targets a path under the workspace.
 * Rejects ../ traversal, absolute paths, and invalid actions.
 */
export function validateWriteback(directive: WritebackDirective, workspacePath: string): boolean {
  if (!VALID_ACTIONS.has(directive.action)) {
    console.warn(`[writeback] invalid action: ${directive.action}`);
    return false;
  }

  if (path.isAbsolute(directive.file)) {
    console.warn(`[writeback] rejected absolute path: ${directive.file}`);
    return false;
  }

  if (directive.file.includes('..')) {
    console.warn(`[writeback] rejected path traversal: ${directive.file}`);
    return false;
  }

  const resolved = path.resolve(workspacePath, directive.file);
  if (!resolved.startsWith(workspacePath + path.sep) && resolved !== workspacePath) {
    console.warn(`[writeback] path escapes workspace: ${directive.file}`);
    return false;
  }

  return true;
}

/**
 * Attempts to write a single directive to disk using atomic tmp+rename.
 * Returns null on success or an error message string on failure.
 */
function writeDirective(directive: WritebackDirective, workspacePath: string): string | null {
  const filePath = path.resolve(workspacePath, directive.file);
  const tmpPath = filePath + '.tmp';

  let body = '';

  if (directive.frontmatter && Object.keys(directive.frontmatter).length > 0) {
    const fmLines = ['---'];
    for (const [key, value] of Object.entries(directive.frontmatter)) {
      fmLines.push(`${key}: ${value}`);
    }
    fmLines.push('---', '');
    body += fmLines.join('\n');
  }

  body += directive.content;

  try {
    mkdirSync(path.dirname(filePath), { recursive: true });

    if (directive.action === 'append') {
      let existing = '';
      try {
        existing = readFileSync(filePath, 'utf-8');
      } catch {
        // File may not exist yet for append — treat as empty
      }
      const combined = existing ? existing + '\n' + body : body;
      writeFileSync(tmpPath, combined);
    } else {
      writeFileSync(tmpPath, body);
    }

    renameSync(tmpPath, filePath);
    return null;
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp file may not exist
    }
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Applies validated writeback directives to the workspace using atomic writes.
 * Retries each failed directive once before reporting failure.
 * Returns a result indicating which writes succeeded and which failed.
 */
export async function applyWritebacks(directives: WritebackDirective[], workspacePath: string): Promise<WritebackResult> {
  const result: WritebackResult = { succeeded: [], failed: [] };
  const retryQueue: WritebackDirective[] = [];

  for (const directive of directives) {
    if (!validateWriteback(directive, workspacePath)) {
      continue;
    }

    const error = writeDirective(directive, workspacePath);
    if (error === null) {
      console.log(`[writeback] ${directive.action}: ${directive.file}`);
      result.succeeded.push(directive.file);
    } else {
      console.warn(`[writeback] first attempt failed for ${directive.file}: ${error}, will retry`);
      retryQueue.push(directive);
    }
  }

  for (const directive of retryQueue) {
    const error = writeDirective(directive, workspacePath);
    if (error === null) {
      console.log(`[writeback] ${directive.action} (retry): ${directive.file}`);
      result.succeeded.push(directive.file);
    } else {
      console.error(`[writeback] failed to apply ${directive.action} to ${directive.file} after retry: ${error}`);
      result.failed.push({ file: directive.file, error });
    }
  }

  return result;
}

/**
 * ContinuityManager — pre/post hooks for the cognitive pipeline.
 * Pre: assembles memory context. Post: applies writeback directives.
 */
export class ContinuityManager {
  constructor(private readonly workspacePath: string) {}

  /**
   * Post-invocation: extract writebacks from raw text, apply them,
   * and return the clean response with any failure notes appended.
   */
  async processResponse(rawResponse: string, chatId?: string | number): Promise<{ cleanResponse: string; writebackResults: WritebackResult }> {
    const { directives, cleanResponse } = extractWritebacks(rawResponse);
    const writebackResults: WritebackResult = { succeeded: [], failed: [] };

    if (directives.length === 0) {
      return { cleanResponse, writebackResults };
    }

    try {
      const result = await applyWritebacks(directives, this.workspacePath);
      writebackResults.succeeded = result.succeeded;
      writebackResults.failed = result.failed;

      if (result.failed.length > 0) {
        const failedFiles = result.failed.map((f) => f.file).join(', ');
        const chatLabel = chatId !== undefined ? ` chat=${chatId}` : '';
        console.error(
          `[writeback]${chatLabel} memory_write_failed files=[${failedFiles}] errors=${JSON.stringify(result.failed)}`,
        );
      }
    } catch (err) {
      const chatLabel = chatId !== undefined ? ` chat=${chatId}` : '';
      console.error(`[writeback]${chatLabel} unexpected_writeback_error:`, err);
    }

    return { cleanResponse, writebackResults };
  }
}
