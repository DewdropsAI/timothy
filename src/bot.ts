import { Bot } from 'grammy';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeClaude } from './claude.js';
import { ensureMemoryDirs, shouldSummarize, performSummarization, runExtractionPipeline } from './memory.js';
import { updateThreads } from './threads.js';
import { addMessage, getHistory, loadSessions, replaceHistory } from './session.js';
import { writeStartupStatus, writeShutdownStatus, startHeartbeat, recordMessage } from './status.js';
import { loadAuth, isAuthenticated, createChallenge, getVerifiedChatIds } from './auth.js';
import { DedupSet } from './dedup.js';
import { KeyedMutex } from './mutex.js';
import { onProactiveMessage, runHeartbeat } from './reflection.js';
import { CognitiveLoop } from './autonomy/cognitive-loop.js';
import { TrustManager } from './autonomy/trust-metrics.js';
import { recordOutcome, type Outcome } from './engagement.js';
import { identity } from './identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_PATH = path.resolve(PROJECT_ROOT, 'workspace');

const TELEGRAM_MAX_LENGTH = 4096;

// Time-windowed dedup: keep IDs for 60 s so late Telegram retries are caught
const recentMessages = new DedupSet(60_000);

// Per-chat mutex: serialise the cognitive pipeline so concurrent retries
// don't race through memory extraction / summarisation at the same time
const chatMutex = new KeyedMutex();

// ── Proactive message tracking ───────────────────────────────────────

interface ProactiveMessageEntry {
  threadId: string;
  sentAt: number;
}

/**
 * Maps Telegram message_id of sent proactive messages to their metadata.
 * Used to classify Chris's replies to proactive messages.
 */
const proactiveMessageMap = new Map<number, ProactiveMessageEntry>();

/** Maximum age of entries in proactiveMessageMap before pruning (1 hour) */
const PROACTIVE_MAP_TTL_MS = 60 * 60 * 1000;

/** Time window for "no response = ignored" classification (30 minutes) */
const IGNORED_THRESHOLD_MS = 30 * 60 * 1000;

/** Prune stale entries from proactiveMessageMap */
function pruneProactiveMap(): void {
  const cutoff = Date.now() - PROACTIVE_MAP_TTL_MS;
  for (const [msgId, entry] of proactiveMessageMap) {
    if (entry.sentAt < cutoff) {
      proactiveMessageMap.delete(msgId);
    }
  }
}

// ── Response classification ──────────────────────────────────────────

const REJECTION_PATTERNS = /\b(stop|don'?t|no more|please stop|shut up|enough|quit)\b/i;
const ACK_PATTERNS = /^(ok|okay|k|thanks|thx|got it|ty|sure|yep|yeah|yup|👍|👌|✅|🙏|☑️)$/i;

/**
 * Classifies a reply to a proactive message as an engagement outcome.
 */
function classifyResponse(text: string): Outcome {
  if (REJECTION_PATTERNS.test(text)) {
    return 'rejected';
  }
  if (text.length <= 20 || ACK_PATTERNS.test(text.trim())) {
    return 'acknowledged';
  }
  return 'engaged';
}

/**
 * Split a string into chunks of at most `maxLen` characters.
 * Splits on the last newline before the limit when possible,
 * otherwise hard-splits at `maxLen`.
 */
export function splitMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split on last newline within limit
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx <= 0) {
      // No good newline break — hard split
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  return chunks;
}

export async function startBot(token: string): Promise<void> {
  const bot = new Bot(token);

  // Clear any stale webhook so Telegram doesn't send updates to both
  // a webhook endpoint AND our long-polling connection simultaneously.
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    console.log(`[${identity.logPrefix}] cleared webhook (if any) — long-polling only`);
  } catch (err) {
    console.warn(`[${identity.logPrefix}] failed to clear webhook:`, err);
  }

  // Only handle private chat text messages
  bot.on('message:text', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const updateId = ctx.update.update_id;

    console.log(`[dedup] incoming update_id=${updateId} message_id=${messageId} chat=${chatId} text=${JSON.stringify(text.slice(0, 50))}`);

    // Serialise per chat — dedup check MUST be inside the mutex so
    // concurrent retries can't both pass isDuplicate() before either records
    await chatMutex.run(chatId, async () => {
      if (recentMessages.isDuplicate(chatId, messageId)) {
        console.log(`[dedup] DROPPED duplicate message_id=${messageId} chat=${chatId}`);
        return;
      }
      console.log(`[dedup] ACCEPTED message_id=${messageId} chat=${chatId}`);

      if (!isAuthenticated(chatId)) {
        const code = createChallenge(chatId);
        await ctx.reply(
          `To verify your identity, enter this code in the ${identity.agentNameDisplay} CLI:\n\n` +
          `/auth ${code}\n\n` +
          `The code expires in 10 minutes.`,
        );
        return;
      }
      // Store the user message and track stats
      addMessage(chatId, { role: 'user', content: text });
      recordMessage();

      // ── Classify response to proactive messages ──────────────
      const replyToId = ctx.message.reply_to_message?.message_id;
      if (replyToId && proactiveMessageMap.has(replyToId)) {
        const entry = proactiveMessageMap.get(replyToId)!;
        const classification = classifyResponse(text);
        console.log(`[trust] proactive response classified: ${classification} (thread=${entry.threadId})`);

        // Update engagement tracking with classified outcome
        recordOutcome(
          `proactive-${entry.threadId}-${Date.now()}`,
          'stale-thread-followup',
          classification,
        );

        // Feed signal into trust manager
        const signalType = classification === 'engaged' || classification === 'acknowledged'
          ? 'positive' as const
          : 'negative' as const;
        trustManager.recordSignal({
          type: signalType,
          value: 0.05,
          source: `proactive-response:${entry.threadId}`,
        });
        try {
          await trustManager.save();
        } catch (err) {
          console.error('[trust] failed to save trust metrics:', err);
        }

        proactiveMessageMap.delete(replyToId);
      }

      // Show typing indicator
      await ctx.replyWithChatAction('typing');

      try {
        const history = getHistory(chatId);
        const response = await invokeClaude(text, chatId, history);

        // Store the assistant response
        addMessage(chatId, { role: 'assistant', content: response });

        // Split and send response — guard against empty (Telegram rejects empty text)
        if (response.trim().length === 0) {
          console.warn(`[bot] chat=${chatId} empty response from Claude, sending fallback`);
          await ctx.reply('(I had a thought but couldn\'t put it into words. Try again?)');
        } else {
          const chunks = splitMessage(response);
          for (const chunk of chunks) {
            if (chunk.trim().length > 0) {
              await ctx.reply(chunk);
            }
          }
        }

        // Summarization & extraction run inside the mutex so concurrent
        // messages for the same chat don't race through memory writes.
        if (shouldSummarize(chatId, getHistory(chatId))) {
          try {
            const { recentTurns } = await performSummarization(chatId, getHistory(chatId));
            replaceHistory(chatId, recentTurns);
          } catch (err) {
            console.error('[memory] summarization failed:', err);
          }
        }

        try {
          const result = await runExtractionPipeline(chatId, text, response);
          if (result.error) {
            console.error(`[memory] extraction failed for chat ${chatId}:`, result.error);
          } else if (result.saved.length > 0) {
            console.log(`[memory] chat ${chatId}: saved ${result.saved.length} new facts`);
          }
        } catch (err) {
          console.error(`[memory] extraction failed for chat ${chatId}:`, err);
        }

        // Thread tracking — silent, never blocks the response
        try {
          updateThreads(text, response);
        } catch (err) {
          console.error(`[threads] tracking failed for chat ${chatId}:`, err);
        }
      } catch (err) {
        console.error('Error processing message:', err);
        await ctx.reply('Sorry, something went wrong while processing your message.');
      }
    });
  });

  // Handle non-text messages in private chats (with dedup)
  bot.on('message', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const updateId = ctx.update.update_id;

    console.log(`[dedup] incoming non-text update_id=${updateId} message_id=${messageId} chat=${chatId}`);

    await chatMutex.run(chatId, async () => {
      if (recentMessages.isDuplicate(chatId, messageId)) {
        console.log(`[dedup] DROPPED duplicate non-text message_id=${messageId} chat=${chatId}`);
        return;
      }

      await ctx.reply('I only support text messages for now.');
    });
  });

  // Initialize cognitive loop — runs the reflection heartbeat via the new
  // attention-based evaluation engine instead of a fixed-interval timer.
  const cognitiveLoop = new CognitiveLoop(
    {},
    async (reason: string) => {
      console.log(`[bot] cognitive loop self-invoke: ${reason}`);
      await runHeartbeat();
    },
  );

  // Graceful shutdown
  const shutdown = async () => {
    console.log(`[${identity.logPrefix}] shutting down...`);
    recentMessages.dispose();
    cognitiveLoop.stop();
    writeShutdownStatus();
    bot.stop();
    console.log(`[${identity.logPrefix}] disconnected from Telegram`);
    console.log(`[${identity.logPrefix}] goodbye`);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Initialize memory directory structure, then restore saved sessions
  ensureMemoryDirs();
  loadSessions();
  loadAuth();
  writeStartupStatus();
  startHeartbeat();

  // Initialize trust manager for recording engagement signals
  const trustManager = new TrustManager(WORKSPACE_PATH);
  await trustManager.load();
  // Wire proactive messages from the heartbeat to Telegram
  onProactiveMessage(async (message, threadId) => {
    const chatIds = getVerifiedChatIds();
    for (const chatId of chatIds) {
      const chunks = splitMessage(message);
      let lastSentId: number | undefined;
      for (const chunk of chunks) {
        if (chunk.trim().length > 0) {
          const sent = await bot.api.sendMessage(chatId, chunk);
          lastSentId = sent.message_id;
        }
      }
      // Track the last sent message so we can classify replies
      if (lastSentId !== undefined) {
        proactiveMessageMap.set(lastSentId, {
          threadId,
          sentAt: Date.now(),
        });
      }
    }
    // Prune stale tracking entries
    pruneProactiveMap();

    // Check for ignored proactive messages (no response within threshold)
    const now = Date.now();
    for (const [msgId, entry] of proactiveMessageMap) {
      if (now - entry.sentAt > IGNORED_THRESHOLD_MS) {
        console.log(`[trust] proactive message ignored (thread=${entry.threadId})`);
        recordOutcome(
          `proactive-${entry.threadId}-${Date.now()}`,
          'stale-thread-followup',
          'ignored',
        );
        trustManager.recordSignal({
          type: 'negative',
          value: 0.05,
          source: `proactive-response:${entry.threadId}`,
        });
        try {
          await trustManager.save();
        } catch (err) {
          console.error('[trust] failed to save trust metrics:', err);
        }
        proactiveMessageMap.delete(msgId);
      }
    }
  });

  cognitiveLoop.start();
  await bot.start({
    onStart: (botInfo) => {
      console.log(`[${identity.logPrefix}] connected as @${botInfo.username} (pid=${process.pid})`);
    },
  });
}
