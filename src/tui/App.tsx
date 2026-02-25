import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, Static, useApp, useInput, useStdout } from 'ink';
import { invokeClaudeStreaming, applyWritebacks, getWorkspacePath, type StreamHandle } from '../claude.js';
import type { WritebackEvent } from '../writeback-parser.js';
import {
  shouldSummarize,
  performSummarization,
  runExtractionPipeline,
} from '../memory.js';
import { addMessage, getHistory, clearHistory, replaceHistory, type ChatId } from '../session.js';
import { verifyCode } from '../auth.js';
import { renderMarkdown } from '../markdown.js';
import { parseCommand } from './commands.js';
import InputEditor from './InputEditor.js';
import StreamingResponse from './StreamingResponse.js';
import { identity } from '../identity.js';

const CLI_CHAT_ID: ChatId = 'cli-local';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sentAt: Date;
}

let messageCounter = 0;

export default function App(): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [processing, setProcessing] = useState(false);
  const [streamHandle, setStreamHandle] = useState<StreamHandle | null>(null);
  const [streamAborted, setStreamAborted] = useState(false);
  const currentInputRef = useRef('');

  const appendMessage = useCallback((role: ChatMessage['role'], content: string) => {
    setMessages((prev) => [...prev, { id: ++messageCounter, role, content, sentAt: new Date() }]);
  }, []);

  const finishProcessing = useCallback(() => {
    setProcessing(false);
    setStreamHandle(null);
    setStreamAborted(false);
  }, []);

  const runPostResponseHooks = useCallback((userInput: string) => {
    const currentHistory = getHistory(CLI_CHAT_ID);
    if (shouldSummarize(CLI_CHAT_ID, currentHistory)) {
      performSummarization(CLI_CHAT_ID, currentHistory)
        .then(({ recentTurns }) => {
          replaceHistory(CLI_CHAT_ID, recentTurns);
        })
        .catch(() => {});
    }
    runExtractionPipeline(CLI_CHAT_ID, userInput, getHistory(CLI_CHAT_ID).at(-1)?.content ?? '').catch(() => {});
  }, []);

  const handleWriteback = useCallback((event: WritebackEvent) => {
    applyWritebacks([event.directive], getWorkspacePath())
      .then((result) => {
        if (result.failed.length > 0) {
          const f = result.failed[0];
          appendMessage('system', `[memory] failed to write ${f.file}: ${f.error}`);
        } else {
          appendMessage('system', `[memory] wrote ${event.directive.file}`);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        appendMessage('system', `[memory] failed to write ${event.directive.file}: ${msg}`);
      });
  }, [appendMessage]);

  const handleStreamComplete = useCallback((fullText: string) => {
    addMessage(CLI_CHAT_ID, { role: 'assistant', content: fullText });
    appendMessage('assistant', fullText);
    finishProcessing();
    runPostResponseHooks(currentInputRef.current);
  }, [appendMessage, finishProcessing, runPostResponseHooks]);

  const handleStreamError = useCallback((errorText: string, partialText: string) => {
    if (partialText) {
      appendMessage('assistant', partialText);
    }
    appendMessage('system', `[error] ${errorText}`);
    finishProcessing();
  }, [appendMessage, finishProcessing]);

  const handleStreamAborted = useCallback((_partialText: string) => {
    appendMessage('system', '[interrupted]');
    finishProcessing();
  }, [appendMessage, finishProcessing]);

  const handleSubmit = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (trimmed === '') return;

    const lower = trimmed.toLowerCase();
    if (lower === 'exit' || lower === 'quit') {
      appendMessage('system', `[${identity.logPrefix}-cli] goodbye`);
      exit();
      return;
    }

    const cmd = parseCommand(trimmed);
    if (cmd.handled) {
      switch (cmd.action) {
        case 'new': {
          if (streamHandle) {
            streamHandle.abort();
            setStreamAborted(true);
          }
          clearHistory(CLI_CHAT_ID);
          setMessages([]);
          appendMessage('system', 'New conversation started');
          finishProcessing();
          return;
        }
        case 'clear': {
          setMessages([]);
          appendMessage('system', 'Screen cleared');
          return;
        }
        case 'history': {
          const history = getHistory(CLI_CHAT_ID);
          if (history.length === 0) {
            appendMessage('system', 'No messages yet');
          } else {
            // Build history display from TUI messages that have user/assistant roles
            const historyLines = messages
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m) => {
                const time = m.sentAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
                const label = m.role === 'user' ? 'You' : identity.agentNameDisplay;
                // Truncate long messages for history view
                const preview = m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content;
                return `[${time}] ${label}: ${preview}`;
              })
              .join('\n');
            appendMessage('system', historyLines);
          }
          return;
        }
        case 'auth': {
          if (cmd.output) {
            appendMessage('system', cmd.output[0]);
            return;
          }
          const code = cmd.args!.code;
          const result = verifyCode(code);
          if (result.success) {
            appendMessage('system', `[auth] Telegram chat ${result.chatId} authenticated.`);
          } else {
            appendMessage('system', '[auth] Invalid or expired code.');
          }
          return;
        }
      }
    }

    // Normal message flow — not a known command
    appendMessage('user', trimmed);
    setProcessing(true);
    currentInputRef.current = trimmed;

    addMessage(CLI_CHAT_ID, { role: 'user', content: trimmed });
    const history = getHistory(CLI_CHAT_ID);

    try {
      const handle = await invokeClaudeStreaming(trimmed, CLI_CHAT_ID, history);
      setStreamHandle(handle);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendMessage('system', `[error] ${msg}`);
      setProcessing(false);
    }
  }, [appendMessage, exit, streamHandle, finishProcessing, messages]);

  // Escape to exit; Ctrl+C during streaming to abort
  useInput((_input, key) => {
    if (key.escape && !processing) {
      appendMessage('system', `[${identity.logPrefix}-cli] goodbye`);
      exit();
      return;
    }
    if (streamHandle && _input === 'c' && key.ctrl) {
      setStreamAborted(true);
      streamHandle.abort();
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="double" paddingX={2} marginBottom={1} width="100%">
        <Text bold>
          {`${identity.agentNameDisplay} CLI\n`}
          {'Type a message to begin.\n'}
          {'exit / quit / Escape to go.'}
        </Text>
      </Box>

      <Static items={messages}>
        {(msg) => {
          if (msg.role === 'user') {
            return (
              <Box key={msg.id} width="100%">
                <Text color="cyan" bold>You: </Text>
                <Text wrap="wrap">{msg.content}</Text>
              </Box>
            );
          }
          if (msg.role === 'assistant') {
            return (
              <Box key={msg.id} width="100%">
                <Text color="green" bold>{identity.agentNameDisplay}: </Text>
                <Text wrap="wrap">{renderMarkdown(msg.content)}</Text>
              </Box>
            );
          }
          return (
            <Box key={msg.id} width="100%">
              <Text dimColor wrap="wrap">{msg.content}</Text>
            </Box>
          );
        }}
      </Static>

      {streamHandle ? (
        <StreamingResponse
          handle={streamHandle}
          aborted={streamAborted}
          onComplete={handleStreamComplete}
          onError={handleStreamError}
          onAborted={handleStreamAborted}
          onWriteback={handleWriteback}
          width={width}
        />
      ) : (
        <InputEditor onSubmit={handleSubmit} disabled={processing} />
      )}
    </Box>
  );
}
