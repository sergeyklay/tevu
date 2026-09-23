import { TevuConfigSchema } from "../config/schema.ts";
import { describeSourceCommitInPrompt } from "./source-commit-in-prompt.ts";

import type { TevuConfig } from "../config/schema.ts";
import type {
  OpenCodeCapabilityReport,
  SourceValidation,
  TevuError,
  TevuResult,
  ValidationDependencies,
  ValidationFinding,
  ValidationReport,
} from "../domain/types.ts";

/** Error kinds the validation contract declares. */
type ValidateConfigErrorKind =
  | "ConfigValidationError"
  | "PrerequisiteError"
  | "SourceMaterializationError"
  | "IsolationError"
  | "OpenCodeProtocolError";

/**
 * Aggregates static and local prerequisite validation for one configuration.
 *
 * Applies the ordered validation stages over injected adapter contracts and
 * retains every independent finding in one invocation instead of stopping at
 * the first failure. Findings carry stable field, task, or variable-name
 * identifiers and never environment values. No Jira call, model session, run
 * artifact, or retained probe file is involved; the configuration is invalid
 * when any error-severity finding exists.
 */
export async function validateConfig(
  config: TevuConfig,
  dependencies: ValidationDependencies,
): Promise<TevuResult<ValidationReport, ValidateConfigErrorKind>> {
  const findings: ValidationFinding[] = [
    ...collectSchemaFindings(config),
    ...(await collectHostFindings(dependencies)),
    ...collectEnvironmentFindings(config, dependencies),
    ...(await collectSourceFindings(config, dependencies)),
    ...(await collectArtifactFindings(config, dependencies)),
  ];

  let capabilities: OpenCodeCapabilityReport | null = null;
  const probe = await dependencies.opencode.probe(config.opencode.executable);
  if (probe.ok) {
    capabilities = probe.value;
  } else {
    findings.push(
      probe.error.kind === "PrerequisiteError"
        ? prerequisiteFinding(probe.error)
        : { severity: "error", identifier: "opencode.executable", message: probe.error.reason },
    );
  }

  return {
    ok: true,
    value: {
      valid: !findings.some((finding) => finding.severity === "error"),
      findings,
      capabilities,
    },
  };
}

/**
 * Strict schema validation, covering duplicate IDs and cross-references.
 *
 * The config is re-validated defensively because validateConfig owns schema
 * truth for callers that did not arrive through loadConfig; the schema's
 * refinements cover duplicates, classifications, and cross-references.
 */
function collectSchemaFindings(config: TevuConfig): ValidationFinding[] {
  const parsed = TevuConfigSchema.safeParse(config);
  if (parsed.success) {
    return [];
  }
  return parsed.error.issues.map(
    (issue): ValidationFinding => ({
      severity: "error",
      identifier:
        issue.path.length === 0 ? "config" : issue.path.map((segment) => String(segment)).join("."),
      message: issue.code === "unrecognized_keys" ? "Unknown configuration field" : issue.message,
    }),
  );
}

/** Checks the local platform and the pinned Node.js, Bun, and Git toolchain. */
async function collectHostFindings(
  dependencies: ValidationDependencies,
): Promise<ValidationFinding[]> {
  const host = await dependencies.prerequisites.probeHost();
  return host.ok ? [] : [prerequisiteFinding(host.error)];
}

/** Checks configured variable presence by name, plus the non-empty parent PATH. */
function collectEnvironmentFindings(
  config: TevuConfig,
  dependencies: ValidationDependencies,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const names = new Set([
    ...config.execution.opencodeEnvironment.map((entry) => entry.name),
    ...config.execution.evaluatorEnvironment.map((entry) => entry.name),
    ...(config.jira === undefined
      ? []
      : [config.jira.emailEnvironmentVariable, config.jira.tokenEnvironmentVariable]),
  ]);
  for (const name of names) {
    if (!dependencies.prerequisites.hasEnvironmentVariable(name)) {
      findings.push({
        severity: "error",
        identifier: `environment.${name}`,
        message: "required environment variable is not set",
      });
    }
  }
  // snapshotParent also rejects missing variables, which are already reported
  // by name above; it runs only for its non-empty parent PATH check and the
  // snapshot values stay in memory, so nothing is retained or exposed.
  if (findings.length === 0) {
    const snapshot = dependencies.environments.snapshotParent(config);
    if (!snapshot.ok) {
      findings.push(prerequisiteFinding(snapshot.error));
    }
  }
  return findings;
}

/**
 * Resolves each task's start commit, inspects its source tree, and rejects a
 * task whose agent prompt names the resolved commit.
 */
async function collectSourceFindings(
  config: TevuConfig,
  dependencies: ValidationDependencies,
): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];
  const repositories = new Map(
    config.repositories.map((repository) => [repository.id, repository]),
  );
  // Tasks sharing a repository and commit reuse one probe so a large source
  // tree is scanned once per pinned commit.
  const validated = new Map<string, TevuResult<SourceValidation, "SourceMaterializationError">>();
  for (const task of config.tasks) {
    const repository = repositories.get(task.repositoryId);
    if (repository === undefined) {
      // A broken reference is already an error finding from the schema stage.
      continue;
    }
    const key = `${repository.id}\u0000${task.startCommit}`;
    let result = validated.get(key);
    if (result === undefined) {
      result = await dependencies.git.validateSource(repository, task.startCommit);
      validated.set(key, result);
    }
    if (!result.ok) {
      findings.push({
        severity: "error",
        identifier: `tasks.${task.id}.startCommit`,
        message: result.error.reason,
      });
      continue;
    }
    const reason = describeSourceCommitInPrompt(
      dependencies.buildTaskPrompt(task),
      result.value.resolvedCommit,
    );
    if (reason !== undefined) {
      findings.push({ severity: "error", identifier: `tasks.${task.id}`, message: reason });
    }
  }
  return findings;
}

/** Checks artifact destination writability without retained probe files. */
async function collectArtifactFindings(
  config: TevuConfig,
  dependencies: ValidationDependencies,
): Promise<ValidationFinding[]> {
  const writable = await dependencies.prerequisites.probeWritableDirectory(
    config.artifacts.directory,
  );
  return writable.ok ? [] : [prerequisiteFinding(writable.error)];
}

function prerequisiteFinding(
  error: Extract<TevuError, { kind: "PrerequisiteError" }>,
): ValidationFinding {
  return {
    severity: "error",
    identifier: `prerequisites.${error.tool}`,
    message:
      error.actual === undefined
        ? `expected ${error.expected}`
        : `expected ${error.expected}, actual ${error.actual}`,
  };
}
