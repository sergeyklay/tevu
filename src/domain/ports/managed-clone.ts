/** The `ManagedCloneAdapter` contract, with the result shape only it uses. */

import type { TevuResult } from '@/domain/errors';
import type { ParsedGitHubRepository } from '@/domain/github-reference';

/** Offline state of one managed-clone directory. */
export type CloneState = 'missing' | 'repository' | 'not-a-repository';

/**
 * Clones and fetches managed clones through git, with gh as git's credential
 * helper. Implemented over the local git CLI and gh; see `src/adapters/managed-clone.ts`.
 */
export interface ManagedCloneAdapter {
  /** Offline: no network, no gh, no write. */
  inspectClone(directory: string): Promise<CloneState>;
  /** Bare-clones `repository` into `directory`; succeeds without cloning when a clone appeared meanwhile. */
  clone(
    directory: string,
    repository: ParsedGitHubRepository,
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
  /** Fetches full commit hashes from `source`, each into `refs/tevu/fetched/<hash>`. */
  fetchCommits(
    directory: string,
    source: ParsedGitHubRepository,
    commits: readonly string[],
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
  /** Fetches every branch and tag of `repository`, force-updating `refs/heads/*` and `refs/tags/*`. */
  fetchBranchesAndTags(
    directory: string,
    repository: ParsedGitHubRepository,
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
  /** Reads `repository`'s HEAD from the remote without writing anything, proving it exists and is readable. */
  checkRemote(
    repository: ParsedGitHubRepository,
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
  /** Fetches every Git LFS object of `commit` that the clone in `directory` lacks, from the endpoint that `repository`'s clone URL implies. */
  fetchLfsObjects(
    directory: string,
    repository: ParsedGitHubRepository,
    commit: string,
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
}
