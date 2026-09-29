// @vitest-environment node
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedCloneAdapter } from './managed-clone';

import type { ManagedCloneAdapterOptions } from './managed-clone';
import type { ParsedGitHubRepository } from '@/domain/github-reference';
import type {
  ManagedProcessRequest,
  ManagedProcessResult,
  ManagedProcessRunner,
} from '@/domain/types';

const REPOSITORY: ParsedGitHubRepository = { host: 'github.com', owner: 'octo', repo: 'app' };
const HELPER_ARGS = [
  '-c',
  'credential.https://github.com.helper=',
  '-c',
  'credential.https://github.com.helper=!gh auth git-credential',
];

function launched(
  overrides: Partial<Extract<ManagedProcessResult, { launched: true }>> = {},
): ManagedProcessResult {
  return {
    launched: true,
    exitCode: 0,
    signal: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1_000,
    timedOut: false,
    cancelled: false,
    terminationStage: 'none',
    stdout: { text: '', totalBytes: 0, truncated: false },
    stderr: { text: '', totalBytes: 0, truncated: false },
    ...overrides,
  };
}

function launchFailure(
  overrides: Partial<Extract<ManagedProcessResult, { launched: false }>> = {},
): ManagedProcessResult {
  return { launched: false, reason: 'boom', ...overrides };
}

/** Matches a request whose argv is exactly `['git', 'rev-parse', '--absolute-git-dir']`. */
function isAbsoluteGitDirCall(request: ManagedProcessRequest): boolean {
  return (
    request.argv[0] === 'git' &&
    request.argv[1] === 'rev-parse' &&
    request.argv[2] === '--absolute-git-dir'
  );
}

function isShowToplevelCall(request: ManagedProcessRequest): boolean {
  return (
    request.argv[0] === 'git' &&
    request.argv[1] === 'rev-parse' &&
    request.argv[2] === '--show-toplevel'
  );
}

function isGhVersionCall(request: ManagedProcessRequest): boolean {
  return request.argv[0] === 'gh' && request.argv[1] === '--version';
}

function isGitCloneCall(request: ManagedProcessRequest): boolean {
  return request.argv[0] === 'git' && request.argv.includes('clone');
}

function isGitFetchCall(request: ManagedProcessRequest): boolean {
  return request.argv[0] === 'git' && request.argv.includes('fetch');
}

function isGitLsRemoteCall(request: ManagedProcessRequest): boolean {
  return request.argv[0] === 'git' && request.argv.includes('ls-remote');
}

/**
 * A scripted `ManagedProcessRunner`: every call is recorded, and each
 * recognized subcommand answers with a per-test override or the given
 * default, so a test scripts only the calls it cares about.
 */
function buildRunProcess(
  overrides: {
    showToplevel?: ManagedProcessResult;
    ghVersion?: ManagedProcessResult;
    gitClone?: ManagedProcessResult;
    gitFetch?: ManagedProcessResult;
    gitLsRemote?: ManagedProcessResult;
    absoluteGitDir?: ManagedProcessResult;
  } = {},
): ManagedProcessRunner {
  return vi.fn(async (request: ManagedProcessRequest): Promise<ManagedProcessResult> => {
    if (isShowToplevelCall(request)) {
      return overrides.showToplevel ?? launched({ exitCode: 1 });
    }
    if (isGhVersionCall(request)) {
      return overrides.ghVersion ?? launched({ exitCode: 0 });
    }
    if (isGitCloneCall(request)) {
      return overrides.gitClone ?? launched({ exitCode: 0 });
    }
    if (isGitFetchCall(request)) {
      return overrides.gitFetch ?? launched({ exitCode: 0 });
    }
    if (isGitLsRemoteCall(request)) {
      return overrides.gitLsRemote ?? launched({ exitCode: 0 });
    }
    if (isAbsoluteGitDirCall(request)) {
      return overrides.absoluteGitDir ?? launched({ exitCode: 1 });
    }
    throw new Error(`unscripted managed-process call: ${request.argv.join(' ')}`);
  });
}

function buildOptions(
  overrides: Partial<ManagedCloneAdapterOptions> = {},
): ManagedCloneAdapterOptions {
  return {
    runProcess: buildRunProcess(),
    parentEnvironment: { PATH: '/usr/bin' },
    secretValues: () => [],
    cancellation: new AbortController().signal,
    ...overrides,
  };
}

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tevu-managed-clone-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('createManagedCloneAdapter', () => {
  describe('inspectClone', () => {
    it('reports missing without launching any process when the directory does not exist', async () => {
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const state = await adapter.inspectClone(join(root, 'missing-clone'));

      expect(state).toBe('missing');
      expect(runProcess).not.toHaveBeenCalled();
    });

    it('reports repository when git prints the real path of the directory', async () => {
      const directory = join(root, 'clone.git');
      await mkdir(directory);
      const realDirectory = resolve(directory);
      const runProcess = buildRunProcess({
        absoluteGitDir: launched({
          exitCode: 0,
          stdout: { text: `${realDirectory}\n`, totalBytes: 0, truncated: false },
        }),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const state = await adapter.inspectClone(directory);

      expect(state).toBe('repository');
    });

    it('reports not-a-repository when git rev-parse exits nonzero', async () => {
      const directory = join(root, 'not-a-repo');
      await mkdir(directory);
      const runProcess = buildRunProcess({ absoluteGitDir: launched({ exitCode: 1 }) });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const state = await adapter.inspectClone(directory);

      expect(state).toBe('not-a-repository');
    });

    it('reports not-a-repository when the printed git directory belongs to another repository', async () => {
      const directory = join(root, 'nested');
      await mkdir(directory);
      const runProcess = buildRunProcess({
        absoluteGitDir: launched({
          exitCode: 0,
          stdout: { text: `${join(root, 'outer.git')}\n`, totalBytes: 0, truncated: false },
        }),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const state = await adapter.inspectClone(directory);

      expect(state).toBe('not-a-repository');
    });

    it('never launches gh for any of the three states', async () => {
      const directory = join(root, 'clone.git');
      await mkdir(directory);
      const runProcess = buildRunProcess({ absoluteGitDir: launched({ exitCode: 1 }) });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      await adapter.inspectClone(join(root, 'missing'));
      await adapter.inspectClone(directory);

      expect(vi.mocked(runProcess).mock.calls.some(([request]) => request.argv[0] === 'gh')).toBe(
        false,
      );
    });
  });

  describe('clone', () => {
    it('fails with the working-tree reason before touching the lock or gh', async () => {
      const directory = join(root, 'cache', 'github.com', 'octo', 'app.git');
      await mkdir(join(root, 'cache'), { recursive: true });
      const runProcess = buildRunProcess({
        showToplevel: launched({
          exitCode: 0,
          stdout: { text: `${root}\n`, totalBytes: 0, truncated: false },
        }),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.clone(directory, REPOSITORY);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({
        kind: 'ManagedCloneError',
        operation: 'clone',
        repository: 'github.com/octo/app',
        reason: `"${join(root, 'cache')}" is inside the Git working tree "${root}"; set XDG_CACHE_HOME to an absolute directory outside every working copy`,
      });
      expect(await exists(`${directory}.lock`)).toBe(false);
      expect(vi.mocked(runProcess).mock.calls.some(([request]) => isGhVersionCall(request))).toBe(
        false,
      );
      expect(vi.mocked(runProcess).mock.calls.some(([request]) => isGitCloneCall(request))).toBe(
        false,
      );
    });

    it('fails when the lock directory already exists, without probing gh', async () => {
      const directory = join(root, 'clone.git');
      await mkdir(`${directory}.lock`, { recursive: true });
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.clone(directory, REPOSITORY);

      expect(result.ok).toBe(false);
      if (result.ok || result.error.kind !== 'ManagedCloneError') return;
      expect(result.error.reason).toBe(
        `clone lock already exists at "${directory}.lock"; another tevu command may be updating this clone, or the lock is stale and must be removed by the operator`,
      );
      expect(vi.mocked(runProcess).mock.calls.some(([request]) => isGhVersionCall(request))).toBe(
        false,
      );
    });

    it('succeeds, renaming the temporary clone into place and releasing the lock', async () => {
      const directory = join(root, 'clone.git');
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.clone(directory, REPOSITORY);

      expect(result).toEqual({ ok: true, value: undefined });
      expect(await exists(directory)).toBe(true);
      expect(await exists(`${directory}.lock`)).toBe(false);
    });

    it('runs a clone argv starting with the four helper arguments for the contacted host', async () => {
      const directory = join(root, 'clone.git');
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(
        buildOptions({ runProcess, remoteUrl: () => 'https://github.com/octo/app.git' }),
      );

      await adapter.clone(directory, REPOSITORY);

      const cloneCall = vi
        .mocked(runProcess)
        .mock.calls.find(([request]) => isGitCloneCall(request));
      expect(cloneCall?.[0].argv).toEqual([
        'git',
        ...HELPER_ARGS,
        'clone',
        '--bare',
        '--quiet',
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        'https://github.com/octo/app.git',
        expect.stringContaining('.app.git.tmp-'),
      ]);
    });

    it('reports the gh-not-installed reason when the gh probe fails to launch with ENOENT', async () => {
      const directory = join(root, 'clone.git');
      const runProcess = buildRunProcess({ ghVersion: launchFailure({ code: 'ENOENT' }) });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.clone(directory, REPOSITORY);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ManagedCloneError',
          operation: 'clone',
          repository: 'github.com/octo/app',
          reason:
            'GitHub CLI (gh) is not installed or not on PATH; install it from https://cli.github.com',
        },
      });
      expect(vi.mocked(runProcess).mock.calls.some(([request]) => isGitCloneCall(request))).toBe(
        false,
      );
    });

    it('fails with the host-rule reason for a repository whose host holds a disallowed character', async () => {
      const directory = join(root, 'clone.git');
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));
      const badHost: ParsedGitHubRepository = {
        host: 'gh;ost.example.com',
        owner: 'octo',
        repo: 'app',
      };

      const result = await adapter.clone(directory, badHost);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ManagedCloneError',
          operation: 'clone',
          repository: 'gh;ost.example.com/octo/app',
          reason:
            'host "gh;ost.example.com" holds characters other than letters, digits, hyphens, and dots',
        },
      });
      expect(runProcess).not.toHaveBeenCalled();
      expect(await exists(`${directory}.lock`)).toBe(false);
    });
  });

  describe('fetchCommits and fetchBranchesAndTags', () => {
    it('creates the lock, probes gh, fetches, and releases the lock', async () => {
      const directory = join(root, 'clone.git');
      await mkdir(directory);
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.fetchCommits(directory, REPOSITORY, ['a'.repeat(40)]);

      expect(result).toEqual({ ok: true, value: undefined });
      expect(await exists(`${directory}.lock`)).toBe(false);
      expect(vi.mocked(runProcess).mock.calls.some(([request]) => isGhVersionCall(request))).toBe(
        true,
      );
    });

    it('runs a fetchCommits argv starting with the four helper arguments, targeting refs/tevu/fetched/<hash>', async () => {
      const directory = join(root, 'clone.git');
      await mkdir(directory);
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(
        buildOptions({ runProcess, remoteUrl: () => 'https://github.com/octo/app.git' }),
      );
      const hash = 'a'.repeat(40);

      await adapter.fetchCommits(directory, REPOSITORY, [hash]);

      const fetchCall = vi
        .mocked(runProcess)
        .mock.calls.find(([request]) => isGitFetchCall(request));
      expect(fetchCall?.[0].argv).toEqual([
        'git',
        ...HELPER_ARGS,
        'fetch',
        '--quiet',
        '--no-tags',
        'https://github.com/octo/app.git',
        `${hash}:refs/tevu/fetched/${hash}`,
      ]);
    });

    it('runs a fetchBranchesAndTags argv force-updating every branch and tag', async () => {
      const directory = join(root, 'clone.git');
      await mkdir(directory);
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(
        buildOptions({ runProcess, remoteUrl: () => 'https://github.com/octo/app.git' }),
      );

      await adapter.fetchBranchesAndTags(directory, REPOSITORY);

      const fetchCall = vi
        .mocked(runProcess)
        .mock.calls.find(([request]) => isGitFetchCall(request));
      expect(fetchCall?.[0].argv).toEqual([
        'git',
        ...HELPER_ARGS,
        'fetch',
        '--quiet',
        '--no-tags',
        'https://github.com/octo/app.git',
        '+refs/heads/*:refs/heads/*',
        '+refs/tags/*:refs/tags/*',
      ]);
    });

    it('fails a fetchCommits source whose host fails the host rule, creating no lock and starting no process', async () => {
      const directory = join(root, 'clone.git');
      await mkdir(directory);
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));
      const badSource: ParsedGitHubRepository = {
        host: 'gh;ost.example.com',
        owner: 'octo',
        repo: 'app',
      };

      const result = await adapter.fetchCommits(directory, badSource, ['a'.repeat(40)]);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ManagedCloneError',
          operation: 'fetch',
          repository: 'gh;ost.example.com/octo/app',
          reason:
            'host "gh;ost.example.com" holds characters other than letters, digits, hyphens, and dots',
        },
      });
      expect(runProcess).not.toHaveBeenCalled();
      expect(await exists(`${directory}.lock`)).toBe(false);
    });

    it('probes gh only once across two operations on the same adapter instance', async () => {
      const directory = join(root, 'clone.git');
      await mkdir(directory);
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      await adapter.fetchCommits(directory, REPOSITORY, ['a'.repeat(40)]);
      await adapter.fetchBranchesAndTags(directory, REPOSITORY);

      const ghCalls = vi
        .mocked(runProcess)
        .mock.calls.filter(([request]) => isGhVersionCall(request));
      expect(ghCalls).toHaveLength(1);
    });
  });

  describe('checkRemote', () => {
    it('probes gh and reads HEAD with the four helper arguments for the contacted host', async () => {
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(
        buildOptions({ runProcess, remoteUrl: () => 'https://github.com/octo/app.git' }),
      );

      const result = await adapter.checkRemote(REPOSITORY);

      expect(result).toEqual({ ok: true, value: undefined });
      const argvs = vi.mocked(runProcess).mock.calls.map(([request]) => request.argv);
      expect(argvs).toEqual([
        ['gh', '--version'],
        ['git', ...HELPER_ARGS, 'ls-remote', '--quiet', 'https://github.com/octo/app.git', 'HEAD'],
      ]);
    });

    it('reports a failed read as an ls-remote ManagedCloneError carrying the git message', async () => {
      const runProcess = buildRunProcess({
        gitLsRemote: launched({
          exitCode: 128,
          stderr: {
            text: "fatal: repository 'https://github.com/octo/app.git/' not found\n",
            totalBytes: 60,
            truncated: false,
          },
        }),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.checkRemote(REPOSITORY);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ManagedCloneError',
          operation: 'ls-remote',
          repository: 'github.com/octo/app',
          reason: expect.stringMatching(/^git ls-remote exited with code 128: .*not found/),
        },
      });
    });

    it('fails a repository whose host fails the host rule without starting a process', async () => {
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.checkRemote({ host: 'gh;ost', owner: 'octo', repo: 'app' });

      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'ManagedCloneError', operation: 'ls-remote' },
      });
      expect(runProcess).not.toHaveBeenCalled();
    });
  });

  describe('no credential leak beyond the injected helper', () => {
    it('carries no other -c credential setting on any git argv, including inspectClone', async () => {
      const directory = join(root, 'clone.git');
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      await adapter.clone(directory, REPOSITORY);
      await adapter.fetchCommits(directory, REPOSITORY, ['a'.repeat(40)]);
      await adapter.fetchBranchesAndTags(directory, REPOSITORY);
      await adapter.inspectClone(directory);

      for (const [request] of vi.mocked(runProcess).mock.calls) {
        const isCredentialedSubcommand = isGitCloneCall(request) || isGitFetchCall(request);
        const argvText = request.argv.join(' ');
        if (!isCredentialedSubcommand) {
          expect(argvText).not.toContain('credential');
        }
      }
    });
  });

  describe('secret-free output', () => {
    it('masks a GitHub token shape in the git failure reason', async () => {
      const directory = join(root, 'clone.git');
      const rawToken = `ghp_${'x'.repeat(36)}`;
      const runProcess = buildRunProcess({
        gitClone: launched({
          exitCode: 128,
          stderr: {
            text: `fatal: authentication failed for token ${rawToken}\n`,
            totalBytes: 0,
            truncated: false,
          },
        }),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.clone(directory, REPOSITORY);

      expect(result.ok).toBe(false);
      if (result.ok || result.error.kind !== 'ManagedCloneError') return;
      expect(result.error.reason).not.toContain(rawToken);
      expect(result.error.reason).toContain('[REDACTED]');
    });

    it('passes secretValues() to every git and gh invocation', async () => {
      const directory = join(root, 'clone.git');
      await mkdir(directory);
      const runProcess = buildRunProcess();
      const secretValues = () => ['s3cr3t'];
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess, secretValues }));

      await adapter.fetchCommits(directory, REPOSITORY, ['a'.repeat(40)]);

      for (const [request] of vi.mocked(runProcess).mock.calls) {
        expect(request.secretValues).toEqual(['s3cr3t']);
      }
    });
  });
});
