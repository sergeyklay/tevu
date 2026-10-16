/**
 * Check questions of the task wizard.
 */

import { log } from '@clack/prompts';

import { deriveCheckId } from '@/interface/derived-identifiers';
import {
  askConfirm,
  askDefaultedText,
  askSelect,
  askText,
  promptOptions,
} from '@/interface/wizard-questions';
import {
  splitNames,
  validateDuration,
  validateExitCodes,
  validateNonWhitespace,
} from '@/interface/wizard-validators';

import type { CheckInput } from '@/config/schema';
import type { WizardIo } from '@/interface/wizard-questions';
import type { TextValidator } from '@/interface/wizard-validators';

/**
 * Collects one check collection until it contains at least one required
 * check.
 *
 * Starts from a copy of `drafted`; when it is non-empty, asks whether to add
 * another check of this collection before entering today's loop, so an
 * accepted draft with no further checks needs no additional question.
 */
export async function interviewChecks(
  io: WizardIo,
  collection: 'acceptance' | 'done',
  validateCheckVariables: TextValidator,
  checkTimeout: string | undefined,
  drafted: CheckInput[] = [],
): Promise<CheckInput[]> {
  const checks: CheckInput[] = [...drafted];
  const collectionName = collection === 'acceptance' ? 'acceptance' : 'Definition of Done';
  const addAnotherQuestion = `Add another ${collectionName} check?`;
  if (drafted.length > 0) {
    const wantsMore = await askConfirm(io, {
      message: addAnotherQuestion,
      initialValue: false,
    });
    if (!wantsMore) {
      return checks;
    }
  }
  for (;;) {
    const id = deriveCheckId(collection, checks.length + 1);
    const kind = await askSelect<'graded' | 'command' | 'manual'>(io, {
      message: 'Check type',
      options: [
        { value: 'graded', label: 'Graded by a model' },
        { value: 'command', label: 'Command' },
        { value: 'manual', label: 'Manual' },
      ],
      initialValue: 'graded',
    });
    const description =
      kind === 'graded'
        ? await askText(io, { message: 'Criterion', validate: validateNonWhitespace })
        : await askDefaultedText(io, {
            message: 'Description',
            defaultValue: '',
            placeholder: 'none',
          });
    const required = await askConfirm(io, { message: 'Required?', initialValue: true });
    const check: CheckInput =
      kind === 'manual'
        ? { id, description, manual: true, ...(required ? {} : { required }) }
        : kind === 'graded'
          ? { id, description, ...(required ? {} : { required }) }
          : {
              id,
              description,
              ...(await interviewCommandEvaluator(io, validateCheckVariables, checkTimeout)),
              ...(required ? {} : { required }),
            };
    checks.push(check);
    if (!checks.some((candidate) => candidate.required !== false)) {
      log.info(`At least one required ${collection} check is needed.`, promptOptions(io));
      continue;
    }
    const wantsMore = await askConfirm(io, {
      message: addAnotherQuestion,
      initialValue: false,
    });
    if (!wantsMore) {
      return checks;
    }
  }
}

/**
 * Asks the command line, time limit, exit codes, and variable list of one
 * command check. The command line is saved as typed. Without a
 * `run.check_timeout` to inherit, the time limit is required.
 */
async function interviewCommandEvaluator(
  io: WizardIo,
  validateCheckVariables: TextValidator,
  checkTimeout: string | undefined,
): Promise<Pick<CheckInput, 'run' | 'timeout' | 'exit_codes' | 'env'>> {
  const run = await askText(io, { message: 'Command', validate: validateNonWhitespace });
  const timeoutRaw =
    checkTimeout === undefined
      ? await askText(io, { message: 'Time limit', validate: validateDuration })
      : await askDefaultedText(io, {
          message: 'Time limit',
          defaultValue: '',
          placeholder: checkTimeout,
          validate: validateDuration,
        });
  const codesText = await askDefaultedText(io, {
    message: 'Passing exit codes',
    defaultValue: '0',
    validate: validateExitCodes,
  });
  const exitCodes = codesText
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => Number.parseInt(token, 10));
  const envText = await askDefaultedText(io, {
    message: 'Check variables',
    defaultValue: '',
    placeholder: 'none',
    validate: validateCheckVariables,
  });
  const env = splitNames(envText);
  return {
    run,
    ...(timeoutRaw.trim().length === 0 ? {} : { timeout: timeoutRaw.trim() }),
    ...(exitCodes.length === 1 && exitCodes[0] === 0 ? {} : { exit_codes: exitCodes }),
    ...(env.length === 0 ? {} : { env }),
  };
}
