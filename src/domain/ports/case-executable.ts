/** The `CaseExecutableAdapter` contract, with the request and result shapes only it uses. */

import type { TevuResult } from '@/domain/errors';

/** Why a `parent-only` replica run did not exit 0; never carries process output. */
type ReplicaFailure =
  | { kind: 'exited'; exitCode: number }
  | { kind: 'signaled'; signal: string }
  | { kind: 'not-started'; code: string | null };

/** Verdict of one case-executable probe. */
export type CaseExecutableVerdict =
  | { verdict: 'runs' }
  | { verdict: 'undetermined' }
  | { verdict: 'parent-only'; resolvedPath: string | null; replicaFailure: ReplicaFailure };

/** One case executable to probe and what its case environment adds to the fixed variables. */
export type CaseExecutableProbeRequest = {
  /** A bare name looked up on `path`, or an absolute path; never a relative path containing `/`. */
  executable: string;
  /** `ParentEnvironmentSnapshot.path`: the PATH every case environment receives. */
  path: string;
  /** The additions by name, with their snapshot values. */
  additions: Readonly<Record<string, string>>;
  /** Absolute working directory of both runs; absent means a new empty directory inside the probe directory. */
  workingDirectory?: string;
  /** Names the parent run omits even when `process.env` sets them. */
  withheldNames: readonly string[];
};

/** Paths one run changed in the working directory, relative to it; each list in ascending byte order. */
type RunChanges = {
  run: 'replica' | 'parent';
  added: string[];
  modified: string[];
  removed: string[];
};

/** What a probe's runs changed in `request.workingDirectory`. */
export type WorkingDirectoryChanges = {
  /** One entry per run whose directory snapshots before and after it both succeeded, in run order, even with empty lists. */
  runs: RunChanges[];
  /** Reason text for the first failed directory snapshot; the probe takes none after it. */
  failure?: string;
};

/** Outcome of one case-executable probe. */
export type CaseExecutableProbe = {
  verdict: CaseExecutableVerdict;
  /** Present exactly when the request sets `workingDirectory`. */
  changes?: WorkingDirectoryChanges;
};

/**
 * Probes whether a case executable runs unmodified in its case environment,
 * without changing any case environment; implemented in `src/adapters/process.ts`.
 */
export interface CaseExecutableAdapter {
  probe(
    request: CaseExecutableProbeRequest,
  ): Promise<TevuResult<CaseExecutableProbe, 'PrerequisiteError'>>;
}
