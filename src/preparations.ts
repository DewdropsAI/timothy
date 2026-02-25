import { mkdirSync, readdirSync, existsSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PREPARATIONS_DIR = path.resolve(PROJECT_ROOT, 'workspace', 'preparations');

/** Default expiry duration: 3 days in milliseconds. */
const DEFAULT_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

let preparationsDir = DEFAULT_PREPARATIONS_DIR;

/** @internal Only for testing */
export function _setPreparationsDir(dir: string): void {
  preparationsDir = dir;
}

export function getPreparationsDir(): string {
  return preparationsDir;
}

/** A single preparation draft. */
export interface Preparation {
  topic: string;        // Slug-based topic identifier (filename without .md)
  keywords: string[];   // Keywords for matching against user messages
  content: string;      // The prepared content/draft
  createdAt: string;    // ISO timestamp
  expiresAt: string;    // ISO timestamp — preparations go stale
}

/**
 * Serializes a preparation into the markdown file format with frontmatter.
 */
function serializePreparation(prep: Preparation): string {
  const keywordsStr = `[${prep.keywords.join(', ')}]`;
  const lines = [
    '---',
    `keywords: ${keywordsStr}`,
    `created: ${prep.createdAt}`,
    `expires: ${prep.expiresAt}`,
    '---',
    '',
    prep.content,
  ];
  return lines.join('\n');
}

/**
 * Parses a preparation file's frontmatter and body.
 * Returns null if the file is malformed.
 */
function parsePreparationFile(raw: string, topic: string): Preparation | null {
  if (!raw.startsWith('---')) {
    return null;
  }

  const secondDelimiter = raw.indexOf('\n---', 3);
  if (secondDelimiter === -1) {
    return null;
  }

  const yamlBlock = raw.slice(4, secondDelimiter).trim();
  const body = raw.slice(secondDelimiter + 4).replace(/^\n+/, '');

  let keywords: string[] = [];
  let created = '';
  let expires = '';

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    if (key === 'keywords') {
      if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        if (inner === '') {
          keywords = [];
        } else {
          keywords = inner.split(',').map((k) => k.trim());
        }
      }
    } else if (key === 'created') {
      created = value;
    } else if (key === 'expires') {
      expires = value;
    }
  }

  if (!created) {
    return null;
  }

  return {
    topic,
    keywords,
    content: body,
    createdAt: created,
    expiresAt: expires,  // Empty string means "no expiry"
  };
}

/**
 * Saves a preparation to workspace/preparations/<topic>.md using atomic write.
 * Creates the directory if needed. Overwrites existing preparation for same topic.
 * Returns the absolute file path.
 */
export async function savePreparation(prep: Preparation): Promise<string> {
  mkdirSync(preparationsDir, { recursive: true });

  const filePath = path.join(preparationsDir, `${prep.topic}.md`);
  const tmpPath = filePath + '.tmp';
  const content = serializePreparation(prep);

  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp file may not exist if writeFileSync failed
    }
    throw err;
  }

  return filePath;
}

/**
 * Loads a single preparation by topic. Returns null if not found.
 */
export async function loadPreparation(topic: string): Promise<Preparation | null> {
  const filePath = path.join(preparationsDir, `${topic}.md`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return parsePreparationFile(raw, topic);
  } catch {
    return null;
  }
}

/**
 * Lists all non-expired preparations. Deletes expired ones.
 */
export async function listActivePreparations(): Promise<Preparation[]> {
  if (!existsSync(preparationsDir)) return [];

  const files = readdirSync(preparationsDir).filter((f) => f.endsWith('.md'));
  const now = new Date();
  const active: Preparation[] = [];

  for (const file of files) {
    const topic = file.replace(/\.md$/, '');
    const prep = await loadPreparation(topic);
    if (!prep) continue;

    if (prep.expiresAt) {
      const expiresAt = new Date(prep.expiresAt);
      if (expiresAt <= now) {
        // Expired — delete the file
        try {
          unlinkSync(path.join(preparationsDir, file));
          console.log(`[preparations] expired and deleted: ${topic}`);
        } catch {
          // File may already be gone
        }
        continue;
      }
    }
    active.push(prep);
  }

  return active;
}

/**
 * Finds preparations relevant to a user message by keyword matching.
 * Returns preparations where 2+ keywords appear in the message (case-insensitive).
 * Sorted by match count (best match first).
 */
export function matchPreparations(message: string, preparations: Preparation[]): Preparation[] {
  const lowerMessage = message.toLowerCase();

  const scored: { prep: Preparation; matchCount: number }[] = [];

  for (const prep of preparations) {
    let matchCount = 0;
    for (const keyword of prep.keywords) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        matchCount++;
      }
    }
    if (matchCount >= 2) {
      scored.push({ prep, matchCount });
    }
  }

  scored.sort((a, b) => b.matchCount - a.matchCount);
  return scored.map((s) => s.prep);
}

/**
 * Formats matched preparations for injection into conversation context.
 * Returns empty string if no matches.
 */
export function formatPreparationsContext(preparations: Preparation[]): string {
  if (preparations.length === 0) return '';

  const sections = preparations.map((prep) => {
    return `#### ${prep.topic}\n${prep.content}`;
  });

  return [
    '### Preparations (silent context)',
    '',
    'The following are notes you prepared in advance. Use them naturally — do not mention that you "prepared" these. Simply incorporate the relevant information.',
    '',
    ...sections,
  ].join('\n');
}

/**
 * Deletes a preparation by topic. Returns true if deleted, false if not found.
 */
export async function deletePreparation(topic: string): Promise<boolean> {
  const filePath = path.join(preparationsDir, `${topic}.md`);
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
