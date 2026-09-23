import type { CheckDefinition, CommandEvaluator, TaskDefinition } from "../config/schema.ts";
import type {
  CaseWorkspace,
  CheckResult,
  EvaluatorProcessAdapter,
  EvaluatorProcessRequest,
  EvaluatorProcessResult,
  IsolatedEnvironment,
  ParentEnvironmentSnapshot,
  RedactedCapture,
  TevuResult,
} from "../domain/types.ts";

/** Redaction boundary applied to evidence before it leaves this module. */
export type Redactor = (text: string) => string;

/** One configured check paired with the collection it came from. */
export type OrderedCheck = {
  definition: CheckDefinition;
  category: "acceptance" | "definition-of-done";
};

/** Everything check evaluation needs; all effects arrive through the process adapter. */
export type CheckEvaluationInput = {
  caseId: string;
  checks: readonly OrderedCheck[];
  workspace: CaseWorkspace;
  environment: IsolatedEnvironment;
  snapshot: ParentEnvironmentSnapshot;
  terminationGraceMs: number;
  processes: EvaluatorProcessAdapter;
  redact: Redactor;
  /** Optional cancellation; the active evaluator is interrupted and later checks do not start. */
  cancellation?: AbortSignal;
};

/** Environment names fixed by the evaluator base-environment contract. */
const FIXED_ENVIRONMENT_NAMES = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI"]);

function isFixedEnvironmentName(name: string): boolean {
  return FIXED_ENVIRONMENT_NAMES.has(name) || name.startsWith("XDG_");
}

/** Projects a task's checks into evaluation order: acceptance criteria, then Definition of Done. */
export function orderTaskChecks(
  task: Pick<TaskDefinition, "acceptanceCriteria" | "definitionOfDone">,
): OrderedCheck[] {
  return [
    ...task.acceptanceCriteria.map(
      (definition): OrderedCheck => ({ definition, category: "acceptance" }),
    ),
    ...task.definitionOfDone.map(
      (definition): OrderedCheck => ({ definition, category: "definition-of-done" }),
    ),
  ];
}

/**
 * Builds one check's process environment: the complete fixed evaluator base
 * from the isolated environment plus only the check's allowlisted ordinary
 * snapshot values. Allowlisted additions never replace fixed or base variables.
 */
export function buildCheckEnvironment(
  environment: IsolatedEnvironment,
  snapshot: ParentEnvironmentSnapshot,
  allowlist: readonly string[],
): Record<string, string> {
  const variables: Record<string, string> = { ...environment.variables };
  for (const name of allowlist) {
    if (isFixedEnvironmentName(name) || name in variables) {
      continue;
    }
    const value = snapshot.ordinaryEvaluatorValues[name];
    if (value !== undefined) {
      variables[name] = value;
    }
  }
  return variables;
}

/** Projects a manual check as pending until `tevu assess` records a verdict. */
export function projectManualCheck(check: OrderedCheck): CheckResult {
  return {
    checkId: check.definition.id,
    category: check.category,
    verdict: "pending",
    evidence: "awaiting manual assessment",
    durationMs: null,
  };
}

/**
 * Evaluates a task's checks sequentially in declared order with the case
 * worktree as cwd. Command launch failure, timeout, signal, or an undeclared
 * exit code produces a failed check with evidence rather than an error.
 * Cancellation stops before the next check; checks that never started are
 * omitted from the results.
 */
export async function evaluateChecks(
  input: CheckEvaluationInput,
): Promise<TevuResult<CheckResult[], "EvaluationError">> {
  const results: CheckResult[] = [];
  for (const check of input.checks) {
    if (input.cancellation?.aborted === true) {
      break;
    }
    if (check.definition.evaluator.kind === "manual") {
      results.push(projectManualCheck(check));
      continue;
    }
    results.push(await runCommandCheck(input, check, check.definition.evaluator));
  }
  return { ok: true, value: results };
}

/**
 * Reduces final check verdicts to the case's acceptance outcome. A failed
 * required check fails the case; an unresolved required check leaves it
 * pending; optional verdicts never change a passed outcome.
 */
export function reduceRequiredOutcome(
  checks: readonly OrderedCheck[],
  results: readonly CheckResult[],
): "passed" | "failed" | "pending" {
  const unresolvedRequired = new Set(
    checks.filter((check) => check.definition.required).map((check) => check.definition.id),
  );
  let pending = false;
  for (const result of results) {
    if (!unresolvedRequired.has(result.checkId)) {
      continue;
    }
    if (result.verdict === "failed") {
      return "failed";
    }
    if (result.verdict !== "passed") {
      pending = true;
    }
    unresolvedRequired.delete(result.checkId);
  }
  return pending || unresolvedRequired.size > 0 ? "pending" : "passed";
}

async function runCommandCheck(
  input: CheckEvaluationInput,
  check: OrderedCheck,
  evaluator: CommandEvaluator,
): Promise<CheckResult> {
  const request: EvaluatorProcessRequest = {
    argv: evaluator.argv,
    cwd: input.workspace.worktreeDirectory,
    environment: buildCheckEnvironment(input.environment, input.snapshot, evaluator.environmentAllowlist),
    timeoutMs: evaluator.timeoutMs,
    terminationGraceMs: input.terminationGraceMs,
    cancellation: input.cancellation,
  };

  let execution: EvaluatorProcessResult;
  try {
    execution = await input.processes.run(request);
  } catch (cause) {
    execution = {
      launched: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }

  if (!execution.launched) {
    return {
      checkId: check.definition.id,
      category: check.category,
      verdict: "failed",
      evidence: input.redact(`launch failed: ${execution.reason}`),
      durationMs: null,
    };
  }

  const passed =
    !execution.timedOut &&
    execution.exitCode !== null &&
    evaluator.successExitCodes.includes(execution.exitCode);

  const statusLine = execution.timedOut
    ? `timed out after ${evaluator.timeoutMs}ms (termination: ${execution.terminationStage})`
    : execution.exitCode !== null
      ? `exit code ${execution.exitCode}${passed ? "" : " (not a declared success exit code)"}`
      : `terminated by signal ${execution.signal ?? "unknown"}`;

  const evidence = [
    statusLine,
    describeCapture("stdout", execution.stdout),
    describeCapture("stderr", execution.stderr),
  ].join("\n");

  return {
    checkId: check.definition.id,
    category: check.category,
    verdict: passed ? "passed" : "failed",
    evidence: input.redact(evidence),
    durationMs: execution.durationMs,
  };
}

function describeCapture(stream: string, capture: RedactedCapture): string {
  const size = `${capture.totalBytes} bytes${capture.truncated ? ", truncated" : ""}`;
  return capture.text.length === 0 ? `${stream} (${size})` : `${stream} (${size}): ${capture.text}`;
}
