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
import { basename, join } from 'node:path';
import process from 'node:process';
import { execa } from 'execa';

import { describeCause } from '@/domain/describe-cause';

import type { RepositoryDefinition, TevuConfig } from '@/config/schema';
import type {
  CaseIdentity,
  CaseWorkspace,
  CheckStateRecord,
  CheckStateRequest,
  GitWorkspaceAdapter,
  OverlayEntry,
  OverlayFileRecord,
  OverlayRecord,
  OverlaySnapshot,
  PatchArtifact,
  PatchBase,
  RestoreRecord,
  SourceValidation,
  TevuResult,
} from '@/domain/types';
import type { Stats } from 'node:fs';

/** Construction inputs for the sealed Git workspace adapter. */
export type GitWorkspaceAdapterOptions = {
  /** Validated configuration supplying repository paths and task references. */
  config: TevuConfig;
  /** Root directory receiving one private subdirectory per case. */
  workspacesDirectory: string;
};

const GIT_COMMAND_TIMEOUT_MS = 600_000;
const FIXED_LOCALE = 'C.UTF-8';
const SUBMODULE_MODE = '160000';
const LFS_POINTER_SIGNATURE = 'https://git-lfs.github.com/spec';
const LFS_ATTRIBUTE = 'filter=lfs';
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
export function createSourceValidator(): Pick<GitWorkspaceAdapter, 'validateSource'> {
  return { validateSource };
}

async function validateSource(
  repository: RepositoryDefinition,
  commit: string,
): Promise<TevuResult<SourceValidation, 'SourceMaterializationError'>> {
  const resolvedCommit = await resolveCommit(repository.path, commit);
  if (resolvedCommit === null) {
    return sourceError(
      repository.id,
      `repository "${repository.id}": "${commit}" is not readable as exactly one commit`,
    );
  }
  const inspection = await inspectSourceTree(repository.path, resolvedCommit);
  if (!inspection.ok) {
    return sourceError(repository.id, `repository "${repository.id}": ${inspection.reason}`);
  }
  return {
    ok: true,
    value: { repositoryId: repository.id, requestedCommit: commit, resolvedCommit },
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
  const { config, workspacesDirectory } = options;

  return {
    validateSource,
    readOverlay,
    applyCheckState,

    async createIsolatedCase(
      identity: CaseIdentity,
    ): Promise<TevuResult<CaseWorkspace, 'SourceMaterializationError' | 'IsolationError'>> {
      const task = config.tasks.find((candidate) => candidate.id === identity.taskId);
      if (task === undefined) {
        return sourceError(
          identity.taskId,
          `task "${identity.taskId}" is not defined in the configuration`,
        );
      }
      const repository = config.repositories.find((candidate) => candidate.id === task.repo);
      if (repository === undefined) {
        return sourceError(
          identity.taskId,
          `repository "${task.repo}" is not defined in the configuration`,
        );
      }
      const resolvedCommit = await resolveCommit(repository.path, identity.sourceCommit);
      if (resolvedCommit === null) {
        return sourceError(
          identity.taskId,
          `repository "${repository.id}": "${identity.sourceCommit}" is not readable as exactly one commit`,
        );
      }
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
      // `add --all` applies ignore rules to every path missing from the
      // index, so the index starts from the diff target's tree. The case
      // repository's configuration is agent-writable, and a sparse checkout
      // enabled there makes `add --all` skip changed tracked paths without
      // an error.
      const patchIndexFile = join(workspace.runtimeDirectory, 'patch-index');
      const indexEnvironment = {
        GIT_INDEX_FILE: patchIndexFile,
        ...(base === undefined ? {} : { GIT_OBJECT_DIRECTORY: base.objectDirectory }),
      };
      const diffTarget = base?.tree ?? workspace.syntheticCommit;
      try {
        await rm(patchIndexFile, { force: true });
        const seeded = await runGit(workspace.worktreeDirectory, ['read-tree', diffTarget], {
          environment: indexEnvironment,
        });
        if (seeded.exitCode !== 0) {
          return artifactError('capture-patch', describeGitFailure('read-tree', seeded));
        }
        const staged = await runGit(
          workspace.worktreeDirectory,
          ['-c', 'core.sparseCheckout=false', 'add', '--all'],
          { environment: indexEnvironment },
        );
        if (staged.exitCode !== 0) {
          return artifactError('capture-patch', describeGitFailure('add --all', staged));
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
        // Seeds and stages as `capturePatch` does, so the base and the
        // capture judge the worktree by the same rules.
        const seeded = await runGit(
          workspace.worktreeDirectory,
          ['read-tree', workspace.syntheticCommit],
          { environment },
        );
        if (seeded.exitCode !== 0) {
          return artifactError('snapshot-patch-base', describeGitFailure('read-tree', seeded));
        }
        const staged = await runGit(
          workspace.worktreeDirectory,
          ['-c', 'core.sparseCheckout=false', 'add', '--all'],
          { environment },
        );
        if (staged.exitCode !== 0) {
          return artifactError('snapshot-patch-base', describeGitFailure('add --all', staged));
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
 * object fails loudly instead of leaking source history.
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
  const committed = await runGit(
    worktreeDirectory,
    ['commit-tree', tree.stdout, '-m', `tevu sealed case ${identity.caseId}`],
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
  const repacked = await runGit(worktreeDirectory, ['repack', '-a', '-d', '--quiet']);
  if (repacked.exitCode !== 0) {
    return fail(describeGitFailure('repack', repacked));
  }
  try {
    await rm(alternatesFile, { force: true });
    await rm(join(repositoryDirectory, 'logs'), { recursive: true, force: true });
  } catch (cause) {
    return fail(`sealing cleanup failed: ${describeCause(cause)}`);
  }

  const populated = await runGit(worktreeDirectory, ['reset', '--hard', '--quiet']);
  if (populated.exitCode !== 0) {
    return fail(describeGitFailure('reset --hard', populated));
  }
  const sealedTree = await runGit(worktreeDirectory, ['rev-parse', 'HEAD^{tree}']);
  if (sealedTree.exitCode !== 0 || sealedTree.stdout !== tree.stdout) {
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

type TreeInspection = { ok: true } | { ok: false; reason: string };

/**
 * Inspects the pinned tree for unsupported submodule (gitlink) entries, Git
 * LFS attribute configuration, and Git LFS pointer blobs. Reasons carry counts
 * only; source filenames never enter error messages.
 */
async function inspectSourceTree(repositoryPath: string, commit: string): Promise<TreeInspection> {
  const listed = await runGit(repositoryPath, ['ls-tree', '-r', '-z', commit]);
  if (listed.exitCode !== 0) {
    return { ok: false, reason: describeGitFailure('ls-tree', listed) };
  }
  let submoduleCount = 0;
  const attributeFilePaths: string[] = [];
  for (const entry of listed.stdout.split('\0')) {
    if (entry.length === 0) {
      continue;
    }
    const tabIndex = entry.indexOf('\t');
    const [mode] = entry.slice(0, tabIndex).split(' ');
    const path = entry.slice(tabIndex + 1);
    if (mode === SUBMODULE_MODE) {
      submoduleCount += 1;
    }
    if (basename(path) === '.gitattributes') {
      attributeFilePaths.push(path);
    }
  }
  if (submoduleCount > 0) {
    return {
      ok: false,
      reason: `source tree contains ${submoduleCount} unsupported submodule entr${submoduleCount === 1 ? 'y' : 'ies'}`,
    };
  }

  for (const path of attributeFilePaths) {
    const attributes = await runGit(repositoryPath, ['cat-file', 'blob', `${commit}:${path}`]);
    if (attributes.exitCode !== 0) {
      return { ok: false, reason: describeGitFailure('cat-file .gitattributes', attributes) };
    }
    if (attributes.stdout.includes(LFS_ATTRIBUTE)) {
      return { ok: false, reason: 'source tree configures unsupported Git LFS attributes' };
    }
  }

  const pointers = await runGit(repositoryPath, [
    'grep',
    '-I',
    '--fixed-strings',
    '--name-only',
    '-e',
    LFS_POINTER_SIGNATURE,
    commit,
  ]);
  if (pointers.exitCode === 0) {
    const pointerCount = pointers.stdout.split('\n').filter((line) => line.length > 0).length;
    return {
      ok: false,
      reason: `source tree contains ${pointerCount} unsupported Git LFS pointer blob${pointerCount === 1 ? '' : 's'}`,
    };
  }
  if (pointers.exitCode !== 1) {
    return { ok: false, reason: describeGitFailure('grep', pointers) };
  }
  return { ok: true };
}

/** Resolves a reference to exactly one full commit hash, or `null`. */
async function resolveCommit(repositoryPath: string, reference: string): Promise<string | null> {
  const outcome = await runGit(repositoryPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${reference}^{commit}`,
  ]);
  if (outcome.exitCode !== 0 || !COMMIT_HASH_PATTERN.test(outcome.stdout)) {
    return null;
  }
  return outcome.stdout;
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
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LANG: FIXED_LOCALE,
    LC_ALL: FIXED_LOCALE,
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
