/**
 * Interactive Clack wizard for `tevu task add`.
 *
 * The wizard requires an interactive TTY on stdin and stdout, asks one
 * question at a time with local re-prompting on invalid input, and hands a
 * typed input to the application use case. It triggers the single write
 * itself through the injected `createTask` and retries it when it fails.
 * Every effect (configuration read, one-time issue import, task creation,
 * wall clock, redaction) is an injected callback, so no concrete adapter,
 * filesystem, Git, or Jira transport enters its modules.
 *
 * Entry point: {@link runTaskWizard}.
 */

import { styleText } from 'node:util';
import { cancel, intro, log } from '@clack/prompts';

import { referencedVariableName } from '@/config/schema';
import { deriveTaskId } from '@/interface/derived-identifiers';
import {
  askText,
  cancellationFailure,
  configValidationFailure,
  promptOptions,
  requireInteractiveTty,
  WizardCancelledError,
} from '@/interface/wizard-questions';
import { validateCheckVariableList, validateNonWhitespace } from '@/interface/wizard-validators';

import { askBaseCommitWithProposal, settleBaseCommit } from './base-commit';
import { interviewBootstrap } from './bootstrap';
import { interviewCriteria } from './criteria';
import { interviewReadiness } from './readiness';
import { interviewReferenceSolution } from './reference-solution';
import { selectTaskRepository } from './repositories';
import { reviewAndSave } from './review';
import { interviewSource } from './source';

import type { TaskWizardDependencies, TaskWizardRequest, WizardProgress } from './shared';
import type { TaskWizardInput } from '@/application/create-task';
import type { TaskInput, TevuConfigInput } from '@/config/schema';
import type { TaskDefinition, TevuConfig } from '@/domain/config';
import type { TevuResult } from '@/domain/errors';
import type { WizardIo } from '@/interface/wizard-questions';

/** Error kinds the task wizard can return. */
type TaskWizardErrorKind =
  | 'ConfigParseError'
  | 'ConfigValidationError'
  | 'ConfigReadError'
  | 'IssueImportError'
  | 'PrerequisiteError'
  | 'CancellationError';

/** What an exit loses: every answer so far, the criteria draft once one exists, and the file's fate. */
function describeExitLoss(
  progress: WizardProgress,
  configPath: string,
  isConfigFileMissing: boolean,
): string {
  const draft = progress.holdsCriteriaDraft ? ', including the criteria draft' : '';
  const file = isConfigFileMissing ? 'is not created' : 'stays unchanged';
  return `Every answer so far is lost${draft}, and ${configPath} ${file}.`;
}

/**
 * Runs the `tevu task add` interview, performs the single configuration write
 * through `createTask`, and returns the created task.
 *
 * Fails before any question when stdin or stdout is not a TTY, when an
 * existing configuration is invalid or cannot be read, or when the
 * configuration directory does not exist. When the configuration file is
 * missing and its directory exists, it bootstraps every required top-level
 * setting, at least one repository, and at least two models before the first
 * task question. An issue source is imported and displayed; the snapshot
 * travels inside the input handed to `createTask`, so the write never reads
 * the tracker again. After the final redacted review is accepted, a failed
 * write is reported and offered again with the same input; every other
 * recoverable failure re-asks its step, so only cancellation and defects end
 * the interview.
 */
export async function runTaskWizard(
  request: TaskWizardRequest,
  dependencies: TaskWizardDependencies,
): Promise<TevuResult<TaskDefinition, TaskWizardErrorKind>> {
  const ttyFailure = requireInteractiveTty(dependencies.io);
  if (ttyFailure !== null) {
    return ttyFailure;
  }
  const existing = await dependencies.readConfig();
  if (!existing.ok) {
    return existing;
  }
  if (
    request.jiraIssueKey !== undefined &&
    existing.value !== null &&
    existing.value.trackers?.jira === undefined
  ) {
    return configValidationFailure([
      {
        severity: 'error',
        identifier: 'trackers.jira',
        message: 'task add --jira requires trackers.jira in the existing configuration',
      },
    ]);
  }
  const progress: WizardProgress = { holdsCriteriaDraft: false };
  const exitLoss = (): string =>
    describeExitLoss(progress, request.configPath, existing.value === null);
  const io: WizardIo = {
    ...dependencies.io,
    signal: dependencies.cancellation,
    exitQuestion: () => `Exit without saving? ${exitLoss()}`,
    exitLoss,
    redact: dependencies.redact,
  };
  const wizardDependencies: TaskWizardDependencies = { ...dependencies, io };
  intro('tevu task add', promptOptions(io));
  log.message(
    styleText('dim', 'Press Ctrl-C to cancel.', { stream: io.output }),
    promptOptions(io),
  );
  try {
    const bootstrap =
      existing.value === null
        ? await interviewBootstrap(io, wizardDependencies, request.jiraIssueKey !== undefined)
        : undefined;
    const input = await interviewTask(
      request,
      wizardDependencies,
      existing.value,
      bootstrap,
      progress,
    );
    if (!input.ok) {
      return input;
    }
    const graderDeclared =
      existing.value === null
        ? bootstrap?.roles?.grader !== undefined
        : existing.value.roles?.grader !== undefined;
    const created = await reviewAndSave(io, wizardDependencies, input.value, graderDeclared);
    return { ok: true, value: created };
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      cancel('Cancelled. Nothing was saved.', promptOptions(io));
      return cancellationFailure();
    }
    throw error;
  }
}

/** Interviews for one complete task after any bootstrap answers were captured. */
async function interviewTask(
  request: TaskWizardRequest,
  dependencies: TaskWizardDependencies,
  existing: TevuConfig | null,
  bootstrap: Omit<TevuConfigInput, 'version' | 'tasks'> | undefined,
  progress: WizardProgress,
): Promise<TevuResult<TaskWizardInput, 'IssueImportError'>> {
  const io = dependencies.io;
  log.step('New task', promptOptions(io));
  const jiraSettings = existing?.trackers?.jira ?? bootstrap?.trackers?.jira;
  const source = await interviewSource(request, dependencies, jiraSettings);
  if (!source.ok) {
    return source;
  }
  const repositories = existing?.repositories ?? bootstrap?.repositories ?? [];
  const outputDirectory = existing?.run.output_dir ?? bootstrap?.run.output_dir;
  if (outputDirectory === undefined) {
    throw new Error('unreachable: interviewTask always has an existing configuration or bootstrap');
  }
  const { repo, newRepository, selectedRepository } = await selectTaskRepository(
    io,
    dependencies,
    repositories,
    outputDirectory,
  );
  const resolvedReference = await interviewReferenceSolution(io, dependencies, selectedRepository);
  const baseCommitAnswer =
    resolvedReference === undefined || resolvedReference.proposedBase === undefined
      ? (await askText(io, { message: 'Base commit', validate: validateNonWhitespace })).trim()
      : await askBaseCommitWithProposal(io, resolvedReference);
  const baseCommit = await settleBaseCommit(
    io,
    dependencies,
    selectedRepository,
    resolvedReference,
    baseCommitAnswer,
  );
  const taskId = deriveTaskId(new Set((existing?.tasks ?? []).map((task) => task.id)));
  const title = await askText(io, {
    message: 'Title',
    ...(source.value.importedTitle === undefined
      ? {}
      : { initialValue: source.value.importedTitle }),
    validate: validateNonWhitespace,
  });
  const description = await askText(io, {
    message: 'Description',
    validate: validateNonWhitespace,
  });
  const prompt = await askText(io, {
    message: 'Prompt for the models',
    validate: validateNonWhitespace,
  });
  const readiness = await interviewReadiness(io);
  const configuredAgents = existing?.agents ?? bootstrap?.agents ?? {};
  const agentNames = new Set(
    Object.values(configuredAgents).flatMap((settings) => [
      ...(settings.secrets ?? []),
      ...(settings.env ?? []),
    ]),
  );
  const jiraNames = new Set(
    jiraSettings === undefined
      ? []
      : [referencedVariableName(jiraSettings.email), referencedVariableName(jiraSettings.token)],
  );
  const validateCheckVariables = validateCheckVariableList(
    new Set([...agentNames, ...jiraNames]),
    dependencies.isVariableSet,
  );
  const { acceptance, done } = await interviewCriteria(
    io,
    dependencies,
    request.configPath,
    existing,
    bootstrap,
    resolvedReference,
    selectedRepository,
    prompt,
    description,
    validateCheckVariables,
    existing?.run.check_timeout ?? bootstrap?.run.check_timeout,
    progress,
  );
  const task: TaskInput = {
    id: taskId,
    title,
    repo,
    base_commit: baseCommit,
    prompt,
    description,
    ...(source.value.source === undefined ? {} : { source: source.value.source }),
    ...(resolvedReference === undefined ? {} : { reference: resolvedReference.reference }),
    readiness,
    checks: { acceptance, done },
  };
  return {
    ok: true,
    value: {
      configPath: request.configPath,
      ...(bootstrap === undefined ? {} : { bootstrap }),
      ...(newRepository === undefined ? {} : { newRepository }),
      task,
    },
  };
}
