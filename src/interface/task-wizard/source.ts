/**
 * Task source and the one-time issue import.
 */

import { note } from '@clack/prompts';

import {
  askSelect,
  askText,
  promptOptions,
  WizardCancelledError,
} from '@/interface/wizard-questions';
import { validateNonWhitespace } from '@/interface/wizard-validators';

import { RETRY_NEXT_STEP, warnLines } from './shared';
import { runWait } from './wait';

import type { TaskWizardDependencies, TaskWizardRequest } from './shared';
import type { TaskInput } from '@/config/schema';
import type { JiraTrackerSettings } from '@/domain/config';
import type { TevuResult } from '@/domain/errors';
import type { IssueSnapshot } from '@/domain/ports/issue-tracker';
import type { WizardIo } from '@/interface/wizard-questions';

/** One selected task source: the stored `source` block, and an imported title for the title prompt. */
type SourceSelection = { source: TaskInput['source']; importedTitle?: string };

/** Selects the task source; a Jira or GitHub issue is imported once and displayed. */
export async function interviewSource(
  request: TaskWizardRequest,
  dependencies: TaskWizardDependencies,
  jiraSettings: JiraTrackerSettings | undefined,
): Promise<TevuResult<SourceSelection, 'IssueImportError'>> {
  const io = dependencies.io;
  const kind =
    request.jiraIssueKey !== undefined
      ? 'jira'
      : request.githubIssueReference !== undefined
        ? 'github'
        : await askSelect<'manual' | 'jira' | 'github'>(io, {
            message: 'Task source',
            options: [
              { value: 'manual', label: 'Write it yourself' },
              {
                value: 'jira',
                label: 'Jira issue',
                ...(jiraSettings === undefined
                  ? { disabled: true, hint: "Jira isn't set up" }
                  : {}),
              },
              { value: 'github', label: 'GitHub issue' },
            ],
          });
  if (kind === 'manual') {
    return { ok: true, value: { source: undefined } };
  }
  if (kind === 'github') {
    return {
      ok: true,
      value: await interviewImportedSource(io, dependencies, {
        kind: 'github',
        question: 'GitHub issue',
        given: request.githubIssueReference,
        importIssue: (reference) => dependencies.importGitHubIssue(reference),
      }),
    };
  }
  if (jiraSettings === undefined) {
    // Unreachable through prompts (the option is disabled), reachable only
    // with --jira, which the caller validated; keep the abort explicit.
    return {
      ok: false,
      error: {
        kind: 'IssueImportError',
        tracker: 'jira-cloud',
        reference: request.jiraIssueKey ?? '',
        reason: 'Jira import is not available because no Jira settings are configured',
      },
    };
  }
  return {
    ok: true,
    value: await interviewImportedSource(io, dependencies, {
      kind: 'jira',
      question: 'Jira issue key',
      given: request.jiraIssueKey,
      importIssue: (issueKey) => dependencies.importJiraIssue(jiraSettings, issueKey),
    }),
  };
}

/** One tracker the task can be imported from, and how to ask for and read its issue. */
type IssueTracker = {
  kind: 'jira' | 'github';
  question: string;
  /** The reference given on the command line, asked for otherwise. */
  given: string | undefined;
  importIssue: (
    reference: string,
  ) => Promise<TevuResult<IssueSnapshot, 'IssueImportError' | 'CancellationError'>>;
};

/**
 * Imports one tracker issue, displays it, and builds its stored source block.
 *
 * A failed import asks the reference again with itself filled in, and an empty
 * answer then writes the task by hand instead, so no failure ends the
 * interview.
 */
async function interviewImportedSource(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  tracker: IssueTracker,
): Promise<SourceSelection> {
  let reference =
    tracker.given ??
    (await askText(io, { message: tracker.question, validate: validateNonWhitespace })).trim();
  for (;;) {
    const imported = unwrapImportResult(
      await runWait(io, 'Importing issue', () => tracker.importIssue(reference)),
    );
    if (imported.ok) {
      const importedAt = dependencies.now().toISOString();
      note(
        dependencies.redact(`${imported.value.summary}\n\n${imported.value.description}`),
        `Imported ${imported.value.issueKey}`,
        promptOptions(io),
      );
      return {
        source: {
          kind: tracker.kind,
          key: imported.value.issueKey,
          url: imported.value.issueUrl,
          imported_at: importedAt,
          title: imported.value.summary,
          body: imported.value.description,
        },
        importedTitle: imported.value.summary,
      };
    }
    const { status, reason } = imported.error;
    warnLines(io, dependencies.redact, {
      headline: `Can't import issue ${reference}.`,
      details: [status === undefined ? reason : `status ${String(status)}: ${reason}`],
      next: `Fix the issue below, or clear it to write the task yourself. ${RETRY_NEXT_STEP}`,
    });
    const answer = (
      await askText(io, { message: tracker.question, initialValue: reference })
    ).trim();
    if (answer === '') {
      return { source: undefined };
    }
    reference = answer;
  }
}

/**
 * Maps a tracker import's cancellation to the internal sentinel the wizard
 * entry points catch, so Ctrl+C during an issue import exits like any other
 * wizard cancellation, never as an `IssueImportError`.
 */
function unwrapImportResult<T>(
  result: TevuResult<T, 'IssueImportError' | 'CancellationError'>,
): TevuResult<T, 'IssueImportError'> {
  if (result.ok || result.error.kind === 'IssueImportError') {
    return result as TevuResult<T, 'IssueImportError'>;
  }
  throw new WizardCancelledError();
}
