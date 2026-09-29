import { Interface } from 'node:readline';
import { settings } from '@clack/core';

import type { StatusLine } from './status-line';
import type { Key } from 'node:readline';

/** A key that exits an exit prompt when pressed twice within the window. */
export type ExitKey = 'escape' | 'ctrl-c';

const EXIT_MESSAGES: Record<ExitKey, string> = {
  escape: 'Press Esc again to exit',
  'ctrl-c': 'Press Ctrl-C again to exit',
};

// Clack's cancel alias of each exit key; a raw-mode Ctrl-C reads as the ETX byte.
const CANCEL_ALIASES: Record<ExitKey, string> = { escape: 'escape', 'ctrl-c': '\u0003' };

/** The status line's idle text at a prompt where an exit key pressed twice exits. */
export const EXIT_HINT = 'Esc or Ctrl-C twice to exit';

// Matches the window of Claude Code's double-press guard.
const EXIT_WINDOW_MS = 800;

/** Where one exit key press falls in its exit prompt's window. */
type ExitPress = 'first' | 'second';

/** Exit key handling of one open exit prompt. */
type ExitPresses = {
  press(key: ExitKey): ExitPress;
  dispose(): void;
};

/**
 * Creates the exit window of one exit prompt: the first press of a key shows
 * a confirmation on the status line, and a second press of the same key within
 * the window confirms the exit. A press of the other key opens its own window.
 *
 * The confirmation stays shown after the second press until `dispose()`, so
 * the prompt draws its cancel frame once, with no redraw between. Call
 * `dispose()` once, after the prompt settles.
 */
export function createExitPresses(statusLine: StatusLine): ExitPresses {
  let phase: { kind: 'closed' } | { kind: 'open'; key: ExitKey } | { kind: 'confirmed' } = {
    kind: 'closed',
  };
  let timer: NodeJS.Timeout | undefined;
  let message: ReturnType<StatusLine['show']> | undefined;

  function stopTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function close(): void {
    stopTimer();
    message?.clear();
    message = undefined;
    phase = { kind: 'closed' };
  }

  return {
    press(key) {
      if (phase.kind === 'confirmed' || (phase.kind === 'open' && phase.key === key)) {
        stopTimer();
        phase = { kind: 'confirmed' };
        return 'second';
      }
      stopTimer();
      message = statusLine.show(EXIT_MESSAGES[key]);
      timer = setTimeout(close, EXIT_WINDOW_MS);
      phase = { kind: 'open', key };
      return 'first';
    },
    dispose: close,
  };
}

/** The exit key a keypress is, if any. */
export function exitKeyOf(char: string | undefined, key: Key): ExitKey | undefined {
  if (key.name === 'escape') {
    return 'escape';
  }
  return char === '\u0003' || (key.ctrl === true && key.name === 'c') ? 'ctrl-c' : undefined;
}

/**
 * Removes Clack's cancel alias of each key and returns the function that puts
 * them back. The aliases are global, so every prompt open meanwhile loses them.
 */
export function suspendCancelAliases(keys: readonly ExitKey[]): () => void {
  const previous = keys.map(
    (key) => [CANCEL_ALIASES[key], settings.aliases.get(CANCEL_ALIASES[key])] as const,
  );
  for (const [alias] of previous) {
    settings.aliases.delete(alias);
  }
  return () => {
    for (const [alias, action] of previous) {
      if (action !== undefined) {
        settings.aliases.set(alias, action);
      }
    }
  };
}

/**
 * Keeps the readline interface of an open Clack prompt reading after a
 * Ctrl-C. Readline closes itself on Ctrl-C unless it has a `SIGINT` listener,
 * which leaves raw mode and pauses input, so a second press would never
 * arrive as a key. Clack keeps the interface private; call this right after
 * `prompt()` opens it.
 *
 * @throws {Error} If the prompt holds no readline interface, which means the
 *   installed Clack no longer matches this port.
 */
export function keepReadingAfterCtrlC(prompt: object): void {
  const readline: unknown = Reflect.get(prompt, 'rl');
  // A signal aborted before the call settles the prompt without opening one.
  if (readline === undefined) {
    return;
  }
  if (!(readline instanceof Interface)) {
    throw new Error('unreachable: an open Clack prompt holds a readline interface');
  }
  readline.on('SIGINT', () => {});
}
