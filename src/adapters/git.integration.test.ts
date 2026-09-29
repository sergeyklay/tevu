// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isGitRepository } from './git';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tevu-git-it-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('isGitRepository', () => {
  it('reports a directory inside a Git repository', async () => {
    await execa('git', ['init', '--quiet', root]);
    const nested = join(root, 'nested');
    await mkdir(nested);

    expect(await isGitRepository(root)).toBe(true);
    expect(await isGitRepository(nested)).toBe(true);
  });

  it('reports neither a plain directory nor a missing one', async () => {
    expect(await isGitRepository(root)).toBe(false);
    expect(await isGitRepository(join(root, 'missing'))).toBe(false);
  });
});
