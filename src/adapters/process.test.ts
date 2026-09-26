// @vitest-environment node
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPrerequisiteAdapter, runManagedProcess } from './process';

const SYNTHETIC_GIT_SCRIPT = '#!/bin/sh\necho "git version 2.45.0-synthetic"\nexit 0\n';

describe('probeHost (P1)', () => {
  let binDirectory = '';
  let originalPath: string | undefined;

  beforeEach(async () => {
    binDirectory = await mkdtemp(join(tmpdir(), 'tevu-probe-host-'));
    const gitPath = join(binDirectory, 'git');
    await writeFile(gitPath, SYNTHETIC_GIT_SCRIPT);
    await chmod(gitPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = binDirectory;
  });

  afterEach(async () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (binDirectory.length > 0) {
      await rm(binDirectory, { recursive: true, force: true });
      binDirectory = '';
    }
  });

  it('resolves the host probe from a PATH holding only a synthetic git script', async () => {
    const result = await createPrerequisiteAdapter().probeHost();

    expect(result).toEqual({
      ok: true,
      value: {
        platform: process.platform,
        nodeVersion: process.version,
        gitVersion: '2.45.0-synthetic',
      },
    });
  });
});

/** UTF-8 encodes to exactly 200,000 bytes: 50,000 copies of `я` (2 bytes each) then 100,000 copies of `a`. */
const FIDELITY_PAYLOAD = 'я'.repeat(50_000) + 'a'.repeat(100_000);
const FIDELITY_PAYLOAD_SHA256 = createHash('sha256')
  .update(Buffer.from(FIDELITY_PAYLOAD, 'utf8'))
  .digest('hex');
const EMPTY_STDIN_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

/** Far above the stdin channel buffer measured on this host, so a write is still pending at exit or kill. */
const PENDING_WRITE_PAYLOAD = 'a'.repeat(1_000_000);

/** Reads fd 0 to end-of-file and prints its byte count and SHA-256, space-separated. */
const READER_SCRIPT =
  'const d=require("fs").readFileSync(0);' +
  'process.stdout.write(d.length+" "+require("crypto").createHash("sha256").update(d).digest("hex"));';

function readerRequest(stdinText: string | undefined) {
  return {
    argv: [process.execPath, '-e', READER_SCRIPT] as [string, ...string[]],
    cwd: process.cwd(),
    environment: {},
    timeoutMs: 10_000,
    terminationGraceMs: 250,
    stdinText,
  };
}

describe('runManagedProcess stdin', () => {
  it('delivers the 200,000-byte fidelity payload to the child unchanged', async () => {
    const result = await runManagedProcess(readerRequest(FIDELITY_PAYLOAD));

    expect(result.launched).toBe(true);
    if (!result.launched) return;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`200000 ${FIDELITY_PAYLOAD_SHA256}`);
  });

  it('gives the child closed, empty stdin when stdinText is absent', async () => {
    const result = await runManagedProcess(readerRequest(undefined));

    expect(result.launched).toBe(true);
    if (!result.launched) return;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`0 ${EMPTY_STDIN_SHA256}`);
  });

  it('ignores EPIPE on an exit-before-read child and preserves its exit status', async () => {
    const result = await runManagedProcess({
      argv: [process.execPath, '-e', 'process.exit(3);'],
      cwd: process.cwd(),
      environment: {},
      timeoutMs: 10_000,
      terminationGraceMs: 250,
      stdinText: PENDING_WRITE_PAYLOAD,
    });

    expect(result).toMatchObject({
      launched: true,
      exitCode: 3,
      signal: null,
      timedOut: false,
      cancelled: false,
      terminationStage: 'none',
    });
  });

  it('a pending write delays neither timeout nor its grace escalation', async () => {
    const result = await runManagedProcess({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000);'],
      cwd: process.cwd(),
      environment: {},
      timeoutMs: 1000,
      terminationGraceMs: 250,
      stdinText: PENDING_WRITE_PAYLOAD,
    });

    expect(result).toMatchObject({
      launched: true,
      timedOut: true,
      terminationStage: 'graceful',
      signal: 'SIGTERM',
    });
  });
});
