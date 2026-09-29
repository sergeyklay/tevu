import { styleText } from 'node:util';

import type { State } from '@clack/core';
import type { Writable } from 'node:stream';

/** One message on the status line. */
type StatusMessage = {
  /** Removes this message while it is the one shown; otherwise does nothing. */
  clear(): void;
};

/** The status line as a message source sees it. */
export type StatusLine = {
  /** Shows `text` in place of any shown message until the returned handle clears it. */
  show(text: string): StatusMessage;
};

/** The status line as an open prompt sees it. */
export type StatusLineDisplay = {
  /** The status line's row for a frame drawn in `state`; `idleText` shows while no message is shown. */
  row(state: State, output: Writable, idleText: string): string;
  /** Redraws the Clack prompt open on `output` after each message change until the returned function runs. */
  follow(output: Writable): () => void;
};

type ShownMessage = { text: string; handle: StatusMessage };

/**
 * Creates the single-slot status line of one wizard run.
 *
 * `show` requires one non-empty line without a line break, and the caller owns
 * the secret rule: constant text or text already passed through the wizard's
 * redaction. The status line neither validates nor redacts.
 */
export function createStatusLine(): StatusLine & StatusLineDisplay {
  let shown: ShownMessage | undefined;
  const followers = new Set<() => void>();

  function notifyFollowers(): void {
    for (const follower of followers) {
      follower();
    }
  }

  return {
    show(text) {
      const message: ShownMessage = {
        text,
        handle: {
          clear() {
            if (shown === message) {
              shown = undefined;
              notifyFollowers();
            }
          },
        },
      };
      shown = message;
      notifyFollowers();
      return message.handle;
    },
    row(state, output, idleText) {
      if (state === 'submit' || state === 'cancel') {
        return '';
      }
      return `  ${styleText('dim', shown?.text ?? idleText, { stream: output })}\n`;
    },
    follow(output) {
      // Clack's Prompt.prompt() redraws on its output's `resize` event and offers no public redraw.
      const follower = (): void => {
        output.emit('resize');
      };
      followers.add(follower);
      return () => {
        followers.delete(follower);
      };
    },
  };
}
