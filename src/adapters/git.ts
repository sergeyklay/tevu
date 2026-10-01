/**
 * Git boundary: read-only source validation, sealed per-case repositories with
 * one synthetic root commit, pre-evaluation patch capture, the check-state
 * setup (restore and overlay) that runs before acceptance checks, and
 * workspace disposal. Source repositories are never mutated; every case owns
 * a private object database, worktree, and runtime directory with no sibling
 * references.
 */

import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { execa } from 'execa';

import { describeCause } from '@/domain/describe-cause';
import { GIT_COMMAND_TIMEOUT_MS, ISOLATED_GIT_SETTINGS } from '@/domain/git-environment';
import { formatGitHubRepository, parseGitHubRepository } from '@/domain/github-reference';

import type {
  CaseIdentity,
  CaseWorkspace,
  CheckStateRecord,
  CheckStateRequest,
  CommitLookup,
  GitWorkspaceAdapter,
  LfsObjectInventory,
  OverlayEntry,
  OverlayFileRecord,
  OverlayRecord,
  OverlaySnapshot,
  PatchArtifact,
  PatchBase,
  RepositoryDefinition,
  RestoreRecord,
  SourceValidation,
  TevuResult,
} from '@/domain/types';
import type { Stats } from 'node:fs';

/** Construction inputs for the sealed Git workspace adapter. */
export type GitWorkspaceAdapterOptions = {
  /** Root directory receiving one private subdirectory per case. */
  workspacesDirectory: string;
};

const SUBMODULE_MODE = '160000';
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755']);
const LFS_POINTER_VERSION_LINE = 'version https://git-lfs.github.com/spec/v1';
const LFS_POINTER_SIZE_LIMIT = 1024;
const COMMIT_HASH_PATTERN = /^[0-9a-f]{40,64}$/;

/** Deterministic identity for the synthetic root commit of every sealed case. */
const SYNTHETIC_COMMIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'tevu',
  GIT_AUTHOR_EMAIL: 'tevu@localhost',
  GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'tevu',
  GIT_COMMITTER_EMAIL: 'tevu@localhost',
  GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
};

/**
 * Creates the read-only source-validation half of {@link GitWorkspaceAdapter},
 * needing no configuration: it reads only the `repository`/`commit`
 * parameters it is called with.
 */
export function createSourceValidator(): Pick<
  GitWorkspaceAdapter,
  'validateSource' | 'resolveCommit' | 'inspectLfsObjects'
> {
  return { validateSource, resolveCommit: resolveCommitInRepository, inspectLfsObjects };
}

/** Reports whether `directory` lies in a Git repository; a missing directory does not. */
export async function isGitRepository(directory: string): Promise<boolean> {
  const outcome = await runGit(directory, ['rev-parse', '--git-dir']);
  return outcome.exitCode === 0;
}

function resolveCommitInRepository(
  repository: RepositoryDefinition,
  reference: string,
): Promise<CommitLookup> {
  return resolveCommit(repository.path, reference);
}

/** Reports whether `ancestor` precedes or equals `descendant`; `null` when Git cannot decide. */
async function isAncestor(
  repository: RepositoryDefinition,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  const outcome = await runGit(repository.path, [
    'merge-base',
    '--is-ancestor',
    '--end-of-options',
    ancestor,
    descendant,
  ]);
  if (outcome.exitCode === 0) {
    return true;
  }
  if (outcome.exitCode === 1) {
    return false;
  }
  return null;
}

type ResolvedSourceTree =
  | { ok: true; resolvedCommit: string; pointerEntries: LfsPointerEntry[] }
  | { ok: false; reason: string };

/**
 * Resolves `revision` to one commit and inspects its tree. The failure reason
 * carries the `repository "<id>": ` prefix every source-validation text has.
 */
async function resolveSourceTree(
  repository: RepositoryDefinition,
  revision: string,
): Promise<ResolvedSourceTree> {
  const lookup = await resolveCommit(repository.path, revision);
  if (lookup.kind === 'no-repository') {
    return {
      ok: false,
      reason: `repository "${repository.id}": "${repository.path}" is not a Git repository`,
    };
  }
  if (lookup.kind === 'not-found') {
    return {
      ok: false,
      reason: `repository "${repository.id}": "${revision}" is not readable as exactly one commit in "${repository.path}"`,
    };
  }
  const inspection = await inspectSourceTree(repository.path, lookup.commit);
  if (!inspection.ok) {
    return { ok: false, reason: `repository "${repository.id}": ${inspection.reason}` };
  }
  return {
    ok: true,
    resolvedCommit: lookup.commit,
    pointerEntries: inspection.pointerEntries,
  };
}

async function validateSource(
  repository: RepositoryDefinition,
  commit: string,
): Promise<TevuResult<SourceValidation, 'SourceMaterializationError'>> {
  const resolved = await resolveSourceTree(repository, commit);
  if (!resolved.ok) {
    return sourceError(repository.id, resolved.reason);
  }
  const { resolvedCommit, pointerEntries } = resolved;
  const extensionFailure = extensionReason(repository, pointerEntries);
  if (extensionFailure !== undefined) {
    return sourceError(repository.id, extensionFailure);
  }
  const report = await lfsStorageReport(repository.path, pointerEntries);
  if (!report.ok) {
    return sourceError(repository.id, `repository "${repository.id}": ${report.reason}`);
  }
  if (report.report.missing > 0) {
    return sourceError(
      repository.id,
      missingReason(repository, report.report, resolvedCommit, await probeGitLfs()),
    );
  }
  return {
    ok: true,
    value: { repositoryId: repository.id, requestedCommit: commit, resolvedCommit },
  };
}

async function inspectLfsObjects(
  repository: RepositoryDefinition,
  revision: string,
): Promise<TevuResult<LfsObjectInventory, 'SourceMaterializationError'>> {
  const resolved = await resolveSourceTree(repository, revision);
  if (!resolved.ok) {
    return sourceError(repository.id, resolved.reason);
  }
  const report = await lfsStorageReport(repository.path, resolved.pointerEntries);
  if (!report.ok) {
    return sourceError(repository.id, `repository "${repository.id}": ${report.reason}`);
  }
  return {
    ok: true,
    value: {
      commit: resolved.resolvedCommit,
      objectCount: report.report.needed.length,
      missingCount: report.report.missing,
    },
  };
}

/**
 * Creates the `GitWorkspaceAdapter` implementation over the local Git CLI.
 *
 * `validateSource` reports failures as `SourceMaterializationError` with the
 * repository ID in the `taskId` field because the adapter contract carries no
 * task identity at that boundary; callers that know the task may re-attribute.
 */
export function createGitWorkspaceAdapter(
  options: GitWorkspaceAdapterOptions,
): GitWorkspaceAdapter {
  const { workspacesDirectory } = options;

  return {
    validateSource,
    resolveCommit: resolveCommitInRepository,
    inspectLfsObjects,
    isAncestor,
    readOverlay,
    applyCheckState,
    initializeEmptyRepository,
    diffCommit,

    async createIsolatedCase(
      identity: CaseIdentity,
      repository: RepositoryDefinition,
    ): Promise<TevuResult<CaseWorkspace, 'SourceMaterializationError' | 'IsolationError'>> {
      const lookup = await resolveCommit(repository.path, identity.sourceCommit);
      if (lookup.kind !== 'found') {
        return sourceError(
          identity.taskId,
          `repository "${repository.id}": "${identity.sourceCommit}" is not readable as exactly one commit`,
        );
      }
      const resolvedCommit = lookup.commit;
      const sourceObjects = await runGit(repository.path, [
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'objects',
      ]);
      if (sourceObjects.exitCode !== 0 || sourceObjects.stdout.length === 0) {
        return sourceError(
          identity.taskId,
          `repository "${repository.id}": ${describeGitFailure('rev-parse --git-path objects', sourceObjects)}`,
        );
      }

      return sealCase({
        identity,
        repository,
        resolvedCommit,
        sourceObjectsDirectory: sourceObjects.stdout,
        workspacesDirectory,
      });
    },

    async capturePatch(
      workspace: CaseWorkspace,
      base?: PatchBase,
    ): Promise<TevuResult<PatchArtifact, 'SourceMaterializationError' | 'ArtifactError'>> {
      // A private throwaway index leaves the case repository's own index
      // untouched while `add --all` snapshots the complete worktree state.
      // With a patch base, `GIT_OBJECT_DIRECTORY` reads through its private
      // object directory and the diff target becomes the base's tree, so
      // `before_agent` output the base already holds never appears as added.
      const patchIndexFile = join(workspace.runtimeDirectory, 'patch-index');
      const indexEnvironment = {
        GIT_INDEX_FILE: patchIndexFile,
        ...(base === undefined ? {} : { GIT_OBJECT_DIRECTORY: base.objectDirectory }),
      };
      const diffTarget = base?.tree ?? workspace.syntheticCommit;
      try {
        await rm(patchIndexFile, { force: true });
        const staged = await stageWorktree(
          workspace.worktreeDirectory,
          diffTarget,
          indexEnvironment,
        );
        if (!staged.ok) {
          return artifactError('capture-patch', staged.reason);
        }
        const diff = await runGit(
          workspace.worktreeDirectory,
          ['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', diffTarget],
          { environment: indexEnvironment, keepFinalNewline: true },
        );
        if (diff.exitCode !== 0) {
          return artifactError('capture-patch', describeGitFailure('diff --cached', diff));
        }
        return {
          ok: true,
          value: {
            caseId: workspace.caseId,
            content: diff.stdout,
            isEmpty: diff.stdout.length === 0,
          },
        };
      } finally {
        await rm(patchIndexFile, { force: true }).catch(() => undefined);
      }
    },

    async snapshotPatchBase(
      workspace: CaseWorkspace,
    ): Promise<TevuResult<PatchBase, 'ArtifactError'>> {
      const baseDirectory = join(workspace.runtimeDirectory, 'patch-base');
      try {
        await mkdir(baseDirectory);
      } catch (cause) {
        return artifactError(
          'snapshot-patch-base',
          `patch base directory cannot be created exclusively: ${describeCause(cause)}`,
        );
      }
      const objectDirectory = join(baseDirectory, 'objects');
      try {
        await mkdir(join(objectDirectory, 'info'), { recursive: true });
        await writeFile(
          join(objectDirectory, 'info', 'alternates'),
          `${workspace.repositoryDirectory}/objects\n`,
          'utf8',
        );
      } catch (cause) {
        return artifactError(
          'snapshot-patch-base',
          `patch base object directory cannot be prepared: ${describeCause(cause)}`,
        );
      }
      const indexFile = join(baseDirectory, 'index');
      const environment = { GIT_INDEX_FILE: indexFile, GIT_OBJECT_DIRECTORY: objectDirectory };
      try {
        const staged = await stageWorktree(
          workspace.worktreeDirectory,
          workspace.syntheticCommit,
          environment,
        );
        if (!staged.ok) {
          return artifactError('snapshot-patch-base', staged.reason);
        }
        const written = await runGit(workspace.worktreeDirectory, ['write-tree'], { environment });
        if (written.exitCode !== 0 || written.stdout.length === 0) {
          return artifactError('snapshot-patch-base', describeGitFailure('write-tree', written));
        }
        return { ok: true, value: { tree: written.stdout, objectDirectory } };
      } finally {
        await rm(indexFile, { force: true }).catch(() => undefined);
      }
    },

    async dispose(workspace: CaseWorkspace): Promise<TevuResult<void, 'ArtifactError'>> {
      const caseDirectory = join(workspacesDirectory, workspace.caseId);
      try {
        await rm(caseDirectory, { recursive: true, force: true });
        return { ok: true, value: undefined };
      } catch (cause) {
        return artifactError(
          'dispose-case-workspace',
          `retained ${caseDirectory}: ${describeCause(cause)}`,
        );
      }
    },

    async isReadable(workspace: CaseWorkspace): Promise<boolean> {
      const outcome = await runGit(workspace.worktreeDirectory, [
        'rev-parse',
        '--verify',
        '--quiet',
        'HEAD',
      ]);
      return outcome.exitCode === 0;
    },
  };
}

/**
 * Makes an existing empty directory the top level of a fresh Git repository:
 * no commit, remote, or configuration beyond {@link baseGitEnvironment}'s
 * defaults.
 */
async function initializeEmptyRepository(
  directory: string,
): Promise<TevuResult<void, 'ArtifactError'>> {
  const outcome = await runGit(directory, ['init', '--quiet']);
  if (outcome.exitCode !== 0) {
    return artifactError('initialize-repository', describeGitFailure('init', outcome));
  }
  return { ok: true, value: undefined };
}

/**
 * Diffs `commit` against its first parent: no color, no external diff driver,
 * no binary contents.
 */
async function diffCommit(
  repository: RepositoryDefinition,
  commit: string,
): Promise<TevuResult<string, 'ArtifactError'>> {
  const outcome = await runGit(
    repository.path,
    ['diff', '--no-color', '--no-ext-diff', `${commit}^1`, commit, '--'],
    { keepFinalNewline: true },
  );
  if (outcome.exitCode !== 0) {
    return artifactError('diff-reference-commit', describeGitFailure('diff', outcome));
  }
  return { ok: true, value: outcome.stdout };
}

type SealCaseInput = {
  identity: CaseIdentity;
  repository: RepositoryDefinition;
  resolvedCommit: string;
  sourceObjectsDirectory: string;
  workspacesDirectory: string;
};

/**
 * Materializes one sealed case repository: a private object database holding
 * exactly one synthetic root commit over the pinned tree, with no remote,
 * alternates, extra refs, reflogs, or untracked source files. Objects are
 * borrowed through a temporary alternates link, copied local by `repack`, and
 * the link is removed before the worktree is populated so a missing local
 * object fails loudly instead of leaking source history. Each Git LFS pointer
 * entry of the pinned tree is replaced, in the synthetic tree, by the blob of
 * its object read from the source's own Git LFS storage.
 */
async function sealCase(
  input: SealCaseInput,
): Promise<TevuResult<CaseWorkspace, 'SourceMaterializationError' | 'IsolationError'>> {
  const { identity, repository, resolvedCommit, workspacesDirectory } = input;
  const caseDirectory = join(workspacesDirectory, identity.caseId);
  const repositoryDirectory = join(caseDirectory, 'repo.git');
  const worktreeDirectory = join(caseDirectory, 'worktree');
  const runtimeDirectory = join(caseDirectory, 'runtime');
  const branch = identity.caseId;

  await mkdir(workspacesDirectory, { recursive: true });
  try {
    await mkdir(caseDirectory);
  } catch (cause) {
    return isolationError(
      identity.caseId,
      `case directory cannot be created exclusively: ${describeCause(cause)}`,
    );
  }

  const fail = async (
    reason: string,
  ): Promise<{ ok: false; error: { kind: 'IsolationError'; caseId: string; reason: string } }> => {
    await rm(caseDirectory, { recursive: true, force: true }).catch(() => undefined);
    return isolationError(identity.caseId, reason);
  };
  const failSource = async (
    reason: string,
  ): Promise<{
    ok: false;
    error: { kind: 'SourceMaterializationError'; taskId: string; reason: string };
  }> => {
    await rm(caseDirectory, { recursive: true, force: true }).catch(() => undefined);
    return sourceError(identity.taskId, reason);
  };

  try {
    await mkdir(runtimeDirectory);
  } catch (cause) {
    return fail(`runtime directory cannot be created: ${describeCause(cause)}`);
  }

  const init = await runGit(workspacesDirectory, [
    'init',
    '--quiet',
    `--initial-branch=${branch}`,
    `--separate-git-dir=${repositoryDirectory}`,
    worktreeDirectory,
  ]);
  if (init.exitCode !== 0) {
    return fail(describeGitFailure('init', init));
  }
  for (const [key, value] of [
    ['core.logAllRefUpdates', 'false'],
    ['gc.auto', '0'],
  ] as const) {
    const configured = await runGit(worktreeDirectory, ['config', key, value]);
    if (configured.exitCode !== 0) {
      return fail(describeGitFailure(`config ${key}`, configured));
    }
  }

  const alternatesFile = join(repositoryDirectory, 'objects', 'info', 'alternates');
  try {
    await writeFile(alternatesFile, `${input.sourceObjectsDirectory}\n`, 'utf8');
  } catch (cause) {
    return fail(`temporary alternates link cannot be written: ${describeCause(cause)}`);
  }

  const tree = await runGit(worktreeDirectory, ['rev-parse', `${resolvedCommit}^{tree}`]);
  if (tree.exitCode !== 0 || tree.stdout.length === 0) {
    return fail(describeGitFailure('rev-parse tree', tree));
  }

  const inspection = await inspectSourceTree(repository.path, resolvedCommit);
  if (!inspection.ok) {
    return failSource(`repository "${repository.id}": ${inspection.reason}`);
  }
  const { pointerEntries } = inspection;
  const extensionFailure = extensionReason(repository, pointerEntries);
  if (extensionFailure !== undefined) {
    return failSource(extensionFailure);
  }
  let sealedTree = tree.stdout;
  let materialized = false;
  if (pointerEntries.length > 0) {
    const storage = await lfsStorageReport(repository.path, pointerEntries);
    if (!storage.ok) {
      return failSource(`repository "${repository.id}": ${storage.reason}`);
    }
    if (storage.report.missing > 0) {
      return failSource(
        missingReason(repository, storage.report, resolvedCommit, await probeGitLfs()),
      );
    }
    const materialization = await materializeLfsEntries({
      repository,
      resolvedCommit,
      pointerEntries,
      report: storage.report,
      worktreeDirectory,
    });
    if (!materialization.ok) {
      return materialization.isSourceFailure
        ? failSource(materialization.reason)
        : fail(materialization.reason);
    }
    materialized = materialization.materialized;
    const written = await writeTreeWithEntries(
      worktreeDirectory,
      join(runtimeDirectory, 'materialize-index'),
      tree.stdout,
      materialization.records,
    );
    if (!written.ok) {
      return fail(written.reason);
    }
    sealedTree = written.tree;
  }

  const committed = await runGit(
    worktreeDirectory,
    ['commit-tree', sealedTree, '-m', `tevu sealed case ${identity.caseId}`],
    { environment: SYNTHETIC_COMMIT_IDENTITY },
  );
  if (committed.exitCode !== 0 || committed.stdout.length === 0) {
    return fail(describeGitFailure('commit-tree', committed));
  }
  const syntheticCommit = committed.stdout;

  const branchRef = await runGit(worktreeDirectory, [
    'update-ref',
    `refs/heads/${branch}`,
    syntheticCommit,
  ]);
  if (branchRef.exitCode !== 0) {
    return fail(describeGitFailure('update-ref', branchRef));
  }
  // Streams every blob above 1 MiB and skips the delta search, bounding the
  // memory of the two commands that would otherwise hold whole LFS objects.
  const boundedMemory = materialized ? ['-c', 'core.bigFileThreshold=1m'] : [];
  const repacked = await runGit(worktreeDirectory, [
    ...boundedMemory,
    'repack',
    '-a',
    '-d',
    '--quiet',
  ]);
  if (repacked.exitCode !== 0) {
    return fail(describeGitFailure('repack', repacked));
  }
  try {
    await rm(alternatesFile, { force: true });
    await rm(join(repositoryDirectory, 'logs'), { recursive: true, force: true });
  } catch (cause) {
    return fail(`sealing cleanup failed: ${describeCause(cause)}`);
  }

  const populated = await runGit(worktreeDirectory, [
    ...boundedMemory,
    'reset',
    '--hard',
    '--quiet',
  ]);
  if (populated.exitCode !== 0) {
    return fail(describeGitFailure('reset --hard', populated));
  }
  const checkedTree = await runGit(worktreeDirectory, ['rev-parse', 'HEAD^{tree}']);
  if (checkedTree.exitCode !== 0 || checkedTree.stdout !== sealedTree) {
    return fail('sealed tree does not match the pinned source tree');
  }

  return {
    ok: true,
    value: {
      caseId: identity.caseId,
      sourceRepositoryPath: repository.path,
      sourceCommit: resolvedCommit,
      repositoryDirectory,
      worktreeDirectory,
      runtimeDirectory,
      branch,
      syntheticCommit,
    },
  };
}

type LfsMaterialization =
  | { ok: true; records: string; materialized: boolean }
  | { ok: false; isSourceFailure: boolean; reason: string };

type LfsDigest =
  | { ok: true; sha256: string; byteCount: number; gitBlobId: string }
  | { ok: false; isAbsent: boolean; cause: unknown };

const LFS_READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Reads one object file in fixed-size chunks, keeping none after hashing it,
 * and computes the SHA-256 Git LFS names it by and the blob id Git would give
 * `size` bytes of it.
 */
async function digestLfsObjectFile(file: string, size: number): Promise<LfsDigest> {
  const sha256 = createHash('sha256');
  const gitBlob = createHash('sha1').update(`blob ${size}\0`);
  let byteCount = 0;
  try {
    const handle = await open(file, 'r');
    try {
      const chunk = Buffer.allocUnsafe(LFS_READ_CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) {
          break;
        }
        const filled = chunk.subarray(0, bytesRead);
        sha256.update(filled);
        gitBlob.update(filled);
        byteCount += bytesRead;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (cause) {
    const code = systemErrorCode(cause);
    return { ok: false, isAbsent: code === 'ENOENT' || code === 'ENOTDIR', cause };
  }
  return { ok: true, sha256: sha256.digest('hex'), byteCount, gitBlobId: gitBlob.digest('hex') };
}

/**
 * Verifies each needed object file against its pointer and writes it into the
 * case repository as a blob, then returns the `update-index --index-info`
 * records that put every pointer entry's blob at its path with its mode.
 * Source-reading failures are flagged so the caller reports them as such.
 */
async function materializeLfsEntries(input: {
  repository: RepositoryDefinition;
  resolvedCommit: string;
  pointerEntries: readonly LfsPointerEntry[];
  report: LfsStorageReport;
  worktreeDirectory: string;
}): Promise<LfsMaterialization> {
  const { repository, resolvedCommit, pointerEntries, report, worktreeDirectory } = input;
  const sourceFailure = (reason: string): LfsMaterialization => ({
    ok: false,
    isSourceFailure: true,
    reason,
  });
  const blobIds = new Map<string, string>();
  let emptyBlobId: string | undefined;
  let materialized = false;

  for (const { oid, size } of report.needed) {
    const file = lfsObjectFile(report.objectsDirectory, oid);
    const digest = await digestLfsObjectFile(file, size);
    if (!digest.ok) {
      if (digest.isAbsent) {
        return sourceFailure(
          missingReason(repository, { ...report, missing: 1 }, resolvedCommit, await probeGitLfs()),
        );
      }
      return sourceFailure(`repository "${repository.id}": ${readReason(file, digest.cause)}`);
    }
    if (digest.sha256 !== oid || digest.byteCount !== size) {
      return sourceFailure(mismatchReason(repository, file, resolvedCommit));
    }
    const written = await runGit(worktreeDirectory, [
      '-c',
      'core.bigFileThreshold=1m',
      'hash-object',
      '-w',
      '--no-filters',
      '--',
      file,
    ]);
    if (written.exitCode !== 0 || written.stdout.length === 0) {
      return {
        ok: false,
        isSourceFailure: false,
        reason: describeGitFailure('hash-object', written),
      };
    }
    if (written.stdout !== digest.gitBlobId) {
      return sourceFailure(mismatchReason(repository, file, resolvedCommit));
    }
    blobIds.set(lfsObjectKey(oid, size), written.stdout);
    materialized = true;
  }

  if (pointerEntries.some((entry) => entry.size === 0)) {
    const empty = await runGit(
      worktreeDirectory,
      ['hash-object', '-w', '--no-filters', '--stdin'],
      {
        stdin: '',
      },
    );
    if (empty.exitCode !== 0 || empty.stdout.length === 0) {
      return {
        ok: false,
        isSourceFailure: false,
        reason: describeGitFailure('hash-object', empty),
      };
    }
    emptyBlobId = empty.stdout;
  }

  let records = '';
  for (const entry of pointerEntries) {
    const blobId =
      entry.size === 0 ? emptyBlobId : blobIds.get(lfsObjectKey(entry.oid, entry.size));
    if (blobId === undefined) {
      return { ok: false, isSourceFailure: false, reason: 'materialized blob is missing' };
    }
    records += `${entry.mode} ${blobId}\t${entry.path}\0`;
  }
  return { ok: true, records, materialized };
}

/**
 * Writes the tree `tree` with the given `--index-info` records applied,
 * through a private index file removed on every exit path.
 */
async function writeTreeWithEntries(
  worktreeDirectory: string,
  indexFile: string,
  tree: string,
  records: string,
): Promise<{ ok: true; tree: string } | { ok: false; reason: string }> {
  const environment = { GIT_INDEX_FILE: indexFile };
  try {
    const read = await runGit(worktreeDirectory, ['read-tree', tree], { environment });
    if (read.exitCode !== 0) {
      return { ok: false, reason: describeGitFailure('read-tree', read) };
    }
    const updated = await runGit(worktreeDirectory, ['update-index', '-z', '--index-info'], {
      environment,
      stdin: records,
    });
    if (updated.exitCode !== 0) {
      return { ok: false, reason: describeGitFailure('update-index --index-info', updated) };
    }
    const written = await runGit(worktreeDirectory, ['write-tree'], { environment });
    if (written.exitCode !== 0 || written.stdout.length === 0) {
      return { ok: false, reason: describeGitFailure('write-tree', written) };
    }
    return { ok: true, tree: written.stdout };
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/** One tree entry whose whole blob is a Git LFS pointer. */
type LfsPointerEntry = {
  path: string;
  mode: '100644' | '100755';
  /** 64 lowercase hexadecimal characters from the `oid sha256:` line. */
  oid: string;
  size: number;
  /** The pointer holds at least one `ext-` line. */
  usesExtensions: boolean;
};

type TreeInspection =
  { ok: true; pointerEntries: LfsPointerEntry[] } | { ok: false; reason: string };

type RegularFileBlob = { mode: LfsPointerEntry['mode']; blobId: string };

// `$` without the multiline flag matches only at the end of the input, so a
// second trailing LF fails the match.
const LFS_POINTER_PATTERN = new RegExp(
  `^${LFS_POINTER_VERSION_LINE.replaceAll('.', String.raw`\.`)}\n` +
    String.raw`(?:ext-\d-[A-Za-z0-9_.-]+ sha256:[0-9a-f]{64}\n)*` +
    String.raw`oid sha256:[0-9a-f]{64}\n` +
    String.raw`size \d+\n$`,
);
const LFS_POINTER_FIELDS_PATTERN = /^oid sha256:([0-9a-f]{64})\nsize (\d+)\n/m;

/** Reports whether the whole blob text is a Git LFS pointer in the one encoding git-lfs writes. */
function isLfsPointerText(content: string): boolean {
  return LFS_POINTER_PATTERN.test(content);
}

function isRegularFileMode(mode: string): mode is LfsPointerEntry['mode'] {
  return REGULAR_FILE_MODES.has(mode);
}

/** Reads the object id, size, and extension use out of text {@link isLfsPointerText} accepted. */
function parseLfsPointer(
  content: string,
): Pick<LfsPointerEntry, 'oid' | 'size' | 'usesExtensions'> | undefined {
  const fields = LFS_POINTER_FIELDS_PATTERN.exec(content);
  const oid = fields?.[1];
  const sizeText = fields?.[2];
  if (oid === undefined || sizeText === undefined) {
    return undefined;
  }
  return { oid, size: Number(sizeText), usesExtensions: content.includes('\next-') };
}

type LfsPointerScan =
  { ok: true; pointerEntries: LfsPointerEntry[] } | { ok: false; reason: string };

/**
 * Lists the regular-file entries of `commit` whose whole blob is a Git LFS
 * pointer, sorted by path. `git grep` only nominates candidates; the blob
 * bytes decide, and only blobs under the pointer size limit are ever read.
 */
async function listLfsPointerEntries(
  repositoryPath: string,
  commit: string,
  regularFileBlobs: ReadonlyMap<string, RegularFileBlob>,
): Promise<LfsPointerScan> {
  // No `-I`: attributes Git reads outside the pinned tree would otherwise
  // decide which blobs are searched.
  const grep = await runGit(repositoryPath, [
    'grep',
    '-z',
    '--no-color',
    '--no-full-name',
    '--name-only',
    '--fixed-strings',
    '-e',
    LFS_POINTER_VERSION_LINE,
    commit,
  ]);
  if (grep.exitCode === 1) {
    return { ok: true, pointerEntries: [] };
  }
  const grepFailure = { ok: false, reason: describeGitFailure('grep', grep) } as const;
  if (grep.exitCode !== 0) {
    return grepFailure;
  }
  const entries = splitNulSeparated(grep.stdout);
  if (entries.length === 0) {
    return grepFailure;
  }

  const prefix = `${commit}:`;
  const candidates: Array<{ path: string } & RegularFileBlob> = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      return grepFailure;
    }
    const path = entry.slice(prefix.length);
    const blob = regularFileBlobs.get(path);
    if (blob === undefined) {
      return grepFailure;
    }
    candidates.push({ path, ...blob });
  }
  const distinctBlobIds = [...new Set(candidates.map((candidate) => candidate.blobId))];

  const sizes = await runGit(repositoryPath, ['cat-file', '--batch-check'], {
    stdin: `${distinctBlobIds.join('\n')}\n`,
  });
  const sizesFailure = {
    ok: false,
    reason: describeGitFailure('cat-file --batch-check', sizes),
  } as const;
  if (sizes.exitCode !== 0) {
    return sizesFailure;
  }
  const lines = sizes.stdout.split('\n');
  if (lines.length !== distinctBlobIds.length) {
    return sizesFailure;
  }

  const pointerBlobs = new Map<string, NonNullable<ReturnType<typeof parseLfsPointer>>>();
  for (const [index, blobId] of distinctBlobIds.entries()) {
    const line = lines[index];
    const linePrefix = `${blobId} blob `;
    if (line === undefined || !line.startsWith(linePrefix)) {
      return sizesFailure;
    }
    const sizeText = line.slice(linePrefix.length);
    if (!/^\d+$/.test(sizeText)) {
      return sizesFailure;
    }
    if (Number(sizeText) >= LFS_POINTER_SIZE_LIMIT) {
      continue;
    }
    const blob = await runGit(repositoryPath, ['cat-file', 'blob', blobId], {
      keepFinalNewline: true,
    });
    if (blob.exitCode !== 0) {
      return { ok: false, reason: describeGitFailure('cat-file blob', blob) };
    }
    if (!isLfsPointerText(blob.stdout)) {
      continue;
    }
    const pointer = parseLfsPointer(blob.stdout);
    if (pointer === undefined) {
      return { ok: false, reason: describeGitFailure('cat-file blob', blob) };
    }
    pointerBlobs.set(blobId, pointer);
  }

  const pointerEntries: LfsPointerEntry[] = [];
  for (const candidate of candidates) {
    const pointer = pointerBlobs.get(candidate.blobId);
    if (pointer !== undefined) {
      pointerEntries.push({ path: candidate.path, mode: candidate.mode, ...pointer });
    }
  }
  return {
    ok: true,
    pointerEntries: pointerEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/**
 * Inspects the pinned tree for unsupported submodule (gitlink) entries and
 * lists its Git LFS pointer entries. Reasons carry counts only; source
 * filenames never enter error messages.
 */
async function inspectSourceTree(repositoryPath: string, commit: string): Promise<TreeInspection> {
  const listed = await runGit(repositoryPath, ['ls-tree', '-r', '-z', commit]);
  if (listed.exitCode !== 0) {
    return { ok: false, reason: describeGitFailure('ls-tree', listed) };
  }
  let submoduleCount = 0;
  const regularFileBlobs = new Map<string, RegularFileBlob>();
  for (const entry of listed.stdout.split('\0')) {
    if (entry.length === 0) {
      continue;
    }
    const tabIndex = entry.indexOf('\t');
    const [mode, , objectId] = entry.slice(0, tabIndex).split(' ');
    const path = entry.slice(tabIndex + 1);
    if (mode === SUBMODULE_MODE) {
      submoduleCount += 1;
    }
    if (mode !== undefined && objectId !== undefined && isRegularFileMode(mode)) {
      regularFileBlobs.set(path, { mode, blobId: objectId });
    }
  }
  if (submoduleCount > 0) {
    return {
      ok: false,
      reason: `source tree contains ${submoduleCount} unsupported submodule entr${submoduleCount === 1 ? 'y' : 'ies'}`,
    };
  }

  const scan = await listLfsPointerEntries(repositoryPath, commit, regularFileBlobs);
  if (!scan.ok) {
    return { ok: false, reason: scan.reason };
  }
  return { ok: true, pointerEntries: scan.pointerEntries };
}

/** Where a repository's Git LFS objects are, and how many of the ones a tree needs are absent. */
type LfsStorageReport = {
  /** Absolute. */
  objectsDirectory: string;
  /** Distinct (oid, size) pairs, sorted by oid, then size. */
  needed: ReadonlyArray<{ oid: string; size: number }>;
  missing: number;
};

type LfsStorageOutcome = { ok: true; report: LfsStorageReport } | { ok: false; reason: string };

/**
 * Reads the Git LFS storage of `repositoryPath` without writing to it and
 * counts how many objects the pointer entries need that it lacks. The failure
 * reason carries no repository prefix.
 */
async function lfsStorageReport(
  repositoryPath: string,
  pointerEntries: readonly LfsPointerEntry[],
): Promise<LfsStorageOutcome> {
  const needed = neededLfsObjects(pointerEntries);
  const configured = await runGit(repositoryPath, [
    'config',
    '--type=path',
    '--get',
    'lfs.storage',
  ]);
  if (configured.exitCode !== 0 && configured.exitCode !== 1) {
    return { ok: false, reason: describeGitFailure('config lfs.storage', configured) };
  }
  const common = await runGit(repositoryPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (common.exitCode !== 0 || common.stdout.length === 0) {
    return { ok: false, reason: describeGitFailure('rev-parse --git-common-dir', common) };
  }
  const configuredStorage = configured.exitCode === 0 ? configured.stdout : '';
  const storage = isAbsolute(configuredStorage)
    ? configuredStorage
    : join(common.stdout, configuredStorage.length > 0 ? configuredStorage : 'lfs');
  const objectsDirectory = join(storage, 'objects');

  let missing = 0;
  for (const { oid, size } of needed) {
    const file = lfsObjectFile(objectsDirectory, oid);
    try {
      const entryStat = await stat(file);
      if (!entryStat.isFile() || !Number.isSafeInteger(size) || entryStat.size !== size) {
        missing += 1;
      }
    } catch (cause) {
      const code = systemErrorCode(cause);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        missing += 1;
        continue;
      }
      return { ok: false, reason: readReason(file, cause) };
    }
  }
  return { ok: true, report: { objectsDirectory, needed, missing } };
}

/** Distinct (oid, size) pairs of pointer entries that use no extension and have a nonzero size. */
function neededLfsObjects(
  pointerEntries: readonly LfsPointerEntry[],
): Array<{ oid: string; size: number }> {
  const distinct = new Map<string, { oid: string; size: number }>();
  for (const { oid, size, usesExtensions } of pointerEntries) {
    if (!usesExtensions && size > 0) {
      distinct.set(lfsObjectKey(oid, size), { oid, size });
    }
  }
  return [...distinct.values()].sort((a, b) =>
    a.oid === b.oid ? a.size - b.size : a.oid < b.oid ? -1 : 1,
  );
}

function lfsObjectKey(oid: string, size: number): string {
  return `${oid}:${size}`;
}

function lfsObjectFile(objectsDirectory: string, oid: string): string {
  return join(objectsDirectory, oid.slice(0, 2), oid.slice(2, 4), oid);
}

/** Reports whether `git lfs version` succeeds; runs outside every repository so it cannot write to one. */
async function probeGitLfs(): Promise<boolean> {
  const outcome = await runGit(tmpdir(), ['lfs', 'version']);
  return outcome.exitCode === 0 && outcome.stdout.startsWith('git-lfs/');
}

/** The extension failure text, or `undefined` when no pointer entry uses Git LFS extensions. */
function extensionReason(
  repository: RepositoryDefinition,
  pointerEntries: readonly LfsPointerEntry[],
): string | undefined {
  const count = pointerEntries.filter((entry) => entry.usesExtensions).length;
  if (count === 0) {
    return undefined;
  }
  const subject =
    count === 1
      ? '1 Git LFS pointer entry that uses Git LFS extensions; tevu cannot rebuild its content'
      : `${count} Git LFS pointer entries that use Git LFS extensions; tevu cannot rebuild their content`;
  return `repository "${repository.id}": source tree contains ${subject}`;
}

function missingReason(
  repository: RepositoryDefinition,
  report: LfsStorageReport,
  resolvedCommit: string,
  isInstalled: boolean,
): string {
  const counts = `${report.missing} of ${report.needed.length}`;
  const installHint = isInstalled
    ? ''
    : 'Git LFS is not installed or not on PATH: install it from https://git-lfs.com, then ';
  const nextStep =
    repository.github === undefined
      ? `fetch them in "${repository.path}"${isInstalled ? ' first' : ''}, for example: git lfs fetch -I "" -X "" origin ${resolvedCommit}`
      : `tevu run --dry-run fetches them from ${githubDisplay(repository.github)}`;
  return `repository "${repository.id}": Git LFS objects not in "${report.objectsDirectory}": ${counts}; ${installHint}${nextStep}`;
}

function mismatchReason(
  repository: RepositoryDefinition,
  file: string,
  resolvedCommit: string,
): string {
  const nextStep =
    repository.github === undefined
      ? `fetch it again in "${repository.path}", for example: git lfs fetch -I "" -X "" origin ${resolvedCommit}`
      : `tevu run --dry-run fetches it again from ${githubDisplay(repository.github)}`;
  return `repository "${repository.id}": Git LFS object file "${file}" does not match its pointer; delete the file, then ${nextStep}`;
}

function readReason(file: string, cause: unknown): string {
  return `Git LFS object file "${file}" cannot be read: ${describeCause(cause)}`;
}

function githubDisplay(github: string): string {
  const parsed = parseGitHubRepository(github);
  return parsed === null ? github : formatGitHubRepository(parsed);
}

/**
 * Resolves a revision to exactly one full commit hash, distinguishing a
 * repository that does not hold the revision from a path that is not a Git
 * repository at all.
 */
async function resolveCommit(repositoryPath: string, reference: string): Promise<CommitLookup> {
  const outcome = await runGit(repositoryPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${reference}^{commit}`,
  ]);
  if (outcome.exitCode === 0 && COMMIT_HASH_PATTERN.test(outcome.stdout)) {
    return { kind: 'found', commit: outcome.stdout };
  }
  if (outcome.exitCode === 1) {
    return { kind: 'not-found' };
  }
  const gitDir = await runGit(repositoryPath, ['rev-parse', '--git-dir']);
  return gitDir.exitCode === 0 ? { kind: 'not-found' } : { kind: 'no-repository' };
}

type GitCommandOutcome = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type RunGitOptions = {
  environment?: Record<string, string>;
  keepFinalNewline?: boolean;
  /** Standard input for a command reading paths from stdin, e.g. `checkout-index --stdin`. */
  stdin?: string;
};

async function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitCommandOutcome> {
  const result = await execa('git', [...args], {
    cwd,
    env: { ...baseGitEnvironment(), ...options.environment },
    extendEnv: false,
    ...(options.stdin === undefined ? { stdin: 'ignore' } : { input: options.stdin }),
    reject: false,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    stripFinalNewline: options.keepFinalNewline !== true,
  });
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

/**
 * Explicit replacement environment for every Git command: user and system
 * configuration reads are disabled, prompts and optional locks are off so
 * source repositories stay byte-for-byte untouched, and output is stable
 * under a fixed locale. `HOME` passes through only for version-manager shims.
 */
function baseGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    ...ISOLATED_GIT_SETTINGS,
  };
  const home = process.env.HOME;
  if (home !== undefined) {
    environment.HOME = home;
  }
  return environment;
}

/** Sanitized failure description: subcommand and exit evidence, never source filenames. */
function describeGitFailure(subcommand: string, outcome: GitCommandOutcome): string {
  if (outcome.exitCode === null) {
    return `git ${subcommand} could not be started`;
  }
  return `git ${subcommand} exited with code ${outcome.exitCode}`;
}

/** Which check-state step a failure belongs to. */
type CheckStateStep = 'restore' | 'overlay';

/** A regular file's bytes and owner-executable bit, or a symbolic link's target; restore and overlay share `place`. */
type Source =
  { kind: 'file'; bytes: Uint8Array; executable: boolean } | { kind: 'symlink'; target: string };

function checkStateFailure(
  step: CheckStateStep,
  reason: string,
): { ok: false; error: { kind: 'CheckStateError'; step: CheckStateStep; reason: string } } {
  return { ok: false, error: { kind: 'CheckStateError', step, reason } };
}

/** Node.js system error code of a thrown value, or `null` when it carries none. */
function systemErrorCode(cause: unknown): string | null {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof (cause as { code: unknown }).code === 'string'
  ) {
    return (cause as { code: string }).code;
  }
  return null;
}

/** Ascending, duplicate-free path list, per the `CheckStateRecord` contract. */
function sortedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

/** Splits a `git ... -z` NUL-terminated byte stream into its worktree-relative paths. */
function splitNulSeparated(text: string): string[] {
  return text.split('\0').filter((entry) => entry.length > 0);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Deletes one worktree entry recursively without following a symbolic link at
 * or beneath it, returning every non-directory path it removed.
 */
async function deleteEntry(
  step: CheckStateStep,
  worktreeDirectory: string,
  relativePath: string,
): Promise<TevuResult<string[], 'CheckStateError'>> {
  const listed = await listNonDirectoryEntries(step, worktreeDirectory, relativePath);
  if (!listed.ok) {
    return listed;
  }
  try {
    await rm(join(worktreeDirectory, relativePath), { recursive: true });
    return { ok: true, value: listed.value };
  } catch (cause) {
    return checkStateFailure(step, `delete failed for "${relativePath}": ${describeCause(cause)}`);
  }
}

/**
 * Lists every non-directory entry at or beneath one worktree path via an
 * `lstat` walk that never follows a symbolic link.
 */
async function listNonDirectoryEntries(
  step: CheckStateStep,
  worktreeDirectory: string,
  relativePath: string,
): Promise<TevuResult<string[], 'CheckStateError'>> {
  const absolutePath = join(worktreeDirectory, relativePath);
  let entryStat: Stats;
  try {
    entryStat = await lstat(absolutePath);
  } catch (cause) {
    return checkStateFailure(step, `read failed for "${relativePath}": ${describeCause(cause)}`);
  }
  if (!entryStat.isDirectory()) {
    return { ok: true, value: [relativePath] };
  }
  let names: string[];
  try {
    names = await readdir(absolutePath);
  } catch (cause) {
    return checkStateFailure(step, `read failed for "${relativePath}": ${describeCause(cause)}`);
  }
  const collected: string[] = [];
  for (const name of names) {
    const childRelative = relativePath.length === 0 ? name : `${relativePath}/${name}`;
    const nested = await listNonDirectoryEntries(step, worktreeDirectory, childRelative);
    if (!nested.ok) {
      return nested;
    }
    collected.push(...nested.value);
  }
  return { ok: true, value: collected };
}

/** `lstat`s one worktree path, returning `null` in place of an `ENOENT` failure. */
async function lstatOrNull(
  step: CheckStateStep,
  absolutePath: string,
  relativePath: string,
): Promise<TevuResult<Stats | null, 'CheckStateError'>> {
  try {
    return { ok: true, value: await lstat(absolutePath) };
  } catch (cause) {
    if (systemErrorCode(cause) === 'ENOENT') {
      return { ok: true, value: null };
    }
    return checkStateFailure(step, `read failed for "${relativePath}": ${describeCause(cause)}`);
  }
}

type WorktreeEntryProbe = { ok: true; isStageable: boolean } | { ok: false; reason: string };

/**
 * Reports whether `update-index` can record a worktree-relative path as it
 * stands: every leading segment is a real directory and the last segment is a
 * regular file or a symbolic link. Walks with `lstat`, one call at a time, so
 * no symbolic link is followed and no file content is read.
 */
async function probeStageableEntry(
  worktreeDirectory: string,
  relativePath: string,
): Promise<WorktreeEntryProbe> {
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { ok: true, isStageable: false };
  }
  for (let depth = 1; depth <= segments.length; depth += 1) {
    let stats: Stats;
    try {
      stats = await lstat(join(worktreeDirectory, ...segments.slice(0, depth)));
    } catch (cause) {
      const code = systemErrorCode(cause);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { ok: true, isStageable: false };
      }
      return {
        ok: false,
        reason: `worktree entry cannot be inspected: ${code ?? 'unknown error'}`,
      };
    }
    if (depth === segments.length) {
      return { ok: true, isStageable: stats.isFile() || stats.isSymbolicLink() };
    }
    if (!stats.isDirectory()) {
      return { ok: true, isStageable: false };
    }
  }
  return { ok: true, isStageable: false };
}

type StagingOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Stages the complete worktree state into the private index that
 * `environment` selects, seeded from `tree`. The seed makes `add --all` record
 * only changes against the diff target, and `add --all` runs with
 * `core.sparseCheckout=false` because the case repository's configuration is
 * agent-writable and a sparse checkout enabled there makes `add --all` skip
 * changed tracked paths without an error.
 *
 * `add --all` applies ignore rules to every path missing from the index it
 * stages into, so a path the case index tracks but `tree` lacks, such as a
 * force-added ignored file, is recorded with `update-index` first. `--replace`
 * is safe there because only paths whose shape matches the worktree are
 * admitted, so the entry it displaces is one `add --all` would remove anyway.
 * The case index is only read, never written. Both patch capture and the patch
 * base stage through this helper so they judge the worktree by the same rules.
 */
async function stageWorktree(
  worktreeDirectory: string,
  tree: string,
  environment: Record<string, string>,
): Promise<StagingOutcome> {
  const seeded = await runGit(worktreeDirectory, ['read-tree', tree], { environment });
  if (seeded.exitCode !== 0) {
    return { ok: false, reason: describeGitFailure('read-tree', seeded) };
  }
  const listed = await runGit(worktreeDirectory, ['ls-files', '-z'], { keepFinalNewline: true });
  if (listed.exitCode !== 0) {
    return { ok: false, reason: describeGitFailure('ls-files', listed) };
  }
  const inTree = await runGit(worktreeDirectory, ['ls-tree', '-r', '-z', '--name-only', tree], {
    environment,
    keepFinalNewline: true,
  });
  if (inTree.exitCode !== 0) {
    return { ok: false, reason: describeGitFailure('ls-tree', inTree) };
  }
  const treePaths = new Set(splitNulSeparated(inTree.stdout));
  const stageable: string[] = [];
  for (const path of new Set(splitNulSeparated(listed.stdout))) {
    if (treePaths.has(path)) {
      continue;
    }
    const probe = await probeStageableEntry(worktreeDirectory, path);
    if (!probe.ok) {
      return probe;
    }
    if (probe.isStageable) {
      stageable.push(path);
    }
  }
  if (stageable.length > 0) {
    const added = await runGit(
      worktreeDirectory,
      ['update-index', '--add', '--replace', '-z', '--stdin'],
      { environment, stdin: stageable.map((path) => `${path}\0`).join('') },
    );
    if (added.exitCode !== 0) {
      return { ok: false, reason: describeGitFailure('update-index --add', added) };
    }
  }
  const staged = await runGit(
    worktreeDirectory,
    ['-c', 'core.sparseCheckout=false', 'add', '--all'],
    { environment },
  );
  if (staged.exitCode !== 0) {
    return { ok: false, reason: describeGitFailure('add --all', staged) };
  }
  return { ok: true };
}

async function tryMkdir(
  step: CheckStateStep,
  absolutePath: string,
  relativePath: string,
): Promise<TevuResult<void, 'CheckStateError'>> {
  try {
    await mkdir(absolutePath);
    return { ok: true, value: undefined };
  } catch (cause) {
    return checkStateFailure(step, `create failed for "${relativePath}": ${describeCause(cause)}`);
  }
}

async function tryUnlink(
  step: CheckStateStep,
  absolutePath: string,
  relativePath: string,
): Promise<TevuResult<void, 'CheckStateError'>> {
  try {
    await unlink(absolutePath);
    return { ok: true, value: undefined };
  } catch (cause) {
    return checkStateFailure(step, `delete failed for "${relativePath}": ${describeCause(cause)}`);
  }
}

async function trySymlink(
  step: CheckStateStep,
  target: string,
  absolutePath: string,
  relativePath: string,
): Promise<TevuResult<void, 'CheckStateError'>> {
  try {
    await symlink(target, absolutePath);
    return { ok: true, value: undefined };
  } catch (cause) {
    return checkStateFailure(step, `create failed for "${relativePath}": ${describeCause(cause)}`);
  }
}

/** Creates one file exclusively (`O_CREAT | O_EXCL`) at the given mode, then writes its bytes. */
async function tryCreateFile(
  step: CheckStateStep,
  absolutePath: string,
  relativePath: string,
  bytes: Uint8Array,
  mode: number,
): Promise<TevuResult<void, 'CheckStateError'>> {
  let handle;
  try {
    handle = await open(absolutePath, 'wx', mode);
  } catch (cause) {
    return checkStateFailure(step, `create failed for "${relativePath}": ${describeCause(cause)}`);
  }
  try {
    await handle.writeFile(bytes);
    return { ok: true, value: undefined };
  } catch (cause) {
    return checkStateFailure(step, `write failed for "${relativePath}": ${describeCause(cause)}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Ensures every leading directory of a worktree path is a real directory,
 * replacing a non-directory blocker along the way; shared by `place` (parent
 * directories only) and `placeDirectory` (every component, the last included).
 */
async function ensureDirectories(
  step: CheckStateStep,
  worktreeDirectory: string,
  segments: readonly string[],
): Promise<TevuResult<string[], 'CheckStateError'>> {
  const deleted: string[] = [];
  const accumulated: string[] = [];
  for (const segment of segments) {
    accumulated.push(segment);
    const relativeDir = accumulated.join('/');
    const absoluteDir = join(worktreeDirectory, relativeDir);
    const probe = await lstatOrNull(step, absoluteDir, relativeDir);
    if (!probe.ok) {
      return probe;
    }
    if (probe.value === null) {
      const created = await tryMkdir(step, absoluteDir, relativeDir);
      if (!created.ok) {
        return created;
      }
    } else if (!probe.value.isDirectory()) {
      const removed = await deleteEntry(step, worktreeDirectory, relativeDir);
      if (!removed.ok) {
        return removed;
      }
      deleted.push(...removed.value);
      const created = await tryMkdir(step, absoluteDir, relativeDir);
      if (!created.ok) {
        return created;
      }
    }
  }
  return { ok: true, value: deleted };
}

/**
 * Writes one path inside the worktree from a restore or overlay source:
 * ensures every leading directory, replaces whatever entry sits at the final
 * path, and creates the path exclusively so nothing is ever written through a
 * symbolic link. Returns every path it deleted to make room.
 */
async function place(
  step: CheckStateStep,
  worktreeDirectory: string,
  relativePath: string,
  source: Source,
): Promise<TevuResult<string[], 'CheckStateError'>> {
  const segments = relativePath.split('/');
  const parents = await ensureDirectories(step, worktreeDirectory, segments.slice(0, -1));
  if (!parents.ok) {
    return parents;
  }
  const deleted = [...parents.value];
  const absolutePath = join(worktreeDirectory, relativePath);
  const probe = await lstatOrNull(step, absolutePath, relativePath);
  if (!probe.ok) {
    return probe;
  }
  if (probe.value !== null) {
    if (probe.value.isDirectory()) {
      const removed = await deleteEntry(step, worktreeDirectory, relativePath);
      if (!removed.ok) {
        return removed;
      }
      deleted.push(...removed.value);
    } else {
      const unlinked = await tryUnlink(step, absolutePath, relativePath);
      if (!unlinked.ok) {
        return unlinked;
      }
    }
  }
  if (source.kind === 'symlink') {
    const linked = await trySymlink(step, source.target, absolutePath, relativePath);
    if (!linked.ok) {
      return linked;
    }
  } else {
    const mode = source.executable ? 0o777 : 0o666;
    const written = await tryCreateFile(step, absolutePath, relativePath, source.bytes, mode);
    if (!written.ok) {
      return written;
    }
  }
  return { ok: true, value: deleted };
}

/** Ensures one worktree directory exists, replacing a non-directory blocker at any leading component. */
async function placeDirectory(
  step: CheckStateStep,
  worktreeDirectory: string,
  relativePath: string,
): Promise<TevuResult<string[], 'CheckStateError'>> {
  return ensureDirectories(step, worktreeDirectory, relativePath.split('/'));
}

/** Reads one path's bytes and owner-executable bit, or its link target, as a restore `Source`. */
async function readSource(
  step: CheckStateStep,
  absolutePath: string,
  relativePath: string,
): Promise<TevuResult<Source, 'CheckStateError'>> {
  let entryStat: Stats;
  try {
    entryStat = await lstat(absolutePath);
  } catch (cause) {
    return checkStateFailure(step, `read failed for "${relativePath}": ${describeCause(cause)}`);
  }
  if (entryStat.isSymbolicLink()) {
    try {
      return { ok: true, value: { kind: 'symlink', target: await readlink(absolutePath) } };
    } catch (cause) {
      return checkStateFailure(step, `read failed for "${relativePath}": ${describeCause(cause)}`);
    }
  }
  try {
    const bytes = await readFile(absolutePath);
    return { ok: true, value: { kind: 'file', bytes, executable: (entryStat.mode & 0o100) !== 0 } };
  } catch (cause) {
    return checkStateFailure(step, `read failed for "${relativePath}": ${describeCause(cause)}`);
  }
}

/**
 * Reports whether a worktree path already holds the same entry as the base
 * tree's checked-out copy: every leading directory is a real directory, the
 * entry has the same type, and a regular file's owner-executable bit and
 * bytes match, or a symbolic link's target matches.
 */
async function sameEntry(
  expectedPath: string,
  worktreeDirectory: string,
  relativePath: string,
): Promise<boolean> {
  const segments = relativePath.split('/');
  const leadingDirs: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    leadingDirs.push(segment);
    try {
      const dirStat = await lstat(join(worktreeDirectory, leadingDirs.join('/')));
      if (!dirStat.isDirectory()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  let worktreeStat: Stats;
  let expectedStat: Stats;
  try {
    worktreeStat = await lstat(join(worktreeDirectory, relativePath));
    expectedStat = await lstat(expectedPath);
  } catch {
    return false;
  }
  if (expectedStat.isSymbolicLink()) {
    if (!worktreeStat.isSymbolicLink()) {
      return false;
    }
    try {
      const [expectedTarget, worktreeTarget] = await Promise.all([
        readlink(expectedPath),
        readlink(join(worktreeDirectory, relativePath)),
      ]);
      return expectedTarget === worktreeTarget;
    } catch {
      return false;
    }
  }
  if (!expectedStat.isFile() || !worktreeStat.isFile()) {
    return false;
  }
  if ((expectedStat.mode & 0o100) !== (worktreeStat.mode & 0o100)) {
    return false;
  }
  try {
    const [expectedBytes, worktreeBytes] = await Promise.all([
      readFile(expectedPath),
      readFile(join(worktreeDirectory, relativePath)),
    ]);
    return expectedBytes.equals(worktreeBytes);
  } catch {
    return false;
  }
}

/**
 * Resets every path matching `patterns` to `workspace.syntheticCommit`'s tree
 * and removes every untracked path the same patterns match, using a private
 * index and a scratch checkout so agent-controlled filters, attributes, and
 * autocrlf never reach the restored bytes.
 */
async function restoreStep(
  workspace: CaseWorkspace,
  patterns: readonly string[],
): Promise<TevuResult<RestoreRecord, 'CheckStateError'>> {
  const step: CheckStateStep = 'restore';
  let privateDirectory: string;
  try {
    privateDirectory = await mkdtemp(join(workspace.runtimeDirectory, 'check-state-'));
  } catch (cause) {
    return checkStateFailure(
      step,
      `create failed for a private restore directory: ${describeCause(cause)}`,
    );
  }
  const cleanup = (): Promise<void> =>
    rm(privateDirectory, { recursive: true, force: true }).catch(() => undefined);

  const privateGitDirectory = join(privateDirectory, 'git');
  const initialized = await runGit(privateDirectory, [
    'init',
    '--bare',
    '--quiet',
    privateGitDirectory,
  ]);
  if (initialized.exitCode !== 0) {
    await cleanup();
    return checkStateFailure(step, describeGitFailure('init --bare', initialized));
  }
  try {
    await writeFile(
      join(privateGitDirectory, 'objects', 'info', 'alternates'),
      `${workspace.repositoryDirectory}/objects\n`,
      'utf8',
    );
  } catch (cause) {
    await cleanup();
    return checkStateFailure(
      step,
      `create failed for a private alternates file: ${describeCause(cause)}`,
    );
  }

  const privateEnvironment = {
    GIT_DIR: privateGitDirectory,
    GIT_INDEX_FILE: join(privateGitDirectory, 'index'),
  };
  const pathspecs = patterns.map((pattern) => `:(glob)${pattern}`);

  const read = await runGit(privateDirectory, ['read-tree', workspace.syntheticCommit], {
    environment: privateEnvironment,
  });
  if (read.exitCode !== 0) {
    await cleanup();
    return checkStateFailure(step, describeGitFailure('read-tree', read));
  }

  const worktreeEnvironment = { ...privateEnvironment, GIT_WORK_TREE: workspace.worktreeDirectory };
  const cached = await runGit(
    workspace.worktreeDirectory,
    ['ls-files', '-z', '--cached', '--', ...pathspecs],
    { environment: worktreeEnvironment, keepFinalNewline: true },
  );
  if (cached.exitCode !== 0) {
    await cleanup();
    return checkStateFailure(step, describeGitFailure('ls-files --cached', cached));
  }
  const others = await runGit(
    workspace.worktreeDirectory,
    ['ls-files', '-z', '--others', '--', ...pathspecs],
    { environment: worktreeEnvironment, keepFinalNewline: true },
  );
  if (others.exitCode !== 0) {
    await cleanup();
    return checkStateFailure(step, describeGitFailure('ls-files --others', others));
  }
  const matched = splitNulSeparated(cached.stdout);
  const untracked = splitNulSeparated(others.stdout);

  const baseDirectory = join(privateDirectory, 'base');
  try {
    await mkdir(baseDirectory);
  } catch (cause) {
    await cleanup();
    return checkStateFailure(
      step,
      `create failed for a private base directory: ${describeCause(cause)}`,
    );
  }
  const checkedOut = await runGit(baseDirectory, ['checkout-index', '-f', '-z', '--stdin'], {
    environment: { ...privateEnvironment, GIT_WORK_TREE: baseDirectory },
    stdin: matched.map((path) => `${path}\0`).join(''),
  });
  if (checkedOut.exitCode !== 0) {
    await cleanup();
    return checkStateFailure(step, describeGitFailure('checkout-index', checkedOut));
  }

  const removed: string[] = [];
  for (const entry of untracked) {
    const relative = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const deleted = await deleteEntry(step, workspace.worktreeDirectory, relative);
    if (!deleted.ok) {
      await cleanup();
      return deleted;
    }
    removed.push(...deleted.value);
  }

  const restored: string[] = [];
  for (const path of matched) {
    const expectedPath = join(baseDirectory, path);
    if (await sameEntry(expectedPath, workspace.worktreeDirectory, path)) {
      continue;
    }
    const source = await readSource(step, expectedPath, path);
    if (!source.ok) {
      await cleanup();
      return source;
    }
    const placed = await place(step, workspace.worktreeDirectory, path, source.value);
    if (!placed.ok) {
      await cleanup();
      return placed;
    }
    removed.push(...placed.value);
    restored.push(path);
  }

  await cleanup();
  return { ok: true, value: { restored: sortedUnique(restored), removed: sortedUnique(removed) } };
}

/** Copies one already-sorted overlay snapshot onto the worktree root, hashing every file it writes. */
async function overlayStep(
  worktreeDirectory: string,
  snapshot: OverlaySnapshot,
): Promise<TevuResult<OverlayRecord, 'CheckStateError'>> {
  const step: CheckStateStep = 'overlay';
  const files: OverlayFileRecord[] = [];
  const removed: string[] = [];
  for (const entry of snapshot) {
    if (entry.kind === 'directory') {
      const placed = await placeDirectory(step, worktreeDirectory, entry.path);
      if (!placed.ok) {
        return placed;
      }
      removed.push(...placed.value);
    } else {
      const placed = await place(step, worktreeDirectory, entry.path, {
        kind: 'file',
        bytes: entry.bytes,
        executable: entry.executable,
      });
      if (!placed.ok) {
        return placed;
      }
      removed.push(...placed.value);
      files.push({ path: entry.path, sha256: sha256Hex(entry.bytes) });
    }
  }
  return { ok: true, value: { files, removed: sortedUnique(removed) } };
}

/**
 * Reads one overlay directory into a snapshot without writing: rejects a
 * missing or non-directory path, a symbolic link, a non-regular/non-directory
 * entry, an entry named `.git`, and an unreadable file or directory, then
 * returns every entry sorted ascending by its path relative to `directory`.
 */
async function readOverlay(
  directory: string,
): Promise<TevuResult<OverlaySnapshot, 'CheckStateError'>> {
  let rootStat: Stats;
  try {
    rootStat = await stat(directory);
  } catch (cause) {
    const code = systemErrorCode(cause);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return checkStateFailure('overlay', `overlay directory "${directory}" does not exist`);
    }
    return checkStateFailure(
      'overlay',
      `overlay directory "${directory}" cannot be read: ${describeCause(cause)}`,
    );
  }
  if (!rootStat.isDirectory()) {
    return checkStateFailure('overlay', `overlay path "${directory}" is not a directory`);
  }

  const entries: OverlayEntry[] = [];

  const walk = async (relative: string): Promise<TevuResult<void, 'CheckStateError'>> => {
    const absoluteDirectory = relative.length === 0 ? directory : join(directory, relative);
    let names: string[];
    try {
      names = await readdir(absoluteDirectory);
    } catch (cause) {
      return checkStateFailure(
        'overlay',
        `overlay directory "${directory}" entry "${relative}" cannot be read: ${describeCause(cause)}`,
      );
    }
    for (const name of [...names].sort()) {
      const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
      if (name === '.git') {
        return checkStateFailure(
          'overlay',
          `overlay directory "${directory}" must not contain an entry named .git; found "${childRelative}"`,
        );
      }
      let childStat: Stats;
      try {
        childStat = await lstat(join(directory, childRelative));
      } catch (cause) {
        return checkStateFailure(
          'overlay',
          `overlay directory "${directory}" entry "${childRelative}" cannot be read: ${describeCause(cause)}`,
        );
      }
      if (childStat.isSymbolicLink()) {
        return checkStateFailure(
          'overlay',
          `overlay directory "${directory}" must contain only regular files and directories; "${childRelative}" is a symbolic link`,
        );
      }
      if (childStat.isDirectory()) {
        entries.push({ kind: 'directory', path: childRelative });
        const nested = await walk(childRelative);
        if (!nested.ok) {
          return nested;
        }
        continue;
      }
      if (!childStat.isFile()) {
        return checkStateFailure(
          'overlay',
          `overlay directory "${directory}" must contain only regular files and directories; "${childRelative}" is neither a regular file nor a directory`,
        );
      }
      try {
        const bytes = await readFile(join(directory, childRelative));
        entries.push({
          kind: 'file',
          path: childRelative,
          executable: (childStat.mode & 0o100) !== 0,
          bytes,
        });
      } catch (cause) {
        return checkStateFailure(
          'overlay',
          `overlay directory "${directory}" entry "${childRelative}" cannot be read: ${describeCause(cause)}`,
        );
      }
    }
    return { ok: true, value: undefined };
  };

  const walked = await walk('');
  if (!walked.ok) {
    return walked;
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, value: entries };
}

/**
 * Resets `request.restore`'s matched paths to the base tree, then copies
 * `request.overlay` onto the worktree root so an overlay file wins over a
 * restored file at the same path. Checks the worktree root itself before the
 * first write; every other write and delete stays inside it by construction
 * of {@link place}, {@link placeDirectory}, and {@link deleteEntry}.
 */
async function applyCheckState(
  workspace: CaseWorkspace,
  request: CheckStateRequest,
): Promise<TevuResult<CheckStateRecord, 'CheckStateError'>> {
  const first: CheckStateStep = request.restore.length === 0 ? 'overlay' : 'restore';
  let rootStat: Stats;
  try {
    rootStat = await lstat(workspace.worktreeDirectory);
  } catch (cause) {
    return checkStateFailure(first, `read failed for ".": ${describeCause(cause)}`);
  }
  if (!rootStat.isDirectory()) {
    return checkStateFailure(first, 'worktree root is not a directory');
  }

  let restore: RestoreRecord | null = null;
  if (request.restore.length > 0) {
    const result = await restoreStep(workspace, request.restore);
    if (!result.ok) {
      return result;
    }
    restore = result.value;
  }
  let overlay: OverlayRecord | null = null;
  if (request.overlay !== null) {
    const result = await overlayStep(workspace.worktreeDirectory, request.overlay);
    if (!result.ok) {
      return result;
    }
    overlay = result.value;
  }
  return { ok: true, value: { restore, overlay } };
}

function sourceError(
  taskId: string,
  reason: string,
): { ok: false; error: { kind: 'SourceMaterializationError'; taskId: string; reason: string } } {
  return { ok: false, error: { kind: 'SourceMaterializationError', taskId, reason } };
}

function isolationError(
  caseId: string,
  reason: string,
): { ok: false; error: { kind: 'IsolationError'; caseId: string; reason: string } } {
  return { ok: false, error: { kind: 'IsolationError', caseId, reason } };
}

function artifactError(
  operation: string,
  reason: string,
): { ok: false; error: { kind: 'ArtifactError'; operation: string; reason: string } } {
  return { ok: false, error: { kind: 'ArtifactError', operation, reason } };
}
