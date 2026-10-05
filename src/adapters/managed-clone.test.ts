// @vitest-environment node
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    stdout: { text: '', totalBytes: 0, truncated: false, incomplete: false },
    stderr: { text: '', totalBytes: 0, truncated: false, incomplete: false },
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
      const realDirectory = await realpath(directory);
      const runProcess = buildRunProcess({
        absoluteGitDir: launched({
          exitCode: 0,
          stdout: {
            text: `${realDirectory}\n`,
            totalBytes: 0,
            truncated: false,
            incomplete: false,
          },
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
          stdout: {
            text: `${join(root, 'outer.git')}\n`,
            totalBytes: 0,
            truncated: false,
            incomplete: false,
          },
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
          stdout: { text: `${root}\n`, totalBytes: 0, truncated: false, incomplete: false },
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
            incomplete: false,
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
            incomplete: false,
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

const LFS_COMMIT = 'c'.repeat(40);
const LFS_OID = 'a1b2c3d4'.repeat(8);
const LFS_RETRY = 'retry once the cause is fixed; objects already fetched are kept';
const GH_NOT_AUTHENTICATED = 'gh is not authenticated; run gh auth login';
const GIT_LFS_VERSION_OUTPUT = 'git-lfs/3.4.1 (GitHub; linux amd64; go 1.22.2)\n';
const DOES_NOT_HAVE_OBJECTS =
  'github.com/octo/app does not have every Git LFS object of this commit; choose another base commit';

function isGitLfsVersionCall(request: ManagedProcessRequest): boolean {
  return request.argv[0] === 'git' && request.argv[1] === 'lfs' && request.argv[2] === 'version';
}

function isGitLfsFetchCall(request: ManagedProcessRequest): boolean {
  return (
    request.argv[0] === 'git' && request.argv.includes('lfs') && request.argv.includes('fetch')
  );
}

function captured(text: string): {
  text: string;
  totalBytes: number;
  truncated: boolean;
  incomplete: boolean;
} {
  return { text, totalBytes: text.length, truncated: false, incomplete: false };
}

function lfsVersionInstalled(): ManagedProcessResult {
  return launched({ stdout: captured(GIT_LFS_VERSION_OUTPUT) });
}

function lfsFetchFailedWith(stderr: string, exitCode = 2): ManagedProcessResult {
  return launched({ exitCode, stderr: captured(stderr) });
}

/**
 * A scripted runner for the Git LFS fetch: `git lfs version`, gh, and
 * `git ... lfs fetch` answer with a per-test override or a success.
 * `whileFetching` runs inside the fetch call, before it answers.
 */
function buildLfsRunProcess(
  overrides: {
    lfsVersion?: ManagedProcessResult;
    ghVersion?: ManagedProcessResult;
    lfsFetch?: ManagedProcessResult;
    whileFetching?: () => void;
  } = {},
): ManagedProcessRunner {
  return vi.fn(async (request: ManagedProcessRequest): Promise<ManagedProcessResult> => {
    if (isGitLfsVersionCall(request)) {
      return overrides.lfsVersion ?? lfsVersionInstalled();
    }
    if (isGhVersionCall(request)) {
      return overrides.ghVersion ?? launched();
    }
    if (isGitLfsFetchCall(request)) {
      overrides.whileFetching?.();
      return overrides.lfsFetch ?? launched();
    }
    throw new Error(`unscripted managed-process call: ${request.argv.join(' ')}`);
  });
}

function callsOf(runProcess: ManagedProcessRunner): ManagedProcessRequest[] {
  return vi.mocked(runProcess).mock.calls.map(([request]) => request);
}

describe('createManagedCloneAdapter fetchLfsObjects', () => {
  let directory = '';

  beforeEach(async () => {
    directory = join(root, 'clone.git');
    await mkdir(directory);
  });

  describe('the fetch command', () => {
    it('runs git lfs fetch in the clone directory with the endpoint pinned to the clone URL and no include or exclude filter', async () => {
      const runProcess = buildLfsRunProcess();
      const adapter = createManagedCloneAdapter(
        buildOptions({ runProcess, remoteUrl: () => 'https://github.com/octo/app.git' }),
      );

      const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      const fetchCall = callsOf(runProcess).find(isGitLfsFetchCall);
      expect(result).toEqual({ ok: true, value: undefined });
      expect(fetchCall?.argv).toEqual([
        'git',
        ...HELPER_ARGS,
        '-c',
        'lfs.url=https://github.com/octo/app.git/info/lfs',
        'lfs',
        'fetch',
        '-I',
        '',
        '-X',
        '',
        'https://github.com/octo/app.git',
        LFS_COMMIT,
      ]);
      expect(fetchCall?.cwd).toBe(directory);
      expect(fetchCall?.timeoutMs).toBe(600_000);
    });

    it('pins the endpoint to the default clone URL when the adapter has no remote override', async () => {
      const runProcess = buildLfsRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(callsOf(runProcess).find(isGitLfsFetchCall)?.argv).toContain(
        'lfs.url=https://github.com/octo/app.git/info/lfs',
      );
    });

    it('scopes the credential helper to the contacted host of a repository on another server', async () => {
      const runProcess = buildLfsRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      await adapter.fetchLfsObjects(
        directory,
        { host: 'ghe.example.com', owner: 'octo', repo: 'app' },
        LFS_COMMIT,
      );

      expect(callsOf(runProcess).find(isGitLfsFetchCall)?.argv.slice(0, 5)).toEqual([
        'git',
        '-c',
        'credential.https://ghe.example.com.helper=',
        '-c',
        'credential.https://ghe.example.com.helper=!gh auth git-credential',
      ]);
    });

    it('starts git lfs version, then gh, then the fetch, all without the operator Git configuration', async () => {
      const runProcess = buildLfsRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      const calls = callsOf(runProcess);
      expect(
        calls.map((call) =>
          isGitLfsVersionCall(call) ? 'lfs version' : isGhVersionCall(call) ? 'gh' : 'lfs fetch',
        ),
      ).toEqual(['lfs version', 'gh', 'lfs fetch']);
      for (const call of calls.filter((call) => call.argv[0] === 'git')) {
        expect(call.environment).toMatchObject({
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        });
      }
    });

    it('passes secretValues() to the probe and the fetch', async () => {
      const runProcess = buildLfsRunProcess();
      const adapter = createManagedCloneAdapter(
        buildOptions({ runProcess, secretValues: () => ['s3cr3t'] }),
      );

      await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      for (const call of callsOf(runProcess)) {
        expect(call.secretValues).toEqual(['s3cr3t']);
      }
    });
  });

  describe('a failed fetch', () => {
    const OBJECT_404 = `[${LFS_OID}] Object does not exist on the server: [404] Object does not exist on the server`;
    const REMOTE_MISSING = `error transferring "${LFS_OID}": [0] remote missing object ${LFS_OID}`;
    const FAILED_TO_FETCH =
      "error: failed to fetch some objects from 'https://github.com/octo/app.git/info/lfs'";
    const NO_CREDENTIAL =
      'batch response: Git credentials for https://github.com/octo/app.git/info/lfs not found.';
    const AUTHORIZATION_ERROR =
      'batch response: Authorization error: https://github.com/octo/app.git/info/lfs/objects/batch';
    const CONNECTION_REFUSED =
      'batch response: Post "https://github.com/octo/app.git/info/lfs/objects/batch": dial tcp 140.82.112.3:443: connect: connection refused';
    const UNSAFE_KEYS_WARNING =
      "warning: These unsafe '.lfsconfig' keys were ignored:\n\n    lfs.url\n";

    it.each([
      {
        name: 'a credential git-lfs cannot find',
        stderr: `${NO_CREDENTIAL}\n${FAILED_TO_FETCH}\n`,
        reason: `git lfs fetch exited with code 2: ${NO_CREDENTIAL}; ${GH_NOT_AUTHENTICATED}`,
      },
      {
        name: 'an authorization error',
        stderr: `${AUTHORIZATION_ERROR}\n${FAILED_TO_FETCH}\n`,
        reason: `git lfs fetch exited with code 2: ${AUTHORIZATION_ERROR}; ${GH_NOT_AUTHENTICATED}`,
      },
      {
        name: 'a per-object 404',
        stderr: `${OBJECT_404}\n${FAILED_TO_FETCH}\n`,
        reason: `git lfs fetch exited with code 2: ${OBJECT_404}; ${DOES_NOT_HAVE_OBJECTS}`,
      },
      {
        name: 'an object missing from a file remote',
        stderr: `${REMOTE_MISSING}\n${FAILED_TO_FETCH}\n`,
        reason: `git lfs fetch exited with code 2: ${REMOTE_MISSING}; ${DOES_NOT_HAVE_OBJECTS}`,
      },
      {
        name: 'a per-object 404 after an authorization error',
        stderr: `${AUTHORIZATION_ERROR}\n${OBJECT_404}\n`,
        reason: `git lfs fetch exited with code 2: ${AUTHORIZATION_ERROR}; ${GH_NOT_AUTHENTICATED}`,
      },
      {
        name: 'a connection failure',
        stderr: `${CONNECTION_REFUSED}\n${FAILED_TO_FETCH}\n`,
        reason: `git lfs fetch exited with code 2: ${CONNECTION_REFUSED}; ${LFS_RETRY}`,
      },
      {
        name: 'a 404 that names no object',
        stderr:
          'batch response: Post "https://github.com/octo/app.git/info/lfs/objects/batch": [404] Not Found\n',
        reason: `git lfs fetch exited with code 2: batch response: Post "https://github.com/octo/app.git/info/lfs/objects/batch": [404] Not Found; ${LFS_RETRY}`,
      },
      {
        name: 'the unsafe-keys warning ahead of a batch response line',
        stderr: `${UNSAFE_KEYS_WARNING}\n${CONNECTION_REFUSED}\n${FAILED_TO_FETCH}\n`,
        reason: `git lfs fetch exited with code 2: ${CONNECTION_REFUSED}; ${LFS_RETRY}`,
      },
      {
        name: 'text no row recognizes',
        stderr: 'fatal: something else went wrong\n',
        reason: `git lfs fetch exited with code 2: fatal: something else went wrong; ${LFS_RETRY}`,
      },
      {
        name: 'no stderr at all',
        stderr: '',
        reason: `git lfs fetch exited with code 2; ${LFS_RETRY}`,
      },
    ])(
      'gives the exit code, the telling stderr line, and the next step for $name',
      async ({ stderr, reason }) => {
        const runProcess = buildLfsRunProcess({ lfsFetch: lfsFetchFailedWith(stderr) });
        const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

        const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

        expect(result).toEqual({
          ok: false,
          error: {
            kind: 'ManagedCloneError',
            operation: 'lfs-fetch',
            repository: 'github.com/octo/app',
            reason,
          },
        });
      },
    );

    it('names the host in the authentication next step for a repository on another server', async () => {
      const runProcess = buildLfsRunProcess({
        lfsFetch: lfsFetchFailedWith(
          'batch response: Authorization error: https://ghe.example.com/x\n',
        ),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.fetchLfsObjects(
        directory,
        { host: 'ghe.example.com', owner: 'octo', repo: 'app' },
        LFS_COMMIT,
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          reason: expect.stringMatching(
            /; gh is not authenticated for ghe\.example\.com; run gh auth login --hostname ghe\.example\.com$/,
          ),
        },
      });
    });

    it('masks a GitHub token shape in the stderr line it quotes', async () => {
      const rawToken = `ghp_${'x'.repeat(36)}`;
      const runProcess = buildLfsRunProcess({
        lfsFetch: lfsFetchFailedWith(`batch response: bad credentials for ${rawToken}\n`),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(result.ok).toBe(false);
      if (result.ok || result.error.kind !== 'ManagedCloneError') return;
      expect(result.error.reason).not.toContain(rawToken);
      expect(result.error.reason).toContain('[REDACTED]');
    });

    it('reports the ten-minute limit with the retry next step', async () => {
      const runProcess = buildLfsRunProcess({
        lfsFetch: launched({ exitCode: null, timedOut: true }),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(result).toMatchObject({
        ok: false,
        error: {
          operation: 'lfs-fetch',
          reason: `git lfs fetch did not finish within 10 minutes; ${LFS_RETRY}`,
        },
      });
    });

    it.each([
      { signal: 'SIGKILL', shown: 'SIGKILL' },
      { signal: null, shown: 'unknown' },
    ])(
      'reports an exit by signal as $shown with the retry next step',
      async ({ signal, shown }) => {
        const runProcess = buildLfsRunProcess({ lfsFetch: launched({ exitCode: null, signal }) });
        const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

        const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

        expect(result).toMatchObject({
          ok: false,
          error: {
            operation: 'lfs-fetch',
            reason: `git lfs fetch exited unexpectedly (signal ${shown}); ${LFS_RETRY}`,
          },
        });
      },
    );

    it.each([
      { launch: { code: 'EACCES' }, cause: 'EACCES' },
      { launch: {}, cause: 'boom' },
    ])('reports a fetch that cannot be started with $cause', async ({ launch, cause }) => {
      const runProcess = buildLfsRunProcess({ lfsFetch: launchFailure(launch) });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(result).toMatchObject({
        ok: false,
        error: { operation: 'lfs-fetch', reason: `git could not be started: ${cause}` },
      });
    });

    it('returns a CancellationError when the fetch is cancelled and still releases the lock', async () => {
      const runProcess = buildLfsRunProcess({
        lfsFetch: launched({ exitCode: null, cancelled: true }),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(result).toEqual({
        ok: false,
        error: { kind: 'CancellationError', activeCaseIds: [] },
      });
      expect(existsSync(`${directory}.lock`)).toBe(false);
    });

    it('releases the lock after a failed fetch', async () => {
      const runProcess = buildLfsRunProcess({ lfsFetch: lfsFetchFailedWith('fatal: boom\n') });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(existsSync(`${directory}.lock`)).toBe(false);
    });
  });

  describe('before the fetch', () => {
    it('starts no process and returns a CancellationError when the command is already cancelled', async () => {
      const controller = new AbortController();
      controller.abort();
      const runProcess = buildLfsRunProcess();
      const adapter = createManagedCloneAdapter(
        buildOptions({ runProcess, cancellation: controller.signal }),
      );

      const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(result).toEqual({
        ok: false,
        error: { kind: 'CancellationError', activeCaseIds: [] },
      });
      expect(runProcess).not.toHaveBeenCalled();
    });

    it('fails a host that breaks the host rule without starting a process or creating a lock', async () => {
      const runProcess = buildLfsRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.fetchLfsObjects(
        directory,
        { host: 'gh;ost.example.com', owner: 'octo', repo: 'app' },
        LFS_COMMIT,
      );

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ManagedCloneError',
          operation: 'lfs-fetch',
          repository: 'gh;ost.example.com/octo/app',
          reason:
            'host "gh;ost.example.com" holds characters other than letters, digits, hyphens, and dots',
        },
      });
      expect(runProcess).not.toHaveBeenCalled();
      expect(existsSync(`${directory}.lock`)).toBe(false);
    });

    it('holds the clone lock while the fetch runs and not after it', async () => {
      const lockDuringFetch: boolean[] = [];
      const runProcess = buildLfsRunProcess({
        whileFetching: () => lockDuringFetch.push(existsSync(`${directory}.lock`)),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(lockDuringFetch).toEqual([true]);
      expect(existsSync(`${directory}.lock`)).toBe(false);
    });

    it('fails at once when the lock already exists, leaves it in place, and starts neither gh nor the fetch', async () => {
      await mkdir(`${directory}.lock`);
      const runProcess = buildLfsRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ManagedCloneError',
          operation: 'lfs-fetch',
          repository: 'github.com/octo/app',
          reason: `clone lock already exists at "${directory}.lock"; another tevu command may be updating this clone, or the lock is stale and must be removed by the operator`,
        },
      });
      expect(existsSync(`${directory}.lock`)).toBe(true);
      expect(callsOf(runProcess).some(isGhVersionCall)).toBe(false);
      expect(callsOf(runProcess).some(isGitLfsFetchCall)).toBe(false);
    });

    it('reports gh as missing without starting the fetch and releases the lock', async () => {
      const runProcess = buildLfsRunProcess({ ghVersion: launchFailure({ code: 'ENOENT' }) });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ManagedCloneError',
          operation: 'lfs-fetch',
          repository: 'github.com/octo/app',
          reason:
            'GitHub CLI (gh) is not installed or not on PATH; install it from https://cli.github.com',
        },
      });
      expect(callsOf(runProcess).some(isGitLfsFetchCall)).toBe(false);
      expect(existsSync(`${directory}.lock`)).toBe(false);
    });
  });

  describe('the git lfs probe', () => {
    it('runs git lfs version outside every repository with a 30 second limit', async () => {
      const runProcess = buildLfsRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      const probe = callsOf(runProcess).find(isGitLfsVersionCall);
      expect(probe?.argv).toEqual(['git', 'lfs', 'version']);
      expect(probe?.cwd).toBe(tmpdir());
      expect(probe?.timeoutMs).toBe(30_000);
    });

    it.each([
      { name: 'cannot be started', lfsVersion: launchFailure({ code: 'ENOENT' }) },
      { name: 'exits nonzero', lfsVersion: launched({ exitCode: 1 }) },
      {
        name: 'prints something other than a git-lfs version',
        lfsVersion: launched({ stdout: captured('git: lfs is not a git command\n') }),
      },
    ])(
      'reports Git LFS as not installed when git lfs version $name, without a lock or a fetch',
      async ({ lfsVersion }) => {
        const runProcess = buildLfsRunProcess({ lfsVersion });
        const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

        const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

        expect(result).toEqual({
          ok: false,
          error: {
            kind: 'ManagedCloneError',
            operation: 'lfs-fetch',
            repository: 'github.com/octo/app',
            reason: 'Git LFS is not installed or not on PATH; install it from https://git-lfs.com',
          },
        });
        expect(callsOf(runProcess).map((call) => call.argv[0])).toEqual(['git']);
        expect(existsSync(`${directory}.lock`)).toBe(false);
      },
    );

    it('reports the 30 second limit when git lfs version does not finish', async () => {
      const runProcess = buildLfsRunProcess({
        lfsVersion: launched({ exitCode: null, timedOut: true }),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(result).toMatchObject({
        ok: false,
        error: {
          operation: 'lfs-fetch',
          reason: 'git lfs version did not finish within 30 seconds',
        },
      });
    });

    it('returns a CancellationError when the probe is cancelled', async () => {
      const runProcess = buildLfsRunProcess({
        lfsVersion: launched({ exitCode: null, cancelled: true }),
      });
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const result = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(result).toEqual({
        ok: false,
        error: { kind: 'CancellationError', activeCaseIds: [] },
      });
    });

    it('probes once per adapter instance across fetches', async () => {
      const runProcess = buildLfsRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);
      await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(callsOf(runProcess).filter(isGitLfsVersionCall)).toHaveLength(1);
      expect(callsOf(runProcess).filter(isGitLfsFetchCall)).toHaveLength(2);
    });

    it('probes again after a failed probe', async () => {
      const runProcess = vi
        .fn<ManagedProcessRunner>()
        .mockResolvedValueOnce(launchFailure({ code: 'ENOENT' }))
        .mockResolvedValue(lfsVersionInstalled());
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      const first = await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);
      await adapter.fetchLfsObjects(directory, REPOSITORY, LFS_COMMIT);

      expect(first.ok).toBe(false);
      expect(callsOf(runProcess).filter(isGitLfsVersionCall)).toHaveLength(2);
    });

    it('starts no probe for a clone operation', async () => {
      const runProcess = buildRunProcess();
      const adapter = createManagedCloneAdapter(buildOptions({ runProcess }));

      await adapter.clone(join(root, 'other.git'), REPOSITORY);

      expect(callsOf(runProcess).some(isGitLfsVersionCall)).toBe(false);
    });
  });
});
