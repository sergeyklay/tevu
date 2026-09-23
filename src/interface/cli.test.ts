// @vitest-environment node

import { Readable, Writable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram, runProgram } from "./program.ts";

import type {
  BenchmarkExecutionHooks,
  ProgramDependencies,
  ProgramIo,
  ProgramOperations,
} from "./program.ts";
import type { AssessmentCaseContext, ManualCheckSummary } from "./task-wizard.ts";
import type {
  CheckDefinition,
  JiraCloudConfig,
  TaskDefinition,
  TevuConfig,
} from "../config/schema.ts";
import type {
  AssessmentRecord,
  BenchmarkMetrics,
  BenchmarkPlan,
  CaseIdentity,
  CaseResult,
  JiraIssueSnapshot,
  OpenCodeCapabilityReport,
  ReportResult,
  RunFinding,
  RunResult,
  TevuError,
  ValidationFinding,
  ValidationReport,
} from "../domain/types.ts";

const clack = vi.hoisted(() => {
  const CANCEL = Symbol("clack-cancel");
  const state = {
    prompts: [] as Array<{ kind: string; message: string }>,
    notes: [] as Array<{ message: string; title: string | undefined }>,
    logs: [] as Array<{ kind: string; message: string }>,
    rejections: [] as Array<{ kind: string; message: string; reason: string }>,
    answers: [] as unknown[],
  };
  return { CANCEL, state };
});

vi.mock("@clack/prompts", () => {
  type AskOptions = {
    message: string;
    validate?: (value: string | undefined) => string | undefined;
  };
  const isInvalidMarker = (value: unknown): value is { invalid: string } =>
    typeof value === "object" && value !== null && "invalid" in value;
  const ask = async (kind: string, options: AskOptions): Promise<unknown> => {
    for (;;) {
      clack.state.prompts.push({ kind, message: options.message });
      const answer = clack.state.answers.shift();
      if (answer === undefined) {
        throw new Error(`no scripted answer left for ${kind}: ${options.message}`);
      }
      if (isInvalidMarker(answer)) {
        const reason = options.validate?.(answer.invalid);
        if (reason !== undefined) {
          clack.state.rejections.push({ kind, message: options.message, reason });
          continue;
        }
        return answer.invalid;
      }
      return answer;
    }
  };
  return {
    text: (options: AskOptions) => ask("text", options),
    confirm: (options: { message: string }) => ask("confirm", options),
    select: (options: { message: string }) => ask("select", options),
    multiselect: (options: { message: string }) => ask("multiselect", options),
    intro: (message: string) => {
      clack.state.prompts.push({ kind: "intro", message });
    },
    note: (message: string, title?: string) => {
      clack.state.notes.push({ message, title });
    },
    log: {
      info: (message: string) => {
        clack.state.logs.push({ kind: "info", message });
      },
      warn: (message: string) => {
        clack.state.logs.push({ kind: "warn", message });
      },
      step: (message: string) => {
        clack.state.logs.push({ kind: "step", message });
      },
    },
    isCancel: (value: unknown) => value === clack.CANCEL,
  };
});

const FIXED_NOW = new Date("2026-09-23T10:00:00.000Z");

function buildJiraCloudSettings(overrides: Partial<JiraCloudConfig> = {}): JiraCloudConfig {
  return {
    baseUrl: "https://jira.example.com",
    emailEnvironmentVariable: "JIRA_EMAIL",
    tokenEnvironmentVariable: "JIRA_TOKEN",
    ...overrides,
  };
}

function buildManualCheck(id: string, overrides: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id,
    description: `${id} check`,
    required: true,
    evaluator: { kind: "manual" },
    ...overrides,
  };
}

function buildTaskDefinition(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: "task-1",
    repositoryId: "repo-1",
    startCommit: "abc123",
    source: { kind: "manual", title: "Fixture task source" },
    description: "Fixture task description",
    prompt: "Fixture task prompt",
    definitionOfReady: [{ id: "ready-1", description: "Repository is readable", confirmed: true }],
    acceptanceCriteria: [buildManualCheck("acc-1")],
    definitionOfDone: [buildManualCheck("dod-1")],
    ...overrides,
  };
}

function buildTevuConfig(overrides: Partial<TevuConfig> = {}): TevuConfig {
  return {
    version: 1,
    artifacts: { directory: "/tmp/artifacts" },
    execution: {
      concurrency: 2,
      caseTimeoutMs: 600000,
      terminationGraceMs: 5000,
      opencodeEnvironment: [],
      evaluatorEnvironment: [],
    },
    opencode: { executable: "opencode" },
    repositories: [{ id: "repo-1", path: "../repos/fixture" }],
    contenders: [
      { id: "c1", model: "provider/model-a", variant: "high" },
      { id: "c2", model: "provider/model-b", variant: "low" },
    ],
    tasks: [buildTaskDefinition()],
    ...overrides,
  };
}

function buildFinding(overrides: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    severity: "warning",
    identifier: "task-1",
    message: "description is thin",
    ...overrides,
  };
}

function buildCapabilityReport(
  overrides: Partial<OpenCodeCapabilityReport> = {},
): OpenCodeCapabilityReport {
  return {
    executable: "opencode",
    detectedVersion: "1.18.32",
    commands: { run: "available", export: "available" },
    runOptions: { jsonFormat: "available", model: "available", variant: "available" },
    isolation: { denyOutsideWorktree: "available" },
    ...overrides,
  };
}

function buildValidationReport(overrides: Partial<ValidationReport> = {}): ValidationReport {
  return {
    valid: true,
    findings: [],
    capabilities: buildCapabilityReport(),
    ...overrides,
  };
}

function buildBenchmarkPlan(
  config: TevuConfig = buildTevuConfig(),
  overrides: Partial<BenchmarkPlan> = {},
): BenchmarkPlan {
  return {
    config,
    cases: config.contenders.flatMap((contender) =>
      config.tasks.map((task) => ({
        caseId: `case-${contender.id}-${task.id}`,
        taskId: task.id,
        contenderId: contender.id,
        sourceCommit: "abc123def",
        model: contender.model,
        variant: contender.variant,
      })),
    ),
    concurrency: config.execution.concurrency,
    caseTimeoutMs: config.execution.caseTimeoutMs,
    terminationGraceMs: config.execution.terminationGraceMs,
    artifactsDirectory: config.artifacts.directory,
    ...overrides,
  };
}

function buildCaseIdentity(overrides: Partial<CaseIdentity> = {}): CaseIdentity {
  return {
    caseId: "case-c1-task-1",
    taskId: "task-1",
    contenderId: "c1",
    sourceCommit: "abc123def",
    model: "provider/model-a",
    variant: "high",
    ...overrides,
  };
}

function buildMetrics(): BenchmarkMetrics {
  const metric = {
    value: 1,
    unit: "count" as const,
    availability: { status: "available" as const, source: "fixture" },
    scope: "root-session" as const,
  };
  return {
    elapsed: metric,
    inputTokens: metric,
    outputTokens: metric,
    reasoningTokens: metric,
    cacheReadTokens: metric,
    cacheWriteTokens: metric,
    turns: metric,
    apiCalls: metric,
    apiErrors: metric,
    toolCalls: metric,
    skillCalls: metric,
    cost: metric,
  };
}

function buildCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    schemaVersion: 1,
    identity: buildCaseIdentity(),
    lifecycle: "completed",
    process: {
      exitCode: 0,
      signal: null,
      startedAt: "2026-09-23T10:00:01.000Z",
      endedAt: "2026-09-23T10:00:05.000Z",
      durationMs: 4000,
      terminationStage: "graceful",
    },
    outcome: "passed",
    checks: [],
    metrics: buildMetrics(),
    artifacts: {
      events: null,
      diagnostics: null,
      sessionExport: null,
      solutionPatch: null,
      checks: null,
      assessment: null,
      result: null,
    },
    failure: null,
    ...overrides,
  };
}

function buildRunFinding(overrides: Partial<RunFinding> = {}): RunFinding {
  return {
    severity: "warning",
    caseId: "case-c1-task-1",
    message: "diagnostics truncated",
    ...overrides,
  };
}

function buildRunResult(overrides: Partial<RunResult> = {}): RunResult {
  const identity = buildCaseIdentity();
  return {
    schemaVersion: 1,
    manifest: {
      schemaVersion: 1,
      runId: "run-1",
      configDigest: "fixture-digest",
      startedAt: "2026-09-23T10:00:00.000Z",
      completedAt: "2026-09-23T10:05:00.000Z",
      host: { platform: "linux", nodeVersion: "24.10.0", bunVersion: "1.2.0" },
      tools: { gitVersion: "2.47.0", opencodeVersion: "1.18.32" },
      execution: { concurrency: 2, caseTimeoutMs: 600000 },
      cases: [identity],
    },
    cases: [buildCaseResult({ identity })],
    findings: [],
    exitCode: 0,
    ...overrides,
  };
}

function buildReportResult(overrides: Partial<ReportResult> = {}): ReportResult {
  return {
    runId: "run-1",
    normalizedJson: "{}",
    markdown: "# Report\n",
    ...overrides,
  };
}

function buildJiraIssueSnapshot(overrides: Partial<JiraIssueSnapshot> = {}): JiraIssueSnapshot {
  return {
    issueKey: "TEVU-42",
    issueUrl: "https://jira.example.com/browse/TEVU-42",
    summary: "Add an export button",
    description: "Users cannot export the current view.",
    ...overrides,
  };
}

function buildManualCheckSummary(overrides: Partial<ManualCheckSummary> = {}): ManualCheckSummary {
  return {
    checkId: "acc-1",
    category: "acceptance",
    description: "Export produces a CSV",
    required: true,
    ...overrides,
  };
}

function buildAssessmentRecord(overrides: Partial<AssessmentRecord> = {}): AssessmentRecord {
  return {
    checkId: "acc-1",
    verdict: "passed",
    assessor: "bob",
    note: "",
    assessedAt: "2026-09-22T09:00:00.000Z",
    ...overrides,
  };
}

function buildAssessmentContext(
  overrides: Partial<AssessmentCaseContext> = {},
): AssessmentCaseContext {
  return {
    manualChecks: [buildManualCheckSummary()],
    existing: [],
    ...overrides,
  };
}

function artifactError(operation: string, reason: string): Extract<TevuError, { kind: "ArtifactError" }> {
  return { kind: "ArtifactError", operation, reason };
}

function prerequisiteError(
  tool: string,
  expected: string,
): Extract<TevuError, { kind: "PrerequisiteError" }> {
  return { kind: "PrerequisiteError", tool, expected };
}

function configParseError(
  findings: ValidationFinding[],
): Extract<TevuError, { kind: "ConfigParseError" }> {
  return { kind: "ConfigParseError", findings };
}

function createOperations(overrides: Partial<ProgramOperations> = {}): ProgramOperations {
  const config = buildTevuConfig();
  return {
    configExists: vi.fn(async () => true),
    loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
    importJiraIssue: vi.fn(async () => ({ ok: true as const, value: buildJiraIssueSnapshot() })),
    createTask: vi.fn(async () => ({ ok: true as const, value: buildTaskDefinition({ id: "task-2" }) })),
    validateConfig: vi.fn(async () => ({ ok: true as const, value: buildValidationReport() })),
    planBenchmark: vi.fn(() => buildBenchmarkPlan(config)),
    executeBenchmark: vi.fn(async () => ({ ok: true as const, value: buildRunResult() })),
    rebuildRunReport: vi.fn(async () => ({ ok: true as const, value: buildReportResult() })),
    readAssessmentContext: vi.fn(async () => ({ ok: true as const, value: buildAssessmentContext() })),
    applyAssessment: vi.fn(async () => ({ ok: true as const, value: buildCaseResult() })),
    ...overrides,
  };
}

class MemoryStream extends Writable {
  readonly chunks: string[] = [];
  isTTY?: boolean;

  _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  get text(): string {
    return this.chunks.join("");
  }

  get lines(): string[] {
    return this.text.split("\n").filter((line) => line.length > 0);
  }
}

function createIo(ttys: { stdin?: boolean; stdout?: boolean } = {}): ProgramIo {
  const stdin: ProgramIo["stdin"] = new Readable({ read() {} });
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  if (ttys.stdin === true) {
    stdin.isTTY = true;
  }
  if (ttys.stdout === true) {
    stdout.isTTY = true;
  }
  return { stdin, stdout, stderr };
}

function createDependencies(overrides: Partial<ProgramDependencies> = {}): ProgramDependencies {
  return {
    io: createIo({ stdin: true, stdout: true }),
    operations: createOperations(),
    now: () => FIXED_NOW,
    redact: (text) => text,
    cancellation: new AbortController().signal,
    ...overrides,
  };
}

async function runCli(
  argv: readonly string[],
  overrides: Partial<ProgramDependencies> = {},
): Promise<{ code: number; dependencies: ProgramDependencies; out: string[]; err: string[] }> {
  const dependencies = createDependencies(overrides);
  const code = await runProgram(argv, dependencies);
  const io = dependencies.io;
  return {
    code,
    dependencies,
    out: (io.stdout as MemoryStream).lines,
    err: (io.stderr as MemoryStream).lines,
  };
}

function scriptAnswers(...answers: unknown[]): void {
  clack.state.answers.push(...answers);
}

function expectNoWrites(operations: ProgramOperations): void {
  expect(operations.createTask).not.toHaveBeenCalled();
  expect(operations.executeBenchmark).not.toHaveBeenCalled();
  expect(operations.rebuildRunReport).not.toHaveBeenCalled();
  expect(operations.applyAssessment).not.toHaveBeenCalled();
}

function taskInterviewAnswers(repositoryChoice: string): unknown[] {
  return [
    "manual",
    "Add an export button",
    "",
    repositoryChoice,
    "abc123",
    "task-2",
    "Export the current view as CSV.",
    "Implement CSV export for the current view.",
    "ready-1",
    "Repository is readable",
    true,
    false,
    "acc-1",
    "Export produces a CSV",
    true,
    "manual",
    false,
    "dod-1",
    "README documents the button",
    true,
    "manual",
    false,
  ];
}

const BOOTSTRAP_PROMPTS = [
  "Artifacts directory (outside every repository)",
  "Execution concurrency (1-32)",
  "Case timeout in milliseconds",
  "Termination grace in milliseconds",
  "OpenCode executable (command name or path)",
  "Add a OpenCode environment variable (names only, never values)?",
  "Add a evaluator environment variable (names only, never values)?",
  "Configure Jira Cloud issue import?",
  "Repository ID",
  'Local path of repository "alpha"',
  "Add another repository?",
  "Contender ID",
  'Model for "c1" (provider/model)',
  'Effort variant for "c1"',
  "Contender ID",
  'Model for "c2" (provider/model)',
  'Effort variant for "c2"',
  "Add another contender?",
];

const HELP_CASES: Array<{ argv: string[]; description: string; usage: string }> = [
  {
    argv: [],
    description: "Compare coding models on your tasks",
    usage: "Usage:\n  tevu [options]\n  tevu <command> [options]",
  },
  {
    argv: ["task"],
    description: "Manage benchmark tasks",
    usage: "Usage:\n  tevu task [options]\n  tevu task <command> [options]",
  },
  {
    argv: ["task", "add"],
    description: "Add a benchmark task",
    usage: "Usage:\n  tevu task add [options]",
  },
  {
    argv: ["validate"],
    description: "Check configuration and prerequisites",
    usage: "Usage:\n  tevu validate [options]",
  },
  {
    argv: ["run"],
    description: "Run the benchmark",
    usage: "Usage:\n  tevu run [options]",
  },
  {
    argv: ["assess"],
    description: "Record manual check results",
    usage: "Usage:\n  tevu assess <run-id> <case-id> [options]",
  },
  {
    argv: ["report"],
    description: "Regenerate a report from a saved run",
    usage: "Usage:\n  tevu report <run-id> [options]",
  },
];

const USAGE_ERROR_CASES: Array<{ argv: string[]; error: string; usage: string }> = [
  {
    argv: ["frobnicate"],
    error: "error: unknown command 'frobnicate'",
    usage: "Usage: tevu [options] [command]",
  },
  {
    argv: ["assess"],
    error: "error: missing required argument 'run-id'",
    usage: "Usage: tevu assess [options] <run-id> <case-id>",
  },
  {
    argv: ["assess", "run-1"],
    error: "error: missing required argument 'case-id'",
    usage: "Usage: tevu assess [options] <run-id> <case-id>",
  },
  {
    argv: ["run", "--bogus"],
    error: "error: unknown option '--bogus'",
    usage: "Usage: tevu run [options]",
  },
  {
    argv: ["--version"],
    error: "error: unknown option '--version'",
    usage: "Usage: tevu [options] [command]",
  },
];

const TTY_REJECTION_CASES: Array<{ stdin: boolean; stdout: boolean; actual: string }> = [
  { stdin: false, stdout: false, actual: "stdin and stdout are not a TTY" },
  { stdin: false, stdout: true, actual: "stdin is not a TTY" },
  { stdin: true, stdout: false, actual: "stdout is not a TTY" },
];

const CONFIG_HONORING_CASES: Array<{ command: string[] }> = [
  { command: ["validate"] },
  { command: ["run", "--dry-run"] },
  { command: ["report", "run-1"] },
];

const EXECUTE_FAILURE_CASES: Array<{
  name: string;
  error: Extract<TevuError, { kind: "CancellationError" | "PrerequisiteError" }>;
  code: number;
  stderr: string;
}> = [
  {
    name: "cancellation",
    error: { kind: "CancellationError", activeCaseIds: [] },
    code: 130,
    stderr: "Cancelled.",
  },
  {
    name: "prerequisite",
    error: { kind: "PrerequisiteError", tool: "opencode", expected: "an opencode executable" },
    code: 1,
    stderr: 'error: prerequisite "opencode" is not satisfied; expected an opencode executable',
  },
];

const APPLY_FAILURE_CASES: Array<{
  name: string;
  error: Extract<
    TevuError,
    { kind: "AssessmentConflictError" | "ArtifactError" | "CancellationError" }
  >;
  code: number;
  stderr: string;
}> = [
  {
    name: "assessment conflict",
    error: {
      kind: "AssessmentConflictError",
      runId: "run-1",
      caseId: "case-1",
      reason: "another assessor holds the revision lock",
    },
    code: 1,
    stderr:
      'error: assessment for run "run-1" case "case-1" is locked: another assessor holds the revision lock',
  },
  {
    name: "artifact failure",
    error: { kind: "ArtifactError", operation: "write-assessment", reason: "disk full" },
    code: 1,
    stderr: 'error: artifact operation "write-assessment" failed: disk full',
  },
  {
    name: "cancellation",
    error: { kind: "CancellationError", activeCaseIds: [] },
    code: 130,
    stderr: "Cancelled.",
  },
];

describe("tevu CLI", () => {
  beforeEach(() => {
    clack.state.prompts = [];
    clack.state.notes = [];
    clack.state.logs = [];
    clack.state.rejections = [];
    clack.state.answers = [];
  });

  describe("command surface", () => {
    it("registers exactly the five top-level commands with task add as the only subcommand", () => {
      const program = createProgram(createDependencies());

      expect(program.commands.map((command) => command.name())).toEqual([
        "task",
        "validate",
        "run",
        "assess",
        "report",
      ]);
      expect(program.commands[0]?.commands.map((command) => command.name())).toEqual(["add"]);
    });

    it("defaults --config to tevu.yaml and registers the per-command options", () => {
      const program = createProgram(createDependencies());
      const run = program.commands.find((command) => command.name() === "run");
      const add = program.commands[0]?.commands[0];

      expect(run?.options.map((option) => option.long)).toEqual(["--config", "--dry-run"]);
      expect(run?.options[0]?.defaultValue).toBe("tevu.yaml");
      expect(add?.options.map((option) => option.long)).toEqual(["--config", "--jira"]);
    });

    it("requires both run-id and case-id arguments on assess", () => {
      const program = createProgram(createDependencies());
      const assess = program.commands.find((command) => command.name() === "assess");

      expect(assess?.registeredArguments.map((argument) => argument.name())).toEqual([
        "run-id",
        "case-id",
      ]);
      expect(assess?.registeredArguments.every((argument) => argument.required)).toBe(true);
    });

    it("rejects --version as an unknown option", async () => {
      const { code, out, err } = await runCli(["--version"]);

      expect(code).toBe(1);
      expect(err[0]).toBe("error: unknown option '--version'");
      expect(out).toEqual([]);
    });
  });

  describe("help", () => {
    it.each(HELP_CASES)("prints description-first help for $description", async ({ argv, description, usage }) => {
      const { code, dependencies, err } = await runCli([...argv, "--help"]);
      const help = (dependencies.io.stdout as MemoryStream).text;

      expect(code).toBe(0);
      expect(help.startsWith(`${description}\n\n${usage}\n\n`)).toBe(true);
      expect(help).not.toMatch(/OpenCode|Sensitive data:|Isolation boundary:/i);
      expect(help).toMatch(/-h, --help\s+Show help\n/);
      expect(help).not.toMatch(/\.\s*$/m);
      expect(err).toEqual([]);
    });

    it.each(HELP_CASES)("formats examples as comment and command pairs for $description", async ({ argv }) => {
      const { dependencies } = await runCli([...argv, "--help"]);
      const help = (dependencies.io.stdout as MemoryStream).text;
      const examples = help.split("\nExamples:\n")[1]?.trimEnd();

      expect(examples).toMatch(/^  # [^\n]+\n  tevu [^\n]+(?:\n\n  # [^\n]+\n  tevu [^\n]+)*$/);
    });

    it.each([
      { argv: [], names: ["task", "validate", "run", "assess", "report"] },
      { argv: ["task"], names: ["add"] },
    ])("lists only command names in Commands for $argv", async ({ argv, names }) => {
      const { dependencies } = await runCli([...argv, "--help"]);
      const help = (dependencies.io.stdout as MemoryStream).text;
      const commands = help.split("\nCommands:\n")[1]?.split("\n\n")[0];

      expect(commands?.split("\n").map((line) => line.trimStart().split(/\s{2,}/)[0])).toEqual(names);
    });

    it("documents --dry-run in the run help", async () => {
      const { out } = await runCli(["run", "--help"]);

      const help = out.join("").replace(/\s+/g, " ");
      expect(help).toContain("--dry-run");
      expect(help).toContain("Show the execution plan without running tasks");
    });

    it("documents --jira in the task add help", async () => {
      const { out } = await runCli(["task", "add", "--help"]);

      expect(out.join("")).toContain("--jira");
    });

    it("prints help on stderr with exit 1 for a bare invocation", async () => {
      const { code, out, err } = await runCli([]);

      expect(code).toBe(1);
      expect(err[0]).toBe("Compare coding models on your tasks");
      expect(err.slice(1, 4)).toEqual(["Usage:", "  tevu [options]", "  tevu <command> [options]"]);
      expect(err.join("")).toContain("Examples:");
      expect(err.join("")).not.toMatch(/OpenCode|Sensitive data:|Isolation boundary:/i);
      expect(out).toEqual([]);
    });

    it("prints task help on stderr with exit 1 for a bare task command", async () => {
      const { code, out, err } = await runCli(["task"]);

      expect(code).toBe(1);
      expect(err[0]).toBe("Manage benchmark tasks");
      expect(err.slice(1, 4)).toEqual(["Usage:", "  tevu task [options]", "  tevu task <command> [options]"]);
      expect(out).toEqual([]);
    });
  });

  describe("usage errors", () => {
    it.each(USAGE_ERROR_CASES)(
      "$error maps to exit 1 with the usage line on stderr",
      async ({ argv, error, usage }) => {
        const { code, out, err } = await runCli(argv);

        expect(code).toBe(1);
        expect(err[0]).toBe(error);
        expect(err[1]).toBe(usage);
        expect(out).toEqual([]);
      },
    );
  });

  describe("non-interactive rejection", () => {
    it("rejects task add before any configuration read when the streams are not TTYs", async () => {
      const operations = createOperations();
      const { code, err } = await runCli(["task", "add"], {
        io: createIo(),
        operations,
      });

      expect(code).toBe(1);
      expect(err[0]).toBe(
        'error: prerequisite "terminal" is not satisfied; expected an interactive TTY on stdin and stdout, actual stdin and stdout are not a TTY',
      );
      expect(operations.configExists).not.toHaveBeenCalled();
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it.each(TTY_REJECTION_CASES)(
      "names the failing streams ($actual) when prompting is not possible",
      async ({ stdin, stdout, actual }) => {
        const { code, err } = await runCli(["task", "add"], { io: createIo({ stdin, stdout }) });

        expect(code).toBe(1);
        expect(err[0]).toBe(
          `error: prerequisite "terminal" is not satisfied; expected an interactive TTY on stdin and stdout, actual ${actual}`,
        );
      },
    );

    it("rejects assess after the configuration read but before any context read or write", async () => {
      const operations = createOperations();
      const { code, err } = await runCli(["assess", "run-1", "case-1"], {
        io: createIo(),
        operations,
      });

      expect(code).toBe(1);
      expect(err[0]).toContain('prerequisite "terminal" is not satisfied');
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith("tevu.yaml");
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });
  });

  describe("validate", () => {
    it("prints every finding and the valid verdict with exit 0", async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({ findings: [buildFinding()] }),
        })),
      });

      const { code, out, err } = await runCli(["validate"], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(["warning task-1: description is thin", "Configuration is valid."]);
      expect(err).toEqual([]);
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith("tevu.yaml");
      expect(vi.mocked(operations.validateConfig)).toHaveBeenCalledExactlyOnceWith(
        buildTevuConfig(),
      );
    });

    it("prints the invalid verdict with exit 1 and plans nothing", async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({
            valid: false,
            findings: [
              buildFinding({ severity: "error", identifier: "opencode", message: "missing" }),
            ],
            capabilities: null,
          }),
        })),
      });

      const { code, out } = await runCli(["validate"], { operations });

      expect(code).toBe(1);
      expect(out).toEqual(["error opencode: missing", "Configuration is invalid."]);
      expect(operations.planBenchmark).not.toHaveBeenCalled();
    });

    it("maps a configuration load failure to exit 1 and skips validation", async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: artifactError("read-configuration", "tevu.yaml is missing"),
        })),
      });

      const { code, err } = await runCli(["validate"], { operations });

      expect(code).toBe(1);
      expect(err[0]).toBe(
        'error: artifact operation "read-configuration" failed: tevu.yaml is missing',
      );
      expect(operations.validateConfig).not.toHaveBeenCalled();
    });

    it("maps a validation prerequisite failure to exit 1", async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: false as const,
          error: prerequisiteError("git", "a git executable"),
        })),
      });

      const { code, err } = await runCli(["validate"], { operations });

      expect(code).toBe(1);
      expect(err[0]).toBe(
        'error: prerequisite "git" is not satisfied; expected a git executable',
      );
    });

    it.each(CONFIG_HONORING_CASES)("reads $command with the --config path", async ({ command }) => {
      const operations = createOperations();

      const { code } = await runCli([...command, "--config", "custom.yaml"], { operations });

      expect(code).toBe(0);
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith("custom.yaml");
    });
  });

  describe("run dry-run", () => {
    it("prints the plan, limits, destination, and capability report with exit 0", async () => {
      const { code, out, err } = await runCli(["run", "--dry-run"]);

      expect(code).toBe(0);
      expect(out).toEqual([
        "Dry run: no artifact, workspace, Jira call, or OpenCode model session is created.",
        "Planned cases (2, execution order):",
        "  case-c1-task-1: task task-1, contender c1, model provider/model-a, variant high, commit abc123def",
        "  case-c2-task-1: task task-1, contender c2, model provider/model-b, variant low, commit abc123def",
        "Limits: concurrency 2, case timeout 600000ms, termination grace 5000ms",
        "Artifact destination: /tmp/artifacts",
        "OpenCode capabilities (opencode, detected version: 1.18.32):",
        "  run command: available",
        "  export command: available",
        "  run --format json: available",
        "  run --model: available",
        "  run --variant: available",
        "  isolation deny-outside-worktree (optional): available",
      ]);
      expect(err).toEqual([]);
    });

    it("calls exactly loadConfig, validateConfig, and planBenchmark and nothing else", async () => {
      const operations = createOperations();

      const { code } = await runCli(["run", "--dry-run"], { operations });

      expect(code).toBe(0);
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith("tevu.yaml");
      expect(vi.mocked(operations.validateConfig)).toHaveBeenCalledExactlyOnceWith(
        buildTevuConfig(),
      );
      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildTevuConfig(),
      );
      expect(operations.configExists).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
    });

    it("prints the not-probed fallback when capabilities are absent", async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({ capabilities: null }),
        })),
      });

      const { out } = await runCli(["run", "--dry-run"], { operations });

      expect(out).toContain("OpenCode capabilities: not probed");
    });

    it("prints findings and stops before planning when validation fails", async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({
            valid: false,
            findings: [
              buildFinding({ severity: "error", identifier: "opencode", message: "unavailable" }),
            ],
          }),
        })),
      });

      const { code, out } = await runCli(["run"], { operations });

      expect(code).toBe(1);
      expect(out).toEqual(["error opencode: unavailable", "Configuration is invalid."]);
      expect(operations.planBenchmark).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });
  });

  describe("run execution", () => {
    it("prints deterministic run metadata in planned order and returns the run exit code", async () => {
      let loadedConfig: TevuConfig | undefined;
      const operations = createOperations({
        loadConfig: vi.fn(async () => {
          const config = buildTevuConfig();
          loadedConfig = config;
          return { ok: true as const, value: config };
        }),
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          hooks.onRunId?.("run-1");
          return {
            ok: true as const,
            value: buildRunResult({
              findings: [
                buildRunFinding({ severity: "warning", caseId: "case-c1-task-1" }),
                buildRunFinding({ severity: "error", caseId: null, message: "cleanup warning" }),
              ],
            }),
          };
        }),
      });

      const { code, out, err } = await runCli(["run"], { operations });

      expect(code).toBe(0);
      expect(out).toEqual([
        "Run run-1 started.",
        "case-c1-task-1: lifecycle completed, outcome passed",
        "warning [case-c1-task-1]: diagnostics truncated",
        "error: cleanup warning",
        "Artifacts: /tmp/artifacts/run-1",
        "Report: /tmp/artifacts/run-1/report.md",
      ]);
      expect(err).toEqual([]);
      expect(vi.mocked(operations.rebuildRunReport)).toHaveBeenCalledExactlyOnceWith(
        loadedConfig,
        "run-1",
      );
    });

    it("wires the shared cancellation and run-id hook and withholds lifecycle progress on non-TTY output", async () => {
      let captured: BenchmarkExecutionHooks | undefined;
      const cancellation = new AbortController().signal;
      const operations = createOperations({
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          captured = hooks;
          return { ok: true as const, value: buildRunResult() };
        }),
      });

      const { code, out } = await runCli(["run"], { io: createIo(), operations, cancellation });

      expect(code).toBe(0);
      expect(captured?.cancellation).toBe(cancellation);
      expect(captured?.onRunId).toBeTypeOf("function");
      expect(captured?.onLifecycle).toBeUndefined();
      expect(out.join("")).not.toContain("[case-");
    });

    it("emits case-prefixed lifecycle progress on a TTY stdout", async () => {
      const operations = createOperations({
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          hooks.onRunId?.("run-1");
          hooks.onLifecycle?.("case-c1-task-1", "running");
          hooks.onLifecycle?.("case-c1-task-1", "completed");
          return { ok: true as const, value: buildRunResult() };
        }),
      });

      const { code, out } = await runCli(["run"], {
        io: createIo({ stdin: true, stdout: true }),
        operations,
      });

      expect(code).toBe(0);
      expect(out).toContain("[case-c1-task-1] running");
      expect(out).toContain("[case-c1-task-1] completed");
      expect(out).toContain("case-c1-task-1: lifecycle completed, outcome passed");
    });

    it("preserves exit code 2 for a passed run with a recorded runtime failure", async () => {
      const operations = createOperations({
        executeBenchmark: vi.fn(async () => ({
          ok: true as const,
          value: buildRunResult({
            exitCode: 2,
            cases: [
              buildCaseResult({
                lifecycle: "process-failed",
                outcome: "passed",
                failure: {
                  error: {
                    kind: "OpenCodeProcessError",
                    caseId: "case-c1-task-1",
                    exitCode: 1,
                    signal: null,
                  },
                  occurredAt: "2026-09-23T10:02:00.000Z",
                },
              }),
            ],
          }),
        })),
      });

      const { code, out } = await runCli(["run"], { operations });

      expect(code).toBe(2);
      expect(out).toContain(
        "case-c1-task-1: lifecycle process-failed, outcome passed, runtime failure OpenCodeProcessError",
      );
      expect(out).toContain("Report: /tmp/artifacts/run-1/report.md");
      expect(operations.rebuildRunReport).toHaveBeenCalledOnce();
    });

    it("skips the report rebuild and names the recovery command for a cancelled run", async () => {
      const operations = createOperations({
        executeBenchmark: vi.fn(async () => ({
          ok: true as const,
          value: buildRunResult({ exitCode: 130 }),
        })),
      });

      const { code, out } = await runCli(["run"], { operations });

      expect(code).toBe(130);
      expect(out).toContain(
        "Run cancelled; partial artifacts were finalized. Regenerate the report with: tevu report run-1",
      );
      expect(operations.rebuildRunReport).not.toHaveBeenCalled();
    });

    it("downgrades to exit 1 with the recovery hint when the rebuild fails", async () => {
      const operations = createOperations({
        rebuildRunReport: vi.fn(async () => ({
          ok: false as const,
          error: artifactError("rebuild-report", "run directory vanished"),
        })),
      });

      const { code, out, err } = await runCli(["run"], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: artifact operation "rebuild-report" failed: run directory vanished',
        "The report could not be generated; recover with: tevu report run-1",
      ]);
      expect(out.join("")).not.toContain("Report:");
    });

    it.each(EXECUTE_FAILURE_CASES)(
      "maps the $name failure of executeBenchmark to exit $code without a rebuild",
      async ({ error, code, stderr }) => {
        const operations = createOperations({
          executeBenchmark: vi.fn(async () => ({ ok: false as const, error })),
        });

        const { code: exitCode, err } = await runCli(["run"], { operations });

        expect(exitCode).toBe(code);
        expect(err[0]).toBe(stderr);
        expect(operations.rebuildRunReport).not.toHaveBeenCalled();
      },
    );
  });

  describe("task add", () => {
    it("rejects --jira before any question when the configuration has no Jira settings", async () => {
      const operations = createOperations();

      const { code, err } = await runCli(["task", "add", "--jira", "TEVU-42"], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        "error: the configuration is invalid",
        "  error jira: task add --jira requires Jira settings in the existing configuration",
      ]);
      expect(clack.state.prompts).toEqual([]);
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it("bootstraps the configuration before the first task question and cancels without a write", async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        "/tmp/bench-artifacts",
        "4",
        "600000",
        "5000",
        "opencode",
        false,
        false,
        false,
        "alpha",
        "../repos/alpha",
        false,
        "c1",
        "provider/model-a",
        "high",
        "c2",
        "provider/model-b",
        "low",
        false,
        clack.CANCEL,
      );

      const { code, err } = await runCli(["task", "add"], { operations });

      expect(code).toBe(130);
      expect(err[0]).toBe("Cancelled.");
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
        "tevu task add",
        ...BOOTSTRAP_PROMPTS,
        "Task source",
      ]);
      expect(vi.mocked(operations.configExists)).toHaveBeenCalledExactlyOnceWith("tevu.yaml");
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.createTask).not.toHaveBeenCalled();
      expect(clack.state.logs).toContainEqual({
        kind: "warn",
        message: "Task creation cancelled; the configuration is unchanged.",
      });
    });

    it("bootstraps the complete configuration, re-prompts invalid integers, and lets createTask perform the only write", async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        "/tmp/bench-artifacts",
        { invalid: "abc" },
        "4",
        "600000",
        "5000",
        "opencode",
        false,
        false,
        false,
        "alpha",
        "../repos/alpha",
        false,
        "c1",
        "provider/model-a",
        "high",
        "c2",
        "provider/model-b",
        "low",
        false,
        ...taskInterviewAnswers("alpha"),
        true,
      );

      const { code, out } = await runCli(["task", "add"], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Task "task-2" added to tevu.yaml.']);
      expect(clack.state.rejections).toEqual([
        {
          kind: "text",
          message: "Execution concurrency (1-32)",
          reason: "enter an integer from 1 through 32",
        },
      ]);
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(vi.mocked(operations.createTask)).toHaveBeenCalledOnce();
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]).toEqual({
        configPath: "tevu.yaml",
        bootstrap: {
          artifacts: { directory: "/tmp/bench-artifacts" },
          execution: {
            concurrency: 4,
            caseTimeoutMs: 600000,
            terminationGraceMs: 5000,
            opencodeEnvironment: [],
            evaluatorEnvironment: [],
          },
          opencode: { executable: "opencode" },
          repositories: [{ id: "alpha", path: "../repos/alpha" }],
          contenders: [
            { id: "c1", model: "provider/model-a", variant: "high" },
            { id: "c2", model: "provider/model-b", variant: "low" },
          ],
        },
        repositoryId: "alpha",
        taskId: "task-2",
        startCommit: "abc123",
        source: { kind: "manual", title: "Add an export button" },
        description: "Export the current view as CSV.",
        prompt: "Implement CSV export for the current view.",
        definitionOfReady: [
          { id: "ready-1", description: "Repository is readable", confirmed: true },
        ],
        acceptanceCriteria: [
          {
            id: "acc-1",
            description: "Export produces a CSV",
            required: true,
            evaluator: { kind: "manual" },
          },
        ],
        definitionOfDone: [
          {
            id: "dod-1",
            description: "README documents the button",
            required: true,
            evaluator: { kind: "manual" },
          },
        ],
      });
    });

    it("captures a task against an existing configuration and lets createTask perform the only write", async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers("repo-1"), true);

      const { code, out } = await runCli(["task", "add"], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Task "task-2" added to tevu.yaml.']);
      expect(vi.mocked(operations.configExists)).toHaveBeenCalledExactlyOnceWith("tevu.yaml");
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledOnce();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(vi.mocked(operations.createTask)).toHaveBeenCalledOnce();
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]).toEqual({
        configPath: "tevu.yaml",
        repositoryId: "repo-1",
        taskId: "task-2",
        startCommit: "abc123",
        source: { kind: "manual", title: "Add an export button" },
        description: "Export the current view as CSV.",
        prompt: "Implement CSV export for the current view.",
        definitionOfReady: [
          { id: "ready-1", description: "Repository is readable", confirmed: true },
        ],
        acceptanceCriteria: [
          {
            id: "acc-1",
            description: "Export produces a CSV",
            required: true,
            evaluator: { kind: "manual" },
          },
        ],
        definitionOfDone: [
          {
            id: "dod-1",
            description: "README documents the button",
            required: true,
            evaluator: { kind: "manual" },
          },
        ],
      });
    });

    it("imports a Jira issue exactly once and travels the snapshot inside the wizard input", async () => {
      const jiraSettings = buildJiraCloudSettings();
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildTevuConfig({ jira: jiraSettings }),
        })),
      });
      scriptAnswers(
        "repo-1",
        "abc123",
        "task-2",
        "Export the current view as CSV.",
        "Implement CSV export for the current view.",
        "ready-1",
        "Repository is readable",
        true,
        false,
        "acc-1",
        "Export produces a CSV",
        true,
        "manual",
        false,
        "dod-1",
        "README documents the button",
        true,
        "manual",
        false,
        true,
      );

      const { code, out } = await runCli(["task", "add", "--jira", "TEVU-42"], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Task "task-2" added to tevu.yaml.']);
      expect(vi.mocked(operations.importJiraIssue)).toHaveBeenCalledExactlyOnceWith(
        jiraSettings,
        "TEVU-42",
      );
      expect(clack.state.notes).toContainEqual({
        title: "Imported TEVU-42 (one-time snapshot)",
        message: "Add an export button\n\nUsers cannot export the current view.",
      });
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.source).toEqual({
        kind: "jira-cloud",
        issueKey: "TEVU-42",
        snapshot: {
          issueKey: "TEVU-42",
          issueUrl: "https://jira.example.com/browse/TEVU-42",
          summary: "Add an export button",
          description: "Users cannot export the current view.",
          importedAt: "2026-09-23T10:00:00.000Z",
        },
      });
    });

    it("cancels at the review confirmation without calling createTask", async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers("repo-1"), false);

      const { code, err } = await runCli(["task", "add"], { operations });

      expect(code).toBe(130);
      expect(err[0]).toBe("Cancelled.");
      expect(operations.createTask).not.toHaveBeenCalled();
      expect(clack.state.logs).toContainEqual({
        kind: "warn",
        message: "Task creation cancelled; the configuration is unchanged.",
      });
    });

    it("maps a configuration parse failure to exit 1 before any question", async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configParseError([
            buildFinding({
              severity: "error",
              identifier: "version",
              message: "unsupported version",
            }),
          ]),
        })),
      });

      const { code, err } = await runCli(["task", "add"], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        "error: the configuration could not be parsed",
        "  error version: unsupported version",
      ]);
      expect(clack.state.prompts).toEqual([]);
      expectNoWrites(operations);
    });
  });

  describe("assess", () => {
    it("collects verdicts for every manual check in configuration order and splices the cancellation signal", async () => {
      const cancellation = new AbortController().signal;
      let loadedConfig: TevuConfig | undefined;
      const operations = createOperations({
        loadConfig: vi.fn(async () => {
          const config = buildTevuConfig();
          loadedConfig = config;
          return { ok: true as const, value: config };
        }),
        readAssessmentContext: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessmentContext({
            manualChecks: [
              buildManualCheckSummary({ checkId: "acc-1", category: "acceptance", required: true }),
              buildManualCheckSummary({
                checkId: "dod-1",
                category: "definition-of-done",
                required: false,
              }),
            ],
          }),
        })),
      });
      scriptAnswers("alice", "passed", "", "failed", "loader missing");

      const { code, out } = await runCli(["assess", "run-1", "case-1"], {
        operations,
        cancellation,
      });

      expect(code).toBe(0);
      expect(out).toEqual([
        "Assessment recorded for case case-1; derived task outcome: passed.",
        "Report: /tmp/artifacts/run-1/report.md",
      ]);
      expect(vi.mocked(operations.readAssessmentContext)).toHaveBeenCalledExactlyOnceWith(
        loadedConfig,
        "run-1",
        "case-1",
      );
      expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]).toEqual({
        runId: "run-1",
        caseId: "case-1",
        decisions: [
          {
            checkId: "acc-1",
            verdict: "passed",
            assessor: "alice",
            note: "",
            replaceExisting: false,
          },
          {
            checkId: "dod-1",
            verdict: "failed",
            assessor: "alice",
            note: "loader missing",
            replaceExisting: false,
          },
        ],
        assessedAt: "2026-09-23T10:00:00.000Z",
        cancellation,
      });
    });

    it("requires individual confirmation to replace a committed assessment", async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessmentContext({ existing: [buildAssessmentRecord()] }),
        })),
      });
      scriptAnswers("alice", true, "failed", "regressed", true);

      const { code } = await runCli(["assess", "run-1", "case-1"], { operations });

      expect(code).toBe(0);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual(
        expect.arrayContaining([
          'Replace the existing assessment for "acc-1"?',
          'Confirm replacing "acc-1" (passed -> failed)?',
        ]),
      );
      expect(clack.state.notes).toContainEqual({
        title: "Existing assessments",
        message: "acc-1: passed by bob at 2026-09-22T09:00:00.000Z",
      });
      expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([
        {
          checkId: "acc-1",
          verdict: "failed",
          assessor: "alice",
          note: "regressed",
          replaceExisting: true,
        },
      ]);
    });

    it("skips a check without verdict prompts when replacement is declined", async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessmentContext({ existing: [buildAssessmentRecord()] }),
        })),
      });
      scriptAnswers("alice", false);

      const { code } = await runCli(["assess", "run-1", "case-1"], { operations });

      expect(code).toBe(0);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
        "tevu assess run-1 case-1",
        "Assessor name",
        'Replace the existing assessment for "acc-1"?',
      ]);
      expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([]);
    });

    it("keeps the existing assessment when the replacement confirmation is declined", async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessmentContext({ existing: [buildAssessmentRecord()] }),
        })),
      });
      scriptAnswers("alice", true, "passed", "", false);

      const { code } = await runCli(["assess", "run-1", "case-1"], { operations });

      expect(code).toBe(0);
      expect(clack.state.logs).toContainEqual({
        kind: "info",
        message: 'Kept the existing assessment for "acc-1".',
      });
      expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([]);
    });

    it("maps a wizard cancellation to exit 130 without recording anything", async () => {
      const operations = createOperations();
      scriptAnswers(clack.CANCEL);

      const { code, err } = await runCli(["assess", "run-1", "case-1"], { operations });

      expect(code).toBe(130);
      expect(err[0]).toBe("Cancelled.");
      expect(operations.applyAssessment).not.toHaveBeenCalled();
      expect(clack.state.logs).toContainEqual({
        kind: "warn",
        message: "Assessment cancelled; nothing was recorded.",
      });
    });

    it("rejects a case with no manual checks as a configuration validation error", async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessmentContext({ manualChecks: [] }),
        })),
      });

      const { code, err } = await runCli(["assess", "run-1", "case-1"], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        "error: the configuration is invalid",
        '  error case-1: case "case-1" has no manual checks; there is nothing to assess',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expectNoWrites(operations);
    });

    it("maps a context read failure to exit 1 before any write", async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: false as const,
          error: artifactError("read-assessment-context", "run directory is missing"),
        })),
      });

      const { code, err } = await runCli(["assess", "run-1", "case-1"], { operations });

      expect(code).toBe(1);
      expect(err[0]).toBe(
        'error: artifact operation "read-assessment-context" failed: run directory is missing',
      );
      expectNoWrites(operations);
    });

    it.each(APPLY_FAILURE_CASES)(
      "maps the $name failure of applyAssessment to exit $code",
      async ({ error, code, stderr }) => {
        const operations = createOperations({
          applyAssessment: vi.fn(async () => ({ ok: false as const, error })),
        });
        scriptAnswers("alice", "passed", "");

        const { code: exitCode, err } = await runCli(["assess", "run-1", "case-1"], {
          operations,
        });

        expect(exitCode).toBe(code);
        expect(err[0]).toBe(stderr);
      },
    );
  });

  describe("report", () => {
    it("regenerates the report from loadConfig and rebuildRunReport only", async () => {
      let loadedConfig: TevuConfig | undefined;
      const operations = createOperations({
        loadConfig: vi.fn(async () => {
          const config = buildTevuConfig();
          loadedConfig = config;
          return { ok: true as const, value: config };
        }),
      });

      const { code, out, err } = await runCli(["report", "run-1"], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(["Report regenerated: /tmp/artifacts/run-1/report.md"]);
      expect(err).toEqual([]);
      expect(vi.mocked(operations.rebuildRunReport)).toHaveBeenCalledExactlyOnceWith(
        loadedConfig,
        "run-1",
      );
      expect(operations.validateConfig).not.toHaveBeenCalled();
      expect(operations.planBenchmark).not.toHaveBeenCalled();
      expect(operations.executeBenchmark).not.toHaveBeenCalled();
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
      expect(operations.applyAssessment).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.createTask).not.toHaveBeenCalled();
    });

    it("maps a rebuild failure to exit 1", async () => {
      const operations = createOperations({
        rebuildRunReport: vi.fn(async () => ({
          ok: false as const,
          error: artifactError("rebuild-report", "missing result.json"),
        })),
      });

      const { code, out, err } = await runCli(["report", "run-1"], { operations });

      expect(code).toBe(1);
      expect(err[0]).toBe('error: artifact operation "rebuild-report" failed: missing result.json');
      expect(out).toEqual([]);
    });

    it("maps a configuration load failure to exit 1", async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: artifactError("read-configuration", "tevu.yaml is missing"),
        })),
      });

      const { code, err } = await runCli(["report", "run-1"], { operations });

      expect(code).toBe(1);
      expect(err[0]).toBe(
        'error: artifact operation "read-configuration" failed: tevu.yaml is missing',
      );
      expect(operations.rebuildRunReport).not.toHaveBeenCalled();
    });
  });

  describe("redaction", () => {
    it("scrubs secrets from stderr failure output", async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: artifactError("read-configuration", "the token hunter2 expired"),
        })),
      });

      const { code, err } = await runCli(["validate"], {
        operations,
        redact: (text) => text.replaceAll("hunter2", "[redacted]"),
      });

      expect(code).toBe(1);
      expect(err[0]).toBe(
        'error: artifact operation "read-configuration" failed: the token [redacted] expired',
      );
      expect(err.join("")).not.toContain("hunter2");
    });

    it("scrubs secrets from stdout success output", async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildTevuConfig({ artifacts: { directory: "/tmp/hunter2" } }),
        })),
      });

      const { out } = await runCli(["report", "run-1"], {
        operations,
        redact: (text) => text.replaceAll("hunter2", "[redacted]"),
      });

      expect(out).toEqual(["Report regenerated: /tmp/[redacted]/run-1/report.md"]);
      expect(out.join("")).not.toContain("hunter2");
    });
  });
});
