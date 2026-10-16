/**
 * Question primitives both wizards ask through, the cancellation sentinel, and
 * the TTY check and failure results of both entry points.
 */

import { isCancel } from '@clack/prompts';

import { confirm, select, text } from './wizard-prompts';

import type { StatusLine, StatusLineDisplay } from './status-line';
import type { WaitInterrupt } from './wait-interrupt';
import type { TevuResult, ValidationFinding } from '@/domain/errors';
import type { CANCEL_SYMBOL, Option } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';

/**
 * Interactive streams the wizards prompt on; both must be TTYs. A `signal`
 * makes every question resolve as cancelled once it aborts. The members after
 * `statusLine` are set by `runTaskWizard` only.
 */
export type WizardIo = {
  input: Readable & { isTTY?: boolean };
  output: Writable & { isTTY?: boolean };
  signal?: AbortSignal;
  /** Drawn under every open question of this wizard run. */
  statusLine: StatusLine & StatusLineDisplay;
  /** Words the exit question asked after a wait took a SIGINT and at a declined save. */
  exitQuestion?: () => string;
  /** Lets each wait take the first SIGINT instead of the command signal. */
  waitInterrupt?: WaitInterrupt;
  /** States what an exit loses, for the notice a wait prints on its first SIGINT. */
  exitLoss?: () => string;
  /** Redacts the notice a wait prints on its first SIGINT. */
  redact?: (text: string) => string;
};

/**
 * Control-flow sentinel that ends a wizard. Questions and waits throw it when
 * the operator cancels, `runWaitReporting` rethrows it, and `runTaskWizard`
 * and `runAssessmentWizard` turn it into a `CancellationError` result, so it
 * never leaves a wizard.
 */
export class WizardCancelledError extends Error {
  constructor() {
    super('wizard cancelled');
  }
}

/** Fails with `PrerequisiteError` unless both wizard streams are TTYs. */
export function requireInteractiveTty(io: WizardIo): TevuResult<never, 'PrerequisiteError'> | null {
  const failing: string[] = [];
  if (io.input.isTTY !== true) {
    failing.push('stdin');
  }
  if (io.output.isTTY !== true) {
    failing.push('stdout');
  }
  if (failing.length === 0) {
    return null;
  }
  return {
    ok: false,
    error: {
      kind: 'PrerequisiteError',
      tool: 'terminal',
      expected: 'an interactive TTY on stdin and stdout',
      actual: `${failing.join(' and ')} ${failing.length === 1 ? 'is' : 'are'} not a TTY`,
    },
  };
}

export function promptOptions(io: WizardIo): { input: Readable; output: Writable } {
  return { input: io.input, output: io.output };
}

/**
 * Opens one Clack question with a signal that follows the wizard's cancellation
 * only while the question is open.
 *
 * Clack never removes the abort listener of a finished question, so handing
 * every question the wizard's own signal would make each earlier question write
 * a stray newline to the terminal the moment the wizard is cancelled.
 */
export async function withPromptSignal<T>(
  io: WizardIo,
  open: (options: { signal?: AbortSignal }) => Promise<T>,
): Promise<T> {
  const wizardSignal = io.signal;
  if (wizardSignal === undefined) {
    return open({});
  }
  const questionController = new AbortController();
  const abortQuestion = (): void => questionController.abort();
  if (wizardSignal.aborted) {
    abortQuestion();
  } else {
    wizardSignal.addEventListener('abort', abortQuestion, { once: true });
  }
  try {
    return await open({ signal: questionController.signal });
  } finally {
    wizardSignal.removeEventListener('abort', abortQuestion);
  }
}

/**
 * Draws one question and resolves its answer; a cancelled question ends the
 * wizard, because the question itself already asked for the second press.
 */
export async function ask<T>(
  io: WizardIo,
  open: (signal: { signal?: AbortSignal }) => Promise<T | typeof CANCEL_SYMBOL>,
): Promise<T> {
  const value = await withPromptSignal(io, open);
  if (isCancel(value)) {
    throw new WizardCancelledError();
  }
  return value;
}

export async function askText(
  io: WizardIo,
  options: {
    message: string;
    defaultValue?: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string | undefined) => string | undefined;
  },
): Promise<string> {
  return ask(io, (signal) =>
    text({ ...options, ...promptOptions(io), statusLine: io.statusLine, ...signal }),
  );
}

/**
 * Asks a question whose default Clack shows dim and submits on an empty Enter.
 *
 * Clack validates the raw input before it applies `defaultValue`, so the
 * validator must accept empty input for the default to be reachable.
 */
export async function askDefaultedText(
  io: WizardIo,
  options: {
    message: string;
    defaultValue: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string | undefined) => string | undefined;
  },
): Promise<string> {
  const { validate, placeholder, ...rest } = options;
  return askText(io, {
    ...rest,
    placeholder: placeholder ?? options.defaultValue,
    validate: (raw) => (raw === undefined || raw.length === 0 ? undefined : validate?.(raw)),
  });
}

export async function askConfirm(
  io: WizardIo,
  options: { message: string; initialValue: boolean },
): Promise<boolean> {
  return ask(io, (signal) =>
    confirm({ ...options, ...promptOptions(io), statusLine: io.statusLine, ...signal }),
  );
}

export async function askSelect<Value extends string>(
  io: WizardIo,
  options: {
    message: string;
    options: Option<Value>[];
    initialValue?: Value;
  },
): Promise<Value> {
  return ask(io, (signal) =>
    select<Value>({ ...options, ...promptOptions(io), statusLine: io.statusLine, ...signal }),
  );
}

export async function askInteger(
  io: WizardIo,
  message: string,
  min: number,
  max: number,
  defaultValue: number,
): Promise<number> {
  const bounds = `an integer from ${min} through ${max}`;
  const value = await askDefaultedText(io, {
    message,
    defaultValue: String(defaultValue),
    validate: (raw) => {
      const trimmed = (raw ?? '').trim();
      if (!/^\d+$/.test(trimmed)) {
        return `enter ${bounds}`;
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed < min || parsed > max) {
        return `enter ${bounds}`;
      }
      return undefined;
    },
  });
  return Number.parseInt(value.trim(), 10);
}

export function configValidationFailure(
  findings: ValidationFinding[],
): TevuResult<never, 'ConfigValidationError'> {
  return { ok: false, error: { kind: 'ConfigValidationError', findings } };
}

export function cancellationFailure(): TevuResult<never, 'CancellationError'> {
  return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
}
