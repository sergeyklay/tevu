/**
 * Grading of a case's graded checks, built on top of `callModelRole`. Grades
 * every graded check of a task from one reply, calling the grader again only
 * when its model stopped before finishing, up to a fixed number of calls.
 * Never writes an artifact itself and never returns an error result: a
 * redaction failure, a call error, or cancellation each become a typed
 * outcome instead.
 *
 * Entry point: {@link gradeCase}.
 */

import { callModelRole, describeModelCallFailure } from '@/application/model-call';
import { unavailableAgentMetrics } from '@/domain/types';
import {
  buildGraderPrompt,
  deriveGrades,
  gradedChecksOf,
  pendingGrades,
  sumGraderCallMetrics,
} from '@/evaluation/grading';

import type {
  AgentMetrics,
  CaseGrading,
  GraderIdentity,
  ModelCallDependencies,
  ModelCallEvidence,
  ProviderSnapshot,
  Redactor,
  TaskDefinition,
  TevuConfig,
  TevuError,
} from '@/domain/types';
import type { GradedCheckSummary } from '@/evaluation/grading';

/** Everything one grading call needs; `patch` is the case's captured solution patch. */
export type GradeCaseRequest = {
  config: TevuConfig;
  task: TaskDefinition;
  patch: string;
  timeoutMs: number;
  redact: Redactor;
  cancellation: AbortSignal;
  /** The run's snapshot of the grader agent's providers. */
  providers: ProviderSnapshot;
};

/** Outcome of one grading call; cancellation carries no grading to persist. */
export type GradeCaseOutcome =
  | { status: 'graded'; grading: CaseGrading; retainedDirectory: string | null }
  | { status: 'cancelled' };

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

/** A grader call that fails with cause `unfinished` is made again until this many calls ran. */
const GRADER_CALL_LIMIT = 3;

function unredactedPromptOutcome(
  grader: GraderIdentity,
  checks: readonly GradedCheckSummary[],
): GradeCaseOutcome {
  const reason = 'the grader prompt could not be redacted; the grader was not called';
  return {
    status: 'graded',
    grading: {
      grader,
      call: { status: 'no-reply', cause: 'other', reason },
      calls: [],
      metrics: unavailableAgentMetrics(reason),
      grades: pendingGrades(checks, reason),
    },
    retainedDirectory: null,
  };
}

/** Only a `ModelCallError` of cause `unfinished` or `tool-call` has a cause of its own. */
function noReplyCauseOf(error: TevuError): 'unfinished' | 'tool-call' | 'other' {
  return error.kind === 'ModelCallError' &&
    (error.cause === 'unfinished' || error.cause === 'tool-call')
    ? error.cause
    : 'other';
}

/** `calls` is never empty where this runs: every exit of the call loop follows a push. */
function sumCallMetrics(calls: CaseGrading['calls']): AgentMetrics {
  const [first, ...rest] = calls.map((call) => call.metrics);
  return sumGraderCallMetrics([first, ...rest]);
}

/**
 * Grades every graded check of `request.task` through up to
 * {@link GRADER_CALL_LIMIT} redacted, error-safe model calls with one prompt.
 * Only a call whose model stopped before finishing its reply is made again;
 * a reply, a tool call, or any other failure ends the grading. A grading
 * without a reply leaves every graded check pending with the last call's
 * reason. Every call is recorded with the redacted records it left, and the
 * grading's metrics sum the calls'. Cancellation during any call returns
 * `{ status: 'cancelled' }` with nothing to persist.
 */
export async function gradeCase(
  request: GradeCaseRequest,
  dependencies: ModelCallDependencies,
): Promise<GradeCaseOutcome> {
  const { grader, checks } = requireGraderRole(request.config, request.task);

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
    return unredactedPromptOutcome(grader, checks);
  }
  // The redactor is injected; a non-string result must fail closed.
  if (typeof (redacted as unknown) !== 'string') {
    return unredactedPromptOutcome(grader, checks);
  }

  const calls: CaseGrading['calls'] = [];
  for (;;) {
    let evidence: ModelCallEvidence | undefined;
    const result = await callModelRole(
      {
        config: request.config,
        role: 'grader',
        prompt: redacted,
        timeoutMs: request.timeoutMs,
        cancellation: request.cancellation,
        providers: request.providers,
        onEvidence: (delivered) => {
          evidence = delivered;
        },
      },
      dependencies,
    );
    const records = {
      events: evidence?.events ?? [],
      diagnostics: evidence?.diagnostics ?? '',
      session: evidence?.session?.export ?? null,
    };

    if (result.ok) {
      calls.push({ outcome: { status: 'replied' }, metrics: result.value.metrics, ...records });
      return {
        status: 'graded',
        grading: {
          grader,
          call: { status: 'replied', reply: result.value.text },
          calls,
          metrics: sumCallMetrics(calls),
          grades: deriveGrades(result.value.text, checks),
        },
        retainedDirectory: result.value.retainedDirectory,
      };
    }

    if (result.error.kind === 'CancellationError') {
      return { status: 'cancelled' };
    }
    const cause = noReplyCauseOf(result.error);
    const reason = `the grader call failed: ${describeModelCallFailure(result.error)}`;
    calls.push({
      outcome: { status: 'no-reply', cause, reason },
      metrics: evidence?.session?.metrics ?? unavailableAgentMetrics(reason),
      ...records,
    });
    if (cause !== 'unfinished' || calls.length >= GRADER_CALL_LIMIT) {
      return {
        status: 'graded',
        grading: {
          grader,
          call: { status: 'no-reply', cause, reason },
          calls,
          metrics: sumCallMetrics(calls),
          grades: pendingGrades(checks, reason),
        },
        retainedDirectory: null,
      };
    }
  }
}
