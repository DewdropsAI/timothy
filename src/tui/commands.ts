/**
 * TUI slash command parser and dispatcher.
 * Known commands: /new, /clear, /history, /auth
 * Unknown slash commands pass through to the cognitive pipeline.
 */

export interface CommandResult {
  handled: boolean;
  action?: 'new' | 'clear' | 'history' | 'auth';
  args?: Record<string, string>;
  output?: string[];
}

const KNOWN_COMMANDS = new Set(['new', 'clear', 'history', 'auth']);

export function parseCommand(input: string): CommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return { handled: false };
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (!KNOWN_COMMANDS.has(cmd)) {
    return { handled: false };
  }

  if (cmd === 'auth') {
    const code = parts.slice(1).join(' ').trim();
    if (!code) {
      return { handled: true, action: 'auth', output: ['/auth <code> — set authentication code'] };
    }
    return { handled: true, action: 'auth', args: { code } };
  }

  return { handled: true, action: cmd as 'new' | 'clear' | 'history' };
}
