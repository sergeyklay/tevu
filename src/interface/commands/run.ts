/** `tevu run`: prepares, validates, plans, and executes a benchmark, or prints the dry-run plan. */

import { agentNamesInUse } from '@/config/schema';
import { effortLabel } from '@/domain/types';
import { renderTevuError } from '@/interface/render-error';

import {
  createLineWriters,
  EXIT_CANCELLED,
  EXIT_COMPLETED,
  EXIT_FAILURE,
  loadCommandConfig,
  printFindings,
  reportFailure,
} from './shared';

import type {
  CommandContext,
  ConfigOperations,
  ConfigOptionValues,
  ConfigValidation,
  LineWriter,
  RunReportRebuild,
} from './shared';
import type {
  AgentCapabilityReport,
  BenchmarkPlan,
  CaseLifecycle,
  EffortChecks,
  RunResult,
  TaskDefinition,
  TevuConfig,
  TevuResult,
  ValidationFinding,
} from '@/domain/types';

/** Cancellation and observation hooks the run command hands to one benchmark execution. */
export type BenchmarkExecutionHooks = {
  cancellation: AbortSignal;
  onRunId?: (runId: string) => void;
  onLifecycle?: (caseId: string, lifecycle: CaseLifecycle) => void;
  onRetainedGradingDirectory?: (directory: string) => void;
};

export type RunOptionValues = ConfigOptionValues & { dryRun?: boolean; repeat?: number };

export type RunOperations = ConfigOperations &
  ConfigValidation &
  RunReportRebuild & {
    prepareRepositories(
      config: TevuConfig,
      onProgress: (line: string) => void,
    ): Promise<
      TevuResult<
        ValidationFinding[],
        'ManagedCloneError' | 'PrerequisiteError' | 'CancellationError'
      >
    >;
    planBenchmark(
      config: TevuConfig,
      configPath: string,
      efforts: EffortChecks,
      repeatOverride?: number,
    ): BenchmarkPlan;
    executeBenchmark(
      plan: BenchmarkPlan,
      hooks: BenchmarkExecutionHooks,
    ): Promise<
      TevuResult<
        RunResult,
        | 'PrerequisiteError'
        | 'SourceMaterializationError'
        | 'IsolationError'
        | 'AgentProcessError'
        | 'AgentProtocolError'
        | 'CaseTimeoutError'
        | 'EvaluationError'
        | 'ArtifactError'
        | 'CancellationError'
        | 'CheckStateError'
        | 'ConfigValidationError'
      >
    >;
  };

export async function runBenchmarkCommand(
  operations: RunOperations,
  context: CommandContext,
  options: RunOptionValues,
): Promise<number> {
  const { out, err } = createLineWriters(context);
  const loaded = await loadCommandConfig(operations, options.config, out);
  if (!loaded.ok) {
    return reportFailure(err, loaded.error, context.redact);
  }
  const prepared = await operations.prepareRepositories(loaded.value.config, out);
  if (!prepared.ok) {
    return reportFailure(err, prepared.error, context.redact);
  }
  for (const warning of prepared.value) {
    out(`warning ${warning.identifier}: ${warning.message}`);
  }
  const validation = await operations.validateConfig(loaded.value.config);
  if (!validation.ok) {
    return reportFailure(err, validation.error, context.redact);
  }
  printFindings(out, validation.value.findings);
  if (!validation.value.valid) {
    out('Configuration is invalid.');
    return EXIT_FAILURE;
  }
  const plan = operations.planBenchmark(
    loaded.value.config,
    loaded.value.configPath,
    validation.value.efforts,
    options.repeat,
  );
  if (options.dryRun === true) {
    printDryRun(out, plan, validation.value.capabilities);
    return EXIT_COMPLETED;
  }

  // Concurrent per-case progress is shown only on a TTY; non-TTY output stays
  // deterministic metadata: run ID, final case summary, findings, and paths.
  const showProgress = context.io.stdout.isTTY === true;
  const retainedGradingDirectories: string[] = [];
  const executed = await operations.executeBenchmark(plan, {
    cancellation: context.cancellation,
    onRunId: (runId) => {
      out(`Run ${runId} started.`);
    },
    onLifecycle: showProgress
      ? (caseId, lifecycle) => {
          out(`[${caseId}] ${lifecycle}`);
        }
      : undefined,
    onRetainedGradingDirectory: (directory) => {
      retainedGradingDirectories.push(directory);
    },
  });
  if (!executed.ok) {
    return reportFailure(err, executed.error, context.redact);
  }
  const run = executed.value;
  const runId = run.manifest.runId;
  const runDirectory = `${plan.artifactsDirectory}/${runId}`;
  if (run.exitCode === EXIT_CANCELLED) {
    // A cancelled run builds no report, so the report's findings cannot carry these warnings.
    for (const directory of retainedGradingDirectories) {
      out(
        `Warning: tevu could not delete the temporary directory of a grading call. The results are not affected. Delete ${directory} when no tevu command uses it.`,
      );
    }
    out(`Artifacts: ${runDirectory}`);
    out(
      `Run cancelled; partial artifacts were finalized. Regenerate the report with: tevu report ${runId}`,
    );
    return EXIT_CANCELLED;
  }
  const rebuilt = await operations.rebuildRunReport(loaded.value.config, runId, 'write');
  if (!rebuilt.ok) {
    out(`Artifacts: ${runDirectory}`);
    for (const line of renderTevuError(rebuilt.error, context.redact)) {
      err(line);
    }
    err(`The report could not be generated; recover with: tevu report ${runId}`);
    return EXIT_FAILURE;
  }
  const { report, retainedDirectories } = rebuilt.value;
  for (const line of [
    ...report.summary.attempts.flatMap((attempt) => attempt.lines),
    ...report.summary.findings,
    ...retainedDirectories.map(
      (directory) =>
        `Warning: tevu could not delete the temporary directory of a summary call. The results are not affected. Delete ${directory} when no tevu command uses it.`,
    ),
  ]) {
    out(line);
  }
  out(`Artifacts: ${runDirectory}`);
  out(`Summary: ${runDirectory}/summary.md`);
  out(`Report: ${runDirectory}/report.md`);
  return run.exitCode;
}

function printDryRun(
  out: LineWriter,
  plan: BenchmarkPlan,
  capabilities: Readonly<Record<string, AgentCapabilityReport>>,
): void {
  out('Dry run: no artifact, workspace, Jira call, or agent model session is created.');
  out(`Planned cases (${plan.cases.length}, execution order):`);
  for (const identity of plan.cases) {
    out(
      `  ${identity.caseId}: task ${identity.taskId}, model entry ${identity.modelId} (${identity.model}, effort ${effortLabel(identity.effort, plan.efforts.models[identity.modelId])}), commit ${identity.sourceCommit}, timeout ${identity.timeoutMs}ms`,
    );
  }
  out(
    `Manual assessments needed: ${countManualAssessments(plan)} (one tevu assess per case whose task has manual checks)`,
  );
  out(
    `Limits: concurrency ${plan.concurrency}, timeout ${plan.defaultCaseTimeoutMs}ms, stop grace ${plan.terminationGraceMs}ms`,
  );
  out(`Artifact destination: ${plan.artifactsDirectory}`);
  for (const name of agentNamesInUse(plan.config)) {
    printCapabilities(out, name, capabilities[name] ?? null);
  }
}

/** Counts `plan.cases` entries whose task declares at least one manual check in `checks.acceptance` or `checks.done`. */
function countManualAssessments(plan: BenchmarkPlan): number {
  const tasksById = new Map(plan.config.tasks.map((task) => [task.id, task]));
  let count = 0;
  for (const identity of plan.cases) {
    const task = tasksById.get(identity.taskId);
    if (task !== undefined && taskHasManualCheck(task)) {
      count += 1;
    }
  }
  return count;
}

/** Holds when a task declares at least one check with `manual: true`, required or optional. */
function taskHasManualCheck(task: TaskDefinition): boolean {
  return [...task.checks.acceptance, ...task.checks.done].some((check) => 'manual' in check);
}

function printCapabilities(
  out: LineWriter,
  name: string,
  report: AgentCapabilityReport | null,
): void {
  if (report === null) {
    out(`Agent "${name}" capabilities: not probed`);
    return;
  }
  out(
    `Agent "${name}" capabilities (${report.executable}, detected version: ${report.detectedVersion ?? 'not detected'}):`,
  );
  for (const capability of report.capabilities) {
    out(
      `  ${capability.name}${capability.required ? '' : ' (optional)'}: ${capability.availability}`,
    );
  }
  out(`  isolation deny-outside-worktree (optional): ${report.isolation.denyOutsideWorktree}`);
}
