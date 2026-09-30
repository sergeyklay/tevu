/**
 * Ensures a GitHub repository entry's managed clone holds the commits a
 * command needs, cloning or fetching through the injected
 * {@link ManagedCloneAdapter} only when a resolution actually requires it.
 *
 * Entry points: {@link ensureManagedCommits}, {@link ensureManagedLfsObjects},
 * {@link prepareManagedRepositories}.
 */

import * as path from 'node:path';

import {
  formatGitHubRepository,
  managedCloneLocation,
  parseGitHubReference,
  parseGitHubRepository,
} from '@/domain/github-reference';

import type { ParsedGitHubRepository } from '@/domain/github-reference';
import type {
  GitWorkspaceAdapter,
  ManagedCloneAdapter,
  TevuConfig,
  TevuError,
  TevuResult,
  ValidationFinding,
} from '@/domain/types';

/** A full commit hash: 40 (SHA-1) or 64 (SHA-256) lowercase hexadecimal characters. */
const FULL_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Effects {@link ensureManagedCommits} and {@link prepareManagedRepositories} need. */
export type ManagedCloneDependencies = {
  clones: ManagedCloneAdapter;
  git: Pick<GitWorkspaceAdapter, 'resolveCommit'>;
  managedCloneRoot: string | undefined;
  /** Receives each progress line before the clone or fetch it names. */
  onProgress: (line: string) => void;
};

/** Managed-clone effects plus the offline Git LFS inventory; {@link ManagedCloneDependencies} itself is unchanged. */
export type ManagedLfsDependencies = ManagedCloneDependencies & {
  git: Pick<GitWorkspaceAdapter, 'resolveCommit' | 'inspectLfsObjects'>;
};

/** One request to ensure a GitHub entry's managed clone holds the Git LFS objects of one base commit. */
export type ManagedLfsObjectsRequest = {
  repository: { id: string; github: string };
  revision: string;
};

/** One request to ensure `revisions` resolve in a GitHub entry's managed clone. */
export type ManagedCommitsRequest = {
  repository: { id: string; github: string };
  revisions: readonly string[];
  /** Where full hashes are fetched from; defaults to the entry's own repository. */
  source?: ParsedGitHubRepository;
};

/** The revisions, as given, that still do not resolve after fetching. */
export type ManagedCommitsOutcome = { missing: string[] };

/**
 * Ensures every revision of `request` resolves in its repository's managed
 * clone: clones it first when missing, then fetches only the full hashes and
 * branch/tag names that do not already resolve locally.
 *
 * Never fetches a revision that already resolves, and calls no adapter
 * method beyond `inspectClone` when every revision already resolves. Fails
 * with `PrerequisiteError` when `dependencies.managedCloneRoot` is
 * `undefined`.
 */
export async function ensureManagedCommits(
  request: ManagedCommitsRequest,
  dependencies: ManagedCloneDependencies,
): Promise<
  TevuResult<ManagedCommitsOutcome, 'ManagedCloneError' | 'PrerequisiteError' | 'CancellationError'>
> {
  const { managedCloneRoot } = dependencies;
  if (managedCloneRoot === undefined) {
    return missingManagedCloneRoot();
  }
  const parsed = parseGitHubRepository(request.repository.github);
  if (parsed === null) {
    throw new Error(
      'unreachable: a managed-commits request names a repository the schema already validated',
    );
  }
  const directory = path.join(managedCloneRoot, managedCloneLocation(parsed));
  const source = request.source ?? parsed;
  const display = formatGitHubRepository(parsed);
  const repositoryId = request.repository.id;

  const state = await dependencies.clones.inspectClone(directory);
  if (state === 'not-a-repository') {
    return managedCloneError(
      'clone',
      display,
      `"${directory}" exists but is not a clone tevu made; remove it and run the command again`,
    );
  }
  if (state === 'missing') {
    dependencies.onProgress(
      `Cloning ${display} for repository "${repositoryId}" into ${directory}`,
    );
    const cloned = await dependencies.clones.clone(directory, parsed);
    if (!cloned.ok) {
      return cloned;
    }
  }

  const unresolved = await unresolvedRevisions(
    request.revisions,
    directory,
    repositoryId,
    dependencies,
  );
  const hashes = unresolved.filter((revision) => FULL_HASH_PATTERN.test(revision));
  const names = unresolved.filter((revision) => !FULL_HASH_PATTERN.test(revision));

  if (hashes.length > 0) {
    const sourceDisplay = formatGitHubRepository(source);
    dependencies.onProgress(
      `Fetching ${hashes.length === 1 ? '1 commit' : `${hashes.length} commits`} from ${sourceDisplay} into the clone of repository "${repositoryId}"`,
    );
    const fetched = await dependencies.clones.fetchCommits(directory, source, hashes);
    if (!fetched.ok) {
      return fetched;
    }
  }
  if (names.length > 0) {
    dependencies.onProgress(
      `Fetching branches and tags from ${display} into the clone of repository "${repositoryId}"`,
    );
    const fetched = await dependencies.clones.fetchBranchesAndTags(directory, parsed);
    if (!fetched.ok) {
      return fetched;
    }
  }

  const missing = await unresolvedRevisions(unresolved, directory, repositoryId, dependencies);
  return { ok: true, value: { missing } };
}

/**
 * Ensures the managed clone of a GitHub entry holds every Git LFS object the
 * tree of one base commit needs, fetching them once when some are missing.
 *
 * Reports no progress and fetches nothing when no object is missing or the
 * inventory fails; the source validation that follows reports that failure.
 * Fails with `PrerequisiteError` when `dependencies.managedCloneRoot` is
 * `undefined`, and with `ManagedCloneError` when the fetch fails or finishes
 * without every object.
 */
export async function ensureManagedLfsObjects(
  request: ManagedLfsObjectsRequest,
  dependencies: ManagedLfsDependencies,
): Promise<TevuResult<void, 'ManagedCloneError' | 'PrerequisiteError' | 'CancellationError'>> {
  const { managedCloneRoot } = dependencies;
  if (managedCloneRoot === undefined) {
    return missingManagedCloneRoot();
  }
  const parsed = parseGitHubRepository(request.repository.github);
  if (parsed === null) {
    throw new Error(
      'unreachable: a managed-LFS-objects request names a repository the schema already validated',
    );
  }
  const directory = path.join(managedCloneRoot, managedCloneLocation(parsed));
  const display = formatGitHubRepository(parsed);
  const clone = { id: request.repository.id, path: directory, github: request.repository.github };

  const inventory = await dependencies.git.inspectLfsObjects(clone, request.revision);
  if (!inventory.ok || inventory.value.missingCount === 0) {
    return { ok: true, value: undefined };
  }
  const { commit, missingCount } = inventory.value;
  dependencies.onProgress(
    `Fetching ${missingCount === 1 ? '1 Git LFS object' : `${missingCount} Git LFS objects`} from ${display} into the clone of repository "${request.repository.id}"`,
  );
  const fetched = await dependencies.clones.fetchLfsObjects(directory, parsed, commit);
  if (!fetched.ok) {
    return fetched;
  }

  const remaining = await dependencies.git.inspectLfsObjects(clone, commit);
  if (!remaining.ok || remaining.value.missingCount === 0) {
    return { ok: true, value: undefined };
  }
  return managedCloneError(
    'lfs-fetch',
    display,
    `git lfs fetch finished without fetching ${remaining.value.missingCount} of ${remaining.value.objectCount} Git LFS objects; choose another base commit`,
  );
}

/**
 * Clones and fetches every GitHub entry a task names, in configuration
 * order, before validation: each entry's tasks' base commits first, then
 * their Git LFS objects once per distinct base commit, failing the whole call
 * on error, then each task's reference commits, only warning when a
 * reference fetch falls short.
 */
export async function prepareManagedRepositories(
  config: TevuConfig,
  dependencies: ManagedLfsDependencies,
): Promise<
  TevuResult<ValidationFinding[], 'ManagedCloneError' | 'PrerequisiteError' | 'CancellationError'>
> {
  const warnings: ValidationFinding[] = [];
  const namedRepositoryIds = new Set(config.tasks.map((task) => task.repo));
  for (const repository of config.repositories) {
    const { github } = repository;
    if (github === undefined || !namedRepositoryIds.has(repository.id)) {
      continue;
    }
    const entry = { id: repository.id, github };
    const tasks = config.tasks.filter((task) => task.repo === repository.id);

    const baseResult = await ensureManagedCommits(
      { repository: entry, revisions: tasks.map((task) => task.base_commit) },
      dependencies,
    );
    if (!baseResult.ok) {
      return baseResult;
    }

    for (const revision of new Set(tasks.map((task) => task.base_commit))) {
      const lfsResult = await ensureManagedLfsObjects(
        { repository: entry, revision },
        dependencies,
      );
      if (!lfsResult.ok) {
        return lfsResult;
      }
    }

    for (const task of tasks) {
      const { reference } = task;
      if (reference === undefined) {
        continue;
      }
      const revisions =
        reference.kind === 'pull-request' && reference.merge_commit !== undefined
          ? [...reference.commits, reference.merge_commit]
          : [...reference.commits];
      const source = referenceSource(reference);
      const referenceResult = await ensureManagedCommits(
        { repository: entry, revisions, ...(source === undefined ? {} : { source }) },
        dependencies,
      );
      if (referenceResult.ok) {
        continue;
      }
      if (referenceResult.error.kind !== 'ManagedCloneError') {
        // A cancellation, or a managed-clone root that disappeared between
        // the base-commit fetch above and here, ends the whole preparation.
        return referenceResult;
      }
      warnings.push({
        severity: 'warning',
        identifier: `tasks.${task.id}.reference`,
        message: `reference commits cannot be fetched from ${referenceResult.error.repository}: ${referenceResult.error.reason}`,
      });
    }
  }
  return { ok: true, value: warnings };
}

/** The pull request's own repository for a pull-request reference; `undefined` for a commit reference. */
function referenceSource(
  reference: NonNullable<TevuConfig['tasks'][number]['reference']>,
): ParsedGitHubRepository | undefined {
  if (reference.kind !== 'pull-request') {
    return undefined;
  }
  const parsed = parseGitHubReference(reference.identifier);
  return parsed === null
    ? undefined
    : { host: parsed.host, owner: parsed.owner, repo: parsed.repo };
}

/**
 * Renders a `ManagedCloneError` for a log line or a rendered CLI error:
 * `cloning <repository> failed: <reason>` for a clone, `fetching from
 * <repository> failed: <reason>` for a fetch, `reading <repository> failed:
 * <reason>` for a remote check, `fetching Git LFS objects from <repository>
 * failed: <reason>` for a Git LFS fetch.
 */
export function describeManagedCloneError(
  error: Extract<TevuError, { kind: 'ManagedCloneError' }>,
): string {
  switch (error.operation) {
    case 'clone':
      return `cloning ${error.repository} failed: ${error.reason}`;
    case 'fetch':
      return `fetching from ${error.repository} failed: ${error.reason}`;
    case 'ls-remote':
      return `reading ${error.repository} failed: ${error.reason}`;
    case 'lfs-fetch':
      return `fetching Git LFS objects from ${error.repository} failed: ${error.reason}`;
  }
}

/** Distinct revisions of `revisions`, in first-appearance order, that do not resolve in `directory`. */
async function unresolvedRevisions(
  revisions: readonly string[],
  directory: string,
  repositoryId: string,
  dependencies: ManagedCloneDependencies,
): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const revision of revisions) {
    if (seen.has(revision)) {
      continue;
    }
    seen.add(revision);
    const lookup = await dependencies.git.resolveCommit(
      { id: repositoryId, path: directory },
      revision,
    );
    if (lookup.kind !== 'found') {
      result.push(revision);
    }
  }
  return result;
}

function missingManagedCloneRoot(): TevuResult<never, 'PrerequisiteError'> {
  return {
    ok: false,
    error: {
      kind: 'PrerequisiteError',
      tool: 'managed-clone-directory',
      expected: 'XDG_CACHE_HOME or HOME set to an absolute path',
      actual: 'unset',
    },
  };
}

function managedCloneError(
  operation: 'clone' | 'fetch' | 'lfs-fetch',
  repository: string,
  reason: string,
): TevuResult<never, 'ManagedCloneError'> {
  return { ok: false, error: { kind: 'ManagedCloneError', operation, repository, reason } };
}
