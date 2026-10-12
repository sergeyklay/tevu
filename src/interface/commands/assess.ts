/** `tevu assess`: records verdicts for one case of a saved run through the assessment wizard. */

import { createStatusLine } from '@/interface/status-line';
import { runAssessmentWizard } from '@/interface/task-wizard';

import { createLineWriters, EXIT_COMPLETED, loadCommandConfig, reportFailure } from './shared';

import type { CommandContext, ConfigOperations, ConfigOptionValues } from './shared';
import type { AssessedCase, AssessmentCaseContext } from '@/application/assess';
import type { AssessmentInput, TevuConfig, TevuResult } from '@/domain/types';

export type AssessOperations = ConfigOperations & {
  readAssessmentContext(
    config: TevuConfig,
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AssessmentCaseContext, 'ConfigValidationError' | 'ArtifactError'>>;
  applyAssessment(
    config: TevuConfig,
    input: AssessmentInput,
  ): Promise<
    TevuResult<
      AssessedCase,
      'ConfigValidationError' | 'AssessmentConflictError' | 'ArtifactError' | 'CancellationError'
    >
  >;
};

export async function runAssess(
  operations: AssessOperations,
  context: CommandContext,
  runId: string,
  caseId: string,
  options: ConfigOptionValues,
): Promise<number> {
  const { out, err } = createLineWriters(context);
  const loaded = await loadCommandConfig(operations, options.config, out);
  if (!loaded.ok) {
    return reportFailure(err, loaded.error, context.redact);
  }
  const config = loaded.value.config;
  const wizard = await runAssessmentWizard(
    { runId, caseId },
    {
      io: {
        input: context.io.stdin,
        output: context.io.stdout,
        statusLine: createStatusLine(),
      },
      readCaseContext: () => operations.readAssessmentContext(config, runId, caseId),
      now: context.now,
      redact: context.redact,
    },
  );
  if (!wizard.ok) {
    return reportFailure(err, wizard.error, context.redact);
  }
  const applied = await operations.applyAssessment(config, {
    ...wizard.value,
    cancellation: context.cancellation,
  });
  if (!applied.ok) {
    return reportFailure(err, applied.error, context.redact);
  }
  out('Assessment recorded.');
  for (const line of applied.value.summary) {
    out(line);
  }
  out(`Report: ${config.run.output_dir}/${runId}/report.md`);
  return EXIT_COMPLETED;
}
