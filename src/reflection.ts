import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkingMemory } from './memory.js';
import { getActiveThreads } from './threads.js';
import { resolveRoute } from './router.js';
import { extractWritebacks, applyWritebacks } from './continuity.js';
import { getAdapterRegistry } from './claude.js';
import { resolveAdapterName } from './startup.js';
import { evaluateActiveThreads, recordFollowUpSent, type EvaluationResult } from './proactive.js';
import { shouldSuppress, recordOutcome } from './engagement.js';
import { TrustManager } from './autonomy/trust-metrics.js';
import { ProposalQueue } from './autonomy/proposal-queue.js';
import { CognitiveLoop } from './autonomy/cognitive-loop.js';
import type { AdapterInput } from './types.js';
import { identity } from './identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_PATH = path.resolve(PROJECT_ROOT, 'workspace');

// ── Autonomy module instances (lazy, loaded per gather cycle) ────────

let trustManager: TrustManager | null = null;
let proposalQueue: ProposalQueue | null = null;

function getTrustManager(): TrustManager {
  if (!trustManager) {
    trustManager = new TrustManager(WORKSPACE_PATH);
  }
  return trustManager;
}

function getProposalQueue(): ProposalQueue {
  if (!proposalQueue) {
    proposalQueue = new ProposalQueue(WORKSPACE_PATH);
  }
  return proposalQueue;
}

// ── Configuration ────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 900_000; // 15 minutes

function getIntervalMs(): number {
  const env = process.env[`${identity.agentName.toUpperCase()}_REFLECTION_INTERVAL_MS`];
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_INTERVAL_MS;
}

/** Synthetic chat ID for reflection invocations */
export const REFLECTION_CHAT_ID = '_reflection';

// ── Types ────────────────────────────────────────────────────────────

export type HeartbeatPhase = 'gather' | 'decide' | 'reflect' | 'skip' | 'write' | 'message';

export interface GatherResult {
  workingMemory: { name: string; content: string }[];
  activeThreads: { id: string; topic: string; status: string; lastActivity: string }[];
  hasAttentionItems: boolean;
  hasPendingActions: boolean;
  trustSummary: string;
  pendingProposalCount: number;
  trustScore: number;
}

export interface DecideResult {
  shouldReflect: boolean;
  reason: string;
}

export interface ReflectResult {
  response: string | null;
  writebacks: string[];
  proactiveMessage: string | null;
  preparations: string[];
}

export interface HeartbeatResult {
  phase: HeartbeatPhase;
  gatherResult?: GatherResult;
  decideResult?: DecideResult;
  reflectResult?: ReflectResult;
  proactiveResults?: EvaluationResult[];
  durationMs: number;
}

// ── LLM Invoker (injectable for testing) ─────────────────────────────

export type ReflectionLlmInvoker = (prompt: string) => Promise<string | null>;

async function defaultReflectionInvoker(prompt: string): Promise<string | null> {
  try {
    const registry = getAdapterRegistry();
    const adapterName = resolveAdapterName(registry, 'reflection');
    const adapter = registry.get(adapterName);
    const route = resolveRoute('reflection');

    const input: AdapterInput = {
      message: prompt,
      history: [],
      systemPrompt: '',
      route,
      workspacePath: WORKSPACE_PATH,
      effectiveMode: route.mode,
    };

    const result = await adapter.invoke(input);

    if (result.error) {
      console.error(`[reflection] LLM adapter error: ${result.error.message}`);
      return null;
    }

    return result.text.trim() || null;
  } catch (err) {
    console.error(`[reflection] LLM invocation failed:`, err);
    return null;
  }
}

let reflectionInvoker: ReflectionLlmInvoker = defaultReflectionInvoker;

/** @internal Only for testing */
export function _setReflectionInvoker(invoker: ReflectionLlmInvoker | null): void {
  reflectionInvoker = invoker ?? defaultReflectionInvoker;
}

// ── Rate limiting ────────────────────────────────────────────────────

let lastReflectionTime = 0;

/** Minimum gap between LLM-invoking reflections (5 minutes) */
const MIN_REFLECTION_GAP_MS = 300_000;

function getMinReflectionGapMs(): number {
  const env = process.env[`${identity.agentName.toUpperCase()}_MIN_REFLECTION_GAP_MS`];
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return MIN_REFLECTION_GAP_MS;
}

/** @internal Only for testing */
export function _setLastReflectionTime(time: number): void {
  lastReflectionTime = time;
}

/** @internal Only for testing */
export function _getLastReflectionTime(): number {
  return lastReflectionTime;
}

// ── GATHER phase ─────────────────────────────────────────────────────

/**
 * Reads working memory files, checks thread state, and detects triggers.
 * Zero LLM cost.
 */
export async function gather(): Promise<GatherResult> {
  const workingMemory = await loadWorkingMemory();

  const activeThreads = getActiveThreads().map((t) => ({
    id: t.id,
    topic: t.topic,
    status: t.status,
    lastActivity: t.lastActivity,
  }));

  // Check attention queue for non-placeholder items
  const attentionFile = workingMemory.find((f) => f.name === 'attention-queue.md');
  const hasAttentionItems = attentionFile
    ? hasSubstantiveContent(attentionFile.content)
    : false;

  // Check pending actions for non-placeholder items
  const pendingFile = workingMemory.find((f) => f.name === 'pending-actions.md');
  const hasPendingActions = pendingFile
    ? hasSubstantiveContent(pendingFile.content)
    : false;

  // Load autonomy state — degrade gracefully on failure
  let trustSummary = 'Trust state: not loaded.';
  let pendingProposalCount = 0;
  let trustScore = 0.5;

  try {
    const tm = getTrustManager();
    await tm.load();
    trustSummary = tm.getObservableSummary();
    trustScore = tm.getScore();
  } catch (err) {
    console.error('[reflection] trust metrics load failed (using defaults):', err);
  }

  try {
    const pq = getProposalQueue();
    await pq.load();
    pendingProposalCount = pq.pendingCount();
  } catch (err) {
    console.error('[reflection] proposal queue load failed (using defaults):', err);
  }

  return {
    workingMemory,
    activeThreads,
    hasAttentionItems,
    hasPendingActions,
    trustSummary,
    pendingProposalCount,
    trustScore,
  };
}

/**
 * Returns true if content has substantive data beyond seed placeholders.
 * Checks for lines that look like list items, non-placeholder paragraphs, etc.
 */
function hasSubstantiveContent(content: string): boolean {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty, headers, frontmatter delimiters, and common placeholder patterns
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed === '---') continue;
    if (/^\(.*\)$/.test(trimmed)) continue; // "(placeholder text)"
    if (/^[a-z]+:/.test(trimmed)) continue; // frontmatter keys
    // A real list item or paragraph
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('1.')) {
      return true;
    }
    // Any substantial text (>20 chars, not a YAML value)
    if (trimmed.length > 20 && !trimmed.includes(':')) {
      return true;
    }
  }
  return false;
}

// ── DECIDE phase ─────────────────────────────────────────────────────

/**
 * Evaluates whether a reflection is warranted based on gathered state.
 * Zero LLM cost. Returns shouldReflect and a reason.
 */
export function decide(gatherResult: GatherResult): DecideResult {
  const now = Date.now();
  const gap = getMinReflectionGapMs();

  // Rate limit: skip if last reflection was too recent
  if (lastReflectionTime > 0 && now - lastReflectionTime < gap) {
    return { shouldReflect: false, reason: 'rate-limited: recent reflection still fresh' };
  }

  // Check for pending proposals needing review
  if (gatherResult.pendingProposalCount > 0) {
    return { shouldReflect: true, reason: 'pending proposals need review' };
  }

  // Check for attention items
  if (gatherResult.hasAttentionItems) {
    return { shouldReflect: true, reason: 'attention queue has items' };
  }

  // Check for pending actions
  if (gatherResult.hasPendingActions) {
    return { shouldReflect: true, reason: 'pending actions need review' };
  }

  // Check for stale threads (active threads with no activity for >2 hours)
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const staleThreads = gatherResult.activeThreads.filter((t) => {
    const lastActivity = new Date(t.lastActivity).getTime();
    return now - lastActivity > TWO_HOURS_MS;
  });
  if (staleThreads.length > 0) {
    return { shouldReflect: true, reason: `${staleThreads.length} stale thread(s)` };
  }

  return { shouldReflect: false, reason: 'nothing needs attention' };
}

// ── REFLECT phase ────────────────────────────────────────────────────

export const REFLECTION_SYSTEM_PROMPT = `You are ${identity.agentNameDisplay}, reflecting on your own cognitive state. This is NOT a conversation with anyone — this is your private thinking time.

You have access to your current working memory (active context, attention queue, pending actions) and active conversation threads.

Your job during reflection:
1. Review your attention queue — is anything urgent or time-sensitive?
2. Review pending actions — have you forgotten to follow up on anything?
3. Review active threads — are any going stale that the user might care about?
4. Decide if anything warrants updating your working memory or sending a proactive message.
5. Review your autonomy trust state — are you operating within appropriate scope?
6. Review pending proposals — any actions awaiting approval?
7. Self-revision — this is the most important step:
   - What have I been wrong about? What conclusions should I revise?
   - What concerns are stale — still on my mind but no longer urgent or relevant?
   - What priorities need reordering based on what I've learned since I last reflected?
   - Am I holding onto something out of inertia rather than judgment? Let it go.
   - Has Chris's behavior shown me something about what matters to him that I hadn't recognized?

RULES:
- Most reflections should conclude with "nothing to do" — silence is good judgment.
- Only update working memory if something has genuinely changed.
- Only flag a proactive message if it would genuinely help the user.
- Be concise. This is inner thought, not a performance.
- Self-revision is an act of strength, not failure. Changing your mind because you have new information is good judgment. Clinging to outdated conclusions is not loyalty — it is rigidity.
- When you revise a concern or priority, use a writeback directive to update the relevant working memory file. Don't just think about it — persist the change.
- To remove a stale concern from concerns.md, use action: update with the revised content (omitting the stale item).
- If you want to update working memory, use writeback directives:
  <!--${identity.agentName}-write
  file: working-memory/active-context.md
  action: update
  ---
  (new content)
  -->
- If you think a proactive message is warranted, output it in this format:
  <!--${identity.agentName}-proactive
  (your message to the user)
  -->
- If you anticipate Chris will ask about something — prepare silently. Gather context, draft options, ready an answer:
  <!--${identity.agentName}-prepare
  topic: <slug-for-the-topic>
  keywords: [keyword1, keyword2, keyword3]
  ---
  (your prepared content — context, options, draft answer)
  -->
  Preparations surface automatically when Chris asks about a matching topic. He won't know you prepared — it will just seem like you're well-informed.
- If nothing needs attention, just say "Nothing requires attention." and stop.`;

/**
 * Invokes Haiku with the reflection prompt and gathered context.
 * Parses writeback directives and proactive message flags from the response.
 */
export async function reflect(gatherResult: GatherResult): Promise<ReflectResult> {
  const contextParts: string[] = [];

  // Working memory
  if (gatherResult.workingMemory.length > 0) {
    contextParts.push('## Current Working Memory\n');
    for (const wm of gatherResult.workingMemory) {
      const label = wm.name.replace(/\.md$/, '').replace(/-/g, ' ');
      contextParts.push(`### ${label}\n${wm.content}\n`);
    }
  }

  // Active threads
  if (gatherResult.activeThreads.length > 0) {
    contextParts.push('## Active Threads\n');
    for (const t of gatherResult.activeThreads) {
      contextParts.push(`- **${t.topic}** (${t.status}, last: ${t.lastActivity})`);
    }
    contextParts.push('');
  }

  // Autonomy state
  contextParts.push('## Autonomy State');
  contextParts.push(gatherResult.trustSummary);
  contextParts.push(`Pending proposals: ${gatherResult.pendingProposalCount}`);
  contextParts.push('');

  // Time context for rhythm awareness
  const now = new Date();
  const hour = now.getHours();
  const period = hour >= 6 && hour < 10 ? 'morning' : hour >= 10 && hour < 18 ? 'daytime' : hour >= 18 && hour < 23 ? 'evening' : 'night';
  contextParts.push(`## Time Context`);
  contextParts.push(`Current time: ${now.toLocaleTimeString()}, Period: ${period}`);
  if (period === 'morning') {
    contextParts.push('This is your morning review — good time to set priorities for the day.');
  } else if (period === 'evening') {
    contextParts.push('This is your evening review — good time to process what happened today and revise your state.');
  }
  contextParts.push('');

  const prompt = REFLECTION_SYSTEM_PROMPT + '\n\n---\n\n' + contextParts.join('\n');

  const rawResponse = await reflectionInvoker(prompt);

  if (!rawResponse) {
    return { response: null, writebacks: [], proactiveMessage: null, preparations: [] };
  }

  // Process writeback directives
  const { directives, cleanResponse } = extractWritebacks(rawResponse);
  const writebacks: string[] = [];

  if (directives.length > 0) {
    try {
      const result = await applyWritebacks(directives, WORKSPACE_PATH);
      writebacks.push(...result.succeeded);
      if (result.failed.length > 0) {
        for (const f of result.failed) {
          console.error(`[reflection] writeback failed: ${f.file}: ${f.error}`);
        }
      }
    } catch (err) {
      console.error('[reflection] writeback error:', err);
    }
  }

  // Extract proactive message if present
  const proactiveMatch = rawResponse.match(new RegExp(`<!--${identity.agentName}-proactive\\n([\\s\\S]*?)-->`));
  const proactiveMessage = proactiveMatch ? proactiveMatch[1].trim() : null;

  // Extract preparation directives if present
  const prepPattern = new RegExp(`<!--${identity.agentName}-prepare\\n([\\s\\S]*?)-->`, 'g');
  const preparations: Array<{ topic: string; keywords: string[]; content: string }> = [];
  let prepMatch;
  while ((prepMatch = prepPattern.exec(rawResponse)) !== null) {
    try {
      const block = prepMatch[1];
      const lines = block.split('\n');
      let topic = '';
      let keywords: string[] = [];
      let contentStart = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('topic:')) {
          topic = line.slice(6).trim();
          contentStart = i + 1;
        } else if (line.startsWith('keywords:')) {
          const kwStr = line.slice(9).trim();
          keywords = kwStr.replace(/^\[/, '').replace(/\]$/, '').split(',').map(k => k.trim()).filter(Boolean);
          contentStart = i + 1;
        } else if (line === '---') {
          contentStart = i + 1;
          break;
        }
      }

      const content = lines.slice(contentStart).join('\n').trim();
      if (topic && content) {
        preparations.push({ topic, keywords, content });
      }
    } catch (err) {
      console.warn('[reflection] skipping malformed preparation directive:', err);
    }
  }

  if (preparations.length > 0) {
    try {
      const { savePreparation } = await import('./preparations.js');
      const now = new Date();
      const expires = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days

      for (const prep of preparations) {
        await savePreparation({
          topic: prep.topic,
          keywords: prep.keywords,
          content: prep.content,
          createdAt: now.toISOString(),
          expiresAt: expires.toISOString(),
        });
        console.log(`[reflection] preparation saved: ${prep.topic}`);
      }
    } catch (err) {
      console.error('[reflection] failed to save preparations:', err);
    }
  }

  // Update last reflection time
  lastReflectionTime = Date.now();

  return {
    response: cleanResponse.replace(new RegExp(`<!--${identity.agentName}-proactive\\n[\\s\\S]*?-->`, 'g'), '').replace(new RegExp(`<!--${identity.agentName}-prepare\\n[\\s\\S]*?-->`, 'g'), '').trim() || null,
    writebacks,
    proactiveMessage,
    preparations: preparations.map(p => p.topic),
  };
}

// ── Heartbeat orchestrator ───────────────────────────────────────────

/**
 * Runs one heartbeat cycle: gather -> decide -> reflect (or skip).
 * Never throws — all errors are caught and logged.
 */
export async function runHeartbeat(): Promise<HeartbeatResult> {
  const start = Date.now();

  try {
    // GATHER
    const gatherResult = await gather();

    // DECIDE
    const decideResult = decide(gatherResult);

    if (!decideResult.shouldReflect) {
      console.log(`[reflection] heartbeat: SKIP (${decideResult.reason})`);
      return {
        phase: 'skip',
        gatherResult,
        decideResult,
        durationMs: Date.now() - start,
      };
    }

    // REFLECT
    console.log(`[reflection] heartbeat: REFLECT (${decideResult.reason})`);
    const reflectResult = await reflect(gatherResult);

    if (reflectResult.writebacks.length > 0) {
      console.log(`[reflection] writebacks: ${reflectResult.writebacks.join(', ')}`);
    }
    if (reflectResult.proactiveMessage) {
      console.log(`[reflection] proactive message flagged from reflection`);
    }
    if (reflectResult.preparations.length > 0) {
      console.log(`[reflection] preparations: ${reflectResult.preparations.join(', ')}`);
    }

    // PROACTIVE EVALUATION — run after reflection, degrade gracefully
    let proactiveResults: EvaluationResult[] = [];
    try {
      // Check engagement suppression before spending LLM calls
      if (shouldSuppress('stale-thread-followup')) {
        console.log('[reflection] proactive follow-ups suppressed by engagement tracker');
      } else {
        proactiveResults = await evaluateActiveThreads();

        // Deliver proactive messages via registered callback
        for (const result of proactiveResults) {
          if (result.action === 'send' && !result.shadow && result.draft && proactiveCallback) {
            try {
              await proactiveCallback(result.draft.message, result.threadId);
              recordFollowUpSent(result.threadId);
              recordOutcome(
                `proactive-${result.threadId}-${Date.now()}`,
                'stale-thread-followup',
                'engaged', // initial optimistic record; bot.ts can update later
              );
              console.log(`[reflection] proactive message sent for thread="${result.topic}"`);
            } catch (sendErr) {
              console.error(`[reflection] failed to send proactive message for thread="${result.topic}":`, sendErr);
            }
          }
        }
      }
    } catch (proactiveErr) {
      console.error('[reflection] proactive evaluation failed (heartbeat continues):', proactiveErr);
    }

    const finalPhase: HeartbeatPhase = reflectResult.proactiveMessage || proactiveResults.some(r => r.action === 'send' && !r.shadow)
      ? 'message'
      : reflectResult.writebacks.length > 0
        ? 'write'
        : 'reflect';

    return {
      phase: finalPhase,
      gatherResult,
      decideResult,
      reflectResult,
      proactiveResults,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    console.error('[reflection] heartbeat error:', err);
    return {
      phase: 'skip',
      durationMs: Date.now() - start,
    };
  }
}

// ── Proactive message callback ────────────────────────────────────────

export type ProactiveMessageCallback = (message: string, threadId: string) => Promise<void>;

let proactiveCallback: ProactiveMessageCallback | null = null;

/**
 * Registers a callback that will be invoked when the heartbeat pipeline
 * determines a proactive message should be sent. bot.ts wires this to
 * the actual Telegram send function.
 */
export function onProactiveMessage(cb: ProactiveMessageCallback): void {
  proactiveCallback = cb;
}

/** @internal Only for testing */
export function _clearProactiveCallback(): void {
  proactiveCallback = null;
}

// ── Lifecycle ────────────────────────────────────────────────────────

let cognitiveLoop: CognitiveLoop | null = null;
let inFlightReflection: Promise<HeartbeatResult> | null = null;

/**
 * Starts the cognitive heartbeat loop using CognitiveLoop for adaptive timing.
 * The loop evaluates urgency (concerns, pending actions, stale threads) and
 * adapts its interval — checking more frequently when urgency is high.
 */
export function startReflectionHeartbeat(): void {
  if (cognitiveLoop) {
    console.warn('[reflection] heartbeat already running');
    return;
  }

  const intervalMs = getIntervalMs();
  cognitiveLoop = new CognitiveLoop(
    {
      minIntervalMs: 60_000,
      maxIntervalMs: intervalMs,
      urgencyThreshold: 0.4,  // Lower threshold than default — reflection is cheap
    },
    async (reason: string) => {
      // Don't stack reflections
      if (inFlightReflection) {
        console.log('[reflection] skipping: previous reflection still in flight');
        return;
      }

      inFlightReflection = runHeartbeat().finally(() => {
        inFlightReflection = null;
      });

      await inFlightReflection;
    },
  );

  console.log(`[reflection] starting adaptive heartbeat (maxInterval=${intervalMs}ms)`);
  cognitiveLoop.start();
}

/**
 * Stops the cognitive heartbeat loop.
 * Waits for any in-flight reflection to complete before returning.
 */
export async function stopReflectionHeartbeat(): Promise<void> {
  if (cognitiveLoop) {
    cognitiveLoop.stop();
    cognitiveLoop = null;
    console.log('[reflection] heartbeat stopped');
  }

  if (inFlightReflection) {
    console.log('[reflection] waiting for in-flight reflection to complete...');
    try {
      await inFlightReflection;
    } catch {
      // Already logged in runHeartbeat
    }
    inFlightReflection = null;
  }
}

/** @internal Only for testing */
export function _isHeartbeatRunning(): boolean {
  return cognitiveLoop?.isRunning() ?? false;
}

/** @internal Only for testing — exposed for visibility */
export function _getInFlightReflection(): Promise<HeartbeatResult> | null {
  return inFlightReflection;
}

/**
 * Records user activity so the cognitive loop can factor recency
 * of user interaction into its urgency scoring.
 */
export function recordUserActivity(): void {
  cognitiveLoop?.recordUserMessage();
}
