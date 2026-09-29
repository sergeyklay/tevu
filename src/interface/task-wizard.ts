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

import { styleText } from 'node:util';
import { cancel, confirm, intro, isCancel, log, note, select, text } from '@clack/prompts';
import stdinDiscarder from 'stdin-discarder';
import yoctoSpinner from 'yocto-spinner';

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

import { sectionedSelect } from './sectioned-select';

import type { AssessableCheckSummary, AssessmentCaseContext } from '@/application/assess';
import type { TaskWizardInput } from '@/application/create-task';
import type {
  CriteriaDraft,
  CriteriaDraftFailure,
  CriteriaDraftOutcome,
  CriteriaDraftRequest,
} from '@/application/draft-criteria';
import type { ManagedCommitsOutcome } from '@/application/managed-clone';
import type {
  AgentDraft,
  ModelAccessOutcome,
  ModelProviderInspection,
} from '@/application/model-access';
import type { ResolvedReferenceSolution } from '@/application/reference-solution';
import type {
  CheckInput,
  ModelDefinitionInput,
  RepositoryInput,
  TaskInput,
  TevuConfigInput,
} from '@/config/schema';
import type {
  AgentCapabilityReport,
  AgentProviderSetting,
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

/**
 * Interactive streams the wizards prompt on; both must be TTYs. A `signal`
 * makes every question resolve as cancelled once it aborts.
 */
type WizardIo = {
  input: Readable & { isTTY?: boolean };
  output: Writable & { isTTY?: boolean };
  signal?: AbortSignal;
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
  now: () => Date;
  redact: (textContent: string) => string;
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
const DRAFT_REVIEW_BACK_OPTION = { value: 'back', label: 'Back to the review' };

/** Renders a `ManagedCloneError` or `PrerequisiteError` for a wizard warning line. */
function describeManagedCloneOrPrerequisiteFailure(
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
function warnLines(
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

const WAIT_FRAMES = ['◒', '◐', '◓', '◑'];

/**
 * Runs one asynchronous step between questions behind a spinner row.
 *
 * Holds stdin with `stdin-discarder` so keys typed meanwhile never reach the
 * next question and Ctrl-C arrives as SIGINT, which the command's abort
 * signal already turns into cancellation. The spinner never installs its own
 * signal handlers: its default would exit the process before the cancelled
 * operation cleans up. Both stop in a `finally`, so no exit path leaves the
 * row, a hidden cursor, or raw mode behind. An aborted signal ends the wizard
 * whatever the operation returned.
 */
async function runWait<T>(io: WizardIo, label: string, operation: () => Promise<T>): Promise<T> {
  // yocto-spinner joins the frame and the text with one space; Clack's rows use two.
  const spinner = yoctoSpinner({
    text: ` ${label}`,
    stream: io.output,
    handleSignals: false,
    color: 'magenta',
    spinner: { frames: WAIT_FRAMES },
  });
  let result: T;
  try {
    stdinDiscarder.start();
    spinner.start();
    result = await operation();
  } finally {
    spinner.stop();
    stdinDiscarder.stop();
  }
  if (io.signal?.aborted === true) {
    throw new WizardCancelledError();
  }
  return result;
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
  const io: WizardIo = { ...dependencies.io, signal: dependencies.cancellation };
  const wizardDependencies: TaskWizardDependencies = { ...dependencies, io };
  intro('tevu task add', promptOptions(io));
  log.message(
    styleText('dim', 'Press Ctrl-C to cancel.', { stream: io.output }),
    promptOptions(io),
  );
  try {
    const bootstrap =
      existing.value === null
        ? await interviewBootstrap(io, wizardDependencies, request.jiraIssueKey !== undefined)
        : undefined;
    const input = await interviewTask(request, wizardDependencies, existing.value, bootstrap);
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
      cancel('Cancelled. Nothing was saved.', promptOptions(io));
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
  dependencies: TaskWizardDependencies,
  requireJira: boolean,
): Promise<Omit<TevuConfigInput, 'version' | 'tasks'>> {
  log.step('New configuration', promptOptions(io));
  const outputDirectory = await askDefaultedText(io, {
    message: 'Output directory',
    defaultValue: 'runs',
    validate: validateNonWhitespace,
  });
  const concurrency = await askInteger(io, 'Concurrent cases', 1, 32, 2);
  const timeout = await askDefaultedText(io, {
    message: 'Agent time limit',
    defaultValue: '10m',
    validate: validateDuration,
  });
  const stopGrace = await askDefaultedText(io, {
    message: 'Stop grace period',
    defaultValue: '3s',
    validate: validateDuration,
  });
  const checkTimeout = await askDefaultedText(io, {
    message: 'Check time limit',
    defaultValue: '5m',
    validate: validateDuration,
  });
  const command = await askAgentCommand(io, dependencies);
  const takenNames = new Set<string>();
  const secrets = await askVariableNames(io, 'Secret variable names', takenNames);
  const env = await askVariableNames(io, 'Non-secret variable names', takenNames);
  const agentNames = new Set([...secrets, ...env]);
  const jira = await interviewJiraSettings(io, requireJira, agentNames);
  const repositories = await interviewRepositories(io);
  const checkState: ModelCheckState = {
    agent: { command, secrets, env, providers: [] },
    keys: new Map(),
    printedUnset: new Set(),
    jiraNames:
      jira === undefined
        ? new Set()
        : new Set([referencedVariableName(jira.email), referencedVariableName(jira.token)]),
  };
  const models = await interviewModels(io, dependencies, checkState);
  const grader = await interviewModelRole(io, dependencies, checkState, 'grader');
  const criteria = await interviewModelRole(io, dependencies, checkState, 'criteria');
  const { agent } = checkState;
  return {
    run: {
      output_dir: outputDirectory,
      concurrency,
      timeout,
      stop_grace: stopGrace,
      check_timeout: checkTimeout.trim(),
    },
    agents: {
      [AGENT_NAMES[0]]: {
        command: agent.command,
        secrets: agent.secrets,
        env: agent.env,
        ...(agent.providers.length === 0 ? {} : { providers: agent.providers }),
      },
    },
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

/**
 * Asks the agent command and probes it behind a spinner, re-asking with the
 * failed command filled in until the probe passes.
 */
async function askAgentCommand(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
): Promise<string> {
  let command = await askDefaultedText(io, {
    message: 'Agent command',
    defaultValue: AGENT_NAMES[0],
    validate: validateNonWhitespace,
  });
  for (;;) {
    const probed = await runWait(io, `Checking ${command}`, () => dependencies.probeAgent(command));
    if (probed.ok) {
      return command;
    }
    const detail =
      probed.error.kind === 'PrerequisiteError'
        ? `expected ${probed.error.expected}${probed.error.actual === undefined ? '' : `, actual ${probed.error.actual}`}`
        : probed.error.reason;
    warnLines(io, dependencies.redact, {
      headline: `Can't run ${command}.`,
      details: [detail],
      next: 'Fix the command below. Press Enter to retry, or Ctrl-C to cancel.',
    });
    command = await askText(io, {
      message: 'Agent command',
      initialValue: command,
      validate: validateNonWhitespace,
    });
  }
}

/** One role's setup-interview texts and effort default. */
type ModelRoleQuestionText = {
  confirm: string;
  modelQuestion: string;
  effortQuestion: string;
  defaultEffort: string;
};

const MODEL_ROLE_QUESTION_TEXT: Record<'criteria' | 'grader', ModelRoleQuestionText> = {
  grader: {
    confirm: 'Grade checks with a model?',
    modelQuestion: 'Grader model',
    effortQuestion: 'Grader effort',
    defaultEffort: 'medium',
  },
  criteria: {
    confirm: 'Draft criteria with a model?',
    modelQuestion: 'Criteria model',
    effortQuestion: 'Criteria effort',
    defaultEffort: 'high',
  },
};

/** Captures an optional `roles.<roleName>` declaration during bootstrap; absent on decline. */
async function interviewModelRole(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  checkState: ModelCheckState,
  roleName: 'criteria' | 'grader',
): Promise<{ model: `${string}/${string}`; effort: string } | undefined> {
  const texts = MODEL_ROLE_QUESTION_TEXT[roleName];
  const wantsRole = await askConfirm(io, { message: texts.confirm, initialValue: true });
  if (!wantsRole) {
    return undefined;
  }
  const model = await askCheckedModel(io, dependencies, texts.modelQuestion, checkState);
  const effort = await askDefaultedText(io, {
    message: texts.effortQuestion,
    defaultValue: texts.defaultEffort,
    validate: validateNonWhitespace,
  });
  return { model, effort };
}

type MutableAgentDraft = {
  command: string;
  secrets: string[];
  env: string[];
  providers: AgentProviderSetting[];
};

/** What the model check keeps across the setup interview's model questions. */
type ModelCheckState = {
  /** The agent block every accepted model so far needs. */
  agent: MutableAgentDraft;
  /** The recorded API key variable answer per provider; an empty answer is a recorded answer. */
  keys: Map<string, string>;
  /** Unset variables already reported, so each name prints once per run. */
  printedUnset: Set<string>;
  /** The variables the Jira answers name; a copied provider never receives them. */
  jiraNames: ReadonlySet<string>;
};

/** Why one model answer was refused; each variant becomes one warning. */
type ModelCheckFailure =
  | { kind: 'config-unreadable'; findings: readonly ValidationFinding[] }
  | { kind: 'provider-rejected'; provider: string; findings: readonly ValidationFinding[] }
  | { kind: 'not-listed'; model: string }
  | { kind: 'listing-failed'; detail: string };

const RETRY_NEXT_STEP = 'Press Enter to retry, or Ctrl-C to cancel.';

/**
 * Asks a model question and checks the answer, re-asking with the refused
 * answer filled in until the agent lists the model. Copies the answer's
 * provider from the operator's configuration into the agent block on the way.
 */
async function askCheckedModel(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  message: string,
  state: ModelCheckState,
): Promise<`${string}/${string}`> {
  let answer = await askText(io, { message, validate: validateModel });
  for (;;) {
    if (isModelIdentifier(answer)) {
      const failure = await checkRound(io, dependencies, state, answer);
      if (failure === undefined) {
        return answer;
      }
      warnLines(io, dependencies.redact, describeModelCheckFailure(failure));
    }
    answer = await askText(io, { message, initialValue: answer, validate: validateModel });
  }
}

/**
 * Checks one model answer against a candidate copy of the agent block, which
 * replaces the accepted block only when the answer passes, so a refused
 * answer leaves no provider or variable behind. Returns `undefined` when the
 * answer is accepted.
 */
async function checkRound(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  state: ModelCheckState,
  model: `${string}/${string}`,
): Promise<ModelCheckFailure | undefined> {
  let hasAskedKey = false;
  for (;;) {
    const candidate: MutableAgentDraft = {
      command: state.agent.command,
      secrets: [...state.agent.secrets],
      env: [...state.agent.env],
      providers: state.agent.providers.map((provider) => ({ ...provider })),
    };
    const inspected = await runWait(io, 'Checking model', () =>
      dependencies.inspectModelProvider(candidate, model),
    );
    if (!inspected.ok) {
      return { kind: 'config-unreadable', findings: inspected.error.findings };
    }
    const { provider, definition } = inspected.value;
    if (definition.defined) {
      if (!candidate.providers.some((entry) => entry.id === provider)) {
        candidate.providers.push({ id: provider });
      }
      for (const name of [...definition.keyVariables, ...definition.otherVariables]) {
        declareSecret(state, candidate, name);
      }
      const isKeyUnknown = definition.keyVariables.length === 0 || definition.apiKey === 'value';
      if (isKeyUnknown && !state.keys.has(provider)) {
        state.keys.set(provider, await askKeyVariable(io, state, provider, undefined));
      }
    }
    const key = state.keys.get(provider) ?? '';
    if (key !== '') {
      const entry = candidate.providers.find((candidateEntry) => candidateEntry.id === provider);
      if (definition.defined && entry !== undefined) {
        entry.api_key = key;
      }
      declareSecret(state, candidate, key);
    }

    const outcome = await runWait(io, 'Checking model', () =>
      dependencies.checkModelAccess(candidate, model),
    );
    if (outcome.status === 'cancelled') {
      throw new WizardCancelledError();
    }
    if (outcome.status === 'provider-rejected') {
      return { kind: 'provider-rejected', provider, findings: outcome.findings };
    }
    if (outcome.status === 'listing-failed') {
      return { kind: 'listing-failed', detail: outcome.detail };
    }
    if (outcome.retainedDirectory !== null) {
      warnRetainedDirectory(io, dependencies.redact, outcome.retainedDirectory);
    }
    if (
      outcome.status === 'not-listed' &&
      !definition.defined &&
      outcome.unsetVariables.length > 0
    ) {
      warnLines(io, dependencies.redact, {
        headline: `${model} can't be checked while ${describeUnsetNames(outcome.unsetVariables)} in this terminal, so it is kept as entered.`,
      });
      for (const name of outcome.unsetVariables) {
        state.printedUnset.add(name);
      }
      state.agent = candidate;
      return undefined;
    }
    for (const name of outcome.unsetVariables) {
      if (!state.printedUnset.has(name)) {
        state.printedUnset.add(name);
        warnLines(io, dependencies.redact, {
          headline: `${name} isn't set in this terminal. Runs will need it.`,
        });
      }
    }
    if (outcome.status === 'listed') {
      state.agent = candidate;
      return undefined;
    }
    if (definition.defined || hasAskedKey) {
      return { kind: 'not-listed', model };
    }
    const answer = await askKeyVariable(io, state, provider, state.keys.get(provider));
    state.keys.set(provider, answer);
    hasAskedKey = true;
    if (answer === '') {
      return { kind: 'not-listed', model };
    }
  }
}

/**
 * Adds `name` to the candidate's secrets unless it is already declared, is
 * not a variable name, is fixed by the isolation contract, or belongs to the
 * Jira answers. A skipped name stays visible to the provider reader, which
 * refuses a definition that references it.
 */
function declareSecret(state: ModelCheckState, candidate: MutableAgentDraft, name: string): void {
  const isDeclarable =
    !candidate.secrets.includes(name) &&
    !candidate.env.includes(name) &&
    validateVariableNameGrammar(name) === undefined &&
    !isFixedEnvironmentName(name) &&
    !state.jiraNames.has(name);
  if (isDeclarable) {
    candidate.secrets.push(name);
  }
}

/** Asks the variable that holds a provider's API key; empty when the operator names none. */
async function askKeyVariable(
  io: WizardIo,
  state: ModelCheckState,
  provider: string,
  previous: string | undefined,
): Promise<string> {
  const validateName = validateVariableName(new Set(state.agent.env));
  return askDefaultedText(io, {
    message: `API key variable for ${provider}`,
    defaultValue: '',
    placeholder: 'none',
    ...(previous === undefined || previous === '' ? {} : { initialValue: previous }),
    validate: (raw) => {
      const problem = validateName(raw);
      if (problem !== undefined) {
        return problem;
      }
      return state.jiraNames.has(raw ?? '')
        ? 'Jira credential variables must not also be passed to the agent'
        : undefined;
    },
  });
}

function describeModelCheckFailure(failure: ModelCheckFailure): {
  headline: string;
  details: readonly string[];
  next: string;
} {
  switch (failure.kind) {
    case 'config-unreadable':
      return {
        headline: "Can't read your OpenCode config.",
        details: failure.findings.map((finding) => finding.message),
        next: `Update your OpenCode settings. ${RETRY_NEXT_STEP}`,
      };
    case 'provider-rejected':
      return {
        headline: `Can't copy provider ${failure.provider} from your OpenCode config.`,
        details: failure.findings.map((finding) => finding.message),
        next: `Update your OpenCode settings. ${RETRY_NEXT_STEP}`,
      };
    case 'not-listed':
      return {
        headline: `OpenCode can't find ${failure.model}.`,
        details: [],
        next: `Update your OpenCode settings or edit the model below. ${RETRY_NEXT_STEP}`,
      };
    case 'listing-failed':
      return {
        headline: "Can't list OpenCode models.",
        details: [failure.detail],
        next: RETRY_NEXT_STEP,
      };
  }
}

/** Warns that removing a temporary directory failed and where its remains are. */
function warnRetainedDirectory(
  io: WizardIo,
  redact: (textContent: string) => string,
  directory: string,
): void {
  warnLines(io, redact, {
    headline: "Couldn't remove a temporary directory.",
    details: [directory],
  });
}

/**
 * Asks one pass-through agent variable list, names only.
 *
 * Every name follows the single-name rules and must be new across both agent
 * lists; accepted names join `takenNames` so the next list sees them.
 */
async function askVariableNames(
  io: WizardIo,
  message: string,
  takenNames: Set<string>,
): Promise<string[]> {
  const validateName = validateVariableName(takenNames);
  const answer = await askDefaultedText(io, {
    message,
    defaultValue: '',
    placeholder: 'none',
    validate: (raw) => {
      const seen = new Set<string>();
      for (const name of splitNames(raw ?? '')) {
        const problem = validateName(name);
        if (problem !== undefined) {
          return problem;
        }
        if (seen.has(name)) {
          return `"${name}" is listed more than once`;
        }
        seen.add(name);
      }
      return undefined;
    },
  });
  const names = splitNames(answer);
  for (const name of names) {
    takenNames.add(name);
  }
  return names;
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
      message: 'Import issues from Jira?',
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
    message: 'Jira site URL',
    validate: validateHttpsUrl,
  });
  const email = await askText(io, {
    message: 'Jira email variable',
    validate: validateCredentialName,
  });
  const token = await askText(io, {
    message: 'Jira token variable',
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
    message: 'Repository source',
    options: [
      { value: 'path', label: 'Local path' },
      { value: 'github', label: 'GitHub, cloned by tevu' },
    ],
  });
  if (source === 'path') {
    const path = await askText(io, {
      message: 'Local path',
      validate: validateNonWhitespace,
    });
    return { id, path };
  }
  const github = await askGitHubRepository(io);
  return { id, path: managedCloneLocation(github), github: github.text };
}

/** Asks a GitHub repository answer, re-prompting with the grammar message until it parses. */
async function askGitHubRepository(
  io: WizardIo,
): Promise<{ host: string; owner: string; repo: string; text: string }> {
  const text = (
    await askText(io, {
      message: 'GitHub repository',
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
async function interviewModels(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  checkState: ModelCheckState,
): Promise<ModelDefinitionInput[]> {
  const models: ModelDefinitionInput[] = [];
  const usedIds = new Set<string>();
  for (;;) {
    const id = await askText(io, {
      message: 'Model entry ID',
      validate: validateId(usedIds),
    });
    const model = await askCheckedModel(io, dependencies, 'Model', checkState);
    const effort = await askText(io, {
      message: 'Reasoning effort',
      validate: validateNonWhitespace,
    });
    usedIds.add(id);
    models.push({ id, model, effort });
    if (models.length < 2) {
      log.info('Add a second model to compare.', promptOptions(io));
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
  log.step('New task', promptOptions(io));
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
      ? (await askText(io, { message: 'Base commit', validate: validateNonWhitespace })).trim()
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
    message: 'Title',
    ...(source.value.importedTitle === undefined
      ? {}
      : { initialValue: source.value.importedTitle }),
    validate: validateNonWhitespace,
  });
  const description = await askText(io, {
    message: 'Description',
    validate: validateNonWhitespace,
  });
  const prompt = await askText(io, {
    message: 'Prompt for the models',
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
    request.configPath,
    existing,
    bootstrap,
    resolvedReference,
    selectedRepository,
    prompt,
    description,
    usedCheckIds,
    excludedNames,
    existing?.run.check_timeout ?? bootstrap?.run.check_timeout,
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
              { value: 'manual', label: 'Write it yourself' },
              {
                value: 'jira',
                label: 'Jira issue',
                ...(jiraSettings === undefined
                  ? { disabled: true, hint: "Jira isn't set up" }
                  : {}),
              },
              { value: 'github', label: 'GitHub issue' },
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
            message: 'GitHub issue',
            validate: validateNonWhitespace,
          })
        ).trim();
      return unwrapImportResult(
        await runWait(io, 'Importing issue', () => dependencies.importGitHubIssue(reference)),
      );
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
    return unwrapImportResult(
      await runWait(io, 'Importing issue', () =>
        dependencies.importJiraIssue(jiraSettings, issueKey),
      ),
    );
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
    `Imported ${imported.value.issueKey}`,
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
    message: 'Repository',
    options: [
      ...repositories.map((repository) => ({
        value: repository.id,
        label: repository.id,
        hint:
          repository.github === undefined ? (repository.path ?? '') : `GitHub ${repository.github}`,
      })),
      { value: NEW_REPOSITORY_CHOICE, label: 'Add a repository' },
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
    const ensured = await runWait(io, 'Preparing repository', () =>
      dependencies.ensureManagedCommits({ id: selectedRepository.id, github }, [], (line) =>
        log.step(dependencies.redact(line), promptOptions(io)),
      ),
    );
    if (ensured.ok) {
      return { ...selection, selectedRepository };
    }
    if (ensured.error.kind === 'CancellationError') {
      throw new WizardCancelledError();
    }
    warnLines(io, dependencies.redact, {
      headline: `Can't use repository ${selectedRepository.id}.`,
      details: [describeManagedCloneOrPrerequisiteFailure(ensured.error)],
    });
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
      await askDefaultedText(io, {
        message: 'Reference PR or commit',
        defaultValue: '',
        placeholder: 'none',
      })
    ).trim();
    if (identifier === '') {
      return undefined;
    }
    const result = await runWait(io, 'Resolving reference', () =>
      dependencies.resolveReference(repository, identifier, (line) =>
        log.step(dependencies.redact(line), promptOptions(io)),
      ),
    );
    if (result.ok) {
      const resolved = result.value;
      const warningText = describeReferenceWarning(resolved);
      if (warningText !== undefined) {
        log.warn(dependencies.redact(warningText), promptOptions(io));
      }
      const unfetched = resolved.pullRequest?.unfetched;
      if (unfetched !== undefined) {
        warnLines(io, dependencies.redact, {
          headline: "Can't fetch some reference commits.",
          details: [unfetched],
        });
      }
      note(
        dependencies.redact(renderReferenceNote(resolved, repository.id)),
        'Reference solution',
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
    warnLines(io, dependencies.redact, {
      headline: "Can't resolve the reference.",
      details: [description],
    });
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
    const ensured = await runWait(io, 'Fetching base commit', () =>
      dependencies.ensureManagedCommits({ id: repository.id, github }, [answer], (line) =>
        log.step(dependencies.redact(line), promptOptions(io)),
      ),
    );
    if (!ensured.ok) {
      if (ensured.error.kind === 'CancellationError') {
        throw new WizardCancelledError();
      }
      warnLines(io, dependencies.redact, {
        headline: "Can't fetch the base commit.",
        details: [describeManagedCloneOrPrerequisiteFailure(ensured.error)],
      });
    } else if (ensured.value.missing.includes(answer)) {
      const keepsUnfetchedAnswer =
        resolvedReference?.reference.kind === 'pull-request' &&
        FULL_COMMIT_HASH_PATTERN.test(answer);
      if (keepsUnfetchedAnswer) {
        return answer;
      }
      const parsed = parseGitHubRepository(github);
      const display = parsed === null ? github : formatGitHubRepository(parsed);
      warnLines(io, dependencies.redact, {
        headline: `Base commit ${answer} isn't in repository ${repository.id}.`,
        details: [`It can't be fetched from ${display}.`],
      });
    } else {
      return answer;
    }
    answer = (
      await askDefaultedText(io, {
        message: 'Base commit',
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

/** Renders the `Reference solution` note body. */
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
    await askDefaultedText(io, { message: 'Base commit', defaultValue: proposedBase.commit })
  ).trim();
  return answer === '' ? proposedBase.commit : answer;
}

/** Collects at least one readiness item, never sent to the agent. */
async function interviewReadiness(io: WizardIo): Promise<string[]> {
  const items: string[] = [];
  for (;;) {
    const item = await askText(io, {
      message: 'Confirmed prerequisite',
      validate: validateNonWhitespace,
    });
    items.push(item);
    const wantsMore = await askConfirm(io, {
      message: 'Add another prerequisite?',
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
  checkTimeout: string | undefined,
  drafted: CheckInput[] = [],
): Promise<CheckInput[]> {
  const checks: CheckInput[] = [...drafted];
  const collectionName = collection === 'acceptance' ? 'acceptance' : 'Definition of Done';
  const addAnotherQuestion = `Add another ${collectionName} check?`;
  if (drafted.length > 0) {
    const wantsMore = await askConfirm(io, {
      message: addAnotherQuestion,
      initialValue: false,
    });
    if (!wantsMore) {
      return checks;
    }
  }
  for (;;) {
    const id = await askText(io, {
      message: `${collection === 'acceptance' ? 'Acceptance' : 'Definition of Done'} check ID`,
      validate: validateId(usedCheckIds),
    });
    const kind = await askSelect<'graded' | 'command' | 'manual'>(io, {
      message: 'Check type',
      options: [
        { value: 'graded', label: 'Graded by a model' },
        { value: 'command', label: 'Command' },
        { value: 'manual', label: 'Manual' },
      ],
      initialValue: 'graded',
    });
    const description =
      kind === 'graded'
        ? await askText(io, { message: 'Criterion', validate: validateNonWhitespace })
        : await askDefaultedText(io, {
            message: 'Description',
            defaultValue: '',
            placeholder: 'none',
          });
    const required = await askConfirm(io, { message: 'Required?', initialValue: true });
    const check: CheckInput =
      kind === 'manual'
        ? { id, description, manual: true, ...(required ? {} : { required }) }
        : kind === 'graded'
          ? { id, description, ...(required ? {} : { required }) }
          : {
              id,
              description,
              ...(await interviewCommandEvaluator(io, excludedNames, checkTimeout)),
              ...(required ? {} : { required }),
            };
    usedCheckIds.add(id);
    checks.push(check);
    if (!checks.some((candidate) => candidate.required !== false)) {
      log.info(`At least one required ${collection} check is needed.`, promptOptions(io));
      continue;
    }
    const wantsMore = await askConfirm(io, {
      message: addAnotherQuestion,
      initialValue: false,
    });
    if (!wantsMore) {
      return checks;
    }
  }
}

/**
 * Asks the command line, time limit, exit codes, and variable list of one
 * command check. The command line is saved as typed. Without a
 * `run.check_timeout` to inherit, the time limit is required.
 */
async function interviewCommandEvaluator(
  io: WizardIo,
  excludedNames: ReadonlySet<string>,
  checkTimeout: string | undefined,
): Promise<Pick<CheckInput, 'run' | 'timeout' | 'exit_codes' | 'env'>> {
  const run = await askText(io, { message: 'Command', validate: validateNonWhitespace });
  const timeoutRaw =
    checkTimeout === undefined
      ? await askText(io, { message: 'Time limit', validate: validateDuration })
      : await askDefaultedText(io, {
          message: 'Time limit',
          defaultValue: '',
          placeholder: checkTimeout,
          validate: validateDuration,
        });
  const codesText = await askDefaultedText(io, {
    message: 'Passing exit codes',
    defaultValue: '0',
    validate: validateExitCodes,
  });
  const exitCodes = codesText
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => Number.parseInt(token, 10));
  const envText = await askDefaultedText(io, {
    message: 'Check variables',
    defaultValue: '',
    placeholder: 'none',
    validate: validateCheckVariableList(excludedNames),
  });
  const env = splitNames(envText);
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
  configPath: string,
  existing: TevuConfig | null,
  bootstrap: Omit<TevuConfigInput, 'version' | 'tasks'> | undefined,
  resolvedReference: ResolvedReferenceSolution | undefined,
  repository: Pick<RepositoryInput, 'id' | 'path' | 'github'>,
  prompt: string,
  description: string,
  usedCheckIds: Set<string>,
  excludedNames: ReadonlySet<string>,
  checkTimeout: string | undefined,
): Promise<DraftedTaskChecks> {
  const byHand = async (): Promise<DraftedTaskChecks> => ({
    acceptance: await interviewChecks(io, 'acceptance', usedCheckIds, excludedNames, checkTimeout),
    done: await interviewChecks(io, 'done', usedCheckIds, excludedNames, checkTimeout),
  });

  if (resolvedReference === undefined) {
    return byHand();
  }
  const role = existing?.roles?.criteria ?? bootstrap?.roles?.criteria;
  if (role === undefined) {
    log.info('No criteria model set. Enter the criteria yourself.', promptOptions(io));
    return byHand();
  }
  const outcome = await runWait(io, 'Drafting criteria', () =>
    dependencies.draftCriteria({
      configuration: currentConfiguration(existing, bootstrap),
      repository,
      reference: resolvedReference,
      prompt,
      description,
    }),
  );
  if (outcome.status === 'cancelled') {
    throw new WizardCancelledError();
  }
  if (outcome.retainedDirectory !== null) {
    warnRetainedDirectory(io, dependencies.redact, outcome.retainedDirectory);
  }
  if (outcome.status === 'failed') {
    const { cause, details } = describeDraftFailure(outcome.failure, configPath);
    warnLines(io, dependencies.redact, {
      headline: "Couldn't draft criteria.",
      details: [cause, ...details],
      next: 'Enter the criteria yourself.',
    });
    return byHand();
  }
  log.success('Criteria drafted', promptOptions(io));
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
      checkTimeout,
      draftedAcceptance,
    ),
    done: await interviewChecks(io, 'done', usedCheckIds, excludedNames, checkTimeout, draftedDone),
  };
}

/** The cause line of a failed criteria draft and the lower-layer detail lines that follow it. */
function describeDraftFailure(
  failure: CriteriaDraftFailure,
  configPath: string,
): { cause: string; details: string[] } {
  switch (failure.cause) {
    case 'changes-unreadable':
      return {
        cause: "The reference solution's changes can't be read.",
        details: [failure.detail],
      };
    case 'prompt-unredactable':
      return { cause: "The prompt couldn't be redacted, so the model wasn't called.", details: [] };
    case 'variables-unset':
      return {
        cause: `${describeUnsetNames(failure.names)} in this terminal.`,
        details: [],
      };
    case 'model-unavailable':
      return {
        cause: `OpenCode can't find ${failure.model} in tevu's environment.`,
        details: [`Add its provider to agents.opencode.providers in ${configPath}.`],
      };
    case 'timed-out':
      return { cause: `The model didn't answer within ${failure.limit}.`, details: [] };
    case 'call-failed':
      return failure.agentMessage === undefined
        ? { cause: 'The OpenCode call failed.', details: [failure.detail] }
        : { cause: `OpenCode reported "${failure.agentMessage}".`, details: [] };
    case 'reply-invalid':
      return { cause: "The model's reply wasn't a usable list.", details: [] };
  }
}

/** `<NAME> isn't set` for one variable, `<A>, <B> aren't set` for several. */
function describeUnsetNames(names: readonly string[]): string {
  return names.length === 1 ? `${names.join(', ')} isn't set` : `${names.join(', ')} aren't set`;
}

/** Both drafted lists, in review order, once the operator accepts them. */
type DraftReviewOutcome = { acceptance: string[]; done: string[] } | 'by-hand';

/** One item's location within the draft review's two lists. */
type DraftItemTarget = { collection: 'acceptance' | 'done'; index: number };

/**
 * Runs the mandatory draft review: the operator accepts,
 * edits, removes, or adds items until either accepting the draft or choosing
 * to write the criteria by hand instead. Accept stays blocked while the
 * acceptance list is empty or an item names the reference solution; the
 * Definition of Done list may be empty. Every note, log line, and
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
      redact(renderDraftReviewNote(acceptance, done, reference, io)),
      'Drafted criteria',
      promptOptions(io),
    );
    const blockingReason = firstDraftBlockingReason(acceptance, done, reference);
    const hasItems = acceptance.length + done.length > 0;
    const action = await askSelect<'accept' | 'edit' | 'remove' | 'add' | 'by-hand'>(io, {
      message: 'What next?',
      options: [
        {
          value: 'accept',
          label: 'Accept',
          ...(blockingReason === undefined ? {} : { disabled: true, hint: blockingReason }),
        },
        { value: 'edit', label: 'Edit an item', ...(hasItems ? {} : { disabled: true }) },
        { value: 'remove', label: 'Remove an item', ...(hasItems ? {} : { disabled: true }) },
        { value: 'add', label: 'Add an item' },
        { value: 'by-hand', label: 'Write my own instead' },
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
          message: 'Item',
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

    const targetCollection = unwrap(
      await withPromptSignal(io, (signal) =>
        sectionedSelect({
          message: 'Add to',
          sections: [
            {
              options: [
                { value: 'acceptance', label: 'Acceptance Criteria' },
                { value: 'done', label: 'Definition of Done' },
              ],
            },
          ],
          back: DRAFT_REVIEW_BACK_OPTION,
          ...promptOptions(io),
          ...signal,
        }),
      ),
    );
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

/**
 * Selects one item to edit or remove, or `'back'`. The headings and the
 * back label are constants and item text passes through `redact`. Escape
 * resolves `back` inside the prompt, while Ctrl-C cancels through `unwrap`.
 */
async function selectDraftItem(
  io: WizardIo,
  redact: (textContent: string) => string,
  acceptance: readonly string[],
  done: readonly string[],
  action: 'edit' | 'remove',
): Promise<DraftItemTarget | 'back'> {
  const choice = unwrap(
    await withPromptSignal(io, (signal) =>
      sectionedSelect({
        message: action === 'edit' ? 'Item to edit' : 'Item to remove',
        sections: [
          {
            heading: 'Acceptance Criteria',
            options: acceptance.map((text, index) => ({
              value: `acceptance:${String(index)}`,
              label: redact(text),
            })),
          },
          {
            heading: 'Definition of Done',
            options: done.map((text, index) => ({
              value: `done:${String(index)}`,
              label: redact(text),
            })),
          },
        ],
        back: DRAFT_REVIEW_BACK_OPTION,
        ...promptOptions(io),
        ...signal,
      }),
    ),
  );
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
  io: WizardIo,
): string {
  return [
    'Agents see every item. Keep outcomes, not details of the reference solution.',
    '',
    boldText(io, 'Acceptance Criteria'),
    ...renderDraftItemLines(acceptance, reference),
    '',
    boldText(io, 'Definition of Done'),
    ...renderDraftItemLines(done, reference),
  ].join('\n');
}

function boldText(io: WizardIo, text: string): string {
  return styleText('bold', text, { stream: io.output });
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
 * acceptance list, then any item naming the reference solution. An empty
 * Definition of Done list never blocks.
 */
function firstDraftBlockingReason(
  acceptance: readonly string[],
  done: readonly string[],
  reference: TaskReference,
): string | undefined {
  if (acceptance.length === 0) {
    return 'the acceptance criteria need at least one item';
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
    message: `Save to ${input.configPath}?`,
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
        `  agents.${name}.providers: ${renderProviderList(settings.providers ?? [])}`,
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

function renderProviderList(providers: readonly AgentProviderSetting[]): string {
  return providers.length === 0
    ? '(none)'
    : providers
        .map((provider) =>
          provider.api_key === undefined
            ? provider.id
            : `${provider.id} (api_key ${provider.api_key})`,
        )
        .join(', ');
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
    `${check.description} (${requirement}, command ${typeof check.run === 'string' ? check.run : check.run.join(' ')}, ` +
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

/**
 * Asks one Clack question with a signal that follows the wizard's cancellation
 * only while the question is open.
 *
 * Clack never removes the abort listener of a finished question, so handing
 * every question the wizard's own signal would make each earlier question write
 * a stray newline to the terminal the moment the wizard is cancelled.
 */
async function withPromptSignal<T>(
  io: WizardIo,
  ask: (options: { signal?: AbortSignal }) => Promise<T>,
): Promise<T> {
  const wizardSignal = io.signal;
  if (wizardSignal === undefined) {
    return ask({});
  }
  const questionController = new AbortController();
  const abortQuestion = (): void => questionController.abort();
  if (wizardSignal.aborted) {
    abortQuestion();
  } else {
    wizardSignal.addEventListener('abort', abortQuestion, { once: true });
  }
  try {
    return await ask({ signal: questionController.signal });
  } finally {
    wizardSignal.removeEventListener('abort', abortQuestion);
  }
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
  return unwrap(
    await withPromptSignal(io, (signal) => text({ ...options, ...promptOptions(io), ...signal })),
  );
}

/**
 * Asks a question whose default Clack shows dim and submits on an empty Enter.
 *
 * Clack validates the raw input before it applies `defaultValue`, so the
 * validator must accept empty input for the default to be reachable.
 */
async function askDefaultedText(
  io: WizardIo,
  options: {
    message: string;
    defaultValue: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string | undefined) => string | undefined;
  },
): Promise<string> {
  const { validate, placeholder, ...rest } = options;
  return askText(io, {
    ...rest,
    placeholder: placeholder ?? options.defaultValue,
    validate: (raw) => (raw === undefined || raw.length === 0 ? undefined : validate?.(raw)),
  });
}

/** Splits a list answer on commas, whitespace, or both, dropping empty tokens. */
function splitNames(raw: string): string[] {
  return raw.split(/[\s,]+/).filter((token) => token.length > 0);
}

async function askConfirm(
  io: WizardIo,
  options: { message: string; initialValue: boolean },
): Promise<boolean> {
  return unwrap(
    await withPromptSignal(io, (signal) =>
      confirm({ ...options, ...promptOptions(io), ...signal }),
    ),
  );
}

async function askSelect<Value extends string>(
  io: WizardIo,
  options: {
    message: string;
    options: Option<Value>[];
    initialValue?: Value;
  },
): Promise<Value> {
  return unwrap(
    await withPromptSignal(io, (signal) =>
      select<Value>({ ...options, ...promptOptions(io), ...signal }),
    ),
  );
}

async function askInteger(
  io: WizardIo,
  message: string,
  min: number,
  max: number,
  defaultValue: number,
): Promise<number> {
  const bounds = `an integer from ${min} through ${max}`;
  const value = await askDefaultedText(io, {
    message,
    defaultValue: String(defaultValue),
    validate: (raw) => {
      const trimmed = (raw ?? '').trim();
      if (!/^\d+$/.test(trimmed)) {
        return `enter ${bounds}`;
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed < min || parsed > max) {
        return `enter ${bounds}`;
      }
      return undefined;
    },
  });
  return Number.parseInt(value.trim(), 10);
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
    const names = splitNames(raw ?? '');
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
