/**
 * Benchmark planning and bounded orchestration: the deterministic
 * task-by-contender matrix, per-case lifecycle over injected adapter
 * contracts, cancellation coordination, and the shared run exit-status
 * reducer. No concrete adapter, filesystem path, or process global enters
 * this module.
 */

import pLimit from "p-limit";

import { durationMs } from "../config/schema.ts";
import { evaluateChecks, orderTaskChecks, reduceRequiredOutcome } from "../evaluation/checks.ts";
import { normalizeMetrics, unavailableBenchmarkMetrics } from "../evaluation/metrics.ts";
import { describeSourceCommitInPrompt } from "./source-commit-in-prompt.ts";

import type { TaskDefinition, TevuConfig } from "../config/schema.ts";
import type {
  BenchmarkMetrics,
  BenchmarkPlan,
  CaseEnvironments,
  CaseIdentity,
  CaseLifecycle,
  CaseResult,
  CaseWorkspace,
  CheckResult,
  OpenCodeExport,
  OpenCodeRunEvent,
  OpenCodeRunResult,
  ParentEnvironmentSnapshot,
  RunDependencies,
  RunFinding,
  RunManifest,
  RunResult,
  TevuError,
  TevuResult,
} from "../domain/types.ts";
import type { OrderedCheck } from "../evaluation/checks.ts";

type OrderedChecks = readonly OrderedCheck[];

/** Result of the single managed OpenCode process one case owns. */
type OpenCodeRunOutcome = TevuResult<
  OpenCodeRunResult,
  "OpenCodeProcessError" | "OpenCodeProtocolError" | "CaseTimeoutError" | "CancellationError"
>;

/** Error kinds the benchmark orchestration contract declares. */
type RunBenchmarkErrorKind =
  | "PrerequisiteError"
  | "SourceMaterializationError"
  | "IsolationError"
  | "OpenCodeProcessError"
  | "OpenCodeProtocolError"
  | "CaseTimeoutError"
  | "EvaluationError"
  | "ArtifactError"
  | "CancellationError";

/**
 * Builds the deterministic task-by-contender execution plan purely from
 * configuration: cases in configuration task order then contender order, with
 * the declared (not yet resolved) start commit and the configured limits.
 */
export function planBenchmark(config: TevuConfig): BenchmarkPlan {
  const cases: CaseIdentity[] = [];
  for (const task of config.tasks) {
    for (const model of config.models) {
      cases.push({
        caseId: `${task.id}--${model.id}`,
        taskId: task.id,
        modelId: model.id,
        sourceCommit: task.base_commit,
        model: model.model,
        effort: model.effort,
      });
    }
  }
  return {
    config,
    cases,
    concurrency: config.run.concurrency,
    caseTimeoutMs: durationMs(config.run.timeout),
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
): RunResult["exitCode"] {
  if (cancelled || cases.some((current) => current.lifecycle === "cancelled")) {
    return 130;
  }
  const incomplete =
    findings.some((finding) => finding.severity === "error") ||
    cases.some((current) => current.lifecycle === "infrastructure-failed");
  if (incomplete) {
    return 1;
  }
  const degraded = cases.some(
    (current) =>
      current.lifecycle === "timed-out" ||
      current.lifecycle === "process-failed" ||
      current.outcome === "failed" ||
      current.outcome === "pending" ||
      current.failure !== null,
  );
  return degraded ? 2 : 0;
}

/**
 * Orchestrates one bounded benchmark run over injected adapters: local
 * prerequisite validation and commit pinning before the first write, one
 * immutable parent-environment snapshot before scheduling, `p-limit` bounded
 * case slots that include acceptance evaluation, exactly one OpenCode process
 * per planned case with no retry, the binding lifecycle and failure mappings,
 * artifact-failure scheduling stop, and bounded cancellation finalization.
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
  const host = await dependencies.prerequisites.probeHost();
  if (!host.ok) {
    return host;
  }
  const snapshot = dependencies.environments.snapshotParent(plan.config);
  if (!snapshot.ok) {
    return snapshot;
  }
  const probe = await dependencies.opencode.probe(plan.config.agents.opencode.command);
  if (!probe.ok) {
    return probe;
  }
  const planned = await resolvePlannedCases(plan, dependencies);
  if (!planned.ok) {
    return planned;
  }
  if (dependencies.cancellation.aborted) {
    return cancellationFailure();
  }

  const startedAt = dependencies.clock.now();
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId: dependencies.generateRunId(startedAt),
    configDigest: dependencies.configDigest(plan.config),
    startedAt: startedAt.toISOString(),
    completedAt: null,
    host: {
      platform: host.value.platform,
      nodeVersion: host.value.nodeVersion,
      bunVersion: host.value.bunVersion,
    },
    tools: { gitVersion: host.value.gitVersion, opencodeVersion: probe.value.detectedVersion },
    execution: { concurrency: plan.concurrency, caseTimeoutMs: plan.caseTimeoutMs },
    cases: planned.value.map((entry) => entry.identity),
    context: { config: plan.config, capabilities: probe.value },
  };
  const started = await dependencies.artifacts.startRun(manifest);
  if (!started.ok) {
    return started;
  }

  const run: RunContext = {
    plan,
    dependencies,
    snapshot: snapshot.value,
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
    dependencies.cancellation.addEventListener("abort", onRunAbort, { once: true });
  }

  for (const entry of planned.value) {
    emitLifecycle(run, entry.identity.caseId, "queued");
  }
  const limit = pLimit(plan.concurrency);
  await Promise.all(planned.value.map((entry) => limit(() => executeCase(run, entry))));
  dependencies.cancellation.removeEventListener("abort", onRunAbort);

  const cases = planned.value.flatMap((entry) => {
    const result = run.results.get(entry.identity.caseId);
    return result === undefined ? [] : [result];
  });
  const findings = [...run.findings].sort(
    (a, b) =>
      compareStrings(a.caseId ?? "", b.caseId ?? "") || compareStrings(a.message, b.message),
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

/** One planned case with its pinned identity and resolved task definition. */
type PlannedCase = {
  identity: CaseIdentity;
  task: TaskDefinition;
};

/** Mutable state shared by every scheduled case of one run. */
type RunContext = {
  plan: BenchmarkPlan;
  dependencies: RunDependencies;
  snapshot: ParentEnvironmentSnapshot;
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
  events: OpenCodeRunEvent[];
  diagnostics: number;
  evidence: OpenCodeRunResult | null;
  artifactFailure: TevuError | null;
  sessionExport: OpenCodeExport | null;
  exportUnavailableReason: string | undefined;
  patchWritten: boolean;
  checks: CheckResult[];
  checksWritten: boolean;
};

function cancellationFailure(): {
  ok: false;
  error: Extract<TevuError, { kind: "CancellationError" }>;
} {
  return { ok: false, error: { kind: "CancellationError", activeCaseIds: [] } };
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
): Promise<TevuResult<PlannedCase[], "SourceMaterializationError">> {
  const tasks = new Map(plan.config.tasks.map((task) => [task.id, task]));
  const repositories = new Map(
    plan.config.repositories.map((repository) => [repository.id, repository]),
  );
  const resolvedCommits = new Map<string, string>();
  const planned: PlannedCase[] = [];
  for (const identity of plan.cases) {
    const task = tasks.get(identity.taskId);
    if (task === undefined) {
      return sourceFailure(identity.taskId, "task is not defined in the configuration");
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
    const reason = describeSourceCommitInPrompt(dependencies.buildTaskPrompt(task), commit);
    if (reason !== undefined) {
      return sourceFailure(task.id, reason);
    }
    planned.push({ identity: { ...identity, sourceCommit: commit }, task });
  }
  return { ok: true, value: planned };
}

function sourceFailure(
  taskId: string,
  reason: string,
): { ok: false; error: Extract<TevuError, { kind: "SourceMaterializationError" }> } {
  return { ok: false, error: { kind: "SourceMaterializationError", taskId, reason } };
}

/** Runs one case inside its concurrency slot from queued skip checks to cleanup. */
async function executeCase(run: RunContext, entry: PlannedCase): Promise<void> {
  const caseId = entry.identity.caseId;
  if (run.state.cancelled) {
    run.findings.push({
      severity: "warning",
      caseId,
      message: "case was still queued when the run was cancelled and was not started",
    });
    return;
  }
  if (run.state.stopScheduling) {
    run.findings.push({
      severity: "error",
      caseId,
      message: "case was not started because an artifact failure stopped scheduling",
    });
    return;
  }

  emitLifecycle(run, caseId, "preparing");
  const workspace = await run.dependencies.git.createIsolatedCase(entry.identity);
  if (!workspace.ok) {
    await persistAndCleanup(run, preparationFailureResult(run, entry, workspace.error), null);
    return;
  }
  const environments = await run.dependencies.environments.createCaseEnvironments(
    workspace.value,
    run.snapshot,
    run.plan.config,
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

  emitLifecycle(run, caseId, "running");
  const outcome = await run.dependencies.opencode.run({
    identity: active.identity,
    executable: run.plan.config.agents.opencode.command,
    prompt: run.dependencies.buildTaskPrompt(active.task),
    worktreeDirectory: active.workspace.worktreeDirectory,
    environment: active.environments.opencode,
    timeoutMs: run.plan.caseTimeoutMs,
    terminationGraceMs: run.plan.terminationGraceMs,
    cancellation: active.abort.signal,
    onEvent: async (event) => {
      active.events.push(event);
      const appended = await run.dependencies.artifacts.appendEvent(caseId, event);
      if (!appended.ok && appended.error.kind === "ArtifactError") {
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

/** Records a mid-case artifact-store failure, terminates the case, and stops scheduling. */
function recordArtifactFailure(run: RunContext, active: ActiveCase, error: TevuError): void {
  active.artifactFailure ??= error;
  run.state.stopScheduling = true;
  active.abort.abort();
}

/** Maps one finished OpenCode run to the case's terminal result. */
async function concludeCase(
  run: RunContext,
  active: ActiveCase,
  outcome: OpenCodeRunOutcome,
): Promise<CaseResult> {
  if (active.artifactFailure !== null) {
    active.exportUnavailableReason =
      "an artifact failure ended the case before the root session could be exported";
    return finishCase(run, active, "infrastructure-failed", active.artifactFailure);
  }
  if (outcome.ok) {
    return evaluateReadableCase(run, active, null);
  }
  const error = outcome.error;
  switch (error.kind) {
    case "CancellationError":
      active.exportUnavailableReason =
        "the case was cancelled before the root session could be exported";
      return finishCase(run, active, "cancelled", error);
    case "CaseTimeoutError": {
      active.exportUnavailableReason =
        "the case timed out before the root session could be exported";
      const patch = await capturePatch(run, active);
      if (patch.storeFailure && patch.failure !== null) {
        return finishCase(run, active, "infrastructure-failed", patch.failure);
      }
      if (patch.failure !== null) {
        run.findings.push({
          severity: "warning",
          caseId: active.identity.caseId,
          message: `solution patch could not be captured after timeout: ${describeError(patch.failure)}`,
        });
      }
      return finishCase(run, active, "timed-out", error);
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
      return finishCase(run, active, "process-failed", error);
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
  emitLifecycle(run, caseId, "evaluating");

  const sessionId = active.evidence?.sessionId ?? null;
  if (sessionId === null) {
    active.exportUnavailableReason =
      preservedFailure === null
        ? "root session could not be identified"
        : `root session could not be identified after the failure: ${describeError(preservedFailure)}`;
  } else {
    const exported = await run.dependencies.opencode.exportSession(
      sessionId,
      active.environments.opencode,
    );
    if (exported.ok) {
      const written = await run.dependencies.artifacts.writeSessionExport(caseId, exported.value);
      if (!written.ok) {
        run.state.stopScheduling = true;
        active.exportUnavailableReason = `session export could not be persisted: ${written.error.reason}`;
        return finishCase(run, active, "infrastructure-failed", written.error);
      }
      active.sessionExport = exported.value;
    } else {
      active.exportUnavailableReason = `root session export failed: ${describeError(exported.error)}`;
      preservedFailure ??= exported.error;
    }
  }
  if (run.state.cancelled) {
    return finishCase(run, active, "cancelled", preservedFailure);
  }

  const patch = await capturePatch(run, active);
  if (patch.failure !== null) {
    return finishCase(run, active, "infrastructure-failed", patch.failure);
  }
  if (run.state.cancelled) {
    return finishCase(run, active, "cancelled", preservedFailure);
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
    return finishCase(run, active, "infrastructure-failed", written.error);
  }
  active.checksWritten = true;
  if (run.state.cancelled) {
    return finishCase(run, active, "cancelled", preservedFailure);
  }

  return finishCase(run, active, "completed", preservedFailure, ordered);
}

/** Patch capture and persistence; a store failure stops scheduling new cases. */
async function capturePatch(
  run: RunContext,
  active: ActiveCase,
): Promise<{ failure: TevuError | null; storeFailure: boolean }> {
  const captured = await run.dependencies.git.capturePatch(active.workspace);
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
  error: Extract<TevuError, { kind: "EvaluationError" }>,
): CheckResult {
  const match = ordered.find((check) => check.definition.id === error.checkId);
  return {
    checkId: error.checkId,
    category: match?.category ?? "acceptance",
    verdict: "failed",
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
    "completed" | "process-failed" | "timed-out" | "cancelled" | "infrastructure-failed"
  >,
  failure: TevuError | null,
  ordered?: OrderedChecks,
): CaseResult {
  const caseId = active.identity.caseId;
  const { metrics, protocolFailure } = computeCaseMetrics(active);
  const preserved = failure ?? protocolFailure;
  const paths = run.dependencies.artifacts.caseArtifactPaths(caseId);
  return {
    schemaVersion: 1,
    identity: active.identity,
    lifecycle,
    process: active.evidence?.process ?? null,
    outcome:
      lifecycle === "completed"
        ? reduceRequiredOutcome(
            (ordered ?? orderTaskChecks(active.task)).map((check) => ({
              id: check.definition.id,
              required: check.definition.required,
            })),
            active.checks,
          )
        : "not-evaluated",
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
    context: {
      sourceRepositoryPath: active.workspace.sourceRepositoryPath,
      syntheticCommit: active.workspace.syntheticCommit,
      environment: [
        ...active.environments.opencode.variableManifest,
        ...active.environments.evaluator.variableManifest,
      ],
    },
  };
}

/** Normalizes metrics from preserved records; a decoding failure stays truthful and preserved. */
function computeCaseMetrics(active: ActiveCase): {
  metrics: BenchmarkMetrics;
  protocolFailure: Extract<TevuError, { kind: "OpenCodeProtocolError" }> | null;
} {
  const durationMs = active.evidence?.process.durationMs ?? null;
  const normalized = normalizeMetrics({
    caseId: active.identity.caseId,
    rootSessionId: active.evidence?.sessionId ?? null,
    sessionExport: active.sessionExport,
    events: active.events,
    elapsedMs: durationMs,
    elapsedUnavailableReason: "the OpenCode process produced no timing evidence",
    exportUnavailableReason: active.exportUnavailableReason,
  });
  if (normalized.ok) {
    return { metrics: normalized.value, protocolFailure: null };
  }
  const metrics = unavailableBenchmarkMetrics(normalized.error.reason);
  if (durationMs !== null) {
    metrics.elapsed = {
      value: durationMs,
      unit: "millisecond",
      availability: { status: "available", source: "process" },
      scope: "case",
    };
  }
  return { metrics, protocolFailure: normalized.error };
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
    lifecycle: "infrastructure-failed",
    process: null,
    outcome: "not-evaluated",
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
      severity: "error",
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
      severity: "warning",
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
    case "OpenCodeProcessError":
      return `OpenCode process ended with exit code ${String(error.exitCode)} and signal ${String(error.signal)}`;
    case "OpenCodeProtocolError":
      return `OpenCode protocol failure: ${error.reason}`;
    case "CaseTimeoutError":
      return `case timed out after ${error.timeoutMs}ms`;
    case "CancellationError":
      return "the run was cancelled";
    case "ArtifactError":
      return `artifact operation "${error.operation}" failed: ${error.reason}`;
    case "SourceMaterializationError":
      return `source materialization failed: ${error.reason}`;
    case "IsolationError":
      return `case isolation failed: ${error.reason}`;
    case "EvaluationError":
      return `check "${error.checkId}" evaluation failed: ${error.reason}`;
    default:
      return error.kind;
  }
}
