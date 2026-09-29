/**
 * The `text`, `confirm`, and `select` prompts of the wizards: the frames
 * `@clack/prompts` draws, plus the status line row, with Escape and Ctrl-C
 * each asking for a second press before they cancel.
 *
 * Clack builds each frame inside a closure it does not expose, so the frames
 * are ported here; entry points are {@link text}, {@link confirm}, and
 * {@link select}.
 */

import { styleText } from 'node:util';
import { ConfirmPrompt, SelectPrompt, TextPrompt, wrapTextWithPrefix } from '@clack/core';
import {
  formatInstructionFooter,
  limitOptions,
  S_BAR,
  S_BAR_END,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  SELECT_INSTRUCTIONS,
  symbol,
  symbolBar,
} from '@clack/prompts';

import {
  createExitPresses,
  EXIT_HINT,
  exitKeyOf,
  keepReadingAfterCtrlC,
  suspendCancelAliases,
} from './exit-press';

import type { StatusLine, StatusLineDisplay } from './status-line';
import type { Prompt, State } from '@clack/core';
import type { CANCEL_SYMBOL, Option } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';

type WizardPromptContext = {
  input: Readable;
  output: Writable;
  /** Aborting it resolves the cancel value, as for the same-named function from @clack/prompts. */
  signal?: AbortSignal;
  statusLine: StatusLine & StatusLineDisplay;
};

/**
 * Asks for a line of text and resolves it, drawing the status line row under
 * every open frame.
 *
 * A second Escape or Ctrl-C within the window and an aborted `signal` resolve
 * the cancel value that `isCancel` from `@clack/prompts` accepts.
 *
 * @throws {Error} If the prompt settles without a value, which cannot happen
 *   because `TextPrompt` finalizes to a string.
 */
export async function text(
  options: WizardPromptContext & {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    initialValue?: string;
    validate?: (value: string | undefined) => string | undefined;
  },
): Promise<string | typeof CANCEL_SYMBOL> {
  const { message, placeholder, defaultValue, initialValue, validate, statusLine } = options;
  const { input, output, signal } = options;

  const prompt = new TextPrompt({
    validate,
    placeholder,
    defaultValue,
    initialValue,
    input,
    output,
    signal,
    render() {
      const title = `${styleText('gray', S_BAR)}\n${symbol(this.state)}  ${message}\n`;
      const placeholderCell =
        placeholder !== undefined && placeholder.length > 0
          ? styleText('inverse', placeholder.slice(0, 1)) + styleText('dim', placeholder.slice(1))
          : styleText(['inverse', 'hidden'], '_');
      const typed = this.userInput ? this.userInputWithCursor : placeholderCell;
      const answer = this.value ?? '';
      return `${textFrame(this.state, title, typed, answer, this.error)}${statusLine.row(this.state, output, EXIT_HINT)}`;
    },
  });
  return openExitPrompt('text', prompt, output, statusLine);
}

/**
 * Asks a yes/no question and resolves the answer, drawing the status line row
 * under every open frame.
 *
 * `Yes` and `No` show side by side; `y` and `n` submit. A second Escape or
 * Ctrl-C within the window and an aborted `signal` resolve the cancel value.
 *
 * @throws {Error} If the prompt settles without a value, which cannot happen
 *   because `ConfirmPrompt` always holds a boolean.
 */
export async function confirm(
  options: WizardPromptContext & { message: string; initialValue: boolean },
): Promise<boolean | typeof CANCEL_SYMBOL> {
  const { message, initialValue, input, output, signal, statusLine } = options;

  const prompt = new ConfirmPrompt({
    active: 'Yes',
    inactive: 'No',
    initialValue,
    input,
    output,
    signal,
    render() {
      const title = `${styleText('gray', S_BAR)}\n${wrapTextWithPrefix(
        output,
        message,
        `${styleText('gray', S_BAR)}  `,
        `${symbol(this.state)}  `,
      )}\n`;
      const answer = this.value ? 'Yes' : 'No';
      return `${confirmFrame(this.state, title, answer, this.value === true)}${statusLine.row(this.state, output, EXIT_HINT)}`;
    },
  });
  return openExitPrompt('confirm', prompt, output, statusLine);
}

/**
 * Asks the operator to pick one option and resolves its `value`, drawing the
 * status line row under every open frame.
 *
 * The row counts against the terminal rows the option list may use. A second
 * Escape or Ctrl-C within the window and an aborted `signal` resolve the
 * cancel value.
 *
 * @throws {Error} If the prompt settles without a value, which cannot happen
 *   while the caller passes at least one option.
 */
export async function select<Value extends string>(
  options: WizardPromptContext & {
    message: string;
    options: Option<Value>[];
    initialValue?: Value;
  },
): Promise<Value | typeof CANCEL_SYMBOL> {
  const { message, initialValue, input, output, signal, statusLine } = options;

  const prompt = new SelectPrompt<SelectRow<Value>>({
    options: options.options,
    initialValue,
    input,
    output,
    signal,
    render() {
      const title = `${styleText('gray', S_BAR)}\n${wrapTextWithPrefix(
        output,
        message,
        `${symbolBar(this.state) ?? ''}  `,
        `${symbol(this.state)}  `,
      )}\n`;
      const row = statusLine.row(this.state, output, EXIT_HINT);
      const chosen = this.options[this.cursor];
      const guide = `${styleText('gray', S_BAR)}  `;
      if (this.state === 'submit') {
        return `${title}${wrapTextWithPrefix(output, formatOption(chosen, 'selected'), guide)}`;
      }
      if (this.state === 'cancel') {
        const struck = wrapTextWithPrefix(output, formatOption(chosen, 'cancelled'), guide);
        return `${title}${struck}\n${styleText('gray', S_BAR)}`;
      }

      const prefix = `${styleText('cyan', S_BAR)}  `;
      const footer = formatInstructionFooter(SELECT_INSTRUCTIONS, true);
      const list = limitOptions({
        output,
        cursor: this.cursor,
        options: this.options,
        columnPadding: prefix.length,
        rowPadding: title.split('\n').length + footer.length + 1 + countNewlines(row),
        style: (item, isActive) =>
          formatOption(item, item.disabled ? 'disabled' : isActive ? 'active' : 'inactive'),
      });
      return `${title}${prefix}${list.join(`\n${prefix}`)}\n${footer.join('\n')}\n${row}`;
    },
  });
  return openExitPrompt('select', prompt, output, statusLine);
}

/**
 * Runs `prompt` with Escape and Ctrl-C routed through the exit window and the
 * status line followed for as long as the prompt is open.
 */
async function openExitPrompt<Value>(
  kind: string,
  prompt: Prompt<Value>,
  output: Writable,
  statusLine: StatusLine & StatusLineDisplay,
): Promise<Value | typeof CANCEL_SYMBOL> {
  const exitPresses = createExitPresses(statusLine);
  prompt.on('key', (char, key) => {
    const exitKey = exitKeyOf(char, key);
    if (exitKey !== undefined && exitPresses.press(exitKey) === 'second') {
      prompt.state = 'cancel';
    }
  });
  // With the aliases, Clack cancels once the `key` listener returns, and at `confirm` Escape flips the answer first.
  const restoreAliases = suspendCancelAliases(['escape', 'ctrl-c']);
  let value: Value | typeof CANCEL_SYMBOL | undefined;
  try {
    const settled = prompt.prompt();
    keepReadingAfterCtrlC(prompt);
    const stopFollowing = statusLine.follow(output);
    try {
      value = await settled;
    } finally {
      stopFollowing();
    }
  } finally {
    exitPresses.dispose();
    restoreAliases();
  }
  if (value === undefined) {
    throw new Error(`unreachable: ${kind} prompt settled without a value`);
  }
  return value;
}

function textFrame(
  state: State,
  title: string,
  input: string,
  answer: string,
  error: string,
): string {
  switch (state) {
    case 'validating':
      return `${title}${styleText('cyan', S_BAR)}  ${styleText('dim', input)}\n${styleText('cyan', S_BAR_END)}  ${styleText('dim', 'Validating...')}\n`;
    case 'error': {
      const message = error ? `  ${styleText('yellow', error)}` : '';
      return `${title.trim()}\n${styleText('yellow', S_BAR)}  ${input}\n${styleText('yellow', S_BAR_END)}${message}\n`;
    }
    case 'submit': {
      const shown = answer ? `  ${styleText('dim', answer)}` : '';
      return `${title}${styleText('gray', S_BAR)}${shown}`;
    }
    case 'cancel': {
      const shown = answer ? `  ${styleText(['strikethrough', 'dim'], answer)}` : '';
      const closing = answer.trim() ? `\n${styleText('gray', S_BAR)}` : '';
      return `${title}${styleText('gray', S_BAR)}${shown}${closing}`;
    }
    default:
      return `${title}${styleText('cyan', S_BAR)}  ${input}\n${styleText('cyan', S_BAR_END)}\n`;
  }
}

function confirmFrame(state: State, title: string, answer: string, isYes: boolean): string {
  const guide = `${styleText('gray', S_BAR)}  `;
  switch (state) {
    case 'submit':
      return `${title}${guide}${styleText('dim', answer)}`;
    case 'cancel':
      return `${title}${guide}${styleText(['strikethrough', 'dim'], answer)}\n${styleText('gray', S_BAR)}`;
    default: {
      const yes = isYes
        ? `${styleText('green', S_RADIO_ACTIVE)} Yes`
        : `${styleText('dim', S_RADIO_INACTIVE)} ${styleText('dim', 'Yes')}`;
      const no = isYes
        ? `${styleText('dim', S_RADIO_INACTIVE)} ${styleText('dim', 'No')}`
        : `${styleText('green', S_RADIO_ACTIVE)} No`;
      return `${title}${styleText('cyan', S_BAR)}  ${yes} ${styleText('dim', '/')} ${no}\n${styleText('cyan', S_BAR_END)}\n`;
    }
  }
}

type SelectRow<Value extends string> = {
  value: Value;
  label?: string;
  hint?: string;
  disabled?: boolean;
};

function formatOption(
  option: SelectRow<string> | undefined,
  variant: 'disabled' | 'selected' | 'active' | 'cancelled' | 'inactive',
): string {
  if (option === undefined) {
    return '';
  }
  const label = option.label ?? String(option.value);
  const hint = option.hint ? ` ${styleText('dim', `(${option.hint})`)}` : '';
  switch (variant) {
    case 'disabled':
      return `${styleText('gray', S_RADIO_INACTIVE)} ${styleEachLine(label, 'gray')}${hint}`;
    case 'selected':
      return styleEachLine(label, 'dim');
    case 'active':
      return `${styleText('green', S_RADIO_ACTIVE)} ${label}${hint}`;
    case 'cancelled':
      return styleEachLine(label, ['strikethrough', 'dim']);
    case 'inactive':
      return `${styleText('dim', S_RADIO_INACTIVE)} ${styleEachLine(label, 'dim')}`;
  }
}

function styleEachLine(label: string, format: Parameters<typeof styleText>[0]): string {
  return label
    .split('\n')
    .map((line) => styleText(format, line))
    .join('\n');
}

function countNewlines(value: string): number {
  return value.split('\n').length - 1;
}
