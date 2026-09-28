/**
 * One-shot grading call for a case's graded checks, built on top of
 * `callModelRole`. Grades every graded check of a task in one call, never
 * writes an artifact itself, and never returns an error result: a redaction
 * failure, a call error, or cancellation each become a typed outcome instead.
 *
 * Entry point: {@link gradeCase}.
 */

import { callModelRole } from '@/application/model-call';
import { unavailableAgentMetrics } from '@/domain/types';
import {
  buildGraderPrompt,
  deriveGrades,
  gradedChecksOf,
  pendingGrades,
} from '@/evaluation/grading';

import type {
  CaseGrading,
  ModelCallDependencies,
  Redactor,
  TaskDefinition,
  TevuConfig,
  TevuError,
} from '@/domain/types';

/** Everything one grading call needs; `patch` is the case's captured solution patch. */
export type GradeCaseRequest = {
  config: TevuConfig;
  task: TaskDefinition;
  patch: string;
  timeoutMs: number;
  redact: Redactor;
  cancellation: AbortSignal;
};

/** Outcome of one grading call; cancellation carries no grading to persist. */
export type GradeCaseOutcome =
  | { status: 'graded'; grading: CaseGrading; retainedDirectory: string | null }
  | { status: 'cancelled' };

/** Identifier-only text for a grader call failure; never includes a secret value. */
export function describeGraderCallFailure(
  error: Extract<
    TevuError,
    {
      kind:
        | 'ModelCallError'
        | 'AgentProtocolError'
        | 'PrerequisiteError'
        | 'ArtifactError'
        | 'ConfigValidationError';
    }
  >,
): string {
  switch (error.kind) {
    case 'ModelCallError':
      return `ModelCallError (${error.cause}): ${error.reason}`;
    case 'AgentProtocolError':
      return `AgentProtocolError: ${error.reason}`;
    case 'PrerequisiteError':
      return `PrerequisiteError: "${error.tool}" expected ${error.expected}${
        error.actual === undefined ? '' : `, actual ${error.actual}`
      }`;
    case 'ArtifactError':
      return `ArtifactError: ${error.operation}: ${error.reason}`;
    case 'ConfigValidationError': {
      const [first] = error.findings;
      return first === undefined
        ? 'ConfigValidationError: no finding was reported'
        : `ConfigValidationError: ${first.identifier}: ${first.message}`;
    }
  }
}

/**
 * Resolves the declared grader role and the task's graded checks.
 *
 * @throws when `config.roles.grader` is undeclared or the task declares no
 * graded check; callers only invoke {@link gradeCase} after confirming both,
 * the same precondition `requireCaseAgentAdapter` documents for its own case.
 */
function requireGraderRole(config: TevuConfig, task: TaskDefinition) {
  const grader = config.roles?.grader;
  const checks = gradedChecksOf(task);
  if (grader === undefined || checks.length === 0) {
    throw new Error(
      `unreachable: gradeCase requires config.roles.grader declared and task "${task.id}" to declare a graded check`,
    );
  }
  return { grader, checks };
}

/**
 * Grades every graded check of `request.task` in one redacted, error-safe
 * model call: a prompt-redaction failure or any non-cancellation call error
 * leaves every graded check pending with the failure's reason, and every
 * grader metric unavailable with that same reason; cancellation during the
 * call returns `{ status: 'cancelled' }` with nothing to persist.
 */
export async function gradeCase(
  request: GradeCaseRequest,
  dependencies: ModelCallDependencies,
): Promise<GradeCaseOutcome> {
  const { grader, checks } = requireGraderRole(request.config, request.task);

  const noReply = (reason: string): GradeCaseOutcome => ({
    status: 'graded',
    grading: {
      grader,
      call: { status: 'no-reply', reason },
      metrics: unavailableAgentMetrics(reason),
      grades: pendingGrades(checks, reason),
    },
    retainedDirectory: null,
  });

  const prompt = buildGraderPrompt({
    prompt: request.task.prompt,
    description: request.task.description,
    checks,
    patch: request.patch,
  });

  let redacted: string;
  try {
    redacted = request.redact(prompt);
  } catch {
    return noReply('the grader prompt could not be redacted; the grader was not called');
  }
  // The redactor is injected; a non-string result must fail closed.
  if (typeof (redacted as unknown) !== 'string') {
    return noReply('the grader prompt could not be redacted; the grader was not called');
  }

  const result = await callModelRole(
    {
      config: request.config,
      role: 'grader',
      prompt: redacted,
      timeoutMs: request.timeoutMs,
      cancellation: request.cancellation,
    },
    dependencies,
  );
  if (!result.ok) {
    if (result.error.kind === 'CancellationError') {
      return { status: 'cancelled' };
    }
    return noReply(`the grader call failed: ${describeGraderCallFailure(result.error)}`);
  }
  return {
    status: 'graded',
    grading: {
      grader,
      call: { status: 'replied', reply: result.value.text },
      metrics: result.value.metrics,
      grades: deriveGrades(result.value.text, checks),
    },
    retainedDirectory: result.value.retainedDirectory,
  };
}
