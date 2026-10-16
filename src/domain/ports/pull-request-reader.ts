/** The `PullRequestReader` contract, with the snapshot shapes only it uses. */

import type { TevuResult } from '@/domain/errors';

/** A GitHub pull request's state, as `readPullRequest` reports it. */
export type PullRequestState = 'open' | 'closed' | 'merged';

/** Whether a pull request's head merges cleanly into its target, as GitHub last computed it. */
export type PullRequestMergeability = 'mergeable' | 'conflicting' | 'unknown';

/** One pull request commit as GitHub lists it. */
export type PullRequestCommit = { hash: string; parents: string[] };

/** One GitHub pull request read once through gh, with its complete commit list. */
export type PullRequestSnapshot = {
  /** `OWNER/REPO#NUMBER`, taken from gh's `url` field. */
  key: string;
  url: string;
  state: PullRequestState;
  /** GraphQL `baseRefName`. */
  targetBranch: string;
  /** GraphQL `baseRef.target.oid` when read; `null` when the target branch no longer exists. */
  targetTip: string | null;
  headCommit: string;
  /** GraphQL `mergeCommit.oid` when `state` is `merged` and GitHub reports one; otherwise `null`. */
  mergeCommit: string | null;
  mergeability: PullRequestMergeability;
  /** Every commit GitHub lists, in GitHub's order; never a partial list. */
  commits: PullRequestCommit[];
};

/** Reads one GitHub pull request, complete with its commit list, exactly once. */
export interface PullRequestReader {
  readPullRequest(
    reference: string,
  ): Promise<TevuResult<PullRequestSnapshot, 'ReferenceResolutionError' | 'CancellationError'>>;
  /** Reads the pull request's unified diff through GitHub's diff media type. */
  readPullRequestDiff(
    reference: string,
  ): Promise<TevuResult<string, 'ReferenceResolutionError' | 'CancellationError'>>;
}
