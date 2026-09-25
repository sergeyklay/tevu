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

import {
  confirm,
  intro,
  isCancel,
  log,
  note,
  select,
  text,
} from "@clack/prompts";

import { AGENT_NAMES, DurationSchema, VariableNameSchema, referencedVariableName } from "../config/schema.ts";

import type { Readable, Writable } from "node:stream";
import type { CANCEL_SYMBOL, Option } from "@clack/prompts";
import type {
  CheckInput,
  JiraTrackerSettings,
  ModelDefinitionInput,
  RepositoryDefinition,
  RepositoryInput,
  TaskInput,
  TevuConfig,
  TevuConfigInput,
} from "../config/schema.ts";
import type {
  AssessmentDecision,
  AssessmentInput,
  AssessmentRecord,
  IssueSnapshot,
  LoadConfigErrorKind,
  TevuResult,
  ValidationFinding,
} from "../domain/types.ts";
import type { TaskWizardInput } from "../application/create-task.ts";
import type { AssessmentCaseContext, ManualCheckSummary } from "../application/assess.ts";

/** Interactive streams the wizards prompt on; both must be TTYs. */
export type WizardIo = {
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
  readConfig: () => Promise<TevuResult<TevuConfig | null, LoadConfigErrorKind | "PrerequisiteError">>;
  /** Reads one Jira issue exactly once with the given connection settings. */
  importJiraIssue: (
    settings: JiraTrackerSettings,
    issueKey: string,
  ) => Promise<TevuResult<IssueSnapshot, "IssueImportError" | "CancellationError">>;
  /** Reads one GitHub issue exactly once through the operator's installed `gh`. */
  importGitHubIssue: (
    reference: string,
  ) => Promise<TevuResult<IssueSnapshot, "IssueImportError" | "CancellationError">>;
  now: () => Date;
  redact: (textContent: string) => string;
};

/** Error kinds the task wizard can return. */
type TaskWizardErrorKind =
  | "ConfigParseError"
  | "ConfigValidationError"
  | "ConfigReadError"
  | "IssueImportError"
  | "PrerequisiteError"
  | "CancellationError";

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
    TevuResult<AssessmentCaseContext, "ConfigValidationError" | "ArtifactError">
  >;
  now: () => Date;
  redact: (textContent: string) => string;
};

/** Error kinds the assessment wizard can return. */
type AssessmentWizardErrorKind =
  | "ConfigValidationError"
  | "ArtifactError"
  | "PrerequisiteError"
  | "CancellationError";

const ID_RULE = "must match ^[a-z][a-z0-9-]{0,63}$";
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const FIXED_ENVIRONMENT_NAMES = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI"]);
const NEW_REPOSITORY_CHOICE = "__add-new-repository__";

/** Internal control-flow sentinel; never crosses the module boundary. */
class WizardCancelledError extends Error {
  constructor() {
    super("wizard cancelled");
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
        severity: "error",
        identifier: "trackers.jira",
        message: "task add --jira requires trackers.jira in the existing configuration",
      },
    ]);
  }
  const io = dependencies.io;
  intro("tevu task add", promptOptions(io));
  try {
    const bootstrap =
      existing.value === null
        ? await interviewBootstrap(io, request.jiraIssueKey !== undefined)
        : undefined;
    const input = await interviewTask(request, dependencies, existing.value, bootstrap);
    if (!input.ok) {
      return input;
    }
    await reviewAndConfirm(io, dependencies.redact, input.value);
    return input;
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      log.warn("Task creation cancelled; the configuration is unchanged.", promptOptions(io));
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
  if (context.value.manualChecks.length === 0) {
    return configValidationFailure([
      {
        severity: "error",
        identifier: request.caseId,
        message: `case "${request.caseId}" has no manual checks; there is nothing to assess`,
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
        redact(context.value.existing.map(renderAssessmentRecord).join("\n")),
        "Existing assessments",
        promptOptions(io),
      );
    }
    const assessor = await askText(io, {
      message: "Assessor name",
      validate: validateNonWhitespace,
    });
    const decisions: AssessmentDecision[] = [];
    for (const check of context.value.manualChecks) {
      log.step(redact(renderManualCheck(check)), promptOptions(io));
      const existingRecord = currentByCheck.get(check.checkId);
      if (existingRecord === undefined) {
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
      log.warn("Assessment cancelled; nothing was recorded.", promptOptions(io));
      return cancellationFailure();
    }
    throw error;
  }
}

/** Captures every required top-level setting for a missing configuration file. */
async function interviewBootstrap(
  io: WizardIo,
  requireJira: boolean,
): Promise<Omit<TevuConfigInput, "version" | "tasks">> {
  log.info(
    "No configuration file exists yet; capturing the complete configuration first.",
    promptOptions(io),
  );
  const outputDirectory = await askText(io, {
    message: "Run output directory (outside every repository, relative to the configuration file)",
    validate: validateNonWhitespace,
  });
  const concurrency = await askInteger(io, "Concurrent cases (1-32)", 1, 32);
  const timeout = await askText(io, {
    message: "Agent time limit per case (for example 10m)",
    validate: validateDuration,
  });
  const stopGrace = await askText(io, {
    message: "Grace period before a forced stop (for example 3s)",
    validate: validateDuration,
  });
  const checkTimeoutRaw = await askText(io, {
    message: "Default time limit for command checks (for example 5m; empty to set one per check)",
    defaultValue: "",
    validate: (value) => (value === undefined || value.trim().length === 0 ? undefined : validateDuration(value)),
  });
  const command = await askText(io, {
    message: `Command for agent "${AGENT_NAMES[0]}" (name on PATH, or a path relative to the configuration file)`,
    validate: validateNonWhitespace,
  });
  const takenNames = new Set<string>();
  const secrets = await interviewVariableList(io, "secret", takenNames);
  const env = await interviewVariableList(io, "ordinary", takenNames);
  const agentNames = new Set([...secrets, ...env]);
  const jira = await interviewJiraSettings(io, requireJira, agentNames);
  const repositories = await interviewRepositories(io);
  const models = await interviewModels(io);
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
  };
}

/** Collects one pass-through agent variable list, names only, unique across both lists. */
async function interviewVariableList(
  io: WizardIo,
  kind: "secret" | "ordinary",
  takenNames: Set<string>,
): Promise<string[]> {
  const names: string[] = [];
  for (;;) {
    const wantsEntry = await askConfirm(io, {
      message:
        names.length === 0
          ? `Add a ${kind} variable for the agent${kind === "secret" ? " (name only, never the value)" : ""}?`
          : `Add another ${kind} variable for the agent?`,
      initialValue: false,
    });
    if (!wantsEntry) {
      return names;
    }
    const name = await askText(io, {
      message: kind === "secret" ? "Secret variable name" : "Variable name",
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
      message: "Configure Jira Cloud issue import?",
      initialValue: false,
    }));
  if (!wantsJira) {
    return undefined;
  }
  const validateCredentialName = (raw: string | undefined): string | undefined => {
    const grammar = validateVariableNameGrammar(raw ?? "");
    if (grammar !== undefined) {
      return grammar;
    }
    if (agentNames.has(raw ?? "")) {
      return "Jira credential variables must not also be passed to the agent";
    }
    return undefined;
  };
  const url = await askText(io, {
    message: "Jira Cloud site URL (https)",
    validate: validateHttpsUrl,
  });
  const email = await askText(io, {
    message: "Variable holding the Jira account email",
    validate: validateCredentialName,
  });
  const token = await askText(io, {
    message: "Variable holding the Jira API token",
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
  } while (
    await askConfirm(io, { message: "Add another repository?", initialValue: false })
  );
  return repositories;
}

/** Asks the ID and local path of one repository. */
async function interviewRepositoryEntry(
  io: WizardIo,
  usedIds: ReadonlySet<string>,
): Promise<RepositoryDefinition> {
  const id = await askText(io, {
    message: "Repository ID",
    validate: validateId(usedIds),
  });
  const path = await askText(io, {
    message: `Local path of repository "${id}"`,
    validate: validateNonWhitespace,
  });
  return { id, path };
}

/** Collects at least two model entries during bootstrap. */
async function interviewModels(io: WizardIo): Promise<ModelDefinitionInput[]> {
  const models: ModelDefinitionInput[] = [];
  const usedIds = new Set<string>();
  for (;;) {
    const id = await askText(io, {
      message: "Model entry ID",
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
      log.info("A runnable configuration needs at least two model entries.", promptOptions(io));
      continue;
    }
    const wantsMore = await askConfirm(io, {
      message: "Add another model?",
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
  bootstrap: Omit<TevuConfigInput, "version" | "tasks"> | undefined,
): Promise<TevuResult<TaskWizardInput, "IssueImportError">> {
  const io = dependencies.io;
  const jiraSettings = existing?.trackers?.jira ?? bootstrap?.trackers?.jira;
  const source = await interviewSource(request, dependencies, jiraSettings);
  if (!source.ok) {
    return source;
  }
  const repositories = existing?.repositories ?? bootstrap?.repositories ?? [];
  const { repo, newRepository } = await interviewRepositorySelection(io, repositories);
  const baseCommit = (
    await askText(io, {
      message: "Base commit (a commit from before the fix; resolved and pinned when saved)",
      validate: validateNonWhitespace,
    })
  ).trim();
  const taskId = await askText(io, {
    message: "Task ID",
    validate: validateId(new Set((existing?.tasks ?? []).map((task) => task.id))),
  });
  const title = await askText(io, {
    message: "Task title",
    ...(source.value.importedTitle === undefined ? {} : { initialValue: source.value.importedTitle }),
    validate: validateNonWhitespace,
  });
  const description = await askText(io, {
    message: "Task description",
    validate: validateNonWhitespace,
  });
  const prompt = await askText(io, {
    message: "Task prompt sent to every model",
    validate: validateNonWhitespace,
  });
  const readiness = await interviewReadiness(io);
  const usedCheckIds = new Set<string>();
  const configuredAgents = existing?.agents ?? bootstrap?.agents ?? {};
  const agentNames = new Set(
    Object.values(configuredAgents).flatMap((settings) => [...(settings.secrets ?? []), ...(settings.env ?? [])]),
  );
  const jiraNames = new Set(
    jiraSettings === undefined
      ? []
      : [referencedVariableName(jiraSettings.email), referencedVariableName(jiraSettings.token)],
  );
  const excludedNames = new Set([...agentNames, ...jiraNames]);
  const acceptance = await interviewChecks(io, "acceptance", usedCheckIds, excludedNames);
  const done = await interviewChecks(io, "done", usedCheckIds, excludedNames);
  const task: TaskInput = {
    id: taskId,
    title,
    repo,
    base_commit: baseCommit,
    prompt,
    description,
    ...(source.value.source === undefined ? {} : { source: source.value.source }),
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
type SourceSelection = { source: TaskInput["source"]; importedTitle?: string };

/** Selects the task source; a Jira or GitHub issue is imported once and displayed. */
async function interviewSource(
  request: TaskWizardRequest,
  dependencies: TaskWizardDependencies,
  jiraSettings: JiraTrackerSettings | undefined,
): Promise<TevuResult<SourceSelection, "IssueImportError">> {
  const io = dependencies.io;
  const kind =
    request.jiraIssueKey !== undefined
      ? "jira"
      : request.githubIssueReference !== undefined
        ? "github"
        : await askSelect<"manual" | "jira" | "github">(io, {
            message: "Task source",
            options: [
              { value: "manual", label: "Written by hand" },
              {
                value: "jira",
                label: "Jira Cloud import",
                ...(jiraSettings === undefined ? { disabled: true, hint: "requires trackers.jira" } : {}),
              },
              { value: "github", label: "GitHub issue import" },
            ],
          });
  if (kind === "manual") {
    return { ok: true, value: { source: undefined } };
  }
  if (kind === "github") {
    return interviewImportedSource(io, dependencies, "github", async () => {
      const reference =
        request.githubIssueReference ??
        (
          await askText(io, {
            message: "GitHub issue (OWNER/REPO#NUMBER or issue URL)",
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
        kind: "IssueImportError",
        tracker: "jira-cloud",
        reference: request.jiraIssueKey ?? "",
        reason: "Jira import is not available because no Jira settings are configured",
      },
    };
  }
  return interviewImportedSource(io, dependencies, "jira", async () => {
    const issueKey =
      request.jiraIssueKey ??
      (
        await askText(io, {
          message: "Jira issue key",
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
  kind: "jira" | "github",
  importIssue: () => Promise<TevuResult<IssueSnapshot, "IssueImportError">>,
): Promise<TevuResult<SourceSelection, "IssueImportError">> {
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
  repositories: readonly RepositoryDefinition[],
): Promise<{ repo: string; newRepository?: RepositoryDefinition }> {
  const choice = await askSelect<string>(io, {
    message: "Task repository",
    options: [
      ...repositories.map((repository) => ({
        value: repository.id,
        label: `${repository.id} (${repository.path})`,
      })),
      { value: NEW_REPOSITORY_CHOICE, label: "Add a new repository" },
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

/** Collects at least one readiness item, never sent to the agent. */
async function interviewReadiness(io: WizardIo): Promise<string[]> {
  const items: string[] = [];
  for (;;) {
    const item = await askText(io, {
      message: "Readiness item you have confirmed",
      validate: validateNonWhitespace,
    });
    items.push(item);
    const wantsMore = await askConfirm(io, {
      message: "Add another readiness item?",
      initialValue: false,
    });
    if (!wantsMore) {
      return items;
    }
  }
}

/** Collects one check collection until it contains at least one required check. */
async function interviewChecks(
  io: WizardIo,
  collection: "acceptance" | "done",
  usedCheckIds: Set<string>,
  excludedNames: ReadonlySet<string>,
): Promise<CheckInput[]> {
  const checks: CheckInput[] = [];
  for (;;) {
    const id = await askText(io, {
      message: `New ${collection} check ID`,
      validate: validateId(usedCheckIds),
    });
    const description = await askText(io, {
      message: `Description of "${id}"`,
      defaultValue: "",
    });
    const required = await askConfirm(io, {
      message: `Is "${id}" required?`,
      initialValue: true,
    });
    const kind = await askSelect<"command" | "manual">(io, {
      message: `How is "${id}" checked?`,
      options: [
        { value: "command", label: "Command (literal argv, no shell)" },
        { value: "manual", label: "Manual (assessed through tevu assess)" },
      ],
    });
    const check: CheckInput =
      kind === "manual"
        ? { id, description, manual: true, ...(required ? {} : { required }) }
        : { id, description, ...(await interviewCommandEvaluator(io, id, excludedNames)), ...(required ? {} : { required }) };
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
): Promise<Pick<CheckInput, "run" | "timeout" | "exit_codes" | "env">> {
  const argvText = await askText(io, {
    message: `Command for "${checkId}" as a JSON array, e.g. ["npm","test"]`,
    validate: validateArgvJson,
  });
  const run = JSON.parse(argvText) as [string, ...string[]];
  const timeoutRaw = await askText(io, {
    message: `Time limit for "${checkId}" (for example 2m; empty to use run.check_timeout)`,
    defaultValue: "",
    validate: (value) => (value === undefined || value.trim().length === 0 ? undefined : validateDuration(value)),
  });
  const codesText = await askText(io, {
    message: `Exit codes that count as a pass for "${checkId}" (comma-separated; empty for 0)`,
    defaultValue: "0",
    validate: validateExitCodes,
  });
  const exitCodes = codesText
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => Number.parseInt(token, 10));
  const envText = await askText(io, {
    message: `Variables for "${checkId}" (comma-separated names; empty for none)`,
    defaultValue: "",
    validate: validateCheckVariableList(excludedNames),
  });
  const env = envText
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return {
    run,
    ...(timeoutRaw.trim().length === 0 ? {} : { timeout: timeoutRaw.trim() }),
    ...(exitCodes.length === 1 && exitCodes[0] === 0 ? {} : { exit_codes: exitCodes }),
    ...(env.length === 0 ? {} : { env }),
  };
}

/** Shows the single credential-redacted review; declining cancels without a write. */
async function reviewAndConfirm(
  io: WizardIo,
  redact: (textContent: string) => string,
  input: TaskWizardInput,
): Promise<void> {
  note(redact(renderTaskReview(input)), "Review", promptOptions(io));
  const accepted = await askConfirm(io, {
    message: `Write this to ${input.configPath}?`,
    initialValue: true,
  });
  if (!accepted) {
    throw new WizardCancelledError();
  }
}

/** Renders the complete wizard input for the TTY-only final review. */
function renderTaskReview(input: TaskWizardInput): string {
  const lines: string[] = [];
  if (input.bootstrap !== undefined) {
    const bootstrap = input.bootstrap;
    lines.push(
      "New configuration:",
      `  run.output_dir: ${bootstrap.run.output_dir}`,
      `  run.concurrency: ${bootstrap.run.concurrency}`,
      `  run.timeout: ${bootstrap.run.timeout}`,
      `  run.stop_grace: ${bootstrap.run.stop_grace}`,
      ...(bootstrap.run.check_timeout === undefined ? [] : [`  run.check_timeout: ${bootstrap.run.check_timeout}`]),
      ...Object.entries(bootstrap.agents).flatMap(([name, settings]) => [
        `  agents.${name}.command: ${settings.command}`,
        `  agents.${name}.secrets: ${renderVariableList(settings.secrets ?? [])}`,
        `  agents.${name}.env: ${renderVariableList(settings.env ?? [])}`,
      ]),
    );
    if (bootstrap.trackers?.jira !== undefined) {
      lines.push(
        `  trackers.jira.url: ${bootstrap.trackers.jira.url}`,
        `  trackers.jira credentials: ${bootstrap.trackers.jira.email}, ${bootstrap.trackers.jira.token} (names only)`,
      );
    }
    for (const repository of bootstrap.repositories) {
      lines.push(`  repositories: ${repository.id} (${repository.path})`);
    }
    for (const model of bootstrap.models) {
      lines.push(`  models: ${model.id}: ${model.model} (effort ${model.effort})`);
    }
    lines.push("");
  }
  const task = input.task;
  lines.push(`Task ${task.id}:`);
  if (input.newRepository !== undefined) {
    lines.push(`  new repository ${input.newRepository.id}: ${input.newRepository.path}`);
  }
  lines.push(`  repo: ${task.repo}`, `  base_commit: ${task.base_commit}`, `  title: ${task.title}`);
  if (task.source === undefined) {
    lines.push("  source: (written by hand)");
  } else {
    lines.push(
      `  source: ${task.source.kind} ${task.source.key}`,
      `  imported at: ${task.source.imported_at}`,
      `  imported title: ${task.source.title}`,
      `  imported body: ${task.source.body}`,
    );
  }
  lines.push(`  description: ${task.description}`, `  prompt: ${task.prompt}`);
  for (const item of task.readiness) {
    lines.push(`  readiness: ${item}`);
  }
  for (const [label, checks] of [
    ["acceptance", task.checks.acceptance],
    ["done", task.checks.done],
  ] as const) {
    for (const check of checks) {
      lines.push(`  ${label} ${check.id}: ${renderCheck(check)}`);
    }
  }
  return lines.join("\n");
}

function renderVariableList(names: readonly string[]): string {
  return names.length === 0 ? "(none)" : names.join(", ");
}

function renderCheck(check: CheckInput): string {
  const requirement = check.required === false ? "optional" : "required";
  if (check.manual === true) {
    return `${check.description} (${requirement}, manual)`;
  }
  const env = check.env === undefined || check.env.length === 0 ? "" : `, variables ${check.env.join(",")}`;
  return (
    `${check.description} (${requirement}, command ${JSON.stringify(check.run)}, ` +
    `timeout ${check.timeout ?? "run.check_timeout"}, ` +
    `exit codes ${(check.exit_codes ?? [0]).join(",")}${env})`
  );
}

function renderManualCheck(check: ManualCheckSummary): string {
  const requirement = check.required ? "required" : "optional";
  return `${check.checkId} (${check.category}, ${requirement}): ${check.description}`;
}

function renderAssessmentRecord(record: AssessmentRecord): string {
  const noteSuffix = record.note.length === 0 ? "" : ` - ${record.note}`;
  return `${record.checkId}: ${record.verdict} by ${record.assessor} at ${record.assessedAt}${noteSuffix}`;
}

/** Fails with `PrerequisiteError` unless both wizard streams are TTYs. */
function requireInteractiveTty(
  io: WizardIo,
): TevuResult<never, "PrerequisiteError"> | null {
  const failing: string[] = [];
  if (io.input.isTTY !== true) {
    failing.push("stdin");
  }
  if (io.output.isTTY !== true) {
    failing.push("stdout");
  }
  if (failing.length === 0) {
    return null;
  }
  return {
    ok: false,
    error: {
      kind: "PrerequisiteError",
      tool: "terminal",
      expected: "an interactive TTY on stdin and stdout",
      actual: `${failing.join(" and ")} ${failing.length === 1 ? "is" : "are"} not a TTY`,
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
  result: TevuResult<T, "IssueImportError" | "CancellationError">,
): TevuResult<T, "IssueImportError"> {
  if (result.ok || result.error.kind === "IssueImportError") {
    return result as TevuResult<T, "IssueImportError">;
  }
  throw new WizardCancelledError();
}

async function askText(
  io: WizardIo,
  options: {
    message: string;
    defaultValue?: string;
    initialValue?: string;
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
      const trimmed = (raw ?? "").trim();
      const bounds = max === undefined ? `an integer of at least ${min}` : `an integer from ${min} through ${max}`;
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

async function askVerdict(io: WizardIo, checkId: string): Promise<"passed" | "failed"> {
  return askSelect<"passed" | "failed">(io, {
    message: `Verdict for "${checkId}"`,
    options: [
      { value: "passed", label: "passed" },
      { value: "failed", label: "failed" },
    ],
  });
}

async function askNote(io: WizardIo, verdict: "passed" | "failed"): Promise<string> {
  return askText(io, {
    message: verdict === "failed" ? "Note (required for a failed verdict)" : "Note (optional)",
    defaultValue: "",
    ...(verdict === "failed"
      ? {
          validate: (value: string | undefined) =>
            (value ?? "").trim().length === 0
              ? "a failed verdict requires a non-empty note"
              : undefined,
        }
      : {}),
  });
}

function validateNonWhitespace(value: string | undefined): string | undefined {
  return (value ?? "").trim().length === 0 ? "a non-empty value is required" : undefined;
}

function validateId(
  usedIds: ReadonlySet<string>,
): (value: string | undefined) => string | undefined {
  return (raw) => {
    const value = raw ?? "";
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
  return isModelIdentifier(value ?? "") ? undefined : 'model must be "<provider>/<model>"';
}

function isModelIdentifier(value: string): value is `${string}/${string}` {
  return /^.+\/.+$/.test(value);
}

function validateHttpsUrl(value: string | undefined): string | undefined {
  try {
    return new URL(value ?? "").protocol === "https:" ? undefined : "an https:// URL is required";
  } catch {
    return "an https:// URL is required";
  }
}

/** Reuses the schema's Duration grammar (including the E1 bound) rather than a second regex. */
function validateDuration(value: string | undefined): string | undefined {
  const result = DurationSchema.safeParse((value ?? "").trim());
  if (result.success) {
    return undefined;
  }
  return result.error.issues[0]?.message ?? "invalid duration";
}

function validateVariableNameGrammar(value: string): string | undefined {
  const result = VariableNameSchema.safeParse(value);
  if (result.success) {
    return undefined;
  }
  return result.error.issues[0]?.message ?? "invalid variable name";
}

function isFixedEnvironmentName(name: string): boolean {
  return FIXED_ENVIRONMENT_NAMES.has(name) || name.startsWith("XDG_");
}

function validateVariableName(
  takenNames: ReadonlySet<string>,
): (value: string | undefined) => string | undefined {
  return (raw) => {
    const value = raw ?? "";
    const grammar = validateVariableNameGrammar(value);
    if (grammar !== undefined) {
      return grammar;
    }
    if (isFixedEnvironmentName(value)) {
      return "PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract";
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
    const names = (raw ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    const seen = new Set<string>();
    for (const name of names) {
      const grammar = validateVariableNameGrammar(name);
      if (grammar !== undefined) {
        return `"${name}": ${grammar}`;
      }
      if (isFixedEnvironmentName(name)) {
        return "PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract";
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
    parsed = JSON.parse(value ?? "");
  } catch {
    return 'enter a JSON array of strings, e.g. ["npm","test"]';
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((element) => typeof element === "string") ||
    parsed[0] === ""
  ) {
    return "the argv array needs a non-empty executable followed by literal string arguments";
  }
  return undefined;
}

function validateExitCodes(value: string | undefined): string | undefined {
  const tokens = (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return undefined;
  }
  if (tokens.some((token) => !/^-?\d+$/.test(token))) {
    return "enter one or more comma-separated integers, e.g. 0";
  }
  return undefined;
}

function configValidationFailure(
  findings: ValidationFinding[],
): TevuResult<never, "ConfigValidationError"> {
  return { ok: false, error: { kind: "ConfigValidationError", findings } };
}

function cancellationFailure(): TevuResult<never, "CancellationError"> {
  return { ok: false, error: { kind: "CancellationError", activeCaseIds: [] } };
}
