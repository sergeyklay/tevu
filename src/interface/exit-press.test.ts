// @vitest-environment node

import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExitPresses, EXIT_HINT } from './exit-press';
import { createStatusLine } from './status-line';

const MESSAGE = 'Press Esc again to exit';
const SHOWN_ROW = `  ${MESSAGE}\n`;
const IDLE_ROW = `  ${EXIT_HINT}\n`;

function setup(): { statusLine: ReturnType<typeof createStatusLine>; row: () => string } {
  const statusLine = createStatusLine();
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return { statusLine, row: () => statusLine.row('active', output, EXIT_HINT) };
}

beforeEach(() => {
  vi.stubEnv('FORCE_COLOR', '0');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('createExitPresses', () => {
  it('shows the Ctrl-C confirmation on a first Ctrl-C and returns second on the next one', () => {
    const { statusLine, row } = setup();
    const exitPresses = createExitPresses(statusLine);

    const first = exitPresses.press('ctrl-c');
    const shown = row();
    const second = exitPresses.press('ctrl-c');

    expect(first).toBe('first');
    expect(shown).toBe('  Press Ctrl-C again to exit\n');
    expect(second).toBe('second');
  });

  it('opens a new window when the other key follows a first press', () => {
    const { statusLine, row } = setup();
    const exitPresses = createExitPresses(statusLine);
    exitPresses.press('escape');

    const press = exitPresses.press('ctrl-c');

    expect(press).toBe('first');
    expect(row()).toBe('  Press Ctrl-C again to exit\n');
  });

  it('shows the confirmation and returns first on the first press', () => {
    const { statusLine, row } = setup();
    const exitPresses = createExitPresses(statusLine);

    const press = exitPresses.press('escape');

    expect(press).toBe('first');
    expect(row()).toBe(SHOWN_ROW);
  });

  it('returns second and leaves the confirmation shown on a press at 799 ms', () => {
    const { statusLine, row } = setup();
    const exitPresses = createExitPresses(statusLine);
    exitPresses.press('escape');

    vi.advanceTimersByTime(799);
    const press = exitPresses.press('escape');

    expect(press).toBe('second');
    expect(row()).toBe(SHOWN_ROW);
  });

  it('stops the timer on the second press so the confirmation stays shown past 800 ms', () => {
    const { statusLine, row } = setup();
    const exitPresses = createExitPresses(statusLine);
    exitPresses.press('escape');
    vi.advanceTimersByTime(799);

    exitPresses.press('escape');
    vi.advanceTimersByTime(5000);

    expect(vi.getTimerCount()).toBe(0);
    expect(row()).toBe(SHOWN_ROW);
  });

  it('keeps the confirmation shown until 800 ms have passed', () => {
    const { statusLine, row } = setup();
    const exitPresses = createExitPresses(statusLine);
    exitPresses.press('escape');

    vi.advanceTimersByTime(799);

    expect(row()).toBe(SHOWN_ROW);
  });

  it('clears the confirmation at 800 ms and counts the next press as first', () => {
    const { statusLine, row } = setup();
    const exitPresses = createExitPresses(statusLine);
    exitPresses.press('escape');

    vi.advanceTimersByTime(800);
    const emptied = row();
    const press = exitPresses.press('escape');

    expect(emptied).toBe(IDLE_ROW);
    expect(press).toBe('first');
    expect(row()).toBe(SHOWN_ROW);
  });

  it('starts a new 800 ms window on the first press after an expired one', () => {
    const { statusLine, row } = setup();
    const exitPresses = createExitPresses(statusLine);
    exitPresses.press('escape');
    vi.advanceTimersByTime(800);
    exitPresses.press('escape');

    vi.advanceTimersByTime(799);
    const press = exitPresses.press('escape');

    expect(press).toBe('second');
    expect(row()).toBe(SHOWN_ROW);
  });

  describe('dispose', () => {
    it('stops the running timer and clears the confirmation while the window is open', () => {
      const { statusLine, row } = setup();
      const exitPresses = createExitPresses(statusLine);
      exitPresses.press('escape');

      exitPresses.dispose();

      expect(vi.getTimerCount()).toBe(0);
      expect(row()).toBe(IDLE_ROW);
    });

    it('clears the confirmation after the second press', () => {
      const { statusLine, row } = setup();
      const exitPresses = createExitPresses(statusLine);
      exitPresses.press('escape');
      exitPresses.press('escape');

      exitPresses.dispose();

      expect(row()).toBe(IDLE_ROW);
    });

    it('changes nothing when the window is closed', () => {
      const { statusLine, row } = setup();
      const exitPresses = createExitPresses(statusLine);
      const resize = vi.fn();
      const output = new Writable();
      output.on('resize', resize);
      statusLine.follow(output);

      exitPresses.dispose();

      expect(row()).toBe(IDLE_ROW);
      expect(resize).not.toHaveBeenCalled();
    });

    it('leaves a message another source showed after the confirmation', () => {
      const { statusLine, row } = setup();
      const exitPresses = createExitPresses(statusLine);
      exitPresses.press('escape');
      statusLine.show('other');

      exitPresses.dispose();

      expect(row()).toBe('  other\n');
    });

    it('starts a fresh window on the next press after a dispose', () => {
      const { statusLine } = setup();
      const exitPresses = createExitPresses(statusLine);
      exitPresses.press('escape');
      exitPresses.dispose();

      expect(exitPresses.press('escape')).toBe('first');
    });
  });

  it('leaves a message another source showed after the confirmation when the timer fires', () => {
    const { statusLine, row } = setup();
    const exitPresses = createExitPresses(statusLine);
    exitPresses.press('escape');
    statusLine.show('other');

    vi.advanceTimersByTime(800);

    expect(row()).toBe('  other\n');
  });
});
