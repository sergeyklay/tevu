/**
 * Git boundary: read-only source validation, sealed per-case repositories with
 * one synthetic root commit, pre-evaluation patch capture, and workspace
 * disposal. Source repositories are never mutated; every case owns a private
 * object database, worktree, and runtime directory with no sibling references.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";
import { execa } from "execa";

import type { RepositoryDefinition, TevuConfig } from "../config/schema.ts";
import type {
  CaseIdentity,
  CaseWorkspace,
  GitWorkspaceAdapter,
  PatchArtifact,
  SourceValidation,
  TevuResult,
} from "../domain/types.ts";

/** Construction inputs for the sealed Git workspace adapter. */
export type GitWorkspaceAdapterOptions = {
  /** Validated configuration supplying repository paths and task references. */
  config: TevuConfig;
  /** Root directory receiving one private subdirectory per case. */
  workspacesDirectory: string;
};

const GIT_COMMAND_TIMEOUT_MS = 600_000;
const FIXED_LOCALE = "C.UTF-8";
const SUBMODULE_MODE = "160000";
const LFS_POINTER_SIGNATURE = "https://git-lfs.github.com/spec";
const LFS_ATTRIBUTE = "filter=lfs";
const COMMIT_HASH_PATTERN = /^[0-9a-f]{40,64}$/;

/** Deterministic identity for the synthetic root commit of every sealed case. */
const SYNTHETIC_COMMIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "tevu",
  GIT_AUTHOR_EMAIL: "tevu@localhost",
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "tevu",
  GIT_COMMITTER_EMAIL: "tevu@localhost",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
};

/**
 * Creates the `GitWorkspaceAdapter` implementation over the local Git CLI.
 *
 * `validateSource` reports failures as `SourceMaterializationError` with the
 * repository ID in the `taskId` field because the adapter contract carries no
 * task identity at that boundary; callers that know the task may re-attribute.
 */
/**
 * Creates the read-only source-validation half of {@link GitWorkspaceAdapter},
 * needing no configuration: it reads only the `repository`/`commit`
 * parameters it is called with.
 */
export function createSourceValidator(): Pick<GitWorkspaceAdapter, "validateSource"> {
  return { validateSource };
}

async function validateSource(
  repository: RepositoryDefinition,
  commit: string,
): Promise<TevuResult<SourceValidation, "SourceMaterializationError">> {
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

export function createGitWorkspaceAdapter(
  options: GitWorkspaceAdapterOptions,
): GitWorkspaceAdapter {
  const { config, workspacesDirectory } = options;

  return {
    validateSource,

    async createIsolatedCase(
      identity: CaseIdentity,
    ): Promise<TevuResult<CaseWorkspace, "SourceMaterializationError" | "IsolationError">> {
      const task = config.tasks.find((candidate) => candidate.id === identity.taskId);
      if (task === undefined) {
        return sourceError(
          identity.taskId,
          `task "${identity.taskId}" is not defined in the configuration`,
        );
      }
      const repository = config.repositories.find(
        (candidate) => candidate.id === task.repo,
      );
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
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ]);
      if (sourceObjects.exitCode !== 0 || sourceObjects.stdout.length === 0) {
        return sourceError(
          identity.taskId,
          `repository "${repository.id}": ${describeGitFailure("rev-parse --git-path objects", sourceObjects)}`,
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
    ): Promise<TevuResult<PatchArtifact, "SourceMaterializationError" | "ArtifactError">> {
      // A private throwaway index leaves the case repository's own index
      // untouched while `add --all` snapshots the complete worktree state.
      const patchIndexFile = join(workspace.runtimeDirectory, "patch-index");
      const indexEnvironment = { GIT_INDEX_FILE: patchIndexFile };
      try {
        await rm(patchIndexFile, { force: true });
        const staged = await runGit(workspace.worktreeDirectory, ["add", "--all"], {
          environment: indexEnvironment,
        });
        if (staged.exitCode !== 0) {
          return artifactError("capture-patch", describeGitFailure("add --all", staged));
        }
        const diff = await runGit(
          workspace.worktreeDirectory,
          [
            "diff",
            "--cached",
            "--binary",
            "--no-color",
            "--no-ext-diff",
            workspace.syntheticCommit,
          ],
          { environment: indexEnvironment, keepFinalNewline: true },
        );
        if (diff.exitCode !== 0) {
          return artifactError("capture-patch", describeGitFailure("diff --cached", diff));
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

    async dispose(workspace: CaseWorkspace): Promise<TevuResult<void, "ArtifactError">> {
      const caseDirectory = join(workspacesDirectory, workspace.caseId);
      try {
        await rm(caseDirectory, { recursive: true, force: true });
        return { ok: true, value: undefined };
      } catch (cause) {
        return artifactError(
          "dispose-case-workspace",
          `retained ${caseDirectory}: ${describeError(cause)}`,
        );
      }
    },

    async isReadable(workspace: CaseWorkspace): Promise<boolean> {
      const outcome = await runGit(workspace.worktreeDirectory, [
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD",
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
): Promise<TevuResult<CaseWorkspace, "SourceMaterializationError" | "IsolationError">> {
  const { identity, repository, resolvedCommit, workspacesDirectory } = input;
  const caseDirectory = join(workspacesDirectory, identity.caseId);
  const repositoryDirectory = join(caseDirectory, "repo.git");
  const worktreeDirectory = join(caseDirectory, "worktree");
  const runtimeDirectory = join(caseDirectory, "runtime");
  const branch = identity.caseId;

  await mkdir(workspacesDirectory, { recursive: true });
  try {
    await mkdir(caseDirectory);
  } catch (cause) {
    return isolationError(
      identity.caseId,
      `case directory cannot be created exclusively: ${describeError(cause)}`,
    );
  }

  const fail = async (
    reason: string,
  ): Promise<{ ok: false; error: { kind: "IsolationError"; caseId: string; reason: string } }> => {
    await rm(caseDirectory, { recursive: true, force: true }).catch(() => undefined);
    return isolationError(identity.caseId, reason);
  };

  try {
    await mkdir(runtimeDirectory);
  } catch (cause) {
    return fail(`runtime directory cannot be created: ${describeError(cause)}`);
  }

  const init = await runGit(workspacesDirectory, [
    "init",
    "--quiet",
    `--initial-branch=${branch}`,
    `--separate-git-dir=${repositoryDirectory}`,
    worktreeDirectory,
  ]);
  if (init.exitCode !== 0) {
    return fail(describeGitFailure("init", init));
  }
  for (const [key, value] of [
    ["core.logAllRefUpdates", "false"],
    ["gc.auto", "0"],
  ] as const) {
    const configured = await runGit(worktreeDirectory, ["config", key, value]);
    if (configured.exitCode !== 0) {
      return fail(describeGitFailure(`config ${key}`, configured));
    }
  }

  const alternatesFile = join(repositoryDirectory, "objects", "info", "alternates");
  try {
    await writeFile(alternatesFile, `${input.sourceObjectsDirectory}\n`, "utf8");
  } catch (cause) {
    return fail(`temporary alternates link cannot be written: ${describeError(cause)}`);
  }

  const tree = await runGit(worktreeDirectory, ["rev-parse", `${resolvedCommit}^{tree}`]);
  if (tree.exitCode !== 0 || tree.stdout.length === 0) {
    return fail(describeGitFailure("rev-parse tree", tree));
  }
  const committed = await runGit(
    worktreeDirectory,
    ["commit-tree", tree.stdout, "-m", `tevu sealed case ${identity.caseId}`],
    { environment: SYNTHETIC_COMMIT_IDENTITY },
  );
  if (committed.exitCode !== 0 || committed.stdout.length === 0) {
    return fail(describeGitFailure("commit-tree", committed));
  }
  const syntheticCommit = committed.stdout;

  const branchRef = await runGit(worktreeDirectory, [
    "update-ref",
    `refs/heads/${branch}`,
    syntheticCommit,
  ]);
  if (branchRef.exitCode !== 0) {
    return fail(describeGitFailure("update-ref", branchRef));
  }
  const repacked = await runGit(worktreeDirectory, ["repack", "-a", "-d", "--quiet"]);
  if (repacked.exitCode !== 0) {
    return fail(describeGitFailure("repack", repacked));
  }
  try {
    await rm(alternatesFile, { force: true });
    await rm(join(repositoryDirectory, "logs"), { recursive: true, force: true });
  } catch (cause) {
    return fail(`sealing cleanup failed: ${describeError(cause)}`);
  }

  const populated = await runGit(worktreeDirectory, ["reset", "--hard", "--quiet"]);
  if (populated.exitCode !== 0) {
    return fail(describeGitFailure("reset --hard", populated));
  }
  const sealedTree = await runGit(worktreeDirectory, ["rev-parse", "HEAD^{tree}"]);
  if (sealedTree.exitCode !== 0 || sealedTree.stdout !== tree.stdout) {
    return fail("sealed tree does not match the pinned source tree");
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
async function inspectSourceTree(
  repositoryPath: string,
  commit: string,
): Promise<TreeInspection> {
  const listed = await runGit(repositoryPath, ["ls-tree", "-r", "-z", commit]);
  if (listed.exitCode !== 0) {
    return { ok: false, reason: describeGitFailure("ls-tree", listed) };
  }
  let submoduleCount = 0;
  const attributeFilePaths: string[] = [];
  for (const entry of listed.stdout.split("\0")) {
    if (entry.length === 0) {
      continue;
    }
    const tabIndex = entry.indexOf("\t");
    const [mode] = entry.slice(0, tabIndex).split(" ");
    const path = entry.slice(tabIndex + 1);
    if (mode === SUBMODULE_MODE) {
      submoduleCount += 1;
    }
    if (basename(path) === ".gitattributes") {
      attributeFilePaths.push(path);
    }
  }
  if (submoduleCount > 0) {
    return {
      ok: false,
      reason: `source tree contains ${submoduleCount} unsupported submodule entr${submoduleCount === 1 ? "y" : "ies"}`,
    };
  }

  for (const path of attributeFilePaths) {
    const attributes = await runGit(repositoryPath, ["cat-file", "blob", `${commit}:${path}`]);
    if (attributes.exitCode !== 0) {
      return { ok: false, reason: describeGitFailure("cat-file .gitattributes", attributes) };
    }
    if (attributes.stdout.includes(LFS_ATTRIBUTE)) {
      return { ok: false, reason: "source tree configures unsupported Git LFS attributes" };
    }
  }

  const pointers = await runGit(repositoryPath, [
    "grep",
    "-I",
    "--fixed-strings",
    "--name-only",
    "-e",
    LFS_POINTER_SIGNATURE,
    commit,
  ]);
  if (pointers.exitCode === 0) {
    const pointerCount = pointers.stdout.split("\n").filter((line) => line.length > 0).length;
    return {
      ok: false,
      reason: `source tree contains ${pointerCount} unsupported Git LFS pointer blob${pointerCount === 1 ? "" : "s"}`,
    };
  }
  if (pointers.exitCode !== 1) {
    return { ok: false, reason: describeGitFailure("grep", pointers) };
  }
  return { ok: true };
}

/** Resolves a reference to exactly one full commit hash, or `null`. */
async function resolveCommit(repositoryPath: string, reference: string): Promise<string | null> {
  const outcome = await runGit(repositoryPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
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
};

async function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitCommandOutcome> {
  const result = await execa("git", [...args], {
    cwd,
    env: { ...baseGitEnvironment(), ...options.environment },
    extendEnv: false,
    stdin: "ignore",
    reject: false,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    stripFinalNewline: options.keepFinalNewline !== true,
  });
  return {
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
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
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
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

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sourceError(
  taskId: string,
  reason: string,
): { ok: false; error: { kind: "SourceMaterializationError"; taskId: string; reason: string } } {
  return { ok: false, error: { kind: "SourceMaterializationError", taskId, reason } };
}

function isolationError(
  caseId: string,
  reason: string,
): { ok: false; error: { kind: "IsolationError"; caseId: string; reason: string } } {
  return { ok: false, error: { kind: "IsolationError", caseId, reason } };
}

function artifactError(
  operation: string,
  reason: string,
): { ok: false; error: { kind: "ArtifactError"; operation: string; reason: string } } {
  return { ok: false, error: { kind: "ArtifactError", operation, reason } };
}
