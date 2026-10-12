/** `tevu report`: regenerates a saved run's summary and report. */

import { createLineWriters, EXIT_COMPLETED, loadCommandConfig, reportFailure } from './shared';

import type {
  CommandContext,
  ConfigOperations,
  ConfigOptionValues,
  RunReportRebuild,
} from './shared';

export type ReportOperations = ConfigOperations & RunReportRebuild;

export async function runReport(
  operations: ReportOperations,
  context: CommandContext,
  runId: string,
  options: ConfigOptionValues,
): Promise<number> {
  const { out, err } = createLineWriters(context);
  const loaded = await loadCommandConfig(operations, options.config, out);
  if (!loaded.ok) {
    return reportFailure(err, loaded.error, context.redact);
  }
  const rebuilt = await operations.rebuildRunReport(loaded.value.config, runId, 'saved');
  if (!rebuilt.ok) {
    return reportFailure(err, rebuilt.error, context.redact);
  }
  out(`Summary regenerated: ${loaded.value.config.run.output_dir}/${runId}/summary.md`);
  out(`Report regenerated: ${loaded.value.config.run.output_dir}/${runId}/report.md`);
  return EXIT_COMPLETED;
}
