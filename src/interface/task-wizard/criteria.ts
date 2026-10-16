/**
 * Acceptance and Definition of Done checks of the task wizard: the criteria draft, its review, and the fallback to check questions.
 */

import { styleText } from 'node:util';
import { log, note } from '@clack/prompts';

import { describeReferenceIdentityInText } from '@/application/source-commit-in-prompt';
import { deriveCheckId } from '@/interface/derived-identifiers';
import { sectionedSelect } from '@/interface/sectioned-select';
import {
  ask,
  askConfirm,
  askSelect,
  askText,
  promptOptions,
  WizardCancelledError,
} from '@/interface/wizard-questions';

import { interviewChecks } from './checks';
import { describeUnsetNames, warnLines, warnRetainedDirectory } from './shared';
import { runWaitReporting } from './wait';

import type { TaskWizardDependencies, WizardProgress } from './shared';
import type {
  CriteriaDraft,
  CriteriaDraftFailure,
  CriteriaDraftRequest,
} from '@/application/draft-criteria';
import type { ResolvedReferenceSolution } from '@/application/reference-solution';
import type { CheckInput, RepositoryInput, TevuConfigInput } from '@/config/schema';
import type { TaskReference, TevuConfig } from '@/domain/config';
import type { WizardIo } from '@/interface/wizard-questions';
import type { TextValidator } from '@/interface/wizard-validators';

const DRAFT_REVIEW_BACK_OPTION = { value: 'back', label: 'Back to the review' };

/** One check collection's checks, as `interviewCriteria` hands them to `interviewTask`. */
type DraftedTaskChecks = { acceptance: CheckInput[]; done: CheckInput[] };

/** The loaded configuration or the captured bootstrap answers, for a criteria-drafting request. */
function currentConfiguration(
  existing: TevuConfig | null,
  bootstrap: Omit<TevuConfigInput, 'version' | 'tasks'> | undefined,
): CriteriaDraftRequest['configuration'] {
  if (existing !== null) {
    return { kind: 'loaded', config: existing };
  }
  if (bootstrap === undefined) {
    throw new Error(
      'unreachable: interviewTask always provides bootstrap answers when no configuration exists',
    );
  }
  return { kind: 'bootstrap', answers: bootstrap };
}

/**
 * Runs the criteria step: without a resolved reference, or without a
 * declared `roles.criteria`, falls through to writing both check collections
 * by hand. With both, drafts from the reference solution, shows the
 * mandatory draft review, and hands an accepted draft's items to the
 * follow-on check questions as the starting checks of each collection.
 */
export async function interviewCriteria(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  configPath: string,
  existing: TevuConfig | null,
  bootstrap: Omit<TevuConfigInput, 'version' | 'tasks'> | undefined,
  resolvedReference: ResolvedReferenceSolution | undefined,
  repository: Pick<RepositoryInput, 'id' | 'path' | 'github'>,
  prompt: string,
  description: string,
  validateCheckVariables: TextValidator,
  checkTimeout: string | undefined,
  progress: WizardProgress,
): Promise<DraftedTaskChecks> {
  const byHand = async (): Promise<DraftedTaskChecks> => ({
    acceptance: await interviewChecks(io, 'acceptance', validateCheckVariables, checkTimeout),
    done: await interviewChecks(io, 'done', validateCheckVariables, checkTimeout),
  });

  if (resolvedReference === undefined) {
    return byHand();
  }
  const role = existing?.roles?.criteria ?? bootstrap?.roles?.criteria;
  if (role === undefined) {
    log.info('No criteria model set. Enter the criteria yourself.', promptOptions(io));
    return byHand();
  }
  const draft = await draftCriteriaUntilDone(
    io,
    dependencies,
    configPath,
    {
      configuration: currentConfiguration(existing, bootstrap),
      repository,
      reference: resolvedReference,
      prompt,
      description,
    },
    role.effort,
    progress,
  );
  if (draft === undefined) {
    return byHand();
  }
  log.success('Criteria drafted', promptOptions(io));
  const review = await reviewDraft(io, dependencies.redact, draft, resolvedReference.reference);
  if (review === 'by-hand') {
    progress.holdsCriteriaDraft = false;
    return byHand();
  }
  const draftedAcceptance: CheckInput[] = review.acceptance.map((text, index) => ({
    id: deriveCheckId('acceptance', index + 1),
    description: text,
  }));
  const draftedDone: CheckInput[] = review.done.map((text, index) => ({
    id: deriveCheckId('done', index + 1),
    description: text,
  }));
  return {
    acceptance: await interviewChecks(
      io,
      'acceptance',
      validateCheckVariables,
      checkTimeout,
      draftedAcceptance,
    ),
    done: await interviewChecks(io, 'done', validateCheckVariables, checkTimeout, draftedDone),
  };
}

/**
 * Drafts the criteria, and after a failure with a cause a retry can change,
 * asks whether to draft again. Each retry is another paid model session, so it
 * runs only after `Yes`. Resolves `undefined` when the operator writes the
 * criteria by hand instead, or when the cause cannot change within this run.
 */
async function draftCriteriaUntilDone(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  configPath: string,
  request: Omit<CriteriaDraftRequest, 'configPath'>,
  effort: string,
  progress: WizardProgress,
): Promise<CriteriaDraft | undefined> {
  for (;;) {
    const outcome = await runWaitReporting(
      io,
      'Drafting criteria',
      async () => {
        const drafting = await dependencies.draftCriteria(request);
        progress.holdsCriteriaDraft = drafting.status === 'drafted';
        return drafting;
      },
      (settled) => {
        for (const directory of settled.retainedDirectories) {
          warnRetainedDirectory(io, dependencies.redact, directory);
        }
      },
    );
    for (const directory of outcome.retainedDirectories) {
      warnRetainedDirectory(io, dependencies.redact, directory);
    }
    if (outcome.status === 'cancelled') {
      throw new WizardCancelledError();
    }
    if (outcome.status === 'drafted') {
      if (outcome.effort.status !== 'verified') {
        warnLines(io, dependencies.redact, {
          headline: `Criteria effort "${effort}" is ${outcome.effort.status}.`,
          details: [outcome.effort.reason],
        });
      }
      return outcome.draft;
    }
    const { cause, details } = describeDraftFailure(outcome.failure, configPath);
    const isRetryable = isRetryableDraftCause(outcome.failure.cause);
    warnLines(io, dependencies.redact, {
      headline: "Couldn't draft criteria.",
      details: [cause, ...details],
      next: isRetryable
        ? 'Press Enter to draft again, or choose No to enter the criteria yourself.'
        : 'Enter the criteria yourself.',
    });
    if (!isRetryable) {
      return undefined;
    }
    const wantsRetry = await askConfirm(io, {
      message: 'Draft the criteria again?',
      initialValue: true,
    });
    if (!wantsRetry) {
      return undefined;
    }
  }
}

/** Holds for the causes another call can change; the others depend on the environment, redactor, or configuration this run already read. */
function isRetryableDraftCause(cause: CriteriaDraftFailure['cause']): boolean {
  switch (cause) {
    case 'changes-unreadable':
    case 'timed-out':
    case 'call-failed':
    case 'reply-invalid':
      return true;
    case 'variables-unset':
    case 'prompt-unredactable':
    case 'model-unavailable':
    case 'effort-unsupported':
      return false;
  }
}

/** The cause line of a failed criteria draft and the lower-layer detail lines that follow it. */
function describeDraftFailure(
  failure: CriteriaDraftFailure,
  configPath: string,
): { cause: string; details: string[] } {
  switch (failure.cause) {
    case 'changes-unreadable':
      return {
        cause: "The reference solution's changes can't be read.",
        details: [failure.detail],
      };
    case 'prompt-unredactable':
      return { cause: "The prompt couldn't be redacted, so the model wasn't called.", details: [] };
    case 'variables-unset':
      return {
        cause: `${describeUnsetNames(failure.names)} in this terminal.`,
        details: [],
      };
    case 'model-unavailable':
      return {
        cause: `OpenCode can't find ${failure.model} in tevu's environment.`,
        details: [`Add its provider to agents.opencode.providers in ${configPath}.`],
      };
    case 'effort-unsupported':
      return {
        cause: `Criteria effort "${failure.effort}" is not a variant OpenCode reports for ${failure.model}.`,
        details: [
          `Its variants: ${failure.variants.join(', ')}.`,
          `Set roles.criteria.effort in ${configPath} to one of them.`,
        ],
      };
    case 'timed-out':
      return { cause: `The model didn't answer within ${failure.limit}.`, details: [] };
    case 'call-failed':
      return failure.agentMessage === undefined
        ? { cause: 'The OpenCode call failed.', details: [failure.detail] }
        : { cause: `OpenCode reported "${failure.agentMessage}".`, details: [] };
    case 'reply-invalid':
      return { cause: "The model's reply wasn't a usable list.", details: [] };
  }
}

/** Both drafted lists, in review order, once the operator accepts them. */
type DraftReviewOutcome = { acceptance: string[]; done: string[] } | 'by-hand';

/** One item's location within the draft review's two lists. */
type DraftItemTarget = { collection: 'acceptance' | 'done'; index: number };

/**
 * Runs the mandatory draft review: the operator accepts,
 * edits, removes, or adds items until either accepting the draft or choosing
 * to write the criteria by hand instead. Accept stays blocked while the
 * acceptance list is empty or an item names the reference solution; the
 * Definition of Done list may be empty. Every note, log line, and
 * select label carrying item text passes through `redact`.
 */
async function reviewDraft(
  io: WizardIo,
  redact: (textContent: string) => string,
  draft: CriteriaDraft,
  reference: TaskReference,
): Promise<DraftReviewOutcome> {
  let acceptance = [...draft.acceptance];
  let done = [...draft.done];

  for (;;) {
    note(
      redact(renderDraftReviewNote(acceptance, done, reference, io)),
      'Drafted criteria',
      promptOptions(io),
    );
    const blockingReason = firstDraftBlockingReason(acceptance, done, reference);
    const hasItems = acceptance.length + done.length > 0;
    const action = await askSelect<'accept' | 'edit' | 'remove' | 'add' | 'by-hand'>(io, {
      message: 'What next?',
      options: [
        {
          value: 'accept',
          label: 'Accept',
          ...(blockingReason === undefined ? {} : { disabled: true, hint: blockingReason }),
        },
        { value: 'edit', label: 'Edit an item', ...(hasItems ? {} : { disabled: true }) },
        { value: 'remove', label: 'Remove an item', ...(hasItems ? {} : { disabled: true }) },
        { value: 'add', label: 'Add an item' },
        { value: 'by-hand', label: 'Write my own instead' },
      ],
    });

    if (action === 'by-hand') {
      return 'by-hand';
    }
    if (action === 'accept') {
      if (blockingReason !== undefined) {
        log.warn(`Cannot accept yet: ${blockingReason}.`, promptOptions(io));
        continue;
      }
      return { acceptance, done };
    }
    if (action === 'edit' || action === 'remove') {
      const target = await selectDraftItem(io, redact, acceptance, done, action);
      if (target === 'back') {
        continue;
      }
      const lists = target.collection === 'acceptance' ? acceptance : done;
      if (action === 'remove') {
        const updated = lists.filter((_, index) => index !== target.index);
        if (target.collection === 'acceptance') {
          acceptance = updated;
        } else {
          done = updated;
        }
        continue;
      }
      const item = lists[target.index];
      if (item === undefined) {
        continue;
      }
      const edited = (
        await askText(io, {
          message: 'Item',
          initialValue: item,
          validate: draftItemValidator(reference),
        })
      ).trim();
      const updated = lists.map((item, index) => (index === target.index ? edited : item));
      if (target.collection === 'acceptance') {
        acceptance = updated;
      } else {
        done = updated;
      }
      continue;
    }

    const targetCollection = await ask(io, (signal) =>
      sectionedSelect({
        message: 'Add to',
        sections: [
          {
            options: [
              { value: 'acceptance', label: 'Acceptance Criteria' },
              { value: 'done', label: 'Definition of Done' },
            ],
          },
        ],
        back: DRAFT_REVIEW_BACK_OPTION,
        ...promptOptions(io),
        statusLine: io.statusLine,
        ...signal,
      }),
    );
    if (targetCollection === 'back') {
      continue;
    }
    const newItem = (
      await askText(io, {
        message:
          targetCollection === 'acceptance'
            ? 'New acceptance criterion'
            : 'New Definition of Done item',
        validate: draftItemValidator(reference),
      })
    ).trim();
    if (targetCollection === 'acceptance') {
      acceptance = [...acceptance, newItem];
    } else {
      done = [...done, newItem];
    }
  }
}

/**
 * Selects one item to edit or remove, or `'back'`. The headings and the
 * back label are constants and item text passes through `redact`. Escape
 * resolves `back` inside the prompt, while Ctrl-C goes through `ask`.
 */
async function selectDraftItem(
  io: WizardIo,
  redact: (textContent: string) => string,
  acceptance: readonly string[],
  done: readonly string[],
  action: 'edit' | 'remove',
): Promise<DraftItemTarget | 'back'> {
  const choice = await ask(io, (signal) =>
    sectionedSelect({
      message: action === 'edit' ? 'Item to edit' : 'Item to remove',
      sections: [
        {
          heading: 'Acceptance Criteria',
          options: acceptance.map((text, index) => ({
            value: `acceptance:${String(index)}`,
            label: redact(text),
          })),
        },
        {
          heading: 'Definition of Done',
          options: done.map((text, index) => ({
            value: `done:${String(index)}`,
            label: redact(text),
          })),
        },
      ],
      back: DRAFT_REVIEW_BACK_OPTION,
      ...promptOptions(io),
      statusLine: io.statusLine,
      ...signal,
    }),
  );
  if (choice === 'back') {
    return 'back';
  }
  const separatorIndex = choice.indexOf(':');
  const collection = choice.slice(0, separatorIndex);
  const index = Number(choice.slice(separatorIndex + 1));
  if (collection !== 'acceptance' && collection !== 'done') {
    throw new Error('unreachable: selectDraftItem only offers acceptance:<n> and done:<n> values');
  }
  return { collection, index };
}

/** The item rule shared by editing and adding: rejects whitespace-only text and text naming the reference. */
function draftItemValidator(
  reference: TaskReference,
): (value: string | undefined) => string | undefined {
  return (raw) => {
    const value = (raw ?? '').trim();
    if (value.length === 0) {
      return 'a non-empty value is required';
    }
    const identity = describeReferenceIdentityInText(raw ?? '', reference);
    if (identity !== undefined) {
      return `the item names ${identity}; tevu validate rejects a task whose agent prompt contains it`;
    }
    return undefined;
  };
}

/** Renders the draft review note body: the guidance line, then each list with its item lines. */
function renderDraftReviewNote(
  acceptance: readonly string[],
  done: readonly string[],
  reference: TaskReference,
  io: WizardIo,
): string {
  return [
    'Agents see every item. Keep outcomes, not details of the reference solution.',
    '',
    boldText(io, 'Acceptance Criteria'),
    ...renderDraftItemLines(acceptance, reference),
    '',
    boldText(io, 'Definition of Done'),
    ...renderDraftItemLines(done, reference),
  ].join('\n');
}

function boldText(io: WizardIo, text: string): string {
  return styleText('bold', text, { stream: io.output });
}

function renderDraftItemLines(items: readonly string[], reference: TaskReference): string[] {
  if (items.length === 0) {
    return ['  (none)'];
  }
  return items.map((item, index) => {
    const identity = describeReferenceIdentityInText(item, reference);
    return `  ${String(index + 1)}. ${item}${identity === undefined ? '' : ` [names ${identity}]`}`;
  });
}

/**
 * The first reason `accept` stays blocked, checked in this order: an empty
 * acceptance list, then any item naming the reference solution. An empty
 * Definition of Done list never blocks.
 */
function firstDraftBlockingReason(
  acceptance: readonly string[],
  done: readonly string[],
  reference: TaskReference,
): string | undefined {
  if (acceptance.length === 0) {
    return 'the acceptance criteria need at least one item';
  }
  const namingCount = [...acceptance, ...done].filter(
    (item) => describeReferenceIdentityInText(item, reference) !== undefined,
  ).length;
  if (namingCount === 0) {
    return undefined;
  }
  return namingCount === 1
    ? '1 item names the reference solution; edit or remove it'
    : `${String(namingCount)} items name the reference solution; edit or remove them`;
}
