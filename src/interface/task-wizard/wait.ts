/**
 * The waits between questions of the task wizard, and the exit question a wait
 * or a declined save opens.
 */

import { isCancel } from '@clack/prompts';
import stdinDiscarder from 'stdin-discarder';
import yoctoSpinner from 'yocto-spinner';

import { confirm } from '@/interface/wizard-prompts';
import {
  promptOptions,
  withPromptSignal,
  WizardCancelledError,
} from '@/interface/wizard-questions';

import { warnLines } from './shared';

import type { WizardIo } from '@/interface/wizard-questions';

const WAIT_FRAMES = ['◒', '◐', '◓', '◑'];

export const SAVING_WAIT_LABEL = 'Saving task';

/**
 * Runs one asynchronous step between questions behind a spinner row.
 *
 * Holds stdin with `stdin-discarder` so keys typed meanwhile never reach the
 * next question and Ctrl-C arrives as SIGINT. The spinner never installs its
 * own signal handlers: its default would exit the process before the
 * cancelled operation cleans up. Both stop in a `finally`, so no exit path
 * leaves the row, a hidden cursor, or raw mode behind.
 *
 * The first SIGINT of a `task add` wait goes to the wait, not to the command
 * signal, because the step cannot stop cleanly at that point: it keeps
 * running, a notice states what a second Ctrl-C loses, and the exit question
 * opens when the step ends. A second SIGINT aborts the command signal, which
 * ends the wizard whatever the operation returned, unless `saved` reports the
 * result as already written; then the result stands and no question opens.
 */
export async function runWait<T>(
  io: WizardIo,
  label: string,
  operation: () => Promise<T>,
  saved: (result: T) => boolean = () => false,
): Promise<T> {
  const held = openWaitInterrupt(io, label);
  // yocto-spinner joins the frame and the text with one space; Clack's rows use two.
  const spinner = yoctoSpinner({
    text: ` ${label}`,
    stream: io.output,
    handleSignals: false,
    color: 'magenta',
    spinner: { frames: WAIT_FRAMES },
  });
  let result: T;
  let hasTakenInterrupt: boolean;
  try {
    stdinDiscarder.start();
    spinner.start();
    result = await operation();
  } finally {
    hasTakenInterrupt = held?.close() === true;
    spinner.stop();
    stdinDiscarder.stop();
  }
  if (saved(result)) {
    return result;
  }
  if (io.signal?.aborted === true) {
    throw new WizardCancelledError();
  }
  if (hasTakenInterrupt && (await confirmExit(io))) {
    throw new WizardCancelledError();
  }
  return result;
}

/**
 * Runs {@link runWait} and, when the wizard cancels after the operation
 * settled, hands the settled outcome to `reportSettled` before the
 * cancellation escapes, because the caller never sees an outcome `runWait`
 * discards.
 */
export async function runWaitReporting<T>(
  io: WizardIo,
  label: string,
  operation: () => Promise<T>,
  reportSettled: (settled: T) => void,
): Promise<T> {
  // A holder object: a closure's assignment to a plain `let` is invisible to
  // the compiler's narrowing in the catch block.
  const holder: { settled?: { outcome: T } } = {};
  try {
    return await runWait(io, label, async () => {
      const outcome = await operation();
      holder.settled = { outcome };
      return outcome;
    });
  } catch (error) {
    if (error instanceof WizardCancelledError && holder.settled !== undefined) {
      reportSettled(holder.settled.outcome);
    }
    throw error;
  }
}

/** Opens the wait's interrupt slot; absent unless the wizard can also ask the exit question. */
function openWaitInterrupt(io: WizardIo, label: string): { close(): boolean } | undefined {
  const { waitInterrupt, exitLoss, redact } = io;
  if (waitInterrupt === undefined || exitLoss === undefined || redact === undefined) {
    return undefined;
  }
  return waitInterrupt.open(() => {
    const loss = exitLoss();
    if (label === SAVING_WAIT_LABEL) {
      warnLines(io, redact, {
        headline: `Press Ctrl-C again to stop saving. If the save stops before the write, ${lowercaseInitial(loss)}`,
        next: 'Otherwise tevu saves the task, or asks whether to exit if the save fails.',
      });
      return;
    }
    warnLines(io, redact, {
      headline: `Press Ctrl-C again to exit now. ${loss}`,
      next: 'Otherwise tevu asks whether to exit when this step ends.',
    });
  });
}

function lowercaseInitial(sentence: string): string {
  return `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

/**
 * Asks whether to exit and reports the answer; Ctrl-C at this question exits.
 * It is asked with `confirm` directly, never through `ask`, so it cannot
 * open another exit question.
 */
export async function confirmExit(io: WizardIo): Promise<boolean> {
  if (io.exitQuestion === undefined) {
    throw new Error('unreachable: only a wizard with an exit question opens it');
  }
  const message = io.exitQuestion();
  const answer = await withPromptSignal(io, (signal) =>
    confirm({
      message,
      initialValue: false,
      ...promptOptions(io),
      statusLine: io.statusLine,
      ...signal,
    }),
  );
  return answer === true || isCancel(answer);
}
