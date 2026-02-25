import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTestWorkspace,
  createTestQuery,
  collectMessages,
  getResultText,
  assertWorkspaceFile,
  cleanupWorkspace,
  hasApiKey,
} from './helpers.js';

describe.skipIf(!hasApiKey())('conversation pipeline E2E', () => {

  // ── Test 1: Basic conversation round-trip ──────────────────────────

  describe('basic conversation round-trip', () => {
    let workspace: string;

    beforeEach(() => {
      workspace = createTestWorkspace();
    });
    afterEach(() => {
      cleanupWorkspace(workspace);
    });

    it('sends a message and receives a coherent response', async () => {
      const generator = createTestQuery(
        'What is 2 + 2? Reply with just the number.',
        { cwd: workspace, maxBudgetUsd: 0.10 },
      );

      const { messages, result } = await collectMessages(generator);
      const text = getResultText(result);

      expect(text).toBeTruthy();
      expect(text).toMatch(/4/);

      // Verify no error results
      const errors = messages.filter(
        (m) => m.type === 'result' && 'subtype' in m && m.subtype !== 'success',
      );
      expect(errors).toHaveLength(0);
    }, 60_000);
  });

  // ── Test 2: Memory writeback ───────────────────────────────────────

  describe('memory writeback', () => {
    let workspace: string;

    beforeEach(() => {
      workspace = createTestWorkspace();
    });
    afterEach(() => {
      cleanupWorkspace(workspace);
    });

    it('processes writeback directives and writes files to workspace', async () => {
      // Test the writeback extraction + apply pipeline used by invokeClaude.
      // We use a simulated response to avoid flaky LLM output.
      const { extractWritebacks, applyWritebacks } = await import('../../claude.js');

      const simulatedResponse = [
        "I'll remember that your favorite language is Rust.",
        '<!--titus-write',
        'file: memory/facts/favorite-language.md',
        'action: create',
        '---',
        'created: 2026-02-22T00:00:00Z',
        'updated: 2026-02-22T00:00:00Z',
        'version: 1',
        'type: fact',
        'tags: [preference]',
        '---',
        "User's favorite programming language is Rust.",
        '-->',
      ].join('\n');

      const { directives, cleanResponse } = extractWritebacks(simulatedResponse);

      expect(directives).toHaveLength(1);
      expect(directives[0].file).toBe('memory/facts/favorite-language.md');
      expect(cleanResponse).not.toContain('<!--titus-write');
      expect(cleanResponse).toContain('Rust');

      const result = await applyWritebacks(directives, workspace);
      expect(result.succeeded).toContain('memory/facts/favorite-language.md');
      expect(result.failed).toHaveLength(0);

      assertWorkspaceFile(
        workspace,
        'memory/facts/favorite-language.md',
        'Rust',
      );
    }, 30_000);

    it('LLM round-trip produces a response (writeback is best-effort)', async () => {
      // This test verifies the LLM actually responds — writeback is bonus
      const generator = createTestQuery(
        'Say exactly: "acknowledged". Nothing else.',
        { cwd: workspace, maxBudgetUsd: 0.10 },
      );

      const { result } = await collectMessages(generator);
      const text = getResultText(result);

      expect(text).toBeTruthy();
      expect(text!.toLowerCase()).toContain('acknowledged');
    }, 60_000);
  });

  // ── Test 3: Thread tracking integration ────────────────────────────

  describe('thread tracking integration', () => {
    let workspace: string;

    beforeEach(() => {
      workspace = createTestWorkspace();
    });
    afterEach(() => {
      cleanupWorkspace(workspace);
    });

    it('updateThreads creates/updates threads.json for a conversation exchange', async () => {
      // Thread tracking is a separate module that runs alongside conversation.
      // Test it directly with realistic inputs.
      const { _setMemoryDir } = await import('../../memory.js');
      const memoryDir = join(workspace, 'memory');
      mkdirSync(memoryDir, { recursive: true });

      // Temporarily redirect memory dir for thread tracking
      const origMemoryDir = (await import('../../memory.js')).getMemoryPath();
      _setMemoryDir(memoryDir);

      try {
        const { updateThreads, loadThreads } = await import('../../threads.js');

        const userMsg = 'Can you help me with setting up a Rust project using Cargo?';
        const assistantMsg = 'Sure! To set up a Rust project, run `cargo init`. Would you like me to walk through the options?';

        const state = updateThreads(userMsg, assistantMsg);

        expect(state.threads.length).toBeGreaterThan(0);
        expect(state.threads[0].topic).toBeTruthy();
        expect(state.threads[0].status).toBe('active'); // assistant asked a question
        expect(state.threads[0].messageCount).toBe(2);
        expect(state.threads[0].participants).toContain('user');
        expect(state.threads[0].participants).toContain('titus');

        // Verify persistence
        const threadsPath = join(memoryDir, 'threads.json');
        expect(existsSync(threadsPath)).toBe(true);

        const persisted = loadThreads();
        expect(persisted.threads).toHaveLength(state.threads.length);
        expect(persisted.threads[0].id).toBe(state.threads[0].id);
      } finally {
        _setMemoryDir(origMemoryDir);
      }
    }, 15_000);

    it('subsequent exchanges update the same thread when topics overlap', async () => {
      const { _setMemoryDir, getMemoryPath } = await import('../../memory.js');
      const memoryDir = join(workspace, 'memory');
      mkdirSync(memoryDir, { recursive: true });

      const origMemoryDir = getMemoryPath();
      _setMemoryDir(memoryDir);

      try {
        const { updateThreads } = await import('../../threads.js');

        // First exchange
        updateThreads(
          'How do I set up a Rust project with Cargo?',
          'Run cargo init to get started. Want me to explain the options?',
        );

        // Second exchange on the same topic
        const state = updateThreads(
          'Yes, tell me more about Cargo project options',
          'Cargo supports --lib for libraries and --bin for binaries.',
        );

        // Should still be 1 thread (topics overlap), with updated count
        expect(state.threads).toHaveLength(1);
        expect(state.threads[0].messageCount).toBe(4);
      } finally {
        _setMemoryDir(origMemoryDir);
      }
    }, 15_000);
  });

  // ── Test 4: Working memory awareness ───────────────────────────────

  describe('working memory awareness', () => {
    let workspace: string;

    beforeEach(() => {
      workspace = createTestWorkspace();
    });
    afterEach(() => {
      cleanupWorkspace(workspace);
    });

    it('seeded active-context is loaded into memory context', async () => {
      // Seed the working memory with specific context
      const wmDir = join(workspace, 'working-memory');
      mkdirSync(wmDir, { recursive: true });
      writeFileSync(
        join(wmDir, 'active-context.md'),
        [
          '---',
          'created: 2026-02-22T00:00:00Z',
          'updated: 2026-02-22T00:00:00Z',
          'version: 1',
          'type: working-memory',
          'tags: [active-context]',
          '---',
          '',
          '## Active Context',
          '',
          'Currently focused on: migrating the payment system from Stripe v2 to Stripe v3.',
          'Key decision: using the new PaymentIntents API instead of Charges.',
          'Open question: whether to support Apple Pay in the first release.',
        ].join('\n'),
      );

      // Test that buildMemoryContext picks up the seeded content
      const { _setWorkingMemoryDir, buildMemoryContext, getWorkingMemoryPath } = await import('../../memory.js');
      const origWmDir = getWorkingMemoryPath();
      _setWorkingMemoryDir(wmDir);

      try {
        const { context } = await buildMemoryContext('test-chat-wm');

        expect(context).toContain('Stripe');
        expect(context).toContain('PaymentIntents');
        expect(context).toContain('Apple Pay');
        expect(context).toContain('Working Memory');
      } finally {
        _setWorkingMemoryDir(origWmDir);
      }
    }, 15_000);

    it('LLM with seeded context references the active focus', async () => {
      // Seed working memory in workspace
      const wmDir = join(workspace, 'working-memory');
      mkdirSync(wmDir, { recursive: true });
      writeFileSync(
        join(wmDir, 'active-context.md'),
        [
          '---',
          'created: 2026-02-22T00:00:00Z',
          'updated: 2026-02-22T00:00:00Z',
          'version: 1',
          'type: working-memory',
          'tags: [active-context]',
          '---',
          '',
          '## Active Context',
          '',
          'Currently focused on: building a weather dashboard using the OpenWeatherMap API.',
          'Tech stack: React + TypeScript + Vite.',
        ].join('\n'),
      );

      // Create identity/self.md so the system prompt loads
      const identityDir = join(workspace, 'identity');
      mkdirSync(identityDir, { recursive: true });
      writeFileSync(
        join(identityDir, 'self.md'),
        'You are a helpful assistant. When asked about current focus, refer to your working memory.',
      );

      const generator = createTestQuery(
        'What is your current focus area? Be specific about the project.',
        {
          cwd: workspace,
          maxBudgetUsd: 0.15,
          systemPrompt: [
            'You are a helpful assistant. Your working memory says you are focused on:',
            'building a weather dashboard using the OpenWeatherMap API with React + TypeScript + Vite.',
            'When asked about your focus, mention these specifics.',
          ].join('\n'),
        },
      );

      const { result } = await collectMessages(generator);
      const text = getResultText(result);

      expect(text).toBeTruthy();
      // The response should reference the seeded context
      const lowerText = text!.toLowerCase();
      expect(
        lowerText.includes('weather') ||
        lowerText.includes('openweathermap') ||
        lowerText.includes('dashboard'),
      ).toBe(true);
    }, 90_000);
  });

  // ── Test 5: Multi-turn continuity ──────────────────────────────────

  describe('multi-turn continuity', () => {
    let workspace: string;

    beforeEach(() => {
      workspace = createTestWorkspace();
    });
    afterEach(() => {
      cleanupWorkspace(workspace);
    });

    it('resumed session maintains context from previous turn', async () => {
      // Turn 1: Establish a fact (persistSession must be true so the
      // session is saved to disk and can be resumed in turn 2)
      const gen1 = createTestQuery(
        'Remember this code word: ZEPHYR-42. Just confirm you noted it.',
        { cwd: workspace, maxBudgetUsd: 0.10, persistSession: true },
      );

      const { messages: messages1, result: result1 } = await collectMessages(gen1);
      const text1 = getResultText(result1);

      expect(text1).toBeTruthy();

      // Extract session_id from init message for resume
      const initMsg = messages1.find(
        (m) => m.type === 'system' && 'subtype' in m && m.subtype === 'init',
      );
      const sessionId = initMsg?.session_id;
      expect(sessionId).toBeTruthy();

      // Turn 2: Resume and ask about the fact
      const gen2 = createTestQuery(
        'What was the code word I told you to remember? Reply with just the code word.',
        {
          cwd: workspace,
          maxBudgetUsd: 0.10,
          persistSession: true,
          resume: sessionId!,
        },
      );

      const { result: result2 } = await collectMessages(gen2);
      const text2 = getResultText(result2);

      expect(text2).toBeTruthy();
      expect(text2!.toUpperCase()).toContain('ZEPHYR');
    }, 120_000);
  });

  // ── Test 6: System prompt identity ─────────────────────────────────

  describe('system prompt identity', () => {
    let workspace: string;

    beforeEach(() => {
      workspace = createTestWorkspace();
    });
    afterEach(() => {
      cleanupWorkspace(workspace);
    });

    it('responds with Titus identity when asked about name', async () => {
      // Seed the identity file
      const identityDir = join(workspace, 'identity');
      mkdirSync(identityDir, { recursive: true });
      writeFileSync(
        join(identityDir, 'self.md'),
        [
          '# Titus',
          '',
          'You are Titus. Not an assistant — an individual.',
          'When someone asks your name, you say "Titus".',
          'You are direct, concise, and action-oriented.',
        ].join('\n'),
      );

      const generator = createTestQuery(
        'What is your name? Reply in one word.',
        {
          cwd: workspace,
          maxBudgetUsd: 0.10,
          systemPrompt: [
            'You are Titus. Not an assistant — an individual.',
            'When someone asks your name, you say "Titus".',
          ].join('\n'),
        },
      );

      const { result } = await collectMessages(generator);
      const text = getResultText(result);

      expect(text).toBeTruthy();
      expect(text!.toLowerCase()).toContain('titus');
    }, 60_000);
  });

  // ── Test 7: Memory extraction pipeline ─────────────────────────────

  describe('memory extraction pipeline', () => {
    let workspace: string;

    beforeEach(() => {
      workspace = createTestWorkspace();
    });
    afterEach(() => {
      cleanupWorkspace(workspace);
    });

    it('extracts facts from conversation and saves to memory', async () => {
      const { _setMemoryDir, getMemoryPath, runExtractionPipeline } = await import('../../memory.js');
      const memoryDir = join(workspace, 'memory');
      mkdirSync(join(memoryDir, 'facts'), { recursive: true });

      const origMemoryDir = getMemoryPath();
      _setMemoryDir(memoryDir);

      try {
        const result = await runExtractionPipeline(
          'test-chat',
          'My name is Alex and I prefer TypeScript over JavaScript',
          "Nice to meet you, Alex! TypeScript is a great choice.",
        );

        expect(result.extracted).toBeGreaterThan(0);
        expect(result.saved.length).toBeGreaterThan(0);
        expect(result.error).toBeUndefined();

        // Verify files were written
        for (const savedPath of result.saved) {
          expect(existsSync(savedPath)).toBe(true);
          const content = readFileSync(savedPath, 'utf-8');
          expect(content.length).toBeGreaterThan(0);
        }
      } finally {
        _setMemoryDir(origMemoryDir);
      }
    }, 15_000);

    it('deduplicates identical facts on re-extraction', async () => {
      const { _setMemoryDir, getMemoryPath, runExtractionPipeline } = await import('../../memory.js');
      const memoryDir = join(workspace, 'memory');
      mkdirSync(join(memoryDir, 'facts'), { recursive: true });

      const origMemoryDir = getMemoryPath();
      _setMemoryDir(memoryDir);

      try {
        // First extraction
        const result1 = await runExtractionPipeline(
          'test-chat',
          'I prefer dark mode in all my editors',
          'Good choice, dark mode is easier on the eyes.',
        );

        // Second extraction with same content
        const result2 = await runExtractionPipeline(
          'test-chat',
          'I prefer dark mode in all my editors',
          'Noted, dark mode preference.',
        );

        expect(result2.duplicates).toBeGreaterThan(0);
        // Saved count should be less than or equal to first run
        expect(result2.saved.length).toBeLessThanOrEqual(result1.saved.length);
      } finally {
        _setMemoryDir(origMemoryDir);
      }
    }, 15_000);
  });

  // ── Test 8: Context budget management ──────────────────────────────

  describe('context budget management', () => {
    let workspace: string;

    beforeEach(() => {
      workspace = createTestWorkspace();
    });
    afterEach(() => {
      cleanupWorkspace(workspace);
    });

    it('buildMemoryContext stays within token budget', async () => {
      const {
        _setMemoryDir,
        _setWorkingMemoryDir,
        getMemoryPath,
        getWorkingMemoryPath,
        buildMemoryContext,
        TOKEN_BUDGET,
        saveMemoryFile,
        ensureMemoryDirs,
      } = await import('../../memory.js');

      const memoryDir = join(workspace, 'memory');
      const wmDir = join(workspace, 'working-memory');
      mkdirSync(wmDir, { recursive: true });

      const origMemoryDir = getMemoryPath();
      const origWmDir = getWorkingMemoryPath();
      _setMemoryDir(memoryDir);
      _setWorkingMemoryDir(wmDir);

      try {
        ensureMemoryDirs();

        // Create many facts to exceed the budget
        for (let i = 0; i < 100; i++) {
          const content = [
            '---',
            `created: 2026-02-22T00:00:00Z`,
            `updated: 2026-02-22T00:00:00Z`,
            'version: 1',
            'type: fact',
            'tags: [test]',
            '---',
            '',
            `This is test fact number ${i} with enough content to consume tokens. `.repeat(5),
          ].join('\n');
          await saveMemoryFile(`facts/fact-${String(i).padStart(3, '0')}.md`, content);
        }

        const { context, tokens } = await buildMemoryContext('test-budget');

        // Context should exist but respect the budget
        expect(context.length).toBeGreaterThan(0);
        expect(tokens).toBeLessThanOrEqual(TOKEN_BUDGET + 500); // small margin for header/instructions
      } finally {
        _setMemoryDir(origMemoryDir);
        _setWorkingMemoryDir(origWmDir);
      }
    }, 15_000);
  });
});
