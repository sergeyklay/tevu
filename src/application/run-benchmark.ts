/**
 * Benchmark planning and bounded orchestration: the deterministic
 * task-by-contender matrix, per-case lifecycle over injected adapter
 * contracts, cancellation coordination, and the shared run exit-status
 * reducer. No concrete adapter, filesystem path, or process global enters
 * this module.
 */

import pLimit from 'p-limit';

import { agentNamesInUse, durationMs } from '@/config/schema';
import { unavailableBenchmarkMetrics } from '@/domain/types';
import {
  buildCheckEnvironment,
  evaluateChecks,
  orderTaskChecks,
  reduceRequiredOutcome,
} from '@/evaluation/checks';
import { combineCaseMetrics } from '@/evaluation/metrics';
import { compareCaseIds } from '@/evaluation/report';

import { buildEnvironmentVariableNames } from './environment-variable-names';
import { runSetupPhase } from './repository-setup';
import { describeSourceCommitInPrompt } from './source-commit-in-prompt';
import { buildTaskPrompt } from './task-prompt';

import type { SetupPhaseOutcome } from './repository-setup';
import type {
  AgentCapabilityReport,
  AgentEventRecord,
  AgentRegistry,
  AgentRunResult,
  AgentSessionExport,
  BenchmarkMetrics,
  BenchmarkPlan,
  CaseEnvironments,
  CaseIdentity,
  CaseLifecycle,
  CaseResult,
  CaseWorkspace,
  CheckResult,
  CheckStateRecord,
  CheckStateRequest,
  EnvironmentVariableNames,
  GitWorkspaceAdapter,
  OverlaySnapshot,
  ParentEnvironmentSnapshot,
  PatchBase,
  RepeatSetting,
  RepositoryDefinition,
  RepositorySetup,
  RunDependencies,
  RunFinding,
  RunManifest,
  RunResult,
  SetupCommandRecord,
  SetupPhase,
  TaskDefinition,
  TevuConfig,
  TevuError,
  TevuResult,
} from '@/domain/types';
import type { OrderedCheck } from '@/evaluation/checks';

type OrderedChecks = readonly OrderedCheck[];

/** Result of the single managed agent process one case owns. */
type AgentRunOutcome = TevuResult<
  AgentRunResult,
  'AgentProcessError' | 'AgentProtocolError' | 'CaseTimeoutError' | 'CancellationError'
>;

/** Error kinds the benchmark orchestration contract declares. */
type RunBenchmarkErrorKind =
  | 'PrerequisiteError'
  | 'SourceMaterializationError'
  | 'IsolationError'
  | 'AgentProcessError'
  | 'AgentProtocolError'
  | 'CaseTimeoutError'
  | 'EvaluationError'
  | 'ArtifactError'
  | 'CancellationError'
  | 'CheckStateError';

/**
 * Builds the deterministic attempt-major execution plan purely from
 * configuration: cases loop attempt outermost, then configuration task order,
 * then contender order, with the declared (not yet resolved) start commit and
 * the configured limits.
 *
 * `repeatOverride`, when present, becomes `plan.repeat` with source `"cli"`,
 * whatever its value; otherwise `plan.repeat` is `config.run.repeat` with
 * source `"config"`. `config` is returned unmodified: `plan.config.run.repeat`
 * always keeps the configured value, even when `repeatOverride` overrides it
 * for this plan.
 *
 * Each case's `timeoutMs` is its task's `timeout` when declared, otherwise
 * `defaultCaseTimeoutMs`; every case of one task shares the same value,
 * regardless of model entry, attempt, or `repeatOverride`.
 */
export function planBenchmark(
  config: TevuConfig,
  configPath: string,
  repeatOverride?: number,
): BenchmarkPlan {
  const repeat: RepeatSetting =
    repeatOverride === undefined
      ? { value: config.run.repeat, source: 'config' }
      : { value: repeatOverride, source: 'cli' };
  const defaultCaseTimeoutMs = durationMs(config.run.timeout);
  const cases: CaseIdentity[] = [];
  for (let attempt = 1; attempt <= repeat.value; attempt += 1) {
    for (const task of config.tasks) {
      const caseTimeoutMs =
        task.timeout === undefined ? defaultCaseTimeoutMs : durationMs(task.timeout);
      for (const model of config.models) {
        cases.push({
          caseId: `${task.id}--${model.id}--${attempt}`,
          taskId: task.id,
          modelId: model.id,
          attempt,
          sourceCommit: task.base_commit,
          model: model.model,
          effort: model.effort,
          agent: model.agent,
          timeoutMs: caseTimeoutMs,
        });
      }
    }
  }
  return {
    config,
    configPath,
    cases,
    repeat,
    concurrency: config.run.concurrency,
    defaultCaseTimeoutMs,
    terminationGraceMs: durationMs(config.run.stop_grace),
    artifactsDirectory: config.run.output_dir,
  };
}

/**
 * Reduces final case results and run findings to the aggregated run exit code.
 * Precedence: user cancellation (130), then an incomplete benchmark record
 * (1), then any preserved degradation (2), otherwise 0. A `completed` case
 * that preserved a runtime failure forces 2 even when its outcome is `passed`.
 * Shared by run aggregation, assessment, and report regeneration.
 */
export function reduceRunExitCode(
  cases: readonly CaseResult[],
  findings: readonly RunFinding[],
  cancelled: boolean,
): RunResult['exitCode'] {
  if (cancelled || cases.some((current) => current.lifecycle === 'cancelled')) {
    return 130;
  }
  const incomplete =
    findings.some((finding) => finding.severity === 'error') ||
    cases.some((current) => current.lifecycle === 'infrastructure-failed');
  if (incomplete) {
    return 1;
  }
  const degraded = cases.some(
    (current) =>
      current.lifecycle === 'timed-out' ||
      current.lifecycle === 'process-failed' ||
      current.outcome === 'failed' ||
      current.outcome === 'pending' ||
      current.failure !== null,
  );
  return degraded ? 2 : 0;
}

/**
 * Orchestrates one bounded benchmark run over injected adapters: local
 * prerequisite validation, commit pinning, and overlay pinning before the
 * first write, one immutable parent-environment snapshot before scheduling,
 * `p-limit` bounded case slots that include acceptance evaluation, exactly
 * one agent process per planned case with no retry, the binding lifecycle and
 * failure mappings, artifact-failure scheduling stop, and bounded
 * cancellation finalization.
 * After the run directory exists, failures are folded into case results and
 * run findings; only a pre-write failure or a final artifact failure returns
 * an error.
 */
export async function runBenchmark(
  plan: BenchmarkPlan,
  dependencies: RunDependencies,
): Promise<TevuResult<RunResult, RunBenchmarkErrorKind>> {
  if (dependencies.cancellation.aborted) {
    return cancellationFailure();
  }
  const agents = dependencies.agents;
  const host = await dependencies.prerequisites.probeHost();
  if (!host.ok) {
    return host;
  }
  const environmentNames = buildEnvironmentVariableNames(plan.config);
  const snapshot = dependencies.environments.snapshotParent(environmentNames);
  if (!snapshot.ok) {
    return snapshot;
  }
  const capabilities: Record<string, AgentCapabilityReport> = {};
  const agentVersions: Record<string, string | null> = {};
  for (const name of agentNamesInUse(plan.config)) {
    const adapter = agents.get(name);
    if (adapter === undefined) {
      return {
        ok: false,
        error: {
          kind: 'PrerequisiteError',
          tool: name,
          expected: 'a registered agent adapter',
          actual: 'none',
        },
      };
    }
    const report = await adapter.probe();
    if (!report.ok) {
      return report;
    }
    capabilities[name] = report.value;
    agentVersions[name] = report.value.detectedVersion;
  }
  const planned = await resolvePlannedCases(plan, dependencies);
  if (!planned.ok) {
    return planned;
  }
  const pinned = await pinOverlays(planned.value, dependencies.git);
  if (!pinned.ok) {
    return pinned;
  }
  if (dependencies.cancellation.aborted) {
    return cancellationFailure();
  }

  const startedAt = dependencies.clock.now();
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId: dependencies.generateRunId(startedAt),
    configDigest: dependencies.configDigest(plan.config),
    configPath: plan.configPath,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    host: {
      platform: host.value.platform,
      nodeVersion: host.value.nodeVersion,
    },
    tools: { gitVersion: host.value.gitVersion, agentVersions },
    execution: {
      concurrency: plan.concurrency,
      caseTimeoutMs: plan.defaultCaseTimeoutMs,
      repeat: plan.repeat,
    },
    cases: pinned.value.map((entry) => entry.identity),
    context: { config: plan.config, capabilities },
  };
  const started = await dependencies.artifacts.startRun(manifest);
  if (!started.ok) {
    return started;
  }

  const run: RunContext = {
    plan,
    dependencies,
    agents,
    snapshot: snapshot.value,
    environmentNames,
    findings: [],
    results: new Map(),
    activeAborts: new Map(),
    state: { cancelled: false, stopScheduling: false },
  };
  const onRunAbort = (): void => {
    run.state.cancelled = true;
    for (const abort of run.activeAborts.values()) {
      abort.abort();
    }
  };
  if (dependencies.cancellation.aborted) {
    onRunAbort();
  } else {
    dependencies.cancellation.addEventListener('abort', onRunAbort, { once: true });
  }

  for (const entry of pinned.value) {
    emitLifecycle(run, entry.identity.caseId, 'queued');
  }
  const limit = pLimit(plan.concurrency);
  await Promise.all(pinned.value.map((entry) => limit(() => executeCase(run, entry))));
  dependencies.cancellation.removeEventListener('abort', onRunAbort);

  const cases = pinned.value.flatMap((entry) => {
    const result = run.results.get(entry.identity.caseId);
    return result === undefined ? [] : [result];
  });
  const identities = new Map(manifest.cases.map((identity) => [identity.caseId, identity]));
  const findings = [...run.findings].sort(
    (a, b) =>
      compareCaseIds(identities, a.caseId, b.caseId) || compareStrings(a.message, b.message),
  );
  const result: RunResult = {
    schemaVersion: 1,
    manifest: { ...manifest, completedAt: dependencies.clock.now().toISOString() },
    cases,
    findings,
    exitCode: reduceRunExitCode(cases, findings, run.state.cancelled),
  };
  const finalized = await dependencies.artifacts.finalizeRun(result);
  if (!finalized.ok) {
    return finalized;
  }
  return { ok: true, value: result };
}

/** One planned case with its pinned identity, resolved task definition, and pinned overlay snapshot. */
type PlannedCase = {
  identity: CaseIdentity;
  task: TaskDefinition;
  /** The run's snapshot of `task.checks.overlay`; `null` before `pinOverlays` runs or when the task declares none. */
  overlay: OverlaySnapshot | null;
  /** The repository `resolvePlannedCases` matched to the case's task by `task.repo`. */
  repository: RepositoryDefinition;
};

/** Mutable state shared by every scheduled case of one run. */
type RunContext = {
  plan: BenchmarkPlan;
  dependencies: RunDependencies;
  agents: AgentRegistry;
  snapshot: ParentEnvironmentSnapshot;
  environmentNames: EnvironmentVariableNames;
  findings: RunFinding[];
  results: Map<string, CaseResult>;
  activeAborts: Map<string, AbortController>;
  state: { cancelled: boolean; stopScheduling: boolean };
};

/** Everything one started case has accumulated when it reaches a terminal state. */
type ActiveCase = {
  identity: CaseIdentity;
  task: TaskDefinition;
  workspace: CaseWorkspace;
  environments: CaseEnvironments;
  abort: AbortController;
  events: AgentEventRecord[];
  diagnostics: number;
  evidence: AgentRunResult | null;
  artifactFailure: TevuError | null;
  sessionExport: AgentSessionExport | null;
  exportUnavailableReason: string | undefined;
  patchWritten: boolean;
  checks: CheckResult[];
  checksWritten: boolean;
  overlay: OverlaySnapshot | null;
  checkState: CheckStateRecord | null;
  setup: RepositorySetup | null;
  setupCommands: SetupCommandRecord[];
  setupLogs: { beforeAgent: string | null; beforeChecks: string | null };
  patchBase: PatchBase | null;
};

function cancellationFailure(): {
  ok: false;
  error: Extract<TevuError, { kind: 'CancellationError' }>;
} {
  return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
}

/**
 * Pins every planned case to its resolved source commit before any write,
 * probing each unique repository-and-commit pair once, and rejects a case
 * whose agent prompt names the resolved commit. Source failures are remapped
 * to the owning task's identity.
 */
async function resolvePlannedCases(
  plan: BenchmarkPlan,
  dependencies: RunDependencies,
): Promise<TevuResult<PlannedCase[], 'SourceMaterializationError'>> {
  const tasks = new Map(plan.config.tasks.map((task) => [task.id, task]));
  const repositories = new Map(
    plan.config.repositories.map((repository) => [repository.id, repository]),
  );
  const resolvedCommits = new Map<string, string>();
  const planned: PlannedCase[] = [];
  for (const identity of plan.cases) {
    const task = tasks.get(identity.taskId);
    if (task === undefined) {
      return sourceFailure(identity.taskId, 'task is not defined in the configuration');
    }
    const repository = repositories.get(task.repo);
    if (repository === undefined) {
      return sourceFailure(
        task.id,
        `repository "${task.repo}" is not defined in the configuration`,
      );
    }
    const key = `${repository.id}\u0000${task.base_commit}`;
    let commit = resolvedCommits.get(key);
    if (commit === undefined) {
      const validated = await dependencies.git.validateSource(repository, task.base_commit);
      if (!validated.ok) {
        return { ok: false, error: { ...validated.error, taskId: task.id } };
      }
      commit = validated.value.resolvedCommit;
      resolvedCommits.set(key, commit);
    }
    const reason = describeSourceCommitInPrompt(buildTaskPrompt(task), commit);
    if (reason !== undefined) {
      return sourceFailure(task.id, reason);
    }
    planned.push({
      identity: { ...identity, sourceCommit: commit },
      task,
      overlay: null,
      repository,
    });
  }
  return { ok: true, value: planned };
}

function sourceFailure(
  taskId: string,
  reason: string,
): { ok: false; error: Extract<TevuError, { kind: 'SourceMaterializationError' }> } {
  return { ok: false, error: { kind: 'SourceMaterializationError', taskId, reason } };
}

/**
 * Reads each distinct configured overlay directory once, in plan order, and
 * sets every planned case's `overlay` to the run's pinned snapshot (`null`
 * for a task that declares none), so a later edit to the directory reaches no
 * case of this run.
 */
async function pinOverlays(
  planned: PlannedCase[],
  git: GitWorkspaceAdapter,
): Promise<TevuResult<PlannedCase[], 'CheckStateError'>> {
  const snapshots = new Map<string, OverlaySnapshot>();
  for (const entry of planned) {
    const directory = entry.task.checks.overlay;
    if (directory === undefined) {
      continue;
    }
    let snapshot = snapshots.get(directory);
    if (snapshot === undefined) {
      const read = await git.readOverlay(directory);
      if (!read.ok) {
        return read;
      }
      snapshot = read.value;
      snapshots.set(directory, snapshot);
    }
    entry.overlay = snapshot;
  }
  return { ok: true, value: planned };
}

/** Builds the check-state setup request for one case, or `null` when neither key is declared. */
function checkStateRequest(
  task: TaskDefinition,
  overlay: OverlaySnapshot | null,
): CheckStateRequest | null {
  const restore = task.checks.restore ?? [];
  if (restore.length === 0 && overlay === null) {
    return null;
  }
  return { restore, overlay };
}

/** Runs one case inside its concurrency slot from queued skip checks to cleanup. */
async function executeCase(run: RunContext, entry: PlannedCase): Promise<void> {
  const caseId = entry.identity.caseId;
  if (run.state.cancelled) {
    run.findings.push({
      severity: 'warning',
      caseId,
      message: 'case was still queued when the run was cancelled and was not started',
    });
    return;
  }
  if (run.state.stopScheduling) {
    run.findings.push({
      severity: 'error',
      caseId,
      message: 'case was not started because an artifact failure stopped scheduling',
    });
    return;
  }

  emitLifecycle(run, caseId, 'preparing');
  const workspace = await run.dependencies.git.createIsolatedCase(entry.identity, entry.repository);
  if (!workspace.ok) {
    await persistAndCleanup(run, preparationFailureResult(run, entry, workspace.error), null);
    return;
  }
  const environments = await run.dependencies.environments.createCaseEnvironments(
    workspace.value,
    run.snapshot,
    run.environmentNames,
    entry.identity.agent,
  );
  if (!environments.ok) {
    await persistAndCleanup(
      run,
      preparationFailureResult(run, entry, environments.error),
      workspace.value,
    );
    return;
  }

  const active: ActiveCase = {
    identity: entry.identity,
    task: entry.task,
    workspace: workspace.value,
    environments: environments.value,
    abort: new AbortController(),
    events: [],
    diagnostics: 0,
    evidence: null,
    artifactFailure: null,
    sessionExport: null,
    exportUnavailableReason: undefined,
    patchWritten: false,
    checks: [],
    checksWritten: false,
    overlay: entry.overlay,
    checkState: null,
    setup: entry.repository.setup ?? null,
    setupCommands: [],
    setupLogs: { beforeAgent: null, beforeChecks: null },
    patchBase: null,
  };
  run.activeAborts.set(caseId, active.abort);
  if (run.state.cancelled) {
    active.abort.abort();
  }

  try {
    await runActiveCase(run, active);
  } finally {
    run.activeAborts.delete(caseId);
  }
}

async function runActiveCase(run: RunContext, active: ActiveCase): Promise<void> {
  const caseId = active.identity.caseId;

  if (active.setup?.before_agent !== undefined) {
    const terminal = await evaluateBeforeAgentSetup(run, active);
    if (terminal !== null) {
      await persistAndCleanup(run, terminal, active.workspace);
      return;
    }
  }

  const adapter = requireCaseAgentAdapter(run, active.identity);

  emitLifecycle(run, caseId, 'running');
  const outcome = await adapter.run({
    identity: active.identity,
    prompt: buildTaskPrompt(active.task),
    worktreeDirectory: active.workspace.worktreeDirectory,
    environment: requireCaseAgentEnvironment(active.environments),
    timeoutMs: active.identity.timeoutMs,
    terminationGraceMs: run.plan.terminationGraceMs,
    cancellation: active.abort.signal,
    onEvent: async (event) => {
      active.events.push(event);
      const appended = await run.dependencies.artifacts.appendEvent(caseId, event);
      if (!appended.ok) {
        recordArtifactFailure(run, active, appended.error);
      }
      return appended;
    },
    onDiagnostic: async (line) => {
      active.diagnostics += 1;
      const appended = await run.dependencies.artifacts.appendDiagnostic(caseId, line);
      if (!appended.ok) {
        recordArtifactFailure(run, active, appended.error);
      }
      return appended;
    },
    onProcess: (evidence) => {
      active.evidence = evidence;
    },
  });
  const result = await concludeCase(run, active, outcome);
  await persistAndCleanup(run, result, active.workspace);
}

/** Outcome of {@link runSetup}: the phase outcome, or a log write failure the phase outcome itself cannot carry. */
type SetupStepResult =
  | SetupPhaseOutcome
  | { status: 'log-failed'; error: Extract<TevuError, { kind: 'ArtifactError' }> };

/**
 * Runs one declared setup phase's commands, shared by step b (`before_agent`)
 * and step g (`before_checks`). Appends every started command to
 * `active.setupCommands`, and, when at least one command started, writes the
 * phase log and records its path on `active.setupLogs`. A log-write failure
 * stops further case scheduling, as {@link recordArtifactFailure} does for a
 * mid-case artifact failure.
 *
 * @throws when `active.setup` or its `phase` key is undeclared; callers only
 * invoke this after confirming the phase is declared.
 */
async function runSetup(
  run: RunContext,
  active: ActiveCase,
  phase: SetupPhase,
): Promise<SetupStepResult> {
  const setup = active.setup;
  const commands = phase === 'before_agent' ? setup?.before_agent : setup?.before_checks;
  if (setup === null || commands === undefined) {
    throw new Error(`unreachable: runSetup is only called when active.setup.${phase} is declared`);
  }
  const outcome = await runSetupPhase({
    phase,
    commands,
    timeoutMs: durationMs(setup.timeout),
    terminationGraceMs: run.plan.terminationGraceMs,
    worktreeDirectory: active.workspace.worktreeDirectory,
    environment: buildCheckEnvironment(active.environments.evaluator, run.snapshot, setup.env),
    processes: run.dependencies.evaluatorProcesses,
    cancellation: active.abort.signal,
  });
  active.setupCommands.push(...outcome.commands);
  if (outcome.commands.length === 0) {
    return outcome;
  }
  const caseId = active.identity.caseId;
  const written = await run.dependencies.artifacts.writeSetupLog(caseId, phase, outcome.log);
  if (!written.ok) {
    run.state.stopScheduling = true;
    return { status: 'log-failed', error: written.error };
  }
  const paths = run.dependencies.artifacts.caseArtifactPaths(caseId);
  if (phase === 'before_agent') {
    active.setupLogs.beforeAgent = paths.setupBeforeAgent;
  } else {
    active.setupLogs.beforeChecks = paths.setupBeforeChecks;
  }
  return outcome;
}

/**
 * Runs step b (`before_agent`) and, on success, records the patch base.
 * Returns the case's terminal result when the agent must never start, or
 * `null` when control should reach the agent call (step c).
 */
async function evaluateBeforeAgentSetup(
  run: RunContext,
  active: ActiveCase,
): Promise<CaseResult | null> {
  const cancelledResult = (): CaseResult =>
    agentNotStartedResult(
      run,
      active,
      'cancelled',
      { kind: 'CancellationError', activeCaseIds: [active.identity.caseId] },
      'the case was cancelled before the agent started',
    );

  const step = await runSetup(run, active, 'before_agent');
  if (step.status === 'log-failed') {
    return agentNotStartedResult(
      run,
      active,
      'infrastructure-failed',
      step.error,
      'the setup.before_agent log could not be written; the agent did not start',
    );
  }
  if (step.status === 'failed') {
    return agentNotStartedResult(
      run,
      active,
      'infrastructure-failed',
      step.error,
      'setup.before_agent failed; the agent did not start',
    );
  }
  if (step.status === 'cancelled' || run.state.cancelled) {
    return cancelledResult();
  }

  const base = await run.dependencies.git.snapshotPatchBase(active.workspace);
  if (!base.ok) {
    return agentNotStartedResult(
      run,
      active,
      'infrastructure-failed',
      base.error,
      'the patch base could not be recorded; the agent did not start',
    );
  }
  if (run.state.cancelled) {
    return cancelledResult();
  }
  active.patchBase = base.value;
  return null;
}

/**
 * Builds the terminal case result for a case whose `before_agent` setup
 * never let the agent start: `adapter.run` is never called. Metrics are
 * unavailable with the given run-time reason; `setup` is present only when
 * at least one setup command started.
 */
function agentNotStartedResult(
  run: RunContext,
  active: ActiveCase,
  lifecycle: Extract<CaseLifecycle, 'infrastructure-failed' | 'cancelled'>,
  failure: TevuError,
  reason: string,
): CaseResult {
  const paths = run.dependencies.artifacts.caseArtifactPaths(active.identity.caseId);
  return {
    schemaVersion: 1,
    identity: active.identity,
    lifecycle,
    process: null,
    outcome: 'not-evaluated',
    checks: [],
    metrics: unavailableBenchmarkMetrics(reason),
    artifacts: {
      events: null,
      diagnostics: null,
      sessionExport: null,
      solutionPatch: null,
      checks: null,
      assessment: null,
      result: paths.result,
    },
    failure: { error: failure, occurredAt: run.dependencies.clock.now().toISOString() },
    ...(active.setupCommands.length === 0
      ? {}
      : { setup: { logs: active.setupLogs, commands: active.setupCommands } }),
  };
}

/**
 * Resolves the adapter `runBenchmark` already confirmed registered for this
 * case's agent while probing every agent in use.
 */
function requireCaseAgentAdapter(run: RunContext, identity: CaseIdentity) {
  const adapter = identity.agent === undefined ? undefined : run.agents.get(identity.agent);
  if (adapter === undefined) {
    throw new Error(
      `unreachable: runBenchmark already validated a registered adapter for agent "${String(identity.agent)}"`,
    );
  }
  return adapter;
}

/** `createCaseEnvironments` always populates `agent`; narrows past its still-optional shim type. */
function requireCaseAgentEnvironment(environments: CaseEnvironments) {
  if (environments.agent === undefined) {
    throw new Error('unreachable: createCaseEnvironments already populates the agent environment');
  }
  return environments.agent;
}

/** Records a mid-case artifact-store failure, terminates the case, and stops scheduling. */
function recordArtifactFailure(run: RunContext, active: ActiveCase, error: TevuError): void {
  active.artifactFailure ??= error;
  run.state.stopScheduling = true;
  active.abort.abort();
}

/** Maps one finished agent run to the case's terminal result. */
async function concludeCase(
  run: RunContext,
  active: ActiveCase,
  outcome: AgentRunOutcome,
): Promise<CaseResult> {
  if (active.artifactFailure !== null) {
    active.exportUnavailableReason =
      'an artifact failure ended the case before the root session could be exported';
    return finishCase(run, active, 'infrastructure-failed', active.artifactFailure);
  }
  if (outcome.ok) {
    return evaluateReadableCase(run, active, null);
  }
  const error = outcome.error;
  switch (error.kind) {
    case 'CancellationError':
      active.exportUnavailableReason =
        'the case was cancelled before the root session could be exported';
      return finishCase(run, active, 'cancelled', error);
    case 'CaseTimeoutError': {
      active.exportUnavailableReason =
        'the case timed out before the root session could be exported';
      const patch = await capturePatch(run, active);
      if (patch.storeFailure && patch.failure !== null) {
        return finishCase(run, active, 'infrastructure-failed', patch.failure);
      }
      if (patch.failure !== null) {
        run.findings.push({
          severity: 'warning',
          caseId: active.identity.caseId,
          message: `solution patch could not be captured after timeout: ${describeError(patch.failure)}`,
        });
      }
      return finishCase(run, active, 'timed-out', error);
    }
    default: {
      const readable =
        run.dependencies.git.isReadable === undefined
          ? true
          : await run.dependencies.git.isReadable(active.workspace);
      if (readable) {
        return evaluateReadableCase(run, active, error);
      }
      active.exportUnavailableReason = `the workspace was unreadable after the failure: ${describeError(error)}`;
      return finishCase(run, active, 'process-failed', error);
    }
  }
}

/**
 * Completes evaluation for a normal exit or a readable process or protocol
 * failure: export when the root session is identifiable, patch before
 * evaluators, eligible checks inside the same slot, then a `completed` result
 * that preserves any runtime failure independently of the check outcome.
 */
async function evaluateReadableCase(
  run: RunContext,
  active: ActiveCase,
  preservedFailure: TevuError | null,
): Promise<CaseResult> {
  const caseId = active.identity.caseId;
  emitLifecycle(run, caseId, 'evaluating');

  const sessionId = active.evidence?.sessionId ?? null;
  if (sessionId === null) {
    active.exportUnavailableReason =
      preservedFailure === null
        ? 'root session could not be identified'
        : `root session could not be identified after the failure: ${describeError(preservedFailure)}`;
  } else {
    const adapter = requireCaseAgentAdapter(run, active.identity);
    const exported = await adapter.exportSession(
      sessionId,
      requireCaseAgentEnvironment(active.environments),
    );
    if (exported.ok) {
      const written = await run.dependencies.artifacts.writeSessionExport(caseId, exported.value);
      if (!written.ok) {
        run.state.stopScheduling = true;
        active.exportUnavailableReason = `session export could not be persisted: ${written.error.reason}`;
        return finishCase(run, active, 'infrastructure-failed', written.error);
      }
      active.sessionExport = exported.value;
    } else {
      active.exportUnavailableReason = `root session export failed: ${describeError(exported.error)}`;
      preservedFailure ??= exported.error;
    }
  }
  if (run.state.cancelled) {
    return finishCase(run, active, 'cancelled', preservedFailure);
  }

  const patch = await capturePatch(run, active);
  if (patch.failure !== null) {
    return finishCase(run, active, 'infrastructure-failed', patch.failure);
  }
  if (run.state.cancelled) {
    return finishCase(run, active, 'cancelled', preservedFailure);
  }

  const request = checkStateRequest(active.task, active.overlay);
  if (request !== null) {
    const applied = await run.dependencies.git.applyCheckState(active.workspace, request);
    if (!applied.ok) {
      return finishCase(run, active, 'infrastructure-failed', applied.error);
    }
    active.checkState = applied.value;
  }

  if (active.setup?.before_checks !== undefined) {
    const step = await runSetup(run, active, 'before_checks');
    if (step.status === 'log-failed') {
      return finishCase(run, active, 'infrastructure-failed', step.error);
    }
    if (step.status === 'failed') {
      return finishCase(run, active, 'infrastructure-failed', step.error);
    }
    if (step.status === 'cancelled' || run.state.cancelled) {
      return finishCase(run, active, 'cancelled', preservedFailure);
    }
  }

  const ordered = orderTaskChecks(active.task);
  const evaluated = await evaluateChecks({
    caseId,
    checks: ordered,
    workspace: active.workspace,
    environment: active.environments.evaluator,
    snapshot: run.snapshot,
    terminationGraceMs: run.plan.terminationGraceMs,
    processes: run.dependencies.evaluatorProcesses,
    redact: run.dependencies.redact,
    cancellation: active.abort.signal,
  });
  active.checks = evaluated.ok
    ? evaluated.value
    : [evaluationFailureCheck(run, ordered, evaluated.error)];
  const written = await run.dependencies.artifacts.writeChecks(caseId, active.checks);
  if (!written.ok) {
    run.state.stopScheduling = true;
    return finishCase(run, active, 'infrastructure-failed', written.error);
  }
  active.checksWritten = true;
  if (run.state.cancelled) {
    return finishCase(run, active, 'cancelled', preservedFailure);
  }

  return finishCase(run, active, 'completed', preservedFailure, ordered);
}

/** Patch capture and persistence; a store failure stops scheduling new cases. */
async function capturePatch(
  run: RunContext,
  active: ActiveCase,
): Promise<{ failure: TevuError | null; storeFailure: boolean }> {
  const captured = await run.dependencies.git.capturePatch(
    active.workspace,
    active.patchBase ?? undefined,
  );
  if (!captured.ok) {
    return { failure: captured.error, storeFailure: false };
  }
  const written = await run.dependencies.artifacts.writePatch(
    active.identity.caseId,
    captured.value,
  );
  if (!written.ok) {
    run.state.stopScheduling = true;
    return { failure: written.error, storeFailure: true };
  }
  active.patchWritten = true;
  return { failure: null, storeFailure: false };
}

/** Converts the module-level evaluation error into one failed check with evidence. */
function evaluationFailureCheck(
  run: RunContext,
  ordered: OrderedChecks,
  error: Extract<TevuError, { kind: 'EvaluationError' }>,
): CheckResult {
  const match = ordered.find((check) => check.definition.id === error.checkId);
  return {
    checkId: error.checkId,
    category: match?.category ?? 'acceptance',
    verdict: 'failed',
    evidence: run.dependencies.redact(`check evaluation failed: ${error.reason}`),
    durationMs: null,
  };
}

/**
 * Builds the final case record from the accumulated evidence: terminal
 * lifecycle, outcome from the terminal-lifecycle contract, truthful metrics
 * with the export fallback, the artifact index, and the preserved runtime
 * failure kept distinct from the check-derived outcome.
 */
function finishCase(
  run: RunContext,
  active: ActiveCase,
  lifecycle: Extract<
    CaseLifecycle,
    'completed' | 'process-failed' | 'timed-out' | 'cancelled' | 'infrastructure-failed'
  >,
  failure: TevuError | null,
  ordered?: OrderedChecks,
): CaseResult {
  const caseId = active.identity.caseId;
  const { metrics, protocolFailure } = computeCaseMetrics(run, active);
  const preserved = failure ?? protocolFailure;
  const paths = run.dependencies.artifacts.caseArtifactPaths(caseId);
  return {
    schemaVersion: 1,
    identity: active.identity,
    lifecycle,
    process: active.evidence?.process ?? null,
    outcome:
      lifecycle === 'completed'
        ? reduceRequiredOutcome(
            (ordered ?? orderTaskChecks(active.task)).map((check) => ({
              id: check.definition.id,
              required: check.definition.required,
            })),
            active.checks,
          )
        : 'not-evaluated',
    checks: active.checks,
    metrics,
    artifacts: {
      events: active.events.length > 0 ? paths.events : null,
      diagnostics: active.diagnostics > 0 ? paths.diagnostics : null,
      sessionExport: active.sessionExport !== null ? paths.sessionExport : null,
      solutionPatch: active.patchWritten ? paths.solutionPatch : null,
      checks: active.checksWritten ? paths.checks : null,
      assessment: null,
      result: paths.result,
    },
    failure:
      preserved === null
        ? null
        : { error: preserved, occurredAt: run.dependencies.clock.now().toISOString() },
    ...(active.checkState === null ? {} : { checkState: active.checkState }),
    ...(active.setupCommands.length === 0
      ? {}
      : { setup: { logs: active.setupLogs, commands: active.setupCommands } }),
    context: {
      sourceRepositoryPath: active.workspace.sourceRepositoryPath,
      syntheticCommit: active.workspace.syntheticCommit,
      environment: [
        ...requireCaseAgentEnvironment(active.environments).variableManifest,
        ...active.environments.evaluator.variableManifest,
      ],
    },
  };
}

/** Normalizes metrics through the case's own adapter; a decoding failure stays truthful and preserved. */
function computeCaseMetrics(
  run: RunContext,
  active: ActiveCase,
): {
  metrics: BenchmarkMetrics;
  protocolFailure: Extract<TevuError, { kind: 'AgentProtocolError' }> | null;
} {
  const adapter = requireCaseAgentAdapter(run, active.identity);
  const durationMs = active.evidence?.process.durationMs ?? null;
  const normalized = adapter.normalizeMetrics({
    caseId: active.identity.caseId,
    sessionId: active.evidence?.sessionId ?? null,
    sessionExport: active.sessionExport,
    events: active.events,
    exportUnavailableReason: active.exportUnavailableReason,
  });
  return combineCaseMetrics({
    durationMs,
    elapsedUnavailableReason: 'the agent process produced no timing evidence',
    normalized,
  });
}

/** Final record for a case whose preparation failed before its process started. */
function preparationFailureResult(
  run: RunContext,
  entry: PlannedCase,
  error: TevuError,
): CaseResult {
  const paths = run.dependencies.artifacts.caseArtifactPaths(entry.identity.caseId);
  return {
    schemaVersion: 1,
    identity: entry.identity,
    lifecycle: 'infrastructure-failed',
    process: null,
    outcome: 'not-evaluated',
    checks: [],
    metrics: unavailableBenchmarkMetrics(`case preparation failed: ${describeError(error)}`),
    artifacts: {
      events: null,
      diagnostics: null,
      sessionExport: null,
      solutionPatch: null,
      checks: null,
      assessment: null,
      result: paths.result,
    },
    failure: { error, occurredAt: run.dependencies.clock.now().toISOString() },
  };
}

/**
 * Persists the terminal result and disposes the workspace only after a
 * successful finalization attempt; a persistence failure stops scheduling and
 * retains the workspace, and a cleanup failure becomes a warning finding with
 * the retained path.
 */
async function persistAndCleanup(
  run: RunContext,
  result: CaseResult,
  workspace: CaseWorkspace | null,
): Promise<void> {
  const caseId = result.identity.caseId;
  emitLifecycle(run, caseId, result.lifecycle);
  run.results.set(caseId, result);
  const finalized = await run.dependencies.artifacts.finalizeCase(result);
  if (!finalized.ok) {
    run.state.stopScheduling = true;
    run.findings.push({
      severity: 'error',
      caseId,
      message:
        workspace === null
          ? `case result could not be persisted: ${finalized.error.reason}`
          : `case result could not be persisted (${finalized.error.reason}); workspace retained at "${workspace.worktreeDirectory}"`,
    });
    return;
  }
  if (workspace === null) {
    return;
  }
  const disposed = await run.dependencies.git.dispose(workspace);
  if (!disposed.ok) {
    run.findings.push({
      severity: 'warning',
      caseId,
      message: `case cleanup failed (${disposed.error.reason}); workspace retained at "${workspace.worktreeDirectory}"`,
    });
  }
}

function emitLifecycle(run: RunContext, caseId: string, lifecycle: CaseLifecycle): void {
  run.dependencies.onLifecycle?.(caseId, lifecycle);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Identifier-only description of a typed failure; never includes secret values. */
function describeError(error: TevuError): string {
  switch (error.kind) {
    case 'AgentProcessError':
      return `agent "${error.agent}" process ended with exit code ${String(error.exitCode)} and signal ${String(error.signal)}`;
    case 'AgentProtocolError':
      return `agent "${error.agent}" protocol failure: ${error.reason}`;
    case 'CaseTimeoutError':
      return `case timed out after ${error.timeoutMs}ms`;
    case 'CancellationError':
      return 'the run was cancelled';
    case 'ArtifactError':
      return `artifact operation "${error.operation}" failed: ${error.reason}`;
    case 'SourceMaterializationError':
      return `source materialization failed: ${error.reason}`;
    case 'IsolationError':
      return `case isolation failed: ${error.reason}`;
    case 'EvaluationError':
      return `check "${error.checkId}" evaluation failed: ${error.reason}`;
    default:
      return error.kind;
  }
}
