/** The `GitWorkspaceAdapter` contract, with the request and result shapes only it uses. */

import type { RepositoryDefinition } from '@/domain/config';
import type { TevuResult } from '@/domain/errors';
import type { CaseIdentity, CheckStateRecord, PatchArtifact } from '@/domain/run-records';

/** Git LFS objects the tree of one commit needs, counted against its repository's own Git LFS storage. */
export type LfsObjectInventory = {
  /** Full hash the requested revision resolved to. */
  commit: string;
  /** Distinct (oid, size) pairs of pointer entries that use no extension and have a nonzero size. */
  objectCount: number;
  /** Pairs whose object file is absent, not a regular file, or of a size other than the pointer's. */
  missingCount: number;
};

/** Successful resolution of a task's pinned commit inside its configured repository. */
export type SourceValidation = {
  repositoryId: string;
  requestedCommit: string;
  resolvedCommit: string;
  /** The first path segment of every path in the resolved commit's tree, ascending UTF-16 code-unit order, no repeats. */
  rootEntries: string[];
};

/** One sealed case workspace: private repository, worktree, and runtime directory. */
export type CaseWorkspace = {
  caseId: string;
  sourceRepositoryPath: string;
  sourceCommit: string;
  repositoryDirectory: string;
  worktreeDirectory: string;
  runtimeDirectory: string;
  branch: string;
  syntheticCommit: string;
};

/** The worktree state `before_agent` left, as a tree in a private object directory outside the case repository. */
export type PatchBase = { readonly tree: string; readonly objectDirectory: string };

/** What `applyCheckState` does to one worktree; built by the orchestrator from the task and the run's overlay snapshot. */
export type CheckStateRequest = {
  /** Patterns from `checks.restore`; empty means no restore step. */
  restore: readonly string[];
  /** The run's snapshot of `checks.overlay`, or null when the task declares none. */
  overlay: OverlaySnapshot | null;
};

/** One overlay directory as `readOverlay` read it, sorted ascending by `path` with `<` comparison. */
export type OverlaySnapshot = readonly OverlayEntry[];

/** `path` follows the recorded-path rules of `CheckStateRecord`; `executable` is the owner-executable bit (`mode & 0o100`). */
export type OverlayEntry =
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; executable: boolean; bytes: Uint8Array };

/** Result of looking up one revision in a repository. */
export type CommitLookup =
  { kind: 'found'; commit: string } | { kind: 'not-found' } | { kind: 'no-repository' };

/**
 * Sealed Git source validation, case materialization, patch capture, disposal,
 * and the check-state setup (restore and overlay) that runs between patch
 * capture and acceptance checks.
 *
 * Also records the worktree state before `before_agent` runs, through
 * {@link GitWorkspaceAdapter.snapshotPatchBase}, so a later patch capture can
 * diff against it instead of the case's synthetic root commit.
 */
export interface GitWorkspaceAdapter {
  validateSource(
    repository: RepositoryDefinition,
    commit: string,
  ): Promise<TevuResult<SourceValidation, 'SourceMaterializationError'>>;
  /** Looks up a revision without failing: distinguishes a repository the path does not hold from a revision it does not resolve. */
  resolveCommit(repository: RepositoryDefinition, reference: string): Promise<CommitLookup>;
  /** Counts the Git LFS objects a revision's tree needs against the repository's own storage; reads only and never starts Git LFS. */
  inspectLfsObjects(
    repository: RepositoryDefinition,
    revision: string,
  ): Promise<TevuResult<LfsObjectInventory, 'SourceMaterializationError'>>;
  /** Reports whether `ancestor` precedes or equals `descendant`; `null` when Git cannot decide. */
  isAncestor(
    repository: RepositoryDefinition,
    ancestor: string,
    descendant: string,
  ): Promise<boolean | null>;
  createIsolatedCase(
    identity: CaseIdentity,
    repository: RepositoryDefinition,
  ): Promise<TevuResult<CaseWorkspace, 'SourceMaterializationError' | 'IsolationError'>>;
  /** Records the worktree state as the patch base; no commit, ref, index change, or object in the case repository. */
  snapshotPatchBase(workspace: CaseWorkspace): Promise<TevuResult<PatchBase, 'ArtifactError'>>;
  /** Diffs against `base.tree` when given; otherwise against `workspace.syntheticCommit`, exactly as without a base. */
  capturePatch(
    workspace: CaseWorkspace,
    base?: PatchBase,
  ): Promise<TevuResult<PatchArtifact, 'SourceMaterializationError' | 'ArtifactError'>>;
  /** Reads an overlay directory into a snapshot without writing; fails with the first defect of the overlay validation rules. */
  readOverlay(directory: string): Promise<TevuResult<OverlaySnapshot, 'CheckStateError'>>;
  /** Restores the request's matched paths to the base tree, then copies the overlay onto the worktree root. */
  applyCheckState(
    workspace: CaseWorkspace,
    request: CheckStateRequest,
  ): Promise<TevuResult<CheckStateRecord, 'CheckStateError'>>;
  dispose(workspace: CaseWorkspace): Promise<TevuResult<void, 'ArtifactError'>>;
  /** Reports whether Git still resolves `HEAD` in the case worktree. */
  isReadable(workspace: CaseWorkspace): Promise<boolean>;
  /** Runs `git init` in an existing empty directory; creates no commit, remote, or configuration. */
  initializeEmptyRepository(directory: string): Promise<TevuResult<void, 'ArtifactError'>>;
  /** The unified diff `commit` introduces against its first parent: no color, no external diff driver, no binary contents. */
  diffCommit(
    repository: RepositoryDefinition,
    commit: string,
  ): Promise<TevuResult<string, 'ArtifactError'>>;
}
