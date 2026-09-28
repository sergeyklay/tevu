/**
 * Interactive Clack wizards for `tevu task add` and `tevu assess`.
 *
 * Both wizards require an interactive TTY on stdin and stdout, ask one
 * question at a time with local re-prompting on invalid input, and return
 * typed inputs for the application use cases; the caller owns the only write.
 * Every effect (configuration read, one-time Jira import, assessment context
 * read, wall clock, redaction) is an injected callback, so no concrete
 * adapter, filesystem, Git, or Jira transport enters this module.
 */

import { confirm, intro, isCancel, log, note, select, text } from '@clack/prompts';

import { describeManagedCloneError } from '@/application/managed-clone';
import { describeReferenceIdentityInText } from '@/application/source-commit-in-prompt';
import {
  AGENT_NAMES,
  DurationSchema,
  referencedVariableName,
  VariableNameSchema,
} from '@/config/schema';
import {
  formatGitHubRepository,
  managedCloneLocation,
  parseGitHubRepository,
} from '@/domain/github-reference';

import type { AssessableCheckSummary, AssessmentCaseContext } from '@/application/assess';
import type { TaskWizardInput } from '@/application/create-task';
import type {
  CriteriaDraft,
  CriteriaDraftOutcome,
  CriteriaDraftRequest,
} from '@/application/draft-criteria';
import type { ManagedCommitsOutcome } from '@/application/managed-clone';
import type { ResolvedReferenceSolution } from '@/application/reference-solution';
import type {
  CheckInput,
  ModelDefinitionInput,
  RepositoryInput,
  TaskInput,
  TevuConfigInput,
} from '@/config/schema';
import type {
  AssessmentDecision,
  AssessmentInput,
  AssessmentRecord,
  IssueSnapshot,
  JiraTrackerSettings,
  LoadConfigErrorKind,
  RepositoryDefinition,
  TaskReference,
  TevuConfig,
  TevuError,
  TevuResult,
  ValidationFinding,
} from '@/domain/types';
import type { CANCEL_SYMBOL, Option } from '@clack/prompts';
import type { Readable, Writable } from 'node:stream';

/** Interactive streams the wizards prompt on; both must be TTYs. */
type WizardIo = {
  input: Readable & { isTTY?: boolean };
  output: Writable & { isTTY?: boolean };
};

/** Command-line facts the task wizard starts from. */
export type TaskWizardRequest = {
  configPath: string;
  jiraIssueKey?: string;
  githubIssueReference?: string;
};

/** Injected effects for the task wizard; it performs no write itself. */
export type TaskWizardDependencies = {
  io: WizardIo;
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
  now: () => Date;
  redact: (textContent: string) => string;
  /** Drafts acceptance criteria and a Definition of Done from a resolved reference solution. */
  draftCriteria: (
    request: Omit<CriteriaDraftRequest, 'configPath'>,
  ) => Promise<CriteriaDraftOutcome>;
};

/** Error kinds the task wizard can return. */
type TaskWizardErrorKind =
  | 'ConfigParseError'
  | 'ConfigValidationError'
  | 'ConfigReadError'
  | 'IssueImportError'
  | 'PrerequisiteError'
  | 'CancellationError';

/** Command-line facts the assessment wizard starts from. */
export type AssessmentWizardRequest = {
  runId: string;
  caseId: string;
};

/** Injected effects for the assessment wizard; it performs no write itself. */
export type AssessmentWizardDependencies = {
  io: WizardIo;
  /** Reads the case's manual checks and current assessment records from preserved artifacts. */
  readCaseContext: () => Promise<
    TevuResult<AssessmentCaseContext, 'ConfigValidationError' | 'ArtifactError'>
  >;
  now: () => Date;
  redact: (textContent: string) => string;
};

/** Error kinds the assessment wizard can return. */
type AssessmentWizardErrorKind =
  'ConfigValidationError' | 'ArtifactError' | 'PrerequisiteError' | 'CancellationError';

const ID_RULE = 'must match ^[a-z][a-z0-9-]{0,63}$';
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const FIXED_ENVIRONMENT_NAMES = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI']);
const NEW_REPOSITORY_CHOICE = '__add-new-repository__';
const GITHUB_GRAMMAR_MESSAGE =
  'github must be OWNER/REPO or https://HOST/OWNER/REPO, with a HOST of letters, digits, hyphens, and dots, and without surrounding spaces, user info, a port, a query, or a fragment';
/** A full commit hash: 40 (SHA-1) or 64 (SHA-256) lowercase hexadecimal characters. */
const FULL_COMMIT_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Renders a `ManagedCloneError` or `PrerequisiteError` for a wizard warning line. */
function describeManagedCloneOrPrerequisiteFailure(
  error: Extract<TevuError, { kind: 'ManagedCloneError' | 'PrerequisiteError' }>,
): string {
  if (error.kind === 'ManagedCloneError') {
    return describeManagedCloneError(error);
  }
  return `prerequisite "${error.tool}" is not satisfied; expected ${error.expected}${error.actual === undefined ? '' : `, actual ${error.actual}`}`;
}

/** Internal control-flow sentinel; never crosses the module boundary. */
class WizardCancelledError extends Error {
  constructor() {
    super('wizard cancelled');
  }
}

/**
 * Runs the `tevu task add` interview and returns the typed wizard input.
 *
 * Fails before any question when stdin or stdout is not a TTY, when an
 * existing configuration is invalid or cannot be read, or when the
 * configuration directory does not exist. When the configuration file is
 * missing and its directory exists, it bootstraps every required top-level
 * setting, at least one repository, and at least two models before the first
 * task question. A Jira source is imported exactly once and displayed; the
 * snapshot travels inside the returned input so task creation never reads
 * Jira again. The final redacted review must be accepted before the input is
 * returned; the caller then delegates the single configuration write to
 * `createTask`.
 */
export async function runTaskWizard(
  request: TaskWizardRequest,
  dependencies: TaskWizardDependencies,
): Promise<TevuResult<TaskWizardInput, TaskWizardErrorKind>> {
  const ttyFailure = requireInteractiveTty(dependencies.io);
  if (ttyFailure !== null) {
    return ttyFailure;
  }
  const existing = await dependencies.readConfig();
  if (!existing.ok) {
    return existing;
  }
  if (
    request.jiraIssueKey !== undefined &&
    existing.value !== null &&
    existing.value.trackers?.jira === undefined
  ) {
    return configValidationFailure([
      {
        severity: 'error',
        identifier: 'trackers.jira',
        message: 'task add --jira requires trackers.jira in the existing configuration',
      },
    ]);
  }
  const io = dependencies.io;
  intro('tevu task add', promptOptions(io));
  try {
    const bootstrap =
      existing.value === null
        ? await interviewBootstrap(io, request.jiraIssueKey !== undefined)
        : undefined;
    const input = await interviewTask(request, dependencies, existing.value, bootstrap);
    if (!input.ok) {
      return input;
    }
    const graderDeclared =
      existing.value === null
        ? bootstrap?.roles?.grader !== undefined
        : existing.value.roles?.grader !== undefined;
    await reviewAndConfirm(io, dependencies.redact, input.value, graderDeclared);
    return input;
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      log.warn('Task creation cancelled; the configuration is unchanged.', promptOptions(io));
      return cancellationFailure();
    }
    throw error;
  }
}

/**
 * Runs the `tevu assess` interview and returns the typed assessment input.
 *
 * Fails before any question when stdin or stdout is not a TTY or when the case
 * context cannot be read. Existing assessments are displayed and skipped
 * unless the assessor selects replacement and then confirms each replacement
 * individually; every pending required and optional manual check is processed
 * in configuration order. The UTC `assessedAt` timestamp comes from the
 * injected clock; the caller delegates the single write to `assessCase`.
 */
export async function runAssessmentWizard(
  request: AssessmentWizardRequest,
  dependencies: AssessmentWizardDependencies,
): Promise<TevuResult<AssessmentInput, AssessmentWizardErrorKind>> {
  const ttyFailure = requireInteractiveTty(dependencies.io);
  if (ttyFailure !== null) {
    return ttyFailure;
  }
  const context = await dependencies.readCaseContext();
  if (!context.ok) {
    return context;
  }
  if (context.value.checks.length === 0) {
    return configValidationFailure([
      {
        severity: 'error',
        identifier: request.caseId,
        message: `case "${request.caseId}" has no manual or graded checks; there is nothing to assess`,
      },
    ]);
  }
  const io = dependencies.io;
  const redact = dependencies.redact;
  intro(`tevu assess ${request.runId} ${request.caseId}`, promptOptions(io));
  try {
    const currentByCheck = new Map(
      context.value.existing.map((record) => [record.checkId, record]),
    );
    if (context.value.existing.length > 0) {
      note(
        redact(context.value.existing.map(renderAssessmentRecord).join('\n')),
        'Existing assessments',
        promptOptions(io),
      );
    }
    const assessor = await askText(io, {
      message: 'Assessor name',
      validate: validateNonWhitespace,
    });
    const decisions: AssessmentDecision[] = [];
    for (const check of context.value.checks) {
      log.step(redact(renderAssessableCheck(check)), promptOptions(io));
      const existingRecord = currentByCheck.get(check.checkId);
      if (existingRecord !== undefined) {
        log.info(redact(renderAssessmentRecord(existingRecord)), promptOptions(io));
        const wantsReplacement = await askConfirm(io, {
          message: `Replace the existing assessment for "${check.checkId}"?`,
          initialValue: false,
        });
        if (!wantsReplacement) {
          continue;
        }
        const verdict = await askVerdict(io, check.checkId);
        const noteText = await askNote(io, verdict);
        const confirmed = await askConfirm(io, {
          message: `Confirm replacing "${check.checkId}" (${existingRecord.verdict} -> ${verdict})?`,
          initialValue: false,
        });
        if (!confirmed) {
          log.info(`Kept the existing assessment for "${check.checkId}".`, promptOptions(io));
          continue;
        }
        decisions.push({
          checkId: check.checkId,
          verdict,
          assessor,
          note: noteText,
          replaceExisting: true,
        });
        continue;
      }

      if (check.evaluator === 'manual') {
        const verdict = await askVerdict(io, check.checkId);
        const noteText = await askNote(io, verdict);
        decisions.push({
          checkId: check.checkId,
          verdict,
          assessor,
          note: noteText,
          replaceExisting: false,
        });
        continue;
      }

      const grade = check.grade;
      if (grade === null) {
        log.info(
          redact(`"${check.checkId}" was not graded: no grading artifact was saved for this case`),
          promptOptions(io),
        );
        const verdict = await askVerdict(io, check.checkId);
        const noteText = await askNote(io, verdict);
        decisions.push({
          checkId: check.checkId,
          verdict,
          assessor,
          note: noteText,
          replaceExisting: false,
        });
        continue;
      }
      if (grade.status === 'pending') {
        log.info(redact(`"${check.checkId}" was not graded: ${grade.reason}`), promptOptions(io));
        const verdict = await askVerdict(io, check.checkId);
        const noteText = await askNote(io, verdict);
        decisions.push({
          checkId: check.checkId,
          verdict,
          assessor,
          note: noteText,
          replaceExisting: false,
        });
        continue;
      }
      const grader = check.grader;
      if (grader === null) {
        throw new Error('unreachable: a saved grade always carries a grader identity');
      }
      log.info(
        redact(
          `Grader verdict for "${check.checkId}": ${grade.verdict} (${grader.model}, effort ${grader.effort}): ${grade.rationale}`,
        ),
        promptOptions(io),
      );
      if (grade.verdict === 'undetermined') {
        const verdict = await askVerdict(io, check.checkId);
        const noteText = await askNote(io, verdict);
        decisions.push({
          checkId: check.checkId,
          verdict,
          assessor,
          note: noteText,
          replaceExisting: false,
        });
        continue;
      }
      const wantsReplacement = await askConfirm(io, {
        message: `Replace the grader's verdict for "${check.checkId}"?`,
        initialValue: false,
      });
      if (!wantsReplacement) {
        continue;
      }
      const verdict = await askVerdict(io, check.checkId);
      const noteText = await askNote(io, verdict);
      const confirmed = await askConfirm(io, {
        message: `Confirm replacing "${check.checkId}" (grader ${grade.verdict} -> ${verdict})?`,
        initialValue: false,
      });
      if (!confirmed) {
        log.info(`Kept the grader's verdict for "${check.checkId}".`, promptOptions(io));
        continue;
      }
      decisions.push({
        checkId: check.checkId,
        verdict,
        assessor,
        note: noteText,
        replaceExisting: true,
      });
    }
    return {
      ok: true,
      value: {
        runId: request.runId,
        caseId: request.caseId,
        decisions,
        assessedAt: dependencies.now().toISOString(),
      },
    };
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      log.warn('Assessment cancelled; nothing was recorded.', promptOptions(io));
      return cancellationFailure();
    }
    throw error;
  }
}

/** Captures every required top-level setting for a missing configuration file. */
async function interviewBootstrap(
  io: WizardIo,
  requireJira: boolean,
): Promise<Omit<TevuConfigInput, 'version' | 'tasks'>> {
  log.info(
    'No configuration file exists yet; capturing the complete configuration first.',
    promptOptions(io),
  );
  const outputDirectory = await askText(io, {
    message: 'Run output directory (outside every repository, relative to the configuration file)',
    validate: validateNonWhitespace,
  });
  const concurrency = await askInteger(io, 'Concurrent cases (1-32)', 1, 32);
  const timeout = await askText(io, {
    message: 'Agent time limit per case (for example 10m)',
    validate: validateDuration,
  });
  const stopGrace = await askText(io, {
    message: 'Grace period before a forced stop (for example 3s)',
    validate: validateDuration,
  });
  const checkTimeoutRaw = await askText(io, {
    message: 'Default time limit for command checks (for example 5m; empty to set one per check)',
    defaultValue: '',
    validate: (value) =>
      value === undefined || value.trim().length === 0 ? undefined : validateDuration(value),
  });
  const command = await askText(io, {
    message: `Command for agent "${AGENT_NAMES[0]}" (name on PATH, or a path relative to the configuration file)`,
    validate: validateNonWhitespace,
  });
  const takenNames = new Set<string>();
  const secrets = await interviewVariableList(io, 'secret', takenNames);
  const env = await interviewVariableList(io, 'ordinary', takenNames);
  const agentNames = new Set([...secrets, ...env]);
  const jira = await interviewJiraSettings(io, requireJira, agentNames);
  const repositories = await interviewRepositories(io);
  const models = await interviewModels(io);
  const grader = await interviewModelRole(io, 'grader');
  const criteria = await interviewModelRole(io, 'criteria');
  return {
    run: {
      output_dir: outputDirectory,
      concurrency,
      timeout,
      stop_grace: stopGrace,
      ...(checkTimeoutRaw.trim().length === 0 ? {} : { check_timeout: checkTimeoutRaw.trim() }),
    },
    agents: { [AGENT_NAMES[0]]: { command, secrets, env } },
    ...(jira === undefined ? {} : { trackers: { jira } }),
    repositories,
    models,
    ...(criteria === undefined && grader === undefined
      ? {}
      : {
          roles: {
            ...(criteria === undefined ? {} : { criteria }),
            ...(grader === undefined ? {} : { grader }),
          },
        }),
  };
}

/** One role's setup-interview texts: the confirm, the credential info line, and the two follow-up questions. */
type ModelRoleQuestionText = {
  confirm: string;
  credentialInfo: string;
  modelQuestion: string;
  effortQuestion: string;
};

const MODEL_ROLE_QUESTION_TEXT: Record<'criteria' | 'grader', ModelRoleQuestionText> = {
  grader: {
    confirm: 'Declare a grader model for graded checks?',
    credentialInfo: `The grader's provider credential must be one of the secret variables of agent "${AGENT_NAMES[0]}"; every case agent of "${AGENT_NAMES[0]}" receives it too.`,
    modelQuestion: 'Grader model (provider/model)',
    effortQuestion: 'Grader reasoning effort (a variant the agent provides without a repository)',
  },
  criteria: {
    confirm: 'Declare a criteria model to draft criteria from a reference solution?',
    credentialInfo: `The criteria model's provider credential must be one of the secret variables of agent "${AGENT_NAMES[0]}"; every case agent of "${AGENT_NAMES[0]}" receives it too.`,
    modelQuestion: 'Criteria model (provider/model)',
    effortQuestion: 'Criteria reasoning effort (a variant the agent provides without a repository)',
  },
};

/** Captures an optional `roles.<roleName>` declaration during bootstrap; absent on decline. */
async function interviewModelRole(
  io: WizardIo,
  roleName: 'criteria' | 'grader',
): Promise<{ model: `${string}/${string}`; effort: string } | undefined> {
  const texts = MODEL_ROLE_QUESTION_TEXT[roleName];
  const wantsRole = await askConfirm(io, { message: texts.confirm, initialValue: true });
  if (!wantsRole) {
    return undefined;
  }
  log.info(texts.credentialInfo, promptOptions(io));
  const model = await askModelRoleIdentifier(io, texts.modelQuestion);
  const effort = await askText(io, {
    message: texts.effortQuestion,
    validate: validateNonWhitespace,
  });
  return { model, effort };
}

/** Asks a model-role question, re-prompting until the answer is a valid `provider/model` identifier. */
async function askModelRoleIdentifier(
  io: WizardIo,
  message: string,
): Promise<`${string}/${string}`> {
  for (;;) {
    const value = await askText(io, { message, validate: validateModel });
    if (isModelIdentifier(value)) {
      return value;
    }
  }
}

/** Collects one pass-through agent variable list, names only, unique across both lists. */
async function interviewVariableList(
  io: WizardIo,
  kind: 'secret' | 'ordinary',
  takenNames: Set<string>,
): Promise<string[]> {
  const names: string[] = [];
  for (;;) {
    const wantsEntry = await askConfirm(io, {
      message:
        names.length === 0
          ? `Add a ${kind} variable for the agent${kind === 'secret' ? ' (name only, never the value)' : ''}?`
          : `Add another ${kind} variable for the agent?`,
      initialValue: false,
    });
    if (!wantsEntry) {
      return names;
    }
    const name = await askText(io, {
      message: kind === 'secret' ? 'Secret variable name' : 'Variable name',
      validate: validateVariableName(takenNames),
    });
    takenNames.add(name);
    names.push(name);
  }
}

/** Captures optional Jira Cloud settings; forced when `task add --jira` started the wizard. */
async function interviewJiraSettings(
  io: WizardIo,
  requireJira: boolean,
  agentNames: ReadonlySet<string>,
): Promise<JiraTrackerSettings | undefined> {
  const wantsJira =
    requireJira ||
    (await askConfirm(io, {
      message: 'Configure Jira Cloud issue import?',
      initialValue: false,
    }));
  if (!wantsJira) {
    return undefined;
  }
  const validateCredentialName = (raw: string | undefined): string | undefined => {
    const grammar = validateVariableNameGrammar(raw ?? '');
    if (grammar !== undefined) {
      return grammar;
    }
    if (agentNames.has(raw ?? '')) {
      return 'Jira credential variables must not also be passed to the agent';
    }
    return undefined;
  };
  const url = await askText(io, {
    message: 'Jira Cloud site URL (https)',
    validate: validateHttpsUrl,
  });
  const email = await askText(io, {
    message: 'Variable holding the Jira account email',
    validate: validateCredentialName,
  });
  const token = await askText(io, {
    message: 'Variable holding the Jira API token',
    validate: validateCredentialName,
  });
  return { url, email: `$${email}`, token: `$${token}` };
}

/** Collects at least one source repository during bootstrap. */
async function interviewRepositories(io: WizardIo): Promise<RepositoryInput[]> {
  const repositories: RepositoryInput[] = [];
  const usedIds = new Set<string>();
  do {
    const entry = await interviewRepositoryEntry(io, usedIds);
    usedIds.add(entry.id);
    repositories.push(entry);
  } while (await askConfirm(io, { message: 'Add another repository?', initialValue: false }));
  return repositories;
}

/**
 * Asks the ID and source of one repository: a local path, or a GitHub
 * repository tevu clones itself.
 *
 * A GitHub entry's `path` is set to its managed-clone location up front, the
 * same value the configuration schema derives on load, so every downstream
 * consumer (reference resolution, base-commit fetching) locates the clone
 * the same way whether the entry came from the file or from this interview.
 */
async function interviewRepositoryEntry(
  io: WizardIo,
  usedIds: ReadonlySet<string>,
): Promise<RepositoryDefinition> {
  const id = await askText(io, {
    message: 'Repository ID',
    validate: validateId(usedIds),
  });
  const source = await askSelect<'path' | 'github'>(io, {
    message: `Where does tevu read repository "${id}" from?`,
    options: [
      { value: 'path', label: 'Local path' },
      { value: 'github', label: 'GitHub repository, cloned by tevu' },
    ],
  });
  if (source === 'path') {
    const path = await askText(io, {
      message: `Local path of repository "${id}" (relative to the configuration file)`,
      validate: validateNonWhitespace,
    });
    return { id, path };
  }
  const github = await askGitHubRepository(io, id);
  return { id, path: managedCloneLocation(github), github: github.text };
}

/** Asks a GitHub repository answer, re-prompting with the grammar message until it parses. */
async function askGitHubRepository(
  io: WizardIo,
  id: string,
): Promise<{ host: string; owner: string; repo: string; text: string }> {
  const text = (
    await askText(io, {
      message: `GitHub repository of "${id}" (OWNER/REPO, or https://HOST/OWNER/REPO for GitHub Enterprise Server)`,
      validate: (value) =>
        parseGitHubRepository((value ?? '').trim()) === null ? GITHUB_GRAMMAR_MESSAGE : undefined,
    })
  ).trim();
  const parsed = parseGitHubRepository(text);
  if (parsed === null) {
    throw new Error('unreachable: askText only returns a value its validate callback accepted');
  }
  return { ...parsed, text };
}

/** Collects at least two model entries during bootstrap. */
async function interviewModels(io: WizardIo): Promise<ModelDefinitionInput[]> {
  const models: ModelDefinitionInput[] = [];
  const usedIds = new Set<string>();
  for (;;) {
    const id = await askText(io, {
      message: 'Model entry ID',
      validate: validateId(usedIds),
    });
    const model = await askModel(io, id);
    const effort = await askText(io, {
      message: `Reasoning effort for "${id}" (passed to the agent verbatim)`,
      validate: validateNonWhitespace,
    });
    usedIds.add(id);
    models.push({ id, model, effort });
    if (models.length < 2) {
      log.info('A runnable configuration needs at least two model entries.', promptOptions(io));
      continue;
    }
    const wantsMore = await askConfirm(io, {
      message: 'Add another model?',
      initialValue: false,
    });
    if (!wantsMore) {
      return models;
    }
  }
}

/** Interviews for one complete task after any bootstrap answers were captured. */
async function interviewTask(
  request: TaskWizardRequest,
  dependencies: TaskWizardDependencies,
  existing: TevuConfig | null,
  bootstrap: Omit<TevuConfigInput, 'version' | 'tasks'> | undefined,
): Promise<TevuResult<TaskWizardInput, 'IssueImportError'>> {
  const io = dependencies.io;
  const jiraSettings = existing?.trackers?.jira ?? bootstrap?.trackers?.jira;
  const source = await interviewSource(request, dependencies, jiraSettings);
  if (!source.ok) {
    return source;
  }
  const repositories = existing?.repositories ?? bootstrap?.repositories ?? [];
  const { repo, newRepository, selectedRepository } = await selectTaskRepository(
    io,
    dependencies,
    repositories,
  );
  const resolvedReference = await interviewReferenceSolution(io, dependencies, selectedRepository);
  const baseCommitAnswer =
    resolvedReference === undefined || resolvedReference.proposedBase === undefined
      ? (
          await askText(io, {
            message: 'Base commit (a commit from before the fix; resolved and pinned when saved)',
            validate: validateNonWhitespace,
          })
        ).trim()
      : await askBaseCommitWithProposal(io, resolvedReference);
  const baseCommit = await ensureBaseCommitInClone(
    io,
    dependencies,
    selectedRepository,
    resolvedReference,
    baseCommitAnswer,
  );
  const taskId = await askText(io, {
    message: 'Task ID',
    validate: validateId(new Set((existing?.tasks ?? []).map((task) => task.id))),
  });
  const title = await askText(io, {
    message: 'Task title',
    ...(source.value.importedTitle === undefined
      ? {}
      : { initialValue: source.value.importedTitle }),
    validate: validateNonWhitespace,
  });
  const description = await askText(io, {
    message: 'Task description',
    validate: validateNonWhitespace,
  });
  const prompt = await askText(io, {
    message: 'Task prompt sent to every model',
    validate: validateNonWhitespace,
  });
  const readiness = await interviewReadiness(io);
  const usedCheckIds = new Set<string>();
  const configuredAgents = existing?.agents ?? bootstrap?.agents ?? {};
  const agentNames = new Set(
    Object.values(configuredAgents).flatMap((settings) => [
      ...(settings.secrets ?? []),
      ...(settings.env ?? []),
    ]),
  );
  const jiraNames = new Set(
    jiraSettings === undefined
      ? []
      : [referencedVariableName(jiraSettings.email), referencedVariableName(jiraSettings.token)],
  );
  const excludedNames = new Set([...agentNames, ...jiraNames]);
  const { acceptance, done } = await interviewCriteria(
    io,
    dependencies,
    existing,
    bootstrap,
    resolvedReference,
    selectedRepository,
    description,
    usedCheckIds,
    excludedNames,
  );
  const task: TaskInput = {
    id: taskId,
    title,
    repo,
    base_commit: baseCommit,
    prompt,
    description,
    ...(source.value.source === undefined ? {} : { source: source.value.source }),
    ...(resolvedReference === undefined ? {} : { reference: resolvedReference.reference }),
    readiness,
    checks: { acceptance, done },
  };
  return {
    ok: true,
    value: {
      configPath: request.configPath,
      ...(bootstrap === undefined ? {} : { bootstrap }),
      ...(newRepository === undefined ? {} : { newRepository }),
      task,
    },
  };
}

/** One selected task source: the stored `source` block, and an imported title for the title prompt. */
type SourceSelection = { source: TaskInput['source']; importedTitle?: string };

/** Selects the task source; a Jira or GitHub issue is imported once and displayed. */
async function interviewSource(
  request: TaskWizardRequest,
  dependencies: TaskWizardDependencies,
  jiraSettings: JiraTrackerSettings | undefined,
): Promise<TevuResult<SourceSelection, 'IssueImportError'>> {
  const io = dependencies.io;
  const kind =
    request.jiraIssueKey !== undefined
      ? 'jira'
      : request.githubIssueReference !== undefined
        ? 'github'
        : await askSelect<'manual' | 'jira' | 'github'>(io, {
            message: 'Task source',
            options: [
              { value: 'manual', label: 'Written by hand' },
              {
                value: 'jira',
                label: 'Jira Cloud import',
                ...(jiraSettings === undefined
                  ? { disabled: true, hint: 'requires trackers.jira' }
                  : {}),
              },
              { value: 'github', label: 'GitHub issue import' },
            ],
          });
  if (kind === 'manual') {
    return { ok: true, value: { source: undefined } };
  }
  if (kind === 'github') {
    return interviewImportedSource(io, dependencies, 'github', async () => {
      const reference =
        request.githubIssueReference ??
        (
          await askText(io, {
            message: 'GitHub issue (OWNER/REPO#NUMBER or issue URL)',
            validate: validateNonWhitespace,
          })
        ).trim();
      return unwrapImportResult(await dependencies.importGitHubIssue(reference));
    });
  }
  if (jiraSettings === undefined) {
    // Unreachable through prompts (the option is disabled), reachable only
    // with --jira, which the caller validated; keep the abort explicit.
    return {
      ok: false,
      error: {
        kind: 'IssueImportError',
        tracker: 'jira-cloud',
        reference: request.jiraIssueKey ?? '',
        reason: 'Jira import is not available because no Jira settings are configured',
      },
    };
  }
  return interviewImportedSource(io, dependencies, 'jira', async () => {
    const issueKey =
      request.jiraIssueKey ??
      (
        await askText(io, {
          message: 'Jira issue key',
          validate: validateNonWhitespace,
        })
      ).trim();
    return unwrapImportResult(await dependencies.importJiraIssue(jiraSettings, issueKey));
  });
}

/** Imports one tracker issue once, displays it, and builds its stored source block. */
async function interviewImportedSource(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  kind: 'jira' | 'github',
  importIssue: () => Promise<TevuResult<IssueSnapshot, 'IssueImportError'>>,
): Promise<TevuResult<SourceSelection, 'IssueImportError'>> {
  const imported = await importIssue();
  if (!imported.ok) {
    return imported;
  }
  const importedAt = dependencies.now().toISOString();
  note(
    dependencies.redact(`${imported.value.summary}\n\n${imported.value.description}`),
    `Imported ${imported.value.issueKey} (one-time snapshot)`,
    promptOptions(io),
  );
  return {
    ok: true,
    value: {
      source: {
        kind,
        key: imported.value.issueKey,
        url: imported.value.issueUrl,
        imported_at: importedAt,
        title: imported.value.summary,
        body: imported.value.description,
      },
      importedTitle: imported.value.summary,
    },
  };
}

/** Picks the task repository from configured entries or captures a new one. */
async function interviewRepositorySelection(
  io: WizardIo,
  // Accepts both a resolved `TevuConfig`'s repositories and a bootstrap
  // interview's, which never carry `setup`; only `id`, `path`, and `github` are read.
  repositories: readonly Pick<RepositoryInput, 'id' | 'path' | 'github'>[],
): Promise<{ repo: string; newRepository?: RepositoryDefinition }> {
  const choice = await askSelect<string>(io, {
    message: 'Task repository',
    options: [
      ...repositories.map((repository) => ({
        value: repository.id,
        label:
          repository.github === undefined
            ? `${repository.id} (${repository.path})`
            : `${repository.id} (GitHub ${repository.github})`,
      })),
      { value: NEW_REPOSITORY_CHOICE, label: 'Add a new repository' },
    ],
  });
  if (choice !== NEW_REPOSITORY_CHOICE) {
    return { repo: choice };
  }
  const entry = await interviewRepositoryEntry(
    io,
    new Set(repositories.map((repository) => repository.id)),
  );
  return { repo: entry.id, newRepository: entry };
}

/** Recovers the full repository entry `interviewRepositorySelection` chose, by id or as a new entry. */
function resolveSelectedRepository(
  repositories: readonly Pick<RepositoryInput, 'id' | 'path' | 'github'>[],
  repo: string,
  newRepository: RepositoryDefinition | undefined,
): Pick<RepositoryInput, 'id' | 'path' | 'github'> {
  if (newRepository !== undefined) {
    return newRepository;
  }
  const found = repositories.find((repository) => repository.id === repo);
  if (found === undefined) {
    throw new Error('unreachable: interviewRepositorySelection returns an id from its own options');
  }
  return found;
}

/**
 * Selects the task repository, ensuring a GitHub entry's managed clone right
 * after selection; a `ManagedCloneError` warns and re-asks the repository
 * select, keeping every earlier answer.
 */
async function selectTaskRepository(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  repositories: readonly Pick<RepositoryInput, 'id' | 'path' | 'github'>[],
): Promise<{
  repo: string;
  newRepository?: RepositoryDefinition;
  selectedRepository: Pick<RepositoryInput, 'id' | 'path' | 'github'>;
}> {
  for (;;) {
    const selection = await interviewRepositorySelection(io, repositories);
    const selectedRepository = resolveSelectedRepository(
      repositories,
      selection.repo,
      selection.newRepository,
    );
    const { github } = selectedRepository;
    if (github === undefined) {
      return { ...selection, selectedRepository };
    }
    const ensured = await dependencies.ensureManagedCommits(
      { id: selectedRepository.id, github },
      [],
      (line) => log.step(dependencies.redact(line), promptOptions(io)),
    );
    if (ensured.ok) {
      return { ...selection, selectedRepository };
    }
    if (ensured.error.kind === 'CancellationError') {
      throw new WizardCancelledError();
    }
    log.warn(
      dependencies.redact(
        `Repository "${selectedRepository.id}" cannot be used: ${describeManagedCloneOrPrerequisiteFailure(ensured.error)}`,
      ),
      promptOptions(io),
    );
  }
}

/**
 * Interviews for the optional reference-solution answer, resolving it once
 * and re-asking on any failure other than cancellation.
 */
async function interviewReferenceSolution(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  repository: Pick<RepositoryInput, 'id' | 'path' | 'github'>,
): Promise<ResolvedReferenceSolution | undefined> {
  for (;;) {
    const identifier = (
      await askText(io, {
        message: `Reference solution: a pull request (OWNER/REPO#NUMBER or URL) or a commit in "${repository.id}" (empty for none)`,
      })
    ).trim();
    if (identifier === '') {
      return undefined;
    }
    const result = await dependencies.resolveReference(repository, identifier, (line) =>
      log.step(dependencies.redact(line), promptOptions(io)),
    );
    if (result.ok) {
      const resolved = result.value;
      const warningText = describeReferenceWarning(resolved);
      if (warningText !== undefined) {
        log.warn(dependencies.redact(warningText), promptOptions(io));
      }
      const unfetched = resolved.pullRequest?.unfetched;
      if (unfetched !== undefined) {
        log.warn(
          dependencies.redact(`Reference commits cannot be fetched: ${unfetched}`),
          promptOptions(io),
        );
      }
      note(
        dependencies.redact(renderReferenceNote(resolved, repository.id)),
        'Reference solution (read once)',
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
    log.warn(
      dependencies.redact(`Reference solution cannot be resolved: ${description}`),
      promptOptions(io),
    );
  }
}

/**
 * Ensures a GitHub entry's base-commit answer resolves in its managed clone
 * before the `Task ID` question; a path entry returns the answer unchanged.
 *
 * A commit still missing after the fetch keeps the answer unchanged for a
 * pull-request task whose answer is a full hash, per `resolveTaskBaseCommit`'s
 * own rule; any other answer is re-asked with itself as the default.
 */
async function ensureBaseCommitInClone(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  repository: Pick<RepositoryInput, 'id' | 'path' | 'github'>,
  resolvedReference: ResolvedReferenceSolution | undefined,
  initialAnswer: string,
): Promise<string> {
  const { github } = repository;
  if (github === undefined) {
    return initialAnswer;
  }
  let answer = initialAnswer;
  for (;;) {
    const ensured = await dependencies.ensureManagedCommits(
      { id: repository.id, github },
      [answer],
      (line) => log.step(dependencies.redact(line), promptOptions(io)),
    );
    if (!ensured.ok) {
      if (ensured.error.kind === 'CancellationError') {
        throw new WizardCancelledError();
      }
      log.warn(
        dependencies.redact(
          `Base commit cannot be fetched: ${describeManagedCloneOrPrerequisiteFailure(ensured.error)}`,
        ),
        promptOptions(io),
      );
    } else if (ensured.value.missing.includes(answer)) {
      const keepsUnfetchedAnswer =
        resolvedReference?.reference.kind === 'pull-request' &&
        FULL_COMMIT_HASH_PATTERN.test(answer);
      if (keepsUnfetchedAnswer) {
        return answer;
      }
      const parsed = parseGitHubRepository(github);
      const display = parsed === null ? github : formatGitHubRepository(parsed);
      log.warn(
        dependencies.redact(
          `Base commit "${answer}" is not in repository "${repository.id}" and cannot be fetched from ${display}`,
        ),
        promptOptions(io),
      );
    } else {
      return answer;
    }
    answer = (
      await askText(io, {
        message: 'Base commit (a commit from before the fix; resolved and pinned when saved)',
        defaultValue: answer,
        validate: validateNonWhitespace,
      })
    ).trim();
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

/** Renders the `Reference solution (read once)` note body. */
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

/** Asks the base-commit question with the resolved reference's proposed base as its default. */
async function askBaseCommitWithProposal(
  io: WizardIo,
  resolved: ResolvedReferenceSolution,
): Promise<string> {
  const proposedBase = resolved.proposedBase;
  if (proposedBase === undefined) {
    throw new Error('unreachable: askBaseCommitWithProposal requires a resolved proposed base');
  }
  const answer = (
    await askText(io, {
      message: `Base commit (empty for ${proposedBase.commit}, ${describeProposedBaseBasis(resolved)})`,
      placeholder: proposedBase.commit,
      defaultValue: proposedBase.commit,
    })
  ).trim();
  return answer === '' ? proposedBase.commit : answer;
}

/** Collects at least one readiness item, never sent to the agent. */
async function interviewReadiness(io: WizardIo): Promise<string[]> {
  const items: string[] = [];
  for (;;) {
    const item = await askText(io, {
      message: 'Readiness item you have confirmed',
      validate: validateNonWhitespace,
    });
    items.push(item);
    const wantsMore = await askConfirm(io, {
      message: 'Add another readiness item?',
      initialValue: false,
    });
    if (!wantsMore) {
      return items;
    }
  }
}

/**
 * Collects one check collection until it contains at least one required
 * check.
 *
 * Starts from a copy of `drafted`; when it is non-empty, asks whether to add
 * another check of this collection before entering today's loop, so an
 * accepted draft with no further checks needs no additional question.
 */
async function interviewChecks(
  io: WizardIo,
  collection: 'acceptance' | 'done',
  usedCheckIds: Set<string>,
  excludedNames: ReadonlySet<string>,
  drafted: CheckInput[] = [],
): Promise<CheckInput[]> {
  const checks: CheckInput[] = [...drafted];
  if (drafted.length > 0) {
    const wantsMore = await askConfirm(io, {
      message: `Add another ${collection} check?`,
      initialValue: false,
    });
    if (!wantsMore) {
      return checks;
    }
  }
  for (;;) {
    const id = await askText(io, {
      message: `New ${collection} check ID`,
      validate: validateId(usedCheckIds),
    });
    const kind = await askSelect<'graded' | 'command' | 'manual'>(io, {
      message: `How is "${id}" checked?`,
      options: [
        { value: 'graded', label: 'Graded by the grader model against its description' },
        { value: 'command', label: 'Command (literal argv, no shell)' },
        { value: 'manual', label: 'Manual (assessed through tevu assess)' },
      ],
      initialValue: 'graded',
    });
    const description = await askText(
      io,
      kind === 'graded'
        ? {
            message: `Description of "${id}" (the criterion the grader grades against)`,
            validate: validateNonWhitespace,
          }
        : { message: `Description of "${id}"`, defaultValue: '' },
    );
    const required = await askConfirm(io, {
      message: `Is "${id}" required?`,
      initialValue: true,
    });
    const check: CheckInput =
      kind === 'manual'
        ? { id, description, manual: true, ...(required ? {} : { required }) }
        : kind === 'graded'
          ? { id, description, ...(required ? {} : { required }) }
          : {
              id,
              description,
              ...(await interviewCommandEvaluator(io, id, excludedNames)),
              ...(required ? {} : { required }),
            };
    usedCheckIds.add(id);
    checks.push(check);
    if (!checks.some((candidate) => candidate.required !== false)) {
      log.info(`At least one required ${collection} check is needed.`, promptOptions(io));
      continue;
    }
    const wantsMore = await askConfirm(io, {
      message: `Add another ${collection} check?`,
      initialValue: false,
    });
    if (!wantsMore) {
      return checks;
    }
  }
}

/** Asks argv, timeout, exit codes, and the variable list of one command check. */
async function interviewCommandEvaluator(
  io: WizardIo,
  checkId: string,
  excludedNames: ReadonlySet<string>,
): Promise<Pick<CheckInput, 'run' | 'timeout' | 'exit_codes' | 'env'>> {
  const argvText = await askText(io, {
    message: `Command for "${checkId}" as a JSON array, e.g. ["npm","test"]`,
    validate: validateArgvJson,
  });
  const run = JSON.parse(argvText) as [string, ...string[]];
  const timeoutRaw = await askText(io, {
    message: `Time limit for "${checkId}" (for example 2m; empty to use run.check_timeout)`,
    defaultValue: '',
    validate: (value) =>
      value === undefined || value.trim().length === 0 ? undefined : validateDuration(value),
  });
  const codesText = await askText(io, {
    message: `Exit codes that count as a pass for "${checkId}" (comma-separated; empty for 0)`,
    defaultValue: '0',
    validate: validateExitCodes,
  });
  const exitCodes = codesText
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => Number.parseInt(token, 10));
  const envText = await askText(io, {
    message: `Variables for "${checkId}" (comma-separated names; empty for none)`,
    defaultValue: '',
    validate: validateCheckVariableList(excludedNames),
  });
  const env = envText
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return {
    run,
    ...(timeoutRaw.trim().length === 0 ? {} : { timeout: timeoutRaw.trim() }),
    ...(exitCodes.length === 1 && exitCodes[0] === 0 ? {} : { exit_codes: exitCodes }),
    ...(env.length === 0 ? {} : { env }),
  };
}

/** One check collection's checks, as `interviewCriteria` hands them to `interviewTask`. */
type DraftedTaskChecks = { acceptance: CheckInput[]; done: CheckInput[] };

/** The loaded configuration or the captured bootstrap answers, for a criteria-drafting request. */
function currentConfiguration(
  existing: TevuConfig | null,
  bootstrap: Omit<TevuConfigInput, 'version' | 'tasks'> | undefined,
): CriteriaDraftRequest['configuration'] {
  if (existing !== null) {
    return { kind: 'loaded', config: existing };
  }
  if (bootstrap === undefined) {
    throw new Error(
      'unreachable: interviewTask always provides bootstrap answers when no configuration exists',
    );
  }
  return { kind: 'bootstrap', answers: bootstrap };
}

/**
 * Runs the criteria step: without a resolved reference, or without a
 * declared `roles.criteria`, falls through to writing both check collections
 * by hand. With both, drafts from the reference solution, shows the
 * mandatory draft review, and hands an accepted draft's items to the
 * follow-on check questions as the starting checks of each collection.
 */
async function interviewCriteria(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  existing: TevuConfig | null,
  bootstrap: Omit<TevuConfigInput, 'version' | 'tasks'> | undefined,
  resolvedReference: ResolvedReferenceSolution | undefined,
  repository: Pick<RepositoryInput, 'id' | 'path' | 'github'>,
  description: string,
  usedCheckIds: Set<string>,
  excludedNames: ReadonlySet<string>,
): Promise<DraftedTaskChecks> {
  const byHand = async (): Promise<DraftedTaskChecks> => ({
    acceptance: await interviewChecks(io, 'acceptance', usedCheckIds, excludedNames),
    done: await interviewChecks(io, 'done', usedCheckIds, excludedNames),
  });

  if (resolvedReference === undefined) {
    return byHand();
  }
  const role = existing?.roles?.criteria ?? bootstrap?.roles?.criteria;
  if (role === undefined) {
    log.info(
      'roles.criteria is not declared; write the acceptance criteria and Definition of Done by hand.',
      promptOptions(io),
    );
    return byHand();
  }
  log.step(
    `Drafting acceptance criteria and a Definition of Done from the reference solution with roles.criteria (${role.model}, effort ${role.effort}); this starts a model session.`,
    promptOptions(io),
  );
  const outcome = await dependencies.draftCriteria({
    configuration: currentConfiguration(existing, bootstrap),
    repository,
    reference: resolvedReference,
    description,
  });
  if (outcome.status === 'cancelled') {
    throw new WizardCancelledError();
  }
  if (outcome.retainedDirectory !== null) {
    log.warn(
      `The criteria call directory could not be removed; it remains at "${outcome.retainedDirectory}".`,
      promptOptions(io),
    );
  }
  if (outcome.status === 'failed') {
    log.warn(
      dependencies.redact(
        `Criteria draft failed: ${outcome.reason}; write the acceptance criteria and Definition of Done by hand.`,
      ),
      promptOptions(io),
    );
    return byHand();
  }
  const review = await reviewDraft(
    io,
    dependencies.redact,
    outcome.draft,
    resolvedReference.reference,
  );
  if (review === 'by-hand') {
    return byHand();
  }
  const draftedAcceptance: CheckInput[] = review.acceptance.map((text, index) => ({
    id: `acceptance-${String(index + 1)}`,
    description: text,
  }));
  const draftedDone: CheckInput[] = review.done.map((text, index) => ({
    id: `done-${String(index + 1)}`,
    description: text,
  }));
  for (const check of [...draftedAcceptance, ...draftedDone]) {
    usedCheckIds.add(check.id);
  }
  return {
    acceptance: await interviewChecks(
      io,
      'acceptance',
      usedCheckIds,
      excludedNames,
      draftedAcceptance,
    ),
    done: await interviewChecks(io, 'done', usedCheckIds, excludedNames, draftedDone),
  };
}

/** Both drafted lists, in review order, once the operator accepts them. */
type DraftReviewOutcome = { acceptance: string[]; done: string[] } | 'by-hand';

/** One item's location within the draft review's two lists. */
type DraftItemTarget = { collection: 'acceptance' | 'done'; index: number };

/**
 * Runs the mandatory draft review: the operator accepts,
 * edits, removes, or adds items until either accepting the draft or choosing
 * to write the criteria by hand instead. Accept stays blocked while a list is
 * empty or an item names the reference solution; every note, log line, and
 * select label carrying item text passes through `redact`.
 */
async function reviewDraft(
  io: WizardIo,
  redact: (textContent: string) => string,
  draft: CriteriaDraft,
  reference: TaskReference,
): Promise<DraftReviewOutcome> {
  let acceptance = [...draft.acceptance];
  let done = [...draft.done];

  for (;;) {
    note(
      redact(renderDraftReviewNote(acceptance, done, reference)),
      'Drafted criteria (review required)',
      promptOptions(io),
    );
    const blockingReason = firstDraftBlockingReason(acceptance, done, reference);
    const hasItems = acceptance.length + done.length > 0;
    const action = await askSelect<'accept' | 'edit' | 'remove' | 'add' | 'by-hand'>(io, {
      message: 'Review the drafted criteria',
      options: [
        {
          value: 'accept',
          label: 'Accept these criteria',
          ...(blockingReason === undefined ? {} : { disabled: true, hint: blockingReason }),
        },
        { value: 'edit', label: 'Edit an item', ...(hasItems ? {} : { disabled: true }) },
        { value: 'remove', label: 'Remove an item', ...(hasItems ? {} : { disabled: true }) },
        { value: 'add', label: 'Add an item' },
        { value: 'by-hand', label: 'Write the criteria by hand instead' },
      ],
    });

    if (action === 'by-hand') {
      return 'by-hand';
    }
    if (action === 'accept') {
      if (blockingReason !== undefined) {
        log.warn(`Cannot accept yet: ${blockingReason}.`, promptOptions(io));
        continue;
      }
      return { acceptance, done };
    }
    if (action === 'edit' || action === 'remove') {
      const target = await selectDraftItem(io, redact, acceptance, done, action);
      if (target === 'back') {
        continue;
      }
      const lists = target.collection === 'acceptance' ? acceptance : done;
      if (action === 'remove') {
        const updated = lists.filter((_, index) => index !== target.index);
        if (target.collection === 'acceptance') {
          acceptance = updated;
        } else {
          done = updated;
        }
        continue;
      }
      const edited = (
        await askText(io, {
          message: 'Edited item',
          initialValue: lists[target.index],
          validate: draftItemValidator(reference),
        })
      ).trim();
      const updated = lists.map((item, index) => (index === target.index ? edited : item));
      if (target.collection === 'acceptance') {
        acceptance = updated;
      } else {
        done = updated;
      }
      continue;
    }

    const targetCollection = await askSelect<'acceptance' | 'done' | 'back'>(io, {
      message: 'Add the item to',
      options: [
        { value: 'acceptance', label: 'Acceptance criteria' },
        { value: 'done', label: 'Definition of Done' },
        { value: 'back', label: 'Back to the review' },
      ],
    });
    if (targetCollection === 'back') {
      continue;
    }
    const newItem = (
      await askText(io, {
        message:
          targetCollection === 'acceptance'
            ? 'New acceptance criterion'
            : 'New Definition of Done item',
        validate: draftItemValidator(reference),
      })
    ).trim();
    if (targetCollection === 'acceptance') {
      acceptance = [...acceptance, newItem];
    } else {
      done = [...done, newItem];
    }
  }
}

/** Selects one item to edit or remove, or `'back'`; every label passes through `redact`. */
async function selectDraftItem(
  io: WizardIo,
  redact: (textContent: string) => string,
  acceptance: readonly string[],
  done: readonly string[],
  action: 'edit' | 'remove',
): Promise<DraftItemTarget | 'back'> {
  const options: Option<string>[] = [
    ...acceptance.map((text, index) => ({
      value: `acceptance:${String(index)}`,
      label: `Acceptance ${String(index + 1)}: ${redact(text)}`,
    })),
    ...done.map((text, index) => ({
      value: `done:${String(index)}`,
      label: `Definition of Done ${String(index + 1)}: ${redact(text)}`,
    })),
    { value: 'back', label: 'Back to the review' },
  ];
  const choice = await askSelect<string>(io, {
    message: action === 'edit' ? 'Item to edit' : 'Item to remove',
    options,
  });
  if (choice === 'back') {
    return 'back';
  }
  const separatorIndex = choice.indexOf(':');
  const collection = choice.slice(0, separatorIndex);
  const index = Number(choice.slice(separatorIndex + 1));
  if (collection !== 'acceptance' && collection !== 'done') {
    throw new Error('unreachable: selectDraftItem only offers acceptance:<n> and done:<n> values');
  }
  return { collection, index };
}

/** The item rule shared by editing and adding: rejects whitespace-only text and text naming the reference. */
function draftItemValidator(
  reference: TaskReference,
): (value: string | undefined) => string | undefined {
  return (raw) => {
    const value = (raw ?? '').trim();
    if (value.length === 0) {
      return 'a non-empty value is required';
    }
    const identity = describeReferenceIdentityInText(raw ?? '', reference);
    if (identity !== undefined) {
      return `the item names ${identity}; tevu validate rejects a task whose agent prompt contains it`;
    }
    return undefined;
  };
}

/** Renders the draft review note body: the guidance line, then each list with its item lines. */
function renderDraftReviewNote(
  acceptance: readonly string[],
  done: readonly string[],
  reference: TaskReference,
): string {
  return [
    "Every item reaches every benchmarked agent's prompt: keep outcomes any correct solution achieves, not details of the reference solution.",
    '',
    'Acceptance criteria:',
    ...renderDraftItemLines(acceptance, reference),
    'Definition of Done:',
    ...renderDraftItemLines(done, reference),
  ].join('\n');
}

function renderDraftItemLines(items: readonly string[], reference: TaskReference): string[] {
  if (items.length === 0) {
    return ['  (none)'];
  }
  return items.map((item, index) => {
    const identity = describeReferenceIdentityInText(item, reference);
    return `  ${String(index + 1)}. ${item}${identity === undefined ? '' : ` [names ${identity}]`}`;
  });
}

/**
 * The first reason `accept` stays blocked, checked in this order: an empty
 * acceptance list, an empty Definition of Done list, then any item naming
 * the reference solution.
 */
function firstDraftBlockingReason(
  acceptance: readonly string[],
  done: readonly string[],
  reference: TaskReference,
): string | undefined {
  if (acceptance.length === 0) {
    return 'the acceptance criteria need at least one item';
  }
  if (done.length === 0) {
    return 'the Definition of Done needs at least one item';
  }
  const namingCount = [...acceptance, ...done].filter(
    (item) => describeReferenceIdentityInText(item, reference) !== undefined,
  ).length;
  if (namingCount === 0) {
    return undefined;
  }
  return namingCount === 1
    ? '1 item names the reference solution; edit or remove it'
    : `${String(namingCount)} items name the reference solution; edit or remove them`;
}

/** Shows the single credential-redacted review; declining cancels without a write. */
async function reviewAndConfirm(
  io: WizardIo,
  redact: (textContent: string) => string,
  input: TaskWizardInput,
  graderDeclared: boolean,
): Promise<void> {
  note(redact(renderTaskReview(input, graderDeclared)), 'Review', promptOptions(io));
  const accepted = await askConfirm(io, {
    message: `Write this to ${input.configPath}?`,
    initialValue: true,
  });
  if (!accepted) {
    throw new WizardCancelledError();
  }
}

/** Renders the complete wizard input for the TTY-only final review. */
function renderTaskReview(input: TaskWizardInput, graderDeclared: boolean): string {
  const lines: string[] = [];
  if (input.bootstrap !== undefined) {
    const bootstrap = input.bootstrap;
    lines.push(
      'New configuration:',
      `  run.output_dir: ${bootstrap.run.output_dir}`,
      `  run.concurrency: ${bootstrap.run.concurrency}`,
      `  run.timeout: ${bootstrap.run.timeout}`,
      `  run.stop_grace: ${bootstrap.run.stop_grace}`,
      ...(bootstrap.run.check_timeout === undefined
        ? []
        : [`  run.check_timeout: ${bootstrap.run.check_timeout}`]),
      ...Object.entries(bootstrap.agents).flatMap(([name, settings]) => [
        `  agents.${name}.command: ${settings.command}`,
        `  agents.${name}.secrets: ${renderVariableList(settings.secrets ?? [])}`,
        `  agents.${name}.env: ${renderVariableList(settings.env ?? [])}`,
      ]),
    );
    if (bootstrap.roles?.criteria !== undefined) {
      lines.push(
        `  roles.criteria: ${bootstrap.roles.criteria.model} (effort ${bootstrap.roles.criteria.effort})`,
      );
    }
    if (bootstrap.roles?.grader !== undefined) {
      lines.push(
        `  roles.grader: ${bootstrap.roles.grader.model} (effort ${bootstrap.roles.grader.effort})`,
      );
    }
    if (bootstrap.trackers?.jira !== undefined) {
      lines.push(
        `  trackers.jira.url: ${bootstrap.trackers.jira.url}`,
        `  trackers.jira credentials: ${bootstrap.trackers.jira.email}, ${bootstrap.trackers.jira.token} (names only)`,
      );
    }
    for (const repository of bootstrap.repositories) {
      lines.push(`  repositories: ${repository.id} (${describeRepositorySource(repository)})`);
    }
    for (const model of bootstrap.models) {
      lines.push(`  models: ${model.id}: ${model.model} (effort ${model.effort})`);
    }
    lines.push('');
  }
  const task = input.task;
  lines.push(`Task ${task.id}:`);
  if (input.newRepository !== undefined) {
    lines.push(
      `  new repository ${input.newRepository.id}: ${describeRepositorySource(input.newRepository)}`,
    );
  }
  lines.push(
    `  repo: ${task.repo}`,
    `  base_commit: ${task.base_commit}`,
    `  title: ${task.title}`,
  );
  if (task.source === undefined) {
    lines.push('  source: (written by hand)');
  } else {
    lines.push(
      `  source: ${task.source.kind} ${task.source.key}`,
      `  imported at: ${task.source.imported_at}`,
      `  imported title: ${task.source.title}`,
      `  imported body: ${task.source.body}`,
    );
  }
  if (task.reference !== undefined) {
    lines.push(
      `  reference: ${task.reference.kind} ${task.reference.identifier}`,
      `  reference commits: ${task.reference.commits.length}`,
    );
    if (task.reference.kind === 'pull-request' && task.reference.merge_commit !== undefined) {
      lines.push(`  reference merge commit: ${task.reference.merge_commit}`);
    }
  }
  lines.push(`  description: ${task.description}`, `  prompt: ${task.prompt}`);
  for (const item of task.readiness) {
    lines.push(`  readiness: ${item}`);
  }
  for (const [label, checks] of [
    ['acceptance', task.checks.acceptance],
    ['done', task.checks.done],
  ] as const) {
    for (const check of checks) {
      lines.push(`  ${label} ${check.id}: ${renderCheck(check)}`);
    }
  }
  if (!graderDeclared && taskDeclaresGradedCheck(task)) {
    lines.push(
      'warning: roles.grader is not declared; tevu validate and tevu run refuse this task until it is',
    );
  }
  return lines.join('\n');
}

/** Holds when a check declares neither `run` nor `manual: true` (a graded check). */
function taskDeclaresGradedCheck(task: TaskInput): boolean {
  return [...task.checks.acceptance, ...task.checks.done].some(
    (check) => check.manual !== true && check.run === undefined,
  );
}

/** `GitHub <github>` for a GitHub entry, its `path` otherwise. */
function describeRepositorySource(repository: Pick<RepositoryInput, 'path' | 'github'>): string {
  return repository.github === undefined ? (repository.path ?? '') : `GitHub ${repository.github}`;
}

function renderVariableList(names: readonly string[]): string {
  return names.length === 0 ? '(none)' : names.join(', ');
}

function renderCheck(check: CheckInput): string {
  const requirement = check.required === false ? 'optional' : 'required';
  if (check.manual === true) {
    return `${check.description} (${requirement}, manual)`;
  }
  if (check.run === undefined) {
    return `${check.description} (${requirement}, graded)`;
  }
  const env =
    check.env === undefined || check.env.length === 0 ? '' : `, variables ${check.env.join(',')}`;
  return (
    `${check.description} (${requirement}, command ${JSON.stringify(check.run)}, ` +
    `timeout ${check.timeout ?? 'run.check_timeout'}, ` +
    `exit codes ${(check.exit_codes ?? [0]).join(',')}${env})`
  );
}

function renderAssessableCheck(check: AssessableCheckSummary): string {
  const requirement = check.required ? 'required' : 'optional';
  const kind = check.evaluator === 'grader' ? ', graded' : '';
  return `${check.checkId} (${check.category}, ${requirement}${kind}): ${check.description}`;
}

function renderAssessmentRecord(record: AssessmentRecord): string {
  const noteSuffix = record.note.length === 0 ? '' : ` - ${record.note}`;
  return `${record.checkId}: ${record.verdict} by ${record.assessor} at ${record.assessedAt}${noteSuffix}`;
}

/** Fails with `PrerequisiteError` unless both wizard streams are TTYs. */
function requireInteractiveTty(io: WizardIo): TevuResult<never, 'PrerequisiteError'> | null {
  const failing: string[] = [];
  if (io.input.isTTY !== true) {
    failing.push('stdin');
  }
  if (io.output.isTTY !== true) {
    failing.push('stdout');
  }
  if (failing.length === 0) {
    return null;
  }
  return {
    ok: false,
    error: {
      kind: 'PrerequisiteError',
      tool: 'terminal',
      expected: 'an interactive TTY on stdin and stdout',
      actual: `${failing.join(' and ')} ${failing.length === 1 ? 'is' : 'are'} not a TTY`,
    },
  };
}

function promptOptions(io: WizardIo): { input: Readable; output: Writable } {
  return { input: io.input, output: io.output };
}

/** Maps a Clack cancellation to the internal sentinel the wizard entry points catch. */
function unwrap<T>(value: T | typeof CANCEL_SYMBOL): T {
  if (isCancel(value)) {
    throw new WizardCancelledError();
  }
  return value;
}

/**
 * Maps a tracker import's cancellation to the internal sentinel the wizard
 * entry points catch, so Ctrl+C during an issue import exits like any other
 * wizard cancellation, never as an `IssueImportError`.
 */
function unwrapImportResult<T>(
  result: TevuResult<T, 'IssueImportError' | 'CancellationError'>,
): TevuResult<T, 'IssueImportError'> {
  if (result.ok || result.error.kind === 'IssueImportError') {
    return result as TevuResult<T, 'IssueImportError'>;
  }
  throw new WizardCancelledError();
}

async function askText(
  io: WizardIo,
  options: {
    message: string;
    defaultValue?: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string | undefined) => string | undefined;
  },
): Promise<string> {
  return unwrap(await text({ ...options, ...promptOptions(io) }));
}

async function askConfirm(
  io: WizardIo,
  options: { message: string; initialValue: boolean },
): Promise<boolean> {
  return unwrap(await confirm({ ...options, ...promptOptions(io) }));
}

async function askSelect<Value extends string>(
  io: WizardIo,
  options: {
    message: string;
    options: Option<Value>[];
    initialValue?: Value;
  },
): Promise<Value> {
  return unwrap(await select<Value>({ ...options, ...promptOptions(io) }));
}

async function askInteger(
  io: WizardIo,
  message: string,
  min: number,
  max?: number,
): Promise<number> {
  const value = await askText(io, {
    message,
    validate: (raw) => {
      const trimmed = (raw ?? '').trim();
      const bounds =
        max === undefined
          ? `an integer of at least ${min}`
          : `an integer from ${min} through ${max}`;
      if (!/^\d+$/.test(trimmed)) {
        return `enter ${bounds}`;
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed < min || (max !== undefined && parsed > max)) {
        return `enter ${bounds}`;
      }
      return undefined;
    },
  });
  return Number.parseInt(value.trim(), 10);
}

async function askModel(io: WizardIo, modelEntryId: string): Promise<`${string}/${string}`> {
  for (;;) {
    const value = await askText(io, {
      message: `Model for "${modelEntryId}" (provider/model)`,
      validate: validateModel,
    });
    if (isModelIdentifier(value)) {
      return value;
    }
  }
}

async function askVerdict(io: WizardIo, checkId: string): Promise<'passed' | 'failed'> {
  return askSelect<'passed' | 'failed'>(io, {
    message: `Verdict for "${checkId}"`,
    options: [
      { value: 'passed', label: 'passed' },
      { value: 'failed', label: 'failed' },
    ],
  });
}

async function askNote(io: WizardIo, verdict: 'passed' | 'failed'): Promise<string> {
  return askText(io, {
    message: verdict === 'failed' ? 'Note (required for a failed verdict)' : 'Note (optional)',
    defaultValue: '',
    ...(verdict === 'failed'
      ? {
          validate: (value: string | undefined) =>
            (value ?? '').trim().length === 0
              ? 'a failed verdict requires a non-empty note'
              : undefined,
        }
      : {}),
  });
}

function validateNonWhitespace(value: string | undefined): string | undefined {
  return (value ?? '').trim().length === 0 ? 'a non-empty value is required' : undefined;
}

function validateId(
  usedIds: ReadonlySet<string>,
): (value: string | undefined) => string | undefined {
  return (raw) => {
    const value = raw ?? '';
    if (!ID_PATTERN.test(value)) {
      return `IDs ${ID_RULE}`;
    }
    if (usedIds.has(value)) {
      return `"${value}" is already used`;
    }
    return undefined;
  };
}

function validateModel(value: string | undefined): string | undefined {
  return isModelIdentifier(value ?? '') ? undefined : 'model must be "<provider>/<model>"';
}

function isModelIdentifier(value: string): value is `${string}/${string}` {
  return /^.+\/.+$/.test(value);
}

function validateHttpsUrl(value: string | undefined): string | undefined {
  try {
    return new URL(value ?? '').protocol === 'https:' ? undefined : 'an https:// URL is required';
  } catch {
    return 'an https:// URL is required';
  }
}

/** Reuses the schema's Duration grammar (including the E1 bound) rather than a second regex. */
function validateDuration(value: string | undefined): string | undefined {
  const result = DurationSchema.safeParse((value ?? '').trim());
  if (result.success) {
    return undefined;
  }
  return result.error.issues[0]?.message ?? 'invalid duration';
}

function validateVariableNameGrammar(value: string): string | undefined {
  const result = VariableNameSchema.safeParse(value);
  if (result.success) {
    return undefined;
  }
  return result.error.issues[0]?.message ?? 'invalid variable name';
}

function isFixedEnvironmentName(name: string): boolean {
  return FIXED_ENVIRONMENT_NAMES.has(name) || name.startsWith('XDG_');
}

function validateVariableName(
  takenNames: ReadonlySet<string>,
): (value: string | undefined) => string | undefined {
  return (raw) => {
    const value = raw ?? '';
    const grammar = validateVariableNameGrammar(value);
    if (grammar !== undefined) {
      return grammar;
    }
    if (isFixedEnvironmentName(value)) {
      return 'PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract';
    }
    if (takenNames.has(value)) {
      return `"${value}" is already configured`;
    }
    return undefined;
  };
}

function validateCheckVariableList(
  excludedNames: ReadonlySet<string>,
): (value: string | undefined) => string | undefined {
  return (raw) => {
    const names = (raw ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    const seen = new Set<string>();
    for (const name of names) {
      const grammar = validateVariableNameGrammar(name);
      if (grammar !== undefined) {
        return `"${name}": ${grammar}`;
      }
      if (isFixedEnvironmentName(name)) {
        return 'PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract';
      }
      if (excludedNames.has(name)) {
        return `"${name}" is passed to the agent or Jira and cannot also be passed to a check`;
      }
      if (seen.has(name)) {
        return `"${name}" is listed more than once`;
      }
      seen.add(name);
    }
    return undefined;
  };
}

function validateArgvJson(value: string | undefined): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '');
  } catch {
    return 'enter a JSON array of strings, e.g. ["npm","test"]';
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((element) => typeof element === 'string') ||
    parsed[0] === ''
  ) {
    return 'the argv array needs a non-empty executable followed by literal string arguments';
  }
  return undefined;
}

function validateExitCodes(value: string | undefined): string | undefined {
  const tokens = (value ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return undefined;
  }
  if (tokens.some((token) => !/^-?\d+$/.test(token))) {
    return 'enter one or more comma-separated integers, e.g. 0';
  }
  return undefined;
}

function configValidationFailure(
  findings: ValidationFinding[],
): TevuResult<never, 'ConfigValidationError'> {
  return { ok: false, error: { kind: 'ConfigValidationError', findings } };
}

function cancellationFailure(): TevuResult<never, 'CancellationError'> {
  return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
}
