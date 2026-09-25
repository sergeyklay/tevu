// @vitest-environment node
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPrerequisiteAdapter } from './process';

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
