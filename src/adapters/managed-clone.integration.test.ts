// @vitest-environment node
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSourceValidator } from '@/adapters/git';
import { runManagedProcess } from '@/adapters/process';
import { ensureManagedCommits } from '@/application/managed-clone';

import { createManagedCloneAdapter } from './managed-clone';

import type { ManagedCloneDependencies } from '@/application/managed-clone';
import type {
  ManagedProcessRequest,
  ManagedProcessResult,
  ManagedProcessRunner,
} from '@/domain/types';

const GIT_IDENTITY_FLAGS = ['-c', 'user.name=tevu', '-c', 'user.email=tevu@localhost'];
const ENTRY = { id: 'app', github: 'octo/app' };
const TEST_TIMEOUT_MS = 20_000;

const FAKE_GH_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version 2.86.0 (fake)"
  exit 0
fi
echo "unexpected gh invocation: $@" >&2
exit 1
`;

const FAILING_GH_SCRIPT = '#!/bin/sh\nexit 1\n';

let root = '';
let remoteDirectory = '';
let cloneRoot = '';
let ghBinDirectory = '';

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ exitCode: number | null; stdout: string }> {
  const result = await execa('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    reject: false,
    stdin: 'ignore',
    timeout: 15_000,
  });
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    stdout: typeof result.stdout === 'string' ? result.stdout.trim() : '',
  };
}

/** Writes `name`, commits it on the current branch, and returns the new commit hash. */
async function commitFile(directory: string, name: string, message: string): Promise<string> {
  await writeFile(join(directory, name), `${name}\n`);
  await runGit(directory, ['add', name]);
  await runGit(directory, [...GIT_IDENTITY_FLAGS, 'commit', '--quiet', '-m', message]);
  const head = await runGit(directory, ['rev-parse', 'HEAD']);
  return head.stdout;
}

async function writeExecutableScript(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tevu-managed-clone-it-'));
  remoteDirectory = join(root, 'remote');
  cloneRoot = join(root, 'cache');
  await mkdir(remoteDirectory, { recursive: true });
  await mkdir(cloneRoot, { recursive: true });
  await runGit(remoteDirectory, ['init', '--quiet', '-b', 'main']);

  ghBinDirectory = join(root, 'gh-bin');
  await mkdir(ghBinDirectory, { recursive: true });
  await writeExecutableScript(join(ghBinDirectory, 'gh'), FAKE_GH_SCRIPT);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Wraps the real process runner, recording every argv the adapter launches. */
function buildSpyRunProcess(): { runProcess: ManagedProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runProcess: ManagedProcessRunner = async (
    request: ManagedProcessRequest,
  ): Promise<ManagedProcessResult> => {
    calls.push([...request.argv]);
    return runManagedProcess(request);
  };
  return { runProcess, calls };
}

function buildDependencies(
  runProcess: ManagedProcessRunner,
  ghBin = ghBinDirectory,
): ManagedCloneDependencies {
  const clones = createManagedCloneAdapter({
    runProcess,
    parentEnvironment: { ...process.env, PATH: `${ghBin}:${process.env['PATH'] ?? ''}` },
    secretValues: () => [],
    cancellation: new AbortController().signal,
    remoteUrl: () => remoteDirectory,
  });
  return {
    clones,
    git: createSourceValidator(),
    managedCloneRoot: cloneRoot,
    onProgress: () => {},
  };
}

describe('managed-clone adapter integration (real git, fake gh on PATH)', () => {
  it(
    'clones on first use and fetches only the missing commit on a later use (AC-16, properties 2 and 3)',
    async () => {
      const commitA = await commitFile(remoteDirectory, 'a.txt', 'commit A');
      const { runProcess, calls } = buildSpyRunProcess();

      const first = await ensureManagedCommits(
        { repository: ENTRY, revisions: [commitA] },
        buildDependencies(runProcess),
      );

      expect(first).toEqual({ ok: true, value: { missing: [] } });
      expect(calls.some((argv) => argv.includes('clone'))).toBe(true);
      expect(calls.some((argv) => argv.includes('fetch'))).toBe(false);

      const commitB = await commitFile(remoteDirectory, 'b.txt', 'commit B');
      const { runProcess: laterRunProcess, calls: laterCalls } = buildSpyRunProcess();

      const second = await ensureManagedCommits(
        { repository: ENTRY, revisions: [commitA, commitB] },
        buildDependencies(laterRunProcess),
      );

      expect(second).toEqual({ ok: true, value: { missing: [] } });
      expect(laterCalls.some((argv) => argv.includes('clone'))).toBe(false);
      const fetchCall = laterCalls.find((argv) => argv.includes('fetch'));
      expect(fetchCall).toBeDefined();
      expect(fetchCall).toContain(`${commitB}:refs/tevu/fetched/${commitB}`);
      expect(fetchCall).not.toContain(`${commitA}:refs/tevu/fetched/${commitA}`);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'calls no network method and launches no gh when every revision already resolves (property 3)',
    async () => {
      const commitA = await commitFile(remoteDirectory, 'a.txt', 'commit A');
      await ensureManagedCommits(
        { repository: ENTRY, revisions: [commitA] },
        buildDependencies(buildSpyRunProcess().runProcess),
      );

      const { runProcess, calls } = buildSpyRunProcess();
      const result = await ensureManagedCommits(
        { repository: ENTRY, revisions: [commitA] },
        buildDependencies(runProcess),
      );

      expect(result).toEqual({ ok: true, value: { missing: [] } });
      expect(calls.some((argv) => argv[0] === 'gh')).toBe(false);
      expect(calls.some((argv) => argv.includes('clone') || argv.includes('fetch'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'force-updates every branch on a fetch for a missing name, including one that resolved to a sibling commit before the call (property 10)',
    async () => {
      await commitFile(remoteDirectory, 'a.txt', 'commit A');
      await runGit(remoteDirectory, ['checkout', '-b', 'feature']);
      const initialFeatureCommit = await commitFile(
        remoteDirectory,
        'feature.txt',
        'feature commit 1',
      );
      await runGit(remoteDirectory, ['checkout', 'main']);
      const dependencies = buildDependencies(buildSpyRunProcess().runProcess);
      await ensureManagedCommits(
        { repository: ENTRY, revisions: [initialFeatureCommit] },
        dependencies,
      );

      // Diverge `feature` on the remote to a sibling commit that does not
      // descend from what the clone already fetched.
      await runGit(remoteDirectory, ['checkout', 'feature']);
      await runGit(remoteDirectory, ['reset', '--hard', 'main']);
      const movedFeatureCommit = await commitFile(
        remoteDirectory,
        'feature-2.txt',
        'feature commit 2, diverged',
      );
      await runGit(remoteDirectory, ['checkout', 'main']);
      // A branch the clone has never seen, forcing a name-based fetch.
      await runGit(remoteDirectory, ['branch', 'another-feature']);

      const result = await ensureManagedCommits(
        { repository: ENTRY, revisions: ['another-feature'] },
        dependencies,
      );

      expect(result).toEqual({ ok: true, value: { missing: [] } });
      const cloneDirectory = join(cloneRoot, 'github.com', 'octo', 'app.git');
      const featureLookup = await createSourceValidator().resolveCommit(
        { id: 'app', path: cloneDirectory },
        'feature',
      );
      expect(featureLookup).toEqual({ kind: 'found', commit: movedFeatureCommit });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'never launches gh or contacts a remote from inspectClone alone, even with an unreachable remote and a gh that fails on any launch (property 7)',
    async () => {
      const failingGhBin = join(root, 'failing-gh-bin');
      await mkdir(failingGhBin, { recursive: true });
      await writeExecutableScript(join(failingGhBin, 'gh'), FAILING_GH_SCRIPT);
      const { runProcess, calls } = buildSpyRunProcess();
      const clones = createManagedCloneAdapter({
        runProcess,
        parentEnvironment: { ...process.env, PATH: `${failingGhBin}:${process.env['PATH'] ?? ''}` },
        secretValues: () => [],
        cancellation: new AbortController().signal,
        remoteUrl: () => join(root, 'nonexistent-remote'),
      });
      const directory = join(cloneRoot, 'github.com', 'octo', 'app.git');

      expect(await clones.inspectClone(directory)).toBe('missing');

      await mkdir(directory, { recursive: true });
      expect(await clones.inspectClone(directory)).toBe('not-a-repository');
      expect(calls.some((argv) => argv[0] === 'gh')).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves no credential key in the clone's config after clone and fetch (property 6)",
    async () => {
      const commitA = await commitFile(remoteDirectory, 'a.txt', 'commit A');
      const dependencies = buildDependencies(buildSpyRunProcess().runProcess);
      await ensureManagedCommits({ repository: ENTRY, revisions: [commitA] }, dependencies);
      const commitB = await commitFile(remoteDirectory, 'b.txt', 'commit B');
      await ensureManagedCommits(
        { repository: ENTRY, revisions: [commitA, commitB] },
        dependencies,
      );

      const cloneDirectory = join(cloneRoot, 'github.com', 'octo', 'app.git');
      const configCheck = await runGit(cloneDirectory, ['config', '--get-regexp', 'credential']);

      expect(configCheck.exitCode).toBe(1);
      expect(configCheck.stdout).toBe('');
    },
    TEST_TIMEOUT_MS,
  );
});
