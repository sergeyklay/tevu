// @vitest-environment node
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTask } from "../application/create-task.ts";
import { validateConfig } from "../application/validate.ts";
import { canonicalConfigSerialization, loadConfig } from "./load.ts";
import { TevuConfigSchema } from "./schema.ts";

import type {
  ConfigBootstrapInput,
  ConfigStore,
  EnvironmentAdapter,
  GitWorkspaceAdapter,
  JiraIssueSnapshot,
  JiraTaskSourceAdapter,
  OpenCodeAdapter,
  OpenCodeCapabilityReport,
  PrerequisiteAdapter,
  TaskDependencies,
  TaskWizardInput,
  TevuError,
  TevuResult,
  ValidationDependencies,
} from "../domain/types.ts";
import type {
  CheckDefinition,
  CommandEvaluator,
  ContenderDefinition,
  EnvironmentVariableDefinition,
  ManualEvaluator,
  ReadyItem,
  RepositoryDefinition,
  TaskDefinition,
  TevuConfig,
} from "./schema.ts";

const FIXED_NOW = new Date("2026-05-01T10:00:00.000Z");

function expectOk<T>(outcome: { ok: true; value: T } | { ok: false; error: TevuError }): T {
  if (outcome.ok) {
    return outcome.value;
  }
  throw new Error(`expected success, got ${JSON.stringify(outcome.error)}`);
}

function expectFailure<K extends TevuError["kind"]>(
  outcome: { ok: true; value: unknown } | { ok: false; error: TevuError },
  kind: K,
): Extract<TevuError, { kind: K }> {
  if (outcome.ok) {
    throw new Error(`expected a ${kind} failure, got success`);
  }
  if (outcome.error.kind !== kind) {
    throw new Error(`expected error kind ${kind}, got ${JSON.stringify(outcome.error)}`);
  }
  return outcome.error as Extract<TevuError, { kind: K }>;
}

function expectSchemaAcceptance(config: unknown): TevuConfig {
  const parsed = TevuConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`expected schema acceptance: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

function expectSchemaRejection(config: unknown): Array<{ path: string; message: string }> {
  const parsed = TevuConfigSchema.safeParse(config);
  if (parsed.success) {
    throw new Error("expected the schema to reject this configuration");
  }
  return parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

function buildRepository(overrides: Partial<RepositoryDefinition> = {}): RepositoryDefinition {
  return { id: "sample-repo", path: "/tmp/tevu/sample-repo", ...overrides };
}

function buildContender(overrides: Partial<ContenderDefinition> = {}): ContenderDefinition {
  return { id: "alpha", model: "openai/gpt-5", variant: "high", ...overrides };
}

function buildEnvironmentVariable(
  overrides: Partial<EnvironmentVariableDefinition> = {},
): EnvironmentVariableDefinition {
  return { name: "EVAL_TOKEN", classification: "ordinary", ...overrides };
}

function buildCommandEvaluator(overrides: Partial<CommandEvaluator> = {}): CommandEvaluator {
  return {
    kind: "command",
    argv: ["node", "check.js"],
    timeoutMs: 10_000,
    successExitCodes: [0],
    environmentAllowlist: [],
    ...overrides,
  };
}

function buildManualEvaluator(): ManualEvaluator {
  return { kind: "manual" };
}

function buildCheck(overrides: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id: "api-returns-200",
    description: "The API returns 200",
    required: true,
    evaluator: buildCommandEvaluator(),
    ...overrides,
  };
}

function buildReadyItem(overrides: Partial<ReadyItem> = {}): ReadyItem {
  return { id: "spec-approved", description: "The spec is approved", confirmed: true, ...overrides };
}

function buildTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: "write-report",
    repositoryId: "sample-repo",
    startCommit: "0123456789abcdef0123456789abcdef01234567",
    source: { kind: "manual", title: "Write the report" },
    description: "Write a report",
    prompt: "Write the report",
    definitionOfReady: [buildReadyItem()],
    acceptanceCriteria: [buildCheck()],
    definitionOfDone: [buildCheck({ id: "tests-pass", evaluator: buildCommandEvaluator({ argv: ["npm", "test"] }) })],
    ...overrides,
  };
}

function buildExecution(overrides: Partial<TevuConfig["execution"]> = {}): TevuConfig["execution"] {
  return {
    concurrency: 2,
    caseTimeoutMs: 60_000,
    terminationGraceMs: 5_000,
    opencodeEnvironment: [],
    evaluatorEnvironment: [buildEnvironmentVariable()],
    ...overrides,
  };
}

function buildConfig(overrides: Partial<TevuConfig> = {}): TevuConfig {
  return {
    version: 1,
    artifacts: { directory: "/tmp/tevu/artifacts" },
    execution: buildExecution(),
    opencode: { executable: "opencode" },
    repositories: [buildRepository()],
    contenders: [
      buildContender(),
      buildContender({ id: "beta", model: "anthropic/claude-4", variant: "max" }),
    ],
    tasks: [buildTask()],
    ...overrides,
  };
}

function buildWizardInput(overrides: Partial<TaskWizardInput> = {}): TaskWizardInput {
  return {
    configPath: "/tmp/tevu/tevu.yaml",
    repositoryId: "sample-repo",
    taskId: "new-task",
    startCommit: "abc123",
    source: { kind: "manual", title: "New task" },
    description: "A new task",
    prompt: "Do the new task",
    definitionOfReady: [buildReadyItem({ id: "new-ready" })],
    acceptanceCriteria: [buildCheck({ id: "new-check" })],
    definitionOfDone: [buildCheck({ id: "new-dod" })],
    ...overrides,
  };
}

function buildJiraSnapshot(
  overrides: Partial<JiraIssueSnapshot & { importedAt: string }> = {},
): JiraIssueSnapshot & { importedAt: string } {
  return {
    issueKey: "PROJ-7",
    issueUrl: "https://jira.example.com/browse/PROJ-7",
    summary: "Add export button",
    description: "Users need an export button",
    importedAt: FIXED_NOW.toISOString(),
    ...overrides,
  };
}

function buildConfigStore(overrides: Partial<ConfigStore> = {}): ConfigStore {
  return {
    exists: vi.fn(async () => true),
    read: vi.fn(async () => ({ ok: true as const, value: buildConfig() })),
    replace: vi.fn(async () => ({ ok: true as const, value: undefined })),
    ...overrides,
  };
}

function buildGit(overrides: Partial<GitWorkspaceAdapter> = {}): GitWorkspaceAdapter {
  return {
    validateSource: vi.fn(
      async (repository: RepositoryDefinition, commit: string) => ({
        ok: true as const,
        value: {
          repositoryId: repository.id,
          requestedCommit: commit,
          resolvedCommit: `resolved-${commit}`,
        },
      }),
    ),
    createIsolatedCase: vi.fn(async () => ({
      ok: false as const,
      error: { kind: "IsolationError" as const, caseId: "unused", reason: "not used in these tests" },
    })),
    capturePatch: vi.fn(async () => ({
      ok: false as const,
      error: { kind: "ArtifactError" as const, operation: "capture-patch", reason: "not used in these tests" },
    })),
    dispose: vi.fn(async () => ({ ok: true as const, value: undefined })),
    ...overrides,
  };
}

function buildJira(overrides: Partial<JiraTaskSourceAdapter> = {}): JiraTaskSourceAdapter {
  return {
    readIssue: vi.fn(async (issueKey: string) => ({
      ok: true as const,
      value: {
        issueKey,
        issueUrl: `https://jira.example.com/browse/${issueKey}`,
        summary: "Issue summary",
        description: "Issue description",
      },
    })),
    ...overrides,
  };
}

function buildTaskDependencies(overrides: Partial<TaskDependencies> = {}): TaskDependencies {
  return {
    configStore: buildConfigStore(),
    git: buildGit(),
    jira: buildJira(),
    clock: { now: vi.fn(() => FIXED_NOW) },
    ...overrides,
  };
}

function buildCapabilityReport(executable: string): OpenCodeCapabilityReport {
  return {
    executable,
    detectedVersion: "1.0.0",
    commands: { run: "available", export: "available" },
    runOptions: { jsonFormat: "available", model: "available", variant: "available" },
    isolation: { denyOutsideWorktree: "available" },
  };
}

function buildPrerequisites(overrides: Partial<PrerequisiteAdapter> = {}): PrerequisiteAdapter {
  return {
    probeHost: vi.fn(async () => ({
      ok: true as const,
      value: { platform: "linux" as const, nodeVersion: "24.21.0", bunVersion: "1.4.2", gitVersion: "2.45.0" },
    })),
    hasEnvironmentVariable: vi.fn(() => true),
    probeWritableDirectory: vi.fn(async () => ({ ok: true as const, value: undefined })),
    ...overrides,
  };
}

function buildOpenCodeAdapter(overrides: Partial<OpenCodeAdapter> = {}): OpenCodeAdapter {
  return {
    probe: vi.fn(async (executable: string) => ({
      ok: true as const,
      value: buildCapabilityReport(executable),
    })),
    run: vi.fn(async () => ({
      ok: false as const,
      error: { kind: "CancellationError" as const, activeCaseIds: [] },
    })),
    exportSession: vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "OpenCodeProtocolError" as const,
        context: { phase: "probe" as const },
        reason: "not used in these tests",
      },
    })),
    ...overrides,
  };
}

function buildEnvironments(overrides: Partial<EnvironmentAdapter> = {}): EnvironmentAdapter {
  return {
    snapshotParent: vi.fn(() => ({
      ok: true as const,
      value: { path: "/usr/bin:/bin", opencodeValues: {}, ordinaryEvaluatorValues: {}, secretValues: [] },
    })),
    createCaseEnvironments: vi.fn(async () => ({
      ok: false as const,
      error: { kind: "IsolationError" as const, caseId: "unused", reason: "not used in these tests" },
    })),
    ...overrides,
  };
}

function buildValidationDependencies(
  overrides: Partial<ValidationDependencies> = {},
): ValidationDependencies {
  return {
    git: buildGit(),
    opencode: buildOpenCodeAdapter(),
    environments: buildEnvironments(),
    prerequisites: buildPrerequisites(),
    ...overrides,
  };
}

function configYaml(options: {
  artifactsDirectory: string;
  repositoryPath: string;
  executable: string;
}): string {
  return `version: 1
artifacts:
  directory: ${options.artifactsDirectory}
execution:
  concurrency: 2
  caseTimeoutMs: 60000
  terminationGraceMs: 5000
  opencodeEnvironment: []
  evaluatorEnvironment:
    - name: EVAL_TOKEN
      classification: ordinary
opencode:
  executable: ${options.executable}
repositories:
  - id: sample-repo
    path: ${options.repositoryPath}
contenders:
  - id: alpha
    model: openai/gpt-5
    variant: high
  - id: beta
    model: anthropic/claude-4
    variant: max
tasks:
  - id: write-report
    repositoryId: sample-repo
    startCommit: 0123456789abcdef0123456789abcdef01234567
    source:
      kind: manual
      title: Write the report
    description: Write a report
    prompt: Write the report
    definitionOfReady:
      - id: spec-approved
        description: The spec is approved
        confirmed: true
    acceptanceCriteria:
      - id: api-returns-200
        description: The API returns 200
        required: true
        evaluator:
          kind: command
          argv: [node, check.js]
          timeoutMs: 10000
          successExitCodes: [0]
          environmentAllowlist: [EVAL_TOKEN]
    definitionOfDone:
      - id: tests-pass
        description: The tests pass
        required: true
        evaluator:
          kind: command
          argv: [npm, test]
          timeoutMs: 60000
          successExitCodes: [0]
`;
}

describe("TevuConfigSchema", () => {
  it("accepts a minimal valid configuration unchanged", () => {
    const config = buildConfig();

    expect(expectSchemaAcceptance(config)).toEqual(config);
  });

  it.each([
    { level: "top-level", config: { ...buildConfig(), telemetry: true } },
    { level: "task", config: { ...buildConfig(), tasks: [{ ...buildTask(), notes: "extra" }] } },
  ])("rejects an unknown field at the $level", ({ config }) => {
    expect(TevuConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects a version other than 1", () => {
    expect(expectSchemaRejection({ ...buildConfig(), version: 2 }).map((issue) => issue.path)).toContain("version");
  });

  it.each(["Bad-id", "bad_id", "1bad", "a".repeat(65)])("rejects the invalid id %s", (id) => {
    expect(TevuConfigSchema.safeParse(buildConfig({ repositories: [buildRepository({ id })] })).success).toBe(false);
  });

  it.each(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "XDG_DATA_HOME"])(
    "rejects the fixed environment name %s",
    (name) => {
      const config = buildConfig({
        execution: buildExecution({
          opencodeEnvironment: [buildEnvironmentVariable({ name, classification: "ordinary" })],
        }),
      });

      expect(TevuConfigSchema.safeParse(config).success).toBe(false);
    },
  );

  it("rejects a non-ordinary classification in evaluatorEnvironment", () => {
    const config = buildConfig({
      execution: buildExecution({
        evaluatorEnvironment: [buildEnvironmentVariable({ name: "PROVIDER_KEY", classification: "provider-credential" })],
      }),
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      "evaluatorEnvironment entries must be classified ordinary",
    );
  });

  it("rejects duplicate environment names within one collection", () => {
    const config = buildConfig({
      execution: buildExecution({
        opencodeEnvironment: [buildEnvironmentVariable({ name: "SHARED", classification: "ordinary" }), buildEnvironmentVariable({ name: "SHARED", classification: "secret" })],
      }),
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'duplicate environment variable name "SHARED"',
    );
  });

  it("rejects an environment variable declared for both opencode and evaluator", () => {
    const config = buildConfig({
      execution: buildExecution({
        opencodeEnvironment: [buildEnvironmentVariable({ name: "SHARED", classification: "ordinary" })],
        evaluatorEnvironment: [buildEnvironmentVariable({ name: "SHARED", classification: "ordinary" })],
      }),
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'environment variable "SHARED" appears in both opencodeEnvironment and evaluatorEnvironment',
    );
  });

  it.each([
    { collection: "repositories", config: { ...buildConfig(), repositories: [] } },
    { collection: "contenders", config: { ...buildConfig(), contenders: [buildContender()] } },
    { collection: "tasks", config: { ...buildConfig(), tasks: [] } },
  ])("rejects an empty or undersized $collection collection", ({ config }) => {
    expect(TevuConfigSchema.safeParse(config).success).toBe(false);
  });

  it.each([
    { collection: "repositories", config: buildConfig({ repositories: [buildRepository({ id: "dup" }), buildRepository({ id: "dup" })] }), path: "repositories.1.id", message: 'duplicate repositories id "dup"' },
    { collection: "contenders", config: buildConfig({ contenders: [buildContender({ id: "dup" }), buildContender({ id: "dup", model: "other/model", variant: "v" })] }), path: "contenders.1.id", message: 'duplicate contenders id "dup"' },
    { collection: "tasks", config: buildConfig({ tasks: [buildTask(), buildTask()] }), path: "tasks.1.id", message: 'duplicate tasks id "write-report"' },
  ])("rejects duplicate $collection ids", ({ config, path, message }) => {
    expect(expectSchemaRejection(config)).toContainEqual({ path, message });
  });

  it("rejects a task referencing an unconfigured repository", () => {
    const config = buildConfig({ tasks: [buildTask({ repositoryId: "ghost" })] });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: "tasks.0.repositoryId",
      message: "repositoryId must reference a configured repository",
    });
  });

  it("rejects an environmentAllowlist name outside evaluatorEnvironment", () => {
    const config = buildConfig({
      tasks: [
        buildTask({
          acceptanceCriteria: [
            buildCheck({ evaluator: buildCommandEvaluator({ environmentAllowlist: ["UNDECLARED_VAR"] }) }),
          ],
        }),
      ],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'environmentAllowlist name "UNDECLARED_VAR" is not declared in execution.evaluatorEnvironment',
    );
  });

  it("rejects a Jira credential variable listed in evaluatorEnvironment", () => {
    const config = buildConfig({
      execution: buildExecution({
        evaluatorEnvironment: [buildEnvironmentVariable({ name: "JIRA_TOKEN", classification: "ordinary" })],
      }),
      jira: {
        baseUrl: "https://jira.example.com",
        emailEnvironmentVariable: "JIRA_EMAIL",
        tokenEnvironmentVariable: "JIRA_TOKEN",
      },
    });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: "jira.tokenEnvironmentVariable",
      message: 'Jira credential variable "JIRA_TOKEN" must not appear in execution.evaluatorEnvironment',
    });
  });

  it("requires at least one required acceptance criterion", () => {
    const config = buildConfig({
      tasks: [buildTask({ acceptanceCriteria: [buildCheck({ required: false })] })],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      "at least one acceptance criterion must be required",
    );
  });

  it("requires at least one required Definition of Done check", () => {
    const config = buildConfig({
      tasks: [buildTask({ definitionOfDone: [buildCheck({ id: "tests-pass", required: false })] })],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      "at least one Definition of Done check must be required",
    );
  });

  it("rejects duplicate Definition of Ready ids", () => {
    const config = buildConfig({
      tasks: [buildTask({ definitionOfReady: [buildReadyItem(), buildReadyItem()] })],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'duplicate Definition of Ready id "spec-approved"',
    );
  });

  it("rejects duplicate check ids across acceptanceCriteria and definitionOfDone", () => {
    const config = buildConfig({
      tasks: [
        buildTask({
          acceptanceCriteria: [buildCheck({ id: "shared" })],
          definitionOfDone: [buildCheck({ id: "shared" })],
        }),
      ],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'duplicate check id "shared" across acceptanceCriteria and definitionOfDone',
    );
  });

  it.each([
    { field: "importedAt", source: { kind: "jira-cloud", issueKey: "PROJ-1", issueUrl: "https://jira.example.com/browse/PROJ-1", importedAt: "2026-01-01", importedSummary: "s", importedDescription: "d" }, path: "tasks.0.source.importedAt" },
    { field: "issueUrl", source: { kind: "jira-cloud", issueKey: "PROJ-1", issueUrl: "not-a-url", importedAt: FIXED_NOW.toISOString(), importedSummary: "s", importedDescription: "d" }, path: "tasks.0.source.issueUrl" },
  ])("rejects an invalid Jira task source $field", ({ source, path }) => {
    const config = buildConfig({
      tasks: [buildTask({ source: source as TaskDefinition["source"] })],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain(path);
  });

  it.each([
    { field: "description", value: "   " },
    { field: "prompt", value: "\t " },
  ])("rejects a whitespace-only task $field", ({ field, value }) => {
    const config = buildConfig({ tasks: [{ ...buildTask(), [field]: value }] });

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain(`tasks.0.${field}`);
  });

  it("rejects a contender model without a namespace separator", () => {
    const config = { ...buildConfig(), contenders: [{ ...buildContender(), model: "gpt-5" }] };

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain("contenders.0.model");
  });

  it("rejects a non-positive command timeout", () => {
    const evaluator = { ...buildCommandEvaluator(), timeoutMs: 0 };
    const config = buildConfig({
      tasks: [buildTask({ acceptanceCriteria: [{ ...buildCheck(), evaluator }] })],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain("tasks.0.acceptanceCriteria.0.evaluator.timeoutMs");
  });

  it("rejects an empty command success exit code list", () => {
    const evaluator = { ...buildCommandEvaluator(), successExitCodes: [] };
    const config = buildConfig({
      tasks: [buildTask({ acceptanceCriteria: [{ ...buildCheck(), evaluator }] })],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain("tasks.0.acceptanceCriteria.0.evaluator.successExitCodes");
  });

  it("rejects a non-HTTPS Jira base URL", () => {
    const config = buildConfig({
      jira: {
        baseUrl: "http://jira.example.com",
        emailEnvironmentVariable: "JIRA_EMAIL",
        tokenEnvironmentVariable: "JIRA_TOKEN",
      },
    });

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain("jira.baseUrl");
  });

  it("accepts a manual evaluator without a command definition", () => {
    const config = buildConfig({
      tasks: [buildTask({ acceptanceCriteria: [{ ...buildCheck(), evaluator: buildManualEvaluator() }] })],
    });

    expect(expectSchemaAcceptance(config).tasks[0]?.acceptanceCriteria[0]?.evaluator).toEqual({ kind: "manual" });
  });
});

describe("loadConfig", () => {
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(join(tmpdir(), "tevu-config-"));
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  async function writeConfigFile(content: string): Promise<string> {
    const filePath = join(tempDirectory, "tevu.yaml");
    await fs.writeFile(filePath, content, "utf8");
    return filePath;
  }

  it("reads a valid configuration and resolves relative paths against its directory", async () => {
    const configPath = await writeConfigFile(
      configYaml({ artifactsDirectory: "./artifacts", repositoryPath: "./repo", executable: "./bin/opencode" }),
    );

    const config = expectOk(await loadConfig(configPath));

    expect(config.artifacts.directory).toBe(join(tempDirectory, "artifacts"));
    expect(config.repositories[0]?.path).toBe(join(tempDirectory, "repo"));
    expect(config.opencode.executable).toBe(join(tempDirectory, "bin/opencode"));
    expect(config.tasks).toHaveLength(1);
    expect(config.contenders).toHaveLength(2);
  });

  it("keeps a bare executable name unresolved", async () => {
    const configPath = await writeConfigFile(
      configYaml({ artifactsDirectory: "./artifacts", repositoryPath: "./repo", executable: "opencode" }),
    );

    const config = expectOk(await loadConfig(configPath));

    expect(config.opencode.executable).toBe("opencode");
  });

  it("reports an ArtifactError when the configuration file cannot be read", async () => {
    const error = expectFailure(await loadConfig(join(tempDirectory, "missing.yaml")), "ArtifactError");

    expect(error.operation).toBe("read-configuration");
    expect(error.reason).toBe("Cannot read configuration file; check the path and access permissions");
  });

  it("reports a ConfigParseError with a line identifier for malformed YAML", async () => {
    const configPath = await writeConfigFile("version: 1\nbroken: [1, 2");

    const error = expectFailure(await loadConfig(configPath), "ConfigParseError");

    expect(error.findings.length).toBeGreaterThan(0);
    expect(error.findings[0]?.severity).toBe("error");
    expect(error.findings[0]?.identifier).toBe("line 2");
    expect(error.findings[0]?.message).toMatch(/^Invalid YAML \(/);
  });

  it("reports ConfigParseError when YAML aliases cannot be resolved", async () => {
    const configPath = await writeConfigFile("m:\n  <<: *missing\n");

    const error = expectFailure(await loadConfig(configPath), "ConfigParseError");

    expect(error.findings).toEqual([
      { severity: "error", identifier: "config", message: "Cannot resolve YAML aliases" },
    ]);
  });

  it("reports field identifiers for schema violations", async () => {
    const configPath = await writeConfigFile("version: 2\n");

    const error = expectFailure(await loadConfig(configPath), "ConfigValidationError");

    const identifiers = error.findings.map((finding) => finding.identifier);
    expect(identifiers).toContain("version");
    expect(identifiers).toContain("contenders");
    expect(identifiers).toContain("tasks");
  });

  it("reports unknown top-level fields as unknown configuration fields", async () => {
    const configPath = await writeConfigFile(
      `${configYaml({ artifactsDirectory: "./artifacts", repositoryPath: "./repo", executable: "opencode" })}\nunknownSection: {}\n`,
    );

    const error = expectFailure(await loadConfig(configPath), "ConfigValidationError");

    expect(error.findings).toContainEqual({
      severity: "error",
      identifier: "config",
      message: "Unknown configuration field",
    });
  });

  it("rejects an artifact directory inside a repository after real-path resolution", async () => {
    await fs.mkdir(join(tempDirectory, "repo"), { recursive: true });
    const configPath = await writeConfigFile(
      configYaml({ artifactsDirectory: "./repo/.tevu", repositoryPath: "./repo", executable: "opencode" }),
    );

    const error = expectFailure(await loadConfig(configPath), "ConfigValidationError");

    expect(error.findings).toEqual([
      {
        severity: "error",
        identifier: "artifacts.directory",
        message: 'artifacts.directory must be outside repository "sample-repo" after real-path resolution',
      },
    ]);
  });

  it("rejects a repository inside the artifact directory after real-path resolution", async () => {
    await fs.mkdir(join(tempDirectory, "artifacts", "repo"), { recursive: true });
    const configPath = await writeConfigFile(
      configYaml({ artifactsDirectory: "./artifacts", repositoryPath: "./artifacts/repo", executable: "opencode" }),
    );

    const error = expectFailure(await loadConfig(configPath), "ConfigValidationError");

    expect(error.findings).toEqual([
      {
        severity: "error",
        identifier: "repositories.sample-repo.path",
        message: 'repository "sample-repo" overlaps the artifact directory after real-path resolution',
      },
    ]);
  });

  it("rejects an artifact directory that symlinks into a repository", async () => {
    await fs.mkdir(join(tempDirectory, "repo"), { recursive: true });
    await fs.symlink(join(tempDirectory, "repo"), join(tempDirectory, "artifacts-link"));
    const configPath = await writeConfigFile(
      configYaml({ artifactsDirectory: "./artifacts-link", repositoryPath: "./repo", executable: "opencode" }),
    );

    const error = expectFailure(await loadConfig(configPath), "ConfigValidationError");

    expect(error.findings).toEqual([
      {
        severity: "error",
        identifier: "artifacts.directory",
        message: 'artifacts.directory must be outside repository "sample-repo" after real-path resolution',
      },
    ]);
  });
});

describe("canonicalConfigSerialization", () => {
  it("produces identical output for equivalent configurations with different key insertion order", () => {
    const ordered = buildConfig();
    const reordered = {
      tasks: ordered.tasks,
      contenders: ordered.contenders,
      repositories: ordered.repositories.map((repository) => ({ path: repository.path, id: repository.id })),
      opencode: ordered.opencode,
      execution: ordered.execution,
      artifacts: ordered.artifacts,
      version: ordered.version,
    };

    expect(canonicalConfigSerialization(reordered)).toBe(canonicalConfigSerialization(ordered));
    expect(JSON.parse(canonicalConfigSerialization(ordered))).toEqual(ordered);
  });

  it("serializes environment variable names without any environment values", () => {
    const config = buildConfig({
      execution: buildExecution({
        opencodeEnvironment: [buildEnvironmentVariable({ name: "SYNTHETIC_OC_VAR" })],
      }),
    });

    const serialized = canonicalConfigSerialization(config);
    const parsed = JSON.parse(serialized) as Pick<TevuConfig, "execution">;

    expect(serialized).toContain('"SYNTHETIC_OC_VAR"');
    expect(serialized).toContain('"EVAL_TOKEN"');
    expect(parsed.execution.opencodeEnvironment[0] && Object.keys(parsed.execution.opencodeEnvironment[0]).sort()).toEqual([
      "classification",
      "name",
    ]);
    expect(parsed.execution.evaluatorEnvironment[0] && Object.keys(parsed.execution.evaluatorEnvironment[0]).sort()).toEqual([
      "classification",
      "name",
    ]);
  });
});

describe("createTask", () => {
  it("appends the task and performs exactly one configuration replacement", async () => {
    const base = buildConfig();
    const input = buildWizardInput({ source: { kind: "manual", reference: "REF-1", title: "New task" } });
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({
        read: vi.fn(async () => ({ ok: true as const, value: base })),
      }),
    });

    const task = expectOk(await createTask(input, dependencies));

    expect(task).toEqual({
      id: "new-task",
      repositoryId: "sample-repo",
      startCommit: "resolved-abc123",
      source: { kind: "manual", reference: "REF-1", title: "New task" },
      description: "A new task",
      prompt: "Do the new task",
      definitionOfReady: input.definitionOfReady,
      acceptanceCriteria: input.acceptanceCriteria,
      definitionOfDone: input.definitionOfDone,
    });
    const replace = vi.mocked(dependencies.configStore.replace);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]?.[0]).toBe(input.configPath);
    expect(replace.mock.calls[0]?.[1]).toEqual({ ...base, tasks: [...base.tasks, task] });
  });

  it("pins the task to a newly added repository when one is supplied", async () => {
    const base = buildConfig();
    const newRepository = buildRepository({ id: "extra-repo", path: "/repos/extra" });
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({
        read: vi.fn(async () => ({ ok: true as const, value: base })),
      }),
    });

    const task = expectOk(await createTask(buildWizardInput({ repositoryId: "extra-repo", newRepository }), dependencies));

    expect(task.repositoryId).toBe("extra-repo");
    expect(vi.mocked(dependencies.configStore.replace).mock.calls[0]?.[1]?.repositories).toEqual([
      ...base.repositories,
      newRepository,
    ]);
  });

  it("rejects a repositoryId that matches no configured or new repository", async () => {
    const input = buildWizardInput({ repositoryId: "ghost" });
    const dependencies = buildTaskDependencies();

    const error = expectFailure(await createTask(input, dependencies), "ConfigValidationError");

    expect(error.findings).toContainEqual({
      severity: "error",
      identifier: "tasks.new-task.repositoryId",
      message: 'repositoryId "ghost" does not reference a configured or newly added repository',
    });
    expect(dependencies.configStore.replace).not.toHaveBeenCalled();
  });

  it("stores a wizard-supplied Jira snapshot verbatim without reading the issue", async () => {
    const snapshot = buildJiraSnapshot({ issueKey: "PROJ-7" });
    const dependencies = buildTaskDependencies();
    const input = buildWizardInput({
      source: { kind: "jira-cloud", issueKey: snapshot.issueKey, snapshot },
    });

    const task = expectOk(await createTask(input, dependencies));

    expect(task.source).toEqual({
      kind: "jira-cloud",
      issueKey: "PROJ-7",
      issueUrl: snapshot.issueUrl,
      importedAt: snapshot.importedAt,
      importedSummary: snapshot.summary,
      importedDescription: snapshot.description,
    });
    expect(dependencies.jira?.readIssue).not.toHaveBeenCalled();
  });

  it("imports the issue once with the injected clock when no snapshot exists", async () => {
    const dependencies = buildTaskDependencies();
    const input = buildWizardInput({ source: { kind: "jira-cloud", issueKey: "PROJ-7" } });

    const task = expectOk(await createTask(input, dependencies));

    expect(dependencies.jira?.readIssue).toHaveBeenCalledExactlyOnceWith("PROJ-7");
    expect(task.source).toEqual({
      kind: "jira-cloud",
      issueKey: "PROJ-7",
      issueUrl: "https://jira.example.com/browse/PROJ-7",
      importedAt: FIXED_NOW.toISOString(),
      importedSummary: "Issue summary",
      importedDescription: "Issue description",
    });
  });

  it("returns JiraImportError when the configuration has no Jira settings", async () => {
    const dependencies = buildTaskDependencies({ jira: null });
    const input = buildWizardInput({ source: { kind: "jira-cloud", issueKey: "PROJ-7" } });

    const error = expectFailure(await createTask(input, dependencies), "JiraImportError");

    expect(error.issueKey).toBe("PROJ-7");
    expect(dependencies.configStore.replace).not.toHaveBeenCalled();
  });

  it("returns CancellationError with no reads or writes when already cancelled", async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    const dependencies = buildTaskDependencies({ cancellation: cancellation.signal });

    const error = expectFailure(await createTask(buildWizardInput(), dependencies), "CancellationError");

    expect(error.activeCaseIds).toEqual([]);
    expect(dependencies.configStore.exists).not.toHaveBeenCalled();
    expect(dependencies.configStore.replace).not.toHaveBeenCalled();
  });

  it("returns CancellationError before the replacement when cancelled during validation", async () => {
    const cancellation = new AbortController();
    const dependencies = buildTaskDependencies({
      cancellation: cancellation.signal,
      git: buildGit({
        validateSource: vi.fn(async (repository: RepositoryDefinition, commit: string) => {
          cancellation.abort();
          return {
            ok: true as const,
            value: { repositoryId: repository.id, requestedCommit: commit, resolvedCommit: `resolved-${commit}` },
          };
        }),
      }),
    });

    const error = expectFailure(await createTask(buildWizardInput(), dependencies), "CancellationError");

    expect(error.activeCaseIds).toEqual([]);
    expect(dependencies.configStore.replace).not.toHaveBeenCalled();
  });

  it("returns SourceMaterializationError with the task id when the commit cannot be resolved", async () => {
    const dependencies = buildTaskDependencies({
      git: buildGit({
        validateSource: vi.fn(async () => ({
          ok: false as const,
          error: { kind: "SourceMaterializationError" as const, taskId: "substituted", reason: "commit not found" },
        })),
      }),
    });

    const error = expectFailure(await createTask(buildWizardInput(), dependencies), "SourceMaterializationError");

    expect(error.taskId).toBe("new-task");
    expect(error.reason).toBe("commit not found");
    expect(dependencies.configStore.replace).not.toHaveBeenCalled();
  });

  it("propagates a base configuration read failure without any write", async () => {
    const readFailure: TevuResult<TevuConfig, "ConfigValidationError"> = {
      ok: false,
      error: {
        kind: "ConfigValidationError",
        findings: [{ severity: "error", identifier: "contenders", message: "too small" }],
      },
    };
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({ read: vi.fn(async () => readFailure) }),
    });

    const error = expectFailure(await createTask(buildWizardInput(), dependencies), "ConfigValidationError");

    expect(error).toEqual(readFailure.error);
    expect(dependencies.configStore.replace).not.toHaveBeenCalled();
  });

  it("rejects a candidate that violates the schema and writes nothing", async () => {
    const input = buildWizardInput({ taskId: "write-report" });
    const dependencies = buildTaskDependencies();

    const error = expectFailure(await createTask(input, dependencies), "ConfigValidationError");

    expect(error.findings).toContainEqual({
      severity: "error",
      identifier: "tasks.1.id",
      message: 'duplicate tasks id "write-report"',
    });
    expect(dependencies.configStore.replace).not.toHaveBeenCalled();
  });

  it("bootstraps a new configuration when the file is missing and answers were captured", async () => {
    const bootstrap: ConfigBootstrapInput = {
      artifacts: { directory: "/tmp/tevu/artifacts" },
      execution: buildExecution(),
      opencode: { executable: "opencode" },
      repositories: [buildRepository()],
      contenders: [buildContender(), buildContender({ id: "beta", model: "anthropic/claude-4", variant: "max" })],
    };
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({ exists: vi.fn(async () => false) }),
    });

    const task = expectOk(await createTask(buildWizardInput({ bootstrap }), dependencies));

    expect(vi.mocked(dependencies.configStore.replace).mock.calls[0]?.[1]).toEqual({
      version: 1,
      ...bootstrap,
      tasks: [task],
    });
  });

  it("reports a missing configuration when no bootstrap answers were captured", async () => {
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({ exists: vi.fn(async () => false) }),
    });

    const error = expectFailure(await createTask(buildWizardInput(), dependencies), "ConfigValidationError");

    expect(error.findings).toContainEqual({
      severity: "error",
      identifier: "config",
      message: "configuration file is missing and no bootstrap answers were captured",
    });
    expect(dependencies.configStore.replace).not.toHaveBeenCalled();
  });

  it("propagates a replacement failure as the final write attempt", async () => {
    const replaceFailure: TevuResult<void, "ArtifactError"> = {
      ok: false,
      error: { kind: "ArtifactError", operation: "replace-configuration", reason: "disk full" },
    };
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({ replace: vi.fn(async () => replaceFailure) }),
    });

    const error = expectFailure(await createTask(buildWizardInput(), dependencies), "ArtifactError");

    expect(error).toEqual(replaceFailure.error);
    expect(vi.mocked(dependencies.configStore.replace)).toHaveBeenCalledTimes(1);
  });
});

describe("validateConfig", () => {
  it("returns a valid report with the probed capability report when everything passes", async () => {
    const dependencies = buildValidationDependencies();

    const report = expectOk(await validateConfig(buildConfig(), dependencies));

    expect(report.valid).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.capabilities).toEqual(buildCapabilityReport("opencode"));
  });

  it("retains every independent finding instead of stopping at the first failure", async () => {
    const config = buildConfig({
      tasks: [buildTask({ id: "broken-ref", repositoryId: "ghost" }), buildTask({ id: "write-report" })],
    });
    const dependencies = buildValidationDependencies({
      git: buildGit({
        validateSource: vi.fn(async () => ({
          ok: false as const,
          error: { kind: "SourceMaterializationError" as const, taskId: "substitute", reason: "commit missing" },
        })),
      }),
      prerequisites: buildPrerequisites({
        probeHost: vi.fn(async () => ({
          ok: false as const,
          error: { kind: "PrerequisiteError" as const, tool: "node", expected: ">=24 <25", actual: "18.0.0" },
        })),
        hasEnvironmentVariable: vi.fn(() => false),
        probeWritableDirectory: vi.fn(async () => ({
          ok: false as const,
          error: { kind: "PrerequisiteError" as const, tool: "artifacts-directory", expected: "a writable directory", actual: "/tmp/tevu/artifacts" },
        })),
      }),
      opencode: buildOpenCodeAdapter({
        probe: vi.fn(async () => ({
          ok: false as const,
          error: { kind: "OpenCodeProtocolError" as const, context: { phase: "probe" as const }, reason: "probe timed out" },
        })),
      }),
    });

    const outcome = await validateConfig(config, dependencies);

    expect(outcome.ok).toBe(true);
    const report = expectOk(outcome);
    expect(report.valid).toBe(false);
    expect(report.findings.map((finding) => finding.identifier)).toEqual([
      "tasks.0.repositoryId",
      "prerequisites.node",
      "environment.EVAL_TOKEN",
      "tasks.write-report.startCommit",
      "prerequisites.artifacts-directory",
      "opencode.executable",
    ]);
    expect(report.findings.find((finding) => finding.identifier === "prerequisites.node")?.message).toBe(
      "expected >=24 <25, actual 18.0.0",
    );
    expect(report.capabilities).toBeNull();
  });

  it("surfaces schema findings when revalidating an invalid configuration", async () => {
    const config = buildConfig({ contenders: [buildContender()] });

    const report = expectOk(await validateConfig(config, buildValidationDependencies()));

    expect(report.findings.map((finding) => finding.identifier)).toContain("contenders");
    expect(report.valid).toBe(false);
  });

  it("checks every configured variable by name and skips the snapshot when a variable is missing", async () => {
    const config = buildConfig({
      execution: buildExecution({
        opencodeEnvironment: [buildEnvironmentVariable({ name: "OC_VAR", classification: "ordinary" })],
        evaluatorEnvironment: [buildEnvironmentVariable()],
      }),
      jira: {
        baseUrl: "https://jira.example.com",
        emailEnvironmentVariable: "JIRA_EMAIL",
        tokenEnvironmentVariable: "JIRA_TOKEN",
      },
    });
    const dependencies = buildValidationDependencies({
      prerequisites: buildPrerequisites({
        hasEnvironmentVariable: vi.fn((name: string) => name !== "OC_VAR"),
      }),
    });

    const report = expectOk(await validateConfig(config, dependencies));

    expect(report.findings.map((finding) => finding.identifier)).toEqual(["environment.OC_VAR"]);
    expect(dependencies.environments.snapshotParent).not.toHaveBeenCalled();
  });

  it("reports a failed parent environment snapshot when all variables are set", async () => {
    const dependencies = buildValidationDependencies({
      environments: buildEnvironments({
        snapshotParent: vi.fn(() => ({
          ok: false as const,
          error: { kind: "PrerequisiteError" as const, tool: "path", expected: "a non-empty PATH", actual: "empty" },
        })),
      }),
    });

    const report = expectOk(await validateConfig(buildConfig(), dependencies));

    expect(report.findings).toContainEqual({
      severity: "error",
      identifier: "prerequisites.path",
      message: "expected a non-empty PATH, actual empty",
    });
    expect(report.valid).toBe(false);
  });

  it("validates each distinct repository-and-commit pair once", async () => {
    const first = buildTask({ id: "task-one" });
    const second = buildTask({ id: "task-two" });
    const third = buildTask({ id: "task-three", startCommit: "ffffff0123456789abcdef0123456789abcdef01" });
    const dependencies = buildValidationDependencies();

    const report = expectOk(await validateConfig(buildConfig({ tasks: [first, second, third] }), dependencies));

    expect(report.valid).toBe(true);
    expect(vi.mocked(dependencies.git.validateSource)).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(dependencies.git.validateSource).mock.calls.map(([repository, commit]) => [repository.id, commit]),
    ).toEqual([
      ["sample-repo", first.startCommit],
      ["sample-repo", third.startCommit],
    ]);
  });
});
