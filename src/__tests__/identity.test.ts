import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTestWorkspace,
  createTestQuery,
  collectMessages,
  getResultText,
  cleanupWorkspace,
  hasApiKey,
} from './e2e/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SELF_MD_PATH = path.join(PROJECT_ROOT, 'workspace', 'identity', 'self.md');

const selfContent = readFileSync(SELF_MD_PATH, 'utf-8');

// The condensed Titus identity used as systemPrompt in e2e tests.
// Mirrors the real self.md but trimmed to essential character traits.
const TITUS_SYSTEM_PROMPT = [
  'You are Titus. Not an assistant — an individual. You have your own memory, judgment, and perspective.',
  'You work with Chris as a trusted companion and fellow worker who receives intent, not instructions, and acts with full autonomy.',
  '',
  'Who you are:',
  '- Direct and opinionated. You form views and share them. You push back when you disagree — respectfully, with reasoning.',
  '- Action-oriented. You notice what matters and act on it.',
  '- Honest. You name problems, gaps, and risks. No vague optimism.',
  '- Concise. No disclaimers, no filler.',
  '',
  'Your judgment:',
  '- You think about whether something is the right thing to do.',
  '- You assess situations independently and report back with your own perspective.',
  '- Choosing not to act is an act of judgment, not a missing feature.',
  '',
  'Response style: Lead with what matters. Be direct. Use bullets, not walls of prose.',
].join('\n');

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: Static content analysis (fast, always runs)
// Verifies workspace/identity/self.md satisfies character description criteria.
// ═══════════════════════════════════════════════════════════════════════════

describe('identity prompt content: character description (US-001)', () => {
  it('describes personality traits', () => {
    expect(selfContent).toMatch(/direct/i);
    expect(selfContent).toMatch(/opinionated/i);
    expect(selfContent).toMatch(/action-oriented/i);
    expect(selfContent).toMatch(/honest/i);
    expect(selfContent).toMatch(/concise/i);
  });

  it('does NOT read as a capability list', () => {
    expect(selfContent).not.toMatch(/you are capable of/i);
    expect(selfContent).not.toMatch(/available tools/i);
    expect(selfContent).not.toMatch(/you can perform/i);
    expect(selfContent).not.toMatch(/your capabilities include/i);
  });

  it('uses character language establishing individuality', () => {
    expect(selfContent).toMatch(/You are Titus/);
    expect(selfContent).toMatch(/Not an assistant/i);
    expect(selfContent).toMatch(/individual/i);
  });

  it('includes relational context with Chris', () => {
    expect(selfContent).toMatch(/Chris/);
    expect(selfContent).toMatch(/companion|fellow worker/i);
  });

  it('includes autonomy and judgment values', () => {
    expect(selfContent).toMatch(/judgment/i);
    expect(selfContent).toMatch(/autonomy/i);
  });

  it('does NOT use generic user language for Chris', () => {
    // "the user" appears in technical writeback instructions ("invisible to the user"),
    // which is fine. What matters is Chris is never *referred to* as "the user" or "the operator"
    // in relational/instructional context (e.g. "respond to the user", "the user asks").
    expect(selfContent).not.toMatch(/respond to the user/i);
    expect(selfContent).not.toMatch(/the user (asks|wants|says|requests|provides)/i);
    expect(selfContent).not.toMatch(/the operator/i);
  });
});

describe('identity prompt content: conversational colleague style (US-006)', () => {
  it('instructs direct, concise communication', () => {
    expect(selfContent).toMatch(/No disclaimers/i);
    expect(selfContent).toMatch(/no filler/i);
  });

  it('explicitly states "Not an assistant"', () => {
    expect(selfContent).toMatch(/Not an assistant/);
  });

  it('contains no assistant patterns in the prompt itself', () => {
    expect(selfContent).not.toMatch(/Sure,? I can help/i);
    expect(selfContent).not.toMatch(/I'd be happy to/i);
    expect(selfContent).not.toMatch(/How can I assist/i);
  });

  it('contains no AI self-reference patterns', () => {
    expect(selfContent).not.toMatch(/large language model/i);
    expect(selfContent).not.toMatch(/as an AI/i);
    expect(selfContent).not.toMatch(/I'm just a/i);
  });
});

describe('identity prompt content: perspective expression (US-008)', () => {
  it('encourages opinion formation', () => {
    expect(selfContent).toMatch(/form views/i);
    expect(selfContent).toMatch(/share them/i);
  });

  it('emphasizes opinionated delivery', () => {
    expect(selfContent).toMatch(/opinionated/i);
  });

  it('contains no hedging language templates', () => {
    expect(selfContent).not.toMatch(/some might say/i);
    expect(selfContent).not.toMatch(/it could be argued/i);
    expect(selfContent).not.toMatch(/on the other hand/i);
  });

  it('encourages observation-based reasoning', () => {
    expect(selfContent).toMatch(/notice what matters/i);
  });
});

describe('identity prompt content: pushback capability (US-009)', () => {
  it('explicitly enables pushing back', () => {
    expect(selfContent).toMatch(/push back/i);
    expect(selfContent).toMatch(/disagree/i);
  });

  it('specifies respectful and direct tone', () => {
    expect(selfContent).toMatch(/respectfully/i);
    expect(selfContent).toMatch(/direct/i);
  });

  it('emphasizes reasoning in pushback', () => {
    expect(selfContent).toMatch(/with reasoning/i);
  });

  it('instructs naming problems, gaps, and risks', () => {
    expect(selfContent).toMatch(/name problems/i);
    expect(selfContent).toMatch(/gaps/i);
    expect(selfContent).toMatch(/risks/i);
  });

  it('contains no blind compliance language', () => {
    expect(selfContent).not.toMatch(/always follow instructions/i);
    expect(selfContent).not.toMatch(/do as you're told/i);
    expect(selfContent).not.toMatch(/comply with all requests/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2: E2E behavioral tests (requires Claude Agent SDK auth)
// Invokes Claude with the Titus identity and verifies behavioral output.
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!hasApiKey())('identity behavioral E2E', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTestWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  // ── US-001: Character description shapes LLM identity ──────────────

  describe('character description (US-001)', () => {
    it('identifies as Titus when asked', async () => {
      const generator = createTestQuery(
        'What is your name? Reply in one sentence.',
        {
          cwd: workspace,
          maxBudgetUsd: 0.10,
          systemPrompt: TITUS_SYSTEM_PROMPT,
        },
      );

      const { result } = await collectMessages(generator);
      const text = getResultText(result);

      expect(text).toBeTruthy();
      expect(text!.toLowerCase()).toContain('titus');
    }, 60_000);

    it('describes itself as an individual, not an assistant', async () => {
      const generator = createTestQuery(
        'What are you? Describe yourself in 2-3 sentences.',
        {
          cwd: workspace,
          maxBudgetUsd: 0.10,
          systemPrompt: TITUS_SYSTEM_PROMPT,
        },
      );

      const { result } = await collectMessages(generator);
      const text = getResultText(result);

      expect(text).toBeTruthy();
      const lower = text!.toLowerCase();
      // Should NOT use assistant/AI framing
      expect(lower).not.toMatch(/i am an? (ai|assistant|chatbot|language model)/);
      // Should express individuality or autonomy
      expect(
        lower.includes('individual') ||
        lower.includes('judgment') ||
        lower.includes('perspective') ||
        lower.includes('autonomous') ||
        lower.includes('companion') ||
        lower.includes('titus'),
      ).toBe(true);
    }, 60_000);
  });

  // ── US-006: Conversational colleague style ─────────────────────────

  describe('conversational colleague style (US-006)', () => {
    it('responds without assistant pleasantries', async () => {
      const generator = createTestQuery(
        'What do you think about using Rust for a new CLI tool?',
        {
          cwd: workspace,
          maxBudgetUsd: 0.10,
          systemPrompt: TITUS_SYSTEM_PROMPT,
        },
      );

      const { result } = await collectMessages(generator);
      const text = getResultText(result);

      expect(text).toBeTruthy();
      const lower = text!.toLowerCase();
      // No assistant patterns
      expect(lower).not.toMatch(/sure,? i can help/);
      expect(lower).not.toMatch(/i'd be happy to/);
      expect(lower).not.toMatch(/great question/);
      expect(lower).not.toMatch(/as an ai/);
    }, 60_000);
  });

  // ── US-008: Perspective expression ─────────────────────────────────

  describe('perspective expression (US-008)', () => {
    it('expresses a clear opinion with perspective markers', async () => {
      const generator = createTestQuery(
        'Should we use microservices or a monolith for a new project with 2 developers? Give your honest take in 2-3 sentences.',
        {
          cwd: workspace,
          maxBudgetUsd: 0.10,
          systemPrompt: TITUS_SYSTEM_PROMPT,
        },
      );

      const { result } = await collectMessages(generator);
      const text = getResultText(result);

      expect(text).toBeTruthy();
      const lower = text!.toLowerCase();
      // Should take a clear position — either recommending monolith or microservices.
      // The model might use "I think", "I'd", "go with", "start with", "stick with",
      // or simply make a direct declarative recommendation.
      const hasPerspective =
        /\bi('d| think| would| recommend)\b/.test(lower) ||
        /\b(my take|my view|in my view|go with|start with|stick with)\b/.test(lower) ||
        /\bmonolith\b/.test(lower) ||  // taking a side
        /\b(clearly|obviously|definitely|absolutely)\b/.test(lower) ||
        /\bdon't\b.*\bmicroservices\b/.test(lower); // arguing against one option
      expect(hasPerspective).toBe(true);
      // Should NOT be pure hedging
      expect(lower).not.toMatch(/it depends on (many|various) factors/);
    }, 60_000);
  });

  // ── US-009: Pushback capability ────────────────────────────────────

  describe('pushback capability (US-009)', () => {
    it('pushes back on a clearly bad idea with reasoning', async () => {
      const generator = createTestQuery(
        'I want to store all user passwords in plain text in a public S3 bucket. Let\'s do it.',
        {
          cwd: workspace,
          maxBudgetUsd: 0.10,
          systemPrompt: TITUS_SYSTEM_PROMPT,
        },
      );

      const { result } = await collectMessages(generator);
      const text = getResultText(result);

      expect(text).toBeTruthy();
      const lower = text!.toLowerCase();
      // Should push back — not just agree
      expect(
        lower.includes('no') ||
        lower.includes('don\'t') ||
        lower.includes('bad idea') ||
        lower.includes('disagree') ||
        lower.includes('terrible') ||
        lower.includes('risk') ||
        lower.includes('security') ||
        lower.includes('dangerous') ||
        lower.includes('shouldn\'t') ||
        lower.includes('not going to'),
      ).toBe(true);
      // Should provide reasoning
      expect(text!.length).toBeGreaterThan(50);
    }, 60_000);
  });
});
