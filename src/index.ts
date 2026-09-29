#!/usr/bin/env node
/**
 * Executable composition root: instantiates the concrete adapters, wires the
 * shared secret redactor, stable run-ID and configuration-digest generators,
 * the wall clock, the standard streams, and bounded signal cancellation into
 * the program factory, then sets the mapped process exit code. Only
 * dependency wiring and signal forwarding live here; no orchestration,
 * evaluation, transport, or persistence logic.
 */
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createOpenCodeAdapter } from '@/adapters/agents/opencode/opencode';
import { createArtifactStore, createConfigStore } from '@/adapters/artifact-store';
import { createGitWorkspaceAdapter, createSourceValidator } from '@/adapters/git';
import { createManagedCloneAdapter } from '@/adapters/managed-clone';
import {
  createCaseExecutableAdapter,
  createEnvironmentAdapter,
  createEvaluatorProcessAdapter,
  createPrerequisiteAdapter,
  createRedactor,
  createSecretRedactor,
  runManagedProcess,
} from '@/adapters/process';
import {
  createGitHubIssuesAdapter,
  createGitHubPullRequestReader,
} from '@/adapters/trackers/github-issues';
import { createJiraCloudAdapter } from '@/adapters/trackers/jira-cloud';
import { assessCase, readAssessmentContext, rebuildReport } from '@/application/assess';
import { createTask } from '@/application/create-task';
import { draftCriteria } from '@/application/draft-criteria';
import { ensureManagedCommits, prepareManagedRepositories } from '@/application/managed-clone';
import { checkModelAccess, inspectModelProvider, probeAgent } from '@/application/model-access';
import { resolveReferenceSolution } from '@/application/reference-solution';
import { planBenchmark, runBenchmark } from '@/application/run-benchmark';
import { validateConfig } from '@/application/validate';
import { canonicalConfigSerialization, loadConfig } from '@/config/load';
import { locateConfig, managedCloneRoot as resolveManagedCloneRoot } from '@/config/locate';
import { referencedVariableName } from '@/config/schema';
import { GH_CREDENTIAL_ENVIRONMENT_VARIABLES } from '@/domain/github-cli';
import { runProgram } from '@/interface/program';

import type { JiraCloudSettings } from '@/adapters/trackers/jira-cloud';
import type { ManagedCloneDependencies } from '@/application/managed-clone';
import type { ModelAccessDependencies } from '@/application/model-access';
import type {
  AgentRegistry,
  ArtifactStore,
  Clock,
  EnvironmentAdapter,
  GitWorkspaceAdapter,
  LoadConfigErrorKind,
  TevuConfig,
  TevuResult,
} from '@/domain/types';
import type { ProgramDependencies, ProgramIo, ProgramOperations } from '@/interface/program';
import type { Writable } from 'node:stream';

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
  const caseExecutables = createCaseExecutableAdapter();
  const configStore = createConfigStore({ redact: registry.redact });
  const environments = wrapEnvironmentAdapter(createEnvironmentAdapter(), registry);
  const cloneRoot = resolveManagedCloneRoot({
    home: process.env['HOME'],
    xdgCacheHome: process.env['XDG_CACHE_HOME'],
  });

  registry.add(GH_CREDENTIAL_ENVIRONMENT_VARIABLES.map((name) => process.env[name]));
  const clones = createManagedCloneAdapter({
    runProcess: runManagedProcess,
    parentEnvironment: process.env,
    secretValues: registry.read,
    cancellation,
  });

  const loadConfigAndRegisterSecrets = async (
    configPath: string,
  ): Promise<TevuResult<TevuConfig, LoadConfigErrorKind>> => {
    const loaded = await loadConfig(configPath, configStore, cloneRoot);
    if (loaded.ok) {
      registerConfigSecrets(registry, loaded.value);
    }
    return loaded;
  };

  const createGit = (): GitWorkspaceAdapter =>
    createGitWorkspaceAdapter({ workspacesDirectory: createWorkspacesRoot() });

  const secrets = createSecretRedactor(registry.read, registry.redact);

  const managedCloneDependencies = (
    onProgress: (line: string) => void,
  ): ManagedCloneDependencies => ({
    clones,
    git: createSourceValidator(),
    managedCloneRoot: cloneRoot,
    onProgress,
  });

  const pullRequests = createGitHubPullRequestReader({
    runGh: (ghRequest) => {
      registry.add(GH_CREDENTIAL_ENVIRONMENT_VARIABLES.map((name) => process.env[name]));
      return runManagedProcess({
        ...ghRequest,
        cwd: process.cwd(),
        secretValues: registry.read(),
        stdoutRedaction: 'structured',
      });
    },
    parentEnvironment: process.env,
    cancellation,
  });

  /** Registers every configured agent under its own name; currently the schema declares only "opencode". */
  const agentsFor = (config: Pick<TevuConfig, 'agents'>): AgentRegistry =>
    new Map([
      [
        'opencode',
        createOpenCodeAdapter(
          {
            agent: 'opencode',
            executable: config.agents.opencode.command,
            providers: config.agents.opencode.providers,
            declaredVariables: {
              secrets: config.agents.opencode.secrets,
              env: config.agents.opencode.env,
            },
          },
          {
            runProcess: runManagedProcess,
            secrets,
            probeEnvironment: { PATH: process.env['PATH'] ?? '' },
            probeDirectory: process.cwd(),
            operatorDirectories: {
              home: process.env['HOME'],
              xdgConfigHome: process.env['XDG_CONFIG_HOME'],
            },
          },
        ),
      ],
    ]);

  const modelAccess = (): ModelAccessDependencies => ({
    agentsFor,
    environments,
    git: createGit(),
    cancellation,
  });

  const storeFor = (config: TevuConfig): ArtifactStore =>
    createArtifactStore({ artifactsDirectory: config.run.output_dir, redact: registry.redact });

  const operations: ProgramOperations = {
    configExists: (configPath) => configStore.exists(configPath),
    loadConfig: loadConfigAndRegisterSecrets,
    requireConfigDirectory: (configPath) => configStore.requireDirectory(configPath),
    locateConfig: (requestedPath) =>
      locateConfig(
        requestedPath,
        {
          cwd: process.cwd(),
          home: process.env['HOME'],
          xdgConfigHome: process.env['XDG_CONFIG_HOME'],
        },
        configStore,
      ),
    importJiraIssue: (settings, issueKey) => {
      const jiraSettings: JiraCloudSettings = {
        baseUrl: settings.url,
        emailEnvironmentVariable: referencedVariableName(settings.email),
        tokenEnvironmentVariable: referencedVariableName(settings.token),
      };
      registry.add([process.env[jiraSettings.tokenEnvironmentVariable]]);
      const jira = createJiraCloudAdapter(jiraSettings, {
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
            stdoutRedaction: 'structured',
          }),
        parentEnvironment: process.env,
        cancellation,
      });
      return github.readIssue(reference);
    },
    resolveReference: (request, onProgress) =>
      resolveReferenceSolution(request, { ...managedCloneDependencies(onProgress), pullRequests }),
    ensureManagedCommits: (request, onProgress) =>
      ensureManagedCommits(request, managedCloneDependencies(onProgress)),
    draftCriteria: (request) =>
      draftCriteria(request, {
        agentsFor,
        environments,
        git: createGit(),
        pullRequests,
        managedCloneRoot: cloneRoot,
        registerSecrets: (names) => registry.add(names.map((name) => process.env[name])),
        redact: registry.redact,
        cancellation,
      }),
    probeAgent: (configPath, command) => probeAgent({ configPath, command }, modelAccess()),
    inspectModelProvider: (configPath, agent, model) =>
      inspectModelProvider({ configPath, agent, model }, modelAccess()),
    checkModelAccess: (configPath, agent, model) =>
      checkModelAccess({ configPath, agent, model }, modelAccess()),
    prepareRepositories: (config, onProgress) =>
      prepareManagedRepositories(config, managedCloneDependencies(onProgress)),
    createTask: (input) =>
      createTask(input, {
        configStore,
        git: createSourceValidator(),
        registerSecrets: (names) => registry.add(names.map((name) => process.env[name])),
        redact: registry.redact,
        managedCloneRoot: cloneRoot,
        cancellation,
      }),
    validateConfig: (config) =>
      validateConfig(config, {
        git: createGit(),
        agents: agentsFor(config),
        environments,
        prerequisites,
        clones: { inspectClone: clones.inspectClone },
        caseExecutables,
      }),
    planBenchmark,
    executeBenchmark: async (plan, hooks) => {
      const clearCancellationExit = scheduleBoundedCancellationExit(
        hooks.cancellation,
        plan.terminationGraceMs,
      );
      try {
        return await runBenchmark(plan, {
          git: createGit(),
          agents: agentsFor(plan.config),
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
          textDigest: sha256Hex,
          redact: registry.redact,
          cancellation: hooks.cancellation,
          onLifecycle: hooks.onLifecycle,
        });
      } finally {
        clearCancellationExit();
      }
    },
    rebuildRunReport: (config, runId) => rebuildReport(runId, storeFor(config), agentsFor(config)),
    readAssessmentContext: (config, runId, caseId) =>
      readAssessmentContext(runId, caseId, storeFor(config)),
    applyAssessment: (config, input) => assessCase(input, storeFor(config), agentsFor(config)),
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
  ignoreClosedReader(process.stdout);
  ignoreClosedReader(process.stderr);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  try {
    return await runProgram(argv, composeProgramDependencies({ cancellation: controller.signal }));
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}

/**
 * Drops output once the reader closes the pipe (`tevu … | head`), so the EPIPE
 * does not crash Node and the command still finishes its run and artifacts;
 * any other write error is rethrown.
 */
export function ignoreClosedReader(stream: Writable): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') {
      throw error;
    }
  });
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

/** Registers every agent secret's value and the Jira token, mirroring the run-level snapshot. */
function registerConfigSecrets(registry: SecretRegistry, config: TevuConfig): void {
  const names = Object.values(config.agents).flatMap((settings) => settings.secrets);
  const jira = config.trackers?.jira;
  if (jira !== undefined) {
    names.push(referencedVariableName(jira.token));
  }
  registry.add(names.map((name) => process.env[name]));
}

/** Records run-level snapshot secrets in the shared registry so later sinks redact them too. */
function wrapEnvironmentAdapter(
  adapter: EnvironmentAdapter,
  registry: SecretRegistry,
): EnvironmentAdapter {
  return {
    snapshotParent(names) {
      const snapshot = adapter.snapshotParent(names);
      if (snapshot.ok) {
        registry.add(snapshot.value.secretValues);
      }
      return snapshot;
    },
    unsetVariables: (names) => adapter.unsetVariables(names),
    createCaseEnvironments: (workspace, snapshot, names, agent, configurationFiles) =>
      adapter.createCaseEnvironments(workspace, snapshot, names, agent, configurationFiles),
    createModelCallEnvironment: (snapshot, agentVariables, configurationFiles) =>
      adapter.createModelCallEnvironment(snapshot, agentVariables, configurationFiles),
  };
}

/** One private sealed-workspace root per adapter instance, outside repositories and artifacts. */
function createWorkspacesRoot(): string {
  return path.join(tmpdir(), `tevu-workspaces-${randomBytes(6).toString('hex')}`);
}

/** UTC basic timestamp plus a collision-resistant lowercase hexadecimal suffix. */
function generateRunId(startedAt: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${startedAt.getUTCFullYear()}${pad(startedAt.getUTCMonth() + 1)}${pad(startedAt.getUTCDate())}` +
    `t${pad(startedAt.getUTCHours())}${pad(startedAt.getUTCMinutes())}${pad(startedAt.getUTCSeconds())}z`;
  return `${stamp}-${randomBytes(6).toString('hex')}`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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
    cancellation.addEventListener('abort', arm, { once: true });
  }
  return () => {
    cancellation.removeEventListener('abort', arm);
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
      process.stderr.write('tevu failed unexpectedly; command could not complete\n');
      process.exitCode = 1;
    },
  );
}
