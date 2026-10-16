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
import { unavailableAgentMetrics } from '@/domain/run-records';
import {
  buildGraderPrompt,
  deriveGrades,
  gradedChecksOf,
  pendingGrades,
  sumGraderCallMetrics,
} from '@/evaluation/grading';

import type { TaskDefinition, TevuConfig } from '@/domain/config';
import type { TevuError } from '@/domain/errors';
import type { ModelCallEvidence, ProviderSnapshot } from '@/domain/ports/agent';
import type { Redactor } from '@/domain/ports/secret-redactor';
import type { AgentMetrics, CaseGrading, GraderIdentity } from '@/domain/run-records';
import type { ModelCallDependencies } from '@/domain/use-cases';
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

/**
 * Outcome of one grading; cancellation carries no grading to persist.
 * `retainedDirectories` is present on every status and lists, in call order,
 * the call directory of each grader call whose removal failed.
 */
export type GradeCaseOutcome =
  | { status: 'graded'; grading: CaseGrading; retainedDirectories: readonly string[] }
  | { status: 'cancelled'; retainedDirectories: readonly string[] };

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
    retainedDirectories: [],
  };
}

/** Only a `ModelCallError` of cause `unfinished` or `tool-call` has a cause of its own. */
function noReplyCauseOf(error: TevuError): 'unfinished' | 'tool-call' | 'other' {
  return error.kind === 'ModelCallError' &&
    (error.cause === 'unfinished' || error.cause === 'tool-call')
    ? error.cause
    : 'other';
}

type GraderCall = CaseGrading['calls'][number];

/** The calls made before `latest`, in call order, followed by `latest`. */
function appendGraderCall(
  earlier: readonly GraderCall[],
  latest: GraderCall,
): [GraderCall, ...GraderCall[]] {
  const [head, ...tail] = earlier;
  return head === undefined ? [latest] : [head, ...tail, latest];
}

function sumCallMetrics(calls: readonly [GraderCall, ...GraderCall[]]): AgentMetrics {
  const [first, ...rest] = calls;
  return sumGraderCallMetrics([first.metrics, ...rest.map((call) => call.metrics)]);
}

/**
 * Grades every graded check of `request.task` through up to
 * {@link GRADER_CALL_LIMIT} redacted, error-safe model calls with one prompt.
 * Only a call whose model stopped before finishing its reply is made again;
 * a reply, a tool call, or any other failure ends the grading. A grading
 * without a reply leaves every graded check pending with the last call's
 * reason. Every call is recorded with the redacted records it left, and the
 * grading's metrics sum the calls'. Cancellation during any call returns
 * `{ status: 'cancelled' }` with no grading to persist, carrying the retained
 * directories of the calls made so far.
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

  let calls: GraderCall[] = [];
  const retainedDirectories: string[] = [];
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
    if (result.retainedDirectory !== null) {
      retainedDirectories.push(result.retainedDirectory);
    }
    const records = {
      events: evidence?.events ?? [],
      diagnostics: evidence?.diagnostics ?? '',
      session: evidence?.session?.export ?? null,
    };

    if (result.ok) {
      const gradedCalls = appendGraderCall(calls, {
        outcome: { status: 'replied' },
        metrics: result.value.metrics,
        ...records,
      });
      return {
        status: 'graded',
        grading: {
          grader,
          call: { status: 'replied', reply: result.value.text },
          calls: gradedCalls,
          metrics: sumCallMetrics(gradedCalls),
          grades: deriveGrades(result.value.text, checks),
        },
        retainedDirectories,
      };
    }

    if (result.error.kind === 'CancellationError') {
      return { status: 'cancelled', retainedDirectories };
    }
    const cause = noReplyCauseOf(result.error);
    const reason = `the grader call failed: ${describeModelCallFailure(result.error)}`;
    const madeCalls = appendGraderCall(calls, {
      outcome: { status: 'no-reply', cause, reason },
      metrics: evidence?.session?.metrics ?? unavailableAgentMetrics(reason),
      ...records,
    });
    if (cause !== 'unfinished' || madeCalls.length >= GRADER_CALL_LIMIT) {
      return {
        status: 'graded',
        grading: {
          grader,
          call: { status: 'no-reply', cause, reason },
          calls: madeCalls,
          metrics: sumCallMetrics(madeCalls),
          grades: pendingGrades(checks, reason),
        },
        retainedDirectories,
      };
    }
    calls = madeCalls;
  }
}
