// @vitest-environment node

import { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import {
  isCancel,
  S_BAR,
  S_BAR_END,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  S_STEP_ACTIVE,
  S_STEP_CANCEL,
  S_STEP_SUBMIT,
  select,
} from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { replayScreen } from './__fixtures__/terminal.fixtures';
import { renderSectionedSelect, sectionedSelect } from './sectioned-select';
import { createStatusLine } from './status-line';
import { text } from './wizard-prompts';

type Options = Parameters<typeof sectionedSelect>[0];
type Sections = Options['sections'];
type Press = readonly [string | undefined, { name: string; ctrl?: boolean; sequence?: string }];

const BACK = { value: 'back', label: 'Back to the review' };
const FOOTER = ['↑/↓ to navigate • Enter: confirm'];

const UP: Press = [undefined, { name: 'up' }];
const DOWN: Press = [undefined, { name: 'down' }];
const LEFT: Press = [undefined, { name: 'left' }];
const RIGHT: Press = [undefined, { name: 'right' }];
const SPACE: Press = [' ', { name: 'space' }];
const TAB: Press = ['\t', { name: 'tab' }];
const ENTER: Press = ['\r', { name: 'return' }];
const CTRL_C: Press = ['\u0003', { name: 'c', ctrl: true, sequence: '\u0003' }];
const ESC = '\u001b';
const BOLD_ACCEPTANCE = `${ESC}[1mAcceptance Criteria${ESC}[22m`;
const BOLD_DONE = `${ESC}[1mDefinition of Done${ESC}[22m`;

function letter(name: string): Press {
  return [name, { name }];
}

class FakeOutput extends Writable {
  readonly chunks: string[] = [];

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }

  _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(String(chunk));
    callback();
  }

  get text(): string {
    return this.chunks.join('');
  }
}

function createStreams(size: { columns: number; rows: number } = { columns: 80, rows: 20 }): {
  input: Readable;
  output: FakeOutput;
} {
  return { input: new Readable({ read() {} }), output: new FakeOutput(size.columns, size.rows) };
}

function buildItemSections(
  acceptance: readonly string[] = ['A1', 'A2'],
  done: readonly string[] = ['D1'],
): Sections {
  return [
    {
      heading: 'Acceptance Criteria',
      options: acceptance.map((label, index) => ({ value: `acceptance:${String(index)}`, label })),
    },
    {
      heading: 'Definition of Done',
      options: done.map((label, index) => ({ value: `done:${String(index)}`, label })),
    },
  ];
}

function buildAddToSections(): Sections {
  return [
    {
      options: [
        { value: 'acceptance', label: 'Acceptance Criteria' },
        { value: 'done', label: 'Definition of Done' },
      ],
    },
  ];
}

function lines(text: string): string[] {
  return stripVTControlCharacters(text).split('\n');
}

function bar(text: string): string {
  return `${S_BAR}  ${text}`;
}

function activeFrame(message: string, body: readonly string[]): string[] {
  return [
    S_BAR,
    `${S_STEP_ACTIVE}  ${message}`,
    ...body.map(bar),
    ...FOOTER.map(bar),
    S_BAR_END,
    '',
  ];
}

const active = (label: string): string => `${S_RADIO_ACTIVE} ${label}`;
const inactive = (label: string): string => `${S_RADIO_INACTIVE} ${label}`;

function renderLines(
  frame: Partial<Parameters<typeof renderSectionedSelect>[0]> & { focused: string },
  size: { columns: number; rows: number } = { columns: 80, rows: 20 },
): string[] {
  return lines(renderRaw(frame, size));
}

function renderRaw(
  frame: Partial<Parameters<typeof renderSectionedSelect>[0]> & { focused: string },
  size: { columns: number; rows: number } = { columns: 80, rows: 20 },
): string {
  return renderSectionedSelect({
    message: 'Item to edit',
    sections: buildItemSections(),
    back: BACK,
    output: createStreams(size).output,
    state: 'active',
    statusRow: '',
    ...frame,
  });
}

function start(overrides: Partial<Options> = {}): {
  input: Readable;
  output: FakeOutput;
  result: Promise<string | symbol>;
  writtenSince: (mark: number) => string;
} {
  const { input, output } = createStreams();
  const result = sectionedSelect({
    message: 'Item to edit',
    sections: buildItemSections(),
    back: BACK,
    input,
    output,
    statusLine: createStatusLine(),
    ...overrides,
  });
  return { input, output, result, writtenSince: (mark) => output.text.slice(mark) };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function press(input: Readable, ...presses: readonly Press[]): void {
  for (const keypress of presses) {
    input.emit('keypress', ...keypress);
  }
}

async function choose(
  presses: readonly Press[],
  overrides: Partial<Options> = {},
): Promise<unknown> {
  const { input, result } = start(overrides);

  press(input, ...presses);

  return result;
}

const IDLE_ROW = '  Esc to go back · Ctrl-C to exit';

const EDIT_FRAME = activeFrame('Item to edit', [
  'Acceptance Criteria',
  active('A1'),
  inactive('A2'),
  '',
  'Definition of Done',
  inactive('D1'),
  inactive('Back to the review'),
]);

beforeEach(() => {
  vi.stubEnv('FORCE_COLOR', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderSectionedSelect', () => {
  it.each([{ state: 'active' as const }, { state: 'initial' as const }])(
    'draws headings without markers, one blank row, and the cursor row for the $state state',
    ({ state }) => {
      const frame = renderLines({ state, focused: 'acceptance:0' });

      expect(frame).toEqual(EDIT_FRAME);
    },
  );

  it('draws only the focused label after a green diamond for the submit state', () => {
    const frame = renderLines({ state: 'submit', focused: 'acceptance:1' });

    expect(frame).toEqual([S_BAR, `${S_STEP_SUBMIT}  Item to edit`, bar('A2')]);
  });

  it('draws the focused label after a red square and a closing bar for the cancel state', () => {
    const frame = renderLines({ state: 'cancel', focused: 'done:0' });

    expect(frame).toEqual([S_BAR, `${S_STEP_CANCEL}  Item to edit`, bar('D1'), S_BAR]);
  });

  it('wraps each heading in bold when color is on', () => {
    vi.stubEnv('FORCE_COLOR', '1');

    const frame = renderRaw({ focused: 'acceptance:0' }).split('\n');

    expect(frame[2]?.slice(-BOLD_ACCEPTANCE.length)).toBe(BOLD_ACCEPTANCE);
    expect(frame[6]?.slice(-BOLD_DONE.length)).toBe(BOLD_DONE);
  });

  it('draws no escape sequence when color is off', () => {
    const raw = renderRaw({ focused: 'acceptance:0' });

    expect(raw).toBe(stripVTControlCharacters(raw));
  });

  it('skips the heading and the blank row of an empty Acceptance Criteria section', () => {
    const frame = renderLines({
      message: 'Item to remove',
      sections: buildItemSections([], ['D1']),
      focused: 'done:0',
    });

    expect(frame).toEqual(
      activeFrame('Item to remove', [
        'Definition of Done',
        active('D1'),
        inactive('Back to the review'),
      ]),
    );
  });

  it('skips the heading and the blank row of an empty Definition of Done section', () => {
    const frame = renderLines({
      message: 'Item to remove',
      sections: buildItemSections(['A1'], []),
      focused: 'acceptance:0',
    });

    expect(frame).toEqual(
      activeFrame('Item to remove', [
        'Acceptance Criteria',
        active('A1'),
        inactive('Back to the review'),
      ]),
    );
  });

  it('shows only the back row when both sections are empty', () => {
    const frame = renderLines({
      message: 'Item to remove',
      sections: buildItemSections([], []),
      focused: 'back',
    });

    expect(frame).toEqual(activeFrame('Item to remove', [active('Back to the review')]));
  });

  describe('when the list is taller than the terminal', () => {
    const sections = buildItemSections(
      ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'],
      ['D1', 'D2'],
    );
    const size = { columns: 80, rows: 10 };

    it('scrolls the window to the top and marks the hidden rows below with dots', () => {
      const frame = renderLines({ sections, focused: 'acceptance:0' }, size);

      expect(frame).toEqual(
        activeFrame('Item to edit', ['Acceptance Criteria', active('A1'), inactive('A2'), '...']),
      );
    });

    it('scrolls the window to the cursor and marks the hidden rows above with dots', () => {
      const frame = renderLines({ sections, focused: 'done:0' }, size);

      expect(frame).toEqual(
        activeFrame('Item to edit', [
          '...',
          active('D1'),
          inactive('D2'),
          inactive('Back to the review'),
        ]),
      );
    });
  });

  it('hard-wraps a long label at the terminal width with the same prefix on the continuation line', () => {
    const label =
      'The task prompt, in whole or in part, never appears in the agent command-line arguments of any spawned process.';

    const frame = renderLines(
      { sections: buildItemSections([label], []), focused: 'acceptance:0' },
      { columns: 60, rows: 20 },
    );

    expect(frame).toEqual([
      S_BAR,
      `${S_STEP_ACTIVE}  Item to edit`,
      bar('Acceptance Criteria'),
      bar(`${S_RADIO_ACTIVE} The task prompt, in whole or in part, never appears in `),
      bar('the agent command-line arguments of any spawned process.'),
      bar(inactive('Back to the review')),
      ...FOOTER.map(bar),
      S_BAR_END,
      '',
    ]);
  });

  it('renders an unheaded section with no heading row and no blank row', () => {
    const frame = renderLines({
      message: 'Add to',
      sections: buildAddToSections(),
      focused: 'acceptance',
    });

    expect(frame).toEqual(
      activeFrame('Add to', [
        active('Acceptance Criteria'),
        inactive('Definition of Done'),
        inactive('Back to the review'),
      ]),
    );
  });
});

describe('sectionedSelect navigation', () => {
  it.each([
    { name: 'no key', presses: [], expected: 'acceptance:0' },
    { name: 'Down Down', presses: [DOWN, DOWN], expected: 'done:0' },
    { name: 'j j', presses: [letter('j'), letter('j')], expected: 'done:0' },
    { name: 'Up', presses: [UP], expected: 'back' },
    { name: 'k', presses: [letter('k')], expected: 'back' },
    { name: 'Down four times', presses: [DOWN, DOWN, DOWN, DOWN], expected: 'acceptance:0' },
  ])(
    'starts on the first item and resolves $expected after $name',
    async ({ presses, expected }) => {
      const value = await choose([...presses, ENTER]);

      expect(value).toBe(expected);
    },
  );

  it('never rests on a heading or the blank row for any short sequence of keys', async () => {
    const keys = [
      UP,
      DOWN,
      LEFT,
      RIGHT,
      letter('j'),
      letter('k'),
      letter('h'),
      letter('l'),
      SPACE,
      TAB,
      letter('x'),
    ];
    const selectable = new Set(['acceptance:0', 'acceptance:1', 'done:0', 'back']);
    let sequences: Press[][] = [[]];
    const unexpected: string[] = [];

    for (let length = 1; length <= 3; length += 1) {
      sequences = sequences.flatMap((prefix) => keys.map((key) => [...prefix, key]));
      for (const sequence of sequences) {
        const value = await choose([...sequence, ENTER]);
        if (typeof value !== 'string' || !selectable.has(value)) {
          unexpected.push(sequence.map(([, key]) => key.name).join(' '));
        }
      }
    }

    expect(unexpected).toEqual([]);
  });

  it.each([
    {
      name: 'only Definition of Done items',
      sections: buildItemSections([], ['D1']),
      expected: 'done:0',
    },
    {
      name: 'only Acceptance Criteria items',
      sections: buildItemSections(['A1'], []),
      expected: 'acceptance:0',
    },
    { name: 'no items', sections: buildItemSections([], []), expected: 'back' },
  ])('resolves $expected on Enter alone for a list with $name', async ({ sections, expected }) => {
    const value = await choose([ENTER], { message: 'Item to remove', sections });

    expect(value).toBe(expected);
  });
});

describe('sectionedSelect cancel', () => {
  it('resolves the cancel value on Ctrl-C after moving down', async () => {
    const value = await choose([DOWN, CTRL_C]);

    expect(isCancel(value)).toBe(true);
  });

  it('resolves the cancel value when the signal is aborted before the call', async () => {
    const controller = new AbortController();
    controller.abort();

    const value = await choose([], { signal: controller.signal });

    expect(isCancel(value)).toBe(true);
  });

  it('resolves the cancel value when the signal is aborted after the first frame', async () => {
    const controller = new AbortController();
    const { result } = start({ signal: controller.signal });

    controller.abort();

    expect(isCancel(await result)).toBe(true);
  });

  it('draws the initial frame as the first frame before any key', () => {
    const { output } = start();

    expect(stripVTControlCharacters(output.text)).toBe(`${EDIT_FRAME.join('\n')}${IDLE_ROW}\n`);
  });
});

describe('sectionedSelect Escape', () => {
  it('resolves back after drawing the submit frame on back when Escape is the first key', async () => {
    const { input, output, result } = start();
    const mark = output.text.length;

    input.push(ESC);
    const value = await result;

    expect(value).toBe('back');
    expect(isCancel(value)).toBe(false);
    expect(lines(output.text.slice(mark))).toEqual([
      `${S_STEP_SUBMIT}  Item to edit`,
      bar('Back to the review'),
      '',
    ]);
  });

  it('resolves back when two Escape bytes arrive in one chunk', async () => {
    const { input, result } = start();

    input.push(`${ESC}${ESC}`);

    expect(await result).toBe('back');
  });

  it('resolves back when Escape follows a Down key', async () => {
    const { input, result } = start();

    press(input, DOWN);
    input.push(ESC);

    expect(await result).toBe('back');
  });

  it('handles Escape with no heading in the section by resolving back', async () => {
    const { input, output, result } = start({
      message: 'Add to',
      sections: buildAddToSections(),
    });
    const mark = output.text.length;

    input.push(ESC);
    const value = await result;

    expect(value).toBe('back');
    expect(isCancel(value)).toBe(false);
    expect(lines(output.text.slice(mark))).toEqual([
      `${S_STEP_SUBMIT}  Add to`,
      bar('Back to the review'),
      '',
    ]);
  });
});

describe('sectionedSelect Ctrl-C and escape sequences over raw bytes', () => {
  it('resolves the cancel value and draws the cancel frame on the Ctrl-C byte', async () => {
    const { input, output, result } = start();
    const mark = output.text.length;

    input.push('\u0003');
    const value = await result;

    expect(isCancel(value)).toBe(true);
    expect(lines(output.text.slice(mark))).toEqual([
      `${S_STEP_CANCEL}  Item to edit`,
      bar('A1'),
      S_BAR,
      '',
    ]);
  });

  it('reads an escape sequence for Down in one chunk as Down, not Escape', async () => {
    const { input, result } = start();

    input.push(`${ESC}[B`);
    input.push('\r');

    expect(await result).toBe('acceptance:1');
  });

  it('reads an escape sequence split across two pushes as Down, not Escape', async () => {
    const { input, result } = start();

    input.push(ESC);
    input.push('[B');
    input.push('\r');

    expect(await result).toBe('acceptance:1');
  });

  it('resolves the focused option when Enter is followed by an Escape byte in one chunk', async () => {
    const { input, result } = start();

    input.push(`\r${ESC}`);

    expect(await result).toBe('acceptance:0');
  });
});

describe('sectionedSelect with an unheaded section', () => {
  const stockOptions = [
    { value: 'acceptance', label: 'Acceptance Criteria' },
    { value: 'done', label: 'Definition of Done' },
    BACK,
  ];

  describe.each(['1', '0'])('under FORCE_COLOR=%s', (level) => {
    beforeEach(() => {
      vi.stubEnv('FORCE_COLOR', level);
    });

    it.each([
      { name: 'Enter', presses: [ENTER] },
      { name: 'Down, Enter', presses: [DOWN, ENTER] },
      { name: 'Down, Down, Enter', presses: [DOWN, DOWN, ENTER] },
      { name: 'Up, Enter', presses: [UP, ENTER] },
      { name: 'Ctrl-C', presses: [CTRL_C] },
      { name: 'Down, Ctrl-C', presses: [DOWN, CTRL_C] },
    ])(
      'draws the screens of select plus one reserved row and resolves the same value for $name',
      async ({ presses }) => {
        const ours = createStreams();
        const stock = createStreams();
        const settled = { ours: false, stock: false };
        const oursResult = sectionedSelect({
          message: 'Add to',
          sections: buildAddToSections(),
          back: BACK,
          statusLine: createStatusLine(),
          ...ours,
        }).then((value) => {
          settled.ours = true;
          return value;
        });
        const stockResult = select({ message: 'Add to', options: stockOptions, ...stock }).then(
          (value) => {
            settled.stock = true;
            return value;
          },
        );
        const expectSameScreens = (label: string): void => {
          const oursScreen = replayScreen(ours.output.text);
          const stockScreen = replayScreen(stock.output.text);
          expect(stockScreen.rows.join('\n'), label).toContain('Add to');
          expect(settled.ours, label).toBe(settled.stock);
          if (settled.stock) {
            expect(oursScreen, label).toEqual(stockScreen);
            return;
          }
          expect(oursScreen.rows, label).toEqual([
            ...stockScreen.rows.slice(0, stockScreen.cursorRow),
            level === '1' ? `  ${ESC}[2m${IDLE_ROW.trimStart()}${ESC}[22m` : IDLE_ROW,
            ...stockScreen.rows.slice(stockScreen.cursorRow),
          ]);
          expect(oursScreen.cursorRow, label).toBe(stockScreen.cursorRow + 1);
        };

        await flush();
        expectSameScreens('first frame');
        for (const [index, keypress] of presses.entries()) {
          press(ours.input, keypress);
          press(stock.input, keypress);
          await flush();
          expectSameScreens(`after key ${String(index + 1)}`);
        }
        const [oursValue, stockValue] = await Promise.all([oursResult, stockResult]);

        if (isCancel(stockValue)) {
          expect(isCancel(oursValue)).toBe(true);
        } else {
          expect(oursValue).toBe(stockValue);
        }
      },
    );
  });
});

describe('sectionedSelect status line', () => {
  function screenOf(output: FakeOutput): ReturnType<typeof replayScreen> {
    return replayScreen(output.text);
  }

  it('shows the key hint under the open frame', () => {
    const { output } = start();

    const screen = screenOf(output);

    expect(screen.rows).toEqual([...EDIT_FRAME.slice(0, -1), IDLE_ROW, '']);
    expect(screen.cursorRow).toBe(screen.rows.length - 1);
  });

  it.each([
    { name: 'Enter', presses: [ENTER] },
    { name: 'Ctrl-C', presses: [CTRL_C] },
  ])('leaves no status line row under the final frame after $name', async ({ presses }) => {
    const { input, output, result } = start();

    press(input, ...presses);
    await result;

    const screen = screenOf(output);
    expect(screen.cursorRow).toBe(screen.rows.length - 1);
    expect(screen.rows.at(-1)).toBe('');
    expect(screen.rows.at(-2)).not.toBe('');
    expect(screen.rows.join('\n')).not.toContain(IDLE_ROW.trim());
  });

  it('leaves no status line row under the final frame after Escape', async () => {
    const { input, output, result } = start();

    input.push(ESC);
    await result;

    const screen = screenOf(output);
    expect(screen.cursorRow).toBe(screen.rows.length - 1);
    expect(screen.rows.at(-1)).toBe('');
    expect(screen.rows.at(-2)).toBe(bar('Back to the review'));
    expect(screen.rows.join('\n')).not.toContain(IDLE_ROW.trim());
  });
});

describe('sectionedSelect status line on a short terminal', () => {
  const sections = buildItemSections(
    ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'],
    ['D1', 'D2'],
  );

  it.each([
    { name: 'the top of the list', focused: 'acceptance:0' },
    { name: 'a cursor scrolled to the end', focused: 'done:0' },
  ])('draws the frame of a terminal one row shorter plus the row for $name', ({ focused }) => {
    const withRow = renderRaw({ sections, focused, statusRow: '\n' }, { columns: 80, rows: 10 });
    const shorter = renderRaw({ sections, focused }, { columns: 80, rows: 9 });
    const sameRows = renderRaw({ sections, focused }, { columns: 80, rows: 10 });

    expect(withRow).toBe(`${shorter}\n`);
    expect(withRow).not.toBe(`${sameRows}\n`);
  });

  it('draws the row after the frame it draws today when it is a lone newline', () => {
    const frame = renderRaw({ focused: 'acceptance:0', statusRow: '\n' });

    expect(frame).toBe(`${renderRaw({ focused: 'acceptance:0' })}\n`);
  });

  it.each(['submit', 'cancel'] as const)(
    'appends the given row to the %s frame unchanged',
    (state) => {
      const frame = renderRaw({ state, focused: 'acceptance:0', statusRow: '<row>' });

      expect(frame).toBe(`${renderRaw({ state, focused: 'acceptance:0' })}<row>`);
    },
  );
});

describe('sectionedSelect after an exit prompt from the wizard prompts', () => {
  it.each([
    { name: 'submits', presses: [ENTER] },
    { name: 'is cancelled by Ctrl-C', presses: [CTRL_C] },
  ])('resolves back on one Escape once a text prompt $name', async ({ presses }) => {
    const exit = createStreams();
    const exitResult = text({
      message: 'Output directory',
      ...exit,
      statusLine: createStatusLine(),
    });
    press(exit.input, ...presses);
    await exitResult;
    const { input, result } = start();

    input.push(ESC);

    expect(await result).toBe('back');
  });
});
