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
  multiselect,
  note,
  select,
  text,
} from "@clack/prompts";

import type { Readable, Writable } from "node:stream";
import type { CANCEL_SYMBOL, Option } from "@clack/prompts";
import type {
  CheckDefinition,
  ContenderDefinition,
  EnvironmentVariableDefinition,
  JiraCloudConfig,
  ReadyItem,
  RepositoryDefinition,
  TevuConfig,
} from "../config/schema.ts";
import type {
  AssessmentDecision,
  AssessmentInput,
  AssessmentRecord,
  ConfigBootstrapInput,
  IssueSnapshot,
  LoadConfigErrorKind,
  TaskSourceRequest,
  TaskWizardInput,
  TevuResult,
  ValidationFinding,
} from "../domain/types.ts";

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
    settings: JiraCloudConfig,
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

/** One manual check of the assessed case, in configuration order. */
export type ManualCheckSummary = {
  checkId: string;
  category: "acceptance" | "definition-of-done";
  description: string;
  required: boolean;
};

/** Pre-read display context for one case's manual assessment. */
export type AssessmentCaseContext = {
  /** Every manual check of the case's task, in configuration order. */
  manualChecks: ManualCheckSummary[];
  /** Current assessment records; replaced ones live in artifact history, not here. */
  existing: AssessmentRecord[];
};

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
 * setting, at least one repository, and at least two contenders before the
 * first task question. A Jira source is
 * imported exactly once and displayed; the snapshot travels inside the
 * returned input so task creation never reads Jira again. The final redacted
 * review must be accepted before the input is returned; the caller then
 * delegates the single configuration write to `createTask`.
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
  if (request.jiraIssueKey !== undefined && existing.value !== null && existing.value.jira === undefined) {
    return configValidationFailure([
      {
        severity: "error",
        identifier: "jira",
        message: "task add --jira requires Jira settings in the existing configuration",
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
): Promise<ConfigBootstrapInput> {
  log.info(
    "No configuration file exists yet; capturing the complete configuration first.",
    promptOptions(io),
  );
  const artifactsDirectory = await askText(io, {
    message: "Artifacts directory (outside every repository)",
    validate: validateNonWhitespace,
  });
  const concurrency = await askInteger(io, "Execution concurrency (1-32)", 1, 32);
  const caseTimeoutMs = await askInteger(io, "Case timeout in milliseconds", 1);
  const terminationGraceMs = await askInteger(io, "Termination grace in milliseconds", 1);
  const executable = await askText(io, {
    message: "OpenCode executable (command name or path)",
    validate: validateNonWhitespace,
  });
  const takenNames = new Set<string>();
  const opencodeEnvironment = await interviewEnvironmentList(io, "OpenCode", false, takenNames);
  const evaluatorEnvironment = await interviewEnvironmentList(io, "evaluator", true, takenNames);
  const evaluatorNames = new Set(evaluatorEnvironment.map((entry) => entry.name));
  const jira = await interviewJiraSettings(io, requireJira, evaluatorNames);
  const repositories = await interviewRepositories(io);
  const contenders = await interviewContenders(io);
  return {
    artifacts: { directory: artifactsDirectory },
    execution: {
      concurrency,
      caseTimeoutMs,
      terminationGraceMs,
      opencodeEnvironment,
      evaluatorEnvironment,
    },
    opencode: { executable },
    ...(jira === undefined ? {} : { jira }),
    repositories,
    contenders,
  };
}

/** Collects one pass-through environment variable list, names and classifications only. */
async function interviewEnvironmentList(
  io: WizardIo,
  label: string,
  ordinaryOnly: boolean,
  takenNames: Set<string>,
): Promise<EnvironmentVariableDefinition[]> {
  const entries: EnvironmentVariableDefinition[] = [];
  for (;;) {
    const wantsEntry = await askConfirm(io, {
      message:
        entries.length === 0
          ? `Add a ${label} environment variable (names only, never values)?`
          : `Add another ${label} environment variable?`,
      initialValue: false,
    });
    if (!wantsEntry) {
      return entries;
    }
    const name = await askText(io, {
      message: `${label} environment variable name`,
      validate: validateEnvironmentName(takenNames),
    });
    const classification = ordinaryOnly
      ? "ordinary"
      : await askSelect<EnvironmentVariableDefinition["classification"]>(io, {
          message: `Classification for "${name}"`,
          options: [
            { value: "provider-credential", label: "provider-credential" },
            { value: "secret", label: "secret" },
            { value: "ordinary", label: "ordinary" },
          ],
        });
    takenNames.add(name);
    entries.push({ name, classification });
  }
}

/** Captures optional Jira Cloud settings; forced when `task add --jira` started the wizard. */
async function interviewJiraSettings(
  io: WizardIo,
  requireJira: boolean,
  evaluatorNames: ReadonlySet<string>,
): Promise<JiraCloudConfig | undefined> {
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
    const value = raw ?? "";
    if (value.trim().length === 0) {
      return "a non-empty environment variable name is required";
    }
    if (evaluatorNames.has(value)) {
      return "Jira credential variables must not appear in execution.evaluatorEnvironment";
    }
    return undefined;
  };
  return {
    baseUrl: await askText(io, {
      message: "Jira Cloud base URL (https)",
      validate: validateHttpsUrl,
    }),
    emailEnvironmentVariable: await askText(io, {
      message: "Environment variable holding the Jira account email",
      validate: validateCredentialName,
    }),
    tokenEnvironmentVariable: await askText(io, {
      message: "Environment variable holding the Jira API token",
      validate: validateCredentialName,
    }),
  };
}

/** Collects at least one source repository during bootstrap. */
async function interviewRepositories(io: WizardIo): Promise<RepositoryDefinition[]> {
  const repositories: RepositoryDefinition[] = [];
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

/** Collects at least two contenders during bootstrap. */
async function interviewContenders(io: WizardIo): Promise<ContenderDefinition[]> {
  const contenders: ContenderDefinition[] = [];
  const usedIds = new Set<string>();
  for (;;) {
    const id = await askText(io, {
      message: "Contender ID",
      validate: validateId(usedIds),
    });
    const model = await askModel(io, id);
    const variant = await askText(io, {
      message: `Effort variant for "${id}"`,
      validate: validateNonWhitespace,
    });
    usedIds.add(id);
    contenders.push({ id, model, variant });
    if (contenders.length < 2) {
      log.info("A runnable configuration needs at least two contenders.", promptOptions(io));
      continue;
    }
    const wantsMore = await askConfirm(io, {
      message: "Add another contender?",
      initialValue: false,
    });
    if (!wantsMore) {
      return contenders;
    }
  }
}

/** Interviews for one complete task after any bootstrap answers were captured. */
async function interviewTask(
  request: TaskWizardRequest,
  dependencies: TaskWizardDependencies,
  existing: TevuConfig | null,
  bootstrap: ConfigBootstrapInput | undefined,
): Promise<TevuResult<TaskWizardInput, "IssueImportError">> {
  const io = dependencies.io;
  const jiraSettings = existing?.jira ?? bootstrap?.jira;
  const source = await interviewSource(request, dependencies, jiraSettings);
  if (!source.ok) {
    return source;
  }
  const repositories = existing?.repositories ?? bootstrap?.repositories ?? [];
  const { repositoryId, newRepository } = await interviewRepositorySelection(io, repositories);
  const startCommit = (
    await askText(io, {
      message: "Pinned start commit (resolved and pinned during creation)",
      validate: validateNonWhitespace,
    })
  ).trim();
  const taskId = await askText(io, {
    message: "Task ID",
    validate: validateId(new Set((existing?.tasks ?? []).map((task) => task.id))),
  });
  const description = await askText(io, {
    message: "Task description",
    validate: validateNonWhitespace,
  });
  const prompt = await askText(io, {
    message: "Task prompt handed to every contender",
    validate: validateNonWhitespace,
  });
  const definitionOfReady = await interviewDefinitionOfReady(io);
  const usedCheckIds = new Set<string>();
  const evaluatorNames = (
    existing?.execution.evaluatorEnvironment ??
    bootstrap?.execution.evaluatorEnvironment ??
    []
  ).map((entry) => entry.name);
  const acceptanceCriteria = await interviewChecks(
    io,
    "acceptance criterion",
    usedCheckIds,
    evaluatorNames,
  );
  const definitionOfDone = await interviewChecks(
    io,
    "Definition of Done check",
    usedCheckIds,
    evaluatorNames,
  );
  return {
    ok: true,
    value: {
      configPath: request.configPath,
      ...(bootstrap === undefined ? {} : { bootstrap }),
      repositoryId,
      ...(newRepository === undefined ? {} : { newRepository }),
      taskId,
      startCommit,
      source: source.value,
      description,
      prompt,
      definitionOfReady,
      acceptanceCriteria,
      definitionOfDone,
    },
  };
}

/** Selects the task source; a Jira or GitHub issue is imported once and displayed. */
async function interviewSource(
  request: TaskWizardRequest,
  dependencies: TaskWizardDependencies,
  jiraSettings: JiraCloudConfig | undefined,
): Promise<TevuResult<TaskSourceRequest, "IssueImportError">> {
  const io = dependencies.io;
  const kind =
    request.jiraIssueKey !== undefined
      ? "jira-cloud"
      : request.githubIssueReference !== undefined
        ? "github-issue"
        : await askSelect<"manual" | "jira-cloud" | "github-issue">(io, {
            message: "Task source",
            options: [
              { value: "manual", label: "Manual" },
              {
                value: "jira-cloud",
                label: "Jira Cloud import",
                ...(jiraSettings === undefined
                  ? { disabled: true, hint: "requires configured Jira settings" }
                  : {}),
              },
              { value: "github-issue", label: "GitHub issue import" },
            ],
          });
  if (kind === "manual") {
    const title = await askText(io, {
      message: "Source title",
      validate: validateNonWhitespace,
    });
    const rawReference = await askText(io, {
      message: "Source reference (optional, submit empty to skip)",
      defaultValue: "",
    });
    const reference = rawReference.trim().length === 0 ? undefined : rawReference;
    return {
      ok: true,
      value: reference === undefined ? { kind: "manual", title } : { kind: "manual", reference, title },
    };
  }
  if (kind === "github-issue") {
    return interviewGitHubSource(io, dependencies, request.githubIssueReference);
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
  const issueKey =
    request.jiraIssueKey ??
    (
      await askText(io, {
        message: "Jira issue key",
        validate: validateNonWhitespace,
      })
    ).trim();
  const imported = unwrapImportResult(await dependencies.importJiraIssue(jiraSettings, issueKey));
  if (!imported.ok) {
    return imported;
  }
  const importedAt = dependencies.now().toISOString();
  note(
    dependencies.redact(
      `${imported.value.summary}\n\n${imported.value.description}`,
    ),
    `Imported ${imported.value.issueKey} (one-time snapshot)`,
    promptOptions(io),
  );
  return {
    ok: true,
    value: {
      kind: "jira-cloud",
      issueKey: imported.value.issueKey,
      snapshot: { ...imported.value, importedAt },
    },
  };
}

/** Imports one GitHub issue through the operator's installed `gh` and displays it. */
async function interviewGitHubSource(
  io: WizardIo,
  dependencies: TaskWizardDependencies,
  githubIssueReference: string | undefined,
): Promise<TevuResult<TaskSourceRequest, "IssueImportError">> {
  const reference =
    githubIssueReference ??
    (
      await askText(io, {
        message: "GitHub issue (OWNER/REPO#NUMBER or issue URL)",
        validate: validateNonWhitespace,
      })
    ).trim();
  const imported = unwrapImportResult(await dependencies.importGitHubIssue(reference));
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
    value: { kind: "github-issue", snapshot: { ...imported.value, importedAt } },
  };
}

/** Picks the task repository from configured entries or captures a new one. */
async function interviewRepositorySelection(
  io: WizardIo,
  repositories: RepositoryDefinition[],
): Promise<{ repositoryId: string; newRepository?: RepositoryDefinition }> {
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
    return { repositoryId: choice };
  }
  const entry = await interviewRepositoryEntry(
    io,
    new Set(repositories.map((repository) => repository.id)),
  );
  return { repositoryId: entry.id, newRepository: entry };
}

/** Collects at least one confirmed Definition of Ready item. */
async function interviewDefinitionOfReady(io: WizardIo): Promise<ReadyItem[]> {
  const items: ReadyItem[] = [];
  const usedIds = new Set<string>();
  for (;;) {
    const id = await askText(io, {
      message: "Definition of Ready item ID",
      validate: validateId(usedIds),
    });
    const description = await askText(io, {
      message: `Definition of Ready item "${id}" description`,
      defaultValue: "",
    });
    const confirmed = await askConfirm(io, {
      message: `Confirm "${id}" is satisfied?`,
      initialValue: true,
    });
    if (!confirmed) {
      log.warn(
        "Only confirmed Definition of Ready items can be recorded; the item was discarded.",
        promptOptions(io),
      );
    } else {
      usedIds.add(id);
      items.push({ id, description, confirmed: true });
    }
    if (items.length === 0) {
      log.info("At least one confirmed Definition of Ready item is required.", promptOptions(io));
      continue;
    }
    const wantsMore = await askConfirm(io, {
      message: "Add another Definition of Ready item?",
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
  label: string,
  usedCheckIds: Set<string>,
  evaluatorNames: string[],
): Promise<CheckDefinition[]> {
  const checks: CheckDefinition[] = [];
  for (;;) {
    const id = await askText(io, {
      message: `New ${label} ID`,
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
      message: `Evaluator for "${id}"`,
      options: [
        { value: "command", label: "Command (literal argv, no shell)" },
        { value: "manual", label: "Manual (assessed through tevu assess)" },
      ],
    });
    const evaluator =
      kind === "manual"
        ? ({ kind: "manual" } as const)
        : await interviewCommandEvaluator(io, id, evaluatorNames);
    usedCheckIds.add(id);
    checks.push({ id, description, required, evaluator });
    if (!checks.some((check) => check.required)) {
      log.info(`At least one required ${label} is needed.`, promptOptions(io));
      continue;
    }
    const wantsMore = await askConfirm(io, {
      message: `Add another ${label}?`,
      initialValue: false,
    });
    if (!wantsMore) {
      return checks;
    }
  }
}

/** Asks argv, timeout, success exit codes, and the ordinary allowlist of one command evaluator. */
async function interviewCommandEvaluator(
  io: WizardIo,
  checkId: string,
  evaluatorNames: string[],
): Promise<CheckDefinition["evaluator"]> {
  const argvText = await askText(io, {
    message: `Command argv for "${checkId}" as a JSON array, e.g. ["npm","test"]`,
    validate: validateArgvJson,
  });
  const argv = JSON.parse(argvText) as [string, ...string[]];
  const timeoutMs = await askInteger(io, `Timeout for "${checkId}" in milliseconds`, 1);
  const codesText = await askText(io, {
    message: `Success exit codes for "${checkId}" (comma-separated integers, e.g. 0)`,
    validate: validateExitCodes,
  });
  const successExitCodes = codesText
    .split(",")
    .map((token) => Number.parseInt(token.trim(), 10));
  const environmentAllowlist =
    evaluatorNames.length === 0
      ? []
      : await askMultiselect(io, {
          message: `Ordinary evaluator variables allowed for "${checkId}"`,
          options: evaluatorNames.map((name) => ({ value: name, label: name })),
        });
  return { kind: "command", argv, timeoutMs, successExitCodes, environmentAllowlist };
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
      `  artifacts.directory: ${bootstrap.artifacts.directory}`,
      `  execution.concurrency: ${bootstrap.execution.concurrency}`,
      `  execution.caseTimeoutMs: ${bootstrap.execution.caseTimeoutMs}`,
      `  execution.terminationGraceMs: ${bootstrap.execution.terminationGraceMs}`,
      `  opencode.executable: ${bootstrap.opencode.executable}`,
      `  opencodeEnvironment: ${renderEnvironmentList(bootstrap.execution.opencodeEnvironment)}`,
      `  evaluatorEnvironment: ${renderEnvironmentList(bootstrap.execution.evaluatorEnvironment)}`,
    );
    if (bootstrap.jira !== undefined) {
      lines.push(
        `  jira.baseUrl: ${bootstrap.jira.baseUrl}`,
        `  jira credentials: ${bootstrap.jira.emailEnvironmentVariable}, ${bootstrap.jira.tokenEnvironmentVariable} (names only)`,
      );
    }
    for (const repository of bootstrap.repositories) {
      lines.push(`  repository ${repository.id}: ${repository.path}`);
    }
    for (const contender of bootstrap.contenders) {
      lines.push(`  contender ${contender.id}: ${contender.model} (${contender.variant})`);
    }
    lines.push("");
  }
  lines.push(`Task ${input.taskId}:`);
  if (input.newRepository !== undefined) {
    lines.push(`  new repository ${input.newRepository.id}: ${input.newRepository.path}`);
  }
  lines.push(`  repository: ${input.repositoryId}`, `  startCommit: ${input.startCommit}`);
  if (input.source.kind === "manual") {
    lines.push(`  source: manual "${input.source.title}"`);
    if (input.source.reference !== undefined) {
      lines.push(`  source reference: ${input.source.reference}`);
    }
  } else if (input.source.kind === "jira-cloud") {
    lines.push(`  source: jira-cloud ${input.source.issueKey}`);
    if (input.source.snapshot !== undefined) {
      lines.push(
        `  imported at: ${input.source.snapshot.importedAt}`,
        `  imported summary: ${input.source.snapshot.summary}`,
        `  imported description: ${input.source.snapshot.description}`,
      );
    }
  } else {
    lines.push(
      `  source: github-issue ${input.source.snapshot.issueKey}`,
      `  imported at: ${input.source.snapshot.importedAt}`,
      `  imported summary: ${input.source.snapshot.summary}`,
      `  imported description: ${input.source.snapshot.description}`,
    );
  }
  lines.push(`  description: ${input.description}`, `  prompt: ${input.prompt}`);
  for (const item of input.definitionOfReady) {
    lines.push(`  ready ${item.id}: ${item.description} (confirmed)`);
  }
  for (const [title, checks] of [
    ["acceptance", input.acceptanceCriteria],
    ["definition of done", input.definitionOfDone],
  ] as const) {
    for (const check of checks) {
      lines.push(`  ${title} ${check.id}: ${renderCheck(check)}`);
    }
  }
  return lines.join("\n");
}

function renderEnvironmentList(entries: EnvironmentVariableDefinition[]): string {
  if (entries.length === 0) {
    return "(none)";
  }
  return entries.map((entry) => `${entry.name} [${entry.classification}]`).join(", ");
}

function renderCheck(check: CheckDefinition): string {
  const requirement = check.required ? "required" : "optional";
  if (check.evaluator.kind === "manual") {
    return `${check.description} (${requirement}, manual)`;
  }
  const allowlist =
    check.evaluator.environmentAllowlist.length === 0
      ? ""
      : `, allowlist ${check.evaluator.environmentAllowlist.join(",")}`;
  return (
    `${check.description} (${requirement}, command ${JSON.stringify(check.evaluator.argv)}, ` +
    `timeout ${check.evaluator.timeoutMs}ms, ` +
    `success codes ${check.evaluator.successExitCodes.join(",")}${allowlist})`
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

async function askMultiselect(
  io: WizardIo,
  options: {
    message: string;
    options: Array<{ value: string; label: string }>;
  },
): Promise<string[]> {
  return unwrap(
    await multiselect<string>({ ...options, required: false, ...promptOptions(io) }),
  );
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

async function askModel(io: WizardIo, contenderId: string): Promise<ContenderDefinition["model"]> {
  for (;;) {
    const value = await askText(io, {
      message: `Model for "${contenderId}" (provider/model)`,
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

function isModelIdentifier(value: string): value is ContenderDefinition["model"] {
  return /^.+\/.+$/.test(value);
}

function validateHttpsUrl(value: string | undefined): string | undefined {
  try {
    return new URL(value ?? "").protocol === "https:" ? undefined : "an https:// URL is required";
  } catch {
    return "an https:// URL is required";
  }
}

function validateEnvironmentName(
  takenNames: ReadonlySet<string>,
): (value: string | undefined) => string | undefined {
  return (raw) => {
    const value = raw ?? "";
    if (value.length === 0) {
      return "a non-empty environment variable name is required";
    }
    if (FIXED_ENVIRONMENT_NAMES.has(value) || value.startsWith("XDG_")) {
      return "PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract";
    }
    if (takenNames.has(value)) {
      return `"${value}" is already configured`;
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
  const tokens = (value ?? "").split(",").map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => !/^-?\d+$/.test(token))) {
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
