import * as path from "node:path";

import { appendToConfigText, renderConfigDocument } from "../config/document.ts";
import { parseConfigText, resolveConfig, resolveConfigPath } from "../config/load.ts";
import { referencedVariableName } from "../config/schema.ts";

import type {
  RepositoryDefinition,
  RepositoryInput,
  TaskDefinition,
  TaskInput,
  TevuConfig,
  TevuConfigInput,
} from "../config/schema.ts";
import type {
  ConfigStore,
  GitWorkspaceAdapter,
  TevuResult,
  ValidationFinding,
} from "../domain/types.ts";

/** Error kinds task creation can produce. */
type CreateTaskErrorKind =
  | "ConfigParseError"
  | "ConfigValidationError"
  | "ConfigReadError"
  | "SourceMaterializationError"
  | "ArtifactError"
  | "CancellationError";

/** Typed wizard answers handed to the task-creation use case, which owns the single write. */
export type TaskWizardInput = {
  configPath: string;
  /** Present only when the configuration file did not exist; `base_commit` as typed, unpinned. */
  bootstrap?: Omit<TevuConfigInput, "version" | "tasks">;
  /** `tevu task add` never interviews for `setup`; a newly added repository never carries it. */
  newRepository?: Omit<RepositoryInput, "setup">;
  task: TaskInput;
};

/** Effects injected into the task-creation use case. */
export type TaskDependencies = {
  configStore: ConfigStore;
  git: Pick<GitWorkspaceAdapter, "validateSource">;
  registerSecrets: (variableNames: readonly string[]) => void;
  redact: (text: string) => string;
  cancellation?: AbortSignal;
};

/**
 * Configuration read from disk, or built fresh from bootstrap answers, before
 * the candidate write; only the bootstrap branch (`text: null`) renders a
 * brand-new document.
 */
type BaseDocument =
  | { text: null; base: Omit<TevuConfigInput, "version" | "tasks"> }
  | { text: string; base: TevuConfig };

/**
 * Creates one benchmark task and atomically appends it to the configuration.
 *
 * Reads and re-validates an existing configuration, or starts from captured
 * bootstrap answers when the file is missing; matches the task's repository,
 * pins its base commit through {@link GitWorkspaceAdapter.validateSource},
 * renders or splices the candidate text, re-validates that candidate, and
 * performs exactly one configuration replacement at the end. Cancellation and
 * every pre-commit failure leave the configuration byte-for-byte unchanged
 * because no write happens before the final replacement.
 */
export async function createTask(
  input: TaskWizardInput,
  dependencies: TaskDependencies,
): Promise<TevuResult<TaskDefinition, CreateTaskErrorKind>> {
  if (isCancelled(dependencies)) {
    return cancellationFailure();
  }

  const loaded = await loadBaseDocument(input, dependencies);
  if (!loaded.ok) {
    return loaded;
  }
  const doc = loaded.value;

  dependencies.registerSecrets(collectBaseSecretNames(doc.base));

  const repositories: RepositoryDefinition[] =
    input.newRepository === undefined ? doc.base.repositories : [...doc.base.repositories, input.newRepository];
  const matched = matchRepository(repositories, input.task.repo, input.task.id);
  if (!matched.ok) {
    return matched;
  }
  const repository = matched.value;

  const configDirectory = path.dirname(path.resolve(input.configPath));
  const resolvedRepository: RepositoryDefinition = {
    ...repository,
    path: resolveConfigPath(configDirectory, repository.path),
  };
  const sourceValidation = await dependencies.git.validateSource(resolvedRepository, input.task.base_commit);
  if (!sourceValidation.ok) {
    return { ok: false, error: { ...sourceValidation.error, taskId: input.task.id } };
  }

  const renderedTask: TaskInput = {
    ...input.task,
    repo: repository.id,
    base_commit: sourceValidation.value.resolvedCommit,
  };

  const rendering = { redact: dependencies.redact };
  const candidate =
    doc.text === null
      ? renderConfigDocument(
          {
            version: 1,
            ...doc.base,
            repositories,
            tasks: [renderedTask],
          },
          rendering,
        )
      : appendToConfigText(doc.text, { task: renderedTask, repository: input.newRepository }, rendering);
  if (!candidate.ok) {
    return candidate;
  }

  const reparsed = parseConfigText(candidate.value);
  if (!reparsed.ok) {
    return reparsed;
  }
  const resolved = await resolveConfig(reparsed.value, input.configPath);
  if (!resolved.ok) {
    return resolved;
  }

  if (isCancelled(dependencies)) {
    return cancellationFailure();
  }

  const replaced = await dependencies.configStore.replaceText(input.configPath, candidate.value);
  if (!replaced.ok) {
    return replaced;
  }
  const task = resolved.value.tasks.find((candidateTask) => candidateTask.id === renderedTask.id);
  if (task === undefined) {
    return artifactFailure(
      "replace-configuration",
      `task "${renderedTask.id}" was written but cannot be found in the replaced configuration`,
    );
  }
  return { ok: true, value: task };
}

/**
 * Reads the existing configuration or starts from the captured bootstrap
 * answers. An existing configuration is authoritative even when bootstrap
 * answers were captured, so a file that appeared after the wizard started is
 * never overwritten; an existing invalid configuration aborts before any
 * mutation.
 */
async function loadBaseDocument(
  input: TaskWizardInput,
  dependencies: TaskDependencies,
): Promise<TevuResult<BaseDocument, "ConfigParseError" | "ConfigValidationError" | "ConfigReadError">> {
  const exists = await dependencies.configStore.exists(input.configPath);
  if (exists) {
    const text = await dependencies.configStore.readText(input.configPath);
    if (!text.ok) {
      return text;
    }
    const parsed = parseConfigText(text.value);
    if (!parsed.ok) {
      return parsed;
    }
    const resolved = await resolveConfig(parsed.value, input.configPath);
    if (!resolved.ok) {
      return resolved;
    }
    return { ok: true, value: { text: text.value, base: resolved.value } };
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
  return { ok: true, value: { text: null, base: input.bootstrap } };
}

function collectBaseSecretNames(base: BaseDocument["base"]): string[] {
  const names = Object.values(base.agents).flatMap((settings) => settings.secrets ?? []);
  const token = base.trackers?.jira?.token;
  if (token !== undefined) {
    names.push(referencedVariableName(token));
  }
  return names;
}

function matchRepository(
  repositories: readonly RepositoryDefinition[],
  requestedRepo: string | undefined,
  taskId: string,
): TevuResult<RepositoryDefinition, "ConfigValidationError"> {
  if (requestedRepo !== undefined) {
    const repository = repositories.find((candidate) => candidate.id === requestedRepo);
    if (repository === undefined) {
      return validationFailure([
        {
          severity: "error",
          identifier: `tasks.${taskId}.repo`,
          message: `repo "${requestedRepo}" does not reference a configured or newly added repository`,
        },
      ]);
    }
    return { ok: true, value: repository };
  }
  if (repositories.length === 1) {
    const [sole] = repositories;
    if (sole !== undefined) {
      return { ok: true, value: sole };
    }
  }
  return validationFailure([
    {
      severity: "error",
      identifier: `tasks.${taskId}.repo`,
      message: "repo is required when more than one repository is configured",
    },
  ]);
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

function artifactFailure(operation: string, reason: string): TevuResult<never, "ArtifactError"> {
  return { ok: false, error: { kind: "ArtifactError", operation, reason } };
}
