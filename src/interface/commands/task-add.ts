/** `tevu task add`: runs the task wizard over the operations its factory built. */

import { outro } from '@clack/prompts';

import { createStatusLine } from '@/interface/status-line';
import { runTaskWizard } from '@/interface/task-wizard/task-wizard';

import { createLineWriters, EXIT_CANCELLED, EXIT_COMPLETED, reportFailure } from './shared';

import type { CommandContext, ConfigOperations, ConfigOptionValues } from './shared';
import type { CreateTaskErrorKind, TaskWizardInput } from '@/application/create-task';
import type { CriteriaDraftOutcome, CriteriaDraftRequest } from '@/application/draft-criteria';
import type {
  ManagedCommitsOutcome,
  ManagedCommitsRequest,
  ManagedLfsObjectsRequest,
} from '@/application/managed-clone';
import type {
  AgentDraft,
  ModelAccessOutcome,
  ModelProviderInspection,
} from '@/application/model-access';
import type {
  ReferenceSolutionRequest,
  ResolvedReferenceSolution,
} from '@/application/reference-solution';
import type { RepositoryInput } from '@/config/schema';
import type {
  JiraTrackerSettings,
  TaskDefinition,
  TaskReference,
  TevuConfig,
} from '@/domain/config';
import type { LoadConfigErrorKind, TevuResult, ValidationFinding } from '@/domain/errors';
import type { ParsedGitHubRepository } from '@/domain/github-reference';
import type { IssueSnapshot } from '@/domain/ports/issue-tracker';
import type { AgentCapabilityReport } from '@/domain/run-records';
import type { LocalRepositoryNaming } from '@/interface/derived-identifiers';

export type TaskAddOptionValues = ConfigOptionValues & { jira?: string; github?: string };

export type TaskAddOperations = ConfigOperations & {
  configExists(configPath: string): Promise<boolean>;
  requireConfigDirectory(configPath: string): Promise<TevuResult<void, 'PrerequisiteError'>>;
  importJiraIssue(
    settings: JiraTrackerSettings,
    issueKey: string,
  ): Promise<TevuResult<IssueSnapshot, 'IssueImportError' | 'CancellationError'>>;
  importGitHubIssue(
    reference: string,
  ): Promise<TevuResult<IssueSnapshot, 'IssueImportError' | 'CancellationError'>>;
  resolveReference(
    request: ReferenceSolutionRequest,
    onProgress: (line: string) => void,
  ): Promise<
    TevuResult<
      ResolvedReferenceSolution,
      'ReferenceResolutionError' | 'ManagedCloneError' | 'PrerequisiteError' | 'CancellationError'
    >
  >;
  ensureManagedCommits(
    request: ManagedCommitsRequest,
    onProgress: (line: string) => void,
  ): Promise<
    TevuResult<
      ManagedCommitsOutcome,
      'ManagedCloneError' | 'PrerequisiteError' | 'CancellationError'
    >
  >;
  /** Ensures a GitHub entry's managed clone holds the Git LFS objects of one base commit, fetching the missing ones. */
  ensureManagedLfsObjects(
    request: ManagedLfsObjectsRequest,
    onProgress: (line: string) => void,
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'PrerequisiteError' | 'CancellationError'>>;
  /** Reads a GitHub repository's HEAD from its remote, proving it exists and is readable. */
  checkGitHubRepository(
    repository: ParsedGitHubRepository,
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
  /** Reports whether `repositoryPath`, resolved against the configuration file's directory, lies in a Git repository. */
  isGitRepository(configPath: string, repositoryPath: string): Promise<boolean>;
  /** Reads the directory name and `origin` remote URL of `repositoryPath`, resolved against the configuration file's directory. */
  readLocalRepositoryNaming(
    configPath: string,
    repositoryPath: string,
  ): Promise<LocalRepositoryNaming>;
  /** The names in `names` that are not set in tevu's own environment. */
  unsetVariables(names: readonly string[]): string[];
  /** Drafts acceptance criteria and a Definition of Done from a resolved reference solution. */
  draftCriteria(request: CriteriaDraftRequest): Promise<CriteriaDraftOutcome>;
  /** Runs the agent's capability probe for `command`, resolved against the configuration file's directory. */
  probeAgent(
    configPath: string,
    command: string,
  ): Promise<TevuResult<AgentCapabilityReport, 'PrerequisiteError' | 'AgentProtocolError'>>;
  /** Names the provider of `model` and reads what the operator's configuration defines for it. */
  inspectModelProvider(
    configPath: string,
    agent: AgentDraft,
    model: `${string}/${string}`,
  ): Promise<TevuResult<ModelProviderInspection, 'ConfigValidationError'>>;
  /** Reports whether `model` resolves for `agent` in an environment built like a case agent's. */
  checkModelAccess(
    configPath: string,
    agent: AgentDraft,
    model: `${string}/${string}`,
  ): Promise<ModelAccessOutcome>;
  /** Inspects a base-commit answer the way `createTask` pins it, without reading the configuration. */
  inspectBaseCommit(
    configPath: string,
    repository: Pick<RepositoryInput, 'id' | 'path' | 'github'>,
    baseCommit: string,
    reference: TaskReference | undefined,
  ): Promise<TevuResult<void, 'SourceMaterializationError' | 'ConfigValidationError'>>;
  /** Reports the `run.output_dir` and `repositories.*` findings a load would raise for answers as typed. */
  checkRepositoryPlacement(
    configPath: string,
    outputDirectory: string,
    repositories: readonly Pick<RepositoryInput, 'id' | 'path' | 'github'>[],
  ): Promise<ValidationFinding[]>;
  createTask(input: TaskWizardInput): Promise<TevuResult<TaskDefinition, CreateTaskErrorKind>>;
};

export async function runTaskAdd(
  operations: TaskAddOperations,
  context: CommandContext,
  options: TaskAddOptionValues,
): Promise<number> {
  const { out, err } = createLineWriters(context);
  const located = await operations.locateConfig(options.config);
  let absolutePath: string;
  if (located.ok) {
    absolutePath = located.value;
  } else if (located.error.kind === 'ConfigNotFoundError') {
    absolutePath = located.error.searchedPaths[0];
  } else {
    return reportFailure(err, located.error, context.redact);
  }
  const loaderPath = options.config ?? absolutePath;
  const wizard = await runTaskWizard(
    {
      configPath: loaderPath,
      jiraIssueKey: options.jira,
      githubIssueReference: options.github,
    },
    {
      io: {
        input: context.io.stdin,
        output: context.io.stdout,
        statusLine: createStatusLine(),
        waitInterrupt: context.waitInterrupt,
      },
      cancellation: context.cancellation,
      readConfig: async (): Promise<
        TevuResult<TevuConfig | null, LoadConfigErrorKind | 'PrerequisiteError'>
      > => {
        const exists = await operations.configExists(loaderPath);
        if (!exists) {
          const directory = await operations.requireConfigDirectory(loaderPath);
          if (!directory.ok) {
            return directory;
          }
          out(`Configuration: ${absolutePath}`);
          return { ok: true, value: null };
        }
        const loaded = await operations.loadConfig(loaderPath);
        if (loaded.ok || loaded.error.kind !== 'ConfigReadError') {
          out(`Configuration: ${absolutePath}`);
        }
        return loaded;
      },
      importJiraIssue: operations.importJiraIssue,
      importGitHubIssue: operations.importGitHubIssue,
      resolveReference: (repository, identifier, onProgress) =>
        operations.resolveReference({ configPath: loaderPath, repository, identifier }, onProgress),
      ensureManagedCommits: (repository, revisions, onProgress) =>
        operations.ensureManagedCommits({ repository, revisions }, onProgress),
      ensureManagedLfsObjects: (repository, revision, onProgress) =>
        operations.ensureManagedLfsObjects({ repository, revision }, onProgress),
      checkGitHubRepository: operations.checkGitHubRepository,
      isGitRepository: (repositoryPath) => operations.isGitRepository(loaderPath, repositoryPath),
      readLocalRepositoryNaming: (repositoryPath) =>
        operations.readLocalRepositoryNaming(loaderPath, repositoryPath),
      isVariableSet: (name) => operations.unsetVariables([name]).length === 0,
      draftCriteria: (request) => operations.draftCriteria({ configPath: loaderPath, ...request }),
      probeAgent: (command) => operations.probeAgent(loaderPath, command),
      inspectModelProvider: (agent, model) =>
        operations.inspectModelProvider(loaderPath, agent, model),
      checkModelAccess: (agent, model) => operations.checkModelAccess(loaderPath, agent, model),
      inspectBaseCommit: (repository, baseCommit, reference) =>
        operations.inspectBaseCommit(loaderPath, repository, baseCommit, reference),
      checkRepositoryPlacement: (outputDirectory, repositories) =>
        operations.checkRepositoryPlacement(loaderPath, outputDirectory, repositories),
      createTask: operations.createTask,
      now: context.now,
      redact: context.redact,
    },
  );
  if (!wizard.ok) {
    // The wizard already printed its single cancel line.
    return wizard.error.kind === 'CancellationError'
      ? EXIT_CANCELLED
      : reportFailure(err, wizard.error, context.redact);
  }
  outro(`Task ${wizard.value.id} added to ${loaderPath}`, { output: context.io.stdout });
  return EXIT_COMPLETED;
}
