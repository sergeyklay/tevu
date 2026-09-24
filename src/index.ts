#!/usr/bin/env node
/**
 * Executable composition root: instantiates the concrete adapters, wires the
 * shared secret redactor, stable run-ID and configuration-digest generators,
 * the wall clock, the standard streams, and bounded signal cancellation into
 * the program factory, then sets the mapped process exit code. Only
 * dependency wiring and signal forwarding live here; no orchestration,
 * evaluation, transport, or persistence logic.
 */

import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createArtifactStore, createConfigStore } from "./adapters/artifact-store.ts";
import { createGitWorkspaceAdapter } from "./adapters/git.ts";
import { buildTaskPrompt, createOpenCodeAdapter } from "./adapters/opencode.ts";
import {
  createEnvironmentAdapter,
  createEvaluatorProcessAdapter,
  createPrerequisiteAdapter,
  createRedactor,
  runManagedProcess,
} from "./adapters/process.ts";
import {
  createGitHubIssuesAdapter,
  GH_CREDENTIAL_ENVIRONMENT_VARIABLES,
} from "./adapters/trackers/github-issues.ts";
import { createJiraCloudAdapter } from "./adapters/trackers/jira-cloud.ts";
import { assessCase, rebuildReport } from "./application/assess.ts";
import { createTask } from "./application/create-task.ts";
import { planBenchmark, runBenchmark } from "./application/run-benchmark.ts";
import { validateConfig } from "./application/validate.ts";
import { canonicalConfigSerialization, loadConfig, resolveConfigPath } from "./config/load.ts";
import { orderTaskChecks } from "./evaluation/checks.ts";
import { runProgram } from "./interface/program.ts";

import type { RepositoryDefinition, TevuConfig } from "./config/schema.ts";
import type {
  ArtifactStore,
  Clock,
  EnvironmentAdapter,
  GitWorkspaceAdapter,
  LoadConfigErrorKind,
  OpenCodeAdapter,
  TaskWizardInput,
  TevuResult,
} from "./domain/types.ts";
import type {
  ProgramDependencies,
  ProgramIo,
  ProgramOperations,
} from "./interface/program.ts";
import type { AssessmentCaseContext } from "./interface/task-wizard.ts";

/** Optional overrides for composing the production dependency graph. */
export type CompositionOptions = {
  io?: ProgramIo;
  cancellation?: AbortSignal;
};

/** Grows as configurations and run-level snapshots reveal secret values, so every sink redacts coherently. */
type SecretRegistry = {
  add(candidates: Iterable<string | undefined>): void;
  read(): readonly string[];
  redact(text: string): string;
};

/**
 * Composes the production dependency graph: real adapters behind the injected
 * operation ports, one shared secret registry backing every redaction sink,
 * and the stable run-ID, digest, and clock sources.
 */
export function composeProgramDependencies(options: CompositionOptions = {}): ProgramDependencies {
  const io: ProgramIo = options.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const cancellation = options.cancellation ?? new AbortController().signal;
  const registry = createSecretRegistry();
  const clock: Clock = { now: () => new Date() };
  const prerequisites = createPrerequisiteAdapter();
  const configStore = createConfigStore({ redact: registry.redact });
  const environments = wrapEnvironmentAdapter(createEnvironmentAdapter(), registry);

  const loadConfigAndRegisterSecrets = async (
    configPath: string,
  ): Promise<TevuResult<TevuConfig, LoadConfigErrorKind>> => {
    const loaded = await loadConfig(configPath);
    if (loaded.ok) {
      registerConfigSecrets(registry, loaded.value);
    }
    return loaded;
  };

  const gitFor = (config: TevuConfig): GitWorkspaceAdapter =>
    createGitWorkspaceAdapter({ config, workspacesDirectory: createWorkspacesRoot() });

  const opencodeFor = (config: TevuConfig): OpenCodeAdapter =>
    createOpenCodeAdapter({ executable: config.opencode.executable, readSecretValues: registry.read });

  const storeFor = (config: TevuConfig): ArtifactStore =>
    createArtifactStore({ artifactsDirectory: config.artifacts.directory, redact: registry.redact });

  const operations: ProgramOperations = {
    configExists: (configPath) => configStore.exists(configPath),
    loadConfig: loadConfigAndRegisterSecrets,
    requireConfigDirectory: (configPath) => configStore.requireDirectory(configPath),
    importJiraIssue: (settings, issueKey) => {
      registry.add([process.env[settings.tokenEnvironmentVariable]]);
      const jira = createJiraCloudAdapter(settings, {
        fetch: (url, init) => globalThis.fetch(url, init),
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        getEnvironmentVariable: (name) => process.env[name],
      });
      return jira.readIssue(issueKey);
    },
    importGitHubIssue: (reference) => {
      registry.add(GH_CREDENTIAL_ENVIRONMENT_VARIABLES.map((name) => process.env[name]));
      const github = createGitHubIssuesAdapter({
        runGh: (request) =>
          runManagedProcess({
            ...request,
            cwd: process.cwd(),
            secretValues: registry.read(),
            stdoutRedaction: "structured",
          }),
        parentEnvironment: process.env,
        cancellation,
      });
      return github.readIssue(reference);
    },
    createTask: async (input) => {
      const resolved = resolveWizardRepositoryPaths(input);
      const adapterConfig =
        resolved.bootstrap === undefined
          ? await loadConfigAndRegisterSecrets(resolved.configPath)
          : projectBootstrapConfig(resolved.bootstrap);
      if (!adapterConfig.ok) {
        return adapterConfig;
      }
      return createTask(resolved, {
        configStore,
        git: gitFor(adapterConfig.value),
        jira: null,
        clock,
        cancellation,
      });
    },
    validateConfig: (config) =>
      validateConfig(config, {
        git: gitFor(config),
        opencode: opencodeFor(config),
        environments,
        prerequisites,
        buildTaskPrompt,
      }),
    planBenchmark,
    executeBenchmark: async (plan, hooks) => {
      const clearCancellationExit = scheduleBoundedCancellationExit(hooks.cancellation, plan.terminationGraceMs);
      try {
        return await runBenchmark(plan, {
        git: gitFor(plan.config),
        opencode: opencodeFor(plan.config),
        artifacts: createArtifactStore({
          artifactsDirectory: plan.artifactsDirectory,
          redact: registry.redact,
        }),
        evaluatorProcesses: createEvaluatorProcessAdapter(registry.read),
        environments,
        prerequisites,
        clock,
        generateRunId: (startedAt) => {
          const runId = generateRunId(startedAt);
          hooks.onRunId?.(runId);
          return runId;
        },
        configDigest: (config) => sha256Hex(canonicalConfigSerialization(config)),
        buildTaskPrompt,
        redact: registry.redact,
        cancellation: hooks.cancellation,
        onLifecycle: hooks.onLifecycle,
        });
      } finally {
        clearCancellationExit();
      }
    },
    rebuildRunReport: (config, runId) => rebuildReport(runId, storeFor(config)),
    readAssessmentContext: (config, runId, caseId) =>
      readAssessmentContext(storeFor(config), runId, caseId),
    applyAssessment: (config, input) => assessCase(input, storeFor(config)),
  };

  return {
    io,
    operations,
    now: () => new Date(),
    redact: registry.redact,
    cancellation,
  };
}

/**
 * Runs the `tevu` executable: wires interrupt signals to graceful bounded
 * cancellation, composes
 * the production dependencies, and returns the mapped exit code.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  const onInterrupt = createInterruptHandler(controller);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  try {
    return await runProgram(argv, composeProgramDependencies({ cancellation: controller.signal }));
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}

/** Repeated interrupts share the same bounded process-group cancellation. */
function createInterruptHandler(controller: AbortController): () => void {
  return () => {
    controller.abort();
  };
}

function createSecretRegistry(): SecretRegistry {
  const values = new Set<string>();
  return {
    add(candidates: Iterable<string | undefined>): void {
      for (const candidate of candidates) {
        if (candidate !== undefined && candidate.length > 0) {
          values.add(candidate);
        }
      }
    },
    read: () => [...values],
    redact: (text) => createRedactor([...values])(text),
  };
}

/** Registers the values of credential-classified variables and the Jira token, mirroring the run-level snapshot. */
function registerConfigSecrets(registry: SecretRegistry, config: TevuConfig): void {
  const names = config.execution.opencodeEnvironment
    .filter((entry) => entry.classification !== "ordinary")
    .map((entry) => entry.name);
  if (config.jira !== undefined) {
    names.push(config.jira.tokenEnvironmentVariable);
  }
  registry.add(names.map((name) => process.env[name]));
}

/** Records run-level snapshot secrets in the shared registry so later sinks redact them too. */
function wrapEnvironmentAdapter(
  adapter: EnvironmentAdapter,
  registry: SecretRegistry,
): EnvironmentAdapter {
  return {
    snapshotParent(config) {
      const snapshot = adapter.snapshotParent(config);
      if (snapshot.ok) {
        registry.add(snapshot.value.secretValues);
      }
      return snapshot;
    },
    createCaseEnvironments: (workspace, snapshot, config) =>
      adapter.createCaseEnvironments(workspace, snapshot, config),
  };
}

/**
 * Resolves wizard-captured relative repository and artifact paths against the
 * configuration file directory, matching the loader's path semantics, so Git
 * validation and the single configuration replacement see resolved paths.
 */
function resolveWizardRepositoryPaths(input: TaskWizardInput): TaskWizardInput {
  const configDirectory = path.dirname(path.resolve(input.configPath));
  const resolveRepository = (repository: RepositoryDefinition): RepositoryDefinition => ({
    ...repository,
    path: resolveConfigPath(configDirectory, repository.path),
  });
  return {
    ...input,
    bootstrap:
      input.bootstrap === undefined
        ? undefined
        : {
            ...input.bootstrap,
            artifacts: {
              directory: resolveConfigPath(configDirectory, input.bootstrap.artifacts.directory),
            },
            repositories: input.bootstrap.repositories.map(resolveRepository),
          },
    newRepository: input.newRepository === undefined ? undefined : resolveRepository(input.newRepository),
  };
}

/** Projects bootstrap answers as a configuration value for adapter construction; tasks arrive via `createTask`. */
function projectBootstrapConfig(
  bootstrap: NonNullable<TaskWizardInput["bootstrap"]>,
): TevuResult<TevuConfig, LoadConfigErrorKind> {
  return {
    ok: true,
    value: {
      version: 1,
      artifacts: bootstrap.artifacts,
      execution: bootstrap.execution,
      opencode: bootstrap.opencode,
      ...(bootstrap.jira === undefined ? {} : { jira: bootstrap.jira }),
      repositories: bootstrap.repositories,
      contenders: bootstrap.contenders,
      tasks: [],
    },
  };
}

/**
 * Builds the assessment wizard's display context from preserved run artifacts
 * only: the manifest's preserved configuration supplies the manual checks in
 * configuration order, and the current assessment records come from the
 * versioned assessment artifact.
 */
async function readAssessmentContext(
  store: ArtifactStore,
  runId: string,
  caseId: string,
): Promise<TevuResult<AssessmentCaseContext, "ConfigValidationError" | "ArtifactError">> {
  const manifest = await store.readRunManifest(runId);
  if (!manifest.ok) {
    return manifest;
  }
  const context = manifest.value.context;
  if (context === undefined) {
    return {
      ok: false,
      error: {
        kind: "ArtifactError",
        operation: "read-run-manifest",
        reason: `run "${runId}" preserves no configuration context; it cannot be assessed`,
      },
    };
  }
  const identity = manifest.value.cases.find((candidate) => candidate.caseId === caseId);
  if (identity === undefined) {
    return {
      ok: false,
      error: {
        kind: "ConfigValidationError",
        findings: [
          {
            severity: "error",
            identifier: caseId,
            message: `case "${caseId}" is not part of run "${runId}"`,
          },
        ],
      },
    };
  }
  const task = context.config.tasks.find((candidate) => candidate.id === identity.taskId);
  if (task === undefined) {
    return {
      ok: false,
      error: {
        kind: "ArtifactError",
        operation: "read-run-manifest",
        reason: `task "${identity.taskId}" is missing from the preserved run configuration`,
      },
    };
  }
  const manualChecks = orderTaskChecks(task)
    .filter((check) => check.definition.evaluator.kind === "manual")
    .map((check) => ({
      checkId: check.definition.id,
      category: check.category,
      description: check.definition.description,
      required: check.definition.required,
    }));
  const assessment = await store.readAssessment(runId, caseId);
  if (!assessment.ok) {
    return assessment;
  }
  return { ok: true, value: { manualChecks, existing: assessment.value?.current ?? [] } };
}

/** One private sealed-workspace root per adapter instance, outside repositories and artifacts. */
function createWorkspacesRoot(): string {
  return path.join(tmpdir(), `tevu-workspaces-${randomBytes(6).toString("hex")}`);
}

/** UTC basic timestamp plus a collision-resistant lowercase hexadecimal suffix. */
function generateRunId(startedAt: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp =
    `${startedAt.getUTCFullYear()}${pad(startedAt.getUTCMonth() + 1)}${pad(startedAt.getUTCDate())}` +
    `t${pad(startedAt.getUTCHours())}${pad(startedAt.getUTCMinutes())}${pad(startedAt.getUTCSeconds())}z`;
  return `${stamp}-${randomBytes(6).toString("hex")}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Forces exit 130 when a cancelled run outlives its bounded finalization:
 * one grace period before forced process-group termination, followed by one
 * additional grace period for final artifact writes.
 */
function scheduleBoundedCancellationExit(
  cancellation: AbortSignal,
  terminationGraceMs: number,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    timer = setTimeout(() => {
      process.exit(130);
    }, terminationGraceMs * 2);
    timer.unref();
  };
  if (cancellation.aborted) {
    arm();
  } else {
    cancellation.addEventListener("abort", arm, { once: true });
  }
  return () => {
    cancellation.removeEventListener("abort", arm);
    clearTimeout(timer);
  };
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("tevu failed unexpectedly; command could not complete\n");
      process.exitCode = 1;
    },
  );
}
