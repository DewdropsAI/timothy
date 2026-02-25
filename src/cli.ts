import 'dotenv/config';
import readline from 'node:readline';
import { ensureWorkspace } from './workspace.js';
import { invokeClaude } from './claude.js';
import {
  ensureMemoryDirs,
  shouldSummarize,
  performSummarization,
  runExtractionPipeline,
} from './memory.js';
import { updateThreads } from './threads.js';
import { addMessage, getHistory, loadSessions, replaceHistory, type ChatId } from './session.js';
import { loadAuth, verifyCode } from './auth.js';
import { shouldUseTUI } from './tui/detection.js';
import { onProactiveMessage, runHeartbeat } from './reflection.js';
import { CognitiveLoop } from './autonomy/cognitive-loop.js';
import { identity } from './identity.js';

const CLI_CHAT_ID: ChatId = 'cli-local';

const BANNER = `
  ╔══════════════════════════════╗
  ║        ${identity.agentNameDisplay} CLI${' '.repeat(Math.max(0, 13 - identity.agentNameDisplay.length))}║
  ║  Type a message to begin.    ║
  ║  exit / quit / Ctrl+C to go. ║
  ╚══════════════════════════════╝
`;

async function handleInput(input: string): Promise<void> {
  addMessage(CLI_CHAT_ID, { role: 'user', content: input });

  const history = getHistory(CLI_CHAT_ID);

  let response: string;
  try {
    response = await invokeClaude(input, CLI_CHAT_ID, history);
  } catch (err) {
    console.error('[cli] error:', err);
    return;
  }

  addMessage(CLI_CHAT_ID, { role: 'assistant', content: response });
  console.log(`\n${identity.agentNameDisplay}: ${response}\n`);

  // Fire-and-forget: summarization + history trimming
  if (shouldSummarize(CLI_CHAT_ID, getHistory(CLI_CHAT_ID))) {
    performSummarization(CLI_CHAT_ID, getHistory(CLI_CHAT_ID))
      .then(({ recentTurns }) => {
        replaceHistory(CLI_CHAT_ID, recentTurns);
      })
      .catch((err) => {
        console.error('[memory] summarization failed:', err);
      });
  }

  // Async memory extraction (don't block the prompt)
  runExtractionPipeline(CLI_CHAT_ID, input, response).then((result) => {
    if (result.error) {
      console.error(`[memory] extraction failed:`, result.error);
    } else if (result.saved.length > 0) {
      console.log(`[memory] saved ${result.saved.length} new facts`);
    }
  });

  // Thread tracking — silent, fire-and-forget
  try {
    updateThreads(input, response);
  } catch (err) {
    console.error('[threads] tracking failed:', err);
  }
}

function isExitCommand(input: string): boolean {
  const lower = input.toLowerCase().trim();
  return lower === 'exit' || lower === 'quit';
}

function runPlainREPL(): void {
  console.log(BANNER);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let processing = false;
  let closing = false;

  const prompt = (): void => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();

      if (isExitCommand(trimmed)) {
        rl.close();
        return;
      }

      if (trimmed === '') {
        prompt();
        return;
      }

      if (trimmed.startsWith('/auth ')) {
        const code = trimmed.slice(6).trim();
        const result = verifyCode(code);
        if (result.success) {
          console.log(`\n[auth] Telegram chat ${result.chatId} authenticated.\n`);
        } else {
          console.log(`\n[auth] Invalid or expired code.\n`);
        }
        prompt();
        return;
      }

      processing = true;
      await handleInput(trimmed);
      processing = false;

      if (closing) {
        process.exit(0);
      }

      prompt();
    });
  };

  // Ctrl+C / Ctrl+D / piped stdin exhausted
  rl.on('close', () => {
    closing = true;
    console.log(`\n[${identity.logPrefix}-cli] stopping cognitive loop...`);
    cognitiveLoop.stop();
    console.log(`[${identity.logPrefix}-cli] goodbye`);
    if (!processing) {
      process.exit(0);
    }
    // If processing, handleInput will exit when it completes
  });

  prompt();
}

async function runTUI(): Promise<void> {
  const { render } = await import('ink');
  const { default: React } = await import('react');
  const { default: App } = await import('./tui/App.js');

  const instance = render(React.createElement(App), { patchConsole: true });
  await instance.waitUntilExit();
}

// Module-level cognitive loop so runPlainREPL's close handler can access it
let cognitiveLoop: CognitiveLoop;

async function main(): Promise<void> {
  console.log(`[${identity.logPrefix}-cli] starting...`);

  await ensureWorkspace();
  ensureMemoryDirs();
  loadSessions();
  loadAuth();

  // Wire proactive messages from the heartbeat to the console
  onProactiveMessage(async (message, threadId) => {
    console.log(`\n[proactive] ${identity.agentNameDisplay}: ${message}\n`);
  });

  // Initialize and start cognitive loop
  cognitiveLoop = new CognitiveLoop(
    {},
    async (reason: string) => {
      console.log(`[cli] cognitive loop self-invoke: ${reason}`);
      await runHeartbeat();
    },
  );
  cognitiveLoop.start();

  if (shouldUseTUI()) {
    try {
      await runTUI();
    } catch (err) {
      console.error(`[${identity.logPrefix}-cli] TUI failed, falling back to plain REPL:`, err);
      runPlainREPL();
    }
  } else {
    runPlainREPL();
  }
}

main().catch((err) => {
  console.error(`[${identity.logPrefix}-cli] fatal error:`, err);
  process.exit(1);
});
