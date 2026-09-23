import { TevuConfigSchema } from "../config/schema.ts";

import type { TaskDefinition, TevuConfig } from "../config/schema.ts";
import type {
  TaskDependencies,
  TaskSourceRequest,
  TaskWizardInput,
  TevuResult,
  ValidationFinding,
} from "../domain/types.ts";

/** Error kinds task creation can produce. */
type CreateTaskErrorKind =
  | "ConfigParseError"
  | "ConfigValidationError"
  | "SourceMaterializationError"
  | "IssueImportError"
  | "ArtifactError"
  | "CancellationError";

/**
 * Creates one benchmark task and atomically appends it to the configuration.
 *
 * Rejects an invalid existing configuration before any source materialization,
 * takes a one-time Jira or GitHub snapshot when the source needs one, pins
 * the task to the resolved source commit, validates the complete candidate
 * document, and performs exactly one configuration replacement at the end.
 * Cancellation and every pre-commit failure leave the configuration
 * byte-for-byte unchanged because no write happens before the final
 * replacement.
 */
export async function createTask(
  input: TaskWizardInput,
  dependencies: TaskDependencies,
): Promise<TevuResult<TaskDefinition, CreateTaskErrorKind>> {
  if (isCancelled(dependencies)) {
    return cancellationFailure();
  }

  const base = await loadBaseDocument(input, dependencies);
  if (!base.ok) {
    return base;
  }

  const repositories =
    input.newRepository === undefined
      ? base.value.repositories
      : [...base.value.repositories, input.newRepository];
  const repository = repositories.find((entry) => entry.id === input.repositoryId);
  if (repository === undefined) {
    return validationFailure([
      {
        severity: "error",
        identifier: `tasks.${input.taskId}.repositoryId`,
        message: `repositoryId "${input.repositoryId}" does not reference a configured or newly added repository`,
      },
    ]);
  }

  const source = await materializeSource(input.source, dependencies);
  if (!source.ok) {
    return source;
  }

  const sourceValidation = await dependencies.git.validateSource(repository, input.startCommit);
  if (!sourceValidation.ok) {
    // The Git adapter has no task identity and substitutes the repository ID;
    // restore the ID of the task being created so the error is actionable.
    return { ok: false, error: { ...sourceValidation.error, taskId: input.taskId } };
  }

  const task: TaskDefinition = {
    id: input.taskId,
    repositoryId: input.repositoryId,
    startCommit: sourceValidation.value.resolvedCommit,
    source: source.value,
    description: input.description,
    prompt: input.prompt,
    definitionOfReady: input.definitionOfReady,
    acceptanceCriteria: input.acceptanceCriteria,
    definitionOfDone: input.definitionOfDone,
  };
  const candidate: TevuConfig = {
    ...base.value,
    repositories,
    tasks: [...base.value.tasks, task],
  };
  const parsed = TevuConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return validationFailure(parsed.error.issues.map(issueFinding));
  }

  if (isCancelled(dependencies)) {
    return cancellationFailure();
  }

  const replaced = await dependencies.configStore.replace(input.configPath, parsed.data);
  if (!replaced.ok) {
    return replaced;
  }
  return { ok: true, value: task };
}

/**
 * Reads the existing configuration or builds the bootstrap document.
 *
 * An existing configuration is authoritative even when bootstrap answers were
 * captured, so a file that appeared after the wizard started is never
 * overwritten; an existing invalid configuration aborts before any mutation.
 */
async function loadBaseDocument(
  input: TaskWizardInput,
  dependencies: TaskDependencies,
): Promise<TevuResult<TevuConfig, "ConfigParseError" | "ConfigValidationError" | "ArtifactError">> {
  const exists = await dependencies.configStore.exists(input.configPath);
  if (exists) {
    return dependencies.configStore.read(input.configPath);
  }
  if (input.bootstrap === undefined) {
    return validationFailure([
      {
        severity: "error",
        identifier: "config",
        message: "configuration file is missing and no bootstrap answers were captured",
      },
    ]);
  }
  const base: TevuConfig = {
    version: 1,
    artifacts: input.bootstrap.artifacts,
    execution: input.bootstrap.execution,
    opencode: input.bootstrap.opencode,
    ...(input.bootstrap.jira === undefined ? {} : { jira: input.bootstrap.jira }),
    repositories: input.bootstrap.repositories,
    contenders: input.bootstrap.contenders,
    tasks: [],
  };
  return { ok: true, value: base };
}

/**
 * Maps the wizard source request to a stored task source, importing Jira once.
 * A wizard-supplied snapshot (Jira or GitHub) is stored verbatim without
 * another tracker read.
 */
async function materializeSource(
  request: TaskSourceRequest,
  dependencies: TaskDependencies,
): Promise<TevuResult<TaskDefinition["source"], "IssueImportError" | "CancellationError">> {
  if (request.kind === "manual") {
    return {
      ok: true,
      value:
        request.reference === undefined
          ? { kind: "manual", title: request.title }
          : { kind: "manual", reference: request.reference, title: request.title },
    };
  }
  if (request.kind === "github-issue") {
    return {
      ok: true,
      value: {
        kind: "github-issue",
        issueKey: request.snapshot.issueKey,
        issueUrl: request.snapshot.issueUrl,
        importedAt: request.snapshot.importedAt,
        importedSummary: request.snapshot.summary,
        importedDescription: request.snapshot.description,
      },
    };
  }
  if (request.snapshot !== undefined) {
    return {
      ok: true,
      value: {
        kind: "jira-cloud",
        issueKey: request.snapshot.issueKey,
        issueUrl: request.snapshot.issueUrl,
        importedAt: request.snapshot.importedAt,
        importedSummary: request.snapshot.summary,
        importedDescription: request.snapshot.description,
      },
    };
  }
  if (dependencies.jira === null) {
    return {
      ok: false,
      error: {
        kind: "IssueImportError",
        tracker: "jira-cloud",
        reference: request.issueKey,
        reason: "Jira import is not available because the configuration has no Jira settings",
      },
    };
  }
  const issue = await dependencies.jira.readIssue(request.issueKey);
  if (!issue.ok) {
    return issue;
  }
  return {
    ok: true,
    value: {
      kind: "jira-cloud",
      issueKey: issue.value.issueKey,
      issueUrl: issue.value.issueUrl,
      importedAt: dependencies.clock.now().toISOString(),
      importedSummary: issue.value.summary,
      importedDescription: issue.value.description,
    },
  };
}

function isCancelled(dependencies: TaskDependencies): boolean {
  return dependencies.cancellation?.aborted === true;
}

function cancellationFailure(): TevuResult<never, "CancellationError"> {
  return { ok: false, error: { kind: "CancellationError", activeCaseIds: [] } };
}

function validationFailure(findings: ValidationFinding[]): TevuResult<never, "ConfigValidationError"> {
  return { ok: false, error: { kind: "ConfigValidationError", findings } };
}

function issueFinding(issue: { path: ReadonlyArray<PropertyKey>; code: string; message: string }): ValidationFinding {
  return {
    severity: "error",
    identifier:
      issue.path.length === 0 ? "config" : issue.path.map((segment) => String(segment)).join("."),
    message: issue.code === "unrecognized_keys" ? "Unknown configuration field" : issue.message,
  };
}
