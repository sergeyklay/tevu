/**
 * Single-choice Clack prompt whose options sit under optional bold headings.
 *
 * Headings and the blank line between sections are rows the cursor skips, and
 * Escape resolves the `back` option instead of cancelling. Entry point:
 * {@link sectionedSelect}; {@link renderSectionedSelect} draws its frames.
 */

import { styleText } from 'node:util';
import { SelectPrompt, wrapTextWithPrefix } from '@clack/core';
import {
  formatInstructionFooter,
  limitOptions,
  S_BAR,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  SELECT_INSTRUCTIONS,
  symbol,
  symbolBar,
} from '@clack/prompts';

import type { StatusLineDisplay } from './status-line';
import type { State } from '@clack/core';
import type { CANCEL_SYMBOL } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';

/** One selectable row: the prompt resolves `value` and shows `label` as given. */
type SectionedSelectOption = { value: string; label: string };

/** A bold heading, when present, over its options; a section without options is not shown. */
type SectionedSelectSection = { heading?: string; options: readonly SectionedSelectOption[] };

type SectionedSelectOptions = {
  message: string;
  sections: readonly SectionedSelectSection[];
  /** Shown last and always selectable; Escape also resolves its value. */
  back: SectionedSelectOption;
  input: Readable;
  output: Writable;
  /** Aborting it resolves the cancel value, as for `select` from @clack/prompts. */
  signal?: AbortSignal;
  /** Drawn as the last row of every open frame. */
  statusLine: StatusLineDisplay;
};

const BACK_HINT = 'Esc to go back · Ctrl-C to exit';

type Row = {
  kind: 'heading' | 'blank' | 'option';
  value: string;
  label: string;
  disabled: boolean;
};

/**
 * Draws one frame of the prompt for `state`, with `focused` naming the value
 * of the option under the cursor and `statusRow` closing the frame.
 *
 * Has no side effect; the frame depends only on its argument, the output's
 * column and row counts, and the color settings `styleText` reads.
 */
export function renderSectionedSelect(
  frame: Pick<SectionedSelectOptions, 'message' | 'sections' | 'back' | 'output'> & {
    state: State;
    focused: string;
    statusRow: string;
  },
): string {
  const { message, sections, back, output, state, focused, statusRow } = frame;
  const rows = buildRows(sections, back);
  const cursor = Math.max(
    rows.findIndex((row) => row.kind === 'option' && row.value === focused),
    0,
  );
  const label = rows[cursor]?.label ?? '';

  const header = `${styleText('gray', S_BAR)}\n${wrapTextWithPrefix(
    output,
    message,
    `${symbolBar(state) ?? ''}  `,
    `${symbol(state)}  `,
  )}\n`;
  const guide = `${styleText('gray', S_BAR)}  `;

  if (state === 'submit') {
    return `${header}${wrapTextWithPrefix(output, styleText('dim', label, { stream: output }), guide)}${statusRow}`;
  }
  if (state === 'cancel') {
    const struck = styleText(['strikethrough', 'dim'], label, { stream: output });
    return `${header}${wrapTextWithPrefix(output, struck, guide)}\n${styleText('gray', S_BAR)}${statusRow}`;
  }

  const prefix = `${styleText('cyan', S_BAR)}  `;
  const footer = formatInstructionFooter(SELECT_INSTRUCTIONS, true);
  const body = limitOptions({
    output,
    cursor,
    options: rows,
    columnPadding: prefix.length,
    rowPadding: header.split('\n').length + footer.length + 1 + (statusRow.split('\n').length - 1),
    style: (row, isActive) => styleRow(row, isActive, output),
  });
  return `${header}${prefix}${body.join(`\n${prefix}`)}\n${footer.join('\n')}\n${statusRow}`;
}

/**
 * Asks the operator to pick one option and resolves its `value`.
 *
 * Escape resolves `back.value` after drawing the submit frame on `back`;
 * Ctrl-C and an aborted `signal` resolve the cancel value that `isCancel`
 * from `@clack/prompts` accepts.
 *
 * @throws {Error} If the prompt settles without a value, which cannot happen
 *   while `back` is always selectable.
 */
export async function sectionedSelect(
  options: SectionedSelectOptions,
): Promise<string | typeof CANCEL_SYMBOL> {
  const { message, sections, back, input, output, signal, statusLine } = options;
  let escaped = false;

  const prompt = new SelectPrompt<Row>({
    options: buildRows(sections, back),
    input,
    output,
    ...(signal === undefined ? {} : { signal }),
    render() {
      const drawnState = escaped ? 'submit' : this.state;
      return renderSectionedSelect({
        message,
        sections,
        back,
        output,
        state: drawnState,
        focused: escaped ? back.value : (this.options[this.cursor]?.value ?? back.value),
        statusRow: statusLine.row(drawnState, output, BACK_HINT),
      });
    },
  });
  // Escape and Ctrl-C both end the prompt as a cancel, and `key` is emitted
  // before that, so it is the only place the two can be told apart.
  prompt.on('key', (_char, key) => {
    if (key.name === 'escape') {
      escaped = true;
    }
  });

  const result = await prompt.prompt();
  if (escaped) {
    return back.value;
  }
  if (result === undefined) {
    throw new Error('unreachable: sectionedSelect always offers its back option');
  }
  return result;
}

function buildRows(
  sections: readonly SectionedSelectSection[],
  back: SectionedSelectOption,
): Row[] {
  const rows: Row[] = [];
  for (const section of sections) {
    if (section.options.length === 0) {
      continue;
    }
    if (rows.length > 0) {
      rows.push({ kind: 'blank', value: '', label: '', disabled: true });
    }
    if (section.heading !== undefined) {
      rows.push({ kind: 'heading', value: '', label: section.heading, disabled: true });
    }
    rows.push(...section.options.map(optionRow));
  }
  rows.push(optionRow(back));
  return rows;
}

function optionRow(option: SectionedSelectOption): Row {
  return { kind: 'option', value: option.value, label: option.label, disabled: false };
}

function styleRow(row: Row, isActive: boolean, output: Writable): string {
  if (row.kind === 'heading') {
    return styleText('bold', row.label, { stream: output });
  }
  if (row.kind === 'blank') {
    return '';
  }
  if (isActive) {
    return `${styleText('green', S_RADIO_ACTIVE, { stream: output })} ${row.label}`;
  }
  return `${styleText('dim', S_RADIO_INACTIVE, { stream: output })} ${styleText('dim', row.label, { stream: output })}`;
}
