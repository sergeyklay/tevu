// @vitest-environment node

import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TevuConfigSchema } from '@/config/schema';
import { CONFIG_TEMPLATE } from '@/config/template';

import { createProgram, runProgram } from './program';

import type {
  BenchmarkExecutionHooks,
  ProgramDependencies,
  ProgramIo,
  ProgramOperations,
} from './program';
import type { AssessmentCaseContext, ManualCheckSummary } from '@/application/assess';
import type { CheckInput, ModelDefinitionInput, TaskInput, TevuConfigInput } from '@/config/schema';
import type {
  AgentCapabilityReport,
  AssessmentRecord,
  BenchmarkMetrics,
  BenchmarkPlan,
  CaseIdentity,
  CaseResult,
  ConfigReadCause,
  IssueSnapshot,
  JiraTrackerSettings,
  ReportResult,
  RunFinding,
  RunResult,
  TaskDefinition,
  TevuConfig,
  TevuError,
  ValidationFinding,
  ValidationReport,
} from '@/domain/types';

const clack = vi.hoisted(() => {
  const CANCEL = Symbol('clack-cancel');
  const state = {
    prompts: [] as Array<{ kind: string; message: string }>,
    notes: [] as Array<{ message: string; title: string | undefined }>,
    logs: [] as Array<{ kind: string; message: string }>,
    rejections: [] as Array<{ kind: string; message: string; reason: string }>,
    answers: [] as unknown[],
  };
  return { CANCEL, state };
});

vi.mock('@clack/prompts', () => {
  type AskOptions = {
    message: string;
    validate?: (value: string | undefined) => string | undefined;
  };
  const isInvalidMarker = (value: unknown): value is { invalid: string } =>
    typeof value === 'object' && value !== null && 'invalid' in value;
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
    text: (options: AskOptions) => ask('text', options),
    confirm: (options: { message: string }) => ask('confirm', options),
    select: (options: { message: string }) => ask('select', options),
    multiselect: (options: { message: string }) => ask('multiselect', options),
    intro: (message: string) => {
      clack.state.prompts.push({ kind: 'intro', message });
    },
    note: (message: string, title?: string) => {
      clack.state.notes.push({ message, title });
    },
    log: {
      info: (message: string) => {
        clack.state.logs.push({ kind: 'info', message });
      },
      warn: (message: string) => {
        clack.state.logs.push({ kind: 'warn', message });
      },
      step: (message: string) => {
        clack.state.logs.push({ kind: 'step', message });
      },
    },
    isCancel: (value: unknown) => value === clack.CANCEL,
  };
});

const FIXED_NOW = new Date('2026-09-23T10:00:00.000Z');

function buildJiraTrackerSettings(
  overrides: Partial<JiraTrackerSettings> = {},
): JiraTrackerSettings {
  return {
    url: 'https://jira.example.com',
    email: '$JIRA_EMAIL',
    token: '$JIRA_TOKEN',
    ...overrides,
  };
}

function buildManualCheck(id: string, overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    id,
    description: `${id} check`,
    manual: true,
    ...overrides,
  };
}

function buildTaskDefinition(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    title: 'Fixture task title',
    repo: 'repo-1',
    base_commit: 'abc123',
    description: 'Fixture task description',
    prompt: 'Fixture task prompt',
    readiness: ['Repository is readable'],
    checks: {
      acceptance: [buildManualCheck('acc-1')],
      done: [buildManualCheck('dod-1')],
    },
    ...overrides,
  };
}

function buildModel(overrides: Partial<ModelDefinitionInput> = {}): ModelDefinitionInput {
  return { id: 'c1', model: 'provider/model-a', effort: 'high', ...overrides };
}

const AGENT_NAME = 'fake-agent';

/**
 * Renames the schema-required `opencode` key to `fake-agent` after parsing.
 * The strict schema accepts only the literal `opencode` key (out of scope for
 * this migration), so every agent-neutral test builds through that key and
 * relabels the materialized config instead of parsing `fake-agent` directly.
 */
function rekeyToFakeAgent(config: TevuConfig): TevuConfig {
  const { opencode, ...otherAgents } = config.agents;
  return {
    ...config,
    agents: { ...otherAgents, [AGENT_NAME]: opencode },
    models: config.models.map((model) => ({ ...model, agent: AGENT_NAME })),
  };
}

function buildTevuConfig(overrides: Partial<TevuConfigInput> = {}): TevuConfig {
  const config: TevuConfigInput = {
    version: 1,
    run: { output_dir: '/tmp/artifacts', concurrency: 2, timeout: '10m', stop_grace: '5s' },
    agents: { opencode: { command: 'opencode', secrets: [], env: [] } },
    repositories: [{ id: 'repo-1', path: '../repos/fixture' }],
    models: [buildModel(), buildModel({ id: 'c2', model: 'provider/model-b', effort: 'low' })],
    tasks: [buildTaskDefinition()],
    ...overrides,
  };
  return rekeyToFakeAgent(TevuConfigSchema.parse(config));
}

/** Materializes one task through the schema so every default (required, evaluator, etc.) is resolved. */
function buildMaterializedTask(overrides: Partial<TaskInput> = {}): TaskDefinition {
  const task = buildTevuConfig({ tasks: [buildTaskDefinition(overrides)] }).tasks[0];
  if (task === undefined) {
    throw new Error('expected the fixture configuration to materialize its task');
  }
  return task;
}

function buildFinding(overrides: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    severity: 'warning',
    identifier: 'task-1',
    message: 'description is thin',
    ...overrides,
  };
}

function buildCapabilityReport(
  overrides: Partial<AgentCapabilityReport> = {},
): AgentCapabilityReport {
  return {
    executable: 'opencode',
    detectedVersion: '1.18.32',
    capabilities: [
      { name: 'run command', required: true, availability: 'available' },
      { name: 'export command', required: true, availability: 'available' },
      { name: 'run --format json', required: true, availability: 'available' },
      { name: 'run --model', required: true, availability: 'available' },
      { name: 'run --variant', required: true, availability: 'available' },
    ],
    isolation: { denyOutsideWorktree: 'available' },
    ...overrides,
  };
}

function buildValidationReport(overrides: Partial<ValidationReport> = {}): ValidationReport {
  return {
    valid: true,
    findings: [],
    capabilities: { [AGENT_NAME]: buildCapabilityReport() },
    ...overrides,
  };
}

function buildBenchmarkPlan(
  config: TevuConfig = buildTevuConfig(),
  overrides: Partial<BenchmarkPlan> = {},
): BenchmarkPlan {
  return {
    config,
    configPath: 'tevu.yaml',
    cases: config.models.flatMap((model) =>
      config.tasks.map((task) => ({
        caseId: `case-${model.id}-${task.id}`,
        taskId: task.id,
        modelId: model.id,
        attempt: 1,
        sourceCommit: 'abc123def',
        model: model.model,
        effort: model.effort,
        agent: model.agent,
        timeoutMs: 600_000,
      })),
    ),
    repeat: { value: config.run.repeat, source: 'config' },
    concurrency: config.run.concurrency,
    defaultCaseTimeoutMs: 600_000,
    terminationGraceMs: 5_000,
    artifactsDirectory: config.run.output_dir,
    ...overrides,
  };
}

function buildCaseIdentity(overrides: Partial<CaseIdentity> = {}): CaseIdentity {
  return {
    caseId: 'case-c1-task-1',
    taskId: 'task-1',
    modelId: 'c1',
    attempt: 1,
    sourceCommit: 'abc123def',
    model: 'provider/model-a',
    effort: 'high',
    agent: AGENT_NAME,
    timeoutMs: 600_000,
    ...overrides,
  };
}

function buildMetrics(): BenchmarkMetrics {
  const metric = {
    value: 1,
    unit: 'count' as const,
    availability: { status: 'available' as const, source: 'fixture' },
    scope: 'root-session' as const,
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
    lifecycle: 'completed',
    process: {
      exitCode: 0,
      signal: null,
      startedAt: '2026-09-23T10:00:01.000Z',
      endedAt: '2026-09-23T10:00:05.000Z',
      durationMs: 4000,
      terminationStage: 'graceful',
    },
    outcome: 'passed',
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
    severity: 'warning',
    caseId: 'case-c1-task-1',
    message: 'diagnostics truncated',
    ...overrides,
  };
}

function buildRunResult(overrides: Partial<RunResult> = {}): RunResult {
  const identity = buildCaseIdentity();
  return {
    schemaVersion: 1,
    manifest: {
      schemaVersion: 1,
      runId: 'run-1',
      configDigest: 'fixture-digest',
      configPath: 'tevu.yaml',
      startedAt: '2026-09-23T10:00:00.000Z',
      completedAt: '2026-09-23T10:05:00.000Z',
      host: { platform: 'linux', nodeVersion: '24.10.0' },
      tools: { gitVersion: '2.47.0', agentVersions: { [AGENT_NAME]: '1.18.32' } },
      execution: { concurrency: 2, caseTimeoutMs: 600000, repeat: { value: 1, source: 'config' } },
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
    runId: 'run-1',
    normalizedJson: '{}',
    markdown: '# Report\n',
    ...overrides,
  };
}

function buildJiraIssueSnapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    issueKey: 'TEVU-42',
    issueUrl: 'https://jira.example.com/browse/TEVU-42',
    summary: 'Add an export button',
    description: 'Users cannot export the current view.',
    ...overrides,
  };
}

function buildManualCheckSummary(overrides: Partial<ManualCheckSummary> = {}): ManualCheckSummary {
  return {
    checkId: 'acc-1',
    category: 'acceptance',
    description: 'Export produces a CSV',
    required: true,
    ...overrides,
  };
}

function buildAssessmentRecord(overrides: Partial<AssessmentRecord> = {}): AssessmentRecord {
  return {
    checkId: 'acc-1',
    verdict: 'passed',
    assessor: 'bob',
    note: '',
    assessedAt: '2026-09-22T09:00:00.000Z',
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

function artifactError(
  operation: string,
  reason: string,
): Extract<TevuError, { kind: 'ArtifactError' }> {
  return { kind: 'ArtifactError', operation, reason };
}

function configReadError(
  cause: ConfigReadCause,
  path: string,
  requestedPath: string,
): Extract<TevuError, { kind: 'ConfigReadError' }> {
  return { kind: 'ConfigReadError', path, requestedPath, cause };
}

function configNotFoundError(
  searchedPaths: [string] | [string, string],
): Extract<TevuError, { kind: 'ConfigNotFoundError' }> {
  return { kind: 'ConfigNotFoundError', searchedPaths };
}

function prerequisiteError(
  tool: string,
  expected: string,
): Extract<TevuError, { kind: 'PrerequisiteError' }> {
  return { kind: 'PrerequisiteError', tool, expected };
}

function configParseError(
  findings: ValidationFinding[],
): Extract<TevuError, { kind: 'ConfigParseError' }> {
  return { kind: 'ConfigParseError', findings };
}

function createOperations(overrides: Partial<ProgramOperations> = {}): ProgramOperations {
  const config = buildTevuConfig();
  return {
    configExists: vi.fn(async () => true),
    loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
    requireConfigDirectory: vi.fn(async () => ({ ok: true as const, value: undefined })),
    locateConfig: vi.fn(async () => ({ ok: true as const, value: 'tevu.yaml' })),
    importJiraIssue: vi.fn(async () => ({ ok: true as const, value: buildJiraIssueSnapshot() })),
    importGitHubIssue: vi.fn(async () => ({ ok: true as const, value: buildJiraIssueSnapshot() })),
    createTask: vi.fn(async () => ({
      ok: true as const,
      value: buildMaterializedTask({ id: 'task-2' }),
    })),
    validateConfig: vi.fn(async () => ({ ok: true as const, value: buildValidationReport() })),
    planBenchmark: vi.fn(() => buildBenchmarkPlan(config)),
    executeBenchmark: vi.fn(async () => ({ ok: true as const, value: buildRunResult() })),
    rebuildRunReport: vi.fn(async () => ({ ok: true as const, value: buildReportResult() })),
    readAssessmentContext: vi.fn(async () => ({
      ok: true as const,
      value: buildAssessmentContext(),
    })),
    applyAssessment: vi.fn(async () => ({ ok: true as const, value: buildCaseResult() })),
    ...overrides,
  };
}

class MemoryStream extends Writable {
  readonly chunks: string[] = [];
  isTTY?: boolean;

  _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(String(chunk));
    callback();
  }

  get text(): string {
    return this.chunks.join('');
  }

  get lines(): string[] {
    return this.text.split('\n').filter((line) => line.length > 0);
  }
}

function createIo(ttys: { stdin?: boolean; stdout?: boolean } = {}): ProgramIo {
  const stdin: ProgramIo['stdin'] = new Readable({ read() {} });
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

/**
 * Reads the fenced `yaml` block under the `## Example` heading of the
 * configuration reference, resolved from this test file's own module
 * location rather than the working directory.
 */
async function readConfigurationExampleBlock(): Promise<string> {
  const docsPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../docs/reference/configuration.md',
  );
  const lines = (await fs.readFile(docsPath, 'utf8')).split('\n');
  const headingIndex = lines.indexOf('## Example');
  if (headingIndex === -1) {
    throw new Error('docs/reference/configuration.md is missing the "## Example" heading');
  }
  const sectionEndOffset = lines
    .slice(headingIndex + 1)
    .findIndex((line) => line.startsWith('## '));
  const section = lines.slice(
    headingIndex,
    sectionEndOffset === -1 ? lines.length : headingIndex + 1 + sectionEndOffset,
  );
  const openIndex = section.indexOf('```yaml');
  if (openIndex === -1) {
    throw new Error('the "## Example" section has no fenced yaml block');
  }
  const closeOffset = section.slice(openIndex + 1).indexOf('```');
  if (closeOffset === -1) {
    throw new Error('the fenced yaml block under "## Example" has no closing fence');
  }
  return section
    .slice(openIndex + 1, openIndex + 1 + closeOffset)
    .map((line) => `${line}\n`)
    .join('');
}

function taskInterviewAnswers(repositoryChoice: string): unknown[] {
  return [
    'manual',
    repositoryChoice,
    'abc123',
    'task-2',
    'Add an export button',
    'Export the current view as CSV.',
    'Implement CSV export for the current view.',
    'Repository is readable',
    false,
    'acc-1',
    'Export produces a CSV',
    true,
    'manual',
    false,
    'dod-1',
    'README documents the button',
    true,
    'manual',
    false,
  ];
}

const BOOTSTRAP_PROMPTS = [
  'Run output directory (outside every repository, relative to the configuration file)',
  'Concurrent cases (1-32)',
  'Agent time limit per case (for example 10m)',
  'Grace period before a forced stop (for example 3s)',
  'Default time limit for command checks (for example 5m; empty to set one per check)',
  'Command for agent "opencode" (name on PATH, or a path relative to the configuration file)',
  'Add a secret variable for the agent (name only, never the value)?',
  'Add a ordinary variable for the agent?',
  'Configure Jira Cloud issue import?',
  'Repository ID',
  'Local path of repository "alpha" (relative to the configuration file)',
  'Add another repository?',
  'Model entry ID',
  'Model for "c1" (provider/model)',
  'Reasoning effort for "c1" (passed to the agent verbatim)',
  'Model entry ID',
  'Model for "c2" (provider/model)',
  'Reasoning effort for "c2" (passed to the agent verbatim)',
  'Add another model?',
];

const HELP_CASES: Array<{ argv: string[]; description: string; usage: string }> = [
  {
    argv: [],
    description: 'Compare coding models on your tasks',
    usage: 'Usage:\n  tevu [options]\n  tevu <command> [options]',
  },
  {
    argv: ['config'],
    description: 'Work with the configuration file',
    usage: 'Usage:\n  tevu config [options]\n  tevu config <command> [options]',
  },
  {
    argv: ['config', 'example'],
    description: 'Print a commented configuration template',
    usage: 'Usage:\n  tevu config example [options]',
  },
  {
    argv: ['task'],
    description: 'Manage benchmark tasks',
    usage: 'Usage:\n  tevu task [options]\n  tevu task <command> [options]',
  },
  {
    argv: ['task', 'add'],
    description: 'Add a benchmark task',
    usage: 'Usage:\n  tevu task add [options]',
  },
  {
    argv: ['validate'],
    description: 'Check configuration and prerequisites',
    usage: 'Usage:\n  tevu validate [options]',
  },
  {
    argv: ['run'],
    description: 'Run the benchmark',
    usage: 'Usage:\n  tevu run [options]',
  },
  {
    argv: ['assess'],
    description: 'Record manual check results',
    usage: 'Usage:\n  tevu assess <run-id> <case-id> [options]',
  },
  {
    argv: ['report'],
    description: 'Regenerate a report from a saved run',
    usage: 'Usage:\n  tevu report <run-id> [options]',
  },
];

const USAGE_ERROR_CASES: Array<{ argv: string[]; error: string; usage: string }> = [
  {
    argv: ['frobnicate'],
    error: "error: unknown command 'frobnicate'",
    usage: 'Usage: tevu [options] [command]',
  },
  {
    argv: ['assess'],
    error: "error: missing required argument 'run-id'",
    usage: 'Usage: tevu assess [options] <run-id> <case-id>',
  },
  {
    argv: ['assess', 'run-1'],
    error: "error: missing required argument 'case-id'",
    usage: 'Usage: tevu assess [options] <run-id> <case-id>',
  },
  {
    argv: ['run', '--bogus'],
    error: "error: unknown option '--bogus'",
    usage: 'Usage: tevu run [options]',
  },
  {
    argv: ['--version'],
    error: "error: unknown option '--version'",
    usage: 'Usage: tevu [options] [command]',
  },
  {
    argv: ['config', 'example', 'extra'],
    error: "error: too many arguments for 'example'. Expected 0 arguments but got 1: extra.",
    usage: 'Usage: tevu config example [options]',
  },
  {
    argv: ['config', 'example', '--config', 'x'],
    error: "error: unknown option '--config'",
    usage: 'Usage: tevu config example [options]',
  },
];

const TTY_REJECTION_CASES: Array<{ stdin: boolean; stdout: boolean; actual: string }> = [
  { stdin: false, stdout: false, actual: 'stdin and stdout are not a TTY' },
  { stdin: false, stdout: true, actual: 'stdin is not a TTY' },
  { stdin: true, stdout: false, actual: 'stdout is not a TTY' },
];

const CONFIG_HONORING_CASES: Array<{ command: string[] }> = [
  { command: ['validate'] },
  { command: ['run', '--dry-run'] },
  { command: ['report', 'run-1'] },
];

const EXECUTE_FAILURE_CASES: Array<{
  name: string;
  error: Extract<
    TevuError,
    { kind: 'CancellationError' | 'PrerequisiteError' | 'CheckStateError' }
  >;
  code: number;
  stderr: string;
}> = [
  {
    name: 'cancellation',
    error: { kind: 'CancellationError', activeCaseIds: [] },
    code: 130,
    stderr: 'Cancelled.',
  },
  {
    name: 'prerequisite',
    error: { kind: 'PrerequisiteError', tool: 'fake-agent', expected: 'a fake-agent executable' },
    code: 1,
    stderr: 'error: prerequisite "fake-agent" is not satisfied; expected a fake-agent executable',
  },
  {
    name: 'check-state',
    error: {
      kind: 'CheckStateError',
      step: 'overlay',
      reason: 'overlay directory "/hidden/checks" does not exist',
    },
    code: 1,
    stderr: 'error: check-state overlay failed: overlay directory "/hidden/checks" does not exist',
  },
];

const APPLY_FAILURE_CASES: Array<{
  name: string;
  error: Extract<
    TevuError,
    { kind: 'AssessmentConflictError' | 'ArtifactError' | 'CancellationError' }
  >;
  code: number;
  stderr: string;
}> = [
  {
    name: 'assessment conflict',
    error: {
      kind: 'AssessmentConflictError',
      runId: 'run-1',
      caseId: 'case-1',
      reason: 'another assessor holds the revision lock',
    },
    code: 1,
    stderr:
      'error: assessment for run "run-1" case "case-1" is locked: another assessor holds the revision lock',
  },
  {
    name: 'artifact failure',
    error: { kind: 'ArtifactError', operation: 'write-assessment', reason: 'disk full' },
    code: 1,
    stderr: 'error: artifact operation "write-assessment" failed: disk full',
  },
  {
    name: 'cancellation',
    error: { kind: 'CancellationError', activeCaseIds: [] },
    code: 130,
    stderr: 'Cancelled.',
  },
];

describe('tevu CLI', () => {
  beforeEach(() => {
    clack.state.prompts = [];
    clack.state.notes = [];
    clack.state.logs = [];
    clack.state.rejections = [];
    clack.state.answers = [];
  });

  describe('command surface', () => {
    it('registers exactly the six top-level commands with add as the only task subcommand', () => {
      const program = createProgram(createDependencies());

      expect(program.commands.map((command) => command.name())).toEqual([
        'task',
        'validate',
        'run',
        'assess',
        'report',
        'config',
      ]);
      expect(program.commands[0]?.commands.map((command) => command.name())).toEqual(['add']);
    });

    it('registers --config with no default and the per-command options', () => {
      const program = createProgram(createDependencies());
      const run = program.commands.find((command) => command.name() === 'run');
      const add = program.commands[0]?.commands[0];

      expect(run?.options.map((option) => option.long)).toEqual([
        '--config',
        '--dry-run',
        '--repeat',
      ]);
      expect(run?.options[0]?.defaultValue).toBeUndefined();
      expect(add?.options.map((option) => option.long)).toEqual(['--config', '--jira', '--github']);
    });

    it.each(['task add', 'validate', 'run', 'assess', 'report'])(
      'gives every --config option the search description with no default text (V12, AC-10)',
      (commandName) => {
        const program = createProgram(createDependencies());
        const [group, sub] = commandName.split(' ');
        const command =
          sub === undefined
            ? program.commands.find((entry) => entry.name() === group)
            : program.commands
                .find((entry) => entry.name() === group)
                ?.commands.find((entry) => entry.name() === sub);
        const option = command?.options.find((entry) => entry.long === '--config');

        expect(option?.description).toBe(
          'Configuration file path; without it, tevu searches ./tevu.yaml, then ' +
            '$XDG_CONFIG_HOME/tevu/tevu.yaml (or $HOME/.config/tevu/tevu.yaml when ' +
            'XDG_CONFIG_HOME is not an absolute path)',
        );
        expect(option?.description).not.toContain('(default:');
      },
    );

    it('requires both run-id and case-id arguments on assess', () => {
      const program = createProgram(createDependencies());
      const assess = program.commands.find((command) => command.name() === 'assess');

      expect(assess?.registeredArguments.map((argument) => argument.name())).toEqual([
        'run-id',
        'case-id',
      ]);
      expect(assess?.registeredArguments.every((argument) => argument.required)).toBe(true);
    });

    it('rejects --version as an unknown option', async () => {
      const { code, out, err } = await runCli(['--version']);

      expect(code).toBe(1);
      expect(err[0]).toBe("error: unknown option '--version'");
      expect(out).toEqual([]);
    });
  });

  describe('config example', () => {
    function expectNoOperationCalled(operations: ProgramOperations): void {
      expect(operations.locateConfig).not.toHaveBeenCalled();
      expect(operations.configExists).not.toHaveBeenCalled();
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expect(operations.validateConfig).not.toHaveBeenCalled();
      expect(operations.planBenchmark).not.toHaveBeenCalled();
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
      expectNoWrites(operations);
    }

    it.each([
      { label: 'TTY stdout', stdout: true },
      { label: 'non-TTY stdout', stdout: false },
    ])('prints the template verbatim with exit 0 and no stderr ($label)', async ({ stdout }) => {
      const operations = createOperations();

      const { code, dependencies, err } = await runCli(['config', 'example'], {
        io: createIo({ stdin: true, stdout }),
        operations,
      });

      expect(code).toBe(0);
      expect((dependencies.io.stdout as MemoryStream).text).toBe(CONFIG_TEMPLATE);
      expect(err).toEqual([]);
      expectNoOperationCalled(operations);
    });

    it('passes the template through the injected redactor', async () => {
      const { dependencies } = await runCli(['config', 'example'], {
        redact: (text) => text.replaceAll('OPENAI_API_KEY', '[redacted]'),
      });

      const stdout = (dependencies.io.stdout as MemoryStream).text;
      expect(stdout).toContain('[redacted]');
      expect(stdout).not.toContain('OPENAI_API_KEY');
    });

    it("matches the fenced yaml block under the configuration reference's Example heading byte for byte", async () => {
      const { dependencies, err } = await runCli(['config', 'example']);
      const docsBlock = await readConfigurationExampleBlock();

      expect(err).toEqual([]);
      expect((dependencies.io.stdout as MemoryStream).text).toBe(docsBlock);
    });
  });

  describe('help', () => {
    it.each(HELP_CASES)(
      'prints description-first help for $description',
      async ({ argv, description, usage }) => {
        const { code, dependencies, err } = await runCli([...argv, '--help']);
        const help = (dependencies.io.stdout as MemoryStream).text;

        expect(code).toBe(0);
        expect(help.startsWith(`${description}\n\n${usage}\n\n`)).toBe(true);
        expect(help).not.toMatch(/opencode|Sensitive data:|Isolation boundary:/i);
        expect(help).toMatch(/-h, --help\s+Show help\n/);
        expect(help).not.toMatch(/\.\s*$/m);
        expect(help).not.toContain('(default:');
        expect(err).toEqual([]);
      },
    );

    it.each(HELP_CASES)(
      'formats examples as comment and command pairs for $description',
      async ({ argv }) => {
        const { dependencies } = await runCli([...argv, '--help']);
        const help = (dependencies.io.stdout as MemoryStream).text;
        const examples = help.split('\nExamples:\n')[1]?.trimEnd();

        expect(examples).toMatch(
          /^ {2}# [^\n]+\n {2}tevu [^\n]+(?:\n\n {2}# [^\n]+\n {2}tevu [^\n]+)*$/,
        );
      },
    );

    it.each([
      { argv: [], names: ['task', 'validate', 'run', 'assess', 'report', 'config'] },
      { argv: ['config'], names: ['example'] },
      { argv: ['task'], names: ['add'] },
    ])('lists only command names in Commands for $argv', async ({ argv, names }) => {
      const { dependencies } = await runCli([...argv, '--help']);
      const help = (dependencies.io.stdout as MemoryStream).text;
      const commands = help.split('\nCommands:\n')[1]?.split('\n\n')[0];

      expect(commands?.split('\n').map((line) => line.trimStart().split(/\s{2,}/)[0])).toEqual(
        names,
      );
    });

    it('documents --dry-run in the run help', async () => {
      const { out } = await runCli(['run', '--help']);

      const help = out.join('').replace(/\s+/g, ' ');
      expect(help).toContain('--dry-run');
      expect(help).toContain('Show the execution plan without running tasks');
    });

    it('documents --jira in the task add help', async () => {
      const { out } = await runCli(['task', 'add', '--help']);

      expect(out.join('')).toContain('--jira');
    });

    it('documents --repeat in the run help', async () => {
      const { out } = await runCli(['run', '--help']);

      const help = out.join('').replace(/\s+/g, ' ');
      expect(help).toContain('--repeat <n>');
      expect(help).toContain('Attempts per task/model pair for this run; overrides run.repeat');
    });

    it('shows the assess example with a three-segment case ID ending in the attempt', async () => {
      const { out } = await runCli(['assess', '--help']);

      expect(out.join('\n')).toContain('tevu assess 20260923t120000z-a1b2c3 task--model--1');
    });

    it('labels the first validate example "Check the configuration tevu finds" (V12)', async () => {
      const { out } = await runCli(['validate', '--help']);

      expect(out.join('\n')).toContain('# Check the configuration tevu finds');
    });

    it('prints help on stderr with exit 1 for a bare invocation', async () => {
      const { code, out, err } = await runCli([]);

      expect(code).toBe(1);
      expect(err[0]).toBe('Compare coding models on your tasks');
      expect(err.slice(1, 4)).toEqual(['Usage:', '  tevu [options]', '  tevu <command> [options]']);
      expect(err.join('')).toContain('Examples:');
      expect(err.join('')).not.toMatch(/opencode|Sensitive data:|Isolation boundary:/i);
      expect(out).toEqual([]);
    });

    it('prints task help on stderr with exit 1 for a bare task command', async () => {
      const { code, out, err } = await runCli(['task']);

      expect(code).toBe(1);
      expect(err[0]).toBe('Manage benchmark tasks');
      expect(err.slice(1, 4)).toEqual([
        'Usage:',
        '  tevu task [options]',
        '  tevu task <command> [options]',
      ]);
      expect(out).toEqual([]);
    });

    it('prints config help on stderr with exit 1 for a bare config command', async () => {
      const { code, out, err } = await runCli(['config']);

      expect(code).toBe(1);
      expect(err[0]).toBe('Work with the configuration file');
      expect(err.slice(1, 4)).toEqual([
        'Usage:',
        '  tevu config [options]',
        '  tevu config <command> [options]',
      ]);
      expect(out).toEqual([]);
    });
  });

  describe('usage errors', () => {
    it.each(USAGE_ERROR_CASES)(
      '$error maps to exit 1 with the usage line on stderr',
      async ({ argv, error, usage }) => {
        const { code, out, err } = await runCli(argv);

        expect(code).toBe(1);
        expect(err[0]).toBe(error);
        expect(err[1]).toBe(usage);
        expect(out).toEqual([]);
      },
    );
  });

  describe('non-interactive rejection', () => {
    it('rejects task add before any configuration read when the streams are not TTYs', async () => {
      const operations = createOperations();
      const { code, err } = await runCli(['task', 'add'], {
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
      'names the failing streams ($actual) when prompting is not possible',
      async ({ stdin, stdout, actual }) => {
        const { code, err } = await runCli(['task', 'add'], { io: createIo({ stdin, stdout }) });

        expect(code).toBe(1);
        expect(err[0]).toBe(
          `error: prerequisite "terminal" is not satisfied; expected an interactive TTY on stdin and stdout, actual ${actual}`,
        );
      },
    );

    it('rejects assess after the configuration read but before any context read or write', async () => {
      const operations = createOperations();
      const { code, err } = await runCli(['assess', 'run-1', 'case-1'], {
        io: createIo(),
        operations,
      });

      expect(code).toBe(1);
      expect(err[0]).toContain('prerequisite "terminal" is not satisfied');
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith('tevu.yaml');
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });
  });

  describe('validate', () => {
    it('prints every finding and the valid verdict with exit 0', async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({ findings: [buildFinding()] }),
        })),
      });

      const { code, out, err } = await runCli(['validate'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'warning task-1: description is thin',
        'Configuration is valid.',
      ]);
      expect(err).toEqual([]);
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith('tevu.yaml');
      expect(vi.mocked(operations.validateConfig)).toHaveBeenCalledExactlyOnceWith(
        buildTevuConfig(),
      );
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
    });

    it('prints the invalid verdict with exit 1 and plans nothing', async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({
            valid: false,
            findings: [
              buildFinding({ severity: 'error', identifier: 'fake-agent', message: 'missing' }),
            ],
            capabilities: {},
          }),
        })),
      });

      const { code, out } = await runCli(['validate'], { operations });

      expect(code).toBe(1);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'error fake-agent: missing',
        'Configuration is invalid.',
      ]);
      expect(operations.planBenchmark).not.toHaveBeenCalled();
    });

    it('maps a not-found configuration load failure to exit 1 with both creation hints and skips validation', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('not-found', '/work/tevu.yaml', 'tevu.yaml'),
        })),
      });

      const { code, out, err } = await runCli(['validate'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found: /work/tevu.yaml',
        '  create one interactively: tevu task add --config tevu.yaml',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.validateConfig).not.toHaveBeenCalled();
    });

    it('maps a search-exhausted configuration failure to exit 1 with both searched paths and calls nothing else (V7)', async () => {
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({
          ok: false as const,
          error: configNotFoundError(['/work/tevu.yaml', '/home/u/.config/tevu/tevu.yaml']),
        })),
      });

      const { code, out, err } = await runCli(['validate'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found',
        '  searched: /work/tevu.yaml',
        '  searched: /home/u/.config/tevu/tevu.yaml',
        '  create one interactively: tevu task add',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.validateConfig).not.toHaveBeenCalled();
    });

    it.each([
      {
        cause: 'permission-denied' as const,
        line: 'error: cannot read configuration file /work/tevu.yaml: permission denied',
      },
      {
        cause: 'not-a-file' as const,
        line: 'error: configuration path is not a file: /work/tevu.yaml',
      },
      {
        cause: 'unreadable' as const,
        line: 'error: cannot read configuration file /work/tevu.yaml',
      },
    ])(
      'maps a $cause configuration load failure to exit 1 with only the cause line',
      async ({ cause, line }) => {
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({
            ok: false as const,
            error: configReadError(cause, '/work/tevu.yaml', 'tevu.yaml'),
          })),
        });

        const { code, out, err } = await runCli(['validate'], { operations });

        expect(code).toBe(1);
        expect(err).toEqual([line]);
        expect(out).toEqual([]);
        expect(operations.validateConfig).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        description: 'the explicit path tevu.yaml',
        requestedPath: 'tevu.yaml',
        taskAddHint: '  create one interactively: tevu task add --config tevu.yaml',
        templateHint: '  or start from the template: tevu config example > tevu.yaml',
      },
      {
        description: 'an absolute path outside the current directory',
        requestedPath: '/nonexistent/tevu.yaml',
        taskAddHint: '  create one interactively: tevu task add --config /nonexistent/tevu.yaml',
        templateHint: '  or start from the template: tevu config example > /nonexistent/tevu.yaml',
      },
      {
        description: 'a path containing a space',
        requestedPath: 'my bench/tevu.yaml',
        taskAddHint: "  create one interactively: tevu task add --config 'my bench/tevu.yaml'",
        templateHint: "  or start from the template: tevu config example > 'my bench/tevu.yaml'",
      },
      {
        description: 'a path containing a single quote',
        requestedPath: "it's.yaml",
        taskAddHint: "  create one interactively: tevu task add --config 'it'\\''s.yaml'",
        templateHint: "  or start from the template: tevu config example > 'it'\\''s.yaml'",
      },
    ])(
      'renders the not-found creation hints for $description',
      async ({ requestedPath, taskAddHint, templateHint }) => {
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({
            ok: false as const,
            error: configReadError('not-found', `/home/u/${requestedPath}`, requestedPath),
          })),
        });

        const { err } = await runCli(['validate', '--config', requestedPath], { operations });

        expect(err[1]).toBe(taskAddHint);
        expect(err[2]).toBe(templateHint);
      },
    );

    it('maps a validation prerequisite failure to exit 1', async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: false as const,
          error: prerequisiteError('git', 'a git executable'),
        })),
      });

      const { code, err } = await runCli(['validate'], { operations });

      expect(code).toBe(1);
      expect(err[0]).toBe('error: prerequisite "git" is not satisfied; expected a git executable');
    });

    it.each([
      {
        description: 'an empty restore pattern (R1)',
        identifier: 'tasks.0.checks.restore.0',
        message: 'restore pattern must not be empty',
      },
      {
        description: 'an overlay inside a configured repository (V2)',
        identifier: 'tasks.write-report.checks.overlay',
        message: 'overlay must be outside repository "sample-repo" after real-path resolution',
      },
    ])(
      'exits 1 for both validate and run when loadConfig reports $description',
      async ({ identifier, message }) => {
        for (const command of [['validate'], ['run']]) {
          const operations = createOperations({
            loadConfig: vi.fn(async () => ({
              ok: false as const,
              error: {
                kind: 'ConfigValidationError' as const,
                findings: [{ severity: 'error' as const, identifier, message }],
              },
            })),
          });

          const { code, err } = await runCli(command, { operations });

          expect(code).toBe(1);
          expect(err).toEqual([
            'error: the configuration is invalid',
            `  error ${identifier}: ${message}`,
          ]);
        }
      },
    );

    it.each([
      {
        description: 'a missing overlay directory (V1)',
        identifier: 'tasks.write-report.checks.overlay',
        message: 'overlay directory "/hidden/checks" does not exist',
      },
      {
        description: 'an overlay directory holding a symbolic link (V3)',
        identifier: 'tasks.write-report.checks.overlay',
        message:
          'overlay directory "/hidden/checks" must contain only regular files and directories; "link" is a symbolic link',
      },
    ])(
      'exits 1 for both validate and run when validateConfig reports $description',
      async ({ identifier, message }) => {
        for (const command of [['validate'], ['run']]) {
          const operations = createOperations({
            validateConfig: vi.fn(async () => ({
              ok: true as const,
              value: buildValidationReport({
                valid: false,
                findings: [{ severity: 'error' as const, identifier, message }],
                capabilities: {},
              }),
            })),
          });

          const { code, out } = await runCli(command, { operations });

          expect(code).toBe(1);
          expect(out).toEqual([
            'Configuration: tevu.yaml',
            `error ${identifier}: ${message}`,
            'Configuration is invalid.',
          ]);
          expect(operations.planBenchmark).not.toHaveBeenCalled();
        }
      },
    );

    it.each(CONFIG_HONORING_CASES)('reads $command with the --config path', async ({ command }) => {
      const operations = createOperations();

      const { code } = await runCli([...command, '--config', 'custom.yaml'], { operations });

      expect(code).toBe(0);
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith('custom.yaml');
    });

    it.each([
      {
        description: 'a duration outside its grammar',
        identifier: 'run.timeout',
        message:
          'must be a positive whole number followed by ms, s, m, or h, for example 30s or 10m',
      },
      {
        description: 'a duration above its millisecond bound',
        identifier: 'run.timeout',
        message: 'must be at most 2147483647ms',
      },
      {
        description: 'a variable name outside its grammar',
        identifier: 'agents.opencode.secrets.0',
        message: 'must be a letter or underscore followed by letters, digits, or underscores',
      },
      {
        description: 'a Jira credential that is not a $VARIABLE reference',
        identifier: 'trackers.jira.token',
        message:
          'must be a $VARIABLE reference, for example $JIRA_API_TOKEN; secret values are never written here',
      },
    ])(
      'renders the $description finding message from a failed configuration load',
      async ({ identifier, message }) => {
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({
            ok: false as const,
            error: {
              kind: 'ConfigValidationError' as const,
              findings: [{ severity: 'error' as const, identifier, message }],
            },
          })),
        });

        const { code, err } = await runCli(['validate'], { operations });

        expect(code).toBe(1);
        expect(err).toEqual([
          'error: the configuration is invalid',
          `  error ${identifier}: ${message}`,
        ]);
      },
    );
  });

  describe('run dry-run', () => {
    it('prints the plan, limits, destination, and capability report with exit 0', async () => {
      const { code, out, err } = await runCli(['run', '--dry-run']);

      expect(code).toBe(0);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Dry run: no artifact, workspace, Jira call, or agent model session is created.',
        'Planned cases (2, execution order):',
        '  case-c1-task-1: task task-1, model entry c1 (provider/model-a, effort high), commit abc123def, timeout 600000ms',
        '  case-c2-task-1: task task-1, model entry c2 (provider/model-b, effort low), commit abc123def, timeout 600000ms',
        'Manual assessments needed: 2 (one tevu assess per case whose task has manual checks)',
        'Limits: concurrency 2, timeout 600000ms, stop grace 5000ms',
        'Artifact destination: /tmp/artifacts',
        'Agent "fake-agent" capabilities (opencode, detected version: 1.18.32):',
        '  run command: available',
        '  export command: available',
        '  run --format json: available',
        '  run --model: available',
        '  run --variant: available',
        '  isolation deny-outside-worktree (optional): available',
      ]);
      expect(err).toEqual([]);
    });

    it('calls exactly loadConfig, validateConfig, and planBenchmark and nothing else', async () => {
      const operations = createOperations();

      const { code } = await runCli(['run', '--dry-run'], { operations });

      expect(code).toBe(0);
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith('tevu.yaml');
      expect(vi.mocked(operations.validateConfig)).toHaveBeenCalledExactlyOnceWith(
        buildTevuConfig(),
      );
      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildTevuConfig(),
        'tevu.yaml',
        undefined,
      );
      expect(operations.configExists).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
    });

    it('prints the not-probed fallback when capabilities are absent', async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({ capabilities: {} }),
        })),
      });

      const { out } = await runCli(['run', '--dry-run'], { operations });

      expect(out).toContain('Agent "fake-agent" capabilities: not probed');
    });

    it('prints findings and stops before planning when validation fails', async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({
            valid: false,
            findings: [
              buildFinding({ severity: 'error', identifier: 'fake-agent', message: 'unavailable' }),
            ],
          }),
        })),
      });

      const { code, out } = await runCli(['run'], { operations });

      expect(code).toBe(1);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'error fake-agent: unavailable',
        'Configuration is invalid.',
      ]);
      expect(operations.planBenchmark).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('maps a not-found configuration load failure to exit 1 without validating or planning', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('not-found', '/work/tevu.yaml', 'tevu.yaml'),
        })),
      });

      const { code, out, err } = await runCli(['run', '--dry-run'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found: /work/tevu.yaml',
        '  create one interactively: tevu task add --config tevu.yaml',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.validateConfig).not.toHaveBeenCalled();
      expect(operations.planBenchmark).not.toHaveBeenCalled();
    });

    it('maps a search-exhausted configuration failure to exit 1 with both searched paths and calls nothing else (V7)', async () => {
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({
          ok: false as const,
          error: configNotFoundError(['/work/tevu.yaml', '/home/u/.config/tevu/tevu.yaml']),
        })),
      });

      const { code, out, err } = await runCli(['run', '--dry-run'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found',
        '  searched: /work/tevu.yaml',
        '  searched: /home/u/.config/tevu/tevu.yaml',
        '  create one interactively: tevu task add',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.validateConfig).not.toHaveBeenCalled();
      expect(operations.planBenchmark).not.toHaveBeenCalled();
    });
  });

  describe('run --repeat', () => {
    it.each(['0', '00', 'abc', '1.5', '-1', '+3', ' 3', '1e3', '101', '100000000', ''])(
      'rejects %j with exit code 1 before any ProgramOperations call (AC-4, verification properties 8, 9)',
      async (value) => {
        const operations = createOperations();

        const { code, out, err } = await runCli(['run', '--repeat', value], { operations });

        expect(code).toBe(1);
        expect(err[0]).toBe(
          `error: option '--repeat <n>' argument '${value}' is invalid. Expected a whole number from 1 to 100.`,
        );
        expect(err[1]).toBe('Usage: tevu run [options]');
        expect(out).toEqual([]);
        expect(operations.loadConfig).not.toHaveBeenCalled();
        expect(operations.validateConfig).not.toHaveBeenCalled();
        expect(operations.planBenchmark).not.toHaveBeenCalled();
      },
    );

    it.each([
      { literal: '3', value: 3 },
      { literal: '03', value: 3 },
      { literal: '100', value: 100 },
    ])(
      'accepts --repeat $literal and passes $value to planBenchmark',
      async ({ literal, value }) => {
        const operations = createOperations();

        const { code } = await runCli(['run', '--dry-run', '--repeat', literal], { operations });

        expect(code).toBe(0);
        expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
          buildTevuConfig(),
          'tevu.yaml',
          value,
        );
      },
    );

    it('passes 100 to planBenchmark for tevu run --dry-run --repeat 100 (AC-14)', async () => {
      const operations = createOperations();

      const { code } = await runCli(['run', '--dry-run', '--repeat', '100'], { operations });

      expect(code).toBe(0);
      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildTevuConfig(),
        'tevu.yaml',
        100,
      );
    });

    it.each(['101', '100000000'])(
      'ends tevu run --repeat %s with exit code 1 before any ProgramOperations call (AC-14)',
      async (value) => {
        const operations = createOperations();

        const { code } = await runCli(['run', '--repeat', value], { operations });

        expect(code).toBe(1);
        expect(operations.planBenchmark).not.toHaveBeenCalled();
      },
    );

    it('accepts the --repeat=<n> form', async () => {
      const operations = createOperations();

      const { code } = await runCli(['run', '--dry-run', '--repeat=5'], { operations });

      expect(code).toBe(0);
      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildTevuConfig(),
        'tevu.yaml',
        5,
      );
    });

    it('keeps the last value when --repeat is repeated', async () => {
      const operations = createOperations();

      const { code } = await runCli(['run', '--dry-run', '--repeat', '2', '--repeat', '7'], {
        operations,
      });

      expect(code).toBe(0);
      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildTevuConfig(),
        'tevu.yaml',
        7,
      );
    });

    it('prints the manual-assessments line after the planned-case list and before Limits, for 2 tasks, 2 model entries, and repeat 3 with one manual-checked task (AC-8)', async () => {
      const manualTask = buildTaskDefinition({ id: 'task-1' });
      const commandOnlyTask = buildTaskDefinition({
        id: 'task-2',
        checks: {
          acceptance: [
            {
              id: 'acc-2',
              description: 'acceptance command exits zero',
              run: ['/synthetic/acceptance-probe'],
              timeout: '5s',
              exit_codes: [0],
            },
          ],
          done: [
            {
              id: 'dod-2',
              description: 'done command exits zero',
              run: ['/synthetic/done-probe'],
              timeout: '5s',
              exit_codes: [0],
            },
          ],
        },
      });
      const config = buildTevuConfig({ tasks: [manualTask, commandOnlyTask] });
      const cases = Array.from({ length: 3 }, (_, index) => index + 1).flatMap((attempt) =>
        config.tasks.flatMap((task) =>
          config.models.map((model) => ({
            caseId: `${task.id}--${model.id}--${attempt}`,
            taskId: task.id,
            modelId: model.id,
            attempt,
            sourceCommit: 'abc123def',
            model: model.model,
            effort: model.effort,
            agent: model.agent,
            timeoutMs: 600_000,
          })),
        ),
      );
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
        planBenchmark: vi.fn(() =>
          buildBenchmarkPlan(config, { cases, repeat: { value: 3, source: 'cli' } }),
        ),
      });

      const { out } = await runCli(['run', '--dry-run', '--repeat', '3'], { operations });

      const plannedIndex = out.findIndex((line) => line.startsWith('Planned cases'));
      const manualIndex = out.indexOf(
        'Manual assessments needed: 6 (one tevu assess per case whose task has manual checks)',
      );
      const limitsIndex = out.findIndex((line) => line.startsWith('Limits:'));
      expect(plannedIndex).toBeGreaterThan(-1);
      expect(manualIndex).toBeGreaterThan(plannedIndex);
      expect(limitsIndex).toBeGreaterThan(manualIndex);
    });
  });

  describe('run execution', () => {
    it('prints deterministic run metadata in planned order and returns the run exit code', async () => {
      let loadedConfig: TevuConfig | undefined;
      const operations = createOperations({
        loadConfig: vi.fn(async () => {
          const config = buildTevuConfig();
          loadedConfig = config;
          return { ok: true as const, value: config };
        }),
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          hooks.onRunId?.('run-1');
          return {
            ok: true as const,
            value: buildRunResult({
              findings: [
                buildRunFinding({ severity: 'warning', caseId: 'case-c1-task-1' }),
                buildRunFinding({ severity: 'error', caseId: null, message: 'cleanup warning' }),
              ],
            }),
          };
        }),
      });

      const { code, out, err } = await runCli(['run'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Run run-1 started.',
        'case-c1-task-1: lifecycle completed, outcome passed',
        'warning [case-c1-task-1]: diagnostics truncated',
        'error: cleanup warning',
        'Artifacts: /tmp/artifacts/run-1',
        'Report: /tmp/artifacts/run-1/report.md',
      ]);
      expect(err).toEqual([]);
      expect(vi.mocked(operations.rebuildRunReport)).toHaveBeenCalledExactlyOnceWith(
        loadedConfig,
        'run-1',
      );
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
    });

    it('passes the same absolute path to planBenchmark that it prints in the Configuration line (AC-3)', async () => {
      const foundPath = '/home/u/.config/tevu/tevu.yaml';
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({ ok: true as const, value: foundPath })),
      });

      const { out } = await runCli(['run'], { operations });

      expect(out[0]).toBe(`Configuration: ${foundPath}`);
      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildTevuConfig(),
        foundPath,
        undefined,
      );
    });

    it('wires the shared cancellation and run-id hook and withholds lifecycle progress on non-TTY output', async () => {
      let captured: BenchmarkExecutionHooks | undefined;
      const cancellation = new AbortController().signal;
      const operations = createOperations({
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          captured = hooks;
          return { ok: true as const, value: buildRunResult() };
        }),
      });

      const { code, out } = await runCli(['run'], { io: createIo(), operations, cancellation });

      expect(code).toBe(0);
      expect(captured?.cancellation).toBe(cancellation);
      expect(captured?.onRunId).toBeTypeOf('function');
      expect(captured?.onLifecycle).toBeUndefined();
      expect(out.join('')).not.toContain('[case-');
    });

    it('emits case-prefixed lifecycle progress on a TTY stdout', async () => {
      const operations = createOperations({
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          hooks.onRunId?.('run-1');
          hooks.onLifecycle?.('case-c1-task-1', 'running');
          hooks.onLifecycle?.('case-c1-task-1', 'completed');
          return { ok: true as const, value: buildRunResult() };
        }),
      });

      const { code, out } = await runCli(['run'], {
        io: createIo({ stdin: true, stdout: true }),
        operations,
      });

      expect(code).toBe(0);
      expect(out).toContain('[case-c1-task-1] running');
      expect(out).toContain('[case-c1-task-1] completed');
      expect(out).toContain('case-c1-task-1: lifecycle completed, outcome passed');
    });

    it('preserves exit code 2 for a passed run with a recorded runtime failure', async () => {
      const operations = createOperations({
        executeBenchmark: vi.fn(async () => ({
          ok: true as const,
          value: buildRunResult({
            exitCode: 2,
            cases: [
              buildCaseResult({
                lifecycle: 'process-failed',
                outcome: 'passed',
                failure: {
                  error: {
                    kind: 'AgentProcessError',
                    agent: 'fake-agent',
                    caseId: 'case-c1-task-1',
                    exitCode: 1,
                    signal: null,
                  },
                  occurredAt: '2026-09-23T10:02:00.000Z',
                },
              }),
            ],
          }),
        })),
      });

      const { code, out } = await runCli(['run'], { operations });

      expect(code).toBe(2);
      expect(out).toContain(
        'case-c1-task-1: lifecycle process-failed, outcome passed, runtime failure AgentProcessError',
      );
      expect(out).toContain('Report: /tmp/artifacts/run-1/report.md');
      expect(operations.rebuildRunReport).toHaveBeenCalledOnce();
    });

    it('skips the report rebuild and names the recovery command for a cancelled run', async () => {
      const operations = createOperations({
        executeBenchmark: vi.fn(async () => ({
          ok: true as const,
          value: buildRunResult({ exitCode: 130 }),
        })),
      });

      const { code, out } = await runCli(['run'], { operations });

      expect(code).toBe(130);
      expect(out).toContain(
        'Run cancelled; partial artifacts were finalized. Regenerate the report with: tevu report run-1',
      );
      expect(operations.rebuildRunReport).not.toHaveBeenCalled();
    });

    it('downgrades to exit 1 with the recovery hint when the rebuild fails', async () => {
      const operations = createOperations({
        rebuildRunReport: vi.fn(async () => ({
          ok: false as const,
          error: artifactError('rebuild-report', 'run directory vanished'),
        })),
      });

      const { code, out, err } = await runCli(['run'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: artifact operation "rebuild-report" failed: run directory vanished',
        'The report could not be generated; recover with: tevu report run-1',
      ]);
      expect(out.join('')).not.toContain('Report:');
    });

    it.each(EXECUTE_FAILURE_CASES)(
      'maps the $name failure of executeBenchmark to exit $code without a rebuild',
      async ({ error, code, stderr }) => {
        const operations = createOperations({
          executeBenchmark: vi.fn(async () => ({ ok: false as const, error })),
        });

        const { code: exitCode, err } = await runCli(['run'], { operations });

        expect(exitCode).toBe(code);
        expect(err[0]).toBe(stderr);
        expect(operations.rebuildRunReport).not.toHaveBeenCalled();
      },
    );
  });

  describe('task add', () => {
    it('rejects combining --jira and --github before any operation is called', async () => {
      const operations = createOperations();

      const { code, err } = await runCli(
        ['task', 'add', '--jira', 'TEVU-42', '--github', 'octo/repo#42'],
        { operations },
      );

      expect(code).toBe(1);
      expect(err[0]).toBe(
        "error: option '--github <reference>' cannot be used with option '--jira <issue-key>'",
      );
      expect(clack.state.prompts).toEqual([]);
      expect(operations.configExists).not.toHaveBeenCalled();
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('rejects --jira before any question when the configuration has no Jira settings', async () => {
      const operations = createOperations();

      const { code, err } = await runCli(['task', 'add', '--jira', 'TEVU-42'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: the configuration is invalid',
        '  error trackers.jira: task add --jira requires trackers.jira in the existing configuration',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('bootstraps the configuration before the first task question and cancels without a write', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        '/tmp/bench-artifacts',
        '4',
        '10m',
        '5s',
        '',
        'opencode',
        false,
        false,
        false,
        'alpha',
        '../repos/alpha',
        false,
        'c1',
        'provider/model-a',
        'high',
        'c2',
        'provider/model-b',
        'low',
        false,
        clack.CANCEL,
      );

      const { code, err } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(err[0]).toBe('Cancelled.');
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
        'tevu task add',
        ...BOOTSTRAP_PROMPTS,
        'Task source',
      ]);
      expect(vi.mocked(operations.configExists)).toHaveBeenCalledExactlyOnceWith('tevu.yaml');
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.createTask).not.toHaveBeenCalled();
      expect(clack.state.logs).toContainEqual({
        kind: 'warn',
        message: 'Task creation cancelled; the configuration is unchanged.',
      });
    });

    it('bootstraps the complete configuration, re-prompts invalid integers, and lets createTask perform the only write', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        '/tmp/bench-artifacts',
        { invalid: 'abc' },
        '4',
        '10m',
        '5s',
        '',
        'opencode',
        false,
        false,
        false,
        'alpha',
        '../repos/alpha',
        false,
        'c1',
        'provider/model-a',
        'high',
        'c2',
        'provider/model-b',
        'low',
        false,
        ...taskInterviewAnswers('alpha'),
        true,
      );

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml', 'Task "task-2" added to tevu.yaml.']);
      expect(clack.state.rejections).toEqual([
        {
          kind: 'text',
          message: 'Concurrent cases (1-32)',
          reason: 'enter an integer from 1 through 32',
        },
      ]);
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(vi.mocked(operations.createTask)).toHaveBeenCalledOnce();
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]).toEqual({
        configPath: 'tevu.yaml',
        bootstrap: {
          run: {
            output_dir: '/tmp/bench-artifacts',
            concurrency: 4,
            timeout: '10m',
            stop_grace: '5s',
          },
          agents: { opencode: { command: 'opencode', secrets: [], env: [] } },
          repositories: [{ id: 'alpha', path: '../repos/alpha' }],
          models: [
            { id: 'c1', model: 'provider/model-a', effort: 'high' },
            { id: 'c2', model: 'provider/model-b', effort: 'low' },
          ],
        },
        task: {
          id: 'task-2',
          title: 'Add an export button',
          repo: 'alpha',
          base_commit: 'abc123',
          description: 'Export the current view as CSV.',
          prompt: 'Implement CSV export for the current view.',
          readiness: ['Repository is readable'],
          checks: {
            acceptance: [{ id: 'acc-1', description: 'Export produces a CSV', manual: true }],
            done: [{ id: 'dod-1', description: 'README documents the button', manual: true }],
          },
        },
      });
    });

    it('captures a task against an existing configuration and lets createTask perform the only write', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), true);

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml', 'Task "task-2" added to tevu.yaml.']);
      expect(vi.mocked(operations.configExists)).toHaveBeenCalledExactlyOnceWith('tevu.yaml');
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledOnce();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(vi.mocked(operations.createTask)).toHaveBeenCalledOnce();
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]).toEqual({
        configPath: 'tevu.yaml',
        task: {
          id: 'task-2',
          title: 'Add an export button',
          repo: 'repo-1',
          base_commit: 'abc123',
          description: 'Export the current view as CSV.',
          prompt: 'Implement CSV export for the current view.',
          readiness: ['Repository is readable'],
          checks: {
            acceptance: [{ id: 'acc-1', description: 'Export produces a CSV', manual: true }],
            done: [{ id: 'dod-1', description: 'README documents the button', manual: true }],
          },
        },
      });
    });

    it('appends to a found search candidate and prints it as both the Configuration line and the added-to target (AC-2)', async () => {
      const foundPath = '/home/u/.config/tevu/tevu.yaml';
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({ ok: true as const, value: foundPath })),
      });
      scriptAnswers(...taskInterviewAnswers('repo-1'), true);

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual([`Configuration: ${foundPath}`, `Task "task-2" added to ${foundPath}.`]);
      expect(vi.mocked(operations.configExists)).toHaveBeenCalledExactlyOnceWith(foundPath);
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith(foundPath);
    });

    it('creates the current-directory file named by searchedPaths[0] when the search reports ConfigNotFoundError (AC-2)', async () => {
      const operations = createOperations({
        configExists: vi.fn(async () => false),
        locateConfig: vi.fn(async () => ({
          ok: false as const,
          error: configNotFoundError(['/work/tevu.yaml', '/home/u/.config/tevu/tevu.yaml']),
        })),
      });
      scriptAnswers(
        '/tmp/bench-artifacts',
        '4',
        '10m',
        '5s',
        '',
        'opencode',
        false,
        false,
        false,
        'alpha',
        '../repos/alpha',
        false,
        'c1',
        'provider/model-a',
        'high',
        'c2',
        'provider/model-b',
        'low',
        false,
        ...taskInterviewAnswers('alpha'),
        true,
      );

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual([
        'Configuration: /work/tevu.yaml',
        'Task "task-2" added to /work/tevu.yaml.',
      ]);
      expect(vi.mocked(operations.configExists)).toHaveBeenCalledExactlyOnceWith('/work/tevu.yaml');
      expect(vi.mocked(operations.requireConfigDirectory)).toHaveBeenCalledExactlyOnceWith(
        '/work/tevu.yaml',
      );
      expect(operations.loadConfig).not.toHaveBeenCalled();
    });

    it("exits 1 before the wizard's first question and before configExists or requireConfigDirectory when the search reports a ConfigReadError", async () => {
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('permission-denied', '/work/tevu.yaml', 'tevu.yaml'),
        })),
      });

      const { code, err } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: cannot read configuration file /work/tevu.yaml: permission denied',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expect(operations.configExists).not.toHaveBeenCalled();
      expect(operations.requireConfigDirectory).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('imports a Jira issue exactly once and travels the snapshot inside the wizard input', async () => {
      const jiraSettings = buildJiraTrackerSettings();
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildTevuConfig({ trackers: { jira: jiraSettings } }),
        })),
      });
      scriptAnswers(
        'repo-1',
        'abc123',
        'task-2',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
        false,
        'acc-1',
        'Export produces a CSV',
        true,
        'manual',
        false,
        'dod-1',
        'README documents the button',
        true,
        'manual',
        false,
        true,
      );

      const { code, out } = await runCli(['task', 'add', '--jira', 'TEVU-42'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml', 'Task "task-2" added to tevu.yaml.']);
      expect(vi.mocked(operations.importJiraIssue)).toHaveBeenCalledExactlyOnceWith(
        jiraSettings,
        'TEVU-42',
      );
      expect(clack.state.notes).toContainEqual({
        title: 'Imported TEVU-42 (one-time snapshot)',
        message: 'Add an export button\n\nUsers cannot export the current view.',
      });
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task.source).toEqual({
        kind: 'jira',
        key: 'TEVU-42',
        url: 'https://jira.example.com/browse/TEVU-42',
        imported_at: '2026-09-23T10:00:00.000Z',
        title: 'Add an export button',
        body: 'Users cannot export the current view.',
      });
    });

    it('imports a GitHub issue exactly once and travels the snapshot inside the wizard input', async () => {
      const githubSnapshot = buildJiraIssueSnapshot({
        issueKey: 'octo/repo#42',
        issueUrl: 'https://github.com/octo/repo/issues/42',
        summary: 'Add an export button',
        description: 'Users cannot export the current view.',
      });
      const operations = createOperations({
        importGitHubIssue: vi.fn(async () => ({ ok: true as const, value: githubSnapshot })),
      });
      scriptAnswers(
        'repo-1',
        'abc123',
        'task-2',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
        false,
        'acc-1',
        'Export produces a CSV',
        true,
        'manual',
        false,
        'dod-1',
        'README documents the button',
        true,
        'manual',
        false,
        true,
      );

      const { code, out } = await runCli(['task', 'add', '--github', 'octo/repo#42'], {
        operations,
      });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml', 'Task "task-2" added to tevu.yaml.']);
      expect(vi.mocked(operations.importGitHubIssue)).toHaveBeenCalledExactlyOnceWith(
        'octo/repo#42',
      );
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(clack.state.notes).toContainEqual({
        title: 'Imported octo/repo#42 (one-time snapshot)',
        message: 'Add an export button\n\nUsers cannot export the current view.',
      });
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task.source).toEqual({
        kind: 'github',
        key: 'octo/repo#42',
        url: 'https://github.com/octo/repo/issues/42',
        imported_at: '2026-09-23T10:00:00.000Z',
        title: 'Add an export button',
        body: 'Users cannot export the current view.',
      });
    });

    it.each([
      {
        description: 'Jira',
        argv: ['task', 'add', '--jira', 'TEVU-42'],
        operationsOverrides: (jiraSettings: JiraTrackerSettings) => ({
          loadConfig: vi.fn(async () => ({
            ok: true as const,
            value: buildTevuConfig({ trackers: { jira: jiraSettings } }),
          })),
          importJiraIssue: vi.fn(async () => ({
            ok: false as const,
            error: { kind: 'CancellationError' as const, activeCaseIds: [] },
          })),
        }),
      },
      {
        description: 'GitHub',
        argv: ['task', 'add', '--github', 'octo/repo#42'],
        operationsOverrides: () => ({
          importGitHubIssue: vi.fn(async () => ({
            ok: false as const,
            error: { kind: 'CancellationError' as const, activeCaseIds: [] },
          })),
        }),
      },
    ])(
      'converts a $description import cancellation into the standard cancellation exit and message',
      async ({ argv, operationsOverrides }) => {
        const operations = createOperations(operationsOverrides(buildJiraTrackerSettings()));

        const { code, err } = await runCli(argv, { operations });

        expect(code).toBe(130);
        expect(err[0]).toBe('Cancelled.');
        expect(operations.createTask).not.toHaveBeenCalled();
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: 'Task creation cancelled; the configuration is unchanged.',
        });
      },
    );

    it('cancels at the review confirmation without calling createTask', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), false);

      const { code, err } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(err[0]).toBe('Cancelled.');
      expect(operations.createTask).not.toHaveBeenCalled();
      expect(clack.state.logs).toContainEqual({
        kind: 'warn',
        message: 'Task creation cancelled; the configuration is unchanged.',
      });
    });

    it('maps a configuration parse failure to exit 1 before any question', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configParseError([
            buildFinding({
              severity: 'error',
              identifier: 'version',
              message: 'unsupported version',
            }),
          ]),
        })),
      });

      const { code, err } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: the configuration could not be parsed',
        '  error version: unsupported version',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expectNoWrites(operations);
    });

    it('fails before the intro on a permission-denied read without starting the interview', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('permission-denied', '/work/locked/tevu.yaml', 'locked/tevu.yaml'),
        })),
      });

      const { code, err } = await runCli(['task', 'add', '--config', 'locked/tevu.yaml'], {
        operations,
      });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: cannot read configuration file /work/locked/tevu.yaml: permission denied',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expect(clack.state.notes).toEqual([]);
      expect(clack.state.logs).toEqual([]);
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('fails before the intro when the configuration directory does not exist', async () => {
      const operations = createOperations({
        configExists: vi.fn(async () => false),
        requireConfigDirectory: vi.fn(async () => ({
          ok: false as const,
          error: {
            kind: 'PrerequisiteError' as const,
            tool: 'configuration directory',
            expected: 'an existing directory',
            actual: '/nonexistent does not exist',
          },
        })),
      });

      const { code, err } = await runCli(['task', 'add', '--config', '/nonexistent/tevu.yaml'], {
        operations,
      });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: prerequisite "configuration directory" is not satisfied; expected an existing directory, actual /nonexistent does not exist',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expect(clack.state.notes).toEqual([]);
      expect(clack.state.logs).toEqual([]);
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('never probes the configuration directory when the configuration file exists', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), true);

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(operations.requireConfigDirectory).not.toHaveBeenCalled();
    });
  });

  describe('assess', () => {
    it('collects verdicts for every manual check in configuration order and splices the cancellation signal', async () => {
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
              buildManualCheckSummary({ checkId: 'acc-1', category: 'acceptance', required: true }),
              buildManualCheckSummary({
                checkId: 'dod-1',
                category: 'definition-of-done',
                required: false,
              }),
            ],
          }),
        })),
      });
      scriptAnswers('alice', 'passed', '', 'failed', 'loader missing');

      const { code, out } = await runCli(['assess', 'run-1', 'case-1'], {
        operations,
        cancellation,
      });

      expect(code).toBe(0);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Assessment recorded for case case-1; derived task outcome: passed.',
        'Report: /tmp/artifacts/run-1/report.md',
      ]);
      expect(vi.mocked(operations.readAssessmentContext)).toHaveBeenCalledExactlyOnceWith(
        loadedConfig,
        'run-1',
        'case-1',
      );
      expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]).toEqual({
        runId: 'run-1',
        caseId: 'case-1',
        decisions: [
          {
            checkId: 'acc-1',
            verdict: 'passed',
            assessor: 'alice',
            note: '',
            replaceExisting: false,
          },
          {
            checkId: 'dod-1',
            verdict: 'failed',
            assessor: 'alice',
            note: 'loader missing',
            replaceExisting: false,
          },
        ],
        assessedAt: '2026-09-23T10:00:00.000Z',
        cancellation,
      });
    });

    it('requires individual confirmation to replace a committed assessment', async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessmentContext({ existing: [buildAssessmentRecord()] }),
        })),
      });
      scriptAnswers('alice', true, 'failed', 'regressed', true);

      const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

      expect(code).toBe(0);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual(
        expect.arrayContaining([
          'Replace the existing assessment for "acc-1"?',
          'Confirm replacing "acc-1" (passed -> failed)?',
        ]),
      );
      expect(clack.state.notes).toContainEqual({
        title: 'Existing assessments',
        message: 'acc-1: passed by bob at 2026-09-22T09:00:00.000Z',
      });
      expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([
        {
          checkId: 'acc-1',
          verdict: 'failed',
          assessor: 'alice',
          note: 'regressed',
          replaceExisting: true,
        },
      ]);
    });

    it('skips a check without verdict prompts when replacement is declined', async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessmentContext({ existing: [buildAssessmentRecord()] }),
        })),
      });
      scriptAnswers('alice', false);

      const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

      expect(code).toBe(0);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
        'tevu assess run-1 case-1',
        'Assessor name',
        'Replace the existing assessment for "acc-1"?',
      ]);
      expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([]);
    });

    it('keeps the existing assessment when the replacement confirmation is declined', async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessmentContext({ existing: [buildAssessmentRecord()] }),
        })),
      });
      scriptAnswers('alice', true, 'passed', '', false);

      const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

      expect(code).toBe(0);
      expect(clack.state.logs).toContainEqual({
        kind: 'info',
        message: 'Kept the existing assessment for "acc-1".',
      });
      expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([]);
    });

    it('maps a wizard cancellation to exit 130 without recording anything', async () => {
      const operations = createOperations();
      scriptAnswers(clack.CANCEL);

      const { code, err } = await runCli(['assess', 'run-1', 'case-1'], { operations });

      expect(code).toBe(130);
      expect(err[0]).toBe('Cancelled.');
      expect(operations.applyAssessment).not.toHaveBeenCalled();
      expect(clack.state.logs).toContainEqual({
        kind: 'warn',
        message: 'Assessment cancelled; nothing was recorded.',
      });
    });

    it('rejects a case with no manual checks as a configuration validation error', async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessmentContext({ manualChecks: [] }),
        })),
      });

      const { code, err } = await runCli(['assess', 'run-1', 'case-1'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: the configuration is invalid',
        '  error case-1: case "case-1" has no manual checks; there is nothing to assess',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expectNoWrites(operations);
    });

    it('maps a context read failure to exit 1 before any write', async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: false as const,
          error: artifactError('read-assessment-context', 'run directory is missing'),
        })),
      });

      const { code, err } = await runCli(['assess', 'run-1', 'case-1'], { operations });

      expect(code).toBe(1);
      expect(err[0]).toBe(
        'error: artifact operation "read-assessment-context" failed: run directory is missing',
      );
      expectNoWrites(operations);
    });

    it('maps a not-found configuration load failure to exit 1 before any read or write', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('not-found', '/work/tevu.yaml', 'tevu.yaml'),
        })),
      });

      const { code, out, err } = await runCli(['assess', 'run-1', 'case-1'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found: /work/tevu.yaml',
        '  create one interactively: tevu task add --config tevu.yaml',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('maps a search-exhausted configuration failure to exit 1 with both searched paths and calls nothing else (V7)', async () => {
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({
          ok: false as const,
          error: configNotFoundError(['/work/tevu.yaml', '/home/u/.config/tevu/tevu.yaml']),
        })),
      });

      const { code, out, err } = await runCli(['assess', 'run-1', 'case-1'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found',
        '  searched: /work/tevu.yaml',
        '  searched: /home/u/.config/tevu/tevu.yaml',
        '  create one interactively: tevu task add',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it.each(APPLY_FAILURE_CASES)(
      'maps the $name failure of applyAssessment to exit $code',
      async ({ error, code, stderr }) => {
        const operations = createOperations({
          applyAssessment: vi.fn(async () => ({ ok: false as const, error })),
        });
        scriptAnswers('alice', 'passed', '');

        const { code: exitCode, err } = await runCli(['assess', 'run-1', 'case-1'], {
          operations,
        });

        expect(exitCode).toBe(code);
        expect(err[0]).toBe(stderr);
      },
    );
  });

  describe('report', () => {
    it('regenerates the report from loadConfig and rebuildRunReport only', async () => {
      let loadedConfig: TevuConfig | undefined;
      const operations = createOperations({
        loadConfig: vi.fn(async () => {
          const config = buildTevuConfig();
          loadedConfig = config;
          return { ok: true as const, value: config };
        }),
      });

      const { code, out, err } = await runCli(['report', 'run-1'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Report regenerated: /tmp/artifacts/run-1/report.md',
      ]);
      expect(err).toEqual([]);
      expect(vi.mocked(operations.rebuildRunReport)).toHaveBeenCalledExactlyOnceWith(
        loadedConfig,
        'run-1',
      );
      expect(operations.validateConfig).not.toHaveBeenCalled();
      expect(operations.planBenchmark).not.toHaveBeenCalled();
      expect(operations.executeBenchmark).not.toHaveBeenCalled();
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
      expect(operations.applyAssessment).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expect(operations.createTask).not.toHaveBeenCalled();
    });

    it('maps a rebuild failure to exit 1', async () => {
      const operations = createOperations({
        rebuildRunReport: vi.fn(async () => ({
          ok: false as const,
          error: artifactError('rebuild-report', 'missing result.json'),
        })),
      });

      const { code, out, err } = await runCli(['report', 'run-1'], { operations });

      expect(code).toBe(1);
      expect(err[0]).toBe('error: artifact operation "rebuild-report" failed: missing result.json');
      expect(out).toEqual(['Configuration: tevu.yaml']);
    });

    it('maps a not-found configuration load failure to exit 1', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('not-found', '/work/tevu.yaml', 'tevu.yaml'),
        })),
      });

      const { code, out, err } = await runCli(['report', 'run-1'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found: /work/tevu.yaml',
        '  create one interactively: tevu task add --config tevu.yaml',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.rebuildRunReport).not.toHaveBeenCalled();
    });

    it('maps a search-exhausted configuration failure to exit 1 with both searched paths and calls nothing else (V7)', async () => {
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({
          ok: false as const,
          error: configNotFoundError(['/work/tevu.yaml', '/home/u/.config/tevu/tevu.yaml']),
        })),
      });

      const { code, out, err } = await runCli(['report', 'run-1'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found',
        '  searched: /work/tevu.yaml',
        '  searched: /home/u/.config/tevu/tevu.yaml',
        '  create one interactively: tevu task add',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.rebuildRunReport).not.toHaveBeenCalled();
    });
  });

  describe('redaction', () => {
    it('scrubs secrets from stderr failure output', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('not-found', '/work/hunter2/tevu.yaml', 'hunter2/tevu.yaml'),
        })),
      });

      const { code, err } = await runCli(['validate'], {
        operations,
        redact: (text) => text.replaceAll('hunter2', '[redacted]'),
      });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found: /work/[redacted]/tevu.yaml',
        "  create one interactively: tevu task add --config '[redacted]/tevu.yaml'",
        "  or start from the template: tevu config example > '[redacted]/tevu.yaml'",
      ]);
      expect(err.join('')).not.toContain('hunter2');
    });

    it('keeps a secret containing a single quote out of stderr in both raw and shell-quoted form', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('not-found', "/work/it's-secret.yaml", "it's-secret.yaml"),
        })),
      });

      const { code, err } = await runCli(['validate'], {
        operations,
        redact: (text) => text.replaceAll("it's-secret", '[redacted]'),
      });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found: /work/[redacted].yaml',
        "  create one interactively: tevu task add --config '[redacted].yaml'",
        "  or start from the template: tevu config example > '[redacted].yaml'",
      ]);
      const combined = err.join('');
      expect(combined).not.toContain("it's-secret");
      expect(combined).not.toContain("it'\\''s-secret");
    });

    it('scrubs secrets from stdout success output', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildTevuConfig({
            run: { output_dir: '/tmp/hunter2', concurrency: 2, timeout: '10m', stop_grace: '5s' },
          }),
        })),
      });

      const { out } = await runCli(['report', 'run-1'], {
        operations,
        redact: (text) => text.replaceAll('hunter2', '[redacted]'),
      });

      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Report regenerated: /tmp/[redacted]/run-1/report.md',
      ]);
      expect(out.join('')).not.toContain('hunter2');
    });
  });
});
