/**
 * Stable `tevu` command surface over Commander: command and option
 * registration, TTY wizard routing, deterministic non-interactive output,
 * concise usage errors, command examples, and the exit-code
 * mapping. Every side effect enters through the injected operations, so this
 * module owns no evaluation, orchestration, transport, process supervision,
 * or storage logic and imports no concrete adapter.
 */

import { Command, CommanderError, Option } from "commander";

import { agentNamesInUse } from "../config/schema.ts";
import { CONFIG_TEMPLATE } from "../config/template.ts";
import { runAssessmentWizard, runTaskWizard } from "./task-wizard.ts";

import type { Readable, Writable } from "node:stream";
import type { Help } from "commander";
import type { AssessmentCaseContext } from "../application/assess.ts";
import type { TaskWizardInput } from "../application/create-task.ts";
import type { JiraTrackerSettings, TaskDefinition, TevuConfig } from "../config/schema.ts";
import type {
  AgentCapabilityReport,
  AssessmentInput,
  BenchmarkPlan,
  CaseLifecycle,
  CaseResult,
  IssueSnapshot,
  LoadConfigErrorKind,
  ReportResult,
  RunResult,
  TevuError,
  TevuResult,
  ValidationFinding,
  ValidationReport,
} from "../domain/types.ts";

/** Standard streams the program reads and writes; wizards additionally require TTY stdin and stdout. */
export type ProgramIo = {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable & { isTTY?: boolean };
};

/** Cancellation and observation hooks the run command hands to one benchmark execution. */
export type BenchmarkExecutionHooks = {
  cancellation: AbortSignal;
  onRunId?: (runId: string) => void;
  onLifecycle?: (caseId: string, lifecycle: CaseLifecycle) => void;
};

/**
 * Every effectful operation the command handlers route to. The composition
 * root binds these to the real application use cases and adapters; product
 * tests bind fakes at the same boundary.
 */
export type ProgramOperations = {
  configExists(configPath: string): Promise<boolean>;
  loadConfig(configPath: string): Promise<TevuResult<TevuConfig, LoadConfigErrorKind>>;
  requireConfigDirectory(configPath: string): Promise<TevuResult<void, "PrerequisiteError">>;
  importJiraIssue(
    settings: JiraTrackerSettings,
    issueKey: string,
  ): Promise<TevuResult<IssueSnapshot, "IssueImportError" | "CancellationError">>;
  importGitHubIssue(
    reference: string,
  ): Promise<TevuResult<IssueSnapshot, "IssueImportError" | "CancellationError">>;
  createTask(
    input: TaskWizardInput,
  ): Promise<
    TevuResult<
      TaskDefinition,
      | "ConfigParseError"
      | "ConfigValidationError"
      | "ConfigReadError"
      | "SourceMaterializationError"
      | "IssueImportError"
      | "ArtifactError"
      | "CancellationError"
    >
  >;
  validateConfig(
    config: TevuConfig,
  ): Promise<
    TevuResult<
      ValidationReport,
      | "ConfigValidationError"
      | "PrerequisiteError"
      | "SourceMaterializationError"
      | "IsolationError"
      | "AgentProtocolError"
    >
  >;
  planBenchmark(config: TevuConfig): BenchmarkPlan;
  executeBenchmark(
    plan: BenchmarkPlan,
    hooks: BenchmarkExecutionHooks,
  ): Promise<
    TevuResult<
      RunResult,
      | "PrerequisiteError"
      | "SourceMaterializationError"
      | "IsolationError"
      | "AgentProcessError"
      | "AgentProtocolError"
      | "CaseTimeoutError"
      | "EvaluationError"
      | "ArtifactError"
      | "CancellationError"
    >
  >;
  rebuildRunReport(
    config: TevuConfig,
    runId: string,
  ): Promise<TevuResult<ReportResult, "AgentProtocolError" | "ArtifactError">>;
  readAssessmentContext(
    config: TevuConfig,
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AssessmentCaseContext, "ConfigValidationError" | "ArtifactError">>;
  applyAssessment(
    config: TevuConfig,
    input: AssessmentInput,
  ): Promise<
    TevuResult<
      CaseResult,
      "ConfigValidationError" | "AssessmentConflictError" | "ArtifactError" | "CancellationError"
    >
  >;
};

/** Everything the program factory needs; injected by the composition root. */
export type ProgramDependencies = {
  io: ProgramIo;
  operations: ProgramOperations;
  now(): Date;
  redact(text: string): string;
  cancellation: AbortSignal;
};

type ConfigOptionValues = { config: string };
type TaskAddOptionValues = ConfigOptionValues & { jira?: string; github?: string };
type RunOptionValues = ConfigOptionValues & { dryRun?: boolean };

type ExitBox = { code: number };

type LineWriter = (line: string) => void;

const DEFAULT_CONFIG_PATH = "tevu.yaml";

const EXIT_COMPLETED = 0;
const EXIT_FAILURE = 1;
const EXIT_CANCELLED = 130;

const HELP_EXAMPLES: Record<string, [string, string][]> = {
  tevu: [
    ["Define a benchmark task", "tevu task add"],
    ["Preview a benchmark", "tevu run --dry-run"],
    ["Run a benchmark", "tevu run"],
  ],
  config: [["Start a configuration file from the template", "tevu config example > tevu.yaml"]],
  example: [
    ["Print the configuration template", "tevu config example"],
    ["Start a configuration file from the template", "tevu config example > tevu.yaml"],
  ],
  task: [["Define a benchmark task", "tevu task add"]],
  add: [
    ["Define a task interactively", "tevu task add"],
    ["Import a task from Jira", "tevu task add --jira PROJ-123"],
    ["Import a task from GitHub", "tevu task add --github OWNER/REPO#123"],
  ],
  validate: [
    ["Check the default configuration", "tevu validate"],
    ["Check a specific configuration", "tevu validate --config benchmarks.yaml"],
  ],
  run: [
    ["Preview the execution plan", "tevu run --dry-run"],
    ["Run the configured benchmark", "tevu run"],
  ],
  assess: [["Assess a case from a saved run", "tevu assess 20260923t120000z-a1b2c3 task--model"]],
  report: [["Regenerate a saved run's report", "tevu report 20260923t120000z-a1b2c3"]],
};

/**
 * Creates the complete `tevu` command tree for help inspection and parsing.
 * Exit codes produced by parsing this instance directly are not captured;
 * use `runProgram` to execute a command line and receive the mapped code.
 */
export function createProgram(dependencies: ProgramDependencies): Command {
  return buildProgram(dependencies, { code: EXIT_COMPLETED });
}

/**
 * Parses and executes one user-supplied argument vector and returns the
 * process exit code: 0 for completion, 1 for invalid usage or a failure that
 * prevented a complete benchmark record, 2 for preserved degraded benchmark
 * evidence, and 130 for user cancellation. Never calls `process.exit`.
 */
export async function runProgram(
  argv: readonly string[],
  dependencies: ProgramDependencies,
): Promise<number> {
  const exit: ExitBox = { code: EXIT_COMPLETED };
  const program = buildProgram(dependencies, exit);
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT_COMPLETED : EXIT_FAILURE;
    }
    throw error;
  }
  return exit.code;
}

function buildProgram(dependencies: ProgramDependencies, exit: ExitBox): Command {
  const program = new Command("tevu");
  program.description("Compare coding models on your tasks");

  const task = program.command("task").description("Manage benchmark tasks");
  task
    .command("add")
    .description("Add a benchmark task")
    .option("--config <path>", "Configuration file path", DEFAULT_CONFIG_PATH)
    .option("--jira <issue-key>", "Import a task from a Jira issue")
    .addOption(new Option("--github <reference>", "Import a task from a GitHub issue").conflicts("jira"))
    .action(async (options: TaskAddOptionValues) => {
      exit.code = await runTaskAdd(dependencies, options);
    });

  program
    .command("validate")
    .description("Check configuration and prerequisites")
    .option("--config <path>", "Configuration file path", DEFAULT_CONFIG_PATH)
    .action(async (options: ConfigOptionValues) => {
      exit.code = await runValidate(dependencies, options);
    });

  program
    .command("run")
    .description("Run the benchmark")
    .option("--config <path>", "Configuration file path", DEFAULT_CONFIG_PATH)
    .option("--dry-run", "Show the execution plan without running tasks")
    .action(async (options: RunOptionValues) => {
      exit.code = await runBenchmarkCommand(dependencies, options);
    });

  program
    .command("assess")
    .description("Record manual check results")
    .argument("<run-id>", "Run to assess")
    .argument("<case-id>", "Case to assess")
    .option("--config <path>", "Configuration file path", DEFAULT_CONFIG_PATH)
    .action(async (runId: string, caseId: string, options: ConfigOptionValues) => {
      exit.code = await runAssess(dependencies, runId, caseId, options);
    });

  program
    .command("report")
    .description("Regenerate a report from a saved run")
    .argument("<run-id>", "Run to report on")
    .option("--config <path>", "Configuration file path", DEFAULT_CONFIG_PATH)
    .action(async (runId: string, options: ConfigOptionValues) => {
      exit.code = await runReport(dependencies, runId, options);
    });

  const config = program.command("config").description("Work with the configuration file");
  config
    .command("example")
    .description("Print a commented configuration template")
    .action(() => {
      exit.code = runConfigExample(dependencies);
    });

  for (const command of walkCommands(program)) {
    configureCommandBoundary(command, dependencies);
  }
  return program;
}

/**
 * Applies the shared stream, error, and help boundary to one command: output
 * through the injected redacting streams, exceptions instead of process
 * exits, a concise error plus the relevant usage line on invalid usage, and
 * command examples appended to its help.
 */
function configureCommandBoundary(command: Command, dependencies: ProgramDependencies): void {
  command.exitOverride();
  command.helpCommand(false);
  command.helpOption("-h, --help", "Show help");
  command.configureHelp({
    subcommandTerm: (subcommand) => subcommand.name(),
    formatHelp: formatCommandHelp,
  });
  command.showHelpAfterError(false);
  command.showSuggestionAfterError(false);
  const examples = HELP_EXAMPLES[command.name()]
    .map(([description, invocation]) => `  # ${description}\n  ${invocation}`)
    .join("\n\n");
  command.addHelpText("after", `\nExamples:\n${examples}`);
  command.configureOutput({
    writeOut: (text) => {
      dependencies.io.stdout.write(dependencies.redact(text));
    },
    writeErr: (text) => {
      dependencies.io.stderr.write(dependencies.redact(text));
    },
    outputError: (text, write) => {
      write(text);
      write(`Usage: ${usageLine(command)}\n`);
    },
  });
}

function* walkCommands(root: Command): Generator<Command> {
  yield root;
  for (const child of root.commands) {
    yield* walkCommands(child);
  }
}

function usageLine(command: Command): string {
  return `${commandPath(command)} ${command.usage()}`;
}

function commandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current !== null) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
}

function formatCommandHelp(command: Command, helper: Help): string {
  const name = commandPath(command);
  const commands = helper.visibleCommands(command);
  const argumentsUsage = command.registeredArguments.map((argument) =>
    argument.required ? `<${argument.name()}>` : `[${argument.name()}]`);
  const usage = commands.length > 0
    ? [`${name} [options]`, `${name} <command> [options]`]
    : [[name, ...argumentsUsage, "[options]"].join(" ")];
  const width = helper.padWidth(command, helper);
  const formatItem = (term: string, description: string): string =>
    helper.formatItem(term, width, description, helper);

  return [
    helper.commandDescription(command),
    "",
    "Usage:",
    ...usage.map((line) => `  ${line}`),
    "",
    ...helper.formatItemList(
      "Arguments:",
      helper.visibleArguments(command).map((argument) =>
        formatItem(helper.argumentTerm(argument), helper.argumentDescription(argument))),
      helper,
    ),
    ...helper.formatItemList(
      "Options:",
      helper.visibleOptions(command).map((option) =>
        formatItem(helper.optionTerm(option), helper.optionDescription(option))),
      helper,
    ),
    ...helper.formatItemList(
      "Commands:",
      commands.map((subcommand) =>
        formatItem(helper.subcommandTerm(subcommand), helper.subcommandDescription(subcommand))),
      helper,
    ),
  ].join("\n");
}

function createLineWriters(dependencies: ProgramDependencies): { out: LineWriter; err: LineWriter } {
  return {
    out: (line) => {
      dependencies.io.stdout.write(`${dependencies.redact(line)}\n`);
    },
    err: (line) => {
      dependencies.io.stderr.write(`${dependencies.redact(line)}\n`);
    },
  };
}

function runConfigExample(dependencies: ProgramDependencies): number {
  dependencies.io.stdout.write(dependencies.redact(CONFIG_TEMPLATE));
  return EXIT_COMPLETED;
}

async function runTaskAdd(
  dependencies: ProgramDependencies,
  options: TaskAddOptionValues,
): Promise<number> {
  const { out, err } = createLineWriters(dependencies);
  const operations = dependencies.operations;
  const wizard = await runTaskWizard(
    { configPath: options.config, jiraIssueKey: options.jira, githubIssueReference: options.github },
    {
      io: { input: dependencies.io.stdin, output: dependencies.io.stdout },
      readConfig: async (): Promise<
        TevuResult<TevuConfig | null, LoadConfigErrorKind | "PrerequisiteError">
      > => {
        const exists = await operations.configExists(options.config);
        if (!exists) {
          const directory = await operations.requireConfigDirectory(options.config);
          if (!directory.ok) {
            return directory;
          }
          return { ok: true, value: null };
        }
        return operations.loadConfig(options.config);
      },
      importJiraIssue: operations.importJiraIssue,
      importGitHubIssue: operations.importGitHubIssue,
      now: dependencies.now,
      redact: dependencies.redact,
    },
  );
  if (!wizard.ok) {
    return reportFailure(err, wizard.error, dependencies.redact);
  }
  const created = await operations.createTask(wizard.value);
  if (!created.ok) {
    return reportFailure(err, created.error, dependencies.redact);
  }
  out(`Task "${created.value.id}" added to ${options.config}.`);
  return EXIT_COMPLETED;
}

async function runValidate(
  dependencies: ProgramDependencies,
  options: ConfigOptionValues,
): Promise<number> {
  const { out, err } = createLineWriters(dependencies);
  const loaded = await dependencies.operations.loadConfig(options.config);
  if (!loaded.ok) {
    return reportFailure(err, loaded.error, dependencies.redact);
  }
  const report = await dependencies.operations.validateConfig(loaded.value);
  if (!report.ok) {
    return reportFailure(err, report.error, dependencies.redact);
  }
  printFindings(out, report.value.findings);
  out(report.value.valid ? "Configuration is valid." : "Configuration is invalid.");
  return report.value.valid ? EXIT_COMPLETED : EXIT_FAILURE;
}

async function runBenchmarkCommand(
  dependencies: ProgramDependencies,
  options: RunOptionValues,
): Promise<number> {
  const { out, err } = createLineWriters(dependencies);
  const operations = dependencies.operations;
  const loaded = await operations.loadConfig(options.config);
  if (!loaded.ok) {
    return reportFailure(err, loaded.error, dependencies.redact);
  }
  const validation = await operations.validateConfig(loaded.value);
  if (!validation.ok) {
    return reportFailure(err, validation.error, dependencies.redact);
  }
  printFindings(out, validation.value.findings);
  if (!validation.value.valid) {
    out("Configuration is invalid.");
    return EXIT_FAILURE;
  }
  const plan = operations.planBenchmark(loaded.value);
  if (options.dryRun === true) {
    printDryRun(out, plan, validation.value.capabilities);
    return EXIT_COMPLETED;
  }

  // Concurrent per-case progress is shown only on a TTY; non-TTY output stays
  // deterministic metadata: run ID, final case summary, findings, and paths.
  const showProgress = dependencies.io.stdout.isTTY === true;
  const executed = await operations.executeBenchmark(plan, {
    cancellation: dependencies.cancellation,
    onRunId: (runId) => {
      out(`Run ${runId} started.`);
    },
    onLifecycle: showProgress
      ? (caseId, lifecycle) => {
          out(`[${caseId}] ${lifecycle}`);
        }
      : undefined,
  });
  if (!executed.ok) {
    return reportFailure(err, executed.error, dependencies.redact);
  }
  const run = executed.value;
  const runId = run.manifest.runId;
  const runDirectory = `${plan.artifactsDirectory}/${runId}`;
  for (const caseResult of run.cases) {
    const failureSuffix =
      caseResult.failure === null ? "" : `, runtime failure ${caseResult.failure.error.kind}`;
    out(
      `${caseResult.identity.caseId}: lifecycle ${caseResult.lifecycle}, outcome ${caseResult.outcome}${failureSuffix}`,
    );
  }
  for (const finding of run.findings) {
    out(`${finding.severity}${finding.caseId === null ? "" : ` [${finding.caseId}]`}: ${finding.message}`);
  }
  out(`Artifacts: ${runDirectory}`);
  if (run.exitCode === EXIT_CANCELLED) {
    out(`Run cancelled; partial artifacts were finalized. Regenerate the report with: tevu report ${runId}`);
    return EXIT_CANCELLED;
  }
  const rebuilt = await operations.rebuildRunReport(loaded.value, runId);
  if (!rebuilt.ok) {
    for (const line of renderTevuError(rebuilt.error, dependencies.redact)) {
      err(line);
    }
    err(`The report could not be generated; recover with: tevu report ${runId}`);
    return EXIT_FAILURE;
  }
  out(`Report: ${runDirectory}/report.md`);
  return run.exitCode;
}

async function runAssess(
  dependencies: ProgramDependencies,
  runId: string,
  caseId: string,
  options: ConfigOptionValues,
): Promise<number> {
  const { out, err } = createLineWriters(dependencies);
  const operations = dependencies.operations;
  const loaded = await operations.loadConfig(options.config);
  if (!loaded.ok) {
    return reportFailure(err, loaded.error, dependencies.redact);
  }
  const config = loaded.value;
  const wizard = await runAssessmentWizard(
    { runId, caseId },
    {
      io: { input: dependencies.io.stdin, output: dependencies.io.stdout },
      readCaseContext: () => operations.readAssessmentContext(config, runId, caseId),
      now: dependencies.now,
      redact: dependencies.redact,
    },
  );
  if (!wizard.ok) {
    return reportFailure(err, wizard.error, dependencies.redact);
  }
  const applied = await operations.applyAssessment(config, {
    ...wizard.value,
    cancellation: dependencies.cancellation,
  });
  if (!applied.ok) {
    return reportFailure(err, applied.error, dependencies.redact);
  }
  out(`Assessment recorded for case ${caseId}; derived task outcome: ${applied.value.outcome}.`);
  out(`Report: ${config.run.output_dir}/${runId}/report.md`);
  return EXIT_COMPLETED;
}

async function runReport(
  dependencies: ProgramDependencies,
  runId: string,
  options: ConfigOptionValues,
): Promise<number> {
  const { out, err } = createLineWriters(dependencies);
  const loaded = await dependencies.operations.loadConfig(options.config);
  if (!loaded.ok) {
    return reportFailure(err, loaded.error, dependencies.redact);
  }
  const rebuilt = await dependencies.operations.rebuildRunReport(loaded.value, runId);
  if (!rebuilt.ok) {
    return reportFailure(err, rebuilt.error, dependencies.redact);
  }
  out(`Report regenerated: ${loaded.value.run.output_dir}/${runId}/report.md`);
  return EXIT_COMPLETED;
}

function printDryRun(
  out: LineWriter,
  plan: BenchmarkPlan,
  capabilities: Readonly<Record<string, AgentCapabilityReport>>,
): void {
  out("Dry run: no artifact, workspace, Jira call, or agent model session is created.");
  out(`Planned cases (${plan.cases.length}, execution order):`);
  for (const identity of plan.cases) {
    out(
      `  ${identity.caseId}: task ${identity.taskId}, model entry ${identity.modelId} (${identity.model}, effort ${identity.effort}), commit ${identity.sourceCommit}`,
    );
  }
  out(
    `Limits: concurrency ${plan.concurrency}, timeout ${plan.caseTimeoutMs}ms, stop grace ${plan.terminationGraceMs}ms`,
  );
  out(`Artifact destination: ${plan.artifactsDirectory}`);
  for (const name of agentNamesInUse(plan.config)) {
    printCapabilities(out, name, capabilities[name] ?? null);
  }
}

function printCapabilities(out: LineWriter, name: string, report: AgentCapabilityReport | null): void {
  if (report === null) {
    out(`Agent "${name}" capabilities: not probed`);
    return;
  }
  out(
    `Agent "${name}" capabilities (${report.executable}, detected version: ${report.detectedVersion ?? "not detected"}):`,
  );
  for (const capability of report.capabilities) {
    out(`  ${capability.name}${capability.required ? "" : " (optional)"}: ${capability.availability}`);
  }
  out(`  isolation deny-outside-worktree (optional): ${report.isolation.denyOutsideWorktree}`);
}

function printFindings(out: LineWriter, findings: readonly ValidationFinding[]): void {
  for (const finding of findings) {
    out(`${finding.severity} ${finding.identifier}: ${finding.message}`);
  }
}

/** Prints one typed failure and returns its mapped exit code. */
function reportFailure(err: LineWriter, error: TevuError, redact: (text: string) => string): number {
  for (const line of renderTevuError(error, redact)) {
    err(line);
  }
  return error.kind === "CancellationError" ? EXIT_CANCELLED : EXIT_FAILURE;
}

function renderTevuError(error: TevuError, redact: (text: string) => string): string[] {
  switch (error.kind) {
    case "ConfigParseError":
      return ["error: the configuration could not be parsed", ...renderFindingLines(error.findings)];
    case "ConfigValidationError":
      return ["error: the configuration is invalid", ...renderFindingLines(error.findings)];
    case "ConfigReadError":
      return renderConfigReadError(error, redact);
    case "PrerequisiteError":
      return [
        `error: prerequisite "${error.tool}" is not satisfied; expected ${error.expected}${error.actual === undefined ? "" : `, actual ${error.actual}`}`,
      ];
    case "SourceMaterializationError":
      return [`error: task "${error.taskId}" source cannot be materialized: ${error.reason}`];
    case "IsolationError":
      return [`error: case "${error.caseId}" isolation failed: ${error.reason}`];
    case "IssueImportError":
      return [
        `error: ${error.tracker === "jira-cloud" ? "Jira" : "GitHub"} issue "${error.reference}" import failed${error.status === undefined ? "" : ` (status ${error.status})`}: ${error.reason}`,
      ];
    case "AgentProcessError":
      return [
        `error: agent "${error.agent}" process for case "${error.caseId}" failed (exit code ${error.exitCode ?? "none"}, signal ${error.signal ?? "none"})`,
      ];
    case "AgentProtocolError":
      return [
        `error: agent "${error.agent}" protocol failure (${error.context.phase === "probe" ? "probe" : `case ${error.context.caseId}`}): ${error.reason}`,
      ];
    case "CaseTimeoutError":
      return [`error: case "${error.caseId}" exceeded its ${error.timeoutMs}ms timeout`];
    case "EvaluationError":
      return [
        `error: check "${error.checkId}" of case "${error.caseId}" could not be evaluated: ${error.reason}`,
      ];
    case "AssessmentConflictError":
      return [
        `error: assessment for run "${error.runId}" case "${error.caseId}" is locked: ${error.reason}`,
      ];
    case "ArtifactError":
      return [`error: artifact operation "${error.operation}" failed: ${error.reason}`];
    case "RedactionError":
      return [`error: redaction failed: ${error.reason}`];
    case "CancellationError":
      return ["Cancelled."];
  }
}

function renderFindingLines(findings: readonly ValidationFinding[]): string[] {
  return findings.map((finding) => `  ${finding.severity} ${finding.identifier}: ${finding.message}`);
}

/** Renders the cause line and, for a missing file, the two redacted, shell-safe creation hints. */
function renderConfigReadError(
  error: Extract<TevuError, { kind: "ConfigReadError" }>,
  redact: (text: string) => string,
): string[] {
  const firstLine = configReadErrorLine(error);
  if (error.cause !== "not-found") {
    return [firstLine];
  }
  const word = shellWord(redact(error.requestedPath));
  const taskAddCommand =
    error.requestedPath === DEFAULT_CONFIG_PATH ? "tevu task add" : `tevu task add --config ${word}`;
  return [
    firstLine,
    `  create one interactively: ${taskAddCommand}`,
    `  or start from the template: tevu config example > ${word}`,
  ];
}

function configReadErrorLine(error: Extract<TevuError, { kind: "ConfigReadError" }>): string {
  switch (error.cause) {
    case "not-found":
      return `error: configuration file not found: ${error.path}`;
    case "permission-denied":
      return `error: cannot read configuration file ${error.path}: permission denied`;
    case "not-a-file":
      return `error: configuration path is not a file: ${error.path}`;
    case "unreadable":
      return `error: cannot read configuration file ${error.path}`;
  }
}

const SHELL_SAFE_WORD_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quotes text for safe pasting into a POSIX shell, per the project's shell-word rule. */
function shellWord(text: string): string {
  if (SHELL_SAFE_WORD_PATTERN.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}
