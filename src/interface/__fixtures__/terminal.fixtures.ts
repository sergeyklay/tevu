import { Readable, Writable } from 'node:stream';

type Screen = {
  /** Bytes written to each row, escape sequences of `m` included. */
  rows: string[];
  cursorRow: number;
  cursorColumn: number;
};

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

export function buildTerminal(
  size: { columns: number; rows: number } = { columns: 80, rows: 20 },
): {
  input: Readable;
  output: FakeOutput;
} {
  return { input: new Readable({ read() {} }), output: new FakeOutput(size.columns, size.rows) };
}

function readSequence(
  bytes: string,
  start: number,
): { text: string; params: string; final: string } | undefined {
  if (bytes[start + 1] !== '[') {
    return undefined;
  }
  let end = start + 2;
  while (end < bytes.length && '0123456789;?'.includes(bytes[end] ?? '')) {
    end += 1;
  }
  const final = bytes[end];
  if (final === undefined || !/[A-Za-z]/.test(final)) {
    return undefined;
  }
  return { text: bytes.slice(start, end + 1), params: bytes.slice(start + 2, end), final };
}

/**
 * Replays the bytes a prompt wrote to a terminal and returns the screen they
 * leave. Understands text, SGR, newline, cursor up, down, and left, `ESC[G`,
 * `ESC[2K`, `ESC[J`, and the cursor show and hide sequences; anything else
 * throws so an unmodeled byte cannot pass unnoticed.
 */
export function replayScreen(bytes: string): Screen {
  const rows = [''];
  let row = 0;
  let column = 0;

  const ensureRow = (): void => {
    while (rows.length <= row) {
      rows.push('');
    }
  };
  const write = (text: string): void => {
    rows[row] = rows[row].slice(0, column).padEnd(column, ' ') + text;
    column += text.length;
  };

  let index = 0;
  while (index < bytes.length) {
    const char = bytes[index];
    if (char === '\n') {
      row += 1;
      column = 0;
      ensureRow();
      index += 1;
      continue;
    }
    if (char !== '\u001b') {
      const code = char.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) {
        throw new Error(`unmodeled control character U+${code.toString(16).padStart(4, '0')}`);
      }
      write(char);
      index += 1;
      continue;
    }

    const sequence = readSequence(bytes, index);
    if (sequence === undefined) {
      throw new Error(`unmodeled escape at offset ${String(index)}`);
    }
    const { text: sequenceText, params, final } = sequence;
    const count = params === '' ? 1 : Number(params);
    index += sequenceText.length;

    if (final === 'm') {
      write(sequenceText);
    } else if (final === 'A') {
      row = Math.max(0, row - count);
    } else if (final === 'B') {
      row += count;
      ensureRow();
    } else if (final === 'D') {
      column = Math.max(0, column - count);
    } else if (final === 'G' && params === '') {
      column = 0;
    } else if (final === 'K' && params === '2') {
      rows[row] = '';
    } else if (final === 'J' && params === '') {
      rows[row] = rows[row].slice(0, column);
      rows.length = row + 1;
    } else if ((final === 'l' || final === 'h') && params === '?25') {
      continue;
    } else {
      throw new Error(`unmodeled escape sequence ${JSON.stringify(sequenceText)}`);
    }
  }

  return { rows, cursorRow: row, cursorColumn: column };
}
