// @vitest-environment node

import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEscapeExit } from './escape-exit';
import { createStatusLine } from './status-line';

const MESSAGE = 'Press Esc again to exit';
const SHOWN_ROW = `  ${MESSAGE}\n`;

function setup(): { statusLine: ReturnType<typeof createStatusLine>; row: () => string } {
  const statusLine = createStatusLine();
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return { statusLine, row: () => statusLine.row('active', output) };
}

beforeEach(() => {
  vi.stubEnv('FORCE_COLOR', '0');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('createEscapeExit', () => {
  it('shows the confirmation and returns first on the first press', () => {
    const { statusLine, row } = setup();
    const escapeExit = createEscapeExit(statusLine);

    const press = escapeExit.press();

    expect(press).toBe('first');
    expect(row()).toBe(SHOWN_ROW);
  });

  it('returns second and leaves the confirmation shown on a press at 799 ms', () => {
    const { statusLine, row } = setup();
    const escapeExit = createEscapeExit(statusLine);
    escapeExit.press();

    vi.advanceTimersByTime(799);
    const press = escapeExit.press();

    expect(press).toBe('second');
    expect(row()).toBe(SHOWN_ROW);
  });

  it('stops the timer on the second press so the confirmation stays shown past 800 ms', () => {
    const { statusLine, row } = setup();
    const escapeExit = createEscapeExit(statusLine);
    escapeExit.press();
    vi.advanceTimersByTime(799);

    escapeExit.press();
    vi.advanceTimersByTime(5000);

    expect(vi.getTimerCount()).toBe(0);
    expect(row()).toBe(SHOWN_ROW);
  });

  it('keeps the confirmation shown until 800 ms have passed', () => {
    const { statusLine, row } = setup();
    const escapeExit = createEscapeExit(statusLine);
    escapeExit.press();

    vi.advanceTimersByTime(799);

    expect(row()).toBe(SHOWN_ROW);
  });

  it('clears the confirmation at 800 ms and counts the next press as first', () => {
    const { statusLine, row } = setup();
    const escapeExit = createEscapeExit(statusLine);
    escapeExit.press();

    vi.advanceTimersByTime(800);
    const emptied = row();
    const press = escapeExit.press();

    expect(emptied).toBe('\n');
    expect(press).toBe('first');
    expect(row()).toBe(SHOWN_ROW);
  });

  it('starts a new 800 ms window on the first press after an expired one', () => {
    const { statusLine, row } = setup();
    const escapeExit = createEscapeExit(statusLine);
    escapeExit.press();
    vi.advanceTimersByTime(800);
    escapeExit.press();

    vi.advanceTimersByTime(799);
    const press = escapeExit.press();

    expect(press).toBe('second');
    expect(row()).toBe(SHOWN_ROW);
  });

  describe('dispose', () => {
    it('stops the running timer and clears the confirmation while the window is open', () => {
      const { statusLine, row } = setup();
      const escapeExit = createEscapeExit(statusLine);
      escapeExit.press();

      escapeExit.dispose();

      expect(vi.getTimerCount()).toBe(0);
      expect(row()).toBe('\n');
    });

    it('clears the confirmation after the second press', () => {
      const { statusLine, row } = setup();
      const escapeExit = createEscapeExit(statusLine);
      escapeExit.press();
      escapeExit.press();

      escapeExit.dispose();

      expect(row()).toBe('\n');
    });

    it('changes nothing when the window is closed', () => {
      const { statusLine, row } = setup();
      const escapeExit = createEscapeExit(statusLine);
      const resize = vi.fn();
      const output = new Writable();
      output.on('resize', resize);
      statusLine.follow(output);

      escapeExit.dispose();

      expect(row()).toBe('\n');
      expect(resize).not.toHaveBeenCalled();
    });

    it('leaves a message another source showed after the confirmation', () => {
      const { statusLine, row } = setup();
      const escapeExit = createEscapeExit(statusLine);
      escapeExit.press();
      statusLine.show('other');

      escapeExit.dispose();

      expect(row()).toBe('  other\n');
    });

    it('starts a fresh window on the next press after a dispose', () => {
      const { statusLine } = setup();
      const escapeExit = createEscapeExit(statusLine);
      escapeExit.press();
      escapeExit.dispose();

      expect(escapeExit.press()).toBe('first');
    });
  });

  it('leaves a message another source showed after the confirmation when the timer fires', () => {
    const { statusLine, row } = setup();
    const escapeExit = createEscapeExit(statusLine);
    escapeExit.press();
    statusLine.show('other');

    vi.advanceTimersByTime(800);

    expect(row()).toBe('  other\n');
  });
});
