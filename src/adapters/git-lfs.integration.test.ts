// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runManagedProcess } from '@/adapters/process';
import { ensureManagedCommits, ensureManagedLfsObjects } from '@/application/managed-clone';

import { buildLfsObject, lfsObjectFile } from './__fixtures__/lfs.fixtures';
import { createGitWorkspaceAdapter, createSourceValidator } from './git';
import { createManagedCloneAdapter } from './managed-clone';

import type { LfsObject } from './__fixtures__/lfs.fixtures';
import type { ManagedLfsDependencies } from '@/application/managed-clone';
import type {
  CaseIdentity,
  CaseWorkspace,
  ManagedProcessRequest,
  ManagedProcessResult,
  ManagedProcessRunner,
  TevuError,
  TevuResult,
} from '@/domain/types';

const gitLfsInstalled = spawnSync('git', ['lfs', 'version']).status === 0;

/** Registers a suite that needs the git-lfs tool, reported as skipped by name when the tool is absent. */
function describeWithGitLfs(name: string, body: () => void): void {
  if (gitLfsInstalled) {
    describe(name, body);
  } else {
    describe.skip(`git lfs is not installed: ${name}`, body);
  }
}

const GIT_IDENTITY_FLAGS = ['-c', 'user.name=tevu', '-c', 'user.email=tevu@localhost'];
const LFS_VERSION_LINE = 'version https://git-lfs.github.com/spec/v1';
const UNREACHABLE_LFS_CONFIG = '[lfs]\n\turl = http://127.0.0.1:9/unreachable\n';
const TEST_TIMEOUT_MS = 60_000;
const FAKE_GH_SCRIPT = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version 2.86.0 (fake)"
  exit 0
fi
echo "unexpected gh invocation: $@" >&2
exit 1
`;

const LFS_CONTENT = {
  'assets/model.bin': Buffer.from(
    Array.from({ length: 4096 }, (_, index) => (index * 31 + 7) % 256),
  ),
  'assets/small.bin': Buffer.from('hello'),
  'tools/run.bin': Buffer.from('#!/bin/sh\necho from lfs\n'),
} as const;
type LfsPath = keyof typeof LFS_CONTENT;
const LFS_PATHS = Object.keys(LFS_CONTENT) as LfsPath[];

type LfsSource = {
  path: string;
  commit: string;
  objects: Readonly<Record<LfsPath, LfsObject>>;
};

let testDirectory = '';

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), 'tevu-git-lfs-it-'));
});

afterEach(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

function unwrapOk<T, K extends TevuError['kind']>(result: TevuResult<T, K>): T {
  if (!result.ok) {
    throw new Error(`expected an ok result, received ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

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
    timeout: 60_000,
  });
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  };
}

/** Builds a repository with the real git-lfs tool: tracked `*.bin` files, a root `.lfsconfig` naming an unreachable endpoint. */
async function createLfsSource(): Promise<LfsSource> {
  const path = join(testDirectory, 'source');
  await mkdir(path, { recursive: true });
  await runGit(path, ['init', '--quiet', '-b', 'main']);
  await runGit(path, ['lfs', 'install', '--local']);
  await runGit(path, ['lfs', 'track', '*.bin']);
  await writeFile(join(path, '.lfsconfig'), UNREACHABLE_LFS_CONFIG);
  for (const file of LFS_PATHS) {
    await mkdir(join(path, file, '..'), { recursive: true });
    await writeFile(join(path, file), LFS_CONTENT[file]);
  }
  await chmod(join(path, 'tools/run.bin'), 0o755);
  await runGit(path, ['add', '-A']);
  await runGit(path, [...GIT_IDENTITY_FLAGS, 'commit', '--quiet', '-m', 'lfs source commit']);
  const commit = (await runGit(path, ['rev-parse', 'HEAD'])).stdout;
  const objects = Object.fromEntries(
    LFS_PATHS.map((file) => [file, buildLfsObject(LFS_CONTENT[file])]),
  ) as Record<LfsPath, LfsObject>;
  for (const file of LFS_PATHS) {
    const committed = (await runGit(path, ['show', `HEAD:${file}`])).stdout;
    if (`${committed}\n` !== objects[file].pointer) {
      throw new Error(`the fixture committed an unexpected pointer for ${file}`);
    }
  }
  return { path, commit, objects };
}

function buildIdentity(sourceCommit: string, caseId = 'task-1--c1'): CaseIdentity {
  return {
    caseId,
    taskId: 'task-1',
    modelId: 'c1',
    attempt: 1,
    sourceCommit,
    model: 'synthetic/model-a',
    effort: 'fast',
    agent: 'opencode',
    timeoutMs: 60_000,
  };
}

function createGitAdapter(): ReturnType<typeof createGitWorkspaceAdapter> {
  return createGitWorkspaceAdapter({ workspacesDirectory: join(testDirectory, 'workspaces') });
}

async function sealFrom(
  repository: { id: string; path: string },
  commit: string,
): Promise<ReturnType<ReturnType<typeof createGitAdapter>['createIsolatedCase']>> {
  return createGitAdapter().createIsolatedCase(buildIdentity(commit), repository);
}

async function sealedContentHex(workspace: CaseWorkspace): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      LFS_PATHS.map(
        async (file) =>
          [
            file,
            (await readFile(join(workspace.worktreeDirectory, file))).toString('hex'),
          ] as const,
      ),
    ),
  );
}

const EXPECTED_CONTENT_HEX = Object.fromEntries(
  LFS_PATHS.map((file) => [file, LFS_CONTENT[file].toString('hex')]),
);

/** Replaces a file's bytes without writing through a hard link another store shares. */
async function replaceFileContent(file: string, bytes: Uint8Array): Promise<void> {
  await unlink(file);
  await writeFile(file, bytes);
}

async function copyLfsObject(
  fromObjectsDirectory: string,
  toObjectsDirectory: string,
  oid: string,
): Promise<void> {
  const target = lfsObjectFile(toObjectsDirectory, oid);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(lfsObjectFile(fromObjectsDirectory, oid), target);
}

async function listFilesWithSizes(root: string): Promise<string[]> {
  const listing: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else {
        listing.push(`${entryPath}:${(await stat(entryPath)).size}`);
      }
    }
  }
  if (existsSync(root)) {
    await walk(root);
  }
  return listing.sort();
}

async function sourceFingerprint(source: LfsSource): Promise<{
  head: string;
  status: string;
  objects: string;
  storage: string[];
}> {
  return {
    head: (await runGit(source.path, ['rev-parse', 'HEAD'])).stdout,
    status: (await runGit(source.path, ['status', '--porcelain'])).stdout,
    objects: (await runGit(source.path, ['count-objects', '-v'])).stdout,
    storage: await listFilesWithSizes(join(source.path, '.git', 'lfs')),
  };
}

describeWithGitLfs('sealing a case from a source that stores files in Git LFS', () => {
  it(
    'writes each pointer entry as its object bytes',
    async () => {
      const source = await createLfsSource();

      const workspace = unwrapOk(
        await sealFrom({ id: 'repo-1', path: source.path }, source.commit),
      );

      expect(await sealedContentHex(workspace)).toEqual(EXPECTED_CONTENT_HEX);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps one synthetic root commit that carries no Git LFS storage, filter, remote, or credential',
    async () => {
      const source = await createLfsSource();

      const workspace = unwrapOk(
        await sealFrom({ id: 'repo-1', path: source.path }, source.commit),
      );

      const worktree = workspace.worktreeDirectory;
      const configKeys = (
        await runGit(worktree, ['config', '--local', '--list', '--name-only'])
      ).stdout
        .split('\n')
        .filter((key) => key.length > 0);
      const hooks = await readdir(join(workspace.repositoryDirectory, 'hooks')).catch(() => []);
      expect((await runGit(worktree, ['rev-list', '--all', '--count'])).stdout).toBe('1');
      expect((await runGit(worktree, ['rev-list', '--parents', '-n', '1', 'HEAD'])).stdout).toBe(
        (await runGit(worktree, ['rev-parse', 'HEAD'])).stdout,
      );
      expect((await runGit(worktree, ['remote'])).stdout).toBe('');
      expect(
        configKeys.filter((key) =>
          ['lfs.', 'filter.', 'remote.', 'credential.'].some((prefix) => key.startsWith(prefix)),
        ),
      ).toEqual([]);
      expect(configKeys).toContain('core.bare');
      expect(configKeys).not.toContain('core.bigfilethreshold');
      expect(await readdir(workspace.repositoryDirectory)).not.toContain('lfs');
      expect(hooks.filter((hook) => !hook.endsWith('.sample'))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the tracked .gitattributes and .lfsconfig byte-identical to the base commit',
    async () => {
      const source = await createLfsSource();

      const workspace = unwrapOk(
        await sealFrom({ id: 'repo-1', path: source.path }, source.commit),
      );

      for (const file of ['.gitattributes', '.lfsconfig']) {
        expect(
          (await runGit(workspace.worktreeDirectory, ['rev-parse', `HEAD:${file}`])).stdout,
        ).toBe((await runGit(source.path, ['rev-parse', `${source.commit}:${file}`])).stdout);
      }
      expect(await readFile(join(workspace.worktreeDirectory, '.lfsconfig'), 'utf8')).toBe(
        UNREACHABLE_LFS_CONFIG,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves the source repository and its Git LFS storage unchanged through validation, sealing, and disposal',
    async () => {
      const source = await createLfsSource();
      const adapter = createGitAdapter();
      const before = await sourceFingerprint(source);

      const validated = await adapter.validateSource(
        { id: 'repo-1', path: source.path },
        source.commit,
      );
      const workspace = unwrapOk(
        await adapter.createIsolatedCase(buildIdentity(source.commit), {
          id: 'repo-1',
          path: source.path,
        }),
      );
      const disposed = await adapter.dispose(workspace);
      const after = await sourceFingerprint(source);

      expect(validated.ok).toBe(true);
      expect(disposed.ok).toBe(true);
      expect(before.storage).toHaveLength(LFS_PATHS.length);
      expect(after).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fails validation and sealing with the fetch command for a path entry when an object is deleted',
    async () => {
      const source = await createLfsSource();
      const objectsDirectory = join(await realpath(source.path), '.git', 'lfs', 'objects');
      await unlink(lfsObjectFile(objectsDirectory, source.objects['assets/model.bin'].oid));
      const adapter = createGitAdapter();
      const repository = { id: 'repo-1', path: source.path };
      const reason = `repository "repo-1": Git LFS objects not in "${objectsDirectory}": 1 of ${LFS_PATHS.length}; fetch them in "${source.path}" first, for example: git lfs fetch -I "" -X "" origin ${source.commit}`;

      const validated = await adapter.validateSource(repository, source.commit);
      const sealed = await adapter.createIsolatedCase(buildIdentity(source.commit), repository);

      expect(validated).toEqual({
        ok: false,
        error: { kind: 'SourceMaterializationError', taskId: 'repo-1', reason },
      });
      expect(sealed).toEqual({
        ok: false,
        error: { kind: 'SourceMaterializationError', taskId: 'task-1', reason },
      });
      expect(existsSync(join(testDirectory, 'workspaces', 'task-1--c1'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'validates an object of the right size but wrong bytes, then fails sealing with the mismatch text and no case directory',
    async () => {
      const source = await createLfsSource();
      const { oid, size } = source.objects['assets/small.bin'];
      const objectsDirectory = join(await realpath(source.path), '.git', 'lfs', 'objects');
      const file = lfsObjectFile(objectsDirectory, oid);
      await replaceFileContent(file, Buffer.alloc(size, 0x78));
      const adapter = createGitAdapter();
      const repository = { id: 'repo-1', path: source.path };

      const validated = await adapter.validateSource(repository, source.commit);
      const sealed = await adapter.createIsolatedCase(buildIdentity(source.commit), repository);

      expect(validated.ok).toBe(true);
      expect(sealed).toEqual({
        ok: false,
        error: {
          kind: 'SourceMaterializationError',
          taskId: 'task-1',
          reason: `repository "repo-1": Git LFS object file "${file}" does not match its pointer; delete the file, then fetch it again in "${source.path}", for example: git lfs fetch -I "" -X "" origin ${source.commit}`,
        },
      });
      expect(existsSync(join(testDirectory, 'workspaces', 'task-1--c1'))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  describe('patch capture and restore of a materialized path', () => {
    const EDITED_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);

    it(
      'captures no patch for an untouched case',
      async () => {
        const source = await createLfsSource();
        const workspace = unwrapOk(
          await sealFrom({ id: 'repo-1', path: source.path }, source.commit),
        );

        const patch = unwrapOk(await createGitAdapter().capturePatch(workspace));

        expect(patch.isEmpty).toBe(true);
        expect(patch.content).toBe('');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'captures an edited path as a binary content change, never as pointer text',
      async () => {
        const source = await createLfsSource();
        const workspace = unwrapOk(
          await sealFrom({ id: 'repo-1', path: source.path }, source.commit),
        );
        await writeFile(join(workspace.worktreeDirectory, 'assets/model.bin'), EDITED_BYTES);

        const patch = unwrapOk(await createGitAdapter().capturePatch(workspace));

        expect(patch.isEmpty).toBe(false);
        expect(patch.content).toContain('diff --git a/assets/model.bin b/assets/model.bin');
        expect(patch.content).toContain('GIT binary patch');
        expect(patch.content).not.toContain(LFS_VERSION_LINE);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'restores an edited path to its object bytes and lists it as restored',
      async () => {
        const source = await createLfsSource();
        const adapter = createGitAdapter();
        const workspace = unwrapOk(
          await adapter.createIsolatedCase(buildIdentity(source.commit), {
            id: 'repo-1',
            path: source.path,
          }),
        );
        await writeFile(join(workspace.worktreeDirectory, 'assets/model.bin'), EDITED_BYTES);

        const applied = unwrapOk(
          await adapter.applyCheckState(workspace, {
            restore: ['assets/model.bin'],
            overlay: null,
          }),
        );

        expect(applied.restore?.restored).toEqual(['assets/model.bin']);
        expect(await readFile(join(workspace.worktreeDirectory, 'assets/model.bin'))).toEqual(
          LFS_CONTENT['assets/model.bin'],
        );
      },
      TEST_TIMEOUT_MS,
    );
  });
});

describeWithGitLfs('fetching Git LFS objects into a managed clone', () => {
  const ENTRY = { id: 'app', github: 'octo/app' };
  const DISPLAY = 'github.com/octo/app';

  type CloneFixture = {
    source: LfsSource;
    remoteDirectory: string;
    cloneDirectory: string;
    progress: string[];
    processCalls: string[][];
    dependencies: ManagedLfsDependencies;
  };

  async function createCloneFixture(): Promise<CloneFixture> {
    const source = await createLfsSource();
    const remoteDirectory = join(testDirectory, 'remote.git');
    await runGit(testDirectory, ['clone', '--quiet', '--bare', source.path, remoteDirectory]);
    await cp(join(source.path, '.git', 'lfs', 'objects'), join(remoteDirectory, 'lfs', 'objects'), {
      recursive: true,
    });
    const ghBinDirectory = join(testDirectory, 'gh-bin');
    await mkdir(ghBinDirectory);
    await writeFile(join(ghBinDirectory, 'gh'), FAKE_GH_SCRIPT);
    await chmod(join(ghBinDirectory, 'gh'), 0o755);

    const processCalls: string[][] = [];
    const runProcess: ManagedProcessRunner = async (
      request: ManagedProcessRequest,
    ): Promise<ManagedProcessResult> => {
      processCalls.push([...request.argv]);
      return runManagedProcess(request);
    };
    const cloneRoot = join(testDirectory, 'cache');
    await mkdir(cloneRoot);
    const progress: string[] = [];
    const dependencies: ManagedLfsDependencies = {
      clones: createManagedCloneAdapter({
        runProcess,
        parentEnvironment: {
          ...process.env,
          PATH: `${ghBinDirectory}:${process.env['PATH'] ?? ''}`,
        },
        secretValues: () => [],
        cancellation: new AbortController().signal,
        remoteUrl: () => `file://${remoteDirectory}`,
      }),
      git: createSourceValidator(),
      managedCloneRoot: cloneRoot,
      onProgress: (line) => progress.push(line),
    };
    const cloned = await ensureManagedCommits(
      { repository: ENTRY, revisions: [source.commit] },
      dependencies,
    );
    unwrapOk(cloned);
    processCalls.length = 0;
    progress.length = 0;
    return {
      source,
      remoteDirectory,
      cloneDirectory: join(cloneRoot, 'github.com', 'octo', 'app.git'),
      progress,
      processCalls,
      dependencies,
    };
  }

  function cloneRepository(fixture: CloneFixture): { id: string; path: string; github: string } {
    return { ...ENTRY, path: fixture.cloneDirectory };
  }

  it(
    'reports the objects of a fresh clone as missing with the dry-run next step for a GitHub entry',
    async () => {
      const fixture = await createCloneFixture();
      const objectsDirectory = join(await realpath(fixture.cloneDirectory), 'lfs', 'objects');

      const validated = await createSourceValidator().validateSource(
        cloneRepository(fixture),
        fixture.source.commit,
      );

      expect(validated).toEqual({
        ok: false,
        error: {
          kind: 'SourceMaterializationError',
          taskId: 'app',
          reason: `repository "app": Git LFS objects not in "${objectsDirectory}": ${LFS_PATHS.length} of ${LFS_PATHS.length}; tevu run --dry-run fetches them from ${DISPLAY}`,
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'fetches the missing objects although the pinned commit names an unreachable endpoint, then validation passes and a sealed case holds the content',
    async () => {
      const fixture = await createCloneFixture();

      const ensured = await ensureManagedLfsObjects(
        { repository: ENTRY, revision: fixture.source.commit },
        fixture.dependencies,
      );
      const validated = await createSourceValidator().validateSource(
        cloneRepository(fixture),
        fixture.source.commit,
      );
      const workspace = unwrapOk(await sealFrom(cloneRepository(fixture), fixture.source.commit));

      expect(ensured).toEqual({ ok: true, value: undefined });
      expect(fixture.progress).toEqual([
        `Fetching ${LFS_PATHS.length} Git LFS objects from ${DISPLAY} into the clone of repository "app"`,
      ]);
      expect(validated.ok).toBe(true);
      expect(await sealedContentHex(workspace)).toEqual(EXPECTED_CONTENT_HEX);
      expect(existsSync(`${fixture.cloneDirectory}.lock`)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'would fail to fetch the same clone without the pinned endpoint',
    async () => {
      const fixture = await createCloneFixture();

      const unpinned = await runGit(fixture.cloneDirectory, [
        'lfs',
        'fetch',
        '-I',
        '',
        '-X',
        '',
        `file://${fixture.remoteDirectory}`,
        fixture.source.commit,
      ]);

      expect(unpinned.exitCode).not.toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts no fetch and reports no progress when the clone already holds every object',
    async () => {
      const fixture = await createCloneFixture();
      unwrapOk(
        await ensureManagedLfsObjects(
          { repository: ENTRY, revision: fixture.source.commit },
          fixture.dependencies,
        ),
      );
      fixture.progress.length = 0;
      fixture.processCalls.length = 0;

      const again = await ensureManagedLfsObjects(
        { repository: ENTRY, revision: fixture.source.commit },
        fixture.dependencies,
      );

      expect(again).toEqual({ ok: true, value: undefined });
      expect(fixture.progress).toEqual([]);
      expect(fixture.processCalls).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  describe('when an object is absent from the remote', () => {
    const ABSENT_PATH: LfsPath = 'assets/small.bin';

    it(
      'fails with the missing-object reason naming the object and the exit code git-lfs returned',
      async () => {
        const fixture = await createCloneFixture();
        const { oid } = fixture.source.objects[ABSENT_PATH];
        await unlink(lfsObjectFile(join(fixture.remoteDirectory, 'lfs', 'objects'), oid));

        const ensured = await ensureManagedLfsObjects(
          { repository: ENTRY, revision: fixture.source.commit },
          fixture.dependencies,
        );

        expect(ensured).toMatchObject({
          ok: false,
          error: {
            kind: 'ManagedCloneError',
            operation: 'lfs-fetch',
            repository: DISPLAY,
            reason: expect.stringMatching(
              new RegExp(
                `^git lfs fetch exited with code [1-9][0-9]*: error transferring "${oid}": \\[0\\] remote missing object ${oid}; ${DISPLAY.replaceAll('.', '\\.')} does not have every Git LFS object of this commit; choose another base commit$`,
              ),
            ),
          },
        });
        expect(existsSync(`${fixture.cloneDirectory}.lock`)).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'keeps the objects it fetched, so a retry announces and fetches only the object still missing',
      async () => {
        const fixture = await createCloneFixture();
        const absent = fixture.source.objects[ABSENT_PATH];
        const remoteObjects = join(fixture.remoteDirectory, 'lfs', 'objects');
        await unlink(lfsObjectFile(remoteObjects, absent.oid));
        await ensureManagedLfsObjects(
          { repository: ENTRY, revision: fixture.source.commit },
          fixture.dependencies,
        );
        await copyLfsObject(
          join(fixture.source.path, '.git', 'lfs', 'objects'),
          remoteObjects,
          absent.oid,
        );

        const retried = await ensureManagedLfsObjects(
          { repository: ENTRY, revision: fixture.source.commit },
          fixture.dependencies,
        );

        expect(retried).toEqual({ ok: true, value: undefined });
        expect(fixture.progress).toEqual([
          `Fetching ${LFS_PATHS.length} Git LFS objects from ${DISPLAY} into the clone of repository "app"`,
          `Fetching 1 Git LFS object from ${DISPLAY} into the clone of repository "app"`,
        ]);
      },
      TEST_TIMEOUT_MS,
    );
  });

  it(
    'fails sealing on a corrupted fetched object with the dry-run next step, and a refetch after deleting it repairs the clone',
    async () => {
      const fixture = await createCloneFixture();
      unwrapOk(
        await ensureManagedLfsObjects(
          { repository: ENTRY, revision: fixture.source.commit },
          fixture.dependencies,
        ),
      );
      const { oid, size } = fixture.source.objects['assets/small.bin'];
      const file = lfsObjectFile(
        join(await realpath(fixture.cloneDirectory), 'lfs', 'objects'),
        oid,
      );
      await replaceFileContent(file, Buffer.alloc(size, 0x78));
      fixture.progress.length = 0;

      const corrupted = await sealFrom(cloneRepository(fixture), fixture.source.commit);
      await unlink(file);
      const refetched = await ensureManagedLfsObjects(
        { repository: ENTRY, revision: fixture.source.commit },
        fixture.dependencies,
      );
      const repaired = unwrapOk(await sealFrom(cloneRepository(fixture), fixture.source.commit));

      expect(corrupted).toEqual({
        ok: false,
        error: {
          kind: 'SourceMaterializationError',
          taskId: 'task-1',
          reason: `repository "app": Git LFS object file "${file}" does not match its pointer; delete the file, then tevu run --dry-run fetches it again from ${DISPLAY}`,
        },
      });
      expect(refetched).toEqual({ ok: true, value: undefined });
      expect(fixture.progress).toEqual([
        `Fetching 1 Git LFS object from ${DISPLAY} into the clone of repository "app"`,
      ]);
      expect(await sealedContentHex(repaired)).toEqual(EXPECTED_CONTENT_HEX);
    },
    TEST_TIMEOUT_MS,
  );
});
