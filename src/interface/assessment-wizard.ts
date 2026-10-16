/**
 * Interactive Clack wizard for `tevu assess`.
 *
 * The wizard requires an interactive TTY on stdin and stdout and asks one
 * question at a time with local re-prompting on invalid input. It returns its
 * typed input and the caller owns the write. Every effect (assessment context
 * read, wall clock, redaction) is an injected callback, so no concrete
 * adapter, filesystem, Git, or Jira transport enters this module.
 *
 * Entry point: {@link runAssessmentWizard}.
 */

import { intro, log, note } from '@clack/prompts';

import {
  askConfirm,
  askSelect,
  askText,
  cancellationFailure,
  configValidationFailure,
  promptOptions,
  requireInteractiveTty,
  WizardCancelledError,
} from './wizard-questions';
import { validateNonWhitespace } from './wizard-validators';

import type { WizardIo } from './wizard-questions';
import type { AssessableCheckSummary, AssessmentCaseContext } from '@/application/assess';
import type { TevuResult } from '@/domain/errors';
import type { AssessmentRecord } from '@/domain/run-records';
import type { AssessmentDecision, AssessmentInput } from '@/domain/use-cases';

/** Command-line facts the assessment wizard starts from. */
export type AssessmentWizardRequest = {
  runId: string;
  caseId: string;
};

/** Injected effects for the assessment wizard; it performs no write itself. */
export type AssessmentWizardDependencies = {
  io: WizardIo;
  /** Reads the case's manual checks and current assessment records from preserved artifacts. */
  readCaseContext: () => Promise<
    TevuResult<AssessmentCaseContext, 'ConfigValidationError' | 'ArtifactError'>
  >;
  now: () => Date;
  redact: (textContent: string) => string;
};

/** Error kinds the assessment wizard can return. */
type AssessmentWizardErrorKind =
  'ConfigValidationError' | 'ArtifactError' | 'PrerequisiteError' | 'CancellationError';

/**
 * Runs the `tevu assess` interview and returns the typed assessment input.
 *
 * Fails before any question when stdin or stdout is not a TTY or when the case
 * context cannot be read. Existing assessments are displayed and skipped
 * unless the assessor selects replacement and then confirms each replacement
 * individually; every pending required and optional manual check is processed
 * in configuration order. The UTC `assessedAt` timestamp comes from the
 * injected clock; the caller delegates the single write to `assessCase`.
 */
export async function runAssessmentWizard(
  request: AssessmentWizardRequest,
  dependencies: AssessmentWizardDependencies,
): Promise<TevuResult<AssessmentInput, AssessmentWizardErrorKind>> {
  const ttyFailure = requireInteractiveTty(dependencies.io);
  if (ttyFailure !== null) {
    return ttyFailure;
  }
  const context = await dependencies.readCaseContext();
  if (!context.ok) {
    return context;
  }
  if (context.value.checks.length === 0) {
    return configValidationFailure([
      {
        severity: 'error',
        identifier: request.caseId,
        message: `case "${request.caseId}" has no manual or graded checks; there is nothing to assess`,
      },
    ]);
  }
  const io = dependencies.io;
  const redact = dependencies.redact;
  intro(`tevu assess ${request.runId} ${request.caseId}`, promptOptions(io));
  log.info(redact(`Assessing ${context.value.caseName}.`), promptOptions(io));
  try {
    const currentByCheck = new Map(
      context.value.existing.map((record) => [record.checkId, record]),
    );
    const namesByCheck = new Map(context.value.checks.map((check) => [check.checkId, check.name]));
    const renderRecord = (record: AssessmentRecord): string =>
      renderAssessmentRecord(record, namesByCheck.get(record.checkId) ?? record.checkId);
    if (context.value.existing.length > 0) {
      note(
        redact(context.value.existing.map(renderRecord).join('\n')),
        'Existing assessments',
        promptOptions(io),
      );
    }
    const assessor = await askText(io, {
      message: 'Assessor name',
      validate: validateNonWhitespace,
    });
    const decisions: AssessmentDecision[] = [];
    for (const check of context.value.checks) {
      log.step(redact(renderAssessableCheck(check)), promptOptions(io));
      const existingRecord = currentByCheck.get(check.checkId);
      if (existingRecord !== undefined) {
        log.info(redact(renderRecord(existingRecord)), promptOptions(io));
        const wantsReplacement = await askConfirm(io, {
          message: 'Replace the existing assessment of this check?',
          initialValue: false,
        });
        if (!wantsReplacement) {
          continue;
        }
        const verdict = await askVerdict(io);
        const noteText = await askNote(io, verdict);
        const confirmed = await askConfirm(io, {
          message: `Confirm replacing the verdict of this check (${existingRecord.verdict} -> ${verdict})?`,
          initialValue: false,
        });
        if (!confirmed) {
          log.info('Kept the existing assessment.', promptOptions(io));
          continue;
        }
        decisions.push({
          checkId: check.checkId,
          verdict,
          assessor,
          note: noteText,
          replaceExisting: true,
        });
        continue;
      }

      if (check.evaluator === 'manual') {
        const verdict = await askVerdict(io);
        const noteText = await askNote(io, verdict);
        decisions.push({
          checkId: check.checkId,
          verdict,
          assessor,
          note: noteText,
          replaceExisting: false,
        });
        continue;
      }

      for (const line of check.gradeLines) {
        log.info(redact(line), promptOptions(io));
      }
      const grade = check.grade;
      if (grade === null) {
        const verdict = await askVerdict(io);
        const noteText = await askNote(io, verdict);
        decisions.push({
          checkId: check.checkId,
          verdict,
          assessor,
          note: noteText,
          replaceExisting: false,
        });
        continue;
      }
      if (grade.status === 'pending') {
        const verdict = await askVerdict(io);
        const noteText = await askNote(io, verdict);
        decisions.push({
          checkId: check.checkId,
          verdict,
          assessor,
          note: noteText,
          replaceExisting: false,
        });
        continue;
      }
      if (grade.verdict === 'undetermined') {
        const verdict = await askVerdict(io);
        const noteText = await askNote(io, verdict);
        decisions.push({
          checkId: check.checkId,
          verdict,
          assessor,
          note: noteText,
          replaceExisting: false,
        });
        continue;
      }
      const wantsReplacement = await askConfirm(io, {
        message: "Replace the grader's verdict for this check?",
        initialValue: false,
      });
      if (!wantsReplacement) {
        continue;
      }
      const verdict = await askVerdict(io);
      const noteText = await askNote(io, verdict);
      const confirmed = await askConfirm(io, {
        message: `Confirm replacing the grader's verdict for this check (${grade.verdict} -> ${verdict})?`,
        initialValue: false,
      });
      if (!confirmed) {
        log.info("Kept the grader's verdict.", promptOptions(io));
        continue;
      }
      decisions.push({
        checkId: check.checkId,
        verdict,
        assessor,
        note: noteText,
        replaceExisting: true,
      });
    }
    return {
      ok: true,
      value: {
        runId: request.runId,
        caseId: request.caseId,
        decisions,
        assessedAt: dependencies.now().toISOString(),
      },
    };
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      log.warn('Assessment cancelled; nothing was recorded.', promptOptions(io));
      return cancellationFailure();
    }
    throw error;
  }
}

function renderAssessableCheck(check: AssessableCheckSummary): string {
  const category = check.category === 'acceptance' ? 'acceptance' : 'Definition of Done';
  const requirement = check.required ? 'required' : 'optional';
  const kind = check.evaluator === 'grader' ? 'graded' : 'manual';
  return `${check.name} (${category}, ${requirement}, ${kind})`;
}

function renderAssessmentRecord(record: AssessmentRecord, checkName: string): string {
  const noteSuffix = record.note.length === 0 ? '' : `; note: ${record.note}`;
  return `${checkName}: ${record.verdict} by ${record.assessor} at ${record.assessedAt}${noteSuffix}`;
}

async function askVerdict(io: WizardIo): Promise<'passed' | 'failed'> {
  return askSelect<'passed' | 'failed'>(io, {
    message: 'Verdict',
    options: [
      { value: 'passed', label: 'passed' },
      { value: 'failed', label: 'failed' },
    ],
  });
}

async function askNote(io: WizardIo, verdict: 'passed' | 'failed'): Promise<string> {
  return askText(io, {
    message: verdict === 'failed' ? 'Note (required for a failed verdict)' : 'Note (optional)',
    defaultValue: '',
    ...(verdict === 'failed'
      ? {
          validate: (value: string | undefined) =>
            (value ?? '').trim().length === 0
              ? 'a failed verdict requires a non-empty note'
              : undefined,
        }
      : {}),
  });
}
