/**
 * Benchmark planning and bounded orchestration: the deterministic
 * task-by-contender matrix, per-case lifecycle over injected adapter
 * contracts, cancellation coordination, and the shared run exit-status
 * reducer. No concrete adapter, filesystem path, or process global enters
 * this module.
 */

import pLimit from 'p-limit';

import { agentNamesInUse, durationMs } from '@/config/schema';
import { parseGitHubReference } from '@/domain/github-reference';
import { unavailableBenchmarkMetrics } from '@/domain/types';
import {
  buildCheckEnvironment,
  evaluateChecks,
  orderTaskChecks,
  reduceRequiredOutcome,
} from '@/evaluation/checks';
import { applyGrades, gradedChecksOf } from '@/evaluation/grading';
import { combineCaseMetrics } from '@/evaluation/metrics';
import { compareCaseIds } from '@/evaluation/report';

import { buildEnvironmentVariableNames } from './environment-variable-names';
import { gradeCase } from './grade-case';
import { runSetupPhase } from './repository-setup';
import {
  describePullRequestInPrompt,
  describeReferenceCommitInPrompt,
  describeSourceCommitInPrompt,
} from './source-commit-in-prompt';
import { buildTaskPrompt } from './task-prompt';

import type {
  AgentCapabilityReport,
  AgentConfigurationFileRecord,
  AgentEventRecord,
  AgentRegistry,
  AgentRunResult,
  AgentSessionExport,
  BenchmarkMetrics,
  BenchmarkPlan,
  CaseEnvironments,
  CaseGrading,
  CaseIdentity,
  CaseLifecycle,
  CaseResult,
  CaseWorkspace,
  CheckResult,
  CheckStateRecord,
  CheckStateRequest,
  CopiedProvider,
  EffortChecks,
  EnvironmentVariableNames,
  GitWorkspaceAdapter,
  OverlaySnapshot,
  ParentEnvironmentSnapshot,
  PatchBase,
  ProviderSnapshot,
  RepeatSetting,
  RepositoryDefinition,
  RepositorySetup,
  RunDependencies,
  RunFinding,
  RunManifest,
  RunResult,
  SetupCommand,
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
  | 'AgentProcessError'
  | 'AgentProtocolError'
  | 'AgentSessionError'
  | 'CaseTimeoutError'
  | 'CancellationError'
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
  | 'CheckStateError'
  | 'ConfigValidationError';

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
 *
 * `plan.efforts` records `efforts.models` and the grader's check, or `null`
 * when the configuration declares no grader; the plan reads no listing itself.
 */
export function planBenchmark(
  config: TevuConfig,
  configPath: string,
  efforts: EffortChecks,
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
    efforts: { models: { ...efforts.models }, grader: efforts.roles.grader ?? null },
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
  const graderRequiredBy = plan.config.tasks.find((task) => gradedChecksOf(task).length > 0);
  if (graderRequiredBy !== undefined && plan.config.roles?.grader === undefined) {
    return {
      ok: false,
      error: {
        kind: 'PrerequisiteError',
        tool: 'roles.grader',
        expected: `roles.grader declared, because task "${graderRequiredBy.id}" declares a graded check`,
        actual: 'not declared',
      },
    };
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
  const providers = await readRunProviders(plan.config, agents);
  if (!providers.ok) {
    return providers;
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
    tools: {
      gitVersion: host.value.gitVersion,
      agentVersions,
      agentConfigurationFiles: buildAgentConfigurationFileRecords(providers.value, dependencies),
      copiedProviders: buildCopiedProviderRecords(providers.value),
    },
    execution: {
      concurrency: plan.concurrency,
      caseTimeoutMs: plan.defaultCaseTimeoutMs,
      repeat: plan.repeat,
    },
    cases: pinned.value.map((entry) => entry.identity),
    efforts: plan.efforts,
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
    providers: providers.value,
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
  providers: ReadonlyMap<string, ProviderSnapshot>;
  findings: RunFinding[];
  results: Map<string, CaseResult>;
  activeAborts: Map<string, AbortController>;
  state: { cancelled: boolean; stopScheduling: boolean };
};

/** What a started case owns from preparation to its terminal record; built once in `executeCase`. */
type CaseBase = {
  readonly identity: CaseIdentity;
  readonly task: TaskDefinition;
  readonly workspace: CaseWorkspace;
  readonly environments: CaseEnvironments;
  readonly abort: AbortController;
  /** The run's pinned snapshot of `task.checks.overlay`; `null` when the task declares none. */
  readonly overlay: OverlaySnapshot | null;
  /** `entry.repository.setup`; `undefined` when the repository declares no setup. */
  readonly repositorySetup: RepositorySetup | undefined;
};

/** Started setup commands and written phase logs; becomes `CaseResult.setup`. */
type SetupEvidence = {
  readonly logs: { readonly beforeAgent: string | null; readonly beforeChecks: string | null };
  readonly commands: readonly SetupCommandRecord[];
};

/** The root-session export, or the reason the case has none. */
type SessionExportState =
  | { readonly status: 'exported'; readonly value: AgentSessionExport }
  | { readonly status: 'unavailable'; readonly reason: string };

/** `before_agent` passed, or the repository declares none and `patchBase` is `undefined`. */
type AgentReadyCase = CaseBase & {
  readonly stage: 'agent-ready';
  readonly setupEvidence: SetupEvidence;
  readonly patchBase: PatchBase | undefined;
};

/** `adapter.run` settled; `agentResult` is what `onProcess` reported, `null` when the process never started. */
type AgentFinishedCase = Omit<AgentReadyCase, 'stage'> & {
  readonly stage: 'agent-finished';
  readonly agentResult: AgentRunResult | null;
  readonly events: readonly AgentEventRecord[];
  readonly diagnosticCount: number;
};

/** The root-session export is settled; `preservedFailure` is what the record keeps unless a later step ends the case with its own failure. */
type ExportSettledCase = Omit<AgentFinishedCase, 'stage'> & {
  readonly stage: 'export-settled';
  readonly sessionExport: SessionExportState;
  readonly preservedFailure: TevuError | null;
};

/** `solution.patch` is written; `patch` is its content. */
type PatchCapturedCase = Omit<ExportSettledCase, 'stage'> & {
  readonly stage: 'patch-captured';
  readonly patch: string;
};

/** Restore and overlay are applied; `checkState` is `undefined` when the task requests neither. */
type CheckStateAppliedCase = Omit<PatchCapturedCase, 'stage'> & {
  readonly stage: 'check-state-applied';
  readonly checkState: CheckStateRecord | undefined;
};

/** `before_checks` passed or is undeclared. */
type ChecksReadyCase = Omit<CheckStateAppliedCase, 'stage'> & { readonly stage: 'checks-ready' };

/** Checks are evaluated; `checks.json` is not written yet. */
type ChecksEvaluatedCase = Omit<ChecksReadyCase, 'stage'> & {
  readonly stage: 'checks-evaluated';
  readonly orderedChecks: OrderedChecks;
  readonly checkResults: readonly CheckResult[];
};

/** `checks.json` is written. */
type CheckedCase = Omit<ChecksEvaluatedCase, 'stage'> & { readonly stage: 'checked' };

/** `grading.json` is written, or the task declares no graded check and `grading` is `undefined`. */
type EvaluatedCase = Omit<CheckedCase, 'stage'> & {
  readonly stage: 'evaluated';
  readonly grading: CaseGrading | undefined;
};

/** Every stage a case that ran its agent can end from; none ends from `ChecksReadyCase`. */
type FinishableCase =
  | ExportSettledCase
  | PatchCapturedCase
  | CheckStateAppliedCase
  | ChecksEvaluatedCase
  | CheckedCase
  | EvaluatedCase;

/** A step's result: the next stage, or the terminal record the step ended the case with. */
type Transition<Next> =
  | { readonly status: 'advanced'; readonly next: Next }
  | { readonly status: 'ended'; readonly result: CaseResult };

/** How the agent step ended; the first event or diagnostic append failure overrides the adapter outcome. */
type AgentRunEnd =
  | {
      readonly status: 'artifact-failed';
      readonly error: Extract<TevuError, { kind: 'ArtifactError' }>;
    }
  | { readonly status: 'returned'; readonly outcome: AgentRunOutcome };

/** Patch capture followed by `writePatch`. */
type PatchCapture =
  | { readonly status: 'written'; readonly next: PatchCapturedCase }
  | {
      readonly status: 'capture-failed';
      readonly error: Extract<TevuError, { kind: 'SourceMaterializationError' | 'ArtifactError' }>;
    }
  | {
      readonly status: 'store-failed';
      readonly error: Extract<TevuError, { kind: 'ArtifactError' }>;
    };

type NotEvaluatedLifecycle = Extract<
  CaseLifecycle,
  'process-failed' | 'timed-out' | 'cancelled' | 'infrastructure-failed'
>;

/** How a case that ran its agent ends; only an evaluated case completes. */
type CaseEnding =
  | { readonly lifecycle: 'completed'; readonly reached: EvaluatedCase }
  | {
      readonly lifecycle: NotEvaluatedLifecycle;
      readonly reached: FinishableCase;
      readonly failure: TevuError | null;
    };

function cancellationFailure(): {
  ok: false;
  error: Extract<TevuError, { kind: 'CancellationError' }>;
} {
  return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
}

/**
 * Reads providers once for every agent this run's cases start, plus the
 * grader agent when a configured task declares a graded check, in a
 * deterministic agent-name order so the resulting map's iteration order
 * never depends on registration order.
 */
async function readRunProviders(
  config: TevuConfig,
  agents: AgentRegistry,
): Promise<
  TevuResult<ReadonlyMap<string, ProviderSnapshot>, 'PrerequisiteError' | 'ConfigValidationError'>
> {
  const names = [...agentNamesInUse(config)];
  const seen = new Set(names);
  const graderAgent = config.roles?.grader?.agent;
  if (
    graderAgent !== undefined &&
    !seen.has(graderAgent) &&
    config.tasks.some((task) => gradedChecksOf(task).length > 0)
  ) {
    seen.add(graderAgent);
    names.push(graderAgent);
  }

  const providers = new Map<string, ProviderSnapshot>();
  for (const name of names) {
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
    const read = await adapter.readProviders();
    if (!read.ok) {
      return read;
    }
    providers.set(name, read.value);
  }
  return { ok: true, value: providers };
}

/** Maps every read agent's snapshot to the written-file digest record `run.json` stores, never the text itself. */
function buildAgentConfigurationFileRecords(
  providers: ReadonlyMap<string, ProviderSnapshot>,
  dependencies: RunDependencies,
): Record<string, AgentConfigurationFileRecord[]> {
  const records: Record<string, AgentConfigurationFileRecord[]> = {};
  for (const [name, snapshot] of providers) {
    records[name] = snapshot.configurationFiles.map((file) => ({
      path: file.relativePath,
      sha256: dependencies.textDigest(file.text),
    }));
  }
  return records;
}

/** Copies every read agent's copied providers into the record `run.json` stores, detached from the snapshot. */
function buildCopiedProviderRecords(
  providers: ReadonlyMap<string, ProviderSnapshot>,
): Record<string, CopiedProvider[]> {
  const records: Record<string, CopiedProvider[]> = {};
  for (const [name, snapshot] of providers) {
    records[name] = snapshot.copiedProviders.map((provider) => ({
      id: provider.id,
      pricedModels: [...provider.pricedModels],
    }));
  }
  return records;
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
    const prompt = buildTaskPrompt(task);
    const reason = describeSourceCommitInPrompt(prompt, commit);
    if (reason !== undefined) {
      return sourceFailure(task.id, reason);
    }
    const recordedReferenceCommits =
      task.reference === undefined
        ? []
        : task.reference.kind === 'pull-request' && task.reference.merge_commit !== undefined
          ? [...task.reference.commits, task.reference.merge_commit]
          : task.reference.commits;
    for (const referenceCommit of recordedReferenceCommits) {
      const referenceReason = describeReferenceCommitInPrompt(prompt, referenceCommit);
      if (referenceReason !== undefined) {
        return sourceFailure(task.id, referenceReason);
      }
    }
    if (task.reference?.kind === 'pull-request') {
      const parsed = parseGitHubReference(task.reference.identifier);
      if (parsed !== null) {
        const pullRequestReason = describePullRequestInPrompt(prompt, parsed);
        if (pullRequestReason !== undefined) {
          return sourceFailure(task.id, pullRequestReason);
        }
      }
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
  git: Pick<GitWorkspaceAdapter, 'readOverlay'>,
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
      message:
        'The run was cancelled before this attempt started, so it has no result. Run the comparison again to get one.',
    });
    return;
  }
  if (run.state.stopScheduling) {
    run.findings.push({
      severity: 'error',
      caseId,
      message:
        'tevu stopped starting attempts after it failed to save files for an earlier attempt, so this attempt has no result. Fix the failure reported for that attempt and run the comparison again.',
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
    requireCaseAgentProviders(run, entry.identity).configurationFiles,
  );
  if (!environments.ok) {
    await persistAndCleanup(
      run,
      preparationFailureResult(run, entry, environments.error),
      workspace.value,
    );
    return;
  }

  const base: CaseBase = {
    identity: entry.identity,
    task: entry.task,
    workspace: workspace.value,
    environments: environments.value,
    abort: new AbortController(),
    overlay: entry.overlay,
    repositorySetup: entry.repository.setup,
  };
  run.activeAborts.set(caseId, base.abort);
  if (run.state.cancelled) {
    base.abort.abort();
  }

  try {
    await runCase(run, base);
  } finally {
    run.activeAborts.delete(caseId);
  }
}

async function runCase(run: RunContext, base: CaseBase): Promise<void> {
  const ready = await runBeforeAgent(run, base);
  if (ready.status === 'ended') {
    await persistAndCleanup(run, ready.result, base.workspace);
    return;
  }

  const { finished, end } = await runAgent(run, ready.next);
  const result = await concludeCase(run, finished, end);
  await persistAndCleanup(run, result, base.workspace);
}

/** A setup phase the repository declares; only `declaredSetupPhase` builds it, so `phase` and `commands` always match. */
type DeclaredSetupPhase = {
  readonly phase: SetupPhase;
  readonly commands: readonly SetupCommand[];
  readonly repositorySetup: RepositorySetup;
};

/** Every variant carries the setup evidence after the phase. */
type SetupStepResult =
  | { readonly status: 'passed' | 'cancelled'; readonly evidence: SetupEvidence }
  | {
      readonly status: 'failed';
      readonly evidence: SetupEvidence;
      readonly error: Extract<TevuError, { kind: 'SetupError' }>;
    }
  | {
      readonly status: 'log-failed';
      readonly evidence: SetupEvidence;
      readonly error: Extract<TevuError, { kind: 'ArtifactError' }>;
    };

/** Reports the phase the repository declares, or `undefined` when it declares none. */
function declaredSetupPhase(
  repositorySetup: RepositorySetup | undefined,
  phase: SetupPhase,
): DeclaredSetupPhase | undefined {
  const commands = repositorySetup?.[phase];
  if (repositorySetup === undefined || commands === undefined) {
    return undefined;
  }
  return { phase, commands, repositorySetup };
}

/**
 * Runs one declared setup phase's commands, shared by `before_agent` and
 * `before_checks`. Adds every started command to the evidence and, when at
 * least one command started, writes the phase log and records its path. A
 * log-write failure stops further case scheduling, as a failed event or
 * diagnostic append does mid-case, and wins over the phase status.
 */
async function runSetup(
  run: RunContext,
  base: CaseBase,
  evidence: SetupEvidence,
  declared: DeclaredSetupPhase,
): Promise<SetupStepResult> {
  const { phase, commands, repositorySetup } = declared;
  const outcome = await runSetupPhase({
    phase,
    commands,
    timeoutMs: durationMs(repositorySetup.timeout),
    terminationGraceMs: run.plan.terminationGraceMs,
    worktreeDirectory: base.workspace.worktreeDirectory,
    environment: buildCheckEnvironment(
      base.environments.evaluator,
      run.snapshot,
      repositorySetup.env,
    ),
    processes: run.dependencies.evaluatorProcesses,
    cancellation: base.abort.signal,
  });
  const started = [...evidence.commands, ...outcome.commands];
  const settle = (settled: SetupEvidence): SetupStepResult =>
    outcome.status === 'failed'
      ? { status: 'failed', evidence: settled, error: outcome.error }
      : { status: outcome.status, evidence: settled };
  if (outcome.commands.length === 0) {
    return settle({ logs: evidence.logs, commands: started });
  }
  const caseId = base.identity.caseId;
  const written = await run.dependencies.artifacts.writeSetupLog(caseId, phase, outcome.log);
  if (!written.ok) {
    run.state.stopScheduling = true;
    return {
      status: 'log-failed',
      evidence: { logs: evidence.logs, commands: started },
      error: written.error,
    };
  }
  const paths = run.dependencies.artifacts.caseArtifactPaths(caseId);
  const logs =
    phase === 'before_agent'
      ? { beforeAgent: paths.setupBeforeAgent, beforeChecks: evidence.logs.beforeChecks }
      : { beforeAgent: evidence.logs.beforeAgent, beforeChecks: paths.setupBeforeChecks };
  return settle({ logs, commands: started });
}

/**
 * Runs `before_agent` setup when the repository declares it and, on success,
 * records the patch base. Ends the case when the agent must never start.
 */
async function runBeforeAgent(
  run: RunContext,
  base: CaseBase,
): Promise<Transition<AgentReadyCase>> {
  const noEvidence: SetupEvidence = {
    logs: { beforeAgent: null, beforeChecks: null },
    commands: [],
  };
  const declared = declaredSetupPhase(base.repositorySetup, 'before_agent');
  if (declared === undefined) {
    return {
      status: 'advanced',
      next: { ...base, stage: 'agent-ready', setupEvidence: noEvidence, patchBase: undefined },
    };
  }

  const step = await runSetup(run, base, noEvidence, declared);
  const cancelled = (): Transition<AgentReadyCase> => ({
    status: 'ended',
    result: agentNotStartedResult(
      run,
      base,
      step.evidence,
      'cancelled',
      { kind: 'CancellationError', activeCaseIds: [base.identity.caseId] },
      'the case was cancelled before the agent started',
    ),
  });
  if (step.status === 'log-failed') {
    return {
      status: 'ended',
      result: agentNotStartedResult(
        run,
        base,
        step.evidence,
        'infrastructure-failed',
        step.error,
        'the setup.before_agent log could not be written; the agent did not start',
      ),
    };
  }
  if (step.status === 'failed') {
    return {
      status: 'ended',
      result: agentNotStartedResult(
        run,
        base,
        step.evidence,
        'infrastructure-failed',
        step.error,
        'setup.before_agent failed; the agent did not start',
      ),
    };
  }
  if (step.status === 'cancelled' || run.state.cancelled) {
    return cancelled();
  }

  const patchBase = await run.dependencies.git.snapshotPatchBase(base.workspace);
  if (!patchBase.ok) {
    return {
      status: 'ended',
      result: agentNotStartedResult(
        run,
        base,
        step.evidence,
        'infrastructure-failed',
        patchBase.error,
        'the patch base could not be recorded; the agent did not start',
      ),
    };
  }
  if (run.state.cancelled) {
    return cancelled();
  }
  return {
    status: 'advanced',
    next: {
      ...base,
      stage: 'agent-ready',
      setupEvidence: step.evidence,
      patchBase: patchBase.value,
    },
  };
}

/**
 * Builds the terminal case result for a case whose `before_agent` setup
 * never let the agent start: `adapter.run` is never called. Metrics are
 * unavailable with the given run-time reason; `setup` is present only when
 * at least one setup command started.
 */
function agentNotStartedResult(
  run: RunContext,
  base: CaseBase,
  evidence: SetupEvidence,
  lifecycle: Extract<CaseLifecycle, 'infrastructure-failed' | 'cancelled'>,
  failure: TevuError,
  reason: string,
): CaseResult {
  const paths = run.dependencies.artifacts.caseArtifactPaths(base.identity.caseId);
  return {
    schemaVersion: 1,
    identity: base.identity,
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
      grading: null,
      result: paths.result,
    },
    failure: { error: failure, occurredAt: run.dependencies.clock.now().toISOString() },
    ...(evidence.commands.length === 0
      ? {}
      : { setup: { logs: evidence.logs, commands: [...evidence.commands] } }),
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

/** Resolves the provider snapshot `runBenchmark` already read for this case's agent. */
function requireCaseAgentProviders(run: RunContext, identity: CaseIdentity): ProviderSnapshot {
  const providers = identity.agent === undefined ? undefined : run.providers.get(identity.agent);
  if (providers === undefined) {
    throw new Error(
      `unreachable: runBenchmark already read providers for agent "${String(identity.agent)}"`,
    );
  }
  return providers;
}

/** Resolves the provider snapshot `runBenchmark` already read for the configured grader agent. */
function requireGraderProviders(run: RunContext): ProviderSnapshot {
  const graderAgent = run.plan.config.roles?.grader?.agent;
  const providers = graderAgent === undefined ? undefined : run.providers.get(graderAgent);
  if (providers === undefined) {
    throw new Error('unreachable: runBenchmark already read providers for the grader agent');
  }
  return providers;
}

/**
 * Runs the case's single agent process. A failed event or diagnostic append
 * stops scheduling, aborts the process, and keeps the first failure, which
 * overrides the adapter outcome.
 */
async function runAgent(
  run: RunContext,
  ready: AgentReadyCase,
): Promise<{ finished: AgentFinishedCase; end: AgentRunEnd }> {
  const caseId = ready.identity.caseId;
  const adapter = requireCaseAgentAdapter(run, ready.identity);
  const events: AgentEventRecord[] = [];
  const observed: {
    diagnosticCount: number;
    agentResult: AgentRunResult | null;
    appendFailure: Extract<TevuError, { kind: 'ArtifactError' }> | undefined;
  } = { diagnosticCount: 0, agentResult: null, appendFailure: undefined };
  const recordAppendFailure = (error: Extract<TevuError, { kind: 'ArtifactError' }>): void => {
    observed.appendFailure ??= error;
    run.state.stopScheduling = true;
    ready.abort.abort();
  };

  emitLifecycle(run, caseId, 'running');
  const outcome = await adapter.run({
    identity: ready.identity,
    prompt: buildTaskPrompt(ready.task),
    worktreeDirectory: ready.workspace.worktreeDirectory,
    environment: ready.environments.agent,
    timeoutMs: ready.identity.timeoutMs,
    terminationGraceMs: run.plan.terminationGraceMs,
    cancellation: ready.abort.signal,
    onEvent: async (event) => {
      events.push(event);
      const appended = await run.dependencies.artifacts.appendEvent(caseId, event);
      if (!appended.ok) {
        recordAppendFailure(appended.error);
      }
      return appended;
    },
    onDiagnostic: async (line) => {
      observed.diagnosticCount += 1;
      const appended = await run.dependencies.artifacts.appendDiagnostic(caseId, line);
      if (!appended.ok) {
        recordAppendFailure(appended.error);
      }
      return appended;
    },
    onProcess: (agentResult) => {
      observed.agentResult = agentResult;
    },
  });

  const finished: AgentFinishedCase = {
    ...ready,
    stage: 'agent-finished',
    agentResult: observed.agentResult,
    events,
    diagnosticCount: observed.diagnosticCount,
  };
  const end: AgentRunEnd =
    observed.appendFailure === undefined
      ? { status: 'returned', outcome }
      : { status: 'artifact-failed', error: observed.appendFailure };
  return { finished, end };
}

/** Settles the export step with no root-session export, keeping `preservedFailure` for the record. */
function settleWithoutExport(
  finished: AgentFinishedCase,
  reason: string,
  preservedFailure: TevuError | null,
): ExportSettledCase {
  return {
    ...finished,
    stage: 'export-settled',
    sessionExport: { status: 'unavailable', reason },
    preservedFailure,
  };
}

/** Maps one finished agent run to the case's terminal result. */
async function concludeCase(
  run: RunContext,
  finished: AgentFinishedCase,
  end: AgentRunEnd,
): Promise<CaseResult> {
  if (end.status === 'artifact-failed') {
    return finishCase(run, {
      lifecycle: 'infrastructure-failed',
      reached: settleWithoutExport(
        finished,
        'an artifact failure ended the case before the root session could be exported',
        end.error,
      ),
      failure: end.error,
    });
  }
  const outcome = end.outcome;
  if (outcome.ok) {
    return evaluateReadableCase(run, finished, null);
  }
  const error = outcome.error;
  switch (error.kind) {
    case 'CancellationError':
      return finishCase(run, {
        lifecycle: 'cancelled',
        reached: settleWithoutExport(
          finished,
          'the case was cancelled before the root session could be exported',
          error,
        ),
        failure: error,
      });
    case 'CaseTimeoutError': {
      const settled = settleWithoutExport(
        finished,
        'the case timed out before the root session could be exported',
        error,
      );
      const patch = await capturePatch(run, settled);
      if (patch.status === 'written') {
        return finishCase(run, { lifecycle: 'timed-out', reached: patch.next, failure: error });
      }
      if (patch.status === 'store-failed') {
        return finishCase(run, {
          lifecycle: 'infrastructure-failed',
          reached: settled,
          failure: patch.error,
        });
      }
      run.findings.push({
        severity: 'warning',
        caseId: finished.identity.caseId,
        message: `tevu could not save the changes this attempt made before its time limit ended it, so its solution patch is missing. The attempt counts as not evaluated either way. Nothing more is needed for this run. Technical detail: ${describeError(patch.error)}`,
      });
      return finishCase(run, { lifecycle: 'timed-out', reached: settled, failure: error });
    }
    case 'AgentProcessError':
    case 'AgentProtocolError':
    case 'AgentSessionError': {
      const readable = await run.dependencies.git.isReadable(finished.workspace);
      if (readable) {
        return evaluateReadableCase(run, finished, error);
      }
      return finishCase(run, {
        lifecycle: 'process-failed',
        reached: settleWithoutExport(
          finished,
          `the workspace was unreadable after the failure: ${describeError(error)}`,
          error,
        ),
        failure: error,
      });
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
  finished: AgentFinishedCase,
  runtimeFailure: TevuError | null,
): Promise<CaseResult> {
  emitLifecycle(run, finished.identity.caseId, 'evaluating');

  const settled = await exportRootSession(run, finished, runtimeFailure);
  if (settled.status === 'ended') {
    return settled.result;
  }
  const captured = await captureSolutionPatch(run, settled.next);
  if (captured.status === 'ended') {
    return captured.result;
  }
  const applied = await applyCaseCheckState(run, captured.next);
  if (applied.status === 'ended') {
    return applied.result;
  }
  const ready = await runBeforeChecks(run, applied.next);
  if (ready.status === 'ended') {
    return ready.result;
  }
  const checked = await runChecks(run, ready.next);
  if (checked.status === 'ended') {
    return checked.result;
  }
  const evaluated = await gradeChecks(run, checked.next);
  if (evaluated.status === 'ended') {
    return evaluated.result;
  }
  return finishCase(run, { lifecycle: 'completed', reached: evaluated.next });
}

/**
 * Exports the root session when it is identifiable and writes the export. A
 * cancelled run ends the case here with the export already settled.
 */
async function exportRootSession(
  run: RunContext,
  finished: AgentFinishedCase,
  runtimeFailure: TevuError | null,
): Promise<Transition<ExportSettledCase>> {
  const sessionId = finished.agentResult?.sessionId ?? null;
  let settled: ExportSettledCase;
  if (sessionId === null) {
    settled = settleWithoutExport(
      finished,
      runtimeFailure === null
        ? 'root session could not be identified'
        : `root session could not be identified after the failure: ${describeError(runtimeFailure)}`,
      runtimeFailure,
    );
  } else {
    const adapter = requireCaseAgentAdapter(run, finished.identity);
    const exported = await adapter.exportSession(sessionId, finished.environments.agent);
    if (exported.ok) {
      const written = await run.dependencies.artifacts.writeSessionExport(
        finished.identity.caseId,
        exported.value,
      );
      if (!written.ok) {
        run.state.stopScheduling = true;
        return {
          status: 'ended',
          result: finishCase(run, {
            lifecycle: 'infrastructure-failed',
            reached: settleWithoutExport(
              finished,
              `session export could not be persisted: ${written.error.reason}`,
              runtimeFailure,
            ),
            failure: written.error,
          }),
        };
      }
      settled = {
        ...finished,
        stage: 'export-settled',
        sessionExport: { status: 'exported', value: exported.value },
        preservedFailure: runtimeFailure,
      };
    } else {
      settled = settleWithoutExport(
        finished,
        `root session export failed: ${describeError(exported.error)}`,
        runtimeFailure ?? exported.error,
      );
    }
  }
  if (run.state.cancelled) {
    return {
      status: 'ended',
      result: finishCase(run, {
        lifecycle: 'cancelled',
        reached: settled,
        failure: settled.preservedFailure,
      }),
    };
  }
  return { status: 'advanced', next: settled };
}

/** Patch capture and persistence; a store failure stops scheduling new cases. */
async function capturePatch(run: RunContext, settled: ExportSettledCase): Promise<PatchCapture> {
  const captured = await run.dependencies.git.capturePatch(settled.workspace, settled.patchBase);
  if (!captured.ok) {
    return { status: 'capture-failed', error: captured.error };
  }
  const written = await run.dependencies.artifacts.writePatch(
    settled.identity.caseId,
    captured.value,
  );
  if (!written.ok) {
    run.state.stopScheduling = true;
    return { status: 'store-failed', error: written.error };
  }
  return {
    status: 'written',
    next: { ...settled, stage: 'patch-captured', patch: captured.value.content },
  };
}

/**
 * Captures and writes the solution patch before any step that applies check
 * state or runs a check; a cancelled run ends the case with the patch written.
 */
async function captureSolutionPatch(
  run: RunContext,
  settled: ExportSettledCase,
): Promise<Transition<PatchCapturedCase>> {
  const capture = await capturePatch(run, settled);
  if (capture.status !== 'written') {
    return {
      status: 'ended',
      result: finishCase(run, {
        lifecycle: 'infrastructure-failed',
        reached: settled,
        failure: capture.error,
      }),
    };
  }
  if (run.state.cancelled) {
    return {
      status: 'ended',
      result: finishCase(run, {
        lifecycle: 'cancelled',
        reached: capture.next,
        failure: capture.next.preservedFailure,
      }),
    };
  }
  return { status: 'advanced', next: capture.next };
}

/**
 * Applies restore and overlay to the worktree. Accepts only a case whose
 * solution patch is already written, so no check state can reach the patch.
 */
async function applyCaseCheckState(
  run: RunContext,
  captured: PatchCapturedCase,
): Promise<Transition<CheckStateAppliedCase>> {
  const request = checkStateRequest(captured.task, captured.overlay);
  if (request === null) {
    return {
      status: 'advanced',
      next: { ...captured, stage: 'check-state-applied', checkState: undefined },
    };
  }
  const applied = await run.dependencies.git.applyCheckState(captured.workspace, request);
  if (!applied.ok) {
    return {
      status: 'ended',
      result: finishCase(run, {
        lifecycle: 'infrastructure-failed',
        reached: captured,
        failure: applied.error,
      }),
    };
  }
  return {
    status: 'advanced',
    next: { ...captured, stage: 'check-state-applied', checkState: applied.value },
  };
}

/**
 * Runs `before_checks` setup when the repository declares it. The phase
 * evidence reaches the record whether the phase passes or ends the case.
 */
async function runBeforeChecks(
  run: RunContext,
  applied: CheckStateAppliedCase,
): Promise<Transition<ChecksReadyCase>> {
  const declared = declaredSetupPhase(applied.repositorySetup, 'before_checks');
  if (declared === undefined) {
    return { status: 'advanced', next: { ...applied, stage: 'checks-ready' } };
  }
  const step = await runSetup(run, applied, applied.setupEvidence, declared);
  const withPhaseEvidence: CheckStateAppliedCase = { ...applied, setupEvidence: step.evidence };
  if (step.status === 'log-failed' || step.status === 'failed') {
    return {
      status: 'ended',
      result: finishCase(run, {
        lifecycle: 'infrastructure-failed',
        reached: withPhaseEvidence,
        failure: step.error,
      }),
    };
  }
  if (step.status === 'cancelled' || run.state.cancelled) {
    return {
      status: 'ended',
      result: finishCase(run, {
        lifecycle: 'cancelled',
        reached: withPhaseEvidence,
        failure: withPhaseEvidence.preservedFailure,
      }),
    };
  }
  return { status: 'advanced', next: { ...withPhaseEvidence, stage: 'checks-ready' } };
}

/**
 * Evaluates the task's checks and writes `checks.json`. A check evaluation
 * that fails as a whole is recorded as one failed check.
 */
async function runChecks(
  run: RunContext,
  ready: ChecksReadyCase,
): Promise<Transition<CheckedCase>> {
  const caseId = ready.identity.caseId;
  const orderedChecks = orderTaskChecks(ready.task);
  const evaluated = await evaluateChecks({
    caseId,
    checks: orderedChecks,
    workspace: ready.workspace,
    environment: ready.environments.evaluator,
    snapshot: run.snapshot,
    terminationGraceMs: run.plan.terminationGraceMs,
    processes: run.dependencies.evaluatorProcesses,
    redact: run.dependencies.redact,
    cancellation: ready.abort.signal,
  });
  const checkResults = evaluated.ok
    ? evaluated.value
    : [evaluationFailureCheck(run, orderedChecks, evaluated.error)];
  const evaluatedCase: ChecksEvaluatedCase = {
    ...ready,
    stage: 'checks-evaluated',
    orderedChecks,
    checkResults,
  };
  const written = await run.dependencies.artifacts.writeChecks(caseId, [...checkResults]);
  if (!written.ok) {
    run.state.stopScheduling = true;
    return {
      status: 'ended',
      result: finishCase(run, {
        lifecycle: 'infrastructure-failed',
        reached: evaluatedCase,
        failure: written.error,
      }),
    };
  }
  const checked: CheckedCase = { ...evaluatedCase, stage: 'checked' };
  if (run.state.cancelled) {
    return {
      status: 'ended',
      result: finishCase(run, {
        lifecycle: 'cancelled',
        reached: checked,
        failure: checked.preservedFailure,
      }),
    };
  }
  return { status: 'advanced', next: checked };
}

/**
 * Grades the task's graded checks from the solution patch and writes
 * `grading.json`; a task without a graded check passes through unchanged.
 * Every grading directory the grader could not delete becomes a warning.
 */
async function gradeChecks(
  run: RunContext,
  checked: CheckedCase,
): Promise<Transition<EvaluatedCase>> {
  if (gradedChecksOf(checked.task).length === 0) {
    return { status: 'advanced', next: { ...checked, stage: 'evaluated', grading: undefined } };
  }
  const caseId = checked.identity.caseId;
  const outcome = await gradeCase(
    {
      config: run.plan.config,
      task: checked.task,
      patch: checked.patch,
      timeoutMs: run.plan.defaultCaseTimeoutMs,
      redact: run.dependencies.redact,
      cancellation: checked.abort.signal,
      providers: requireGraderProviders(run),
    },
    {
      agents: run.agents,
      environments: run.dependencies.environments,
      git: run.dependencies.git,
    },
  );
  for (const directory of outcome.retainedDirectories) {
    run.dependencies.onRetainedGradingDirectory?.(directory);
    run.findings.push({
      severity: 'warning',
      caseId,
      message: `tevu could not delete the temporary directory of this attempt's grading call. The results are not affected. Delete \`${directory}\` when no tevu command uses it.`,
    });
  }
  if (outcome.status === 'cancelled') {
    return {
      status: 'ended',
      result: finishCase(run, {
        lifecycle: 'cancelled',
        reached: checked,
        failure: checked.preservedFailure,
      }),
    };
  }
  const written = await run.dependencies.artifacts.writeGrading(caseId, outcome.grading);
  if (!written.ok) {
    run.state.stopScheduling = true;
    return {
      status: 'ended',
      result: finishCase(run, {
        lifecycle: 'infrastructure-failed',
        reached: checked,
        failure: written.error,
      }),
    };
  }
  const evaluated: EvaluatedCase = { ...checked, stage: 'evaluated', grading: outcome.grading };
  if (run.state.cancelled) {
    return {
      status: 'ended',
      result: finishCase(run, {
        lifecycle: 'cancelled',
        reached: evaluated,
        failure: evaluated.preservedFailure,
      }),
    };
  }
  return { status: 'advanced', next: evaluated };
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
 * Builds the final case record from the stage the case reached: terminal
 * lifecycle, outcome from the terminal-lifecycle contract, truthful metrics
 * with the export fallback, the artifact index, and the preserved runtime
 * failure kept distinct from the check-derived outcome.
 */
function finishCase(run: RunContext, ending: CaseEnding): CaseResult {
  const { reached } = ending;
  const caseId = reached.identity.caseId;
  const { metrics, protocolFailure } = computeCaseMetrics(run, reached);
  const recordedFailure =
    (ending.lifecycle === 'completed' ? reached.preservedFailure : ending.failure) ??
    protocolFailure;
  const paths = run.dependencies.artifacts.caseArtifactPaths(caseId);
  const hasCheckResults =
    reached.stage === 'checks-evaluated' ||
    reached.stage === 'checked' ||
    reached.stage === 'evaluated';
  const grading = reached.stage === 'evaluated' ? reached.grading : undefined;
  const gradedChecks = applyGrades(hasCheckResults ? reached.checkResults : [], grading ?? null);
  const checkState =
    reached.stage === 'export-settled' || reached.stage === 'patch-captured'
      ? undefined
      : reached.checkState;
  return {
    schemaVersion: 1,
    identity: reached.identity,
    lifecycle: ending.lifecycle,
    process: reached.agentResult?.process ?? null,
    outcome:
      ending.lifecycle === 'completed'
        ? reduceRequiredOutcome(
            ending.reached.orderedChecks.map((check) => ({
              id: check.definition.id,
              required: check.definition.required,
            })),
            gradedChecks,
          )
        : 'not-evaluated',
    checks: gradedChecks,
    metrics,
    artifacts: {
      events: reached.events.length > 0 ? paths.events : null,
      diagnostics: reached.diagnosticCount > 0 ? paths.diagnostics : null,
      sessionExport: reached.sessionExport.status === 'exported' ? paths.sessionExport : null,
      solutionPatch: reached.stage === 'export-settled' ? null : paths.solutionPatch,
      checks: reached.stage === 'checked' || reached.stage === 'evaluated' ? paths.checks : null,
      assessment: null,
      grading: grading === undefined ? null : paths.grading,
      result: paths.result,
    },
    failure:
      recordedFailure === null
        ? null
        : { error: recordedFailure, occurredAt: run.dependencies.clock.now().toISOString() },
    ...(checkState === undefined ? {} : { checkState }),
    ...(reached.setupEvidence.commands.length === 0
      ? {}
      : {
          setup: {
            logs: reached.setupEvidence.logs,
            commands: [...reached.setupEvidence.commands],
          },
        }),
    context: {
      sourceRepositoryPath: reached.workspace.sourceRepositoryPath,
      syntheticCommit: reached.workspace.syntheticCommit,
      environment: [
        ...reached.environments.agent.variableManifest,
        ...reached.environments.evaluator.variableManifest,
      ],
    },
  };
}

/** Normalizes metrics through the case's own adapter; a decoding failure stays truthful and preserved. */
function computeCaseMetrics(
  run: RunContext,
  reached: FinishableCase,
): {
  metrics: BenchmarkMetrics;
  protocolFailure: Extract<TevuError, { kind: 'AgentProtocolError' }> | null;
} {
  const adapter = requireCaseAgentAdapter(run, reached.identity);
  const durationMs = reached.agentResult?.process.durationMs ?? null;
  const normalized = adapter.normalizeMetrics({
    caseId: reached.identity.caseId,
    sessionId: reached.agentResult?.sessionId ?? null,
    sessionExport: reached.sessionExport.status === 'exported' ? reached.sessionExport.value : null,
    events: reached.events,
    exportUnavailableReason:
      reached.sessionExport.status === 'unavailable' ? reached.sessionExport.reason : undefined,
    copiedProviders: requireCaseAgentProviders(run, reached.identity).copiedProviders,
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
      grading: null,
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
          ? `tevu could not save the result of this attempt, so the report of this run cannot be built. Check free space and permissions of the output directory, then run the comparison again. Technical detail: ${finalized.error.reason}`
          : `tevu could not save the result of this attempt, so the report of this run cannot be built; its workspace is kept at \`${workspace.worktreeDirectory}\`. Check free space and permissions of the output directory, run the comparison again, and delete the kept workspace when you no longer need it. Technical detail: ${finalized.error.reason}`,
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
      message: `tevu could not delete the workspace of this attempt, which is kept at \`${workspace.worktreeDirectory}\`. The results are not affected. Delete it when you no longer need it. Technical detail: ${disposed.error.reason}`,
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
    case 'AgentSessionError':
      return `agent "${error.agent}" reported a session error`;
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
    case 'ConfigParseError':
    case 'ConfigValidationError':
    case 'ConfigReadError':
    case 'ConfigNotFoundError':
    case 'PrerequisiteError':
    case 'IssueImportError':
    case 'ModelCallError':
    case 'AssessmentConflictError':
    case 'RedactionError':
    case 'CheckStateError':
    case 'SetupError':
    case 'ReferenceResolutionError':
    case 'ManagedCloneError':
      return error.kind;
  }
}
