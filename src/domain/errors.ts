/** The result of every fallible contract and the typed error union. */

import type { ModelRoleName, SetupPhase } from './config';

/** Result of a fallible module contract; errors never cross boundaries as thrown exceptions. */
export type TevuResult<T, K extends TevuError['kind']> =
  { ok: true; value: T } | { ok: false; error: Extract<TevuError, { kind: K }> };

/** One aggregated parse or validation finding with a stable field, task, or check identifier. */
export type ValidationFinding = {
  severity: 'error' | 'warning';
  identifier: string;
  message: string;
};

/** Why the configuration file could not be read. */
export type ConfigReadCause = 'not-found' | 'permission-denied' | 'not-a-file' | 'unreadable';

/** Error kinds a configuration load can produce. */
export type LoadConfigErrorKind = 'ConfigParseError' | 'ConfigValidationError' | 'ConfigReadError';

/** Tracker behind an imported task source. */
type IssueTrackerKind = 'jira-cloud' | 'github-issue';

/** Exhaustive typed error union for every tevu failure crossing a module boundary. */
export type TevuError =
  | { kind: 'ConfigParseError'; findings: ValidationFinding[] }
  | { kind: 'ConfigValidationError'; findings: ValidationFinding[] }
  | {
      kind: 'ConfigReadError';
      /** Absolute path the loader probed: `path.resolve(requestedPath)`. */
      path: string;
      /** Path handed to the loader: `--config` exactly as given, or an absolute search candidate; the not-found hints embed it. */
      requestedPath: string;
      cause: ConfigReadCause;
    }
  | {
      kind: 'ConfigNotFoundError';
      /** Absolute paths the search read, in search order; the first is the current-directory file, which `task add` creates. */
      searchedPaths:
        [currentDirectoryFile: string] | [currentDirectoryFile: string, userFile: string];
    }
  | { kind: 'PrerequisiteError'; tool: string; expected: string; actual?: string }
  | { kind: 'SourceMaterializationError'; taskId: string; reason: string }
  | { kind: 'IsolationError'; caseId: string; reason: string }
  | {
      kind: 'IssueImportError';
      tracker: IssueTrackerKind;
      reference: string;
      /** HTTP status; only the Jira Cloud adapter sets it. */
      status?: number;
      reason: string;
    }
  | {
      kind: 'AgentProcessError';
      agent: string;
      caseId: string;
      exitCode: number | null;
      signal: string | null;
    }
  | {
      kind: 'AgentProtocolError';
      agent: string;
      context:
        | { phase: 'probe' }
        | { phase: 'case'; caseId: string }
        | { phase: 'call'; role: ModelRoleName };
      line?: number;
      reason: string;
    }
  | {
      kind: 'AgentSessionError';
      agent: string;
      caseId: string;
      /** First line of the agent's own error message, redacted; absent when the agent reported none. */
      agentMessage?: string;
    }
  | {
      kind: 'ModelCallError';
      role: ModelRoleName;
      agent: string;
      cause: 'launch-failed' | 'failed' | 'timed-out' | 'unfinished' | 'tool-call';
      reason: string;
      /** First line of the agent's own error message, redacted; absent when the agent reported none. */
      agentMessage?: string;
    }
  | { kind: 'CaseTimeoutError'; caseId: string; timeoutMs: number }
  | { kind: 'EvaluationError'; caseId: string; checkId: string; reason: string }
  | {
      kind: 'AssessmentConflictError';
      runId: string;
      caseId: string;
      reason: string;
    }
  | { kind: 'ArtifactError'; operation: string; reason: string }
  | { kind: 'RedactionError'; reason: string }
  | { kind: 'CancellationError'; activeCaseIds: string[] }
  | { kind: 'CheckStateError'; step: 'restore' | 'overlay'; reason: string }
  | { kind: 'SetupError'; phase: SetupPhase; argv: string[]; reason: string }
  | { kind: 'ReferenceResolutionError'; reason: string }
  | {
      kind: 'ManagedCloneError';
      operation: ManagedCloneOperation;
      /** Display form of the repository contacted for this operation. */
      repository: string;
      reason: string;
    };

/** The git operation a `ManagedCloneError` reports on. */
export type ManagedCloneOperation = 'clone' | 'fetch' | 'ls-remote' | 'lfs-fetch';
