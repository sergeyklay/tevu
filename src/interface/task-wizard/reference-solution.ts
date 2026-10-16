/**
 * Reference pull request or commit step of the task wizard.
 */

import { log, note } from '@clack/prompts';

import {
  askDefaultedText,
  promptOptions,
  WizardCancelledError,
} from '@/interface/wizard-questions';

import { describeManagedCloneOrPrerequisiteFailure, RETRY_NEXT_STEP, warnLines } from './shared';
import { runWait } from './wait';

import type { TaskWizardDependencies } from './shared';
import type { ResolvedReferenceSolution } from '@/application/reference-solution';
import type { RepositoryInput } from '@/config/schema';
import type { WizardIo } from '@/interface/wizard-questions';

/**
 * Interviews for the optional reference-solution answer, resolving it once
 * and re-asking with the failed identifier filled in on any failure other than
 * cancellation; clearing the answer adds the task without a reference.
 */
export async function interviewReferenceSolution(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  repository: Pick<RepositoryInput, 'id' | 'path' | 'github'>,
): Promise<ResolvedReferenceSolution | undefined> {
  let refused: string | undefined;
  for (;;) {
    const identifier = (
      await askDefaultedText(io, {
        message: 'Reference PR or commit',
        defaultValue: '',
        placeholder: 'none',
        ...(refused === undefined ? {} : { initialValue: refused }),
      })
    ).trim();
    if (identifier === '') {
      return undefined;
    }
    const result = await runWait(io, 'Resolving reference', () =>
      dependencies.resolveReference(repository, identifier, (line) =>
        log.step(dependencies.redact(line), promptOptions(io)),
      ),
    );
    if (result.ok) {
      const resolved = result.value;
      const warningText = describeReferenceWarning(resolved);
      if (warningText !== undefined) {
        log.warn(dependencies.redact(warningText), promptOptions(io));
      }
      const unfetched = resolved.pullRequest?.unfetched;
      if (unfetched !== undefined) {
        warnLines(io, dependencies.redact, {
          headline: "Can't fetch some reference commits.",
          details: [unfetched],
        });
      }
      note(
        dependencies.redact(renderReferenceNote(resolved, repository.id)),
        'Reference solution',
        promptOptions(io),
      );
      return resolved;
    }
    if (result.error.kind === 'CancellationError') {
      throw new WizardCancelledError();
    }
    const description =
      result.error.kind === 'ReferenceResolutionError'
        ? result.error.reason
        : describeManagedCloneOrPrerequisiteFailure(result.error);
    warnLines(io, dependencies.redact, {
      headline: "Can't resolve the reference.",
      details: [description],
      next: `Fix the reference below, or clear it to add the task without one. ${RETRY_NEXT_STEP}`,
    });
    refused = identifier;
  }
}

/** The at-most-one warning line a resolved reference prints before its note, or `undefined`. */
function describeReferenceWarning(resolved: ResolvedReferenceSolution): string | undefined {
  const pullRequest = resolved.pullRequest;
  if (pullRequest === undefined) {
    return undefined;
  }
  if (pullRequest.noProposedBase !== undefined) {
    return `No base commit is proposed: ${pullRequest.noProposedBase}`;
  }
  if (pullRequest.warning === undefined) {
    return undefined;
  }
  const { key, targetBranch, firstCommitParent, warning } = pullRequest;
  const hint =
    firstCommitParent === undefined
      ? ''
      : `; if it conflicts, enter ${firstCommitParent}, the parent of its first commit`;
  if (warning === 'conflicting') {
    return `Pull request ${key} conflicts with ${targetBranch}; the proposed base is the parent of its first commit, not the tip of ${targetBranch}`;
  }
  if (warning === 'closed') {
    return `Pull request ${key} is closed, and GitHub does not recheck closed pull requests against ${targetBranch}; the proposed base is the tip of ${targetBranch}${hint}`;
  }
  if (warning === 'mergeability-unknown') {
    return `GitHub has not determined whether pull request ${key} conflicts with ${targetBranch}; the proposed base is the tip of ${targetBranch}${hint}`;
  }
  return `Branch ${targetBranch} of pull request ${key} no longer exists on GitHub; the proposed base is the parent of its first commit`;
}

/** The proposed base's basis, in operator-facing terms; `target-tip` names the pull request's target branch. */
function describeProposedBaseBasis(resolved: ResolvedReferenceSolution): string {
  const basis = resolved.proposedBase?.basis;
  if (basis === 'target-tip') {
    return `the tip of ${resolved.pullRequest?.targetBranch} read from GitHub`;
  }
  if (basis === 'first-commit-parent') {
    return "the parent of the pull request's first commit";
  }
  return 'the parent of the reference commit';
}

/** Renders the `Reference solution` note body. */
function renderReferenceNote(resolved: ResolvedReferenceSolution, repositoryId: string): string {
  if (resolved.pullRequest !== undefined && resolved.reference.kind === 'pull-request') {
    const { key, state, targetBranch } = resolved.pullRequest;
    const mergeCommitSuffix =
      resolved.reference.merge_commit === undefined
        ? ''
        : `, merge commit ${resolved.reference.merge_commit}`;
    return [
      `Pull request ${key} (${state}) into ${targetBranch}`,
      `Commits: ${resolved.reference.commits.length}${mergeCommitSuffix}`,
      resolved.proposedBase === undefined
        ? 'Proposed base: none'
        : `Proposed base: ${resolved.proposedBase.commit} (${describeProposedBaseBasis(resolved)})`,
    ].join('\n');
  }
  const [commit] = resolved.reference.commits;
  const lines = [`Commit ${commit} in "${repositoryId}"`];
  if (resolved.proposedBase !== undefined) {
    lines.push(
      `Proposed base: ${resolved.proposedBase.commit} (${describeProposedBaseBasis(resolved)})`,
    );
  }
  return lines.join('\n');
}
