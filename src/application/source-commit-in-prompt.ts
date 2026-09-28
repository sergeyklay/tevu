/**
 * Detects whether an agent prompt names its resolved source commit, a
 * resolved reference commit, or a pull-request reference, so a
 * curator-authored prompt cannot leak the pinned commit or the accepted
 * solution that the sealed repository itself withholds.
 */

import { parseGitHubReference } from '@/domain/github-reference';

import type { ParsedGitHubReference } from '@/domain/github-reference';
import type { TaskReference } from '@/domain/types';

/**
 * Reports whether `prompt` contains the resolved source commit.
 *
 * Compares the first 7 characters of `sourceCommit` against `prompt` as a
 * case-insensitive substring, matching every abbreviation Git can emit down
 * to its shortest default form. Returns the reason string when a match is
 * found, `undefined` otherwise. Total and pure: never throws, performs no
 * I/O, and reads no clock or randomness.
 */
export function describeSourceCommitInPrompt(
  prompt: string,
  sourceCommit: string,
): string | undefined {
  const prefix = sourceCommit.slice(0, 7);
  if (prompt.toLowerCase().includes(prefix.toLowerCase())) {
    return `agent prompt contains resolved base commit ${prefix}`;
  }
  return undefined;
}

/**
 * Reports whether `prompt` contains a resolved reference commit.
 *
 * Shares {@link describeSourceCommitInPrompt}'s 7-character, case-insensitive
 * substring comparison, so a reference commit cannot leak through the prompt
 * any more than the base commit can.
 */
export function describeReferenceCommitInPrompt(
  prompt: string,
  referenceCommit: string,
): string | undefined {
  const prefix = referenceCommit.slice(0, 7);
  if (prompt.toLowerCase().includes(prefix.toLowerCase())) {
    return `agent prompt contains resolved reference commit ${prefix}`;
  }
  return undefined;
}

/**
 * Reports whether `prompt` contains a pull request's key or URL form.
 *
 * Builds `<owner>/<repo>#<number>` and the scheme-less URL form
 * `<host>/<owner>/<repo>/pull/<number>` from the parts a pull-request
 * reference's identifier parses to, and compares each against `prompt` as a
 * case-insensitive plain substring, with no character-boundary conditions.
 */
export function describePullRequestInPrompt(
  prompt: string,
  pullRequest: ParsedGitHubReference,
): string | undefined {
  const { host, owner, repo, number } = pullRequest;
  const key = `${owner}/${repo}#${number}`;
  const url = `${host}/${owner}/${repo}/pull/${number}`;
  const lowerPrompt = prompt.toLowerCase();
  if (lowerPrompt.includes(key.toLowerCase()) || lowerPrompt.includes(url.toLowerCase())) {
    return `agent prompt contains pull request ${key}`;
  }
  return undefined;
}

/**
 * Reports the first reference identity `text` names: a resolved reference
 * commit, its merge commit, or the pull request itself.
 *
 * Checks, in order, each entry of `reference.commits`, then
 * `reference.merge_commit` when present, through
 * {@link describeReferenceCommitInPrompt}, then, for a pull-request
 * reference, its key and URL form through {@link describePullRequestInPrompt}.
 * Deliberately excludes the task's `base_commit`, which is not part of
 * `reference`.
 */
export function describeReferenceIdentityInText(
  text: string,
  reference: TaskReference,
): string | undefined {
  for (const commit of reference.commits) {
    if (describeReferenceCommitInPrompt(text, commit) !== undefined) {
      return `reference commit ${commit.slice(0, 7)}`;
    }
  }
  if (
    reference.kind === 'pull-request' &&
    reference.merge_commit !== undefined &&
    describeReferenceCommitInPrompt(text, reference.merge_commit) !== undefined
  ) {
    return `reference commit ${reference.merge_commit.slice(0, 7)}`;
  }
  if (reference.kind === 'pull-request') {
    const parsed = parseGitHubReference(reference.identifier);
    if (parsed !== null && describePullRequestInPrompt(text, parsed) !== undefined) {
      return `pull request ${parsed.owner}/${parsed.repo}#${parsed.number}`;
    }
  }
  return undefined;
}
