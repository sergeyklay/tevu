// @vitest-environment node

import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStatusLine } from './status-line';

const ESC = '\u001b';
const IDLE = 'Ctrl-C to exit';
const IDLE_ROW = `  ${IDLE}\n`;

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
    'is two spaces, the idle text, and a newline in the %s state with color off',
    (state) => {
      const statusLine = createStatusLine();

      expect(statusLine.row(state, createOutput(), IDLE)).toBe(IDLE_ROW);
    },
  );

  it.each(['submit', 'cancel'] as const)('is empty in the %s state', (state) => {
    const statusLine = createStatusLine();

    expect(statusLine.row(state, createOutput(), IDLE)).toBe('');
  });

  it('wraps the idle text in SGR 2 and SGR 22 after two unstyled spaces with color on', () => {
    vi.stubEnv('FORCE_COLOR', '1');
    const statusLine = createStatusLine();

    expect(statusLine.row('active', createOutput(), IDLE)).toBe(`  ${ESC}[2m${IDLE}${ESC}[22m\n`);
  });

  it('shows the idle text it is given, not a fixed one', () => {
    const statusLine = createStatusLine();

    expect(statusLine.row('active', createOutput(), 'Esc to go back')).toBe('  Esc to go back\n');
  });
});
