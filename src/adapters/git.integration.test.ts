// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isGitRepository, readOriginRemoteUrl } from './git';

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

describe('readOriginRemoteUrl', () => {
  it.each([
    { form: 'a URL with user info', url: 'https://user:token@example.invalid/acme/app.git' },
    { form: 'an scp-like address', url: 'git@example.invalid:acme/app.git' },
  ])('returns the URL set by git remote add origin for $form', async ({ url }) => {
    await execa('git', ['init', '--quiet', root]);
    await execa('git', ['remote', 'add', 'origin', url], { cwd: root });

    expect(await readOriginRemoteUrl(root)).toBe(url);
  });

  it('returns undefined for a repository without an origin remote', async () => {
    await execa('git', ['init', '--quiet', root]);
    await execa('git', ['remote', 'add', 'upstream', 'https://example.invalid/acme/app.git'], {
      cwd: root,
    });

    expect(await readOriginRemoteUrl(root)).toBeUndefined();
  });

  it('returns undefined for neither a plain directory nor a missing one', async () => {
    expect(await readOriginRemoteUrl(root)).toBeUndefined();
    expect(await readOriginRemoteUrl(join(root, 'missing'))).toBeUndefined();
  });
});
