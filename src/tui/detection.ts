/**
 * Terminal capability detection for TUI vs plain REPL selection.
 */
export function shouldUseTUI(): boolean {
  const isTTY = Boolean(process.stdout.isTTY);
  const isDumb = process.env.TERM === 'dumb';
  // TERM unset -> default to TUI mode (most terminals don't set TERM)
  // Only piped stdout triggers fallback (not piped stdin, since Ink reads stdin itself)
  return isTTY && !isDumb;
}
