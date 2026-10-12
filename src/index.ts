#!/usr/bin/env node
/**
 * Executable composition root: instantiates the concrete adapters, wires one
 * host environment that backs every secret redaction sink, stable run-ID and
 * configuration-digest generators, the wall clock, the standard streams, and
 * bounded signal cancellation into the program factory, then sets the mapped
 * process exit code. Each command's adapters are built by its own operations
 * factory when the command runs. Only dependency wiring and signal forwarding
 * live here; no orchestration, evaluation, transport, or persistence logic.
 */
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { createOpenCodeAdapter } from '@/adapters/agents/opencode/opencode';
import { createArtifactStore, createConfigStore } from '@/adapters/artifact-store';
import {
  createGitWorkspaceAdapter,
  createSourceValidator,
  isGitRepository,
  readOriginRemoteUrl,
} from '@/adapters/git';
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
import {
  collectBaseSecretNames,
  createTask,
  inspectTaskBaseCommit,
} from '@/application/create-task';
import { draftCriteria } from '@/application/draft-criteria';
import {
  ensureManagedCommits,
  ensureManagedLfsObjects,
  prepareManagedRepositories,
} from '@/application/managed-clone';
import { checkModelAccess, inspectModelProvider, probeAgent } from '@/application/model-access';
import { resolveReferenceSolution } from '@/application/reference-solution';
import { planBenchmark, runBenchmark } from '@/application/run-benchmark';
import { validateConfig } from '@/application/validate';
import { writeTaskConclusions } from '@/application/write-conclusions';
import { canonicalConfigSerialization, checkRepositoryPlacement, loadConfig } from '@/config/load';
import { locateConfig, managedCloneRoot as resolveManagedCloneRoot } from '@/config/locate';
import { referencedVariableName } from '@/config/schema';
import { GH_CREDENTIAL_ENVIRONMENT_VARIABLES } from '@/domain/github-cli';
import { runProgram } from '@/interface/program';
import { createWaitInterrupt } from '@/interface/wait-interrupt';

import type { GitHubIssuesDependencies } from '@/adapters/trackers/github-issues';
import type { JiraCloudSettings } from '@/adapters/trackers/jira-cloud';
import type { ManagedLfsDependencies } from '@/application/managed-clone';
import type { ModelAccessDependencies } from '@/application/model-access';
import type { ConclusionWriter } from '@/application/write-conclusions';
import type {
  AgentRegistry,
  ArtifactStore,
  CaseExecutableAdapter,
  Clock,
  ConfigStore,
  EnvironmentAdapter,
  GitWorkspaceAdapter,
  ManagedCloneAdapter,
  ParentEnvironmentSnapshot,
  PrerequisiteAdapter,
  TevuConfig,
} from '@/domain/types';
import type { AssessOperations } from '@/interface/commands/assess';
import type { ReportOperations } from '@/interface/commands/report';
import type { RunOperations } from '@/interface/commands/run';
import type { ConfigOperations, ProgramIo } from '@/interface/commands/shared';
import type { TaskAddOperations } from '@/interface/commands/task-add';
import type { ValidateOperations } from '@/interface/commands/validate';
import type { ProgramDependencies } from '@/interface/program';
import type { WaitInterrupt } from '@/interface/wait-interrupt';
import type { Writable } from 'node:stream';

/** The `version` of package.json; scripts/build.mjs defines it in the bundle, vitest.config.ts in tests. */
declare const __TEVU_VERSION__: string;

/** Optional overrides for composing the production dependency graph. */
export type CompositionOptions = {
  io?: ProgramIo;
  cancellation?: AbortSignal;
  /** Defaults to a fresh instance that no signal handler feeds. */
  waitInterrupt?: WaitInterrupt;
};

/**
 * tevu's own environment, copied once when `composeProgramDependencies` runs.
 * The composition root reads every variable through it: a credential only
 * through `secret`, which registers it before returning, and through
 * `ordinary` only `HOME`, `PATH`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, and the
 * variable `trackers.jira.email` references.
 */
interface HostEnvironment {
  /**
   * Every variable tevu started with, passed whole to the adapters that start
   * gh or git. No variable is read from it, because reading it registers
   * nothing.
   */
  readonly parentEnvironment: Readonly<Record<string, string | undefined>>;
  /** A credential variable's value; a non-empty value is registered before it is returned. */
  secret(name: string): string | undefined;
  /** A non-credential variable's value; never registered. */
  ordinary(name: string): string | undefined;
  /**
   * Registers the non-empty `secretValues` of a snapshot an adapter read from
   * the live environment. Only `wrapEnvironmentAdapter` calls it.
   */
  registerSnapshotSecrets(snapshot: ParentEnvironmentSnapshot): void;
  /** Every registered value, each once. */
  secretValues(): readonly string[];
  /** `text` with every registered value replaced by `[REDACTED]`. */
  redact(text: string): string;
}

/** Program-wide values every command's operations factory shares. */
type CompositionContext = {
  host: HostEnvironment;
  cancellation: AbortSignal;
  configStore: ConfigStore;
  managedCloneRoot: string | undefined;
};

type AgentsFor = (config: Pick<TevuConfig, 'agents'>) => AgentRegistry;

type ValidateConfigParts = {
  agentsFor: AgentsFor;
  environments: EnvironmentAdapter;
  prerequisites: PrerequisiteAdapter;
  clones: ManagedCloneAdapter;
  caseExecutables: CaseExecutableAdapter;
};

type ExecuteBenchmarkParts = {
  agentsFor: AgentsFor;
  environments: EnvironmentAdapter;
  prerequisites: PrerequisiteAdapter;
};

type RebuildReportParts = {
  agentsFor: AgentsFor;
  environments: EnvironmentAdapter;
};

/**
 * Composes the production dependency graph: one host environment backing every
 * redaction sink, one operations factory per command that builds real
 * adapters behind the injected operation ports when the command runs, and the
 * stable run-ID, digest, and clock sources.
 */
export function composeProgramDependencies(options: CompositionOptions = {}): ProgramDependencies {
  const io: ProgramIo = options.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const cancellation = options.cancellation ?? new AbortController().signal;
  const host = createHostEnvironment(process.env);
  const context: CompositionContext = {
    host,
    cancellation,
    configStore: createConfigStore({ redact: host.redact }),
    managedCloneRoot: resolveManagedCloneRoot({
      home: host.ordinary('HOME'),
      xdgCacheHome: host.ordinary('XDG_CACHE_HOME'),
    }),
  };

  return {
    io,
    commands: {
      taskAdd: () => composeTaskAddOperations(context),
      validate: () => composeValidateOperations(context),
      run: () => composeRunOperations(context),
      assess: () => composeAssessOperations(context),
      report: () => composeReportOperations(context),
    },
    version: __TEVU_VERSION__,
    now: () => new Date(),
    redact: host.redact,
    cancellation,
    waitInterrupt: options.waitInterrupt ?? createWaitInterrupt(),
  };
}

/**
 * Runs the `tevu` executable: wires interrupt signals to graceful bounded
 * cancellation, composes the production dependencies, and returns the mapped
 * exit code.
 *
 * SIGINT is offered to the open `task add` wait first and aborts the command
 * signal only when no wait takes it; SIGTERM aborts at once. Repeated
 * interrupts share the same bounded process-group cancellation.
 */
async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  const waitInterrupt = createWaitInterrupt();
  const onSigint = (): void => {
    if (!waitInterrupt.take()) {
      controller.abort();
    }
  };
  const onSigterm = (): void => {
    controller.abort();
  };
  ignoreClosedReader(process.stdout);
  ignoreClosedReader(process.stderr);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    return await runProgram(
      argv,
      composeProgramDependencies({ cancellation: controller.signal, waitInterrupt }),
    );
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
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

/**
 * Creates the host environment over a copy of `variables` and registers the
 * GitHub CLI credentials in it, so every sink redacts them from the start.
 *
 * Later writes to `variables` change no result. No method uses `this`, throws,
 * or performs I/O, so each works when passed detached.
 */
export function createHostEnvironment(
  variables: Readonly<Record<string, string | undefined>>,
): HostEnvironment {
  const copy = { ...variables };
  const registered = new Set<string>();
  const register = (value: string | undefined): void => {
    if (value !== undefined && value.length > 0) {
      registered.add(value);
    }
  };
  const secretValues = (): readonly string[] => [...registered];
  const host: HostEnvironment = {
    parentEnvironment: copy,
    secret: (name) => {
      const value = copy[name];
      register(value);
      return value;
    },
    ordinary: (name) => copy[name],
    registerSnapshotSecrets: (snapshot) => {
      snapshot.secretValues.forEach(register);
    },
    secretValues,
    redact: (text) => createRedactor(secretValues())(text),
  };
  for (const name of GH_CREDENTIAL_ENVIRONMENT_VARIABLES) {
    host.secret(name);
  }
  return host;
}

/** Reads each named credential variable through the host, which registers its value. */
function registerSecretVariables(host: HostEnvironment, names: Iterable<string>): void {
  for (const name of names) {
    host.secret(name);
  }
}

/**
 * Records the secret values each successful run-level snapshot read, so later
 * sinks redact them too. The values come from the snapshot, not from the
 * host's copy, because they are the ones case environments receive.
 */
function wrapEnvironmentAdapter(
  adapter: EnvironmentAdapter,
  host: HostEnvironment,
): EnvironmentAdapter {
  return {
    snapshotParent(names) {
      const snapshot = adapter.snapshotParent(names);
      if (snapshot.ok) {
        host.registerSnapshotSecrets(snapshot.value);
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

function createGit(): GitWorkspaceAdapter {
  return createGitWorkspaceAdapter({ workspacesDirectory: createWorkspacesRoot() });
}

/** Registers every configured agent under its own name; currently the schema declares only "opencode". */
function createAgentsFor({ host }: CompositionContext): AgentsFor {
  const secrets = createSecretRedactor(host.secretValues, host.redact);
  return (config) =>
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
            probeEnvironment: { PATH: host.ordinary('PATH') ?? '' },
            probeDirectory: process.cwd(),
            operatorDirectories: {
              home: host.ordinary('HOME'),
              xdgConfigHome: host.ordinary('XDG_CONFIG_HOME'),
            },
          },
        ),
      ],
    ]);
}

function createClones(context: CompositionContext): ManagedCloneAdapter {
  return createManagedCloneAdapter({
    runProcess: runManagedProcess,
    parentEnvironment: context.host.parentEnvironment,
    secretValues: context.host.secretValues,
    cancellation: context.cancellation,
  });
}

function createGitHubDependencies(context: CompositionContext): GitHubIssuesDependencies {
  return {
    runGh: (request) =>
      runManagedProcess({
        ...request,
        cwd: process.cwd(),
        secretValues: context.host.secretValues(),
        stdoutRedaction: 'structured',
      }),
    parentEnvironment: context.host.parentEnvironment,
    cancellation: context.cancellation,
  };
}

function createManagedLfsDependencies(
  context: CompositionContext,
  clones: ManagedCloneAdapter,
  onProgress: (line: string) => void,
): ManagedLfsDependencies {
  return {
    clones,
    git: createSourceValidator(),
    managedCloneRoot: context.managedCloneRoot,
    onProgress,
  };
}

function artifactStoreFor(host: HostEnvironment, config: TevuConfig): ArtifactStore {
  return createArtifactStore({ artifactsDirectory: config.run.output_dir, redact: host.redact });
}

function createValidateConfig(parts: ValidateConfigParts): ValidateOperations['validateConfig'] {
  return (config) =>
    validateConfig(config, {
      git: createGit(),
      agents: parts.agentsFor(config),
      environments: parts.environments,
      prerequisites: parts.prerequisites,
      clones: { inspectClone: parts.clones.inspectClone },
      caseExecutables: parts.caseExecutables,
    });
}

function createRebuildRunReport(
  context: CompositionContext,
  parts: RebuildReportParts,
): ReportOperations['rebuildRunReport'] {
  const { host, cancellation } = context;
  return (config, runId, conclusions) => {
    const agents = parts.agentsFor(config);
    const writer: ConclusionWriter | undefined =
      conclusions === 'write'
        ? {
            write: (evidence) =>
              writeTaskConclusions(
                { config, evidence, redact: host.redact, cancellation },
                { agents, environments: parts.environments, git: createGit() },
              ),
          }
        : undefined;
    return rebuildReport(runId, artifactStoreFor(host, config), agents, writer);
  };
}

function createExecuteBenchmark(
  context: CompositionContext,
  parts: ExecuteBenchmarkParts,
): RunOperations['executeBenchmark'] {
  const { host } = context;
  const clock: Clock = { now: () => new Date() };
  return async (plan, hooks) => {
    const clearCancellationExit = scheduleBoundedCancellationExit(
      hooks.cancellation,
      plan.terminationGraceMs,
    );
    try {
      return await runBenchmark(plan, {
        git: createGit(),
        agents: parts.agentsFor(plan.config),
        artifacts: createArtifactStore({
          artifactsDirectory: plan.artifactsDirectory,
          redact: host.redact,
        }),
        evaluatorProcesses: createEvaluatorProcessAdapter(host.secretValues),
        environments: parts.environments,
        prerequisites: parts.prerequisites,
        clock,
        generateRunId: (startedAt) => {
          const runId = generateRunId(startedAt);
          hooks.onRunId?.(runId);
          return runId;
        },
        configDigest: (config) => sha256Hex(canonicalConfigSerialization(config)),
        textDigest: sha256Hex,
        redact: host.redact,
        cancellation: hooks.cancellation,
        onLifecycle: hooks.onLifecycle,
        onRetainedGradingDirectory: hooks.onRetainedGradingDirectory,
      });
    } finally {
      clearCancellationExit();
    }
  };
}

function createImportJiraIssue(host: HostEnvironment): TaskAddOperations['importJiraIssue'] {
  return (settings, issueKey) => {
    const jiraSettings: JiraCloudSettings = {
      baseUrl: settings.url,
      emailEnvironmentVariable: referencedVariableName(settings.email),
      tokenEnvironmentVariable: referencedVariableName(settings.token),
    };
    host.secret(jiraSettings.tokenEnvironmentVariable);
    const jira = createJiraCloudAdapter(jiraSettings, {
      fetch: (url, init) => globalThis.fetch(url, init),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      getEnvironmentVariable: (name) =>
        name === jiraSettings.tokenEnvironmentVariable ? host.secret(name) : host.ordinary(name),
    });
    return jira.readIssue(issueKey);
  };
}

function createImportGitHubIssue(
  context: CompositionContext,
): TaskAddOperations['importGitHubIssue'] {
  return (reference) =>
    createGitHubIssuesAdapter(createGitHubDependencies(context)).readIssue(reference);
}

function composeConfigOperations(context: CompositionContext): ConfigOperations {
  const { host, configStore, managedCloneRoot } = context;
  return {
    locateConfig: (requestedPath) =>
      locateConfig(
        requestedPath,
        {
          cwd: process.cwd(),
          home: host.ordinary('HOME'),
          xdgConfigHome: host.ordinary('XDG_CONFIG_HOME'),
        },
        configStore,
      ),
    loadConfig: async (configPath) => {
      const loaded = await loadConfig(configPath, configStore, managedCloneRoot);
      if (loaded.ok) {
        registerSecretVariables(host, collectBaseSecretNames(loaded.value));
      }
      return loaded;
    },
  };
}

function composeValidateOperations(context: CompositionContext): ValidateOperations {
  const environments = wrapEnvironmentAdapter(createEnvironmentAdapter(), context.host);
  return {
    ...composeConfigOperations(context),
    validateConfig: createValidateConfig({
      agentsFor: createAgentsFor(context),
      environments,
      prerequisites: createPrerequisiteAdapter(),
      clones: createClones(context),
      caseExecutables: createCaseExecutableAdapter(),
    }),
  };
}

function composeReportOperations(context: CompositionContext): ReportOperations {
  const environments = wrapEnvironmentAdapter(createEnvironmentAdapter(), context.host);
  return {
    ...composeConfigOperations(context),
    rebuildRunReport: createRebuildRunReport(context, {
      agentsFor: createAgentsFor(context),
      environments,
    }),
  };
}

function composeAssessOperations(context: CompositionContext): AssessOperations {
  const agentsFor = createAgentsFor(context);
  return {
    ...composeConfigOperations(context),
    readAssessmentContext: (config, runId, caseId) =>
      readAssessmentContext(runId, caseId, artifactStoreFor(context.host, config)),
    applyAssessment: (config, input) =>
      assessCase(input, artifactStoreFor(context.host, config), agentsFor(config)),
  };
}

function composeRunOperations(context: CompositionContext): RunOperations {
  const agentsFor = createAgentsFor(context);
  const environments = wrapEnvironmentAdapter(createEnvironmentAdapter(), context.host);
  const prerequisites = createPrerequisiteAdapter();
  const clones = createClones(context);
  return {
    ...composeConfigOperations(context),
    prepareRepositories: (config, onProgress) =>
      prepareManagedRepositories(config, createManagedLfsDependencies(context, clones, onProgress)),
    validateConfig: createValidateConfig({
      agentsFor,
      environments,
      prerequisites,
      clones,
      caseExecutables: createCaseExecutableAdapter(),
    }),
    planBenchmark,
    executeBenchmark: createExecuteBenchmark(context, { agentsFor, environments, prerequisites }),
    rebuildRunReport: createRebuildRunReport(context, { agentsFor, environments }),
  };
}

function composeLocalRepositoryOperations(): Pick<
  TaskAddOperations,
  'isGitRepository' | 'readLocalRepositoryNaming'
> {
  return {
    isGitRepository: (configPath, repositoryPath) =>
      isGitRepository(path.resolve(path.dirname(path.resolve(configPath)), repositoryPath)),
    readLocalRepositoryNaming: async (configPath, repositoryPath) => {
      const directory = path.resolve(path.dirname(path.resolve(configPath)), repositoryPath);
      const originUrl = await readOriginRemoteUrl(directory);
      return {
        directoryName: path.basename(directory),
        ...(originUrl === undefined ? {} : { originUrl }),
      };
    },
  };
}

function composeModelAccessOperations(
  context: CompositionContext,
  environments: EnvironmentAdapter,
): Pick<TaskAddOperations, 'probeAgent' | 'inspectModelProvider' | 'checkModelAccess'> {
  const agentsFor = createAgentsFor(context);
  const modelAccess = (): ModelAccessDependencies => ({
    agentsFor,
    environments,
    git: createGit(),
    cancellation: context.cancellation,
  });
  return {
    probeAgent: (configPath, command) => probeAgent({ configPath, command }, modelAccess()),
    inspectModelProvider: (configPath, agent, model) =>
      inspectModelProvider({ configPath, agent, model }, modelAccess()),
    checkModelAccess: (configPath, agent, model) =>
      checkModelAccess({ configPath, agent, model }, modelAccess()),
  };
}

function composeTaskAddOperations(context: CompositionContext): TaskAddOperations {
  const { host, cancellation, configStore, managedCloneRoot } = context;
  const clones = createClones(context);
  const agentsFor = createAgentsFor(context);
  const environments = wrapEnvironmentAdapter(createEnvironmentAdapter(), host);
  const pullRequests = createGitHubPullRequestReader(createGitHubDependencies(context));
  const registerSecrets = (names: readonly string[]): void => {
    registerSecretVariables(host, names);
  };
  return {
    ...composeConfigOperations(context),
    ...composeLocalRepositoryOperations(),
    ...composeModelAccessOperations(context, environments),
    configExists: (configPath) => configStore.exists(configPath),
    requireConfigDirectory: (configPath) => configStore.requireDirectory(configPath),
    importJiraIssue: createImportJiraIssue(host),
    importGitHubIssue: createImportGitHubIssue(context),
    resolveReference: (request, onProgress) =>
      resolveReferenceSolution(request, {
        ...createManagedLfsDependencies(context, clones, onProgress),
        pullRequests,
      }),
    ensureManagedCommits: (request, onProgress) =>
      ensureManagedCommits(request, createManagedLfsDependencies(context, clones, onProgress)),
    ensureManagedLfsObjects: (request, onProgress) =>
      ensureManagedLfsObjects(request, createManagedLfsDependencies(context, clones, onProgress)),
    checkGitHubRepository: (repository) => clones.checkRemote(repository),
    unsetVariables: (names) => environments.unsetVariables(names),
    draftCriteria: (request) =>
      draftCriteria(request, {
        agentsFor,
        environments,
        git: createGit(),
        pullRequests,
        managedCloneRoot,
        registerSecrets,
        redact: host.redact,
        cancellation,
      }),
    inspectBaseCommit: (configPath, repository, baseCommit, reference) =>
      inspectTaskBaseCommit(
        { configPath, repository, baseCommit, ...(reference === undefined ? {} : { reference }) },
        { git: createSourceValidator(), managedCloneRoot },
      ),
    checkRepositoryPlacement: (configPath, outputDirectory, repositories) =>
      checkRepositoryPlacement({ outputDirectory, repositories }, configPath, managedCloneRoot),
    createTask: (input) =>
      createTask(input, {
        configStore,
        git: createSourceValidator(),
        registerSecrets,
        redact: host.redact,
        managedCloneRoot,
        cancellation,
      }),
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
