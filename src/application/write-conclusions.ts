/**
 * The summary call of one task, built on top of `callModelRole`. Saves the
 * model's conclusions when its reply passes the acceptance check, and the
 * template sentences otherwise. Never writes an artifact itself and never
 * returns an error result: a missing role, a redaction failure, a call error,
 * and a rejected reply each become a typed outcome, and a cancellation becomes
 * `{ status: 'cancelled' }`.
 *
 * Entry point: {@link writeTaskConclusions}.
 */

import { callModelRole, describeModelCallFailure } from '@/application/model-call';
import { durationMs } from '@/config/schema';
import { unavailableAgentMetrics } from '@/domain/types';
import { acceptConclusions, buildSummaryPrompt, templateConclusions } from '@/evaluation/summary';

import type {
  ConclusionTexts,
  ModelCallDependencies,
  ModelCallEvidence,
  ModelRoleCallConfig,
  Redactor,
  SummaryCall,
  TaskConclusions,
} from '@/domain/types';
import type { SummaryEvidence } from '@/evaluation/summary';

/** What the summary call of one task produced; a cancellation has nothing to save. */
export type TaskConclusionsOutcome =
  | { status: 'written'; conclusions: TaskConclusions; retainedDirectory: string | null }
  | { status: 'cancelled' };

/** Writes the conclusions of one task at the end of `tevu run`. */
export type ConclusionWriter = {
  write(evidence: SummaryEvidence): Promise<TaskConclusionsOutcome>;
};

const UNREDACTED_PROMPT_REASON =
  'the summary prompt could not be redacted; the summary model was not called';

/** Redacts `prompt`, or returns `undefined` when the injected redactor throws or returns no text. */
function redactPrompt(redact: Redactor, prompt: string): string | undefined {
  let redacted: string;
  try {
    redacted = redact(prompt);
  } catch {
    return undefined;
  }
  // The redactor is injected; a non-string result must fail closed.
  return typeof (redacted as unknown) === 'string' ? redacted : undefined;
}

/**
 * Writes the conclusions of one task: the template sentences without a
 * `roles.summary`, and with one, the sentences of a single redacted model call
 * when they pass {@link acceptConclusions}, else the template sentences with
 * the reason saved. The call is made once, within `run.timeout`, and never
 * again after a failure.
 */
export async function writeTaskConclusions(
  request: {
    config: ModelRoleCallConfig;
    evidence: SummaryEvidence;
    redact: Redactor;
    cancellation: AbortSignal;
  },
  dependencies: ModelCallDependencies,
): Promise<TaskConclusionsOutcome> {
  const { config, evidence } = request;
  const template = templateConclusions(evidence.facts);
  const model = config.roles?.summary;
  if (model === undefined) {
    return written(evidence, template, null);
  }
  const noReply = (reason: string, metrics: SummaryCall['metrics']): SummaryCall => ({
    model,
    outcome: { status: 'no-reply', reason },
    metrics,
  });

  const prompt = redactPrompt(request.redact, buildSummaryPrompt(evidence));
  if (prompt === undefined) {
    return written(
      evidence,
      template,
      noReply(UNREDACTED_PROMPT_REASON, unavailableAgentMetrics(UNREDACTED_PROMPT_REASON)),
    );
  }

  let delivered: ModelCallEvidence | undefined;
  const result = await callModelRole(
    {
      config,
      role: 'summary',
      prompt,
      timeoutMs: durationMs(config.run.timeout),
      cancellation: request.cancellation,
      onEvidence: (evidenceOfCall) => {
        delivered = evidenceOfCall;
      },
    },
    dependencies,
  );

  if (!result.ok) {
    if (result.error.kind === 'CancellationError') {
      return { status: 'cancelled' };
    }
    const reason = `the summary call failed: ${describeModelCallFailure(result.error)}`;
    return written(
      evidence,
      template,
      noReply(reason, delivered?.session?.metrics ?? unavailableAgentMetrics(reason)),
    );
  }

  const { text, metrics, retainedDirectory } = result.value;
  const check = acceptConclusions(text, evidence);
  return check.accepted
    ? written(
        evidence,
        check.conclusions,
        { model, outcome: { status: 'accepted', reply: text }, metrics },
        retainedDirectory,
      )
    : written(
        evidence,
        template,
        { model, outcome: { status: 'rejected', reply: text, reason: check.reason }, metrics },
        retainedDirectory,
      );
}

function written(
  evidence: SummaryEvidence,
  conclusions: ConclusionTexts,
  call: SummaryCall | null,
  retainedDirectory: string | null = null,
): TaskConclusionsOutcome {
  return {
    status: 'written',
    conclusions: { taskId: evidence.taskId, facts: evidence.facts, conclusions, call },
    retainedDirectory,
  };
}
