import { describe, expect, it, vi } from 'vitest';

import { resolveReferenceSolution } from './reference-solution';

import type { ReferenceSolutionDependencies, ReferenceSolutionRequest } from './reference-solution';
import type {
  CommitLookup,
  GitWorkspaceAdapter,
  PullRequestCommit,
  PullRequestReader,
  PullRequestSnapshot,
  RepositoryDefinition,
  TevuResult,
} from '@/domain/types';

function buildRequest(overrides: Partial<ReferenceSolutionRequest> = {}): ReferenceSolutionRequest {
  return {
    configPath: '/tmp/tevu/tevu.yaml',
    repository: { id: 'app', path: '../app' },
    identifier: 'HEAD~3',
    ...overrides,
  };
}

function failingResolveCommit(): Promise<CommitLookup> {
  throw new Error('unexpected Git call while resolving a pull request');
}

function buildDependencies(
  resolveCommit: (
    repository: RepositoryDefinition,
    reference: string,
  ) => Promise<CommitLookup> = failingResolveCommit,
  pullRequests: PullRequestReader = {
    readPullRequest: vi.fn(async () => {
      throw new Error('unexpected pull-request read for a commit reference');
    }),
  },
): ReferenceSolutionDependencies {
  return { git: { resolveCommit } as Pick<GitWorkspaceAdapter, 'resolveCommit'>, pullRequests };
}

function buildPullRequestSnapshot(
  overrides: Partial<PullRequestSnapshot> = {},
): PullRequestSnapshot {
  return {
    key: 'octo/repo#42',
    url: 'https://github.com/octo/repo/pull/42',
    state: 'open',
    targetBranch: 'main',
    targetTip: 'e'.repeat(40),
    headCommit: 'a'.repeat(40),
    mergeCommit: null,
    mergeability: 'mergeable',
    commits: [{ hash: 'a'.repeat(40), parents: ['f'.repeat(40)] }],
    ...overrides,
  };
}

function buildPullRequestReader(snapshot: PullRequestSnapshot): PullRequestReader {
  return {
    readPullRequest: vi.fn(
      async (): Promise<TevuResult<PullRequestSnapshot, 'ReferenceResolutionError'>> => ({
        ok: true,
        value: snapshot,
      }),
    ),
  };
}

function commit(hash: string, parents: readonly string[]): PullRequestCommit {
  return { hash, parents: [...parents] };
}

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const PARENT = 'fedcba9876543210fedcba9876543210fedcba98';

describe('resolveReferenceSolution', () => {
  it('fails with E-EMPTY for a blank identifier', async () => {
    const dependencies = buildDependencies(vi.fn());

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: '   ' }),
      dependencies,
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: 'ReferenceResolutionError', reason: 'reference must not be empty' },
    });
  });

  it('fails with E-NO-REPOSITORY when the lookup finds no Git repository', async () => {
    const resolveCommit = vi.fn(async () => ({ kind: 'no-repository' as const }));
    const dependencies = buildDependencies(resolveCommit);

    const result = await resolveReferenceSolution(
      buildRequest({ repository: { id: 'app', path: '../app' } }),
      dependencies,
    );

    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'ReferenceResolutionError') return;
    expect(result.error.reason).toMatch(/^repository "app": ".*app" is not a Git repository$/);
  });

  it('fails with E-NOT-A-COMMIT when the identifier does not name a commit', async () => {
    const resolveCommit = vi.fn(async () => ({ kind: 'not-found' as const }));
    const dependencies = buildDependencies(resolveCommit);

    const result = await resolveReferenceSolution(buildRequest(), dependencies);

    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'ReferenceResolutionError') return;
    expect(result.error.reason).toMatch(
      /^the answer does not name a commit in repository "app" \(".*app"\)$/,
    );
  });

  it('fails with E-ROOT when the resolved commit has no parent', async () => {
    const resolveCommit = vi.fn(async (_repository: RepositoryDefinition, reference: string) => {
      if (reference === `${COMMIT}^1`) {
        return { kind: 'not-found' as const };
      }
      return { kind: 'found' as const, commit: COMMIT };
    });
    const dependencies = buildDependencies(resolveCommit);

    const result = await resolveReferenceSolution(buildRequest(), dependencies);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'ReferenceResolutionError',
        reason: `commit ${COMMIT.slice(0, 7)} has no parent, so no base commit can precede it`,
      },
    });
  });

  it('resolves a commit reference with the commit-parent basis', async () => {
    const resolveCommit = vi.fn(async (_repository: RepositoryDefinition, reference: string) => {
      if (reference === `${COMMIT}^1`) {
        return { kind: 'found' as const, commit: PARENT };
      }
      return { kind: 'found' as const, commit: COMMIT };
    });
    const dependencies = buildDependencies(resolveCommit);

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: '  HEAD~3  ' }),
      dependencies,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        reference: { kind: 'commit', identifier: 'HEAD~3', commits: [COMMIT] },
        proposedBase: { commit: PARENT, basis: 'commit-parent' },
      },
    });
  });
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const P0 = '0'.repeat(40);
const P1 = '1'.repeat(40);
const TARGET_TIP = 'e'.repeat(40);

describe('resolveReferenceSolution pull-request identifiers', () => {
  it.each([
    { description: 'a short-form reference', identifier: 'octo/repo#42' },
    { description: 'a URL reference', identifier: 'https://github.com/octo/repo/pull/42' },
  ])(
    'resolves $description through the pull-request reader and calls no Git method',
    async ({ identifier }) => {
      const resolveCommit = vi.fn(failingResolveCommit);
      const reader = buildPullRequestReader(buildPullRequestSnapshot());
      const dependencies = buildDependencies(resolveCommit, reader);

      const result = await resolveReferenceSolution(buildRequest({ identifier }), dependencies);

      expect(result.ok).toBe(true);
      expect(reader.readPullRequest).toHaveBeenCalledExactlyOnceWith(identifier);
      expect(resolveCommit).not.toHaveBeenCalled();
    },
  );

  it('propagates a pull-request reader failure unchanged', async () => {
    const reader: PullRequestReader = {
      readPullRequest: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'ReferenceResolutionError' as const,
          reason: 'pull request octo/repo#42 has no commits',
        },
      })),
    };
    const dependencies = buildDependencies(undefined, reader);

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'ReferenceResolutionError',
        reason: 'pull request octo/repo#42 has no commits',
      },
    });
  });
});

describe('resolveReferenceSolution first-commit parent', () => {
  it('finds the fork point of a linear branch', async () => {
    const snapshot = buildPullRequestSnapshot({
      commits: [commit(A, [P0]), commit(B, [A]), commit(C, [B])],
    });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullRequest?.firstCommitParent).toBe(P0);
  });

  it('finds the fork point through a commit that merges the target, keeping the branch-side parent', async () => {
    const snapshot = buildPullRequestSnapshot({
      commits: [commit(A, [P0]), commit(B, [A, TARGET_TIP])],
    });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullRequest?.firstCommitParent).toBe(P0);
  });

  it('defines the parent when two merged lines share the same external parent', async () => {
    const snapshot = buildPullRequestSnapshot({
      commits: [commit(A, [P0]), commit(B, [P0]), commit(C, [A, B])],
    });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullRequest?.firstCommitParent).toBe(P0);
  });

  it('reports E-FIRST-COMMITS when two merged lines start from different parents', async () => {
    const snapshot = buildPullRequestSnapshot({
      state: 'merged',
      commits: [commit(A, [P0]), commit(B, [P1]), commit(C, [A, B])],
    });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullRequest?.firstCommitParent).toBeUndefined();
    expect(result.value.pullRequest?.noProposedBase).toBe(
      `the commits of pull request octo/repo#42 start from 2 different parents (${P0.slice(0, 7)}, ${P1.slice(0, 7)}), so tevu cannot tell which commit it was built on`,
    );
  });

  it('reports E-FIRST-COMMITS for a first commit with several external parents', async () => {
    const snapshot = buildPullRequestSnapshot({ state: 'merged', commits: [commit(A, [P0, P1])] });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullRequest?.noProposedBase).toContain('2 different parents');
  });

  it('reports E-NO-PARENT for a commit with no parent at all', async () => {
    const snapshot = buildPullRequestSnapshot({ state: 'merged', commits: [commit(A, [])] });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullRequest?.noProposedBase).toBe(
      `first commit ${A.slice(0, 7)} of pull request octo/repo#42 has no parent`,
    );
  });
});

describe('resolveReferenceSolution proposed base by pull-request state and mergeability', () => {
  const linearCommits = [commit(A, [P0])];

  it('proposes the first-commit parent for a merged pull request, with no warning', async () => {
    const snapshot = buildPullRequestSnapshot({ state: 'merged', commits: linearCommits });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedBase).toEqual({ commit: P0, basis: 'first-commit-parent' });
    expect(result.value.pullRequest?.warning).toBeUndefined();
  });

  it('proposes the first-commit parent with the target-deleted warning when the target branch is gone', async () => {
    const snapshot = buildPullRequestSnapshot({ targetTip: null, commits: linearCommits });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedBase).toEqual({ commit: P0, basis: 'first-commit-parent' });
    expect(result.value.pullRequest?.warning).toBe('target-deleted');
  });

  it('proposes the first-commit parent with the conflicting warning', async () => {
    const snapshot = buildPullRequestSnapshot({
      mergeability: 'conflicting',
      commits: linearCommits,
    });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedBase).toEqual({ commit: P0, basis: 'first-commit-parent' });
    expect(result.value.pullRequest?.warning).toBe('conflicting');
  });

  it('proposes the target tip with the mergeability-unknown warning', async () => {
    const snapshot = buildPullRequestSnapshot({ mergeability: 'unknown', commits: linearCommits });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedBase).toEqual({ commit: TARGET_TIP, basis: 'target-tip' });
    expect(result.value.pullRequest?.warning).toBe('mergeability-unknown');
  });

  it('proposes the target tip with no warning for an open, mergeable pull request', async () => {
    const snapshot = buildPullRequestSnapshot({ state: 'open', commits: linearCommits });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedBase).toEqual({ commit: TARGET_TIP, basis: 'target-tip' });
    expect(result.value.pullRequest?.warning).toBeUndefined();
  });

  it('proposes the target tip with the closed warning for a closed, mergeable pull request', async () => {
    const snapshot = buildPullRequestSnapshot({ state: 'closed', commits: linearCommits });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedBase).toEqual({ commit: TARGET_TIP, basis: 'target-tip' });
    expect(result.value.pullRequest?.warning).toBe('closed');
  });

  it('proposes no base and no warning when the first-commit parent is undefined', async () => {
    const snapshot = buildPullRequestSnapshot({ state: 'merged', commits: [commit(A, [])] });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposedBase).toBeUndefined();
    expect(result.value.pullRequest?.warning).toBeUndefined();
    expect(result.value.pullRequest?.noProposedBase).toBeDefined();
  });
});

describe('resolveReferenceSolution pull-request reference block', () => {
  it('records every commit in order and a merge commit that is not one of them', async () => {
    const mergeCommit = 'd'.repeat(40);
    const snapshot = buildPullRequestSnapshot({
      state: 'merged',
      commits: [commit(A, [P0]), commit(B, [A])],
      mergeCommit,
    });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reference).toEqual({
      kind: 'pull-request',
      identifier: 'octo/repo#42',
      commits: [A, B],
      merge_commit: mergeCommit,
    });
  });

  it('omits merge_commit when the merge commit is already one of the listed commits', async () => {
    const snapshot = buildPullRequestSnapshot({
      state: 'merged',
      commits: [commit(A, [P0]), commit(B, [A])],
      mergeCommit: B,
    });
    const dependencies = buildDependencies(undefined, buildPullRequestReader(snapshot));

    const result = await resolveReferenceSolution(
      buildRequest({ identifier: 'octo/repo#42' }),
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reference).toEqual({
      kind: 'pull-request',
      identifier: 'octo/repo#42',
      commits: [A, B],
    });
  });
});
