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

import { decodeRunConfig } from '@/config/run-snapshot';
import { reduceRequiredOutcome } from '@/evaluation/checks';
import { applyGrades } from '@/evaluation/grading';
import { combineCaseMetrics } from '@/evaluation/metrics';
import { buildReport, buildSummaryEvidence } from '@/evaluation/report';
import { templateConclusions } from '@/evaluation/summary';
import { buildReaderNames, gradeLines } from '@/evaluation/wording';

import { reduceRunExitCode } from './run-benchmark';

import type { ConclusionWriter } from './write-conclusions';
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
  ConclusionsArtifact,
  CopiedProvider,
  GradeRecord,
  GraderIdentity,
  GradingArtifact,
  ReplacedGraderVerdict,
  ReplacedOperatorVerdict,
  ReportResult,
  RunConfigRecord,
  RunManifest,
  RunResult,
  TaskConclusions,
  TaskRecord,
  TevuError,
  TevuResult,
  ValidationFinding,
} from '@/domain/types';
import type { SummaryEvidence } from '@/evaluation/summary';
import type { ReaderNames } from '@/evaluation/wording';

/** One assessable check of the assessed case, in configuration order: manual, or graded with its saved grade. */
export type AssessableCheckSummary = {
  checkId: string;
  /** The plain check name shown to the operator in place of the check ID. */
  name: string;
  category: 'acceptance' | 'definition-of-done';
  required: boolean;
} & (
  | { evaluator: 'manual' }
  | {
      evaluator: 'grader';
      grade: GradeRecord | null;
      grader: GraderIdentity | null;
      /** Lines the wizard logs before asking, in the report's wording. */
      gradeLines: string[];
    }
);

/** Pre-read display context for one case's assessment. */
export type AssessmentCaseContext = {
  /** The plain name of the attempt on its task, as the report names it. */
  caseName: string;
  /** Every manual or graded check of the case's task, in configuration order. */
  checks: AssessableCheckSummary[];
  /** Current assessment records; replaced ones live in artifact history, not here. */
  existing: AssessmentRecord[];
};

/** Holds when a preserved check is assessable: manual, or graded. */
function isAssessableCheck(
  check: CheckRecord,
): check is CheckRecord & { evaluator: 'manual' | 'grader' } {
  return check.evaluator === 'manual' || check.evaluator === 'grader';
}

/** Names the tasks, model settings, attempts, and checks of one run in configuration order. */
function readerNamesOf(config: RunConfigRecord, manifest: RunManifest): ReaderNames {
  return buildReaderNames({
    tasks: config.tasks,
    models: config.models,
    repeat: manifest.execution.repeat.value,
    cases: manifest.cases,
  });
}

/** Projects assessable check definitions and a case's saved grading into display/decision summaries. */
function buildAssessableChecks(
  definitions: readonly (CheckRecord & { evaluator: 'manual' | 'grader' })[],
  names: ReaderNames,
  taskId: string,
  grading: GradingArtifact | null,
): AssessableCheckSummary[] {
  const gradeByCheckId = new Map((grading?.grades ?? []).map((grade) => [grade.checkId, grade]));
  return definitions.map((check) => {
    const name = names.check(taskId, check.id);
    if (check.evaluator === 'manual') {
      return {
        checkId: check.id,
        name,
        category: check.category,
        required: check.required,
        evaluator: 'manual',
      };
    }
    const grade = gradeByCheckId.get(check.id) ?? null;
    return {
      checkId: check.id,
      name,
      category: check.category,
      required: check.required,
      evaluator: 'grader',
      grade,
      grader: grading?.grader ?? null,
      gradeLines: gradeLines(grade, grading),
    };
  });
}

/**
 * A check's existing verdict: its current operator record, or, without one, a
 * `passed`/`failed` grade. A check with neither is pending.
 */
function existingVerdictOf(
  check: AssessableCheckSummary,
  currentByCheck: ReadonlyMap<string, AssessmentRecord>,
): { verdict: 'passed' | 'failed'; source: 'operator' | 'grader' } | undefined {
  const operatorRecord = currentByCheck.get(check.checkId);
  if (operatorRecord !== undefined) {
    return { verdict: operatorRecord.verdict, source: 'operator' };
  }
  if (
    check.evaluator === 'grader' &&
    check.grade !== null &&
    check.grade.status === 'graded' &&
    check.grade.verdict !== 'undetermined'
  ) {
    return { verdict: check.grade.verdict, source: 'grader' };
  }
  return undefined;
}

/** Error kinds the manual assessment contract declares. */
type AssessCaseErrorKind =
  'ConfigValidationError' | 'AssessmentConflictError' | 'ArtifactError' | 'CancellationError';

/** Error kinds the report regeneration contract declares. */
type RebuildReportErrorKind = 'AgentProtocolError' | 'ArtifactError';

/** What one recorded assessment returns. */
export type AssessedCase = {
  result: CaseResult;
  /** The assessed case's `ReportSummary.attempts[].lines` from the rebuilt report. */
  summary: string[];
};

/**
 * What a regeneration pass does with the summary: `write` saves the
 * conclusions of every task in `conclusions.json` and writes `summary.md`
 * (`tevu run`), `render` renders both from the saved conclusions (`tevu
 * report`), and `keep` renders only `report.md` and leaves `conclusions.json`
 * and `summary.md` as they are (`tevu assess`).
 */
type ConclusionsMode = { kind: 'write'; writer: ConclusionWriter } | { kind: 'render' | 'keep' };

/** Derived records produced by one regeneration pass over a finalized run. */
type RebuiltRun = {
  run: RunResult;
  report: ReportResult;
  retainedDirectories: string[];
};

/** What `rebuildReport` returns: the report and the summary-call directories tevu could not delete. */
export type RebuiltReport = { report: ReportResult; retainedDirectories: string[] };

const EXPORT_ABSENT_REASON = 'the preserved case artifacts contain no session export';
const ELAPSED_ABSENT_REASON = 'the preserved case result contains no process timing evidence';

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
): Promise<TevuResult<AssessedCase, AssessCaseErrorKind>> {
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
      'assess-case',
      `run "${input.runId}" manifest does not preserve the configuration context required for assessment`,
    );
  }
  const identity = manifest.value.cases.find((entry) => entry.caseId === input.caseId);
  if (identity === undefined) {
    return configValidationFailure([
      {
        severity: 'error',
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
      'assess-case',
      `preserved configuration for run "${input.runId}" does not define task "${identity.taskId}"`,
    );
  }
  const assessableDefinitions = task.checks.filter(isAssessableCheck);
  if (assessableDefinitions.length === 0) {
    return configValidationFailure([
      {
        severity: 'error',
        identifier: input.caseId,
        message: `case "${input.caseId}" has no manual or graded checks; there is nothing to assess`,
      },
    ]);
  }
  const storedCase = await store.readCaseResult(input.runId, input.caseId);
  if (!storedCase.ok) {
    return storedCase;
  }
  if (storedCase.value.lifecycle !== 'completed') {
    return configValidationFailure([
      {
        severity: 'error',
        identifier: input.caseId,
        message: `case "${input.caseId}" ended "${storedCase.value.lifecycle}"; manual assessment requires a completed case`,
      },
    ]);
  }
  let grading: GradingArtifact | null = null;
  if (storedCase.value.artifacts.grading !== null) {
    const read = await store.readGrading(input.runId, input.caseId);
    if (!read.ok) {
      return read;
    }
    grading = read.value;
  }
  const checks = buildAssessableChecks(
    assessableDefinitions,
    readerNamesOf(decoded.value, manifest.value),
    task.id,
    grading,
  );

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
  const findings = validateAssessmentInput(input, checks, currentByCheck);
  if (findings.length > 0) {
    return releaseAndReturn(lock.value, configValidationFailure(findings));
  }
  if (isAborted(input.cancellation)) {
    return releaseAndReturn(lock.value, cancellationFailure());
  }

  const next = buildNextAssessment(input, checks, currentByCheck, existing.value);
  const committed = await store.replaceAssessment(next);
  if (!committed.ok) {
    return releaseAndReturn(lock.value, committed);
  }

  // Commit point passed: the revision must survive every later failure.
  const rebuilt = await rebuildRunDerived(input.runId, store, agents, { kind: 'keep' });
  if (!rebuilt.ok) {
    await lock.value.release();
    return artifactFailure(
      'assess-case',
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
      'assess-case',
      `assessment revision ${next.revision} for case "${input.caseId}" is committed, but the regenerated run record does not contain the case; run \`tevu report ${input.runId}\` to regenerate the derived results and report`,
    );
  }
  const summary = rebuilt.value.report.summary.attempts.find(
    (entry) => entry.caseId === input.caseId,
  );
  if (summary === undefined) {
    return artifactFailure(
      'assess-case',
      `assessment revision ${next.revision} for case "${input.caseId}" is committed, but the regenerated report does not contain the case; run \`tevu report ${input.runId}\` to regenerate the derived results and report`,
    );
  }
  return { ok: true, value: { result: derived, summary: summary.lines } };
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
): Promise<TevuResult<AssessmentCaseContext, 'ConfigValidationError' | 'ArtifactError'>> {
  const manifest = await store.readRunManifest(runId);
  if (!manifest.ok) {
    return manifest;
  }
  const context = manifest.value.context;
  if (context === undefined) {
    return artifactFailure(
      'read-run-manifest',
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
      {
        severity: 'error',
        identifier: caseId,
        message: `case "${caseId}" is not part of run "${runId}"`,
      },
    ]);
  }
  const task = decoded.value.tasks.find((candidate) => candidate.id === identity.taskId);
  if (task === undefined) {
    return artifactFailure(
      'read-run-manifest',
      `task "${identity.taskId}" is missing from the preserved run configuration`,
    );
  }
  const assessableDefinitions = task.checks.filter(isAssessableCheck);
  const caseResult = await store.readCaseResult(runId, caseId);
  if (!caseResult.ok) {
    return caseResult;
  }
  let grading: GradingArtifact | null = null;
  if (caseResult.value.artifacts.grading !== null) {
    const read = await store.readGrading(runId, caseId);
    if (!read.ok) {
      return read;
    }
    grading = read.value;
  }
  const names = readerNamesOf(decoded.value, manifest.value);
  const checks = buildAssessableChecks(assessableDefinitions, names, task.id, grading);
  const assessment = await store.readAssessment(runId, caseId);
  if (!assessment.ok) {
    return assessment;
  }
  return {
    ok: true,
    value: {
      caseName: names.caseName(identity),
      checks,
      existing: assessment.value?.current ?? [],
    },
  };
}

/**
 * Rebuilds the normalized run record and Markdown report of a finalized run
 * solely from versioned artifacts: preserved events, session exports, checks,
 * current assessments, per-case process and failure records, and the manifest
 * configuration context. Metrics are recomputed through `normalizeMetrics`,
 * outcomes and the run exit code through the shared reducers. Source
 * artifacts are never mutated; only the derived case results, run aggregate,
 * and report are replaced.
 *
 * With a `writer`, which is `tevu run`, the rebuild first writes the
 * conclusions of every task, one at a time in task ID order, and saves them in
 * `conclusions.json` before it renders. A cancellation during the writes saves
 * template sentences for the tasks not yet written and makes no further call.
 * Without one, which is `tevu report`, it renders `summary.md` from the saved
 * conclusions.
 */
export async function rebuildReport(
  runId: string,
  store: ArtifactStore,
  agents: AgentRegistry,
  writer?: ConclusionWriter,
): Promise<TevuResult<RebuiltReport, RebuildReportErrorKind>> {
  const rebuilt = await rebuildRunDerived(
    runId,
    store,
    agents,
    writer === undefined ? { kind: 'render' } : { kind: 'write', writer },
  );
  if (!rebuilt.ok) {
    return rebuilt;
  }
  return {
    ok: true,
    value: { report: rebuilt.value.report, retainedDirectories: rebuilt.value.retainedDirectories },
  };
}

/** Regenerates and persists every derived record of one finalized run. */
async function rebuildRunDerived(
  runId: string,
  store: ArtifactStore,
  agents: AgentRegistry,
  mode: ConclusionsMode,
): Promise<TevuResult<RebuiltRun, RebuildReportErrorKind>> {
  const stored = await store.readRunResult(runId);
  if (!stored.ok) {
    return stored;
  }
  const manifest = stored.value.manifest;
  const context = manifest.context;
  if (context === undefined) {
    return artifactFailure(
      'rebuild-report',
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
  const gradings: GradingArtifact[] = [];
  for (const cached of stored.value.cases) {
    const rebuilt = await rebuildCaseResult(
      runId,
      cached.identity.caseId,
      tasksById,
      store,
      agents,
      manifest.tools.copiedProviders,
    );
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
    if (rebuilt.value.grading !== null) {
      gradings.push(rebuilt.value.grading);
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
  const input = {
    run,
    capabilities: context.capabilities,
    tasks: decoded.value.tasks,
    models: decoded.value.models,
    repositories: decoded.value.repositories,
    assessments,
    gradings,
  };
  const retainedDirectories: string[] = [];
  let saved: ConclusionsArtifact | null;
  if (mode.kind === 'write') {
    const tasks = await writeTaskConclusionsInOrder(buildSummaryEvidence(input), mode.writer);
    retainedDirectories.push(...tasks.retainedDirectories);
    saved = { schemaVersion: 1, runId, tasks: tasks.conclusions };
    const savedConclusions = await store.writeConclusions(saved);
    if (!savedConclusions.ok) {
      return savedConclusions;
    }
    const persisted = await store.readConclusions(runId);
    if (!persisted.ok) {
      return persisted;
    }
    saved = persisted.value;
  } else {
    const read = await store.readConclusions(runId);
    if (!read.ok) {
      return read;
    }
    saved = read.value;
  }
  const report = buildReport({ ...input, conclusions: saved });
  const written = await store.writeReport(runId, report);
  if (!written.ok) {
    return written;
  }
  if (mode.kind !== 'keep') {
    const summarized = await store.writeSummary(runId, report.summaryMarkdown);
    if (!summarized.ok) {
      return summarized;
    }
  }
  return { ok: true, value: { run, report, retainedDirectories } };
}

/**
 * Writes the conclusions of every task in order. After a cancellation, each
 * remaining task saves its template sentences with no call, so the summary is
 * complete without the model.
 */
async function writeTaskConclusionsInOrder(
  evidence: readonly SummaryEvidence[],
  writer: ConclusionWriter,
): Promise<{ conclusions: TaskConclusions[]; retainedDirectories: string[] }> {
  const conclusions: TaskConclusions[] = [];
  const retainedDirectories: string[] = [];
  let isCancelled = false;
  for (const entry of evidence) {
    const outcome = isCancelled ? { status: 'cancelled' as const } : await writer.write(entry);
    if (outcome.status === 'cancelled') {
      isCancelled = true;
      conclusions.push({
        taskId: entry.taskId,
        facts: entry.facts,
        conclusions: templateConclusions(entry.facts),
        call: null,
      });
      continue;
    }
    conclusions.push(outcome.conclusions);
    if (outcome.retainedDirectory !== null) {
      retainedDirectories.push(outcome.retainedDirectory);
    }
  }
  return { conclusions, retainedDirectories };
}

/** Rebuilds one derived case result from its preserved source artifacts. */
async function rebuildCaseResult(
  runId: string,
  caseId: string,
  tasksById: ReadonlyMap<string, TaskRecord>,
  store: ArtifactStore,
  agents: AgentRegistry,
  copiedProviders: Readonly<Record<string, readonly CopiedProvider[]>>,
): Promise<
  TevuResult<
    { result: CaseResult; assessment: AssessmentArtifact | null; grading: GradingArtifact | null },
    RebuildReportErrorKind
  >
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
      'rebuild-report',
      `case "${caseId}" names agent "${String(agentName)}", which has no registered adapter`,
    );
  }
  if (agentName === undefined || !Object.hasOwn(copiedProviders, agentName)) {
    return artifactFailure(
      'rebuild-report',
      `case "${caseId}" names agent "${String(agentName)}", which has no tools.copiedProviders entry in run.json`,
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
  let grading: GradingArtifact | null = null;
  if (source.artifacts.grading !== null) {
    const read = await store.readGrading(runId, caseId);
    if (!read.ok) {
      return read;
    }
    grading = read.value;
  }
  const assessment = await store.readAssessment(runId, caseId);
  if (!assessment.ok) {
    return assessment;
  }

  const task = tasksById.get(source.identity.taskId);
  if (task === undefined) {
    return artifactFailure(
      'rebuild-report',
      `preserved configuration does not define task "${source.identity.taskId}" for case "${caseId}"`,
    );
  }
  const normalized = adapter.normalizeMetrics({
    caseId,
    sessionId: null,
    events,
    sessionExport,
    exportUnavailableReason: EXPORT_ABSENT_REASON,
    copiedProviders: copiedProviders[agentName],
  });
  if (!normalized.ok) {
    return normalized;
  }
  const derivedChecks = applyCurrentAssessments(applyGrades(checks, grading), assessment.value);
  const paths = store.caseArtifactPaths(caseId);
  const result: CaseResult = {
    ...source,
    outcome:
      source.lifecycle === 'completed'
        ? reduceRequiredOutcome(task.checks, derivedChecks)
        : 'not-evaluated',
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
  return { ok: true, value: { result, assessment: assessment.value, grading } };
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
      evidence: `manually assessed by ${record.assessor} at ${record.assessedAt}${record.note.length > 0 ? `: ${record.note}` : ''}`,
    };
  });
}

/** Aggregates every defect of one assessment invocation into findings. */
function validateAssessmentInput(
  input: AssessmentInput,
  checks: readonly AssessableCheckSummary[],
  currentByCheck: ReadonlyMap<string, AssessmentRecord>,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  if (input.assessedAt.trim().length === 0 || Number.isNaN(Date.parse(input.assessedAt))) {
    findings.push({
      severity: 'error',
      identifier: 'assessedAt',
      message: 'assessedAt must be a parseable timestamp supplied by the caller',
    });
  }
  const checksById = new Map(checks.map((check) => [check.checkId, check]));
  const decided = new Set<string>();
  for (const decision of input.decisions) {
    if (decided.has(decision.checkId)) {
      findings.push({
        severity: 'error',
        identifier: decision.checkId,
        message: `check "${decision.checkId}" has more than one decision`,
      });
      continue;
    }
    decided.add(decision.checkId);
    const check = checksById.get(decision.checkId);
    if (check === undefined) {
      findings.push({
        severity: 'error',
        identifier: decision.checkId,
        message: `check "${decision.checkId}" is not a manual or graded check of this case`,
      });
      continue;
    }
    if (decision.assessor.trim().length === 0) {
      findings.push({
        severity: 'error',
        identifier: decision.checkId,
        message: 'assessor must not be empty',
      });
    }
    if (decision.verdict === 'failed' && decision.note.trim().length === 0) {
      findings.push({
        severity: 'error',
        identifier: decision.checkId,
        message: 'a failed verdict requires a non-empty note',
      });
    }
    const existing = existingVerdictOf(check, currentByCheck);
    if (existing !== undefined && !decision.replaceExisting) {
      findings.push({
        severity: 'error',
        identifier: decision.checkId,
        message:
          existing.source === 'operator'
            ? `check "${decision.checkId}" is already assessed; replacement must be selected and confirmed`
            : `check "${decision.checkId}" has a grader verdict; replacement must be selected and confirmed`,
      });
    }
    if (existing === undefined && decision.replaceExisting) {
      findings.push({
        severity: 'error',
        identifier: decision.checkId,
        message: `check "${decision.checkId}" has no existing assessment to replace`,
      });
    }
  }
  for (const check of checks) {
    if (existingVerdictOf(check, currentByCheck) === undefined && !decided.has(check.checkId)) {
      findings.push({
        severity: 'error',
        identifier: check.checkId,
        message:
          check.evaluator === 'grader'
            ? `pending graded check "${check.checkId}" has no decision; every pending graded check must be assessed`
            : `pending manual check "${check.checkId}" has no decision; every pending manual check must be assessed`,
      });
    }
  }
  if (input.decisions.length === 0 && findings.length === 0) {
    findings.push({
      severity: 'error',
      identifier: input.caseId,
      message:
        'every manual and graded check already has a verdict and no replacement was selected',
    });
  }
  return findings;
}

/**
 * Builds the next assessment revision in configuration order: new decisions
 * install fresh records, a replaced prior operator record moves to history
 * stamped `source: 'operator'`, a replaced grade-derived verdict moves to
 * history stamped `source: 'grader'`, and unreplaced existing records are
 * retained unchanged.
 */
function buildNextAssessment(
  input: AssessmentInput,
  checks: readonly AssessableCheckSummary[],
  currentByCheck: ReadonlyMap<string, AssessmentRecord>,
  existing: AssessmentArtifact | null,
): AssessmentArtifact {
  const decisionsByCheck = new Map(input.decisions.map((decision) => [decision.checkId, decision]));
  const current: AssessmentRecord[] = [];
  const history: Array<ReplacedOperatorVerdict | ReplacedGraderVerdict> = [
    ...(existing?.history ?? []),
  ];
  for (const check of checks) {
    const checkId = check.checkId;
    const decision = decisionsByCheck.get(checkId);
    const priorOperatorRecord = currentByCheck.get(checkId);
    if (decision === undefined) {
      if (priorOperatorRecord !== undefined) {
        current.push(priorOperatorRecord);
      }
      continue;
    }
    if (priorOperatorRecord !== undefined) {
      history.push({ ...priorOperatorRecord, source: 'operator', replacedAt: input.assessedAt });
    } else if (
      check.evaluator === 'grader' &&
      check.grade !== null &&
      check.grade.status === 'graded' &&
      check.grade.verdict !== 'undetermined' &&
      check.grader !== null
    ) {
      history.push({
        source: 'grader',
        checkId,
        verdict: check.grade.verdict,
        rationale: check.grade.rationale,
        grader: check.grader,
        replacedAt: input.assessedAt,
      });
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
  return error.kind === 'ArtifactError'
    ? `artifact operation "${error.operation}" failed: ${error.reason}`
    : `agent "${error.agent}" protocol failure: ${error.reason}`;
}

function artifactFailure(
  operation: string,
  reason: string,
): { ok: false; error: Extract<TevuError, { kind: 'ArtifactError' }> } {
  return { ok: false, error: { kind: 'ArtifactError', operation, reason } };
}

function configValidationFailure(findings: ValidationFinding[]): {
  ok: false;
  error: Extract<TevuError, { kind: 'ConfigValidationError' }>;
} {
  return { ok: false, error: { kind: 'ConfigValidationError', findings } };
}

function cancellationFailure(): {
  ok: false;
  error: Extract<TevuError, { kind: 'CancellationError' }>;
} {
  return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
}
