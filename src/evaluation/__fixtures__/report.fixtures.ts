import { unavailableAgentMetrics, unavailableBenchmarkMetrics } from '@/domain/types';

import type {
  CaseIdentity,
  CaseResult,
  CheckRecord,
  CheckResult,
  GradeRecord,
  GradingArtifact,
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

export function buildGradingArtifact(overrides: Partial<GradingArtifact> = {}): GradingArtifact {
  return {
    schemaVersion: 1,
    runId: FIXTURE_RUN_ID,
    caseId: 'task-1--m1--1',
    grader: { model: 'vendor/grader-model', effort: 'medium', agent: 'opencode' },
    call: { status: 'replied', reply: '{"grades":[]}' },
    metrics: unavailableAgentMetrics('not measured in this fixture'),
    grades: [],
    ...overrides,
  };
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
