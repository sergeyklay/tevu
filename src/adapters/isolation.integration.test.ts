// @vitest-environment node
import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TevuConfigSchema } from "../config/schema.ts";
import { buildCheckEnvironment } from "../evaluation/checks.ts";
import { createGitWorkspaceAdapter } from "./git.ts";
import { createEnvironmentAdapter, createRedactor, createStreamingRedactor, runManagedProcess } from "./process.ts";

import type {
  CaseEnvironments,
  CaseIdentity,
  CaseWorkspace,
  GitWorkspaceAdapter,
  IsolatedEnvironment,
  ManagedProcessResult,
  TevuError,
  TevuResult,
} from "../domain/types.ts";
import type { TaskInput, TevuConfig, TevuConfigInput } from "../config/schema.ts";

const PROVIDER_NAME = "TEVU_IT_PROVIDER_KEY";
const PROVIDER_VALUE = "synthetic-provider-secret-9f2";
const SECRET_NAME = "TEVU_IT_SECRET_VALUE";
const SECRET_VALUE = "synthetic-secret-token-7b4";
const EVAL_NAME = "TEVU_IT_ORDINARY";
const ORDINARY_VALUE = "ordinary-evaluator-value";
const HOST_SENTINEL_NAME = "TEVU_IT_HOST_ONLY";
const HOST_SENTINEL_VALUE = "host-only-sentinel";
const UNLISTED_NAME = "TEVU_IT_UNLISTED";
const UNLISTED_VALUE = "unlisted-parent-value";
const HOST_XDG_DATA = "/host/xdg-data-synthetic";

const MANAGED_ENV_KEYS = [
  PROVIDER_NAME,
  SECRET_NAME,
  EVAL_NAME,
  HOST_SENTINEL_NAME,
  UNLISTED_NAME,
  "XDG_DATA_HOME",
] as const;

const FIXED_EVALUATOR_KEYS = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CI",
];

const AGENT_ENV_KEYS = [...FIXED_EVALUATOR_KEYS, PROVIDER_NAME, SECRET_NAME].sort();
const EVALUATOR_ALLOWLISTED_KEYS = [...FIXED_EVALUATOR_KEYS, EVAL_NAME].sort();

const SOURCE_TEXT = "synthetic source line one\n";
const SOURCE_BINARY = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x41, 0x42, 0x43, 0x0a]);
const SOURCE_SCRIPT = "#!/bin/sh\necho synthetic\n";
const SYMLINK_TARGET = "../src/welcome.txt";

const GIT_IDENTITY_FLAGS = ["-c", "user.name=tevu", "-c", "user.email=tevu@localhost"];

const ENVIRONMENT_PROBE_SCRIPT =
  "process.stdout.write(JSON.stringify({ home: process.env.HOME, provider: process.env.TEVU_IT_PROVIDER_KEY, secret: process.env.TEVU_IT_SECRET_VALUE, ordinary: process.env.TEVU_IT_ORDINARY, hostSentinel: process.env.TEVU_IT_HOST_ONLY, keys: Object.keys(process.env).sort() }));";
const STDERR_SECRET_PROBE_SCRIPT =
  "process.stderr.write(String(process.env.TEVU_IT_PROVIDER_KEY) + '\\n');\n";

const SURVIVOR_GRANDCHILD_SCRIPT = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
const MORTAL_GRANDCHILD_SCRIPT = "setInterval(() => {}, 1000);";

let testDirectory = "";
let savedEnvironment: Array<readonly [string, string | undefined]> = [];

beforeEach(async () => {
  savedEnvironment = MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]);
  process.env[PROVIDER_NAME] = PROVIDER_VALUE;
  process.env[SECRET_NAME] = SECRET_VALUE;
  process.env[EVAL_NAME] = ORDINARY_VALUE;
  process.env[HOST_SENTINEL_NAME] = HOST_SENTINEL_VALUE;
  process.env[UNLISTED_NAME] = UNLISTED_VALUE;
  process.env.XDG_DATA_HOME = HOST_XDG_DATA;
  testDirectory = await mkdtemp(join(tmpdir(), "tevu-isolation-"));
});

afterEach(async () => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (testDirectory.length > 0) {
    await rm(testDirectory, { recursive: true, force: true });
    testDirectory = "";
  }
});

function unwrapOk<T, K extends TevuError["kind"]>(result: TevuResult<T, K>): T {
  if (!result.ok) {
    throw new Error(`expected an ok result, received ${result.error.kind}`);
  }
  return result.value;
}

/** `createCaseEnvironments` always populates `agent`; narrows past its still-optional shim type. */
function requireAgentEnvironment(environments: CaseEnvironments): IsolatedEnvironment {
  if (environments.agent === undefined) {
    throw new Error("expected createCaseEnvironments to populate the agent environment");
  }
  return environments.agent;
}

type GitOutcome = { exitCode: number | null; stdout: string; stderr: string };

async function runGit(cwd: string, args: readonly string[]): Promise<GitOutcome> {
  const result = await execa("git", [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    reject: false,
    stdin: "ignore",
    timeout: 60_000,
  });
  return {
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function buildTask(sourceCommit: string): TaskInput {
  return {
    id: "task-1",
    title: "Synthetic isolation task",
    repo: "repo-1",
    base_commit: sourceCommit,
    description: "synthetic task description",
    prompt: "implement the synthetic feature",
    readiness: ["synthetic ready item"],
    checks: {
      acceptance: [
        {
          id: "acc-1",
          description: "acceptance command exits zero",
          run: ["/synthetic/acceptance-probe", "--suite", "synthetic"],
          timeout: "5s",
          exit_codes: [0],
          env: [EVAL_NAME],
        },
      ],
      done: [
        {
          id: "dod-1",
          description: "Definition of Done command exits zero",
          run: ["/synthetic/dod-probe", "--suite", "synthetic"],
          timeout: "5s",
          exit_codes: [0],
        },
      ],
    },
  };
}

function buildConfig(repositoryPath: string, sourceCommit: string): TevuConfig {
  const config: TevuConfigInput = {
    version: 1,
    run: { output_dir: join(testDirectory, "artifacts"), concurrency: 1, timeout: "1m", stop_grace: "250ms" },
    agents: { opencode: { command: "/synthetic/agent", secrets: [PROVIDER_NAME, SECRET_NAME], env: [] } },
    repositories: [{ id: "repo-1", path: repositoryPath }],
    models: [
      { id: "c1", model: "synthetic/model-a", effort: "fast" },
      { id: "c2", model: "synthetic/model-b", effort: "deep" },
    ],
    tasks: [buildTask(sourceCommit)],
  };
  return TevuConfigSchema.parse(config);
}

function buildIdentity(caseId: string, sourceCommit: string): CaseIdentity {
  return {
    caseId,
    taskId: "task-1",
    modelId: "c1",
    sourceCommit,
    model: "synthetic/model-a",
    effort: "fast",
    agent: "opencode",
  };
}

async function createSyntheticRepository(): Promise<{ path: string; commit: string }> {
  const path = join(testDirectory, "source-repository");
  await mkdir(path, { recursive: true });
  for (const directory of ["src", "assets", "scripts", "docs"]) {
    await mkdir(join(path, directory));
  }
  await writeFile(join(path, "src/welcome.txt"), SOURCE_TEXT);
  await writeFile(join(path, "assets/logo.bin"), SOURCE_BINARY);
  await writeFile(join(path, "scripts/run.sh"), SOURCE_SCRIPT);
  await chmod(join(path, "scripts/run.sh"), 0o755);
  await symlink(SYMLINK_TARGET, join(path, "docs/latest.txt"));
  await runGit(path, ["init", "--quiet", "-b", "main"]);
  await runGit(path, ["add", "-A"]);
  await runGit(path, [...GIT_IDENTITY_FLAGS, "commit", "--quiet", "-m", "synthetic pinned commit"]);
  const commit = (await runGit(path, ["rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(path, "untracked.txt"), "untracked source file\n");
  await writeFile(join(path, "src/welcome.txt"), `${SOURCE_TEXT}dirty local edit\n`);
  return { path, commit };
}

function createGitAdapter(repositoryPath: string, sourceCommit: string): GitWorkspaceAdapter {
  return createGitWorkspaceAdapter({
    config: buildConfig(repositoryPath, sourceCommit),
    workspacesDirectory: join(testDirectory, "workspaces"),
  });
}

async function sealCaseFromSyntheticRepository(
  caseId: string,
): Promise<{ repository: { path: string; commit: string }; adapter: GitWorkspaceAdapter; workspace: CaseWorkspace }> {
  const repository = await createSyntheticRepository();
  const adapter = createGitAdapter(repository.path, repository.commit);
  const sealed = await adapter.createIsolatedCase(buildIdentity(caseId, repository.commit));
  return { repository, adapter, workspace: unwrapOk(sealed) };
}

function buildFabricatedWorkspace(caseId: string): CaseWorkspace {
  return {
    caseId,
    sourceRepositoryPath: "/synthetic/source",
    sourceCommit: "f".repeat(40),
    repositoryDirectory: join(testDirectory, "ws", caseId, "repo.git"),
    worktreeDirectory: join(testDirectory, "ws", caseId, "worktree"),
    runtimeDirectory: join(testDirectory, "ws", caseId, "runtime"),
    branch: caseId,
    syntheticCommit: "f".repeat(40),
  };
}

function pidState(pid: number | null): "gone" | "zombie" | "alive" {
  if (pid === null) {
    return "gone";
  }
  try {
    process.kill(pid, 0);
  } catch {
    return "gone";
  }
  try {
    const statText = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const state = statText.slice(statText.lastIndexOf(")") + 2).trimStart().split(" ")[0] ?? "";
    return state === "Z" ? "zombie" : "alive";
  } catch {
    return "gone";
  }
}

async function waitForDescendantsReaped(pidFile: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { child: number; grandchild: number };
    const alive = [pids.child, pids.grandchild].filter((pid) => pidState(pid) === "alive");
    if (alive.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`descendant processes were not reaped within 5s: ${alive.join(", ")}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

function buildChildScript(pidFile: string, options: {
  trapSignal: boolean;
  exitAfterMs?: number;
  grandchildScript: string;
}): string {
  const trap = options.trapSignal ? "process.on('SIGTERM', () => {});\n" : "";
  const stayAlive =
    options.exitAfterMs === undefined
      ? "setInterval(() => {}, 1000);\n"
      : `setTimeout(() => process.exit(0), ${String(options.exitAfterMs)});\n`;
  return [
    "const fs = require('node:fs');",
    "const cp = require('node:child_process');",
    trap +
      `const grandchild = cp.spawn(process.execPath, ['-e', ${JSON.stringify(options.grandchildScript)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));`,
    stayAlive,
  ].join("\n");
}

function expectLaunched(result: ManagedProcessResult): Extract<ManagedProcessResult, { launched: true }> {
  if (!result.launched) {
    throw new Error(`expected a launched process, received: ${result.reason}`);
  }
  return result;
}

describe("sealed Git case materialization", () => {
  it("materializes one synthetic root commit whose tree is byte-equivalent to the pinned source tree", async () => {
    const { workspace } = await sealCaseFromSyntheticRepository("task-1--c1");

    const sourceTree = await runGit(workspace.sourceRepositoryPath, ["rev-parse", `${workspace.sourceCommit}^{tree}`]);
    const sealedTree = await runGit(workspace.worktreeDirectory, ["rev-parse", "HEAD^{tree}"]);
    const rootCount = await runGit(workspace.worktreeDirectory, ["rev-list", "--all", "--count"]);
    const head = await runGit(workspace.worktreeDirectory, ["rev-parse", "HEAD"]);
    const branch = await runGit(workspace.worktreeDirectory, ["rev-parse", "--abbrev-ref", "HEAD"]);

    expect(sealedTree.stdout).toBe(sourceTree.stdout);
    expect(Number(rootCount.stdout)).toBe(1);
    expect(head.stdout).toBe(workspace.syntheticCommit);
    expect(branch.stdout).toBe("task-1--c1");
    expect(workspace.syntheticCommit).not.toBe(workspace.sourceCommit);

    const text = await readFile(join(workspace.worktreeDirectory, "src/welcome.txt"), "utf8");
    expect(text).toBe(SOURCE_TEXT);
    const binary = await readFile(join(workspace.worktreeDirectory, "assets/logo.bin"));
    expect(binary.equals(SOURCE_BINARY)).toBe(true);
    const executable = await stat(join(workspace.worktreeDirectory, "scripts/run.sh"));
    expect(executable.mode & 0o111).not.toBe(0);
    const link = await lstat(join(workspace.worktreeDirectory, "docs/latest.txt"));
    expect(link.isSymbolicLink()).toBe(true);
    await expect(readlink(join(workspace.worktreeDirectory, "docs/latest.txt"), "utf8")).resolves.toBe(SYMLINK_TARGET);
  }, 30_000);

  it("excludes untracked and dirty source state from the sealed worktree", async () => {
    const { workspace } = await sealCaseFromSyntheticRepository("task-1--c1");

    const status = await runGit(workspace.worktreeDirectory, ["status", "--porcelain"]);

    expect(existsSync(join(workspace.worktreeDirectory, "untracked.txt"))).toBe(false);
    expect((await readFile(join(workspace.worktreeDirectory, "src/welcome.txt"), "utf8"))).toBe(SOURCE_TEXT);
    expect(status.stdout).toBe("");
  });

  it("keeps one private object database with no remotes, alternates, tags, stashes, reflogs, later refs, or host identity", async () => {
    const { repository, workspace } = await sealCaseFromSyntheticRepository("task-1--c1");

    const refs = await runGit(workspace.worktreeDirectory, ["for-each-ref", "--format=%(refname)"]);
    const tags = await runGit(workspace.worktreeDirectory, ["tag", "--list"]);
    const remotes = await runGit(workspace.worktreeDirectory, ["remote"]);
    const stashes = await runGit(workspace.worktreeDirectory, ["stash", "--list"]);
    const objectsPath = await runGit(workspace.worktreeDirectory, ["rev-parse", "--git-path", "objects"]);
    const hostIdentity = await runGit(workspace.worktreeDirectory, ["config", "--local", "--get-regexp", "^user\\."]);
    const sourceCommitLookup = await runGit(workspace.repositoryDirectory, ["cat-file", "-e", repository.commit]);

    expect(refs.stdout.split("\n").filter((line) => line.length > 0)).toEqual([`refs/heads/task-1--c1`]);
    expect(tags.stdout).toBe("");
    expect(remotes.stdout).toBe("");
    expect(stashes.stdout).toBe("");
    expect(existsSync(join(workspace.repositoryDirectory, "objects/info/alternates"))).toBe(false);
    expect(existsSync(join(workspace.repositoryDirectory, "logs"))).toBe(false);
    expect(resolve(workspace.worktreeDirectory, objectsPath.stdout.trim())).toBe(
      join(workspace.repositoryDirectory, "objects"),
    );
    expect(hostIdentity.exitCode).not.toBe(0);
    expect(sourceCommitLookup.exitCode).not.toBe(0);
  });

  it("separates sibling cases with disjoint directories, object storage, and branches", async () => {
    const repository = await createSyntheticRepository();
    const adapter = createGitWorkspaceAdapter({
      config: buildConfig(repository.path, repository.commit),
      workspacesDirectory: join(testDirectory, "workspaces"),
    });
    const first = unwrapOk(await adapter.createIsolatedCase(buildIdentity("task-1--c1", repository.commit)));
    const second = unwrapOk(await adapter.createIsolatedCase(buildIdentity("task-1--c2", repository.commit)));

    expect(first.repositoryDirectory).not.toBe(second.repositoryDirectory);
    expect(first.worktreeDirectory).not.toBe(second.worktreeDirectory);
    expect(first.runtimeDirectory).not.toBe(second.runtimeDirectory);
    expect(first.syntheticCommit).not.toBe(second.syntheticCommit);
    expect(first.branch).toBe("task-1--c1");
    expect(second.branch).toBe("task-1--c2");

    const secondCommitLookup = await runGit(first.repositoryDirectory, ["cat-file", "-e", second.syntheticCommit]);
    expect(secondCommitLookup.exitCode).not.toBe(0);
    expect(existsSync(join(first.repositoryDirectory, "objects/info/alternates"))).toBe(false);
  });

  it("leaves the source repository state unchanged across materialization and disposal", async () => {
    const repository = await createSyntheticRepository();
    const adapter = createGitWorkspaceAdapter({
      config: buildConfig(repository.path, repository.commit),
      workspacesDirectory: join(testDirectory, "workspaces"),
    });
    const headBefore = await runGit(repository.path, ["rev-parse", "HEAD"]);
    const statusBefore = await runGit(repository.path, ["status", "--porcelain"]);
    const refsBefore = await runGit(repository.path, ["for-each-ref"]);
    const objectsBefore = await runGit(repository.path, ["count-objects", "-v"]);

    const sealed = await adapter.createIsolatedCase(buildIdentity("task-1--c1", repository.commit));
    await adapter.dispose(unwrapOk(sealed));

    const headAfter = await runGit(repository.path, ["rev-parse", "HEAD"]);
    const statusAfter = await runGit(repository.path, ["status", "--porcelain"]);
    const refsAfter = await runGit(repository.path, ["for-each-ref"]);
    const objectsAfter = await runGit(repository.path, ["count-objects", "-v"]);

    expect(headAfter.stdout).toBe(headBefore.stdout);
    expect(statusAfter.stdout).toBe(statusBefore.stdout);
    expect(statusBefore.stdout).toContain("M src/welcome.txt");
    expect(statusBefore.stdout).toContain("?? untracked.txt");
    expect(refsAfter.stdout).toBe(refsBefore.stdout);
    expect(objectsAfter.stdout).toBe(objectsBefore.stdout);
  });

  it("validates a pinned commit and rejects references that are not exactly one commit", async () => {
    const repository = await createSyntheticRepository();
    const adapter = createGitWorkspaceAdapter({
      config: buildConfig(repository.path, repository.commit),
      workspacesDirectory: join(testDirectory, "workspaces"),
    });

    const validated = await adapter.validateSource({ id: "repo-1", path: repository.path }, repository.commit);
    const rejected = await adapter.validateSource(
      { id: "repo-1", path: repository.path },
      "f".repeat(40),
    );

    expect(validated).toEqual({
      ok: true,
      value: { repositoryId: "repo-1", requestedCommit: repository.commit, resolvedCommit: repository.commit },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.kind).toBe("SourceMaterializationError");
      expect(rejected.error.taskId).toBe("repo-1");
    }
  });

  it("reports workspace readability and disposes the case directory", async () => {
    const { adapter, workspace } = await sealCaseFromSyntheticRepository("task-1--c1");
    const readableBefore = await adapter.isReadable?.(workspace);

    await rm(join(workspace.repositoryDirectory, "HEAD"));

    const readableAfterCorruption = await adapter.isReadable?.(workspace);
    const disposed = await adapter.dispose(workspace);

    expect(readableBefore).toBe(true);
    expect(readableAfterCorruption).toBe(false);
    expect(disposed.ok).toBe(true);
    expect(existsSync(join(testDirectory, "workspaces", "task-1--c1"))).toBe(false);
  });
});

async function createBaseRepository(name: string): Promise<string> {
  const path = join(testDirectory, name);
  await mkdir(path, { recursive: true });
  await runGit(path, ["init", "--quiet", "-b", "main"]);
  await writeFile(join(path, "README.md"), "synthetic source\n");
  await runGit(path, ["add", "-A"]);
  await runGit(path, [...GIT_IDENTITY_FLAGS, "commit", "--quiet", "-m", "synthetic base commit"]);
  return path;
}

async function sourceFingerprint(repositoryPath: string): Promise<{
  head: string;
  status: string;
  objects: string;
}> {
  const head = await runGit(repositoryPath, ["rev-parse", "HEAD"]);
  const status = await runGit(repositoryPath, ["status", "--porcelain"]);
  const objects = await runGit(repositoryPath, ["count-objects", "-v"]);
  return { head: head.stdout, status: status.stdout, objects: objects.stdout };
}

describe("unsupported source rejection", () => {
  it("rejects a synthetic gitlink without disclosing the submodule path", async () => {
    const repositoryPath = await createBaseRepository("gitlink-source");
    const baseCommit = (await runGit(repositoryPath, ["rev-parse", "HEAD"])).stdout.trim();
    await runGit(repositoryPath, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${baseCommit},vendor/dependency`,
    ]);
    await runGit(repositoryPath, [...GIT_IDENTITY_FLAGS, "commit", "--quiet", "-m", "synthetic gitlink commit"]);
    const commit = (await runGit(repositoryPath, ["rev-parse", "HEAD"])).stdout.trim();
    const before = await sourceFingerprint(repositoryPath);

    const rejected = await createGitAdapter(repositoryPath, commit).validateSource(
      { id: "repo-1", path: repositoryPath },
      commit,
    );
    const after = await sourceFingerprint(repositoryPath);

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toEqual({
        kind: "SourceMaterializationError",
        taskId: "repo-1",
        reason: 'repository "repo-1": source tree contains 1 unsupported submodule entry',
      });
    }
    expect(after).toEqual(before);
  });

  it("rejects a tracked Git LFS pointer without disclosing the blob filename", async () => {
    const repositoryPath = await createBaseRepository("lfs-pointer-source");
    await mkdir(join(repositoryPath, "assets"), { recursive: true });
    await writeFile(
      join(repositoryPath, "assets/model.bin"),
      "version https://git-lfs.github.com/spec/v1\noid sha256:0000000000000000000000000000000000000000000000000000000000000000\nsize 12\n",
    );
    await runGit(repositoryPath, ["add", "assets/model.bin"]);
    await runGit(repositoryPath, [...GIT_IDENTITY_FLAGS, "commit", "--quiet", "-m", "synthetic lfs pointer commit"]);
    const commit = (await runGit(repositoryPath, ["rev-parse", "HEAD"])).stdout.trim();
    const before = await sourceFingerprint(repositoryPath);

    const rejected = await createGitAdapter(repositoryPath, commit).validateSource(
      { id: "repo-1", path: repositoryPath },
      commit,
    );
    const after = await sourceFingerprint(repositoryPath);

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toEqual({
        kind: "SourceMaterializationError",
        taskId: "repo-1",
        reason: 'repository "repo-1": source tree contains 1 unsupported Git LFS pointer blob',
      });
    }
    expect(after).toEqual(before);
  });

  it("rejects Git LFS attributes without disclosing the attributes path", async () => {
    const repositoryPath = await createBaseRepository("lfs-attributes-source");
    await writeFile(
      join(repositoryPath, ".gitattributes"),
      "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
    await runGit(repositoryPath, ["add", ".gitattributes"]);
    await runGit(repositoryPath, [...GIT_IDENTITY_FLAGS, "commit", "--quiet", "-m", "synthetic lfs attributes commit"]);
    const commit = (await runGit(repositoryPath, ["rev-parse", "HEAD"])).stdout.trim();
    const before = await sourceFingerprint(repositoryPath);

    const rejected = await createGitAdapter(repositoryPath, commit).validateSource(
      { id: "repo-1", path: repositoryPath },
      commit,
    );
    const after = await sourceFingerprint(repositoryPath);

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toEqual({
        kind: "SourceMaterializationError",
        taskId: "repo-1",
        reason: 'repository "repo-1": source tree configures unsupported Git LFS attributes',
      });
    }
    expect(after).toEqual(before);
  });
});

describe("pre-evaluation patch capture", () => {
  it("captures model commits and new files while excluding later evaluator mutations", async () => {
    const { adapter, workspace } = await sealCaseFromSyntheticRepository("task-1--c1");

    await writeFile(join(workspace.worktreeDirectory, "src/welcome.txt"), `${SOURCE_TEXT}model edit\n`);
    await writeFile(
      join(workspace.worktreeDirectory, "assets/logo.bin"),
      Buffer.concat([SOURCE_BINARY, Buffer.from([0x01, 0x02, 0x03])]),
    );
    await runGit(workspace.worktreeDirectory, ["add", "-A"]);
    await runGit(workspace.worktreeDirectory, [...GIT_IDENTITY_FLAGS, "commit", "--quiet", "-m", "synthetic model commit"]);
    await writeFile(join(workspace.worktreeDirectory, "src/model-added.txt"), "added by the model\n");

    const modelPatch = unwrapOk(await adapter.capturePatch(workspace));

    await writeFile(join(workspace.worktreeDirectory, "src/evaluator-mutation.txt"), "evaluator mutation\n");
    const postEvaluationPatch = unwrapOk(await adapter.capturePatch(workspace));

    expect(modelPatch.isEmpty).toBe(false);
    expect(modelPatch.content).toContain("diff --git a/src/welcome.txt");
    expect(modelPatch.content).toContain("GIT binary patch");
    expect(modelPatch.content).toContain("new file mode");
    expect(modelPatch.content).toContain("src/model-added.txt");
    expect(modelPatch.content).not.toContain("evaluator-mutation");

    expect(postEvaluationPatch.content).toContain("src/evaluator-mutation.txt");

    const stagedInRealIndex = await runGit(workspace.worktreeDirectory, ["diff", "--cached", "--name-only"]);
    expect(stagedInRealIndex.stdout).toBe("");
  });
});

describe("isolated case environments", () => {
  it("builds separate replacement environments with private homes and no host state", async () => {
    const config = buildConfig("/synthetic/source", "f".repeat(40));
    const adapter = createEnvironmentAdapter();
    const snapshot = adapter.snapshotParent(config);
    const workspace = buildFabricatedWorkspace("task-1--c1");
    await mkdir(workspace.runtimeDirectory, { recursive: true });

    const environments = await adapter.createCaseEnvironments(workspace, unwrapOk(snapshot), config, "opencode");
    const { evaluator } = unwrapOk(environments);
    const agent = requireAgentEnvironment(unwrapOk(environments));

    expect(Object.keys(agent.variables).sort()).toEqual(AGENT_ENV_KEYS);
    expect(Object.keys(evaluator.variables).sort()).toEqual([...FIXED_EVALUATOR_KEYS].sort());
    expect(agent.variables.LANG).toBe("C.UTF-8");
    expect(agent.variables.LC_ALL).toBe("C.UTF-8");
    expect(agent.variables.CI).toBe("1");
    expect(agent.variables.PATH).toBe(unwrapOk(snapshot).path);
    expect(agent.variables[PROVIDER_NAME]).toBe(PROVIDER_VALUE);
    expect(agent.variables[SECRET_NAME]).toBe(SECRET_VALUE);
    expect(agent.variables.HOME).toBe(agent.homeDirectory);
    expect(agent.variables.TMPDIR).toBe(agent.temporaryDirectory);
    expect(agent.homeDirectory.startsWith(workspace.runtimeDirectory)).toBe(true);
    expect(agent.variables.HOME).not.toBe(process.env.HOME);
    expect(agent.variables.XDG_DATA_HOME).not.toBe(HOST_XDG_DATA);
    expect(evaluator.homeDirectory.startsWith(workspace.runtimeDirectory)).toBe(true);
    expect(agent.homeDirectory).not.toBe(evaluator.homeDirectory);

    const evaluatorValues = JSON.stringify(evaluator.variables);
    expect(evaluatorValues).not.toContain(PROVIDER_VALUE);
    expect(evaluatorValues).not.toContain(SECRET_VALUE);
    expect(evaluatorValues).not.toContain(HOST_SENTINEL_VALUE);
    expect(evaluatorValues).not.toContain(UNLISTED_VALUE);
    expect(JSON.stringify(agent.variables)).not.toContain(HOST_SENTINEL_VALUE);
    expect(JSON.stringify(agent.variables)).not.toContain(UNLISTED_VALUE);

    for (const directory of [
      agent.homeDirectory,
      agent.temporaryDirectory,
      evaluator.homeDirectory,
      evaluator.temporaryDirectory,
      agent.variables.XDG_CONFIG_HOME,
      evaluator.variables.XDG_STATE_HOME,
    ]) {
      await stat(directory);
    }
    const agentConfigHome = await stat(agent.variables.XDG_CONFIG_HOME);
    expect(agentConfigHome.isDirectory()).toBe(true);

    expect(agent.variableManifest).toEqual(
      expect.arrayContaining([
        { name: PROVIDER_NAME, classification: "secret", recipient: "agent" },
        { name: SECRET_NAME, classification: "secret", recipient: "agent" },
      ]),
    );
    expect(evaluator.variableManifest).toEqual(
      expect.arrayContaining([{ name: EVAL_NAME, classification: "ordinary", recipient: "evaluator" }]),
    );
    expect(JSON.stringify([...agent.variableManifest, ...evaluator.variableManifest])).not.toContain(PROVIDER_VALUE);
    expect(JSON.stringify([...agent.variableManifest, ...evaluator.variableManifest])).not.toContain(SECRET_VALUE);
  });

  it("keeps the parent snapshot immutable and passes only allowlisted ordinary values to evaluator checks", async () => {
    const config = buildConfig("/synthetic/source", "f".repeat(40));
    const adapter = createEnvironmentAdapter();
    const snapshot = adapter.snapshotParent(config);
    const snapshotValue = unwrapOk(snapshot);
    const snapshotClone = JSON.parse(JSON.stringify(snapshotValue)) as typeof snapshotValue;

    const firstWorkspace = buildFabricatedWorkspace("task-1--c1");
    const secondWorkspace = buildFabricatedWorkspace("task-1--c2");
    for (const workspace of [firstWorkspace, secondWorkspace]) {
      await mkdir(workspace.runtimeDirectory, { recursive: true });
    }
    const firstEnvironments = unwrapOk(
      await adapter.createCaseEnvironments(firstWorkspace, snapshotValue, config, "opencode"),
    );
    const secondEnvironments = unwrapOk(
      await adapter.createCaseEnvironments(secondWorkspace, snapshotValue, config, "opencode"),
    );
    const firstAgent = requireAgentEnvironment(firstEnvironments);
    const secondAgent = requireAgentEnvironment(secondEnvironments);

    expect(firstAgent.variables.PATH).toBe(snapshotValue.path);
    expect(secondAgent.variables.PATH).toBe(snapshotValue.path);
    expect(firstAgent.variables[PROVIDER_NAME]).toBe(snapshotValue.agentValues?.[PROVIDER_NAME]);
    expect(firstAgent.variables).not.toBe(secondAgent.variables);
    secondEnvironments.evaluator.variables.TEVU_IT_SCRATCH = "scratch";
    expect(firstEnvironments.evaluator.variables.TEVU_IT_SCRATCH).toBeUndefined();
    expect(snapshotValue).toEqual(snapshotClone);

    const checkEnvironment = buildCheckEnvironment(firstEnvironments.evaluator, snapshotValue, [
      EVAL_NAME,
      "HOME",
      "TEVU_IT_MISSING",
    ]);

    expect(checkEnvironment[EVAL_NAME]).toBe(ORDINARY_VALUE);
    expect(checkEnvironment.HOME).toBe(firstEnvironments.evaluator.variables.HOME);
    expect(Object.keys(checkEnvironment).sort()).toEqual([...FIXED_EVALUATOR_KEYS, EVAL_NAME].sort());
    expect(checkEnvironment.TEVU_IT_MISSING).toBeUndefined();
    expect(JSON.stringify(checkEnvironment)).not.toContain(PROVIDER_VALUE);
    expect(JSON.stringify(checkEnvironment)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(checkEnvironment)).not.toContain(HOST_SENTINEL_VALUE);
    expect(JSON.stringify(checkEnvironment)).not.toContain(UNLISTED_VALUE);

    expect(snapshotValue.secretValues).toContain(PROVIDER_VALUE);
    expect(snapshotValue.secretValues).toContain(SECRET_VALUE);
  });

  it("runs a real process whose environment is exactly the isolated replacement set", async () => {
    const config = buildConfig("/synthetic/source", "f".repeat(40));
    const adapter = createEnvironmentAdapter();
    const snapshotValue = unwrapOk(adapter.snapshotParent(config));
    const workspace = buildFabricatedWorkspace("task-1--c1");
    await mkdir(workspace.runtimeDirectory, { recursive: true });
    const environments = unwrapOk(await adapter.createCaseEnvironments(workspace, snapshotValue, config, "opencode"));
    const agent = requireAgentEnvironment(environments);

    const outcome = expectLaunched(
      await runManagedProcess({
        argv: [process.execPath, "-e", ENVIRONMENT_PROBE_SCRIPT],
        cwd: testDirectory,
        environment: agent.variables,
        timeoutMs: 10_000,
        terminationGraceMs: 250,
        secretValues: [PROVIDER_VALUE, SECRET_VALUE],
      }),
    );

    const reported = JSON.parse(outcome.stdout.text) as {
      home: string;
      provider: string;
      secret: string;
      ordinary: string | undefined;
      hostSentinel: string | undefined;
      keys: string[];
    };
    expect(outcome.exitCode).toBe(0);
    expect(outcome.terminationStage).toBe("none");
    expect(reported.home).toBe(agent.homeDirectory);
    expect(reported.provider).toBe("[REDACTED]");
    expect(reported.secret).toBe("[REDACTED]");
    expect(reported.ordinary).toBeUndefined();
    expect(reported.hostSentinel).toBeUndefined();
    expect(reported.keys).toEqual(AGENT_ENV_KEYS);
    expect(outcome.stdout.text).not.toContain(PROVIDER_VALUE);
    expect(outcome.stdout.text).not.toContain(SECRET_VALUE);

    const evaluatorOutcome = expectLaunched(
      await runManagedProcess({
        argv: [process.execPath, "-e", ENVIRONMENT_PROBE_SCRIPT],
        cwd: testDirectory,
        environment: buildCheckEnvironment(environments.evaluator, snapshotValue, [EVAL_NAME]),
        timeoutMs: 10_000,
        terminationGraceMs: 250,
        secretValues: [PROVIDER_VALUE, SECRET_VALUE],
      }),
    );
    const evaluatorReported = JSON.parse(evaluatorOutcome.stdout.text) as {
      home: string;
      provider: string | undefined;
      ordinary: string;
      keys: string[];
    };
    expect(evaluatorReported.keys).toEqual([...FIXED_EVALUATOR_KEYS, EVAL_NAME].sort());
    expect(evaluatorReported.home).toBe(environments.evaluator.homeDirectory);
    expect(evaluatorReported.ordinary).toBe(ORDINARY_VALUE);
    expect(evaluatorReported.provider).toBeUndefined();
    expect(evaluatorOutcome.stdout.text).not.toContain("[REDACTED]");
  });
});

describe("credential-secret redaction", () => {
  it("redacts secrets that span streaming chunk boundaries without losing text", () => {
    const first = createStreamingRedactor([PROVIDER_VALUE]);
    const second = createStreamingRedactor([PROVIDER_VALUE]);
    const third = createStreamingRedactor([PROVIDER_VALUE]);

    const twoWay = `${first.push(`before ${PROVIDER_VALUE.slice(0, 15)}`)}${first.push(`${PROVIDER_VALUE.slice(15)} after`)}${first.flush()}`;
    const threeWay = [
      second.push(`prefix ${PROVIDER_VALUE.slice(0, 21)}`),
      second.push(PROVIDER_VALUE.slice(21, 28)),
      second.push(`${PROVIDER_VALUE.slice(28)} done`),
      second.flush(),
    ].join("");
    const danglingPartial = `${third.push("tail synthetic-sec")}${third.flush()}`;

    expect(twoWay).toBe("before [REDACTED] after");
    expect(twoWay).not.toContain(PROVIDER_VALUE);
    expect(threeWay).toBe("prefix [REDACTED] done");
    expect(danglingPartial).toBe("tail synthetic-sec");

    const wholeText = createRedactor(["alpha-secret-extended", "secret-extended"]);
    expect(wholeText("x alpha-secret-extended y")).toBe("x [REDACTED] y");
    expect(createRedactor([""])("plain text")).toBe("plain text");
  });

  it("redacts secrets at the managed stderr sink before capture", async () => {
    const config = buildConfig("/synthetic/source", "f".repeat(40));
    const snapshotValue = unwrapOk(createEnvironmentAdapter().snapshotParent(config));

    const outcome = expectLaunched(
      await runManagedProcess({
        argv: [process.execPath, "-e", STDERR_SECRET_PROBE_SCRIPT],
        cwd: testDirectory,
        environment: {
          PATH: process.env.PATH ?? "",
          [PROVIDER_NAME]: PROVIDER_VALUE,
        },
        timeoutMs: 10_000,
        terminationGraceMs: 250,
        secretValues: snapshotValue.secretValues,
      }),
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr.text).toBe("[REDACTED]\n");
    expect(outcome.stderr.text).not.toContain(PROVIDER_VALUE);
    expect(outcome.stderr.totalBytes).toBe(Buffer.byteLength("[REDACTED]\n", "utf8"));
  });

  it("bounds captured output and reports the untruncated total size", async () => {
    const outcome = expectLaunched(
      await runManagedProcess({
        argv: [process.execPath, "-e", "process.stdout.write('0123456789'.repeat(10));"],
        cwd: testDirectory,
        environment: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10_000,
        terminationGraceMs: 250,
        maxCaptureBytes: 16,
      }),
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.stdout.text, "utf8")).toBeLessThanOrEqual(16);
    expect(outcome.stdout.totalBytes).toBe(100);
  });
});

describe("process-group termination", () => {
  it("reports a launch failure with the ENOENT code for a nonexistent executable", async () => {
    const result = await runManagedProcess({
      argv: ["definitely-not-installed", "--version"],
      cwd: testDirectory,
      environment: { PATH: process.env.PATH ?? "", HOME: testDirectory },
      timeoutMs: 1_000,
      terminationGraceMs: 250,
    });

    expect(result.launched).toBe(false);
    if (result.launched) return;
    expect(result.code).toBe("ENOENT");
  });

  it("terminates a timed-out process group gracefully and reaps descendants", async () => {
    const pidFile = join(testDirectory, "pids-graceful.json");

    const outcome = expectLaunched(
      await runManagedProcess({
        argv: [process.execPath, "-e", buildChildScript(pidFile, {
          trapSignal: false,
          grandchildScript: MORTAL_GRANDCHILD_SCRIPT,
        })],
        cwd: testDirectory,
        environment: { PATH: process.env.PATH ?? "", HOME: testDirectory },
        timeoutMs: 1_000,
        terminationGraceMs: 250,
      }),
    );

    expect(outcome.timedOut).toBe(true);
    expect(outcome.terminationStage).toBe("graceful");
    expect(outcome.signal).toBe("SIGTERM");
    await waitForDescendantsReaped(pidFile);
  });

  it("forces termination when the group traps SIGTERM and reaps trapped descendants", async () => {
    const pidFile = join(testDirectory, "pids-forced.json");

    const outcome = expectLaunched(
      await runManagedProcess({
        argv: [process.execPath, "-e", buildChildScript(pidFile, {
          trapSignal: true,
          grandchildScript: SURVIVOR_GRANDCHILD_SCRIPT,
        })],
        cwd: testDirectory,
        environment: { PATH: process.env.PATH ?? "", HOME: testDirectory },
        timeoutMs: 1_000,
        terminationGraceMs: 250,
      }),
    );

    expect(outcome.timedOut).toBe(true);
    expect(outcome.terminationStage).toBe("forced");
    expect(outcome.signal).toBe("SIGKILL");
    await waitForDescendantsReaped(pidFile);
  });

  it("reaps a grandchild that outlives the supervised process while holding its output pipes", async () => {
    const pidFile = join(testDirectory, "pids-survivor.json");

    const outcome = expectLaunched(
      await runManagedProcess({
        argv: [process.execPath, "-e", buildChildScript(pidFile, {
          trapSignal: false,
          exitAfterMs: 150,
          grandchildScript: SURVIVOR_GRANDCHILD_SCRIPT,
        })],
        cwd: testDirectory,
        environment: { PATH: process.env.PATH ?? "", HOME: testDirectory },
        timeoutMs: 10_000,
        terminationGraceMs: 300,
      }),
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.terminationStage).toBe("none");
    await waitForDescendantsReaped(pidFile);
  });
});