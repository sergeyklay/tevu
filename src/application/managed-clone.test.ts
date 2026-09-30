// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { TevuConfigSchema } from '@/config/schema';

import {
  describeManagedCloneError,
  ensureManagedCommits,
  ensureManagedLfsObjects,
  prepareManagedRepositories,
} from './managed-clone';

import type { ManagedCommitsRequest, ManagedLfsDependencies } from './managed-clone';
import type { TaskInput, TevuConfigInput } from '@/config/schema';
import type {
  CommitLookup,
  LfsObjectInventory,
  ManagedCloneAdapter,
  RepositoryDefinition,
  TevuConfig,
  TevuError,
  TevuResult,
} from '@/domain/types';

const CLONE_DIRECTORY = '/cache/tevu/repositories/github.com/octo/app.git';
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const COMMIT_C = 'c'.repeat(40);

function buildRequest(overrides: Partial<ManagedCommitsRequest> = {}): ManagedCommitsRequest {
  return { repository: { id: 'app', github: 'octo/app' }, revisions: [], ...overrides };
}

function buildManagedCloneAdapter(
  overrides: Partial<ManagedCloneAdapter> = {},
): ManagedCloneAdapter {
  return {
    inspectClone: vi.fn(async () => 'repository' as const),
    clone: vi.fn(async () => ({ ok: true as const, value: undefined })),
    fetchCommits: vi.fn(async () => ({ ok: true as const, value: undefined })),
    fetchBranchesAndTags: vi.fn(async () => ({ ok: true as const, value: undefined })),
    checkRemote: vi.fn(async () => ({ ok: true as const, value: undefined })),
    fetchLfsObjects: vi.fn(async () => ({ ok: true as const, value: undefined })),
    ...overrides,
  };
}

/** A fake `resolveCommit` reporting `found` for exactly the hashes in `resolved`. */
function buildResolveCommit(
  resolved: ReadonlySet<string>,
): (repository: RepositoryDefinition, revision: string) => Promise<CommitLookup> {
  return vi.fn(async (_repository: RepositoryDefinition, revision: string) =>
    resolved.has(revision)
      ? { kind: 'found' as const, commit: revision }
      : { kind: 'not-found' as const },
  );
}

/** A fake `inspectLfsObjects` reporting a tree that needs no Git LFS object. */
function buildInspectLfsObjects(): ManagedLfsDependencies['git']['inspectLfsObjects'] {
  return vi.fn(async (_repository: RepositoryDefinition, revision: string) => ({
    ok: true as const,
    value: { commit: revision, objectCount: 0, missingCount: 0 },
  }));
}

type DependencyOverrides = Omit<Partial<ManagedLfsDependencies>, 'git'> & {
  git?: Partial<ManagedLfsDependencies['git']>;
};

function buildDependencies(overrides: DependencyOverrides = {}): ManagedLfsDependencies {
  const { git, ...rest } = overrides;
  return {
    clones: buildManagedCloneAdapter(),
    managedCloneRoot: '/cache/tevu/repositories',
    onProgress: vi.fn(),
    ...rest,
    git: {
      resolveCommit: buildResolveCommit(new Set()),
      inspectLfsObjects: buildInspectLfsObjects(),
      ...git,
    },
  };
}

/**
 * A `clones` adapter and `resolveCommit` sharing one mutable resolved set, so
 * a fetch that succeeds makes its hashes resolvable on the next lookup.
 */
function buildFetchingDependencies(alreadyResolved: readonly string[] = []): {
  clones: ManagedCloneAdapter;
  dependencies: ManagedLfsDependencies;
} {
  const resolved = new Set(alreadyResolved);
  const clones = buildManagedCloneAdapter({
    fetchCommits: vi.fn(async (_directory, _source, commits: readonly string[]) => {
      for (const commit of commits) {
        resolved.add(commit);
      }
      return { ok: true as const, value: undefined };
    }),
  });
  const dependencies = buildDependencies({
    clones,
    git: { resolveCommit: buildResolveCommit(resolved) },
  });
  return { clones, dependencies };
}

function unwrapOk<T, K extends TevuError['kind']>(result: TevuResult<T, K>): T {
  if (!result.ok) {
    throw new Error(`expected an ok result, received ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function unwrapError<T, K extends TevuError['kind']>(
  result: TevuResult<T, K>,
): Extract<TevuError, { kind: K }> {
  if (result.ok) {
    throw new Error('expected an error result, received success');
  }
  return result.error;
}

function managedCloneError(reason = 'boom'): Extract<TevuError, { kind: 'ManagedCloneError' }> {
  return {
    kind: 'ManagedCloneError',
    operation: 'fetch',
    repository: 'github.com/octo/app',
    reason,
  };
}

describe('ensureManagedCommits', () => {
  it('fails with PrerequisiteError when managedCloneRoot is undefined, calling no adapter method', async () => {
    const clones = buildManagedCloneAdapter();
    const dependencies = buildDependencies({ clones, managedCloneRoot: undefined });

    const result = await ensureManagedCommits(
      buildRequest({ revisions: [COMMIT_A] }),
      dependencies,
    );

    expect(unwrapError(result)).toEqual({
      kind: 'PrerequisiteError',
      tool: 'managed-clone-directory',
      expected: 'XDG_CACHE_HOME or HOME set to an absolute path',
      actual: 'unset',
    });
    expect(clones.inspectClone).not.toHaveBeenCalled();
    expect(clones.clone).not.toHaveBeenCalled();
  });

  it('clones exactly once and fetches nothing when the clone is missing and every revision resolves afterward', async () => {
    const clones = buildManagedCloneAdapter({
      inspectClone: vi.fn(async () => 'missing' as const),
    });
    const dependencies = buildDependencies({
      clones,
      git: { resolveCommit: buildResolveCommit(new Set([COMMIT_A])) },
    });

    const result = await ensureManagedCommits(
      buildRequest({ revisions: [COMMIT_A] }),
      dependencies,
    );

    expect(unwrapOk(result)).toEqual({ missing: [] });
    expect(clones.clone).toHaveBeenCalledOnce();
    expect(clones.clone).toHaveBeenCalledWith(CLONE_DIRECTORY, {
      host: 'github.com',
      owner: 'octo',
      repo: 'app',
    });
    expect(clones.fetchCommits).not.toHaveBeenCalled();
    expect(clones.fetchBranchesAndTags).not.toHaveBeenCalled();
    expect(dependencies.onProgress).toHaveBeenCalledExactlyOnceWith(
      `Cloning github.com/octo/app for repository "app" into ${CLONE_DIRECTORY}`,
    );
  });

  it('calls no network method or gh when every revision already resolves', async () => {
    const clones = buildManagedCloneAdapter();
    const dependencies = buildDependencies({
      clones,
      git: { resolveCommit: buildResolveCommit(new Set([COMMIT_A, COMMIT_B])) },
    });

    const result = await ensureManagedCommits(
      buildRequest({ revisions: [COMMIT_A, COMMIT_B] }),
      dependencies,
    );

    expect(unwrapOk(result)).toEqual({ missing: [] });
    expect(clones.clone).not.toHaveBeenCalled();
    expect(clones.fetchCommits).not.toHaveBeenCalled();
    expect(clones.fetchBranchesAndTags).not.toHaveBeenCalled();
  });

  it('fetches only the distinct full hashes resolveCommit did not find, in first-appearance order', async () => {
    const { clones, dependencies } = buildFetchingDependencies([COMMIT_A]);

    const result = await ensureManagedCommits(
      buildRequest({ revisions: [COMMIT_B, COMMIT_A, COMMIT_B] }),
      dependencies,
    );

    expect(unwrapOk(result)).toEqual({ missing: [] });
    expect(clones.fetchCommits).toHaveBeenCalledExactlyOnceWith(
      CLONE_DIRECTORY,
      { host: 'github.com', owner: 'octo', repo: 'app' },
      [COMMIT_B],
    );
    expect(clones.fetchBranchesAndTags).not.toHaveBeenCalled();
    expect(dependencies.onProgress).toHaveBeenCalledExactlyOnceWith(
      'Fetching 1 commit from github.com/octo/app into the clone of repository "app"',
    );
  });

  it('names the count in the commit progress line for more than one hash', async () => {
    const dependencies = buildDependencies();

    await ensureManagedCommits(buildRequest({ revisions: [COMMIT_A, COMMIT_B] }), dependencies);

    expect(dependencies.onProgress).toHaveBeenCalledExactlyOnceWith(
      'Fetching 2 commits from github.com/octo/app into the clone of repository "app"',
    );
  });

  it('fetches both hashes and branch/tag names for a mixed request, and reports what is still missing', async () => {
    const clones = buildManagedCloneAdapter();
    const dependencies = buildDependencies({ clones });

    const result = await ensureManagedCommits(
      buildRequest({ revisions: [COMMIT_A, 'main'] }),
      dependencies,
    );

    expect(clones.fetchCommits).toHaveBeenCalledExactlyOnceWith(
      CLONE_DIRECTORY,
      { host: 'github.com', owner: 'octo', repo: 'app' },
      [COMMIT_A],
    );
    expect(clones.fetchBranchesAndTags).toHaveBeenCalledExactlyOnceWith(CLONE_DIRECTORY, {
      host: 'github.com',
      owner: 'octo',
      repo: 'app',
    });
    expect(dependencies.onProgress).toHaveBeenCalledWith(
      'Fetching branches and tags from github.com/octo/app into the clone of repository "app"',
    );
    expect(unwrapOk(result)).toEqual({ missing: [COMMIT_A, 'main'] });
  });

  it('fetches commits from an overridden source, while clone and branch/tag refresh stay on the entry itself', async () => {
    const clones = buildManagedCloneAdapter();
    const dependencies = buildDependencies({ clones });
    const source = { host: 'github.com', owner: 'other', repo: 'app' };

    await ensureManagedCommits(
      buildRequest({ revisions: [COMMIT_A, 'main'], source }),
      dependencies,
    );

    expect(clones.fetchCommits).toHaveBeenCalledExactlyOnceWith(CLONE_DIRECTORY, source, [
      COMMIT_A,
    ]);
    expect(clones.fetchBranchesAndTags).toHaveBeenCalledExactlyOnceWith(CLONE_DIRECTORY, {
      host: 'github.com',
      owner: 'octo',
      repo: 'app',
    });
  });

  it('reports the not-a-repository failure without cloning when the directory is foreign', async () => {
    const clones = buildManagedCloneAdapter({
      inspectClone: vi.fn(async () => 'not-a-repository' as const),
    });
    const dependencies = buildDependencies({ clones });

    const result = await ensureManagedCommits(
      buildRequest({ revisions: [COMMIT_A] }),
      dependencies,
    );

    expect(unwrapError(result)).toEqual({
      kind: 'ManagedCloneError',
      operation: 'clone',
      repository: 'github.com/octo/app',
      reason: `"${CLONE_DIRECTORY}" exists but is not a clone tevu made; remove it and run the command again`,
    });
    expect(clones.clone).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'clone' as const, state: 'missing' as const },
    { method: 'fetchCommits' as const, state: 'repository' as const },
    { method: 'fetchBranchesAndTags' as const, state: 'repository' as const },
  ])('propagates a $method failure unchanged', async ({ method, state }) => {
    const failure = managedCloneError('git exited with code 128');
    const clones = buildManagedCloneAdapter({
      inspectClone: vi.fn(async () => state),
      [method]: vi.fn(async () => ({ ok: false as const, error: failure })),
    });
    const revisions = method === 'fetchBranchesAndTags' ? ['main'] : [COMMIT_A];
    const dependencies = buildDependencies({ clones });

    const result = await ensureManagedCommits(buildRequest({ revisions }), dependencies);

    expect(unwrapError(result)).toEqual(failure);
  });
});

type InventoryResult = TevuResult<LfsObjectInventory, 'SourceMaterializationError'>;

function inventoryOf(
  missingCount: number,
  overrides: Partial<LfsObjectInventory> = {},
): InventoryResult {
  return {
    ok: true,
    value: { commit: COMMIT_B, objectCount: 5, missingCount, ...overrides },
  };
}

function inventoryFailure(): InventoryResult {
  return {
    ok: false,
    error: {
      kind: 'SourceMaterializationError',
      taskId: 'app',
      reason: 'repository "app": "abc" is not readable as exactly one commit',
    },
  };
}

/** Dependencies whose `inspectLfsObjects` answers the given inventories in order. */
function buildLfsDependencies(
  inventories: readonly InventoryResult[],
  overrides: DependencyOverrides = {},
): ManagedLfsDependencies {
  const inspectLfsObjects = vi.fn<ManagedLfsDependencies['git']['inspectLfsObjects']>();
  for (const inventory of inventories) {
    inspectLfsObjects.mockResolvedValueOnce(inventory);
  }
  return buildDependencies({
    ...overrides,
    git: { resolveCommit: buildResolveCommit(new Set()), inspectLfsObjects },
  });
}

describe('ensureManagedLfsObjects', () => {
  const REQUEST = { repository: { id: 'app', github: 'octo/app' }, revision: 'abbrev' };
  const CLONE = { id: 'app', path: CLONE_DIRECTORY, github: 'octo/app' };

  it('fails with the PrerequisiteError ensureManagedCommits gives when managedCloneRoot is undefined, touching nothing', async () => {
    const clones = buildManagedCloneAdapter();
    const dependencies = buildLfsDependencies([], { clones, managedCloneRoot: undefined });

    const result = await ensureManagedLfsObjects(REQUEST, dependencies);

    expect(unwrapError(result)).toEqual({
      kind: 'PrerequisiteError',
      tool: 'managed-clone-directory',
      expected: 'XDG_CACHE_HOME or HOME set to an absolute path',
      actual: 'unset',
    });
    expect(dependencies.git.inspectLfsObjects).not.toHaveBeenCalled();
    expect(clones.fetchLfsObjects).not.toHaveBeenCalled();
    expect(dependencies.onProgress).not.toHaveBeenCalled();
  });

  it('inspects the clone once and neither reports progress nor fetches when no object is missing', async () => {
    const clones = buildManagedCloneAdapter();
    const dependencies = buildLfsDependencies([inventoryOf(0)], { clones });

    const result = await ensureManagedLfsObjects(REQUEST, dependencies);

    expect(unwrapOk(result)).toBeUndefined();
    expect(dependencies.git.inspectLfsObjects).toHaveBeenCalledExactlyOnceWith(CLONE, 'abbrev');
    expect(dependencies.onProgress).not.toHaveBeenCalled();
    expect(clones.fetchLfsObjects).not.toHaveBeenCalled();
  });

  it('leaves an inventory failure to the validation that follows: ok, no progress, no fetch', async () => {
    const clones = buildManagedCloneAdapter();
    const dependencies = buildLfsDependencies([inventoryFailure()], { clones });

    const result = await ensureManagedLfsObjects(REQUEST, dependencies);

    expect(unwrapOk(result)).toBeUndefined();
    expect(dependencies.onProgress).not.toHaveBeenCalled();
    expect(clones.fetchLfsObjects).not.toHaveBeenCalled();
  });

  it('reports progress before it fetches once with the full hash the inventory resolved, then inspects that hash again', async () => {
    const clones = buildManagedCloneAdapter();
    const dependencies = buildLfsDependencies(
      [inventoryOf(1, { commit: COMMIT_B }), inventoryOf(0, { commit: COMMIT_B })],
      { clones },
    );

    const result = await ensureManagedLfsObjects(REQUEST, dependencies);

    expect(unwrapOk(result)).toBeUndefined();
    expect(clones.fetchLfsObjects).toHaveBeenCalledExactlyOnceWith(
      CLONE_DIRECTORY,
      { host: 'github.com', owner: 'octo', repo: 'app' },
      COMMIT_B,
    );
    expect(vi.mocked(dependencies.git.inspectLfsObjects).mock.calls).toEqual([
      [CLONE, 'abbrev'],
      [CLONE, COMMIT_B],
    ]);
    expect(vi.mocked(dependencies.onProgress).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(clones.fetchLfsObjects).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    {
      missing: 1,
      line: 'Fetching 1 Git LFS object from github.com/octo/app into the clone of repository "app"',
    },
    {
      missing: 3,
      line: 'Fetching 3 Git LFS objects from github.com/octo/app into the clone of repository "app"',
    },
  ])(
    'reports exactly one progress line for $missing missing objects',
    async ({ missing, line }) => {
      const dependencies = buildLfsDependencies([inventoryOf(missing), inventoryOf(0)]);

      await ensureManagedLfsObjects(REQUEST, dependencies);

      expect(vi.mocked(dependencies.onProgress).mock.calls).toEqual([[line]]);
    },
  );

  it.each([
    {
      name: 'a ManagedCloneError',
      failure: {
        kind: 'ManagedCloneError' as const,
        operation: 'lfs-fetch' as const,
        repository: 'github.com/octo/app',
        reason: 'git lfs fetch exited with code 2',
      },
    },
    {
      name: 'a CancellationError',
      failure: { kind: 'CancellationError' as const, activeCaseIds: [] },
    },
  ])('returns $name from the fetch as it is, without inspecting again', async ({ failure }) => {
    const clones = buildManagedCloneAdapter({
      fetchLfsObjects: vi.fn(async () => ({ ok: false as const, error: failure })),
    });
    const dependencies = buildLfsDependencies([inventoryOf(2)], { clones });

    const result = await ensureManagedLfsObjects(REQUEST, dependencies);

    expect(unwrapError(result)).toEqual(failure);
    expect(dependencies.git.inspectLfsObjects).toHaveBeenCalledTimes(1);
  });

  it('fails with the counts of the second inventory when objects are still missing after a fetch that succeeded', async () => {
    const dependencies = buildLfsDependencies([
      inventoryOf(3, { objectCount: 5 }),
      inventoryOf(2, { objectCount: 5 }),
    ]);

    const result = await ensureManagedLfsObjects(REQUEST, dependencies);

    expect(unwrapError(result)).toEqual({
      kind: 'ManagedCloneError',
      operation: 'lfs-fetch',
      repository: 'github.com/octo/app',
      reason:
        'git lfs fetch finished without fetching 2 of 5 Git LFS objects; choose another base commit',
    });
  });

  it('leaves a failed second inventory to the validation that follows', async () => {
    const dependencies = buildLfsDependencies([inventoryOf(2), inventoryFailure()]);

    const result = await ensureManagedLfsObjects(REQUEST, dependencies);

    expect(unwrapOk(result)).toBeUndefined();
  });
});

describe('describeManagedCloneError', () => {
  it.each([
    { operation: 'clone' as const, expected: 'cloning github.com/octo/app failed: boom' },
    { operation: 'fetch' as const, expected: 'fetching from github.com/octo/app failed: boom' },
    {
      operation: 'lfs-fetch' as const,
      expected: 'fetching Git LFS objects from github.com/octo/app failed: boom',
    },
  ])('renders the $operation form', ({ operation, expected }) => {
    expect(
      describeManagedCloneError({
        kind: 'ManagedCloneError',
        operation,
        repository: 'github.com/octo/app',
        reason: 'boom',
      }),
    ).toBe(expected);
  });
});

function buildTaskDefinition(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    title: 'Fixture task title',
    repo: 'app',
    base_commit: COMMIT_A,
    description: 'Fixture task description',
    prompt: 'Fixture task prompt',
    readiness: ['Repository is readable'],
    checks: {
      acceptance: [{ id: 'acc-1', description: 'acc', manual: true }],
      done: [{ id: 'dod-1', description: 'dod', manual: true }],
    },
    ...overrides,
  };
}

/**
 * A schema-materialized configuration whose `app` repository is a GitHub
 * entry; `repositoryInputs` schema-validates as path entries first, then
 * `app` is swapped to its GitHub form so every task's `repo` reference
 * resolves during materialization.
 */
function buildGitHubConfig(
  tasks: TaskInput[],
  repositoryInputs: TevuConfigInput['repositories'] = [
    { id: 'app', path: '/unused/path-placeholder' },
  ],
): TevuConfig {
  const input: TevuConfigInput = {
    version: 1,
    run: {
      output_dir: '/synthetic/artifacts',
      concurrency: 2,
      timeout: '60s',
      stop_grace: '500ms',
    },
    agents: { opencode: { command: 'opencode', secrets: [], env: [] } },
    repositories: repositoryInputs,
    models: [
      { id: 'c1', model: 'synthetic/model-a', effort: 'fast' },
      { id: 'c2', model: 'synthetic/model-b', effort: 'deep' },
    ],
    tasks,
  };
  const materialized = TevuConfigSchema.parse(input);
  return {
    ...materialized,
    repositories: materialized.repositories.map((repository) =>
      repository.id === 'app'
        ? { id: 'app', github: 'octo/app', path: CLONE_DIRECTORY }
        : repository,
    ),
  };
}

describe('prepareManagedRepositories', () => {
  it('fails the whole call on a base-commit fetch failure, running no reference fetch', async () => {
    const failure = managedCloneError('clone lock already exists');
    const clones = buildManagedCloneAdapter({
      inspectClone: vi.fn(async () => 'missing' as const),
      clone: vi.fn(async () => ({ ok: false as const, error: failure })),
    });
    const config = buildGitHubConfig([
      buildTaskDefinition({
        reference: { kind: 'commit', identifier: 'HEAD~1', commits: [COMMIT_B] },
      }),
    ]);
    const dependencies = buildDependencies({ clones });

    const result = await prepareManagedRepositories(config, dependencies);

    expect(unwrapError(result)).toEqual(failure);
    expect(clones.fetchBranchesAndTags).not.toHaveBeenCalled();
  });

  it('only appends a warning on a reference-commit fetch failure and continues to the next task', async () => {
    const failure = managedCloneError('git fetch did not finish within 10 minutes');
    let fetchCommitsCallCount = 0;
    const clones = buildManagedCloneAdapter({
      fetchCommits: vi.fn(async () => {
        fetchCommitsCallCount += 1;
        // The base-commit fetch (call 1) succeeds; every reference-commit fetch fails.
        return fetchCommitsCallCount === 1
          ? { ok: true as const, value: undefined }
          : { ok: false as const, error: failure };
      }),
    });
    const config = buildGitHubConfig([
      buildTaskDefinition({
        id: 'task-one',
        reference: { kind: 'commit', identifier: 'HEAD~1', commits: [COMMIT_B] },
      }),
      buildTaskDefinition({
        id: 'task-two',
        reference: { kind: 'commit', identifier: 'HEAD~1', commits: [COMMIT_B] },
      }),
    ]);
    const dependencies = buildDependencies({ clones });

    const result = await prepareManagedRepositories(config, dependencies);

    expect(unwrapOk(result)).toEqual([
      {
        severity: 'warning',
        identifier: 'tasks.task-one.reference',
        message: `reference commits cannot be fetched from github.com/octo/app: ${failure.reason}`,
      },
      {
        severity: 'warning',
        identifier: 'tasks.task-two.reference',
        message: `reference commits cannot be fetched from github.com/octo/app: ${failure.reason}`,
      },
    ]);
  });

  it('returns a CancellationError from a reference fetch immediately, without a warning', async () => {
    let fetchCommitsCallCount = 0;
    const clones = buildManagedCloneAdapter({
      fetchCommits: vi.fn(async () => {
        fetchCommitsCallCount += 1;
        return fetchCommitsCallCount === 1
          ? { ok: true as const, value: undefined }
          : {
              ok: false as const,
              error: { kind: 'CancellationError' as const, activeCaseIds: [] },
            };
      }),
    });
    const config = buildGitHubConfig([
      buildTaskDefinition({
        reference: { kind: 'commit', identifier: 'HEAD~1', commits: [COMMIT_B] },
      }),
    ]);
    const dependencies = buildDependencies({ clones });

    const result = await prepareManagedRepositories(config, dependencies);

    expect(unwrapError(result)).toEqual({ kind: 'CancellationError', activeCaseIds: [] });
  });

  it('skips a GitHub entry no task names, and never reaches the adapter for a path entry', async () => {
    const clones = buildManagedCloneAdapter();
    const config = buildGitHubConfig(
      [buildTaskDefinition({ repo: 'other' })],
      [
        { id: 'app', path: '/unused/path-placeholder' },
        { id: 'other', path: '/synthetic/other' },
      ],
    );
    const dependencies = buildDependencies({ clones });

    const result = await prepareManagedRepositories(config, dependencies);

    expect(unwrapOk(result)).toEqual([]);
    expect(clones.inspectClone).not.toHaveBeenCalled();
  });

  it("fetches a pull request's own repository as the reference source, then its merge commit", async () => {
    const clones = buildManagedCloneAdapter();
    const config = buildGitHubConfig([
      buildTaskDefinition({
        reference: {
          kind: 'pull-request',
          identifier: 'other/app#12',
          commits: [COMMIT_B],
          merge_commit: 'c'.repeat(40),
        },
      }),
    ]);
    const dependencies = buildDependencies({ clones });

    await prepareManagedRepositories(config, dependencies);

    expect(clones.fetchCommits).toHaveBeenCalledWith(
      CLONE_DIRECTORY,
      { host: 'github.com', owner: 'other', repo: 'app' },
      [COMMIT_B, 'c'.repeat(40)],
    );
  });
  describe('Git LFS objects', () => {
    it('ensures them once per distinct base commit, after the base commits and before the reference commits', async () => {
      const events: string[] = [];
      const resolved = new Set<string>();
      const clones = buildManagedCloneAdapter({
        fetchCommits: vi.fn(async (_directory, _source, commits: readonly string[]) => {
          events.push(`fetch:${commits.join(',')}`);
          for (const commit of commits) {
            resolved.add(commit);
          }
          return { ok: true as const, value: undefined };
        }),
      });
      const inspectLfsObjects = vi.fn<ManagedLfsDependencies['git']['inspectLfsObjects']>(
        async (_repository, revision) => {
          events.push(`lfs:${revision}`);
          return inventoryOf(0, { commit: revision });
        },
      );
      const config = buildGitHubConfig([
        buildTaskDefinition({
          id: 'task-one',
          base_commit: COMMIT_A,
          reference: { kind: 'commit', identifier: 'HEAD~1', commits: [COMMIT_C] },
        }),
        buildTaskDefinition({ id: 'task-two', base_commit: COMMIT_A }),
        buildTaskDefinition({ id: 'task-three', base_commit: COMMIT_B }),
      ]);
      const dependencies = buildDependencies({
        clones,
        git: { resolveCommit: buildResolveCommit(resolved), inspectLfsObjects },
      });

      const result = await prepareManagedRepositories(config, dependencies);

      expect(unwrapOk(result)).toEqual([]);
      expect(events).toEqual([
        `fetch:${COMMIT_A},${COMMIT_B}`,
        `lfs:${COMMIT_A}`,
        `lfs:${COMMIT_B}`,
        `fetch:${COMMIT_C}`,
      ]);
    });

    it('returns the first Git LFS error and runs neither a later inventory nor a reference fetch', async () => {
      const failure = {
        kind: 'ManagedCloneError' as const,
        operation: 'lfs-fetch' as const,
        repository: 'github.com/octo/app',
        reason: 'git lfs fetch exited with code 2',
      };
      const { clones, dependencies } = buildFetchingDependencies();
      vi.mocked(clones.fetchLfsObjects).mockResolvedValueOnce({ ok: false, error: failure });
      vi.mocked(dependencies.git.inspectLfsObjects).mockResolvedValue(inventoryOf(1));
      const config = buildGitHubConfig([
        buildTaskDefinition({
          id: 'task-one',
          base_commit: COMMIT_A,
          reference: { kind: 'commit', identifier: 'HEAD~1', commits: [COMMIT_C] },
        }),
        buildTaskDefinition({ id: 'task-two', base_commit: COMMIT_B }),
      ]);

      const result = await prepareManagedRepositories(config, dependencies);

      expect(unwrapError(result)).toEqual(failure);
      expect(dependencies.git.inspectLfsObjects).toHaveBeenCalledTimes(1);
      expect(clones.fetchCommits).toHaveBeenCalledTimes(1);
    });

    it('never inspects Git LFS objects for a path entry', async () => {
      const dependencies = buildDependencies();
      const config = buildGitHubConfig(
        [buildTaskDefinition({ repo: 'other' })],
        [
          { id: 'app', path: '/unused/path-placeholder' },
          { id: 'other', path: '/synthetic/other' },
        ],
      );

      await prepareManagedRepositories(config, dependencies);

      expect(dependencies.git.inspectLfsObjects).not.toHaveBeenCalled();
    });
  });
});
