import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import type { StreamHandle } from '../claude.js';
import { MarkdownChunker } from '../markdown.js';
import { WritebackStreamParser, type WritebackEvent } from '../writeback-parser.js';
import { identity } from '../identity.js';

interface StreamingResponseProps {
  handle: StreamHandle;
  aborted?: boolean;
  onComplete: (fullText: string) => void;
  onError: (errorText: string, partialText: string) => void;
  onAborted: (partialText: string) => void;
  onWriteback?: (event: WritebackEvent) => void;
  width?: number;
}

export default function StreamingResponse({
  handle,
  aborted = false,
  onComplete,
  onError,
  onAborted,
  onWriteback,
  width,
}: StreamingResponseProps): React.ReactElement {
  const [rendered, setRendered] = useState('');
  const [thinking, setThinking] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const textRef = useRef('');
  const chunkerRef = useRef<MarkdownChunker>(new MarkdownChunker());
  const parserRef = useRef<WritebackStreamParser>(new WritebackStreamParser());
  const renderedPartsRef = useRef<string[]>([]);
  const abortedRef = useRef(aborted);
  abortedRef.current = aborted;

  // Elapsed time ticker
  useEffect(() => {
    if (!thinking) return;
    const interval = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [thinking]);

  // Consume the stream
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        for await (const chunk of handle.chunks) {
          if (cancelled) break;

          if (chunk.type === 'text') {
            setThinking(false);
            const parsed = parserRef.current.push(chunk.text);
            for (const event of parsed.events) {
              onWriteback?.(event);
            }
            if (parsed.text) {
              textRef.current += parsed.text;
              const blocks = chunkerRef.current.push(parsed.text);
              if (blocks.length > 0) {
                renderedPartsRef.current.push(...blocks);
              }
            }
            // Show rendered blocks + raw pending text for live display
            const pendingText = chunkerRef.current.pending;
            const display = pendingText
              ? [...renderedPartsRef.current, pendingText].join('\n')
              : renderedPartsRef.current.join('\n');
            setRendered(display);
          } else if (chunk.type === 'error') {
            setThinking(false);
            const parserFlushed = parserRef.current.flush();
            if (parserFlushed.text) {
              textRef.current += parserFlushed.text;
              const blocks = chunkerRef.current.push(parserFlushed.text);
              if (blocks.length > 0) {
                renderedPartsRef.current.push(...blocks);
              }
            }
            const flushed = chunkerRef.current.flush();
            if (flushed) {
              renderedPartsRef.current.push(flushed);
              setRendered(renderedPartsRef.current.join('\n'));
            }
            if (!cancelled) {
              onError(chunk.text, textRef.current);
            }
            return;
          } else if (chunk.type === 'done') {
            setThinking(false);
            const parserFlushed = parserRef.current.flush();
            if (parserFlushed.text) {
              textRef.current += parserFlushed.text;
              const blocks = chunkerRef.current.push(parserFlushed.text);
              if (blocks.length > 0) {
                renderedPartsRef.current.push(...blocks);
              }
            }
            const flushed = chunkerRef.current.flush();
            if (flushed) {
              renderedPartsRef.current.push(flushed);
              setRendered(renderedPartsRef.current.join('\n'));
            }
            if (!cancelled) {
              if (abortedRef.current) {
                onAborted(textRef.current);
              } else {
                onComplete(textRef.current);
              }
            }
            return;
          }
        }

        // Generator exhausted without done/error (e.g. abort killed the stream)
        const parserFlushed2 = parserRef.current.flush();
        if (parserFlushed2.text) {
          textRef.current += parserFlushed2.text;
          const blocks = chunkerRef.current.push(parserFlushed2.text);
          if (blocks.length > 0) {
            renderedPartsRef.current.push(...blocks);
          }
        }
        const flushed = chunkerRef.current.flush();
        if (flushed) {
          renderedPartsRef.current.push(flushed);
          setRendered(renderedPartsRef.current.join('\n'));
        }
        if (!cancelled && abortedRef.current) {
          onAborted(textRef.current);
        }
      } catch {
        const parserFlushed3 = parserRef.current.flush();
        if (parserFlushed3.text) {
          textRef.current += parserFlushed3.text;
          const blocks = chunkerRef.current.push(parserFlushed3.text);
          if (blocks.length > 0) {
            renderedPartsRef.current.push(...blocks);
          }
        }
        const flushed = chunkerRef.current.flush();
        if (flushed) {
          renderedPartsRef.current.push(flushed);
          setRendered(renderedPartsRef.current.join('\n'));
        }
        if (!cancelled) {
          onError('Stream interrupted unexpectedly.', textRef.current);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handle]); // eslint-disable-line react-hooks/exhaustive-deps

  if (thinking) {
    return (
      <Box width="100%">
        <Text color="yellow">Thinking... {elapsed}s</Text>
      </Box>
    );
  }

  return (
    <Box width="100%">
      <Text color="green" bold>{identity.agentNameDisplay}: </Text>
      <Text wrap="wrap">{rendered}</Text>
    </Box>
  );
}

export { type StreamingResponseProps };
