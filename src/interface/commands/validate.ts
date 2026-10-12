/** `tevu validate`: loads the configuration and prints its validation findings. */

import {
  createLineWriters,
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
} from './shared';

export type ValidateOperations = ConfigOperations & ConfigValidation;

export async function runValidate(
  operations: ValidateOperations,
  context: CommandContext,
  options: ConfigOptionValues,
): Promise<number> {
  const { out, err } = createLineWriters(context);
  const loaded = await loadCommandConfig(operations, options.config, out);
  if (!loaded.ok) {
    return reportFailure(err, loaded.error, context.redact);
  }
  const report = await operations.validateConfig(loaded.value.config);
  if (!report.ok) {
    return reportFailure(err, report.error, context.redact);
  }
  printFindings(out, report.value.findings);
  out(report.value.valid ? 'Configuration is valid.' : 'Configuration is invalid.');
  return report.value.valid ? EXIT_COMPLETED : EXIT_FAILURE;
}
