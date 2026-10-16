/**
 * What several steps of the task wizard share: the request, the injected
 * effects, the progress the exit question reads, and warning helpers.
 */

import { log } from '@clack/prompts';

import { describeManagedCloneError } from '@/application/managed-clone';
import { promptOptions } from '@/interface/wizard-questions';

import type { CreateTaskErrorKind, TaskWizardInput } from '@/application/create-task';
import type { CriteriaDraftOutcome, CriteriaDraftRequest } from '@/application/draft-criteria';
import type { ManagedCommitsOutcome } from '@/application/managed-clone';
import type {
  AgentDraft,
  ModelAccessOutcome,
  ModelProviderInspection,
} from '@/application/model-access';
import type { ResolvedReferenceSolution } from '@/application/reference-solution';
import type { RepositoryInput } from '@/config/schema';
import type {
  JiraTrackerSettings,
  TaskDefinition,
  TaskReference,
  TevuConfig,
} from '@/domain/config';
import type {
  LoadConfigErrorKind,
  TevuError,
  TevuResult,
  ValidationFinding,
} from '@/domain/errors';
import type { ParsedGitHubRepository } from '@/domain/github-reference';
import type { IssueSnapshot } from '@/domain/ports/issue-tracker';
import type { AgentCapabilityReport } from '@/domain/run-records';
import type { LocalRepositoryNaming } from '@/interface/derived-identifiers';
import type { WizardIo } from '@/interface/wizard-questions';

/** Facts of one task add run that the exit question reads. */
export type WizardProgress = { holdsCriteriaDraft: boolean };

/** Command-line facts the task wizard starts from. */
export type TaskWizardRequest = {
  configPath: string;
  jiraIssueKey?: string | undefined;
  githubIssueReference?: string | undefined;
};

/** Injected effects for the task wizard; it triggers the single write through `createTask` and retries it on failure. */
export type TaskWizardDependencies = {
  io: WizardIo;
  /** Aborts when the operator interrupts the command; an aborted signal cancels every open or next question. */
  cancellation: AbortSignal;
  /** Reads and validates the existing configuration; `null` means the file is missing and its directory exists. */
  readConfig: () => Promise<
    TevuResult<TevuConfig | null, LoadConfigErrorKind | 'PrerequisiteError'>
  >;
  /** Reads one Jira issue exactly once with the given connection settings. */
  importJiraIssue: (
    settings: JiraTrackerSettings,
    issueKey: string,
  ) => Promise<TevuResult<IssueSnapshot, 'IssueImportError' | 'CancellationError'>>;
  /** Reads one GitHub issue exactly once through the operator's installed `gh`. */
  importGitHubIssue: (
    reference: string,
  ) => Promise<TevuResult<IssueSnapshot, 'IssueImportError' | 'CancellationError'>>;
  /** Resolves one reference-solution answer exactly once against the task's repository. */
  resolveReference: (
    repository: Pick<RepositoryInput, 'id' | 'path' | 'github'>,
    identifier: string,
    onProgress: (line: string) => void,
  ) => Promise<
    TevuResult<
      ResolvedReferenceSolution,
      'ReferenceResolutionError' | 'ManagedCloneError' | 'PrerequisiteError' | 'CancellationError'
    >
  >;
  /** Ensures a GitHub entry's managed clone holds `revisions`, cloning or fetching as needed. */
  ensureManagedCommits: (
    repository: { id: string; github: string },
    revisions: readonly string[],
    onProgress: (line: string) => void,
  ) => Promise<
    TevuResult<
      ManagedCommitsOutcome,
      'ManagedCloneError' | 'PrerequisiteError' | 'CancellationError'
    >
  >;
  /** Ensures a GitHub entry's managed clone holds the Git LFS objects of one base commit, fetching the missing ones. */
  ensureManagedLfsObjects: (
    repository: { id: string; github: string },
    revision: string,
    onProgress: (line: string) => void,
  ) => Promise<TevuResult<void, 'ManagedCloneError' | 'PrerequisiteError' | 'CancellationError'>>;
  now: () => Date;
  redact: (textContent: string) => string;
  /** Reads a GitHub repository's HEAD from its remote, proving it exists and is readable. */
  checkGitHubRepository: (
    repository: ParsedGitHubRepository,
  ) => Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
  /** Reports whether a local repository answer, resolved against the configuration file's directory, lies in a Git repository. */
  isGitRepository: (repositoryPath: string) => Promise<boolean>;
  /** Reads the directory name and `origin` remote URL of a local repository answer, resolved against the configuration file's directory. */
  readLocalRepositoryNaming: (repositoryPath: string) => Promise<LocalRepositoryNaming>;
  /** Reports whether a variable is set in this terminal. */
  isVariableSet: (name: string) => boolean;
  /** Drafts acceptance criteria and a Definition of Done from a resolved reference solution. */
  draftCriteria: (
    request: Omit<CriteriaDraftRequest, 'configPath'>,
  ) => Promise<CriteriaDraftOutcome>;
  /** Runs the agent's capability probe for an agent command as typed. */
  probeAgent: (
    command: string,
  ) => Promise<TevuResult<AgentCapabilityReport, 'PrerequisiteError' | 'AgentProtocolError'>>;
  /** Names the provider of a model and reads what the operator's configuration defines for it. */
  inspectModelProvider: (
    agent: AgentDraft,
    model: `${string}/${string}`,
  ) => Promise<TevuResult<ModelProviderInspection, 'ConfigValidationError'>>;
  /** Reports whether a model resolves for the agent in an environment built like a case agent's. */
  checkModelAccess: (
    agent: AgentDraft,
    model: `${string}/${string}`,
  ) => Promise<ModelAccessOutcome>;
  /** Inspects a base-commit answer the way the write pins it, so a refusal surfaces before the criteria draft. */
  inspectBaseCommit: (
    repository: Pick<RepositoryInput, 'id' | 'path' | 'github'>,
    baseCommit: string,
    reference: TaskReference | undefined,
  ) => Promise<TevuResult<void, 'SourceMaterializationError' | 'ConfigValidationError'>>;
  /** Reports the findings the write would raise for an output directory and repository entries as answered. */
  checkRepositoryPlacement: (
    outputDirectory: string,
    repositories: readonly Pick<RepositoryInput, 'id' | 'path' | 'github'>[],
  ) => Promise<readonly ValidationFinding[]>;
  /** Performs the single configuration write for the accepted review. */
  createTask: (input: TaskWizardInput) => Promise<TevuResult<TaskDefinition, CreateTaskErrorKind>>;
};

/** Renders a `ManagedCloneError` or `PrerequisiteError` for a wizard warning line. */
export function describeManagedCloneOrPrerequisiteFailure(
  error: Extract<TevuError, { kind: 'ManagedCloneError' | 'PrerequisiteError' }>,
): string {
  if (error.kind === 'ManagedCloneError') {
    return describeManagedCloneError(error);
  }
  return `prerequisite "${error.tool}" is not satisfied; expected ${error.expected}${error.actual === undefined ? '' : `, actual ${error.actual}`}`;
}

/**
 * Prints one warning: a headline, detail lines that quote a lower layer's
 * text unchanged, and an optional next step, all redacted together.
 */
export function warnLines(
  io: WizardIo,
  redact: (textContent: string) => string,
  lines: { headline: string; details?: readonly string[]; next?: string },
): void {
  const text = [
    lines.headline,
    ...(lines.details ?? []),
    ...(lines.next === undefined ? [] : [lines.next]),
  ].join('\n');
  log.warn(redact(text), promptOptions(io));
}

export const RETRY_NEXT_STEP = 'Press Enter to retry, or Ctrl-C to cancel.';

/** Warns that removing a temporary directory failed and where its remains are. */
export function warnRetainedDirectory(
  io: WizardIo,
  redact: (textContent: string) => string,
  directory: string,
): void {
  warnLines(io, redact, {
    headline: "Couldn't remove a temporary directory.",
    details: [directory],
  });
}

/** `<NAME> isn't set` for one variable, `<A>, <B> aren't set` for several. */
export function describeUnsetNames(names: readonly string[]): string {
  return names.length === 1 ? `${names.join(', ')} isn't set` : `${names.join(', ')} aren't set`;
}
