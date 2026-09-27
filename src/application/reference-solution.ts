/**
 * Resolves a `tevu task add` reference-solution answer into a `TaskReference`
 * and a proposed base commit, without ever adding either to an agent prompt.
 *
 * Entry point: {@link resolveReferenceSolution}.
 */

import * as path from 'node:path';

import { resolveConfigPath } from '@/config/load';
import { parseGitHubReference } from '@/domain/github-reference';

import type {
  GitWorkspaceAdapter,
  PullRequestCommit,
  PullRequestReader,
  PullRequestSnapshot,
  PullRequestState,
  RepositoryDefinition,
  TaskReference,
  TevuResult,
} from '@/domain/types';

/** Inputs to resolve one `task add` reference-solution answer. */
export type ReferenceSolutionRequest = {
  configPath: string;
  repository: Pick<RepositoryDefinition, 'id' | 'path'>;
  identifier: string;
};

/** What a proposed base commit was derived from. */
type ProposedBaseBasis = 'target-tip' | 'first-commit-parent' | 'commit-parent';

/** A pull request condition the wizard warns about, naming the proposed base's caveat. */
type PullRequestWarning = 'conflicting' | 'closed' | 'mergeability-unknown' | 'target-deleted';

/** A resolved reference solution: the block to save, and its proposed base, when one is defined. */
export type ResolvedReferenceSolution = {
  reference: TaskReference;
  /** Absent when the proposed-base rule uses an undefined first-commit parent. */
  proposedBase?: { commit: string; basis: ProposedBaseBasis };
  /** Present only for a pull request. */
  pullRequest?: {
    key: string;
    state: PullRequestState;
    targetBranch: string;
    /** Present when defined; the Closed and Mergeability unknown hints name it. */
    firstCommitParent?: string;
    /** Absent when `noProposedBase` is present. */
    warning?: PullRequestWarning;
    /** The E-NO-PARENT or E-FIRST-COMMITS reason; present exactly when `proposedBase` is absent. */
    noProposedBase?: string;
  };
};

/** Effects `resolveReferenceSolution` needs. */
export type ReferenceSolutionDependencies = {
  git: Pick<GitWorkspaceAdapter, 'resolveCommit'>;
  pullRequests: PullRequestReader;
};

/**
 * Resolves a trimmed reference-solution identifier to a `TaskReference` and,
 * when defined, a proposed base commit.
 *
 * A pull-request identifier (containing `://`, or read as the short form)
 * resolves through {@link PullRequestReader.readPullRequest} and issues no
 * Git command. A commit identifier resolves against the task's repository,
 * pinned by {@link GitWorkspaceAdapter.resolveCommit}; its proposed base is
 * the commit's first parent. Fails with `ReferenceResolutionError` when the
 * identifier is empty, a commit's repository path is not a Git repository,
 * a commit identifier does not name a commit, or a commit has no parent.
 */
export async function resolveReferenceSolution(
  request: ReferenceSolutionRequest,
  dependencies: ReferenceSolutionDependencies,
): Promise<
  TevuResult<ResolvedReferenceSolution, 'ReferenceResolutionError' | 'CancellationError'>
> {
  const identifier = request.identifier.trim();
  if (identifier.length === 0) {
    return referenceFailure('reference must not be empty');
  }
  if (isPullRequestKind(identifier)) {
    return resolvePullRequest(identifier, dependencies);
  }

  const repository: RepositoryDefinition = {
    id: request.repository.id,
    path: resolveConfigPath(
      path.dirname(path.resolve(request.configPath)),
      request.repository.path,
    ),
  };

  const found = await dependencies.git.resolveCommit(repository, identifier);
  if (found.kind === 'no-repository') {
    return referenceFailure(
      `repository "${repository.id}": "${repository.path}" is not a Git repository`,
    );
  }
  if (found.kind === 'not-found') {
    return referenceFailure(
      `the answer does not name a commit in repository "${repository.id}" ("${repository.path}")`,
    );
  }

  const parent = await dependencies.git.resolveCommit(repository, `${found.commit}^1`);
  if (parent.kind !== 'found') {
    return referenceFailure(
      `commit ${found.commit.slice(0, 7)} has no parent, so no base commit can precede it`,
    );
  }

  return {
    ok: true,
    value: {
      reference: { kind: 'commit', identifier, commits: [found.commit] },
      proposedBase: { commit: parent.commit, basis: 'commit-parent' },
    },
  };
}

/** An identifier is a pull request when it holds a scheme or reads as the short form `OWNER/REPO#NUMBER`. */
function isPullRequestKind(identifier: string): boolean {
  if (identifier.includes('://')) {
    return true;
  }
  const parsed = parseGitHubReference(identifier);
  return parsed !== null && parsed.path === undefined;
}

/** Outcome of locating the pull request's first-commit parent. */
type FirstCommitParentResult =
  | { kind: 'parent'; hash: string }
  | { kind: 'no-parent'; firstCommitHash: string }
  | { kind: 'many-parents'; parents: string[] };

/**
 * Locates the parent every first commit of a pull request shares.
 *
 * A first commit is one none of whose parents is itself a pull request
 * commit. The result is `no-parent` when the first such first commit (in
 * list order) has no parent at all, `many-parents` when the first commits'
 * external parents are not all the same hash, and `parent` otherwise.
 */
function firstCommitParent(commits: readonly PullRequestCommit[]): FirstCommitParentResult {
  const pullRequestHashes = new Set(commits.map((commit) => commit.hash));
  const firstCommits = commits.filter((commit) =>
    commit.parents.every((parent) => !pullRequestHashes.has(parent)),
  );
  for (const commit of firstCommits) {
    if (commit.parents.length === 0) {
      return { kind: 'no-parent', firstCommitHash: commit.hash };
    }
  }
  const distinctParents: string[] = [];
  for (const commit of firstCommits) {
    for (const parent of commit.parents) {
      if (!distinctParents.includes(parent)) {
        distinctParents.push(parent);
      }
    }
  }
  const [sole] = distinctParents;
  return distinctParents.length === 1 && sole !== undefined
    ? { kind: 'parent', hash: sole }
    : { kind: 'many-parents', parents: distinctParents };
}

/** The E-NO-PARENT or E-FIRST-COMMITS reason for an undefined first-commit parent, naming `key`. */
function noProposedBaseReason(result: FirstCommitParentResult, key: string): string | undefined {
  if (result.kind === 'no-parent') {
    return `first commit ${result.firstCommitHash.slice(0, 7)} of pull request ${key} has no parent`;
  }
  if (result.kind === 'many-parents') {
    const prefixes = result.parents.map((hash) => hash.slice(0, 7)).join(', ');
    return `the commits of pull request ${key} start from ${result.parents.length} different parents (${prefixes}), so tevu cannot tell which commit it was built on`;
  }
  return undefined;
}

type ProposedBaseOutcome = {
  proposedBase?: { commit: string; basis: ProposedBaseBasis };
  warning?: PullRequestWarning;
  noProposedBase?: string;
};

/** Selects the proposed base, its basis, and any warning, per the ordered proposed-base rule table. */
function resolveProposedBase(
  pr: PullRequestSnapshot,
  parentHash: string | undefined,
  reasonWhenUndefined: string | undefined,
): ProposedBaseOutcome {
  const fromFirstCommitParent = (warning?: PullRequestWarning): ProposedBaseOutcome =>
    parentHash === undefined
      ? { noProposedBase: reasonWhenUndefined }
      : {
          proposedBase: { commit: parentHash, basis: 'first-commit-parent' },
          ...(warning === undefined ? {} : { warning }),
        };

  if (pr.state === 'merged') {
    return fromFirstCommitParent();
  }
  if (pr.targetTip === null) {
    return fromFirstCommitParent('target-deleted');
  }
  if (pr.mergeability === 'conflicting') {
    return fromFirstCommitParent('conflicting');
  }
  if (pr.mergeability === 'unknown') {
    return {
      proposedBase: { commit: pr.targetTip, basis: 'target-tip' },
      warning: 'mergeability-unknown',
    };
  }
  return {
    proposedBase: { commit: pr.targetTip, basis: 'target-tip' },
    ...(pr.state === 'closed' ? { warning: 'closed' as const } : {}),
  };
}

async function resolvePullRequest(
  identifier: string,
  dependencies: ReferenceSolutionDependencies,
): Promise<
  TevuResult<ResolvedReferenceSolution, 'ReferenceResolutionError' | 'CancellationError'>
> {
  const read = await dependencies.pullRequests.readPullRequest(identifier);
  if (!read.ok) {
    return read;
  }
  const pr = read.value;
  const hashes = pr.commits.map((commit) => commit.hash);
  const reference: TaskReference =
    pr.mergeCommit !== null && !hashes.includes(pr.mergeCommit)
      ? { kind: 'pull-request', identifier, commits: hashes, merge_commit: pr.mergeCommit }
      : { kind: 'pull-request', identifier, commits: hashes };

  const parentResult = firstCommitParent(pr.commits);
  const parentHash = parentResult.kind === 'parent' ? parentResult.hash : undefined;
  const { proposedBase, warning, noProposedBase } = resolveProposedBase(
    pr,
    parentHash,
    noProposedBaseReason(parentResult, pr.key),
  );

  return {
    ok: true,
    value: {
      reference,
      ...(proposedBase === undefined ? {} : { proposedBase }),
      pullRequest: {
        key: pr.key,
        state: pr.state,
        targetBranch: pr.targetBranch,
        ...(parentHash === undefined ? {} : { firstCommitParent: parentHash }),
        ...(warning === undefined ? {} : { warning }),
        ...(noProposedBase === undefined ? {} : { noProposedBase }),
      },
    },
  };
}

function referenceFailure(reason: string): TevuResult<never, 'ReferenceResolutionError'> {
  return { ok: false, error: { kind: 'ReferenceResolutionError', reason } };
}
