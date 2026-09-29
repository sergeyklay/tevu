import { styleText } from 'node:util';

import type { State } from '@clack/core';
import type { Writable } from 'node:stream';

/** The status line as an open prompt sees it. */
export type StatusLineDisplay = {
  /** The status line's row for a frame drawn in `state`; empty once the prompt has settled. */
  row(state: State, output: Writable, idleText: string): string;
};

/**
 * Creates the status line of one wizard run.
 *
 * The caller owns the secret rule: `idleText` is constant text. The status
 * line neither validates nor redacts.
 */
export function createStatusLine(): StatusLineDisplay {
  return {
    row(state, output, idleText) {
      if (state === 'submit' || state === 'cancel') {
        return '';
      }
      return `  ${styleText('dim', idleText, { stream: output })}\n`;
    },
  };
}
