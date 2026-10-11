/**
 * Zod parsers for the JSON files of a saved run.
 *
 * Each parse function turns an untyped value into the domain type it mirrors,
 * or into the path of the first field that does not match; no message, input,
 * or parsed value ever enters a defect path. Every schema passes through
 * `schemaFor`, so the compiler rejects a schema that drifts from its domain
 * type. Entry points: `parseRunManifest`, `parseRunResult`, `parseCaseResult`,
 * `parseChecksArtifact`, `parseGradingArtifact`, `parseAssessmentArtifact`,
 * and `parseConclusionsArtifact`.
 */

import { z } from 'zod';

import { describePath } from '@/domain/describe-path';

import type {
  AgentCapabilityReport,
  AgentConfigurationFileRecord,
  AgentMetrics,
  AssessmentArtifact,
  AssessmentRecord,
  BenchmarkMetrics,
  CapabilityAvailability,
  CaseGrading,
  CaseIdentity,
  CaseResult,
  CheckCategory,
  CheckResult,
  CheckStateRecord,
  ConclusionsArtifact,
  CopiedProvider,
  EffortCheck,
  EnvironmentVariableRecord,
  FailureRecord,
  GradeRecord,
  GradingArtifact,
  MetricValue,
  ModelRole,
  ModelRoleName,
  ProcessResult,
  RepeatSetting,
  ReplacedGraderVerdict,
  ReplacedOperatorVerdict,
  RunFinding,
  RunManifest,
  RunResult,
  SetupCommandRecord,
  SetupPhase,
  SummaryCall,
  SummaryComparison,
  SummaryDropout,
  SummaryFacts,
  SummaryMargin,
  SummaryMeasure,
  SummarySetting,
  TaskConclusions,
  TevuError,
  ValidationFinding,
} from '@/domain/types';

/** The layout of `cases/<case-id>/checks.json`; `ArtifactStore.writeChecks` writes it and `readChecks` parses it. */
export type ChecksArtifact = {
  schemaVersion: 1;
  runId: string;
  caseId: string;
  checks: CheckResult[];
};

type ArtifactParse<T> = { ok: true; value: T } | { ok: false; defectPath: string };

type KeysOfUnion<T> = T extends unknown ? keyof T & string : never;

type PropertyOf<T, K extends string> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never;

/** The dotted path of every string key `T` declares, at any depth, that `O` lacks. */
type MissingKeyPaths<T, O> =
  NonNullable<T> extends readonly unknown[]
    ? MissingKeyPaths<
        NonNullable<T>[number],
        NonNullable<O> extends readonly unknown[] ? NonNullable<O>[number] : never
      >
    : NonNullable<T> extends object
      ? {
          [K in KeysOfUnion<NonNullable<T>>]: K extends KeysOfUnion<NonNullable<O>>
            ? MissingKeyPaths<
                PropertyOf<NonNullable<T>, K>,
                PropertyOf<NonNullable<O>, K>
              > extends infer P extends string
              ? `${K}.${P}`
              : never
            : K;
        }[KeysOfUnion<NonNullable<T>>]
      : never;

/**
 * Resolves to `unknown` when the schema output and `T` assign to each other and
 * `T` declares no key, at any depth, that the output lacks. Mutual assignability
 * alone accepts a schema that omits an optional property of `T`.
 */
type ExactOutput<S extends z.ZodType, T> = [z.output<S>] extends [T]
  ? [T] extends [z.output<S>]
    ? [MissingKeyPaths<T, z.output<S>>] extends [never]
      ? unknown
      : { missingFromSchema: MissingKeyPaths<T, z.output<S>> }
    : never
  : never;

function schemaFor<T>(): <S extends z.ZodType<T>>(schema: S & ExactOutput<S, T>) => S {
  return (schema) => schema;
}

function defectPathOf(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    return describePath([...issue.path, issue.keys[0] ?? '']);
  }
  return describePath(issue.path);
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown): ArtifactParse<z.output<S>> {
  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const firstIssue = result.error.issues[0];
  return { ok: false, defectPath: firstIssue === undefined ? '(root)' : defectPathOf(firstIssue) };
}

/** Fails with the path of the first rule whose actual value differs from the expected one. */
function withIdentity<T>(
  parsed: ArtifactParse<T>,
  rules: (value: T) => ReadonlyArray<readonly [path: string, actual: string, expected: string]>,
): ArtifactParse<T> {
  if (!parsed.ok) {
    return parsed;
  }
  for (const [path, actual, expected] of rules(parsed.value)) {
    if (actual !== expected) {
      return { ok: false, defectPath: path };
    }
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const nonEmptyStringSchema = z.string().min(1);
const positiveSafeIntegerSchema = z.number().int().min(1);
const countSchema = z.number().int().min(0);

const stringListSchema = schemaFor<string[]>()(z.array(z.string()));
const schemaVersionSchema = schemaFor<1>()(z.literal(1));
const checkCategorySchema = schemaFor<CheckCategory>()(
  z.enum(['acceptance', 'definition-of-done']),
);
const modelRoleNameSchema = schemaFor<ModelRoleName>()(z.enum(['criteria', 'grader', 'summary']));
const setupPhaseSchema = schemaFor<SetupPhase>()(z.enum(['before_agent', 'before_checks']));
const capabilityAvailabilitySchema = schemaFor<CapabilityAvailability>()(
  z.enum(['available', 'unavailable']),
);

const metricValueSchema = schemaFor<MetricValue>()(
  z.strictObject({
    value: z.number().nullable(),
    unit: z.enum(['count', 'token', 'millisecond', 'USD']),
    availability: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('available'), source: z.string() }),
      z.strictObject({ status: z.literal('unavailable'), reason: z.string() }),
    ]),
    scope: z.enum(['case', 'root-session', 'session-tree']),
  }),
);

const agentMetricShape = {
  inputTokens: metricValueSchema,
  outputTokens: metricValueSchema,
  reasoningTokens: metricValueSchema,
  cacheReadTokens: metricValueSchema,
  cacheWriteTokens: metricValueSchema,
  turns: metricValueSchema,
  apiCalls: metricValueSchema,
  apiErrors: metricValueSchema,
  toolCalls: metricValueSchema,
  skillCalls: metricValueSchema,
  cost: metricValueSchema,
};

const agentMetricsSchema = schemaFor<AgentMetrics>()(z.strictObject(agentMetricShape));

const benchmarkMetricsSchema = schemaFor<BenchmarkMetrics>()(
  z.strictObject({ elapsed: metricValueSchema, ...agentMetricShape }),
);

const validationFindingSchema = schemaFor<ValidationFinding>()(
  z.strictObject({
    severity: z.enum(['error', 'warning']),
    identifier: z.string(),
    message: z.string(),
  }),
);

const tevuErrorSchema = schemaFor<TevuError>()(
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('ConfigParseError'),
      findings: z.array(validationFindingSchema),
    }),
    z.strictObject({
      kind: z.literal('ConfigValidationError'),
      findings: z.array(validationFindingSchema),
    }),
    z.strictObject({
      kind: z.literal('ConfigReadError'),
      path: z.string(),
      requestedPath: z.string(),
      cause: z.enum(['not-found', 'permission-denied', 'not-a-file', 'unreadable']),
    }),
    z.strictObject({
      kind: z.literal('ConfigNotFoundError'),
      searchedPaths: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    }),
    z.strictObject({
      kind: z.literal('PrerequisiteError'),
      tool: z.string(),
      expected: z.string(),
      actual: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal('SourceMaterializationError'),
      taskId: z.string(),
      reason: z.string(),
    }),
    z.strictObject({ kind: z.literal('IsolationError'), caseId: z.string(), reason: z.string() }),
    z.strictObject({
      kind: z.literal('IssueImportError'),
      tracker: z.enum(['jira-cloud', 'github-issue']),
      reference: z.string(),
      status: z.number().optional(),
      reason: z.string(),
    }),
    z.strictObject({
      kind: z.literal('AgentProcessError'),
      agent: z.string(),
      caseId: z.string(),
      exitCode: z.number().nullable(),
      signal: z.string().nullable(),
    }),
    z.strictObject({
      kind: z.literal('AgentProtocolError'),
      agent: z.string(),
      context: z.discriminatedUnion('phase', [
        z.strictObject({ phase: z.literal('probe') }),
        z.strictObject({ phase: z.literal('case'), caseId: z.string() }),
        z.strictObject({ phase: z.literal('call'), role: modelRoleNameSchema }),
      ]),
      line: z.number().optional(),
      reason: z.string(),
    }),
    z.strictObject({
      kind: z.literal('AgentSessionError'),
      agent: z.string(),
      caseId: z.string(),
      agentMessage: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal('ModelCallError'),
      role: modelRoleNameSchema,
      agent: z.string(),
      cause: z.enum(['launch-failed', 'failed', 'timed-out', 'unfinished', 'tool-call']),
      reason: z.string(),
      agentMessage: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal('CaseTimeoutError'),
      caseId: z.string(),
      timeoutMs: z.number(),
    }),
    z.strictObject({
      kind: z.literal('EvaluationError'),
      caseId: z.string(),
      checkId: z.string(),
      reason: z.string(),
    }),
    z.strictObject({
      kind: z.literal('AssessmentConflictError'),
      runId: z.string(),
      caseId: z.string(),
      reason: z.string(),
    }),
    z.strictObject({ kind: z.literal('ArtifactError'), operation: z.string(), reason: z.string() }),
    z.strictObject({ kind: z.literal('RedactionError'), reason: z.string() }),
    z.strictObject({ kind: z.literal('CancellationError'), activeCaseIds: stringListSchema }),
    z.strictObject({
      kind: z.literal('CheckStateError'),
      step: z.enum(['restore', 'overlay']),
      reason: z.string(),
    }),
    z.strictObject({
      kind: z.literal('SetupError'),
      phase: setupPhaseSchema,
      argv: stringListSchema,
      reason: z.string(),
    }),
    z.strictObject({ kind: z.literal('ReferenceResolutionError'), reason: z.string() }),
    z.strictObject({
      kind: z.literal('ManagedCloneError'),
      operation: z.enum(['clone', 'fetch', 'ls-remote', 'lfs-fetch']),
      repository: z.string(),
      reason: z.string(),
    }),
  ]),
);

const repeatSettingSchema = schemaFor<RepeatSetting>()(
  z.strictObject({ value: positiveSafeIntegerSchema, source: z.enum(['config', 'cli']) }),
);

const caseIdentitySchema = schemaFor<CaseIdentity>()(
  z.strictObject({
    caseId: z.string(),
    taskId: z.string(),
    modelId: z.string(),
    attempt: positiveSafeIntegerSchema,
    sourceCommit: z.string(),
    model: z.string(),
    effort: z.string(),
    agent: nonEmptyStringSchema,
    timeoutMs: positiveSafeIntegerSchema,
  }),
);

const modelRoleSchema = schemaFor<ModelRole>()(
  z.strictObject({
    model: z.templateLiteral([z.string(), '/', z.string()]),
    effort: nonEmptyStringSchema,
    agent: nonEmptyStringSchema,
  }),
);

const checkResultSchema = schemaFor<CheckResult>()(
  z.strictObject({
    checkId: nonEmptyStringSchema,
    category: checkCategorySchema,
    verdict: z.enum(['passed', 'failed', 'pending', 'not-run']),
    evidence: z.string(),
    durationMs: z.number().nullable(),
  }),
);

const processResultSchema = schemaFor<ProcessResult>()(
  z.strictObject({
    exitCode: z.number().nullable(),
    signal: z.string().nullable(),
    startedAt: z.string(),
    endedAt: z.string(),
    durationMs: z.number(),
    terminationStage: z.enum(['none', 'graceful', 'forced']),
  }),
);

const failureRecordSchema = schemaFor<FailureRecord>()(
  z.strictObject({ error: tevuErrorSchema, occurredAt: z.string() }),
);

const artifactIndexSchema = schemaFor<CaseResult['artifacts']>()(
  z.strictObject({
    events: z.string().nullable(),
    diagnostics: z.string().nullable(),
    sessionExport: z.string().nullable(),
    solutionPatch: z.string().nullable(),
    checks: z.string().nullable(),
    assessment: z.string().nullable(),
    grading: nonEmptyStringSchema.nullable(),
    result: z.string().nullable(),
  }),
);

const checkStateRecordSchema = schemaFor<CheckStateRecord>()(
  z.strictObject({
    restore: z.strictObject({ restored: stringListSchema, removed: stringListSchema }).nullable(),
    overlay: z
      .strictObject({
        files: z.array(z.strictObject({ path: z.string(), sha256: z.string() })),
        removed: stringListSchema,
      })
      .nullable(),
  }),
);

const setupCommandRecordSchema = schemaFor<SetupCommandRecord>()(
  z.strictObject({
    phase: setupPhaseSchema,
    argv: stringListSchema,
    exitCode: z.number().nullable(),
    durationMs: z.number().nullable(),
    outcome: z.enum(['passed', 'failed', 'timed-out', 'launch-failed', 'cancelled']),
  }),
);

const setupRecordSchema = schemaFor<NonNullable<CaseResult['setup']>>()(
  z.strictObject({
    logs: z.strictObject({
      beforeAgent: z.string().nullable(),
      beforeChecks: z.string().nullable(),
    }),
    commands: z.array(setupCommandRecordSchema),
  }),
);

const environmentVariableRecordSchema = schemaFor<EnvironmentVariableRecord>()(
  z.strictObject({
    name: z.string(),
    classification: z.enum(['fixed', 'secret', 'ordinary']),
    recipient: z.enum(['agent', 'evaluator']),
  }),
);

const caseContextSchema = schemaFor<NonNullable<CaseResult['context']>>()(
  z.strictObject({
    sourceRepositoryPath: z.string(),
    syntheticCommit: z.string(),
    environment: z.array(environmentVariableRecordSchema),
  }),
);

const caseResultSchema = schemaFor<CaseResult>()(
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    identity: caseIdentitySchema,
    lifecycle: z.enum([
      'queued',
      'preparing',
      'running',
      'evaluating',
      'completed',
      'process-failed',
      'timed-out',
      'cancelled',
      'infrastructure-failed',
    ]),
    process: processResultSchema.nullable(),
    outcome: z.enum(['passed', 'failed', 'pending', 'not-evaluated']),
    checks: z.array(checkResultSchema),
    metrics: benchmarkMetricsSchema,
    artifacts: artifactIndexSchema,
    failure: failureRecordSchema.nullable(),
    checkState: checkStateRecordSchema.optional(),
    setup: setupRecordSchema.optional(),
    context: caseContextSchema.optional(),
  }),
);

const copiedProviderSchema = schemaFor<CopiedProvider>()(
  z.strictObject({ id: nonEmptyStringSchema, pricedModels: stringListSchema }),
);

const agentConfigurationFileRecordSchema = schemaFor<AgentConfigurationFileRecord>()(
  z.strictObject({ path: z.string(), sha256: z.string() }),
);

const effortCheckSchema = schemaFor<EffortCheck>()(
  z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('verified') }),
    z.strictObject({ status: z.literal('unverified'), reason: nonEmptyStringSchema }),
    z.strictObject({ status: z.literal('unsupported'), reason: nonEmptyStringSchema }),
  ]),
);

const runEffortChecksSchema = schemaFor<RunManifest['efforts']>()(
  z.strictObject({
    models: z.record(z.string(), effortCheckSchema),
    grader: effortCheckSchema.nullable(),
  }),
);

const agentCapabilityReportSchema = schemaFor<AgentCapabilityReport>()(
  z.strictObject({
    executable: z.string(),
    detectedVersion: z.string().nullable(),
    capabilities: z.array(
      z.strictObject({
        name: z.string(),
        required: z.boolean(),
        availability: capabilityAvailabilitySchema,
      }),
    ),
    isolation: z.strictObject({ denyOutsideWorktree: capabilityAvailabilitySchema }),
  }),
);

function snapshotDeclaresGrader(manifest: RunManifest): boolean {
  const config = manifest.context?.config;
  if (!isRecord(config)) {
    return false;
  }
  const roles = config['roles'];
  return isRecord(roles) && roles['grader'] !== undefined;
}

const runManifestSchema = schemaFor<RunManifest>()(
  z
    .strictObject({
      schemaVersion: schemaVersionSchema,
      runId: z.string(),
      configDigest: z.string(),
      configPath: nonEmptyStringSchema,
      startedAt: z.string(),
      completedAt: z.string().nullable(),
      host: z.strictObject({ platform: z.enum(['linux', 'darwin']), nodeVersion: z.string() }),
      tools: z.strictObject({
        gitVersion: z.string(),
        agentVersions: z.record(z.string(), z.string().nullable()),
        agentConfigurationFiles: z.record(z.string(), z.array(agentConfigurationFileRecordSchema)),
        copiedProviders: z.record(z.string(), z.array(copiedProviderSchema)),
      }),
      execution: z.strictObject({
        concurrency: z.number(),
        caseTimeoutMs: z.number(),
        repeat: repeatSettingSchema,
      }),
      cases: z.array(caseIdentitySchema),
      efforts: runEffortChecksSchema,
      context: z
        .strictObject({
          config: z.unknown(),
          capabilities: z.record(z.string(), agentCapabilityReportSchema),
        })
        .optional(),
    })
    .superRefine((manifest, ctx) => {
      const unlistedAgent = manifest.cases.findIndex(
        (entry) => !Object.hasOwn(manifest.tools.copiedProviders, entry.agent),
      );
      if (unlistedAgent !== -1) {
        ctx.addIssue({ code: 'custom', path: ['cases', unlistedAgent, 'agent'] });
        return;
      }
      const uncheckedModel = manifest.cases.findIndex(
        (entry) => !Object.hasOwn(manifest.efforts.models, entry.modelId),
      );
      if (uncheckedModel !== -1) {
        ctx.addIssue({ code: 'custom', path: ['cases', uncheckedModel, 'modelId'] });
        return;
      }
      if ((manifest.efforts.grader === null) === snapshotDeclaresGrader(manifest)) {
        ctx.addIssue({ code: 'custom', path: ['efforts', 'grader'] });
      }
    }),
);

const runFindingSchema = schemaFor<RunFinding>()(
  z.strictObject({
    severity: z.enum(['error', 'warning']),
    caseId: z.string().nullable(),
    message: z.string(),
  }),
);

const runResultSchema = schemaFor<RunResult>()(
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    manifest: runManifestSchema,
    cases: z.array(caseResultSchema),
    findings: z.array(runFindingSchema),
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(130)]),
  }),
);

const checksArtifactSchema = schemaFor<ChecksArtifact>()(
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    runId: z.string(),
    caseId: z.string(),
    checks: z.array(checkResultSchema),
  }),
);

const gradeRecordSchema = schemaFor<GradeRecord>()(
  z.discriminatedUnion('status', [
    z.strictObject({
      checkId: nonEmptyStringSchema,
      category: checkCategorySchema,
      status: z.literal('graded'),
      verdict: z.enum(['passed', 'failed', 'undetermined']),
      rationale: z.string(),
    }),
    z.strictObject({
      checkId: nonEmptyStringSchema,
      category: checkCategorySchema,
      status: z.literal('pending'),
      reason: z.string(),
    }),
  ]),
);

const graderNoReplySchema = schemaFor<Extract<CaseGrading['call'], { status: 'no-reply' }>>()(
  z.strictObject({
    status: z.literal('no-reply'),
    cause: z.enum(['unfinished', 'tool-call', 'other']),
    reason: z.string(),
  }),
);

const graderCallRecordSchema = schemaFor<CaseGrading['call']>()(
  z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('replied'), reply: z.string() }),
    graderNoReplySchema,
  ]),
);

const graderCallSchema = schemaFor<CaseGrading['calls'][number]>()(
  z.strictObject({
    outcome: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('replied') }),
      graderNoReplySchema,
    ]),
    metrics: agentMetricsSchema,
    events: z.array(z.unknown()),
    diagnostics: z.string(),
    session: z.record(z.string(), z.unknown()).nullable(),
  }),
);

const gradingArtifactSchema = schemaFor<GradingArtifact>()(
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    runId: z.string(),
    caseId: z.string(),
    grader: modelRoleSchema,
    call: graderCallRecordSchema,
    calls: z.array(graderCallSchema),
    metrics: agentMetricsSchema,
    grades: z.array(gradeRecordSchema),
  }),
);

const assessmentRecordShape = {
  checkId: nonEmptyStringSchema,
  verdict: z.enum(['passed', 'failed']),
  assessor: z.string(),
  note: z.string(),
  assessedAt: z.string(),
};

const assessmentRecordSchema = schemaFor<AssessmentRecord>()(z.strictObject(assessmentRecordShape));

const replacedOperatorVerdictSchema = schemaFor<ReplacedOperatorVerdict>()(
  z.strictObject({
    ...assessmentRecordShape,
    source: z.literal('operator'),
    replacedAt: nonEmptyStringSchema,
  }),
);

const replacedGraderVerdictSchema = schemaFor<ReplacedGraderVerdict>()(
  z.strictObject({
    source: z.literal('grader'),
    checkId: nonEmptyStringSchema,
    verdict: z.enum(['passed', 'failed', 'undetermined']),
    rationale: z.string(),
    grader: modelRoleSchema,
    replacedAt: nonEmptyStringSchema,
  }),
);

const assessmentArtifactSchema = schemaFor<AssessmentArtifact>()(
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    runId: z.string(),
    caseId: z.string(),
    revision: positiveSafeIntegerSchema,
    current: z.array(assessmentRecordSchema),
    history: z.array(
      z.discriminatedUnion('source', [replacedOperatorVerdictSchema, replacedGraderVerdictSchema]),
    ),
  }),
);

const summaryMeasureSchema = schemaFor<SummaryMeasure>()(
  z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('unknown') }),
    z.strictObject({
      status: z.literal('known'),
      value: z.number(),
      text: z.string(),
      reportedAttempts: countSchema,
    }),
  ]),
);

const summaryDropoutSchema = schemaFor<SummaryDropout>()(
  z.strictObject({
    timedOut: countSchema,
    failedToRun: countSchema,
    failedToRunLabels: stringListSchema,
    waiting: countSchema,
  }),
);

const summarySettingSchema = schemaFor<SummarySetting>()(
  z.strictObject({
    name: z.string(),
    model: z.string(),
    effort: z.string(),
    planned: countSchema,
    outcomes: z.strictObject({
      passed: countSchema,
      failed: countSchema,
      pending: countSchema,
      notEvaluated: countSchema,
    }),
    requiredChecks: z.strictObject({
      passed: countSchema,
      failed: countSchema,
      pending: countSchema,
      notRun: countSchema,
      total: countSchema,
    }),
    didTask: z.boolean(),
    cost: summaryMeasureSchema,
    elapsed: summaryMeasureSchema,
    dropout: summaryDropoutSchema.nullable(),
  }),
);

const summaryMarginSchema = schemaFor<SummaryMargin>()(
  z.strictObject({ kind: z.enum(['times', 'percent']), value: z.string() }),
);

const summaryComparisonSchema = schemaFor<SummaryComparison>()(
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none-did-the-task') }),
    z.strictObject({ kind: z.literal('only-setting'), leader: z.string() }),
    z.strictObject({ kind: z.literal('not-enough-data'), unknown: stringListSchema }),
    z.strictObject({
      kind: z.enum(['leader', 'tie']),
      leaders: stringListSchema,
      value: z.string(),
      next: z
        .strictObject({ value: z.string(), margin: summaryMarginSchema.nullable() })
        .nullable(),
      unknown: stringListSchema,
      partial: z.array(z.strictObject({ name: z.string(), reportedAttempts: countSchema })),
    }),
  ]),
);

const summaryFactsSchema = schemaFor<SummaryFacts>()(
  z.strictObject({
    task: z.string(),
    repository: z.string(),
    when: z.string(),
    repeat: countSchema,
    requiredChecksPerAttempt: countSchema,
    settings: z.array(summarySettingSchema),
    separation: z.enum(['passed', 'failed']).nullable(),
    cost: summaryComparisonSchema,
    speed: summaryComparisonSchema,
  }),
);

const summaryCallSchema = schemaFor<SummaryCall>()(
  z.strictObject({
    model: modelRoleSchema,
    outcome: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('accepted'), reply: z.string() }),
      z.strictObject({ status: z.literal('rejected'), reply: z.string(), reason: z.string() }),
      z.strictObject({ status: z.literal('no-reply'), reason: z.string() }),
    ]),
    metrics: agentMetricsSchema,
  }),
);

const taskConclusionsSchema = schemaFor<TaskConclusions>()(
  z.strictObject({
    taskId: nonEmptyStringSchema,
    facts: summaryFactsSchema,
    table: stringListSchema,
    conclusions: z.strictObject({
      correctness: z.string(),
      cost: z.string(),
      speed: z.string(),
    }),
    call: summaryCallSchema.nullable(),
  }),
);

const conclusionsArtifactSchema = schemaFor<ConclusionsArtifact>()(
  z.strictObject({
    schemaVersion: schemaVersionSchema,
    runId: z.string(),
    tasks: z.array(taskConclusionsSchema),
  }),
);

/** Parses `run.json`'s manifest and refuses one whose run ID is not `runId`. */
export function parseRunManifest(value: unknown, runId: string): ArtifactParse<RunManifest> {
  return withIdentity(parseWith(runManifestSchema, value), (manifest) => [
    ['runId', manifest.runId, runId],
  ]);
}

/** Parses a finalized `run.json` and refuses one whose manifest names a run other than `runId`. */
export function parseRunResult(value: unknown, runId: string): ArtifactParse<RunResult> {
  return withIdentity(parseWith(runResultSchema, value), (result) => [
    ['manifest.runId', result.manifest.runId, runId],
  ]);
}

/** Parses a case `result.json` and refuses one whose case ID is not `caseId`. */
export function parseCaseResult(value: unknown, caseId: string): ArtifactParse<CaseResult> {
  return withIdentity(parseWith(caseResultSchema, value), (result) => [
    ['identity.caseId', result.identity.caseId, caseId],
  ]);
}

/** Parses a case `checks.json` and refuses one that names a run or case other than the given ones. */
export function parseChecksArtifact(
  value: unknown,
  runId: string,
  caseId: string,
): ArtifactParse<ChecksArtifact> {
  return withIdentity(parseWith(checksArtifactSchema, value), (artifact) => [
    ['runId', artifact.runId, runId],
    ['caseId', artifact.caseId, caseId],
  ]);
}

/** Parses a case `grading.json` and refuses one that names a run or case other than the given ones. */
export function parseGradingArtifact(
  value: unknown,
  runId: string,
  caseId: string,
): ArtifactParse<GradingArtifact> {
  return withIdentity(parseWith(gradingArtifactSchema, value), (artifact) => [
    ['runId', artifact.runId, runId],
    ['caseId', artifact.caseId, caseId],
  ]);
}

/** Parses a case `assessment.json` and refuses one that names a run or case other than the given ones. */
export function parseAssessmentArtifact(
  value: unknown,
  runId: string,
  caseId: string,
): ArtifactParse<AssessmentArtifact> {
  return withIdentity(parseWith(assessmentArtifactSchema, value), (artifact) => [
    ['runId', artifact.runId, runId],
    ['caseId', artifact.caseId, caseId],
  ]);
}

/** Parses `conclusions.json` and refuses one whose run ID is not `runId`. */
export function parseConclusionsArtifact(
  value: unknown,
  runId: string,
): ArtifactParse<ConclusionsArtifact> {
  return withIdentity(parseWith(conclusionsArtifactSchema, value), (artifact) => [
    ['runId', artifact.runId, runId],
  ]);
}
