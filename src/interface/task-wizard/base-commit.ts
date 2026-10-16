/**
 * Base commit step of the task wizard: the question and the inspection of the commit.
 */

import { log } from '@clack/prompts';

import { formatGitHubRepository, parseGitHubRepository } from '@/domain/github-reference';
import {
  askDefaultedText,
  askText,
  promptOptions,
  WizardCancelledError,
} from '@/interface/wizard-questions';
import { validateNonWhitespace } from '@/interface/wizard-validators';

import { describeManagedCloneOrPrerequisiteFailure, RETRY_NEXT_STEP, warnLines } from './shared';
import { runWait } from './wait';

import type { TaskWizardDependencies } from './shared';
import type { ResolvedReferenceSolution } from '@/application/reference-solution';
import type { RepositoryInput } from '@/config/schema';
import type { WizardIo } from '@/interface/wizard-questions';

/** A full commit hash: 40 (SHA-1) or 64 (SHA-256) lowercase hexadecimal characters. */
const FULL_COMMIT_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Ensures a GitHub entry's base-commit answer resolves in its managed clone
 * before the title question; a path entry returns the answer unchanged.
 *
 * A commit still missing after the fetch keeps the answer unchanged for a
 * pull-request task whose answer is a full hash, per `resolveTaskBaseCommit`'s
 * own rule; any other answer is re-asked with itself filled in.
 */
async function ensureBaseCommitInClone(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  repository: Pick<RepositoryInput, 'id' | 'path' | 'github'>,
  resolvedReference: ResolvedReferenceSolution | undefined,
  initialAnswer: string,
): Promise<string> {
  const { github } = repository;
  if (github === undefined) {
    return initialAnswer;
  }
  let answer = initialAnswer;
  for (;;) {
    const ensured = await runWait(io, 'Fetching base commit', () =>
      dependencies.ensureManagedCommits({ id: repository.id, github }, [answer], (line) =>
        log.step(dependencies.redact(line), promptOptions(io)),
      ),
    );
    if (!ensured.ok) {
      if (ensured.error.kind === 'CancellationError') {
        throw new WizardCancelledError();
      }
      warnLines(io, dependencies.redact, {
        headline: "Can't fetch the base commit.",
        details: [describeManagedCloneOrPrerequisiteFailure(ensured.error)],
        next: BASE_COMMIT_NEXT_STEP,
      });
    } else if (ensured.value.missing.includes(answer)) {
      const keepsUnfetchedAnswer =
        resolvedReference?.reference.kind === 'pull-request' &&
        FULL_COMMIT_HASH_PATTERN.test(answer);
      if (keepsUnfetchedAnswer) {
        return answer;
      }
      const parsed = parseGitHubRepository(github);
      const display = parsed === null ? github : formatGitHubRepository(parsed);
      warnLines(io, dependencies.redact, {
        headline: `Base commit ${answer} isn't in repository ${repository.id}.`,
        details: [`It can't be fetched from ${display}.`],
        next: BASE_COMMIT_NEXT_STEP,
      });
    } else {
      const lfs = await runWait(io, 'Fetching Git LFS objects', () =>
        dependencies.ensureManagedLfsObjects({ id: repository.id, github }, answer, (line) =>
          log.step(dependencies.redact(line), promptOptions(io)),
        ),
      );
      if (lfs.ok) {
        return answer;
      }
      if (lfs.error.kind === 'CancellationError') {
        throw new WizardCancelledError();
      }
      warnLines(io, dependencies.redact, {
        headline: `Can't fetch the Git LFS objects of base commit ${answer}.`,
        details: [describeManagedCloneOrPrerequisiteFailure(lfs.error)],
        next: BASE_COMMIT_NEXT_STEP,
      });
    }
    answer = await askBaseCommitAgain(io, answer);
  }
}

const BASE_COMMIT_NEXT_STEP = `Fix the cause or change the base commit below. ${RETRY_NEXT_STEP}`;

/** Asks the base commit again with the refused answer filled in. */
async function askBaseCommitAgain(io: WizardIo, refused: string): Promise<string> {
  return (
    await askText(io, {
      message: 'Base commit',
      initialValue: refused,
      validate: validateNonWhitespace,
    })
  ).trim();
}

/**
 * Settles the base-commit answer: ensures a GitHub entry's clone holds it,
 * then inspects it the way the write pins it, asking again with the refused
 * answer filled in until both pass. Neither the criteria draft nor the write
 * runs before an inspection succeeds.
 */
export async function settleBaseCommit(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  repository: Pick<RepositoryInput, 'id' | 'path' | 'github'>,
  resolvedReference: ResolvedReferenceSolution | undefined,
  initialAnswer: string,
): Promise<string> {
  let answer = initialAnswer;
  for (;;) {
    answer = await ensureBaseCommitInClone(io, dependencies, repository, resolvedReference, answer);
    const inspected = await runWait(io, 'Checking base commit', () =>
      dependencies.inspectBaseCommit(repository, answer, resolvedReference?.reference),
    );
    if (inspected.ok) {
      return answer;
    }
    warnLines(io, dependencies.redact, {
      headline: `Can't use base commit ${answer}.`,
      details:
        inspected.error.kind === 'SourceMaterializationError'
          ? [inspected.error.reason]
          : inspected.error.findings.map((finding) => finding.message),
      next: BASE_COMMIT_NEXT_STEP,
    });
    answer = await askBaseCommitAgain(io, answer);
  }
}

/** Asks the base-commit question with the resolved reference's proposed base as its default. */
export async function askBaseCommitWithProposal(
  io: WizardIo,
  resolved: ResolvedReferenceSolution,
): Promise<string> {
  const proposedBase = resolved.proposedBase;
  if (proposedBase === undefined) {
    throw new Error('unreachable: askBaseCommitWithProposal requires a resolved proposed base');
  }
  const answer = (
    await askDefaultedText(io, { message: 'Base commit', defaultValue: proposedBase.commit })
  ).trim();
  return answer === '' ? proposedBase.commit : answer;
}
