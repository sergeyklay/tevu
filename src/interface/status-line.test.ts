// @vitest-environment node

import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStatusLine } from './status-line';

const ESC = '\u001b';
const SHOWN = 'Press Esc again to exit';

function createOutput(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

beforeEach(() => {
  vi.stubEnv('FORCE_COLOR', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createStatusLine row', () => {
  it.each(['initial', 'active', 'error', 'validating'] as const)(
    'is a lone newline in the %s state while no message is shown',
    (state) => {
      const statusLine = createStatusLine();

      expect(statusLine.row(state, createOutput())).toBe('\n');
    },
  );

  it.each(['submit', 'cancel'] as const)(
    'is empty in the %s state, with or without a message shown',
    (state) => {
      const statusLine = createStatusLine();
      const output = createOutput();

      const idle = statusLine.row(state, output);
      statusLine.show(SHOWN);
      const showing = statusLine.row(state, output);

      expect(idle).toBe('');
      expect(showing).toBe('');
    },
  );

  it.each(['initial', 'active', 'error', 'validating'] as const)(
    'is two spaces, the text, and a newline in the %s state with color off',
    (state) => {
      const statusLine = createStatusLine();
      statusLine.show(SHOWN);

      expect(statusLine.row(state, createOutput())).toBe(`  ${SHOWN}\n`);
    },
  );

  it('wraps the text in SGR 2 and SGR 22 after two unstyled spaces with color on', () => {
    vi.stubEnv('FORCE_COLOR', '1');
    const statusLine = createStatusLine();
    statusLine.show(SHOWN);

    expect(statusLine.row('active', createOutput())).toBe(`  ${ESC}[2m${SHOWN}${ESC}[22m\n`);
  });

  it('draws no character for the reserved row with color on', () => {
    vi.stubEnv('FORCE_COLOR', '1');
    const statusLine = createStatusLine();

    expect(statusLine.row('active', createOutput())).toBe('\n');
  });
});

describe('createStatusLine show', () => {
  it('replaces the shown message with the newer one', () => {
    const statusLine = createStatusLine();
    const output = createOutput();

    statusLine.show('first');
    statusLine.show('second');

    expect(statusLine.row('active', output)).toBe('  second\n');
  });

  it('keeps the newer message when the replaced handle clears', () => {
    const statusLine = createStatusLine();
    const output = createOutput();
    const older = statusLine.show('first');
    statusLine.show('second');

    older.clear();

    expect(statusLine.row('active', output)).toBe('  second\n');
  });

  it('empties the row when the shown handle clears', () => {
    const statusLine = createStatusLine();
    const output = createOutput();
    const message = statusLine.show(SHOWN);

    message.clear();

    expect(statusLine.row('active', output)).toBe('\n');
  });

  it('does not bring a replaced message back when the newer one clears', () => {
    const statusLine = createStatusLine();
    const output = createOutput();
    statusLine.show('first');
    const newer = statusLine.show('second');

    newer.clear();

    expect(statusLine.row('active', output)).toBe('\n');
  });

  it('does nothing when a handle that already cleared clears again after a newer message', () => {
    const statusLine = createStatusLine();
    const output = createOutput();
    const first = statusLine.show('first');
    first.clear();
    statusLine.show('second');

    first.clear();

    expect(statusLine.row('active', output)).toBe('  second\n');
  });
});

describe('createStatusLine follow', () => {
  it('emits resize on the given output once per show', () => {
    const statusLine = createStatusLine();
    const output = createOutput();
    const resize = vi.fn();
    output.on('resize', resize);
    statusLine.follow(output);

    statusLine.show(SHOWN);

    expect(resize).toHaveBeenCalledTimes(1);
  });

  it('emits resize after the row already holds the new message', () => {
    const statusLine = createStatusLine();
    const output = createOutput();
    const rowsSeen: string[] = [];
    output.on('resize', () => {
      rowsSeen.push(statusLine.row('active', output));
    });
    statusLine.follow(output);

    const message = statusLine.show(SHOWN);
    message.clear();

    expect(rowsSeen).toEqual([`  ${SHOWN}\n`, '\n']);
  });

  it('emits resize once when a shown handle clears', () => {
    const statusLine = createStatusLine();
    const output = createOutput();
    const message = statusLine.show(SHOWN);
    const resize = vi.fn();
    output.on('resize', resize);
    statusLine.follow(output);

    message.clear();

    expect(resize).toHaveBeenCalledTimes(1);
  });

  it('emits resize once when a newer message replaces the shown one', () => {
    const statusLine = createStatusLine();
    const output = createOutput();
    statusLine.show('first');
    const resize = vi.fn();
    output.on('resize', resize);
    statusLine.follow(output);

    statusLine.show('second');

    expect(resize).toHaveBeenCalledTimes(1);
  });

  it('emits no resize when a replaced handle clears', () => {
    const statusLine = createStatusLine();
    const output = createOutput();
    const older = statusLine.show('first');
    statusLine.show('second');
    const resize = vi.fn();
    output.on('resize', resize);
    statusLine.follow(output);

    older.clear();

    expect(resize).not.toHaveBeenCalled();
  });

  it('emits no resize when a handle clears twice', () => {
    const statusLine = createStatusLine();
    const output = createOutput();
    const message = statusLine.show(SHOWN);
    message.clear();
    const resize = vi.fn();
    output.on('resize', resize);
    statusLine.follow(output);

    message.clear();

    expect(resize).not.toHaveBeenCalled();
  });

  it('emits no resize after the stop function runs', () => {
    const statusLine = createStatusLine();
    const output = createOutput();
    const resize = vi.fn();
    output.on('resize', resize);
    const stop = statusLine.follow(output);

    stop();
    const message = statusLine.show(SHOWN);
    message.clear();

    expect(resize).not.toHaveBeenCalled();
  });

  it('runs the stop function twice without stopping another follower', () => {
    const statusLine = createStatusLine();
    const first = createOutput();
    const second = createOutput();
    const resizeSecond = vi.fn();
    second.on('resize', resizeSecond);
    const stopFirst = statusLine.follow(first);
    statusLine.follow(second);

    stopFirst();
    stopFirst();
    statusLine.show(SHOWN);

    expect(resizeSecond).toHaveBeenCalledTimes(1);
  });

  it('emits resize only on the output it follows', () => {
    const statusLine = createStatusLine();
    const followed = createOutput();
    const other = createOutput();
    const resizeOther = vi.fn();
    other.on('resize', resizeOther);
    statusLine.follow(followed);

    statusLine.show(SHOWN);

    expect(resizeOther).not.toHaveBeenCalled();
  });
});
