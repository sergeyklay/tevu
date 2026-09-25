/**
 * Manual assessment and report regeneration use cases. `assessCase` validates
 * every pending manual check of one completed case against the configuration
 * preserved in the run manifest, commits exactly one assessment revision under
 * the exclusive case lock, and regenerates the derived results before the lock
 * is released. `rebuildReport` rebuilds the derived case results, the run
 * aggregate, and the report solely from versioned source artifacts, resolving
 * each case's adapter from the injected `AgentRegistry` by its saved agent
 * name. No Git, Jira, model, clock, or filesystem implementation enters this
 * module; every effect flows through the injected `ArtifactStore`.
 */

import { decodeRunConfig } from "../config/run-snapshot.ts";
import { reduceRequiredOutcome } from "../evaluation/checks.ts";
import { combineCaseMetrics } from "../evaluation/metrics.ts";
import { buildReport } from "../evaluation/report.ts";
import { reduceRunExitCode } from "./run-benchmark.ts";

import type {
  AgentEventRecord,
  AgentRegistry,
  AgentSessionExport,
  ArtifactStore,
  AssessmentArtifact,
  AssessmentInput,
  AssessmentLock,
  AssessmentRecord,
  CaseResult,
  CheckRecord,
  CheckResult,
  ReportResult,
  RunResult,
  TaskRecord,
  TevuError,
  TevuResult,
  ValidationFinding,
} from "../domain/types.ts";

/** One manual check of the assessed case, in configuration order. */
export type ManualCheckSummary = {
  checkId: string;
  category: "acceptance" | "definition-of-done";
  description: string;
  required: boolean;
};

/** Pre-read display context for one case's manual assessment. */
export type AssessmentCaseContext = {
  /** Every manual check of the case's task, in configuration order. */
  manualChecks: ManualCheckSummary[];
  /** Current assessment records; replaced ones live in artifact history, not here. */
  existing: AssessmentRecord[];
};

/** Error kinds the manual assessment contract declares. */
type AssessCaseErrorKind =
  | "ConfigValidationError"
  | "AssessmentConflictError"
  | "ArtifactError"
  | "CancellationError";

/** Error kinds the report regeneration contract declares. */
type RebuildReportErrorKind = "AgentProtocolError" | "ArtifactError";

/** Derived records produced by one regeneration pass over a finalized run. */
type RebuiltRun = {
  run: RunResult;
  report: ReportResult;
};

const EXPORT_ABSENT_REASON = "the preserved case artifacts contain no session export";
const ELAPSED_ABSENT_REASON = "the preserved case result contains no process timing evidence";

/**
 * Records manual verdicts for one case's pending manual checks and rebuilds
 * the derived case result, run aggregate, and report. Acquires the exclusive
 * case assessment lock before reading `assessment.json`, validates every
 * decision, commits exactly one new revision (replacement moves prior current
 * records to history and requires explicit confirmation via
 * `replaceExisting`), and regenerates derived records before releasing the
 * lock. The assessment replacement is the commit point: a derived write
 * failure after it retains the committed revision and names
 * `tevu report <run-id>` as the recovery command.
 */
export async function assessCase(
  input: AssessmentInput,
  store: ArtifactStore,
  agents: AgentRegistry,
): Promise<TevuResult<CaseResult, AssessCaseErrorKind>> {
  if (isAborted(input.cancellation)) {
    return cancellationFailure();
  }
  const manifest = await store.readRunManifest(input.runId);
  if (!manifest.ok) {
    return manifest;
  }
  const context = manifest.value.context;
  if (context === undefined) {
    return artifactFailure(
      "assess-case",
      `run "${input.runId}" manifest does not preserve the configuration context required for assessment`,
    );
  }
  const identity = manifest.value.cases.find((entry) => entry.caseId === input.caseId);
  if (identity === undefined) {
    return configValidationFailure([
      {
        severity: "error",
        identifier: input.caseId,
        message: `case "${input.caseId}" is not part of run "${input.runId}"`,
      },
    ]);
  }
  const decoded = decodeRunConfig(context.config);
  if (!decoded.ok) {
    return decoded;
  }
  const task = decoded.value.tasks.find((entry) => entry.id === identity.taskId);
  if (task === undefined) {
    return artifactFailure(
      "assess-case",
      `preserved configuration for run "${input.runId}" does not define task "${identity.taskId}"`,
    );
  }
  const manualChecks = task.checks.filter((check) => check.evaluator === "manual");
  if (manualChecks.length === 0) {
    return configValidationFailure([
      {
        severity: "error",
        identifier: input.caseId,
        message: `case "${input.caseId}" has no manual checks; there is nothing to assess`,
      },
    ]);
  }
  const storedCase = await store.readCaseResult(input.runId, input.caseId);
  if (!storedCase.ok) {
    return storedCase;
  }
  if (storedCase.value.lifecycle !== "completed") {
    return configValidationFailure([
      {
        severity: "error",
        identifier: input.caseId,
        message: `case "${input.caseId}" ended "${storedCase.value.lifecycle}"; manual assessment requires a completed case`,
      },
    ]);
  }

  const lock = await store.acquireAssessmentLock(input.runId, input.caseId);
  if (!lock.ok) {
    return lock;
  }

  const existing = await store.readAssessment(input.runId, input.caseId);
  if (!existing.ok) {
    return releaseAndReturn(lock.value, existing);
  }
  const currentByCheck = new Map(
    (existing.value?.current ?? []).map((record) => [record.checkId, record]),
  );
  const findings = validateAssessmentInput(input, manualChecks, currentByCheck);
  if (findings.length > 0) {
    return releaseAndReturn(lock.value, configValidationFailure(findings));
  }
  if (isAborted(input.cancellation)) {
    return releaseAndReturn(lock.value, cancellationFailure());
  }

  const next = buildNextAssessment(input, manualChecks, existing.value);
  const committed = await store.replaceAssessment(next);
  if (!committed.ok) {
    return releaseAndReturn(lock.value, committed);
  }

  // Commit point passed: the revision must survive every later failure.
  const rebuilt = await rebuildRunDerived(input.runId, store, agents);
  if (!rebuilt.ok) {
    await lock.value.release();
    return artifactFailure(
      "assess-case",
      `assessment revision ${next.revision} for case "${input.caseId}" is committed, but derived regeneration failed (${describeRebuildError(rebuilt.error)}); run \`tevu report ${input.runId}\` to regenerate the derived results and report`,
    );
  }
  const released = await lock.value.release();
  if (!released.ok) {
    return released;
  }
  const derived = rebuilt.value.run.cases.find((entry) => entry.identity.caseId === input.caseId);
  if (derived === undefined) {
    return artifactFailure(
      "assess-case",
      `assessment revision ${next.revision} for case "${input.caseId}" is committed, but the regenerated run record does not contain the case; run \`tevu report ${input.runId}\` to regenerate the derived results and report`,
    );
  }
  return { ok: true, value: derived };
}

/**
 * Reads the assessment wizard's display context from preserved run artifacts
 * only: the manifest's decoded configuration supplies the manual checks in
 * configuration order, and the current assessment records come from the
 * versioned assessment artifact.
 */
export async function readAssessmentContext(
  runId: string,
  caseId: string,
  store: ArtifactStore,
): Promise<TevuResult<AssessmentCaseContext, "ConfigValidationError" | "ArtifactError">> {
  const manifest = await store.readRunManifest(runId);
  if (!manifest.ok) {
    return manifest;
  }
  const context = manifest.value.context;
  if (context === undefined) {
    return artifactFailure(
      "read-run-manifest",
      `run "${runId}" preserves no configuration context; it cannot be assessed`,
    );
  }
  const decoded = decodeRunConfig(context.config);
  if (!decoded.ok) {
    return decoded;
  }
  const identity = manifest.value.cases.find((candidate) => candidate.caseId === caseId);
  if (identity === undefined) {
    return configValidationFailure([
      { severity: "error", identifier: caseId, message: `case "${caseId}" is not part of run "${runId}"` },
    ]);
  }
  const task = decoded.value.tasks.find((candidate) => candidate.id === identity.taskId);
  if (task === undefined) {
    return artifactFailure(
      "read-run-manifest",
      `task "${identity.taskId}" is missing from the preserved run configuration`,
    );
  }
  const manualChecks: ManualCheckSummary[] = task.checks
    .filter((check) => check.evaluator === "manual")
    .map((check) => ({
      checkId: check.id,
      category: check.category,
      description: check.description,
      required: check.required,
    }));
  const assessment = await store.readAssessment(runId, caseId);
  if (!assessment.ok) {
    return assessment;
  }
  return { ok: true, value: { manualChecks, existing: assessment.value?.current ?? [] } };
}

/**
 * Rebuilds the normalized run record and Markdown report of a finalized run
 * solely from versioned artifacts: preserved events, session exports, checks,
 * current assessments, per-case process and failure records, and the manifest
 * configuration context. Metrics are recomputed through `normalizeMetrics`,
 * outcomes and the run exit code through the shared reducers. Source
 * artifacts are never mutated; only the derived case results, run aggregate,
 * and report are replaced.
 */
export async function rebuildReport(
  runId: string,
  store: ArtifactStore,
  agents: AgentRegistry,
): Promise<TevuResult<ReportResult, RebuildReportErrorKind>> {
  const rebuilt = await rebuildRunDerived(runId, store, agents);
  if (!rebuilt.ok) {
    return rebuilt;
  }
  return { ok: true, value: rebuilt.value.report };
}

/** Regenerates and persists every derived record of one finalized run. */
async function rebuildRunDerived(
  runId: string,
  store: ArtifactStore,
  agents: AgentRegistry,
): Promise<TevuResult<RebuiltRun, RebuildReportErrorKind>> {
  const stored = await store.readRunResult(runId);
  if (!stored.ok) {
    return stored;
  }
  const manifest = stored.value.manifest;
  const context = manifest.context;
  if (context === undefined) {
    return artifactFailure(
      "rebuild-report",
      `run "${runId}" manifest does not preserve the configuration context required for regeneration`,
    );
  }
  const decoded = decodeRunConfig(context.config);
  if (!decoded.ok) {
    return decoded;
  }
  const tasksById = new Map(decoded.value.tasks.map((task) => [task.id, task]));

  const cases: CaseResult[] = [];
  const assessments: AssessmentArtifact[] = [];
  for (const cached of stored.value.cases) {
    const rebuilt = await rebuildCaseResult(runId, cached.identity.caseId, tasksById, store, agents);
    if (!rebuilt.ok) {
      return rebuilt;
    }
    const replaced = await store.replaceCaseResult(runId, rebuilt.value.result);
    if (!replaced.ok) {
      return replaced;
    }
    cases.push(rebuilt.value.result);
    if (rebuilt.value.assessment !== null) {
      assessments.push(rebuilt.value.assessment);
    }
  }

  const findings = stored.value.findings;
  const run: RunResult = {
    schemaVersion: 1,
    manifest,
    cases,
    findings,
    exitCode: reduceRunExitCode(cases, findings, false),
  };
  const finalized = await store.finalizeRun(run);
  if (!finalized.ok) {
    return finalized;
  }
  const report = buildReport({
    run,
    capabilities: context.capabilities,
    tasks: decoded.value.tasks,
    models: decoded.value.models,
    repositories: decoded.value.repositories,
    assessments,
  });
  const written = await store.writeReport(runId, report);
  if (!written.ok) {
    return written;
  }
  return { ok: true, value: { run, report } };
}

/** Rebuilds one derived case result from its preserved source artifacts. */
async function rebuildCaseResult(
  runId: string,
  caseId: string,
  tasksById: ReadonlyMap<string, TaskRecord>,
  store: ArtifactStore,
  agents: AgentRegistry,
): Promise<
  TevuResult<{ result: CaseResult; assessment: AssessmentArtifact | null }, RebuildReportErrorKind>
> {
  const cached = await store.readCaseResult(runId, caseId);
  if (!cached.ok) {
    return cached;
  }
  const source = cached.value;
  const agentName = source.identity.agent;
  const adapter = agentName === undefined ? undefined : agents.get(agentName);
  if (adapter === undefined) {
    return artifactFailure(
      "rebuild-report",
      `case "${caseId}" names agent "${String(agentName)}", which has no registered adapter`,
    );
  }

  let events: AgentEventRecord[] = [];
  if (source.artifacts.events !== null) {
    const read = await store.readEvents(runId, caseId);
    if (!read.ok) {
      return read;
    }
    events = read.value;
  }
  let sessionExport: AgentSessionExport | null = null;
  if (source.artifacts.sessionExport !== null) {
    const read = await store.readSessionExport(runId, caseId);
    if (!read.ok) {
      return read;
    }
    sessionExport = read.value;
  }
  let checks: CheckResult[] = [];
  if (source.artifacts.checks !== null) {
    const read = await store.readChecks(runId, caseId);
    if (!read.ok) {
      return read;
    }
    checks = read.value;
  }
  const assessment = await store.readAssessment(runId, caseId);
  if (!assessment.ok) {
    return assessment;
  }

  const task = tasksById.get(source.identity.taskId);
  if (task === undefined) {
    return artifactFailure(
      "rebuild-report",
      `preserved configuration does not define task "${source.identity.taskId}" for case "${caseId}"`,
    );
  }
  const normalized = adapter.normalizeMetrics({
    caseId,
    sessionId: null,
    events,
    sessionExport,
    exportUnavailableReason: EXPORT_ABSENT_REASON,
  });
  if (!normalized.ok) {
    return normalized;
  }
  const derivedChecks = applyCurrentAssessments(checks, assessment.value);
  const paths = store.caseArtifactPaths(caseId);
  const result: CaseResult = {
    ...source,
    outcome:
      source.lifecycle === "completed"
        ? reduceRequiredOutcome(task.checks, derivedChecks)
        : "not-evaluated",
    checks: derivedChecks,
    metrics: combineCaseMetrics({
      durationMs: source.process?.durationMs ?? null,
      elapsedUnavailableReason: ELAPSED_ABSENT_REASON,
      normalized,
    }).metrics,
    artifacts: {
      ...source.artifacts,
      assessment: assessment.value !== null ? paths.assessment : null,
    },
  };
  return { ok: true, value: { result, assessment: assessment.value } };
}

/**
 * Applies current assessment verdicts onto the preserved check results. Only
 * `current` records contribute verdicts; history is retained as evidence
 * without affecting the outcome. Source checks stay unchanged on disk.
 */
function applyCurrentAssessments(
  checks: readonly CheckResult[],
  assessment: AssessmentArtifact | null,
): CheckResult[] {
  if (assessment === null) {
    return [...checks];
  }
  const currentByCheck = new Map(assessment.current.map((record) => [record.checkId, record]));
  return checks.map((check) => {
    const record = currentByCheck.get(check.checkId);
    if (record === undefined) {
      return check;
    }
    return {
      ...check,
      verdict: record.verdict,
      evidence: `manually assessed by ${record.assessor} at ${record.assessedAt}${record.note.length > 0 ? `: ${record.note}` : ""}`,
    };
  });
}

/** Aggregates every defect of one assessment invocation into findings. */
function validateAssessmentInput(
  input: AssessmentInput,
  manualChecks: readonly CheckRecord[],
  currentByCheck: ReadonlyMap<string, AssessmentRecord>,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  if (input.assessedAt.trim().length === 0 || Number.isNaN(Date.parse(input.assessedAt))) {
    findings.push({
      severity: "error",
      identifier: "assessedAt",
      message: "assessedAt must be a parseable timestamp supplied by the caller",
    });
  }
  const manualCheckIds = new Set(manualChecks.map((check) => check.id));
  const decided = new Set<string>();
  for (const decision of input.decisions) {
    if (decided.has(decision.checkId)) {
      findings.push({
        severity: "error",
        identifier: decision.checkId,
        message: `check "${decision.checkId}" has more than one decision`,
      });
      continue;
    }
    decided.add(decision.checkId);
    if (!manualCheckIds.has(decision.checkId)) {
      findings.push({
        severity: "error",
        identifier: decision.checkId,
        message: `check "${decision.checkId}" is not a manual check of this case`,
      });
      continue;
    }
    if (decision.assessor.trim().length === 0) {
      findings.push({
        severity: "error",
        identifier: decision.checkId,
        message: "assessor must not be empty",
      });
    }
    if (decision.verdict === "failed" && decision.note.trim().length === 0) {
      findings.push({
        severity: "error",
        identifier: decision.checkId,
        message: "a failed verdict requires a non-empty note",
      });
    }
    const prior = currentByCheck.get(decision.checkId);
    if (prior !== undefined && !decision.replaceExisting) {
      findings.push({
        severity: "error",
        identifier: decision.checkId,
        message: `check "${decision.checkId}" is already assessed; replacement must be selected and confirmed`,
      });
    }
    if (prior === undefined && decision.replaceExisting) {
      findings.push({
        severity: "error",
        identifier: decision.checkId,
        message: `check "${decision.checkId}" has no existing assessment to replace`,
      });
    }
  }
  for (const check of manualChecks) {
    const checkId = check.id;
    if (!currentByCheck.has(checkId) && !decided.has(checkId)) {
      findings.push({
        severity: "error",
        identifier: checkId,
        message: `pending manual check "${checkId}" has no decision; every pending manual check must be assessed`,
      });
    }
  }
  if (input.decisions.length === 0 && findings.length === 0) {
    findings.push({
      severity: "error",
      identifier: input.caseId,
      message: "every manual check is already assessed and no replacement was selected",
    });
  }
  return findings;
}

/**
 * Builds the next assessment revision in configuration order: new decisions
 * install fresh records, replaced prior records move to history stamped with
 * `replacedAt`, and unreplaced existing records are retained unchanged.
 */
function buildNextAssessment(
  input: AssessmentInput,
  manualChecks: readonly CheckRecord[],
  existing: AssessmentArtifact | null,
): AssessmentArtifact {
  const decisionsByCheck = new Map(input.decisions.map((decision) => [decision.checkId, decision]));
  const currentByCheck = new Map(
    (existing?.current ?? []).map((record) => [record.checkId, record]),
  );
  const current: AssessmentRecord[] = [];
  const history = [...(existing?.history ?? [])];
  for (const check of manualChecks) {
    const checkId = check.id;
    const decision = decisionsByCheck.get(checkId);
    const prior = currentByCheck.get(checkId);
    if (decision === undefined) {
      if (prior !== undefined) {
        current.push(prior);
      }
      continue;
    }
    if (prior !== undefined) {
      history.push({ ...prior, replacedAt: input.assessedAt });
    }
    current.push({
      checkId,
      verdict: decision.verdict,
      assessor: decision.assessor,
      note: decision.note,
      assessedAt: input.assessedAt,
    });
  }
  return {
    schemaVersion: 1,
    runId: input.runId,
    caseId: input.caseId,
    revision: (existing?.revision ?? 0) + 1,
    current,
    history,
  };
}

/** Re-reads the signal at call time; the state can flip across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** Releases the lock best-effort and returns the primary failure unchanged. */
async function releaseAndReturn<T extends { ok: false }>(
  lock: AssessmentLock,
  failure: T,
): Promise<T> {
  await lock.release();
  return failure;
}

/** Identifier-only description of a regeneration failure; never secret values. */
function describeRebuildError(error: Extract<TevuError, { kind: RebuildReportErrorKind }>): string {
  return error.kind === "ArtifactError"
    ? `artifact operation "${error.operation}" failed: ${error.reason}`
    : `agent "${error.agent}" protocol failure: ${error.reason}`;
}

function artifactFailure(
  operation: string,
  reason: string,
): { ok: false; error: Extract<TevuError, { kind: "ArtifactError" }> } {
  return { ok: false, error: { kind: "ArtifactError", operation, reason } };
}

function configValidationFailure(findings: ValidationFinding[]): {
  ok: false;
  error: Extract<TevuError, { kind: "ConfigValidationError" }>;
} {
  return { ok: false, error: { kind: "ConfigValidationError", findings } };
}

function cancellationFailure(): {
  ok: false;
  error: Extract<TevuError, { kind: "CancellationError" }>;
} {
  return { ok: false, error: { kind: "CancellationError", activeCaseIds: [] } };
}
