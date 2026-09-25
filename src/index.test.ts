// @vitest-environment node

import { Readable, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { runProgram } from '@/interface/program';

import { composeProgramDependencies, ignoreClosedReader } from './index';

function writeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code, syscall: 'write' });
}

/** A stdout whose reader has gone away, like the pipe `tevu --help | head -2` leaves behind. */
function closedPipe(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(writeError('EPIPE'));
    },
  });
}

function capture(): { stream: Writable; text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

describe('closed output reader', () => {
  it('finishes a command quietly when stdout fails with EPIPE', async () => {
    const stdout = closedPipe();
    const stderr = capture();
    ignoreClosedReader(stdout);
    const dependencies = composeProgramDependencies({
      io: { stdin: Readable.from([]), stdout, stderr: stderr.stream },
    });

    const code = await runProgram(['--help'], dependencies);
    await setImmediate();

    expect(code).toBe(0);
    expect(stdout.destroyed).toBe(true);
    expect(stderr.text()).toBe('');
  });

  it('rethrows a write error other than EPIPE', () => {
    const stdout = capture().stream;
    ignoreClosedReader(stdout);

    expect(() => stdout.emit('error', writeError('ENOSPC'))).toThrow('write ENOSPC');
  });
});
