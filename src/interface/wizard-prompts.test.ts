// @vitest-environment node

import { settings } from '@clack/core';
import {
  isCancel,
  S_BAR,
  S_BAR_END,
  confirm as stockConfirm,
  select as stockSelect,
  text as stockText,
} from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildTerminal, replayScreen } from './__fixtures__/terminal.fixtures';
import { createStatusLine } from './status-line';
import { confirm, select, text } from './wizard-prompts';

import type { Option } from '@clack/prompts';

type Terminal = ReturnType<typeof buildTerminal>;
type StatusLine = ReturnType<typeof createStatusLine>;
type Press = readonly [string | undefined, { name: string; ctrl?: boolean; sequence?: string }];
type Step = string | Press;
type TextOptions = Omit<Parameters<typeof text>[0], 'input' | 'output' | 'signal' | 'statusLine'>;

type Case = {
  kind: 'text' | 'confirm' | 'select';
  name: string;
  message: string;
  steps: readonly Step[];
  ours(terminal: Terminal, statusLine: StatusLine): Promise<unknown>;
  stock(terminal: Terminal): Promise<unknown>;
};

type Kind = {
  name: 'text' | 'confirm' | 'select';
  message: string;
  /** Steps that move the prompt off its defaults, so an Escape that reset it would show. */
  prepare: readonly Step[];
  /** What Enter resolves after `prepare`. */
  submitted: unknown;
  open(terminal: Terminal, statusLine: StatusLine, signal?: AbortSignal): Promise<unknown>;
  stock(terminal: Terminal): Promise<unknown>;
};

type Running = {
  terminal: Terminal;
  statusLine: StatusLine;
  result: Promise<unknown>;
  state: { settled: boolean; value: unknown };
};

const ESC = '\u001b';
const IDLE_HINT = 'Ctrl-C to exit';

const ENTER: Press = ['\r', { name: 'return' }];
const UP: Press = [undefined, { name: 'up' }];
const DOWN: Press = [undefined, { name: 'down' }];
const LEFT: Press = [undefined, { name: 'left' }];
const RIGHT: Press = [undefined, { name: 'right' }];
const YES: Press = ['y', { name: 'y' }];
const NO: Press = ['n', { name: 'n' }];
const CTRL_C: Press = ['\u0003', { name: 'c', ctrl: true, sequence: '\u0003' }];
const ESCAPE: Press = [ESC, { name: 'escape', sequence: ESC }];

const SELECT_OPTIONS: Option<string>[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', hint: 'second' },
  { value: 'c', label: 'Gamma' },
  { value: 'd', label: 'Delta', disabled: true },
];

function textCase(name: string, options: Partial<TextOptions>, steps: readonly Step[]): Case {
  const full = { message: 'Output directory', ...options };
  return {
    kind: 'text',
    name,
    message: full.message,
    steps,
    ours: (terminal, statusLine) => text({ ...full, ...terminal, statusLine }),
    stock: (terminal) => stockText({ ...full, ...terminal }),
  };
}

function confirmCase(name: string, initialValue: boolean, steps: readonly Step[]): Case {
  const full = { message: 'Add another criterion', initialValue };
  return {
    kind: 'confirm',
    name,
    message: full.message,
    steps,
    ours: (terminal, statusLine) => confirm({ ...full, ...terminal, statusLine }),
    stock: (terminal) => stockConfirm({ ...full, ...terminal }),
  };
}

function selectCase(name: string, initialValue: string | undefined, steps: readonly Step[]): Case {
  const full = { message: 'Provider', options: SELECT_OPTIONS, initialValue };
  return {
    kind: 'select',
    name,
    message: full.message,
    steps,
    ours: (terminal, statusLine) => select({ ...full, ...terminal, statusLine }),
    stock: (terminal) => stockSelect({ ...full, ...terminal }),
  };
}

const CASES: readonly Case[] = [
  textCase('a typed answer', {}, ['runs', ENTER]),
  textCase('a placeholder replaced by typing', { placeholder: 'runs' }, ['x', ENTER]),
  textCase('the default value on Enter', { placeholder: 'runs', defaultValue: 'runs' }, [ENTER]),
  textCase('an initial value', { initialValue: 'seed' }, [ENTER]),
  textCase(
    'a validation error cleared by typing',
    { validate: (value) => (value === 'bad' ? 'Not allowed' : undefined) },
    ['bad', ENTER, 'x', ENTER],
  ),
  textCase(
    'a validation error on empty input',
    { validate: (value) => (value ? undefined : 'Required') },
    [ENTER, 'x', ENTER],
  ),
  textCase('Ctrl-C after typing', {}, ['ab', CTRL_C]),
  textCase('Ctrl-C on empty input', {}, [CTRL_C]),
  confirmCase('Enter on the default Yes', true, [ENTER]),
  confirmCase('Right then Enter', true, [RIGHT, ENTER]),
  confirmCase('Left from No then Enter', false, [LEFT, ENTER]),
  confirmCase('y from No', false, [YES]),
  confirmCase('n from Yes', true, [NO]),
  confirmCase('Ctrl-C on Yes', true, [CTRL_C]),
  confirmCase('Ctrl-C after toggling', true, [RIGHT, CTRL_C]),
  selectCase('Enter on the first option', undefined, [ENTER]),
  selectCase('Down, Down, Up, Enter', undefined, [DOWN, DOWN, UP, ENTER]),
  selectCase('an initial value with a hint', 'b', [ENTER]),
  selectCase('navigation that skips the disabled option', undefined, [DOWN, DOWN, DOWN, ENTER]),
  selectCase('Ctrl-C after moving down', undefined, [DOWN, CTRL_C]),
];

const KINDS: readonly Kind[] = [
  {
    name: 'text',
    message: 'Output directory',
    prepare: ['runs'],
    submitted: 'runs',
    open: (terminal, statusLine, signal) =>
      text({ message: 'Output directory', ...terminal, signal, statusLine }),
    stock: (terminal) => stockText({ message: 'Output directory', ...terminal }),
  },
  {
    name: 'confirm',
    message: 'Add another criterion',
    prepare: [RIGHT],
    submitted: false,
    open: (terminal, statusLine, signal) =>
      confirm({
        message: 'Add another criterion',
        initialValue: true,
        ...terminal,
        signal,
        statusLine,
      }),
    stock: (terminal) =>
      stockConfirm({ message: 'Add another criterion', initialValue: true, ...terminal }),
  },
  {
    name: 'select',
    message: 'Provider',
    prepare: [DOWN],
    submitted: 'b',
    open: (terminal, statusLine, signal) =>
      select({ message: 'Provider', options: SELECT_OPTIONS, ...terminal, signal, statusLine }),
    stock: (terminal) => stockSelect({ message: 'Provider', options: SELECT_OPTIONS, ...terminal }),
  },
];

async function flush(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    return;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const openRuns: Running[] = [];

function track(terminal: Terminal, statusLine: StatusLine, result: Promise<unknown>): Running {
  const state = { settled: false, value: undefined as unknown };
  const tracked = result.then((value) => {
    state.settled = true;
    state.value = value;
    return value;
  });
  const running = { terminal, statusLine, result: tracked, state };
  openRuns.push(running);
  return running;
}

function apply(terminal: Terminal, step: Step): void {
  if (typeof step === 'string') {
    terminal.input.push(step);
    return;
  }
  terminal.input.emit('keypress', ...step);
}

async function applyAll(terminal: Terminal, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    apply(terminal, step);
    await flush();
  }
}

function screenOf(running: Pick<Running, 'terminal'>): ReturnType<typeof replayScreen> {
  return replayScreen(running.terminal.output.text);
}

async function startPrepared(kind: Kind, signal?: AbortSignal): Promise<Running> {
  const terminal = buildTerminal();
  const statusLine = createStatusLine();
  const running = track(terminal, statusLine, kind.open(terminal, statusLine, signal));
  await applyAll(terminal, kind.prepare);
  return running;
}

async function startStock(kind: Kind, steps: readonly Step[]): Promise<Running> {
  const terminal = buildTerminal();
  const running = track(terminal, createStatusLine(), kind.stock(terminal));
  await applyAll(terminal, steps);
  return running;
}

function expectFrameMatchesStock(
  label: string,
  message: string,
  idleRow: string,
  ours: { screen: ReturnType<typeof replayScreen>; settled: boolean },
  stock: { screen: ReturnType<typeof replayScreen>; settled: boolean },
): void {
  expect(stock.screen.rows.join('\n'), label).toContain(message);
  expect(ours.screen.rows.join('\n'), label).toContain(message);
  if (stock.settled) {
    expect(ours.settled, label).toBe(true);
    expect(ours.screen, label).toEqual(stock.screen);
    return;
  }
  expect(ours.settled, label).toBe(false);
  expect(ours.screen.rows, label).toEqual([
    ...stock.screen.rows.slice(0, stock.screen.cursorRow),
    idleRow,
    ...stock.screen.rows.slice(stock.screen.cursorRow),
  ]);
  expect(ours.screen.cursorRow, label).toBe(stock.screen.cursorRow + 1);
}

/** The status line row an exit prompt draws on `terminal` while no message is shown, without its newline. */
function idleRowOn(terminal: Terminal): string {
  return createStatusLine().row('active', terminal.output, IDLE_HINT).slice(0, -1);
}

async function expectMatchesStock(
  subject: Case,
  tamper: (bytes: string) => string = (bytes) => bytes,
): Promise<void> {
  const oursTerminal = buildTerminal();
  const stockTerminal = buildTerminal();
  const ours = track(
    oursTerminal,
    createStatusLine(),
    subject.ours(oursTerminal, createStatusLine()),
  );
  const stock = track(stockTerminal, createStatusLine(), subject.stock(stockTerminal));
  const compare = (label: string): void => {
    expectFrameMatchesStock(
      label,
      subject.message,
      idleRowOn(oursTerminal),
      { screen: replayScreen(tamper(oursTerminal.output.text)), settled: ours.state.settled },
      { screen: replayScreen(stockTerminal.output.text), settled: stock.state.settled },
    );
  };

  await flush();
  compare('first frame');
  for (const [index, step] of subject.steps.entries()) {
    apply(oursTerminal, step);
    apply(stockTerminal, step);
    await flush();
    compare(`after step ${String(index + 1)}`);
  }

  const [oursValue, stockValue] = await Promise.all([ours.result, stock.result]);
  if (isCancel(stockValue)) {
    expect(isCancel(oursValue)).toBe(true);
  } else {
    expect(oursValue).toBe(stockValue);
  }
}

function expectSettledScreen(screen: ReturnType<typeof replayScreen>): void {
  expect(screen.cursorRow).toBe(screen.rows.length - 1);
  expect(screen.rows.at(-1)).toBe('');
  expect(screen.rows.at(-2)).not.toBe('');
}

beforeEach(() => {
  vi.stubEnv('FORCE_COLOR', '0');
});

afterEach(async () => {
  for (const running of openRuns.splice(0)) {
    if (!running.state.settled) {
      apply(running.terminal, CTRL_C);
    }
  }
  await flush();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.each(['1', '0'])('wizard prompts under FORCE_COLOR=%s', (level) => {
  beforeEach(() => {
    vi.stubEnv('FORCE_COLOR', level);
  });

  it.each(CASES)(
    'draws the stock $kind frames plus one reserved row for $name',
    async (subject) => {
      await expectMatchesStock(subject);
    },
  );
});

describe('the stock comparison', () => {
  const [typed] = CASES;

  it('fails for a port that draws no reserved row', async () => {
    const stockAsPort: Case = { ...typed!, ours: (terminal) => typed!.stock(terminal) };

    await expect(expectMatchesStock(stockAsPort)).rejects.toThrow();
  });

  it('fails for a port that draws S_BAR where the stock frame draws S_BAR_END', async () => {
    await expect(
      expectMatchesStock(typed!, (bytes) => bytes.replaceAll(S_BAR_END, S_BAR)),
    ).rejects.toThrow();
  });

  it('fails for a port that draws other text in the reserved row', async () => {
    await expect(
      expectMatchesStock(typed!, (bytes) => bytes.replace(IDLE_HINT, 'Esc to exit')),
    ).rejects.toThrow();
  });
});

describe('select list window', () => {
  const manyOptions: Option<string>[] = Array.from({ length: 30 }, (_, index) => ({
    value: `option-${String(index)}`,
    label: `Option ${String(index)}`,
  }));

  it.each([
    { name: 'the top of the list', initialValue: undefined },
    { name: 'a cursor scrolled to the end', initialValue: 'option-27' },
  ])(
    'takes one terminal row from the list for $name, as stock select does on a terminal one row shorter',
    async ({ initialValue }) => {
      const rows = 14;
      const ours = buildTerminal({ columns: 80, rows });
      const stock = buildTerminal({ columns: 80, rows: rows - 1 });
      const stockAtSameRows = buildTerminal({ columns: 80, rows });
      const options = { message: 'Provider', options: manyOptions, initialValue };

      const statusLine = createStatusLine();
      track(ours, statusLine, select({ ...options, ...ours, statusLine }));
      track(stock, statusLine, stockSelect({ ...options, ...stock }));
      track(stockAtSameRows, statusLine, stockSelect({ ...options, ...stockAtSameRows }));
      await flush();

      const idleRow = `  ${IDLE_HINT}\n`;
      expect(ours.output.text).toBe(`${stock.output.text}${idleRow}`);
      expect(ours.output.text).toContain('...');
      expect(ours.output.text).not.toBe(`${stockAtSameRows.output.text}${idleRow}`);
    },
  );
});

describe.each(KINDS)('$name prompt Escape', (kind) => {
  const READLINE_ESCAPE_WINDOW_MS = 60;

  function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  describe.each(['1', '0'])('under FORCE_COLOR=%s', (level) => {
    beforeEach(() => {
      vi.stubEnv('FORCE_COLOR', level);
    });

    it.each([
      { name: 'one Escape', escapes: [ESCAPE] },
      { name: 'two Escapes in a row', escapes: [ESCAPE, ESCAPE] },
    ])('leaves the prompt open and the screen unchanged after $name', async ({ escapes }) => {
      const running = await startPrepared(kind);
      const before = screenOf(running);

      await applyAll(running.terminal, escapes);
      const after = screenOf(running);

      expect(running.state.settled).toBe(false);
      expect(after.rows).toEqual(before.rows);
      expect(after.cursorRow).toBe(before.cursorRow);
    });

    it('leaves the screen unchanged when the second Escape comes 799 ms after the first', async () => {
      vi.useFakeTimers();
      const running = await startPrepared(kind);
      const before = screenOf(running);

      apply(running.terminal, ESCAPE);
      await flush();
      await vi.advanceTimersByTimeAsync(799);
      apply(running.terminal, ESCAPE);
      await flush();

      expect(running.state.settled).toBe(false);
      expect(screenOf(running)).toEqual(before);
    });

    it.each([
      { name: 'one Escape', escapes: [ESCAPE] },
      { name: 'two Escapes', escapes: [ESCAPE, ESCAPE] },
    ])(
      'resolves the prepared answer with the screen of Enter alone when Enter follows $name',
      async ({ escapes }) => {
        const running = await startPrepared(kind);
        const stock = await startStock(kind, [...kind.prepare, ENTER]);

        await applyAll(running.terminal, escapes);
        apply(running.terminal, ENTER);
        await flush();

        expect(await running.result).toBe(kind.submitted);
        expect(screenOf(running)).toEqual(screenOf(stock));
      },
    );
  });

  it('leaves the prompt open when two ESC bytes arrive in one chunk', async () => {
    const running = await startPrepared(kind);
    const before = screenOf(running);

    running.terminal.input.push(ESC + ESC);
    await wait(READLINE_ESCAPE_WINDOW_MS);

    expect(running.state.settled).toBe(false);
    expect(screenOf(running)).toEqual(before);
  });

  it('leaves the prompt open when two ESC bytes are read as separate keypresses', async () => {
    const running = await startPrepared(kind);
    const before = screenOf(running);

    running.terminal.input.push(ESC);
    await wait(READLINE_ESCAPE_WINDOW_MS);
    running.terminal.input.push(ESC);
    await wait(READLINE_ESCAPE_WINDOW_MS);

    expect(running.state.settled).toBe(false);
    expect(screenOf(running)).toEqual(before);
  });

  it('still resolves the cancel value on Ctrl-C after an Escape', async () => {
    const running = await startPrepared(kind);
    apply(running.terminal, ESCAPE);
    await flush();

    apply(running.terminal, CTRL_C);
    await flush();

    expect(isCancel(await running.result)).toBe(true);
  });
});

describe('confirm prompt keys after an Escape', () => {
  it.each([
    { name: 'y', key: YES, expected: true, initialValue: false },
    { name: 'n', key: NO, expected: false, initialValue: true },
  ])(
    'submits $expected on $name after an Escape, with the screen of $name alone',
    async ({ key, expected, initialValue }) => {
      const options = { message: 'Add another criterion', initialValue };
      const terminal = buildTerminal();
      const stockTerminal = buildTerminal();
      const running = track(
        terminal,
        createStatusLine(),
        confirm({ ...options, ...terminal, statusLine: createStatusLine() }),
      );
      const stock = track(
        stockTerminal,
        createStatusLine(),
        stockConfirm({ ...options, ...stockTerminal }),
      );
      await flush();

      apply(terminal, ESCAPE);
      await flush();
      apply(terminal, key);
      apply(stockTerminal, key);
      await flush();

      expect(await running.result).toBe(expected);
      expect(screenOf(running)).toEqual(screenOf(stock));
    },
  );
});

describe('text prompt onCancel', () => {
  async function openText(
    onCancel: (typed: string) => void,
    steps: readonly Step[],
  ): Promise<unknown> {
    const terminal = buildTerminal();
    const statusLine = createStatusLine();
    const running = track(
      terminal,
      statusLine,
      text({ message: 'Output directory', ...terminal, statusLine, onCancel }),
    );

    await applyAll(terminal, steps);

    return running.result;
  }

  it('reports the typed text once when Ctrl-C cancels the prompt', async () => {
    const onCancel = vi.fn();

    const value = await openText(onCancel, ['abc', CTRL_C]);

    expect(isCancel(value)).toBe(true);
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('abc');
  });

  it('reports an empty string when Ctrl-C cancels a prompt with nothing typed', async () => {
    const onCancel = vi.fn();

    await openText(onCancel, [CTRL_C]);

    expect(onCancel).toHaveBeenCalledExactlyOnceWith('');
  });

  it('reports the text typed after an Escape', async () => {
    const onCancel = vi.fn();

    await openText(onCancel, ['ab', ESCAPE, 'c', CTRL_C]);

    expect(onCancel).toHaveBeenCalledExactlyOnceWith('abc');
  });

  it('does not report anything when Enter submits the answer', async () => {
    const onCancel = vi.fn();

    const value = await openText(onCancel, ['abc', ENTER]);

    expect(value).toBe('abc');
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('settle paths', () => {
  const PATHS: ReadonlyArray<{ name: string; keys: readonly Step[] }> = [
    { name: 'Enter', keys: [ENTER] },
    { name: 'Ctrl-C', keys: [CTRL_C] },
    { name: 'Enter after an Escape', keys: [ESCAPE, ENTER] },
    { name: 'Ctrl-C after an Escape', keys: [ESCAPE, CTRL_C] },
  ];
  const settleCases = KINDS.flatMap((kind) =>
    PATHS.map((path) => ({ kind, kindName: kind.name, pathName: path.name, keys: path.keys })),
  );

  it.each(settleCases)(
    'restores the alias and leaves no row for the $kindName prompt settled by $pathName',
    async ({ kind, keys }) => {
      const running = await startPrepared(kind);
      const aliasWhileOpen = settings.aliases.has('escape');

      await applyAll(running.terminal, keys);
      await running.result;

      expect(aliasWhileOpen).toBe(false);
      expect(settings.aliases.get('escape')).toBe('cancel');
      expectSettledScreen(screenOf(running));
    },
  );

  it.each([
    { name: 'y', key: YES, initialValue: false },
    { name: 'n', key: NO, initialValue: true },
  ])('leaves no row after $name settles the confirm prompt', async ({ key, initialValue }) => {
    const terminal = buildTerminal();
    const statusLine = createStatusLine();
    const running = track(
      terminal,
      statusLine,
      confirm({ message: 'Add another criterion', initialValue, ...terminal, statusLine }),
    );
    await flush();

    apply(terminal, key);
    await flush();
    await running.result;

    expectSettledScreen(screenOf(running));
    expect(settings.aliases.get('escape')).toBe('cancel');
  });

  it.each(KINDS)('restores the alias when the signal aborts the $name prompt', async (kind) => {
    const controller = new AbortController();
    const running = await startPrepared(kind, controller.signal);
    apply(running.terminal, ESCAPE);
    await flush();

    controller.abort();
    const value = await running.result;

    expect(isCancel(value)).toBe(true);
    expect(settings.aliases.get('escape')).toBe('cancel');
  });

  it.each(KINDS)('restores the alias when the $name prompt fails while drawing', async (kind) => {
    const terminal = buildTerminal();
    const statusLine = createStatusLine();
    vi.spyOn(terminal.output, 'write').mockImplementation(() => {
      throw new Error('write failed');
    });

    await expect(kind.open(terminal, statusLine)).rejects.toThrow('write failed');

    expect(settings.aliases.get('escape')).toBe('cancel');
    terminal.input.destroy();
  });
});
