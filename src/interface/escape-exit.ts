import type { StatusLine } from './status-line';

const ESCAPE_MESSAGE = 'Press Esc again to exit';

/** The status line's idle text at a prompt where Escape pressed twice exits. */
export const ESCAPE_EXIT_HINT = 'Esc twice or Ctrl-C to exit';

// Matches the window of Claude Code's double-press guard.
const ESCAPE_WINDOW_MS = 800;

/** Where one Escape press falls in its exit prompt's window. */
type EscapePress = 'first' | 'second';

/** Escape handling of one open exit prompt. */
type EscapeExit = {
  press(): EscapePress;
  dispose(): void;
};

/**
 * Creates the Escape window of one exit prompt: the first press shows a
 * confirmation on the status line, and a second press within the window
 * confirms the exit.
 *
 * The confirmation stays shown after the second press until `dispose()`, so
 * the prompt draws its cancel frame once, with no redraw between. Call
 * `dispose()` once, after the prompt settles.
 */
export function createEscapeExit(statusLine: StatusLine): EscapeExit {
  let phase: 'closed' | 'open' | 'confirmed' = 'closed';
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
    phase = 'closed';
  }

  return {
    press() {
      if (phase !== 'closed') {
        stopTimer();
        phase = 'confirmed';
        return 'second';
      }
      message = statusLine.show(ESCAPE_MESSAGE);
      timer = setTimeout(close, ESCAPE_WINDOW_MS);
      phase = 'open';
      return 'first';
    },
    dispose: close,
  };
}
