import { unavailableAgentMetrics, unavailableBenchmarkMetrics } from '@/domain/types';

import type {
  AgentMetrics,
  CaseIdentity,
  CaseResult,
  CheckRecord,
  CheckResult,
  GradeRecord,
  GradingArtifact,
  MetricValue,
  ModelRecord,
  SummaryCall,
  SummaryFacts,
  SummaryMeasure,
  SummarySetting,
  TaskRecord,
  TevuError,
} from '@/domain/types';
import type { SummaryEvidence, SummaryTaskView } from '@/evaluation/summary';

export const FIXTURE_RUN_ID = 'run-1';

export function buildCaseIdentity(overrides: Partial<CaseIdentity> = {}): CaseIdentity {
  return {
    caseId: 'task-1--m1--1',
    taskId: 'task-1',
    modelId: 'm1',
    attempt: 1,
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    model: 'vendor/model-a',
    effort: 'high',
    agent: 'opencode',
    timeoutMs: 60_000,
    ...overrides,
  };
}

export function buildCheckRecord(
  overrides: Partial<CheckRecord> & Pick<CheckRecord, 'id'>,
): CheckRecord {
  return {
    category: 'acceptance',
    description: `check ${overrides.id}`,
    required: true,
    evaluator: 'command',
    ...overrides,
  };
}

export function buildTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: 'Fix the login redirect',
    repositoryId: 'repo-1',
    startCommit: '0123456789abcdef0123456789abcdef01234567',
    description: 'synthetic task description',
    source: { kind: 'manual' },
    checks: [],
    ...overrides,
  };
}

export function buildModelRecord(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return { id: 'm1', model: 'vendor/model-a', effort: 'high', ...overrides };
}

export function buildCheckResult(
  overrides: Partial<CheckResult> & Pick<CheckResult, 'checkId'>,
): CheckResult {
  return {
    category: 'acceptance',
    verdict: 'passed',
    evidence: 'exit code 0',
    durationMs: 12,
    ...overrides,
  };
}

export function buildCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  const identity = overrides.identity ?? buildCaseIdentity();
  return {
    schemaVersion: 1,
    identity,
    lifecycle: 'completed',
    process: null,
    outcome: 'passed',
    checks: [],
    metrics: unavailableBenchmarkMetrics('not measured in this fixture'),
    artifacts: {
      events: null,
      diagnostics: null,
      sessionExport: null,
      solutionPatch: null,
      checks: null,
      assessment: null,
      grading: null,
      result: `cases/${identity.caseId}/result.json`,
    },
    failure: null,
    ...overrides,
  };
}

export function buildFailure(error: TevuError): NonNullable<CaseResult['failure']> {
  return { error, occurredAt: '2026-09-23T00:00:00.000Z' };
}

type GraderCallEntry = GradingArtifact['calls'][number];

/** An agent metric set where every value is available and measured as one under the `export` source. */
export function buildAgentMetrics(overrides: Partial<AgentMetrics> = {}): AgentMetrics {
  const measured = (unit: MetricValue['unit'], value: number): MetricValue => ({
    value,
    unit,
    availability: { status: 'available', source: 'export' },
    scope: 'root-session',
  });
  return {
    inputTokens: measured('token', 100),
    outputTokens: measured('token', 20),
    reasoningTokens: measured('token', 0),
    cacheReadTokens: measured('token', 0),
    cacheWriteTokens: measured('token', 0),
    turns: measured('count', 1),
    apiCalls: measured('count', 1),
    apiErrors: measured('count', 0),
    toolCalls: measured('count', 0),
    skillCalls: measured('count', 0),
    cost: measured('USD', 0.5),
    ...overrides,
  };
}

export function buildGraderCall(overrides: Partial<GraderCallEntry> = {}): GraderCallEntry {
  return {
    outcome: { status: 'replied' },
    metrics: buildAgentMetrics(),
    events: [],
    diagnostics: '',
    session: null,
    ...overrides,
  };
}

function outcomeOf(call: GradingArtifact['call']): GraderCallEntry['outcome'] {
  return call.status === 'replied' ? { status: 'replied' } : call;
}

/** A grading whose single call is consistent with `call` and `metrics`, unless `calls` is overridden. */
export function buildGradingArtifact(overrides: Partial<GradingArtifact> = {}): GradingArtifact {
  const call = overrides.call ?? { status: 'replied', reply: '{"grades":[]}' };
  const metrics = overrides.metrics ?? unavailableAgentMetrics('not measured in this fixture');
  return {
    schemaVersion: 1,
    runId: FIXTURE_RUN_ID,
    caseId: 'task-1--m1--1',
    grader: { model: 'vendor/grader-model', effort: 'medium', agent: 'opencode' },
    call,
    calls: [buildGraderCall({ outcome: outcomeOf(call), metrics })],
    metrics,
    grades: [],
    ...overrides,
  };
}

type UnfinishedNoReply = Extract<GradingArtifact['call'], { status: 'no-reply' }>;

/**
 * A grading that made `callCount` calls and ended without a reply: every call
 * but the last stopped early, and the last one ended as `call` says.
 */
export function buildMultiCallGradingArtifact(
  callCount: number,
  overrides: Partial<GradingArtifact> & { call?: UnfinishedNoReply } = {},
): GradingArtifact {
  const call: UnfinishedNoReply = overrides.call ?? {
    status: 'no-reply',
    cause: 'unfinished',
    reason: 'the grader call failed: the model stopped before finishing its reply',
  };
  const unfinished = {
    status: 'no-reply',
    cause: 'unfinished',
    reason: 'the grader call failed: the model stopped before finishing its reply',
  } as const;
  const calls = Array.from({ length: callCount }, (_, index) =>
    buildGraderCall({ outcome: index === callCount - 1 ? call : unfinished }),
  );
  return buildGradingArtifact({ call, calls, ...overrides });
}

type GradedGrade = Extract<GradeRecord, { status: 'graded' }>;
type PendingGrade = Extract<GradeRecord, { status: 'pending' }>;

export function buildGradedGrade(
  overrides: Partial<GradedGrade> & Pick<GradedGrade, 'checkId'>,
): GradedGrade {
  return {
    category: 'acceptance',
    status: 'graded',
    verdict: 'passed',
    rationale: 'the diff satisfies the check',
    ...overrides,
  };
}

export function buildPendingGrade(
  overrides: Partial<PendingGrade> & Pick<PendingGrade, 'checkId'>,
): PendingGrade {
  return {
    category: 'acceptance',
    status: 'pending',
    reason: 'the reply named no verdict for this check',
    ...overrides,
  };
}

type ViewRow = SummaryTaskView['rows'][number];
type ViewAttempt = ViewRow['attempts'][number];

export const UNKNOWN_MEASURE: SummaryMeasure = { status: 'unknown' };

export function knownMeasure(value: number, text: string, reportedAttempts = 1): SummaryMeasure {
  return { status: 'known', value, text, reportedAttempts };
}

export function buildViewAttempt(overrides: Partial<ViewAttempt> = {}): ViewAttempt {
  return { outcome: 'passed', dropout: null, label: null, ...overrides };
}

/** One passed attempt of `gpt-5.6-luna` at high effort that cost $0.0800 and took 6.3 min. */
export function buildViewRow(overrides: Partial<ViewRow> = {}): ViewRow {
  return {
    name: 'gpt-5.6-luna, high',
    model: 'gpt-5.6-luna',
    effort: 'high',
    attempts: [buildViewAttempt()],
    requiredChecks: { passed: 6, failed: 0, pending: 0, notRun: 0, total: 6 },
    cost: knownMeasure(0.08, '$0.0800'),
    elapsed: knownMeasure(378_000, '6.3 min'),
    ...overrides,
  };
}

function buildLowEffortRow(overrides: Partial<ViewRow> = {}): ViewRow {
  return buildViewRow({
    name: 'gpt-5.6-luna, low',
    effort: 'low',
    cost: knownMeasure(0.02, '$0.0200'),
    elapsed: knownMeasure(126_000, '2.1 min'),
    ...overrides,
  });
}

/** Two settings of one model, one attempt each, both passed: the high setting is slower and dearer. */
export function buildSummaryView(overrides: Partial<SummaryTaskView> = {}): SummaryTaskView {
  return {
    task: 'Fix the login redirect',
    repository: 'acme/app',
    when: '2026-10-02 at 14:05 UTC',
    repeat: 1,
    requiredChecksPerAttempt: 6,
    separation: null,
    rows: [buildViewRow(), buildLowEffortRow()],
    ...overrides,
  };
}

const TIMED_OUT_CHECKS = { passed: 2, failed: 0, pending: 0, notRun: 4, total: 6 };

/** The low setting timed out, so only the high setting did the task. */
export function buildTimedOutView(): SummaryTaskView {
  return buildSummaryView({
    rows: [
      buildViewRow(),
      buildLowEffortRow({
        attempts: [buildViewAttempt({ outcome: 'failed', dropout: 'timed-out' })],
        requiredChecks: TIMED_OUT_CHECKS,
      }),
    ],
  });
}

/** The low setting has required checks still waiting for a verdict. */
export function buildPendingView(): SummaryTaskView {
  return buildSummaryView({
    rows: [
      buildViewRow(),
      buildLowEffortRow({
        attempts: [buildViewAttempt({ outcome: 'pending', dropout: 'waiting' })],
        requiredChecks: { passed: 5, failed: 0, pending: 1, notRun: 0, total: 6 },
      }),
    ],
  });
}

/** Both settings passed at the same displayed cost. */
export function buildCostTieView(): SummaryTaskView {
  return buildSummaryView({
    rows: [
      buildViewRow({ cost: knownMeasure(0.05004, '$0.0500') }),
      buildLowEffortRow({ cost: knownMeasure(0.05, '$0.0500') }),
    ],
  });
}

/** Both settings passed, but the low setting reported no cost. */
export function buildUnavailableCostView(): SummaryTaskView {
  return buildSummaryView({
    rows: [buildViewRow(), buildLowEffortRow({ cost: UNKNOWN_MEASURE })],
  });
}

/** Three attempts per setting; the low setting reported its cost for two of them. */
export function buildRepeatView(): SummaryTaskView {
  const attempts = [buildViewAttempt(), buildViewAttempt(), buildViewAttempt()];
  const checks = { passed: 18, failed: 0, pending: 0, notRun: 0, total: 18 };
  return buildSummaryView({
    repeat: 3,
    rows: [
      buildViewRow({
        attempts,
        requiredChecks: checks,
        cost: knownMeasure(0.08, '$0.0800', 3),
        elapsed: knownMeasure(378_000, '6.3 min', 3),
      }),
      buildLowEffortRow({
        attempts,
        requiredChecks: checks,
        cost: knownMeasure(0.02, '$0.0200', 2),
        elapsed: knownMeasure(126_000, '2.1 min', 3),
      }),
    ],
  });
}

export function buildSummarySetting(overrides: Partial<SummarySetting> = {}): SummarySetting {
  return {
    name: 'gpt-5.6-luna, high',
    model: 'gpt-5.6-luna',
    effort: 'high',
    planned: 1,
    outcomes: { passed: 1, failed: 0, pending: 0, notEvaluated: 0 },
    requiredChecks: { passed: 6, failed: 0, pending: 0, notRun: 0, total: 6 },
    didTask: true,
    cost: knownMeasure(0.08, '$0.0800'),
    elapsed: knownMeasure(378_000, '6.3 min'),
    dropout: null,
    ...overrides,
  };
}

/** The facts of the worked example: both settings passed, and the low setting was cheapest and fastest. */
export function buildSummaryFacts(overrides: Partial<SummaryFacts> = {}): SummaryFacts {
  return {
    task: 'Fix the login redirect',
    repository: 'acme/app',
    when: '2026-10-02 at 14:05 UTC',
    repeat: 1,
    requiredChecksPerAttempt: 6,
    settings: [
      buildSummarySetting(),
      buildSummarySetting({
        name: 'gpt-5.6-luna, low',
        effort: 'low',
        cost: knownMeasure(0.02, '$0.0200'),
        elapsed: knownMeasure(126_000, '2.1 min'),
      }),
    ],
    separation: 'passed',
    cost: {
      kind: 'leader',
      leaders: ['gpt-5.6-luna, low'],
      value: '$0.0200',
      next: { value: '$0.0800', margin: { kind: 'times', value: '4' } },
      unknown: [],
      partial: [],
    },
    speed: {
      kind: 'leader',
      leaders: ['gpt-5.6-luna, low'],
      value: '2.1 min',
      next: { value: '6.3 min', margin: { kind: 'times', value: '3' } },
      unknown: [],
      partial: [],
    },
    ...overrides,
  };
}

/** Evidence for `facts`, with identifiers a reply must not repeat and no grader rationale. */
export function buildSummaryEvidenceRecord(
  facts: SummaryFacts = buildSummaryFacts(),
  overrides: Partial<SummaryEvidence> = {},
): SummaryEvidence {
  return {
    taskId: 'fix-login',
    facts,
    rationales: [],
    displayModels: [...new Set(facts.settings.map((setting) => setting.model))],
    identifiers: [
      'fix-login--m-high--1',
      'fix-login--m-low--1',
      'fix-login',
      'm-high',
      'm-low',
      'repo-main',
      'redirect-check',
    ],
    ...overrides,
  };
}

/** A summary call whose reply was accepted, with every metric reported. */
export function buildSummaryCall(overrides: Partial<SummaryCall> = {}): SummaryCall {
  return {
    model: { model: 'openai/summary-model', effort: 'medium', agent: 'opencode' },
    outcome: { status: 'accepted', reply: '{}' },
    metrics: buildAgentMetrics(),
    ...overrides,
  };
}
