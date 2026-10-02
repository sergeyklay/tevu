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
  TaskRecord,
  TevuError,
} from '@/domain/types';

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
