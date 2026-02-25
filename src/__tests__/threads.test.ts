import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setMemoryDir } from '../memory.js';
import {
  loadThreads,
  saveThreads,
  extractTopic,
  generateThreadId,
  inferStatus,
  topicsSimilar,
  updateThreads,
  getActiveThreads,
  parkThread,
  resolveThread,
  type ThreadsState,
  type Thread,
} from '../threads.js';

const tmpDir = join(tmpdir(), 'titus-test-threads');

beforeEach(() => {
  _setMemoryDir(tmpDir);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadThreads', () => {
  it('returns empty state when threads.json does not exist', () => {
    const state = loadThreads();
    expect(state.threads).toEqual([]);
    expect(state.lastUpdated).toBeTruthy();
  });

  it('loads existing threads from disk', () => {
    const existing: ThreadsState = {
      threads: [
        {
          id: 'test-thread-1',
          topic: 'test topic',
          status: 'active',
          lastActivity: '2026-01-01T00:00:00.000Z',
          participants: ['user', 'titus'],
          messageCount: 4,
        },
      ],
      lastUpdated: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(join(tmpDir, 'threads.json'), JSON.stringify(existing));

    const state = loadThreads();
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].id).toBe('test-thread-1');
    expect(state.threads[0].topic).toBe('test topic');
  });

  it('returns empty state for malformed JSON', () => {
    writeFileSync(join(tmpDir, 'threads.json'), 'not json');

    const state = loadThreads();
    expect(state.threads).toEqual([]);
  });

  it('returns empty state for JSON without threads array', () => {
    writeFileSync(join(tmpDir, 'threads.json'), JSON.stringify({ foo: 'bar' }));

    const state = loadThreads();
    expect(state.threads).toEqual([]);
  });
});

describe('saveThreads', () => {
  it('writes threads.json atomically', () => {
    const state: ThreadsState = {
      threads: [
        {
          id: 'save-test',
          topic: 'saving test',
          status: 'active',
          lastActivity: '2026-01-01T00:00:00.000Z',
          participants: ['user', 'titus'],
          messageCount: 2,
        },
      ],
      lastUpdated: '2026-01-01T00:00:00.000Z',
    };

    saveThreads(state);

    const filePath = join(tmpDir, 'threads.json');
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(filePath + '.tmp')).toBe(false);

    const loaded = JSON.parse(readFileSync(filePath, 'utf-8')) as ThreadsState;
    expect(loaded.threads).toHaveLength(1);
    expect(loaded.threads[0].id).toBe('save-test');
  });

  it('creates parent directory if missing', () => {
    rmSync(tmpDir, { recursive: true, force: true });

    const state: ThreadsState = { threads: [], lastUpdated: new Date().toISOString() };
    saveThreads(state);

    expect(existsSync(join(tmpDir, 'threads.json'))).toBe(true);
  });
});

describe('extractTopic', () => {
  it('returns null for very short messages', () => {
    expect(extractTopic('hi')).toBeNull();
    expect(extractTopic('hey there')).toBeNull();
  });

  it('extracts topic from explicit patterns', () => {
    expect(extractTopic("let's talk about the deployment strategy")).toBe('the deployment strategy');
    expect(extractTopic('I need help with TypeScript generics')).toBe('TypeScript generics');
    expect(extractTopic('question about the memory system design')).toBe('the memory system design');
  });

  it('extracts topic from question patterns', () => {
    expect(extractTopic('how do I set up the development environment')).toBe('set up the development environment');
    expect(extractTopic('what is the best approach for error handling')).toBe('the best approach for error handling');
  });

  it('falls back to first sentence for unstructured messages', () => {
    const topic = extractTopic('The database migration is failing in production. We need to fix it.');
    expect(topic).toBe('The database migration is failing in production');
  });

  it('truncates long topics to 80 chars', () => {
    const longMsg = 'can you help with ' + 'a'.repeat(200);
    const topic = extractTopic(longMsg);
    expect(topic!.length).toBeLessThanOrEqual(80);
  });
});

describe('generateThreadId', () => {
  it('produces a slug with timestamp suffix', () => {
    const id = generateThreadId('TypeScript generics');
    expect(id).toMatch(/^typescript-generics-[a-z0-9]{4}$/);
  });

  it('handles special characters', () => {
    const id = generateThreadId('What about the API design?');
    expect(id).toMatch(/^what-about-the-api-design-[a-z0-9]{4}$/);
  });

  it('truncates long slugs', () => {
    const id = generateThreadId('this is a very long topic that should be truncated to thirty characters');
    // slug portion is max 30 chars, plus dash, plus 4-char suffix
    const slugPart = id.slice(0, id.lastIndexOf('-', id.length - 6));
    expect(slugPart.length).toBeLessThanOrEqual(30);
  });
});

describe('inferStatus', () => {
  it('returns awaiting-response when last role is user', () => {
    expect(inferStatus('help me', 'sure thing', 'user')).toBe('awaiting-response');
  });

  it('returns resolved for conclusive assistant responses', () => {
    expect(inferStatus('how do I fix this?', 'Here is the solution. Hope that helps!', 'assistant')).toBe('resolved');
    expect(inferStatus('deploy the app', 'Done! That should do it.', 'assistant')).toBe('resolved');
  });

  it('returns active when assistant asks a question', () => {
    expect(inferStatus('fix the bug', 'Which file has the bug? Do you want me to look at tests?', 'assistant')).toBe('active');
    expect(inferStatus('update config', 'Would you like me to also update the production config?', 'assistant')).toBe('active');
  });

  it('returns active as default for normal responses', () => {
    expect(inferStatus('tell me about X', 'X is a framework for building apps. It uses components.', 'assistant')).toBe('active');
  });
});

describe('topicsSimilar', () => {
  it('returns true for matching topics', () => {
    expect(topicsSimilar('TypeScript generics', 'help with TypeScript generics')).toBe(true);
    expect(topicsSimilar('deployment strategy', 'the deployment strategy')).toBe(true);
  });

  it('returns false for unrelated topics', () => {
    expect(topicsSimilar('TypeScript generics', 'database migration')).toBe(false);
    expect(topicsSimilar('deployment strategy', 'memory system design')).toBe(false);
  });

  it('returns false when topics have only short words', () => {
    expect(topicsSimilar('a b c', 'x y z')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(topicsSimilar('', '')).toBe(false);
    expect(topicsSimilar('some topic', '')).toBe(false);
  });
});

describe('updateThreads', () => {
  it('creates a new thread for a novel topic', () => {
    const state = updateThreads(
      'How do I set up the development environment?',
      'Here are the steps to set up your dev environment...',
    );

    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].topic).toContain('set up the development environment');
    expect(state.threads[0].status).toBe('active');
    expect(state.threads[0].messageCount).toBe(2);
    expect(state.threads[0].participants).toEqual(['user', 'titus']);
  });

  it('updates an existing thread with a similar topic', () => {
    // Create initial thread
    updateThreads(
      'How do I set up the development environment?',
      'You need Node.js and npm installed first.',
    );

    // Continue the same topic
    const state = updateThreads(
      'What about the development environment configuration?',
      'You also need a .env file. Hope that helps!',
    );

    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].messageCount).toBe(4);
    expect(state.threads[0].status).toBe('resolved');
  });

  it('creates separate threads for different topics', () => {
    updateThreads(
      'How do I set up the development environment?',
      'You need Node.js installed.',
    );

    const state = updateThreads(
      'Tell me about the database migration strategy',
      'We use Prisma for migrations.',
    );

    expect(state.threads).toHaveLength(2);
  });

  it('skips tracking for very short messages', () => {
    const state = updateThreads('hi', 'Hello!');
    expect(state.threads).toHaveLength(0);
  });

  it('persists state to disk', () => {
    updateThreads(
      'How do I configure the deployment pipeline?',
      'Use the CI/CD configuration in .github/workflows.',
    );

    const filePath = join(tmpDir, 'threads.json');
    expect(existsSync(filePath)).toBe(true);

    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8')) as ThreadsState;
    expect(onDisk.threads).toHaveLength(1);
  });

  it('does not match against resolved threads', () => {
    // Create and resolve a thread
    updateThreads(
      'How do I set up the development environment?',
      'Here are the steps. Hope that helps!',
    );

    // Mark it as resolved (it already is from the inferStatus, but be explicit)
    const state1 = loadThreads();
    state1.threads[0].status = 'resolved';
    saveThreads(state1);

    // Same topic again should create a new thread
    const state = updateThreads(
      'How do I set up the development environment again?',
      'Sure, let me walk you through it again.',
    );

    expect(state.threads).toHaveLength(2);
  });

  it('caps at 50 threads by removing oldest resolved first', () => {
    // Pre-populate with 50 threads, mix of resolved and active
    const threads: Thread[] = [];
    for (let i = 0; i < 50; i++) {
      threads.push({
        id: `thread-${i}`,
        topic: `unique topic number ${i} for testing`,
        status: i < 25 ? 'resolved' : 'active',
        lastActivity: new Date(Date.now() - (50 - i) * 60000).toISOString(),
        participants: ['user', 'titus'],
        messageCount: 2,
      });
    }
    saveThreads({ threads, lastUpdated: new Date().toISOString() });

    // Add one more
    const state = updateThreads(
      'Brand new topic about something completely different and unique',
      'Interesting, tell me more about it.',
    );

    expect(state.threads.length).toBeLessThanOrEqual(50);
  });
});

describe('getActiveThreads', () => {
  it('returns only non-resolved threads', () => {
    const state: ThreadsState = {
      threads: [
        {
          id: 'active-1',
          topic: 'active topic',
          status: 'active',
          lastActivity: '2026-01-01T00:00:00.000Z',
          participants: ['user', 'titus'],
          messageCount: 2,
        },
        {
          id: 'resolved-1',
          topic: 'resolved topic',
          status: 'resolved',
          lastActivity: '2026-01-01T00:00:00.000Z',
          participants: ['user', 'titus'],
          messageCount: 4,
        },
        {
          id: 'parked-1',
          topic: 'parked topic',
          status: 'parked',
          lastActivity: '2026-01-01T00:00:00.000Z',
          participants: ['user', 'titus'],
          messageCount: 2,
        },
      ],
      lastUpdated: '2026-01-01T00:00:00.000Z',
    };
    saveThreads(state);

    const active = getActiveThreads();
    expect(active).toHaveLength(2);
    expect(active.map((t) => t.id)).toEqual(['active-1', 'parked-1']);
  });
});

describe('parkThread', () => {
  it('parks an existing thread', () => {
    saveThreads({
      threads: [
        {
          id: 'to-park',
          topic: 'some topic',
          status: 'active',
          lastActivity: '2026-01-01T00:00:00.000Z',
          participants: ['user', 'titus'],
          messageCount: 2,
        },
      ],
      lastUpdated: '2026-01-01T00:00:00.000Z',
    });

    expect(parkThread('to-park')).toBe(true);

    const state = loadThreads();
    expect(state.threads[0].status).toBe('parked');
  });

  it('returns false for non-existent thread', () => {
    saveThreads({ threads: [], lastUpdated: new Date().toISOString() });
    expect(parkThread('nonexistent')).toBe(false);
  });
});

describe('resolveThread', () => {
  it('resolves an existing thread', () => {
    saveThreads({
      threads: [
        {
          id: 'to-resolve',
          topic: 'some topic',
          status: 'active',
          lastActivity: '2026-01-01T00:00:00.000Z',
          participants: ['user', 'titus'],
          messageCount: 4,
        },
      ],
      lastUpdated: '2026-01-01T00:00:00.000Z',
    });

    expect(resolveThread('to-resolve')).toBe(true);

    const state = loadThreads();
    expect(state.threads[0].status).toBe('resolved');
  });

  it('returns false for non-existent thread', () => {
    saveThreads({ threads: [], lastUpdated: new Date().toISOString() });
    expect(resolveThread('nonexistent')).toBe(false);
  });
});
