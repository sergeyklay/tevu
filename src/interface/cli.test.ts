// @vitest-environment node

import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGitHubPullRequestReader } from '@/adapters/trackers/github-issues';
import { resolveReferenceSolution } from '@/application/reference-solution';
import { renderConfigDocument } from '@/config/document';
import { parseConfigText } from '@/config/load';
import { TevuConfigSchema } from '@/config/schema';
import { CONFIG_TEMPLATE } from '@/config/template';

import { createProgram, runProgram } from './program';

import type {
  BenchmarkExecutionHooks,
  ProgramDependencies,
  ProgramIo,
  ProgramOperations,
} from './program';
import type { GhRun } from '@/adapters/trackers/github-issues';
import type { AssessableCheckSummary, AssessmentCaseContext } from '@/application/assess';
import type { TaskWizardInput } from '@/application/create-task';
import type { CriteriaDraftFailure } from '@/application/draft-criteria';
import type { ModelAccessOutcome } from '@/application/model-access';
import type { CheckInput, ModelDefinitionInput, TaskInput, TevuConfigInput } from '@/config/schema';
import type {
  AgentCapabilityReport,
  AssessmentRecord,
  BenchmarkMetrics,
  BenchmarkPlan,
  CaseIdentity,
  CaseResult,
  ConfigReadCause,
  GradeRecord,
  GraderIdentity,
  IssueSnapshot,
  JiraTrackerSettings,
  ManagedCloneAdapter,
  OperatorProvider,
  ReportResult,
  RunFinding,
  RunResult,
  TaskDefinition,
  TevuConfig,
  TevuError,
  ValidationFinding,
  ValidationReport,
} from '@/domain/types';

type AskOptions = {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  initialValue?: unknown;
  options?: Array<{ label?: string; hint?: string; disabled?: boolean }>;
  signal?: AbortSignal;
  statusLine?: unknown;
  validate?: (value: string | undefined) => string | undefined;
};

const clack = vi.hoisted(() => {
  const CANCEL = Symbol('clack-cancel');
  const ESCAPE = Symbol('clack-escape');
  const state = {
    prompts: [] as Array<{
      kind: string;
      message: string;
      placeholder: string | undefined;
      defaultValue: string | undefined;
      initialValue: unknown;
      options: Array<{ label: string; hint: string | undefined; disabled: boolean }> | undefined;
    }>,
    notes: [] as Array<{ message: string; title: string | undefined }>,
    logs: [] as Array<{ kind: string; message: string }>,
    rejections: [] as Array<{ kind: string; message: string; reason: string }>,
    answers: [] as unknown[],
    cancels: [] as string[],
    outros: [] as string[],
    spinners: [] as Array<{ label: string; handleSignals: boolean | undefined }>,
    timeline: [] as string[],
    statusLines: [] as Array<{ message: string; statusLine: unknown }>,
    sectionedSelects: [] as Array<{
      message: string;
      sections: ReadonlyArray<{
        heading?: string;
        options: ReadonlyArray<{ value: string; label: string }>;
      }>;
      back: { value: string; label: string };
    }>,
  };
  const isInvalidMarker = (value: unknown): value is { invalid: string } =>
    typeof value === 'object' && value !== null && 'invalid' in value;
  const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
  const isInterruption = (value: unknown): value is () => void => typeof value === 'function';
  const applyDefault = (kind: string, options: AskOptions, answer: unknown): unknown =>
    kind === 'text' && answer === '' && options.defaultValue !== undefined
      ? options.defaultValue
      : answer;
  const ask = async (kind: string, options: AskOptions): Promise<unknown> => {
    for (;;) {
      state.prompts.push({
        kind,
        message: options.message,
        placeholder: options.placeholder,
        defaultValue: options.defaultValue,
        initialValue: options.initialValue,
        options: options.options?.map((option) => ({
          label: option.label ?? '',
          hint: option.hint,
          disabled: option.disabled === true,
        })),
      });
      state.statusLines.push({ message: options.message, statusLine: options.statusLine });
      state.timeline.push(`prompt:${options.message}`);
      if (isAborted(options.signal)) {
        return CANCEL;
      }
      const answer = state.answers.shift();
      if (answer === undefined) {
        throw new Error(`no scripted answer left for ${kind}: ${options.message}`);
      }
      if (answer === ESCAPE) {
        throw new Error(
          `Escape is scripted only at sectionedSelect prompts, not at ${kind}: ${options.message}`,
        );
      }
      if (isInterruption(answer)) {
        answer();
        if (isAborted(options.signal)) {
          return CANCEL;
        }
        continue;
      }
      if (isInvalidMarker(answer)) {
        const reason = options.validate?.(answer.invalid);
        if (reason !== undefined) {
          state.rejections.push({ kind, message: options.message, reason });
          continue;
        }
        return applyDefault(kind, options, answer.invalid);
      }
      return applyDefault(kind, options, answer);
    }
  };
  return { CANCEL, ESCAPE, state, ask };
});

vi.mock('@clack/prompts', () => {
  const recordLog = (kind: string, message: string): void => {
    clack.state.logs.push({ kind, message });
    clack.state.timeline.push(`log:${kind}`);
  };
  return {
    multiselect: (options: AskOptions) => clack.ask('multiselect', options),
    intro: (message: string) => {
      clack.state.prompts.push({
        kind: 'intro',
        message,
        placeholder: undefined,
        defaultValue: undefined,
        initialValue: undefined,
        options: undefined,
      });
      clack.state.timeline.push('intro');
    },
    outro: (message: string) => {
      clack.state.outros.push(message);
      clack.state.timeline.push('outro');
    },
    cancel: (message: string) => {
      clack.state.cancels.push(message);
      clack.state.timeline.push('cancel');
    },
    note: (message: string, title?: string) => {
      clack.state.notes.push({ message, title });
    },
    log: {
      info: (message: string) => {
        recordLog('info', message);
      },
      warn: (message: string) => {
        recordLog('warn', message);
      },
      step: (message: string) => {
        recordLog('step', message);
      },
      message: (message: string) => {
        recordLog('message', message);
      },
      success: (message: string) => {
        recordLog('success', message);
      },
    },
    isCancel: (value: unknown) => value === clack.CANCEL,
  };
});

vi.mock('./wizard-prompts', () => ({
  text: (options: AskOptions) => clack.ask('text', options),
  confirm: (options: AskOptions) => clack.ask('confirm', options),
  select: (options: AskOptions) => clack.ask('select', options),
}));

vi.mock('./sectioned-select', () => ({
  sectionedSelect: async (options: {
    message: string;
    sections: (typeof clack.state.sectionedSelects)[number]['sections'];
    back: { value: string; label: string };
    signal?: AbortSignal;
    statusLine?: unknown;
  }): Promise<unknown> => {
    const isAborted = (): boolean => options.signal?.aborted === true;
    clack.state.statusLines.push({ message: options.message, statusLine: options.statusLine });
    clack.state.sectionedSelects.push({
      message: options.message,
      sections: options.sections,
      back: options.back,
    });
    for (;;) {
      clack.state.timeline.push(`prompt:${options.message}`);
      if (isAborted()) {
        return clack.CANCEL;
      }
      const answer = clack.state.answers.shift();
      if (answer === undefined) {
        throw new Error(`no scripted answer left for sectionedSelect: ${options.message}`);
      }
      if (answer === clack.ESCAPE) {
        return options.back.value;
      }
      if (typeof answer === 'function') {
        answer();
        if (isAborted()) {
          return clack.CANCEL;
        }
        continue;
      }
      return answer;
    }
  },
}));

vi.mock('yocto-spinner', () => ({
  default: (options: { text?: string; handleSignals?: boolean }) => {
    const label = (options.text ?? '').trim();
    clack.state.spinners.push({ label, handleSignals: options.handleSignals });
    return {
      start: () => {
        clack.state.timeline.push(`spinner:start:${label}`);
      },
      stop: () => {
        clack.state.timeline.push(`spinner:stop:${label}`);
      },
    };
  },
}));

vi.mock('stdin-discarder', () => ({
  default: {
    start: () => {
      clack.state.timeline.push('discarder:start');
    },
    stop: () => {
      clack.state.timeline.push('discarder:stop');
    },
  },
}));

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
      grading: null,
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
      tools: {
        gitVersion: '2.47.0',
        agentVersions: { [AGENT_NAME]: '1.18.32' },
        agentConfigurationFiles: {},
      },
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

function buildManualCheckSummary(
  overrides: Partial<AssessableCheckSummary> = {},
): AssessableCheckSummary {
  return {
    checkId: 'acc-1',
    category: 'acceptance',
    description: 'Export produces a CSV',
    required: true,
    evaluator: 'manual',
    ...overrides,
  } as AssessableCheckSummary;
}

function buildGrader(overrides: Partial<GraderIdentity> = {}): GraderIdentity {
  return { model: 'openai/grader-model', effort: 'high', agent: AGENT_NAME, ...overrides };
}

function buildGradedCheckSummary(
  overrides: Partial<AssessableCheckSummary> & { grade?: GradeRecord | null } = {},
): AssessableCheckSummary {
  return {
    checkId: 'acc-1',
    category: 'acceptance',
    description: 'The criterion holds.',
    required: true,
    evaluator: 'grader',
    grade: null,
    grader: null,
    ...overrides,
  } as AssessableCheckSummary;
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
    checks: [buildManualCheckSummary()],
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

function failingManagedCloneAdapter(): ManagedCloneAdapter {
  const fail = (): never => {
    throw new Error('unexpected managed-clone call for a path repository');
  };
  return { inspectClone: fail, clone: fail, fetchCommits: fail, fetchBranchesAndTags: fail };
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
    resolveReference: vi.fn(async () => {
      throw new Error('resolveReference should not be called without a scripted reference answer');
    }),
    ensureManagedCommits: vi.fn(async () => {
      throw new Error('ensureManagedCommits should not be called without a scripted GitHub entry');
    }),
    draftCriteria: vi.fn(async () => {
      throw new Error(
        'draftCriteria should not be called without a resolved reference and a declared criteria role',
      );
    }),
    probeAgent: vi.fn(async () => ({ ok: true as const, value: buildCapabilityReport() })),
    inspectModelProvider: vi.fn(async (_configPath, _agent, model) => ({
      ok: true as const,
      value: {
        provider: model.slice(0, model.indexOf('/')),
        definition: { defined: false as const },
      },
    })),
    checkModelAccess: vi.fn(async () => ({
      status: 'listed' as const,
      unsetVariables: [],
      retainedDirectory: null,
    })),
    prepareRepositories: vi.fn(async () => ({ ok: true as const, value: [] })),
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

/** Wraps a fake operation so the shared timeline shows when it started and ended. */
function recordOperation<Args extends unknown[], Result>(
  name: string,
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    clack.state.timeline.push(`operation:${name}:start`);
    try {
      return await operation(...args);
    } finally {
      clack.state.timeline.push(`operation:${name}:end`);
    }
  };
}

/** A scripted answer that interrupts the command while the prompt that consumes it is open. */
function interruptWith(controller: AbortController): () => void {
  return () => {
    controller.abort();
  };
}

function managedCloneFailure(): Extract<TevuError, { kind: 'ManagedCloneError' }> {
  return {
    kind: 'ManagedCloneError',
    operation: 'clone',
    repository: 'github.com/octo/app',
    reason: 'git clone exited with code 128',
  };
}

function buildGitHubRepositoryConfig(overrides: Partial<TevuConfig> = {}): TevuConfig {
  return {
    ...buildTevuConfig({ repositories: [{ id: 'repo-1', github: 'octo/app' }] }),
    ...overrides,
  };
}

function expectNoWrites(operations: ProgramOperations): void {
  expect(operations.createTask).not.toHaveBeenCalled();
  expect(operations.executeBenchmark).not.toHaveBeenCalled();
  expect(operations.rebuildRunReport).not.toHaveBeenCalled();
  expect(operations.applyAssessment).not.toHaveBeenCalled();
}

function requireCreateTaskCall(operations: ProgramOperations): TaskWizardInput {
  const call = vi.mocked(operations.createTask).mock.calls[0]?.[0];
  if (call === undefined) {
    throw new Error('expected createTask to have captured one call');
  }
  return call;
}

/**
 * Renders the bootstrap answers and interviewed task through the real
 * document writer, then re-parses the result with the real config parser -
 * the same round trip `createTask` performs before its only write.
 */
function renderAndParseBootstrap(call: TaskWizardInput): TevuConfig {
  if (call.bootstrap === undefined) {
    throw new Error('expected the captured createTask call to carry bootstrap answers');
  }
  const rendered = renderConfigDocument(
    { version: 1, ...call.bootstrap, tasks: [call.task] },
    { redact: (text) => text },
  );
  if (!rendered.ok) {
    throw new Error(`expected renderConfigDocument to succeed: ${JSON.stringify(rendered.error)}`);
  }
  const parsed = parseConfigText(rendered.value);
  if (!parsed.ok) {
    throw new Error(`expected the written configuration to parse: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
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
    '',
    'abc123',
    'task-2',
    'Add an export button',
    'Export the current view as CSV.',
    'Implement CSV export for the current view.',
    'Repository is readable',
    false,
    'acc-1',
    'manual',
    'Export produces a CSV',
    true,
    false,
    'dod-1',
    'manual',
    'README documents the button',
    true,
    false,
  ];
}

/** Answers the questions of one command check, each entry listing the answers its question consumes in order. */
function commandCheckAnswers(
  overrides: {
    command?: readonly unknown[];
    timeLimit?: readonly unknown[];
    variables?: readonly unknown[];
  } = {},
): unknown[] {
  return [
    'acc-1',
    'command',
    'The test suite passes',
    true,
    ...(overrides.command ?? ['npm test -- --run']),
    ...(overrides.timeLimit ?? ['']),
    '',
    ...(overrides.variables ?? ['']),
    false,
  ];
}

/** Answers a whole task interview around a scripted acceptance check, ending after the last check. */
function taskAnswersWithAcceptanceCheck(
  repositoryChoice: string,
  acceptanceCheck: readonly unknown[],
): unknown[] {
  return [
    'manual',
    repositoryChoice,
    '',
    'abc123',
    'task-2',
    'Add an export button',
    'Export the current view as CSV.',
    'Implement CSV export for the current view.',
    'Repository is readable',
    false,
    ...acceptanceCheck,
    'dod-1',
    'manual',
    'README documents the button',
    true,
    false,
  ];
}

const REFERENCE_HASH = '0123456789abcdef0123456789abcdef01234567';
const REFERENCE_PARENT = 'fedcba9876543210fedcba9876543210fedcba98';

/** A configuration whose `roles.criteria` is declared. */
function buildCriteriaConfig(): TevuConfig {
  return {
    ...buildTevuConfig(),
    roles: {
      criteria: { model: 'openai/criteria-model', effort: 'high', agent: AGENT_NAME },
    },
  };
}

function buildResolvedCommitReference(): {
  reference: { kind: 'commit'; identifier: string; commits: [string] };
  proposedBase: { commit: string; basis: 'commit-parent' };
} {
  return {
    reference: { kind: 'commit', identifier: 'HEAD~3', commits: [REFERENCE_HASH] },
    proposedBase: { commit: REFERENCE_PARENT, basis: 'commit-parent' },
  };
}

/** Answers every task question from the source through the readiness list when a reference resolves. */
const READY_ANSWERS = [
  'manual',
  'repo-1',
  'HEAD~3',
  '',
  'task-2',
  'Add an export button',
  'Export the current view as CSV.',
  'Implement CSV export for the current view.',
  'Repository is readable',
  false,
];

const BOOTSTRAP_PROMPTS = [
  'Output directory',
  'Concurrent cases',
  'Agent time limit',
  'Stop grace period',
  'Check time limit',
  'Agent command',
  'Secret variable names',
  'Non-secret variable names',
  'Import issues from Jira?',
  'Repository ID',
  'Repository source',
  'Local path',
  'Add another repository?',
  'Model entry ID',
  'Model',
  'Reasoning effort',
  'Model entry ID',
  'Model',
  'Reasoning effort',
  'Add another model?',
  'Grade checks with a model?',
];

/** Answers every setup question up to and including "Add another model?" without typing the defaults. */
const BOOTSTRAP_ANSWERS: unknown[] = [
  '/tmp/bench-artifacts',
  '4',
  '10m',
  '5s',
  '',
  'opencode',
  '',
  '',
  false,
  'alpha',
  'path',
  '../repos/alpha',
  false,
  'c1',
  'provider/model-a',
  'high',
  'c2',
  'provider/model-b',
  'low',
  false,
];

/** The failed-draft causes with the lines the wizard prints after its headline and before its last line. */
const DRAFT_FAILURE_CASES: Array<{
  name: string;
  failure: CriteriaDraftFailure;
  lines: string[];
}> = [
  {
    name: 'unreadable changes',
    failure: { cause: 'changes-unreadable', detail: 'git-diff: bad object' },
    lines: ["The reference solution's changes can't be read.", 'git-diff: bad object'],
  },
  {
    name: 'an unredactable prompt',
    failure: { cause: 'prompt-unredactable' },
    lines: ["The prompt couldn't be redacted, so the model wasn't called."],
  },
  {
    name: 'one unset variable',
    failure: { cause: 'variables-unset', names: ['ACME_KEY'] },
    lines: ["ACME_KEY isn't set in this terminal."],
  },
  {
    name: 'several unset variables',
    failure: { cause: 'variables-unset', names: ['ACME_KEY', 'ACME_BASE'] },
    lines: ["ACME_KEY, ACME_BASE aren't set in this terminal."],
  },
  {
    name: "the operator's model missing from the environment",
    failure: { cause: 'model-unavailable', model: 'litellm/anthropic/claude-opus-5' },
    lines: [
      "OpenCode can't find litellm/anthropic/claude-opus-5 in tevu's environment.",
      'Add its provider to agents.opencode.providers in tevu.yaml.',
    ],
  },
  {
    name: 'a timeout',
    failure: { cause: 'timed-out', limit: '10m' },
    lines: ["The model didn't answer within 10m."],
  },
  {
    name: 'a failure that carries the agent message',
    failure: {
      cause: 'call-failed',
      agentMessage: 'Unexpected server error. Check server logs for details.',
      detail: 'run process exited with code 1: Unexpected server error.',
    },
    lines: ['OpenCode reported "Unexpected server error. Check server logs for details.".'],
  },
  {
    name: 'a failure without an agent message',
    failure: { cause: 'call-failed', detail: 'ModelCallError (failed): synthetic failure' },
    lines: ['The OpenCode call failed.', 'ModelCallError (failed): synthetic failure'],
  },
  {
    name: 'an invalid reply',
    failure: { cause: 'reply-invalid', defect: 'done is not an array' },
    lines: ["The model's reply wasn't a usable list."],
  },
];

function draftFailureMessage(lines: readonly string[]): string {
  return ["Couldn't draft criteria.", ...lines, 'Enter the criteria yourself.'].join('\n');
}

/**
 * The setup answers from the first question through "Add another model?".
 * An option replaces the answers its question consumes, so a test can script
 * an extra answer (a retry, a key variable) where the interview asks for it.
 */
function setupAnswers(
  options: {
    command?: readonly unknown[];
    secrets?: string;
    env?: string;
    jira?: readonly unknown[];
    firstModel?: readonly unknown[];
    secondModel?: readonly unknown[];
  } = {},
): unknown[] {
  return [
    ...BOOTSTRAP_ANSWERS.slice(0, 5),
    ...(options.command ?? ['opencode']),
    options.secrets ?? '',
    options.env ?? '',
    ...(options.jira ?? [false]),
    ...BOOTSTRAP_ANSWERS.slice(9, 14),
    ...(options.firstModel ?? ['provider/model-a']),
    'high',
    'c2',
    ...(options.secondModel ?? ['provider/model-b']),
    'low',
    false,
  ];
}

/** A complete setup and task interview that declines both roles and saves. */
function fullSetupAnswers(options: Parameters<typeof setupAnswers>[0] = {}): unknown[] {
  return [...setupAnswers(options), false, false, ...taskInterviewAnswers('alpha'), true];
}

function operationsWithModelCheck(overrides: Partial<ProgramOperations> = {}): ProgramOperations {
  return createOperations({ configExists: vi.fn(async () => false), ...overrides });
}

function definedProvider(
  overrides: Partial<Extract<OperatorProvider, { defined: true }>> = {},
): OperatorProvider {
  return { defined: true, keyVariables: [], otherVariables: [], apiKey: 'absent', ...overrides };
}

/** Answers `inspectModelProvider` from a table keyed by provider; an absent provider is undefined. */
function inspectingProviders(
  definitions: Record<string, OperatorProvider>,
): ProgramOperations['inspectModelProvider'] {
  return vi.fn<ProgramOperations['inspectModelProvider']>(async (_configPath, _agent, model) => {
    const provider = model.slice(0, model.indexOf('/'));
    return {
      ok: true as const,
      value: { provider, definition: definitions[provider] ?? { defined: false as const } },
    };
  });
}

function accessOutcome(
  status: 'listed' | 'not-listed',
  overrides: { unsetVariables?: string[]; retainedDirectory?: string | null } = {},
): ModelAccessOutcome {
  return { status, unsetVariables: [], retainedDirectory: null, ...overrides };
}

function requireAgentBlock(
  operations: ProgramOperations,
): NonNullable<TaskWizardInput['bootstrap']>['agents']['opencode'] {
  const agent = requireCreateTaskCall(operations).bootstrap?.agents.opencode;
  if (agent === undefined) {
    throw new Error('expected the captured createTask call to carry an agent block');
  }
  return agent;
}

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
    description: 'Record manual and graded check verdicts',
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
    clack.state.cancels = [];
    clack.state.outros = [];
    clack.state.spinners = [];
    clack.state.timeline = [];
    clack.state.sectionedSelects = [];
    clack.state.statusLines = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

    it('prints roles.criteria before roles.grader (AC-13)', async () => {
      const { dependencies } = await runCli(['config', 'example']);

      const printed = (dependencies.io.stdout as MemoryStream).text;
      expect(printed.indexOf('  criteria:')).toBeLessThan(printed.indexOf('  grader:'));
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

    it('never calls prepareRepositories and prints no progress line (AC-10)', async () => {
      const operations = createOperations();

      const { out } = await runCli(['validate'], { operations });

      expect(out).toEqual(['Configuration: tevu.yaml', 'Configuration is valid.']);
      expect(operations.prepareRepositories).not.toHaveBeenCalled();
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

  describe('repository preparation (AC-9, AC-10)', () => {
    it.each([{ argv: ['run', '--dry-run'] }, { argv: ['run'] }])(
      'prints preparation progress and warning lines before validation output for tevu $argv',
      async ({ argv }) => {
        const operations = createOperations({
          prepareRepositories: vi.fn(async (_config, onProgress: (line: string) => void) => {
            onProgress(
              'Cloning github.com/octo/app for repository "repo-1" into /cache/github.com/octo/app.git',
            );
            return {
              ok: true as const,
              value: [
                {
                  severity: 'warning' as const,
                  identifier: 'tasks.task-1.reference',
                  message:
                    'reference commits cannot be fetched from github.com/octo/app: git fetch timed out',
                },
              ],
            };
          }),
        });

        const { code, out } = await runCli(argv, { operations });

        expect(code).toBe(0);
        expect(out.slice(0, 3)).toEqual([
          'Configuration: tevu.yaml',
          'Cloning github.com/octo/app for repository "repo-1" into /cache/github.com/octo/app.git',
          'warning tasks.task-1.reference: reference commits cannot be fetched from github.com/octo/app: git fetch timed out',
        ]);
        expect(vi.mocked(operations.prepareRepositories)).toHaveBeenCalledExactlyOnceWith(
          buildTevuConfig(),
          expect.any(Function),
        );
        expect(vi.mocked(operations.validateConfig)).toHaveBeenCalledOnce();
      },
    );

    it('maps a ManagedCloneError from prepareRepositories to exit 1 and never validates', async () => {
      const operations = createOperations({
        prepareRepositories: vi.fn(async () => ({
          ok: false as const,
          error: {
            kind: 'ManagedCloneError' as const,
            operation: 'clone' as const,
            repository: 'github.com/octo/app',
            reason: 'git clone exited with code 128',
          },
        })),
      });

      const { code, out, err } = await runCli(['run', '--dry-run'], { operations });

      expect(code).toBe(1);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(err).toEqual([
        'error: cloning github.com/octo/app failed: git clone exited with code 128',
      ]);
      expect(operations.validateConfig).not.toHaveBeenCalled();
      expect(operations.planBenchmark).not.toHaveBeenCalled();
    });

    it('maps a CancellationError from prepareRepositories to exit 130', async () => {
      const operations = createOperations({
        prepareRepositories: vi.fn(async () => ({
          ok: false as const,
          error: { kind: 'CancellationError' as const, activeCaseIds: [] },
        })),
      });

      const { code, err } = await runCli(['run'], { operations });

      expect(code).toBe(130);
      expect(err).toEqual(['Cancelled.']);
      expect(operations.validateConfig).not.toHaveBeenCalled();
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
      scriptAnswers(...BOOTSTRAP_ANSWERS, clack.CANCEL);

      const { code, err } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(err).toEqual([]);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
        'tevu task add',
        ...BOOTSTRAP_PROMPTS,
      ]);
      expect(vi.mocked(operations.configExists)).toHaveBeenCalledExactlyOnceWith('tevu.yaml');
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.createTask).not.toHaveBeenCalled();
      expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
    });

    const GITHUB_GRAMMAR_MESSAGE =
      'github must be OWNER/REPO or https://HOST/OWNER/REPO, with a HOST of letters, digits, hyphens, and dots, and without surrounding spaces, user info, a port, a query, or a fragment';

    it('offers the GitHub repository option during bootstrap and re-prompts on a malformed answer (AC-7)', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        '/tmp/bench-artifacts',
        '4',
        '10m',
        '5s',
        '',
        'opencode',
        '',
        '',
        false,
        'alpha',
        'github',
        { invalid: 'bad repo' },
        'octo/app',
        clack.CANCEL,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
        'tevu task add',
        ...BOOTSTRAP_PROMPTS.slice(0, 10),
        'Repository source',
        'GitHub repository',
        'GitHub repository',
        'Add another repository?',
      ]);
      expect(clack.state.rejections).toEqual([
        { kind: 'text', message: 'GitHub repository', reason: GITHUB_GRAMMAR_MESSAGE },
      ]);
    });

    it('re-asks the Repository select on a ManagedCloneError, keeping every earlier answer (AC-9)', async () => {
      const config = buildTevuConfig({ repositories: [{ id: 'repo-1', github: 'octo/app' }] });
      const ensureManagedCommits = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false as const,
          error: {
            kind: 'ManagedCloneError' as const,
            operation: 'clone' as const,
            repository: 'github.com/octo/app',
            reason: 'git clone exited with code 128',
          },
        })
        .mockResolvedValue({ ok: true as const, value: { missing: [] } });
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
        ensureManagedCommits,
      });
      const remainingTaskAnswers = taskInterviewAnswers('repo-1').slice(2);
      scriptAnswers('manual', 'repo-1', 'repo-1', ...remainingTaskAnswers, true);

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(clack.state.prompts.filter((prompt) => prompt.message === 'Repository')).toHaveLength(
        2,
      );
      expect(clack.state.logs).toContainEqual({
        kind: 'warn',
        message:
          "Can't use repository repo-1.\ncloning github.com/octo/app failed: git clone exited with code 128",
      });
      expect(ensureManagedCommits).toHaveBeenCalledWith(
        { repository: { id: 'repo-1', github: 'octo/app' }, revisions: [] },
        expect.any(Function),
      );
    });

    it('bootstraps the complete configuration, re-prompts invalid integers, and lets createTask perform the only write', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        '/tmp/bench-artifacts',
        { invalid: 'abc' },
        ...BOOTSTRAP_ANSWERS.slice(1),
        false,
        false,
        ...taskInterviewAnswers('alpha'),
        true,
      );

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
      expect(clack.state.rejections).toEqual([
        {
          kind: 'text',
          message: 'Concurrent cases',
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
            check_timeout: '5m',
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

    it('declares roles.grader in the bootstrap answers when the operator opts in, and the written configuration parses with the role (P11)', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        ...BOOTSTRAP_ANSWERS,
        true,
        'openai/grader-model',
        'high',
        false,
        ...taskInterviewAnswers('alpha'),
        true,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual(
        expect.arrayContaining([...BOOTSTRAP_PROMPTS, 'Grader model', 'Grader effort']),
      );
      const call = requireCreateTaskCall(operations);
      expect(call.bootstrap?.roles).toEqual({
        grader: { model: 'openai/grader-model', effort: 'high' },
      });

      const parsed = renderAndParseBootstrap(call);

      expect(parsed.roles?.grader).toEqual(buildGrader({ agent: 'opencode' }));
    });

    it('asks the criteria question after the grader question and declares roles.criteria when the operator opts in (E5)', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        ...BOOTSTRAP_ANSWERS,
        false,
        true,
        'openai/criteria-model',
        'high',
        ...taskInterviewAnswers('alpha'),
        true,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      const graderIndex = clack.state.prompts.findIndex(
        (prompt) => prompt.message === 'Grade checks with a model?',
      );
      const criteriaIndex = clack.state.prompts.findIndex(
        (prompt) => prompt.message === 'Draft criteria with a model?',
      );
      expect(graderIndex).toBeGreaterThanOrEqual(0);
      expect(criteriaIndex).toBeGreaterThan(graderIndex);
      const call = requireCreateTaskCall(operations);
      expect(call.bootstrap?.roles).toEqual({
        criteria: { model: 'openai/criteria-model', effort: 'high' },
      });

      const parsed = renderAndParseBootstrap(call);

      expect(parsed.roles?.criteria).toEqual({
        model: 'openai/criteria-model',
        effort: 'high',
        agent: 'opencode',
      });
    });

    it('omits roles from the bootstrap answers when the operator declines a grader model, and the written configuration still parses (P11)', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(...BOOTSTRAP_ANSWERS, false, false, ...taskInterviewAnswers('alpha'), true);

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      const call = requireCreateTaskCall(operations);
      expect(call.bootstrap?.roles).toBeUndefined();

      const parsed = renderAndParseBootstrap(call);

      expect(parsed.roles?.grader).toBeUndefined();
      expect(parsed.roles?.criteria).toBeUndefined();
    });

    it('re-prompts the grader model question until the answer is a valid provider/model identifier', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        ...BOOTSTRAP_ANSWERS,
        true,
        { invalid: 'not-a-model' },
        'openai/grader-model',
        clack.CANCEL,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
        'tevu task add',
        ...BOOTSTRAP_PROMPTS,
        'Grader model',
        'Grader model',
        'Grader effort',
      ]);
      expect(clack.state.rejections).toEqual([
        { kind: 'text', message: 'Grader model', reason: 'model must be "<provider>/<model>"' },
      ]);
      expect(operations.createTask).not.toHaveBeenCalled();
    });

    it('captures a task against an existing configuration and lets createTask perform the only write', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), true);

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
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
      expect(out).toEqual([`Configuration: ${foundPath}`]);
      expect(clack.state.outros).toEqual([`Task task-2 added to ${foundPath}`]);
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
      scriptAnswers(...BOOTSTRAP_ANSWERS, false, false, ...taskInterviewAnswers('alpha'), true);

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: /work/tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to /work/tevu.yaml']);
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
        '',
        'abc123',
        'task-2',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
        false,
        'acc-1',
        'manual',
        'Export produces a CSV',
        true,
        false,
        'dod-1',
        'manual',
        'README documents the button',
        true,
        false,
        true,
      );

      const { code, out } = await runCli(['task', 'add', '--jira', 'TEVU-42'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
      expect(vi.mocked(operations.importJiraIssue)).toHaveBeenCalledExactlyOnceWith(
        jiraSettings,
        'TEVU-42',
      );
      expect(clack.state.notes).toContainEqual({
        title: 'Imported TEVU-42',
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
        '',
        'abc123',
        'task-2',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
        false,
        'acc-1',
        'manual',
        'Export produces a CSV',
        true,
        false,
        'dod-1',
        'manual',
        'README documents the button',
        true,
        false,
        true,
      );

      const { code, out } = await runCli(['task', 'add', '--github', 'octo/repo#42'], {
        operations,
      });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
      expect(vi.mocked(operations.importGitHubIssue)).toHaveBeenCalledExactlyOnceWith(
        'octo/repo#42',
      );
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(clack.state.notes).toContainEqual({
        title: 'Imported octo/repo#42',
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
        expect(err).toEqual([]);
        expect(operations.createTask).not.toHaveBeenCalled();
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
      },
    );

    it('cancels at the review confirmation without calling createTask', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), false);

      const { code, err } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(err).toEqual([]);
      expect(operations.createTask).not.toHaveBeenCalled();
      expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
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

    it('adds a task exactly as without a reference when the reference question is left empty', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), true);

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(operations.resolveReference).not.toHaveBeenCalled();
      expect(operations.draftCriteria).not.toHaveBeenCalled();
      expect(
        clack.state.prompts.find((prompt) => prompt.message === 'Reference PR or commit'),
      ).toMatchObject({
        placeholder: 'none',
        defaultValue: '',
      });
      expect(clack.state.prompts.find((prompt) => prompt.message === 'Base commit')).toMatchObject({
        placeholder: undefined,
        defaultValue: undefined,
      });
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task).not.toHaveProperty(
        'reference',
      );
      const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
      expect(reviewNote?.message).not.toContain('reference');
    });

    it('resolves a local commit reference, retries after a failed resolution, and proposes its parent as the base commit', async () => {
      const hash = '0123456789abcdef0123456789abcdef01234567';
      const parent = 'fedcba9876543210fedcba9876543210fedcba98';
      const resolveReference = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false as const,
          error: {
            kind: 'ReferenceResolutionError' as const,
            reason: 'the answer does not name a commit',
          },
        })
        .mockResolvedValueOnce({
          ok: true as const,
          value: {
            reference: { kind: 'commit' as const, identifier: 'HEAD~3', commits: [hash] },
            proposedBase: { commit: parent, basis: 'commit-parent' as const },
          },
        });
      const operations = createOperations({ resolveReference });
      scriptAnswers(
        'manual',
        'repo-1',
        'bad-ref',
        'HEAD~3',
        '',
        'task-2',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
        false,
        'acc-1',
        'manual',
        'Export produces a CSV',
        true,
        false,
        'dod-1',
        'manual',
        'README documents the button',
        true,
        false,
        true,
      );

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
      expect(resolveReference).toHaveBeenCalledTimes(2);
      expect(resolveReference.mock.calls[0]?.[0]).toEqual({
        configPath: 'tevu.yaml',
        repository: { id: 'repo-1', path: '../repos/fixture' },
        identifier: 'bad-ref',
      });
      expect(resolveReference.mock.calls[1]?.[0]).toEqual({
        configPath: 'tevu.yaml',
        repository: { id: 'repo-1', path: '../repos/fixture' },
        identifier: 'HEAD~3',
      });
      expect(clack.state.logs).toContainEqual({
        kind: 'warn',
        message: "Can't resolve the reference.\nthe answer does not name a commit",
      });
      expect(clack.state.notes).toContainEqual({
        title: 'Reference solution',
        message: `Commit ${hash} in "repo-1"\nProposed base: ${parent} (the parent of the reference commit)`,
      });
      expect(clack.state.prompts.find((prompt) => prompt.message === 'Base commit')).toMatchObject({
        placeholder: parent,
        defaultValue: parent,
      });
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task).toMatchObject({
        base_commit: parent,
        reference: { kind: 'commit', identifier: 'HEAD~3', commits: [hash] },
      });
      const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
      expect(reviewNote?.message).toContain('  reference: commit HEAD~3\n  reference commits: 1');
    });

    it('resolves a pull-request reference through resolveReferenceSolution over a fake gh, recording its merge commit', async () => {
      const headHash = 'a'.repeat(40);
      const parentHash = 'b'.repeat(40);
      const targetTipHash = 'c'.repeat(40);
      const mergeHash = 'd'.repeat(40);
      const page = {
        data: {
          repository: {
            pullRequest: {
              number: 128,
              url: 'https://github.com/octo/app/pull/128',
              state: 'MERGED',
              headRefOid: headHash,
              baseRefName: 'main',
              baseRef: { target: { oid: targetTipHash } },
              mergeCommit: { oid: mergeHash },
              mergeable: 'MERGEABLE',
              commits: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    commit: {
                      oid: headHash,
                      parents: { totalCount: 1, nodes: [{ oid: parentHash }] },
                    },
                  },
                ],
              },
            },
          },
        },
      };
      const runGh: GhRun = vi.fn(async () => ({
        launched: true as const,
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        stdout: { text: JSON.stringify([page]), truncated: false },
        stderr: { text: '', truncated: false },
      }));
      const operations = createOperations({
        resolveReference: (request, onProgress) =>
          resolveReferenceSolution(request, {
            git: { resolveCommit: async () => ({ kind: 'not-found' as const }) },
            clones: failingManagedCloneAdapter(),
            managedCloneRoot: undefined,
            onProgress,
            pullRequests: createGitHubPullRequestReader({
              runGh,
              parentEnvironment: {},
              cancellation: new AbortController().signal,
            }),
          }),
      });
      scriptAnswers(
        'manual',
        'repo-1',
        'octo/app#128',
        '',
        'task-2',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
        false,
        'acc-1',
        'manual',
        'Export produces a CSV',
        true,
        false,
        'dod-1',
        'manual',
        'README documents the button',
        true,
        false,
        true,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(runGh).toHaveBeenCalledTimes(1);
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task).toMatchObject({
        base_commit: parentHash,
        reference: {
          kind: 'pull-request',
          identifier: 'octo/app#128',
          commits: [headHash],
          merge_commit: mergeHash,
        },
      });
      expect(clack.state.notes).toContainEqual({
        title: 'Reference solution',
        message: `Pull request octo/app#128 (merged) into main\nCommits: 1, merge commit ${mergeHash}\nProposed base: ${parentHash} (the parent of the pull request's first commit)`,
      });
      const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
      expect(reviewNote?.message).toContain(`  reference merge commit: ${mergeHash}`);
    });

    it.each([
      {
        description: 'a conflicting pull request',
        snapshotOverrides: { mergeable: 'CONFLICTING' },
        expectedWarning:
          'Pull request octo/app#128 conflicts with main; the proposed base is the parent of its first commit, not the tip of main',
      },
      {
        description: 'a closed, mergeable pull request',
        snapshotOverrides: { state: 'CLOSED' },
        expectedWarning:
          'Pull request octo/app#128 is closed, and GitHub does not recheck closed pull requests against main; the proposed base is the tip of main; if it conflicts, enter bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, the parent of its first commit',
      },
      {
        description: 'a pull request with unknown mergeability',
        snapshotOverrides: { mergeable: null },
        expectedWarning:
          'GitHub has not determined whether pull request octo/app#128 conflicts with main; the proposed base is the tip of main; if it conflicts, enter bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, the parent of its first commit',
      },
      {
        description: 'a pull request whose target branch was deleted',
        snapshotOverrides: { baseRef: null },
        expectedWarning:
          'Branch main of pull request octo/app#128 no longer exists on GitHub; the proposed base is the parent of its first commit',
      },
    ])('prints the warning for $description', async ({ snapshotOverrides, expectedWarning }) => {
      const headHash = 'a'.repeat(40);
      const parentHash = 'b'.repeat(40);
      const targetTipHash = 'c'.repeat(40);
      const page = {
        data: {
          repository: {
            pullRequest: {
              number: 128,
              url: 'https://github.com/octo/app/pull/128',
              state: 'OPEN',
              headRefOid: headHash,
              baseRefName: 'main',
              baseRef: { target: { oid: targetTipHash } },
              mergeCommit: null,
              mergeable: 'MERGEABLE',
              commits: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    commit: {
                      oid: headHash,
                      parents: { totalCount: 1, nodes: [{ oid: parentHash }] },
                    },
                  },
                ],
              },
              ...snapshotOverrides,
            },
          },
        },
      };
      const runGh: GhRun = vi.fn(async () => ({
        launched: true as const,
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        stdout: { text: JSON.stringify([page]), truncated: false },
        stderr: { text: '', truncated: false },
      }));
      const operations = createOperations({
        resolveReference: (request, onProgress) =>
          resolveReferenceSolution(request, {
            git: { resolveCommit: async () => ({ kind: 'not-found' as const }) },
            clones: failingManagedCloneAdapter(),
            managedCloneRoot: undefined,
            onProgress,
            pullRequests: createGitHubPullRequestReader({
              runGh,
              parentEnvironment: {},
              cancellation: new AbortController().signal,
            }),
          }),
      });
      scriptAnswers(
        'manual',
        'repo-1',
        'octo/app#128',
        '',
        'task-2',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
        false,
        'acc-1',
        'manual',
        'Export produces a CSV',
        true,
        false,
        'dod-1',
        'manual',
        'README documents the button',
        true,
        false,
        true,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(clack.state.logs).toContainEqual({ kind: 'warn', message: expectedWarning });
    });

    it("records the reference and asks today's base commit question when no base is proposed", async () => {
      const firstCommit = 'a'.repeat(40);
      const noProposedBase = `first commit ${firstCommit.slice(0, 7)} of pull request octo/app#128 has no parent`;
      const resolveReference = vi.fn(async () => ({
        ok: true as const,
        value: {
          reference: {
            kind: 'pull-request' as const,
            identifier: 'octo/app#128',
            commits: [firstCommit],
          },
          pullRequest: {
            key: 'octo/app#128',
            state: 'merged' as const,
            targetBranch: 'main',
            noProposedBase,
          },
        },
      }));
      const operations = createOperations({ resolveReference });
      const base = 'abcdef0123456789abcdef0123456789abcdef01';
      scriptAnswers(
        'manual',
        'repo-1',
        'octo/app#128',
        base,
        'task-2',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
        false,
        'acc-1',
        'manual',
        'Export produces a CSV',
        true,
        false,
        'dod-1',
        'manual',
        'README documents the button',
        true,
        false,
        true,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(clack.state.logs).toContainEqual({
        kind: 'warn',
        message: `No base commit is proposed: ${noProposedBase}`,
      });
      expect(clack.state.prompts.find((prompt) => prompt.message === 'Base commit')).toMatchObject({
        placeholder: undefined,
        defaultValue: undefined,
      });
      expect(clack.state.notes).toContainEqual({
        title: 'Reference solution',
        message: 'Pull request octo/app#128 (merged) into main\nCommits: 1\nProposed base: none',
      });
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task).toMatchObject({
        base_commit: base,
        reference: { kind: 'pull-request', identifier: 'octo/app#128', commits: [firstCommit] },
      });
    });

    describe('defaults and list answers', () => {
      const DEFAULTED_BOOTSTRAP_ANSWERS: unknown[] = [
        '',
        '',
        '',
        '',
        '',
        '',
        ...BOOTSTRAP_ANSWERS.slice(6),
      ];

      it('creates the documented run settings, agent command, and role efforts from empty answers', async () => {
        const operations = createOperations({ configExists: vi.fn(async () => false) });
        scriptAnswers(
          ...DEFAULTED_BOOTSTRAP_ANSWERS,
          true,
          'openai/grader-model',
          '',
          true,
          'openai/criteria-model',
          '',
          ...taskAnswersWithAcceptanceCheck('alpha', commandCheckAnswers()),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(requireCreateTaskCall(operations).bootstrap).toMatchObject({
          run: {
            output_dir: 'runs',
            concurrency: 2,
            timeout: '10m',
            stop_grace: '3s',
            check_timeout: '5m',
          },
          agents: { opencode: { command: 'opencode' } },
          roles: {
            grader: { model: 'openai/grader-model', effort: 'medium' },
            criteria: { model: 'openai/criteria-model', effort: 'high' },
          },
        });
      });

      it('shows every default as the placeholder of its prompt', async () => {
        const operations = createOperations({ configExists: vi.fn(async () => false) });
        scriptAnswers(
          ...DEFAULTED_BOOTSTRAP_ANSWERS,
          true,
          'openai/grader-model',
          '',
          true,
          'openai/criteria-model',
          '',
          ...taskAnswersWithAcceptanceCheck('alpha', commandCheckAnswers()),
          true,
        );

        await runCli(['task', 'add'], { operations });

        const defaulted = clack.state.prompts
          .filter((prompt) => prompt.kind === 'text' && prompt.defaultValue !== undefined)
          .map((prompt) => [prompt.message, prompt.defaultValue, prompt.placeholder]);
        expect(defaulted).toEqual([
          ['Output directory', 'runs', 'runs'],
          ['Concurrent cases', '2', '2'],
          ['Agent time limit', '10m', '10m'],
          ['Stop grace period', '3s', '3s'],
          ['Check time limit', '5m', '5m'],
          ['Agent command', 'opencode', 'opencode'],
          ['Secret variable names', '', 'none'],
          ['Non-secret variable names', '', 'none'],
          ['Grader effort', 'medium', 'medium'],
          ['Criteria effort', 'high', 'high'],
          ['Reference PR or commit', '', 'none'],
          ['Description', '', 'none'],
          ['Time limit', '', '5m'],
          ['Passing exit codes', '0', '0'],
          ['Check variables', '', 'none'],
          ['Description', '', 'none'],
        ]);
      });

      it('prints the step lines and asks for a second model when only one is entered', async () => {
        const operations = createOperations({ configExists: vi.fn(async () => false) });
        scriptAnswers(...BOOTSTRAP_ANSWERS, false, false, ...taskInterviewAnswers('alpha'), true);

        await runCli(['task', 'add'], { operations });

        const infoAndSteps = clack.state.logs.filter((log) => log.kind !== 'message');
        expect(infoAndSteps).toEqual([
          { kind: 'step', message: 'New configuration' },
          { kind: 'info', message: 'Add a second model to compare.' },
          { kind: 'step', message: 'New task' },
        ]);
      });

      it.each([
        { separator: ',', description: 'commas' },
        { separator: ' ', description: 'spaces' },
        { separator: ', ', description: 'commas and spaces' },
      ])(
        'reads the secret, non-secret, and check variable lists separated by $description',
        async ({ separator }) => {
          const operations = createOperations({ configExists: vi.fn(async () => false) });
          scriptAnswers(
            ...BOOTSTRAP_ANSWERS.slice(0, 6),
            ['SECRET_ONE', 'SECRET_TWO'].join(separator),
            ['PLAIN_ONE', 'PLAIN_TWO'].join(separator),
            ...BOOTSTRAP_ANSWERS.slice(8),
            false,
            false,
            ...taskAnswersWithAcceptanceCheck(
              'alpha',
              commandCheckAnswers({ variables: [['CHECK_ONE', 'CHECK_TWO'].join(separator)] }),
            ),
            true,
          );

          const { code } = await runCli(['task', 'add'], { operations });

          const call = requireCreateTaskCall(operations);
          expect(code).toBe(0);
          expect(call.bootstrap?.agents).toEqual({
            opencode: {
              command: 'opencode',
              secrets: ['SECRET_ONE', 'SECRET_TWO'],
              env: ['PLAIN_ONE', 'PLAIN_TWO'],
            },
          });
          expect(call.task.checks.acceptance[0]).toMatchObject({ env: ['CHECK_ONE', 'CHECK_TWO'] });
        },
      );

      it.each([
        {
          description: 'a name repeated inside one secret list',
          answers: [{ invalid: 'KEY_A KEY_A' }, 'KEY_A', ''],
          rejection: {
            message: 'Secret variable names',
            reason: '"KEY_A" is listed more than once',
          },
        },
        {
          description: 'a secret name repeated in the non-secret list',
          answers: ['SHARED_KEY', { invalid: 'SHARED_KEY' }, 'OTHER_VAR'],
          rejection: {
            message: 'Non-secret variable names',
            reason: '"SHARED_KEY" is already configured',
          },
        },
        {
          description: 'a name the isolation contract fixes',
          answers: [{ invalid: 'PATH' }, '', ''],
          rejection: {
            message: 'Secret variable names',
            reason:
              'PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract',
          },
        },
      ])('rejects $description', async ({ answers, rejection }) => {
        const operations = createOperations({ configExists: vi.fn(async () => false) });
        scriptAnswers(...BOOTSTRAP_ANSWERS.slice(0, 6), ...answers, clack.CANCEL);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(clack.state.rejections).toEqual([{ kind: 'text', ...rejection }]);
      });

      it('shows the inherited check time limit as the placeholder and writes no timeout for an empty answer', async () => {
        const config = buildTevuConfig({
          run: {
            output_dir: '/tmp/artifacts',
            concurrency: 2,
            timeout: '10m',
            stop_grace: '5s',
            check_timeout: '7m',
          },
        });
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
        });
        scriptAnswers(...taskAnswersWithAcceptanceCheck('repo-1', commandCheckAnswers()), true);

        await runCli(['task', 'add'], { operations });

        expect(clack.state.prompts.find((prompt) => prompt.message === 'Time limit')).toMatchObject(
          {
            placeholder: '7m',
          },
        );
        const check = requireCreateTaskCall(operations).task.checks.acceptance[0];
        expect(check).not.toHaveProperty('timeout');
      });

      it('writes a typed check time limit', async () => {
        const operations = createOperations();
        scriptAnswers(
          ...taskAnswersWithAcceptanceCheck('repo-1', commandCheckAnswers({ timeLimit: ['2m'] })),
          true,
        );

        await runCli(['task', 'add'], { operations });

        expect(requireCreateTaskCall(operations).task.checks.acceptance[0]).toMatchObject({
          timeout: '2m',
        });
      });

      it('requires a check time limit when the configuration has none to inherit', async () => {
        const operations = createOperations();
        scriptAnswers(
          ...taskAnswersWithAcceptanceCheck(
            'repo-1',
            commandCheckAnswers({ timeLimit: [{ invalid: '' }, '2m'] }),
          ),
          true,
        );

        await runCli(['task', 'add'], { operations });

        expect(clack.state.rejections).toEqual([
          { kind: 'text', message: 'Time limit', reason: expect.any(String) },
        ]);
        expect(clack.state.prompts.find((prompt) => prompt.message === 'Time limit')).toMatchObject(
          {
            placeholder: undefined,
          },
        );
        expect(requireCreateTaskCall(operations).task.checks.acceptance[0]).toMatchObject({
          timeout: '2m',
        });
      });
    });

    describe('prompt vocabulary', () => {
      async function runFullInterview(): Promise<void> {
        const operations = createOperations({
          configExists: vi.fn(async () => false),
          ensureManagedCommits: vi.fn(async () => ({ ok: true as const, value: { missing: [] } })),
        });
        scriptAnswers(
          ...BOOTSTRAP_ANSWERS.slice(0, 6),
          '',
          '',
          true,
          'https://jira.example.com',
          'JIRA_EMAIL',
          'JIRA_TOKEN',
          'alpha',
          'github',
          'octo/app',
          true,
          'beta',
          'path',
          '../beta',
          false,
          ...BOOTSTRAP_ANSWERS.slice(13),
          true,
          'openai/grader-model',
          '',
          true,
          'openai/criteria-model',
          '',
          ...taskAnswersWithAcceptanceCheck('alpha', commandCheckAnswers()),
          true,
        );

        await runCli(['task', 'add'], { operations });
      }

      it('keeps every label at 40 characters or fewer, without parentheses', async () => {
        await runFullInterview();

        const labels = clack.state.prompts
          .filter((prompt) => prompt.kind !== 'intro')
          .map((prompt) => prompt.message);
        expect(labels).toContain('Jira token variable');
        expect(labels.filter((label) => label.length > 40 || /[()]/.test(label))).toEqual([]);
      });

      it('asks the Jira and repository setup questions in order with the terse labels', async () => {
        await runFullInterview();

        const labels = clack.state.prompts.map((prompt) => prompt.message);
        const jiraStart = labels.indexOf('Import issues from Jira?');
        expect(labels.slice(jiraStart, jiraStart + 12)).toEqual([
          'Import issues from Jira?',
          'Jira site URL',
          'Jira email variable',
          'Jira token variable',
          'Repository ID',
          'Repository source',
          'GitHub repository',
          'Add another repository?',
          'Repository ID',
          'Repository source',
          'Local path',
          'Add another repository?',
        ]);
      });

      it('offers each configured repository by ID with its source as the hint, then adding one', async () => {
        await runFullInterview();

        const repositoryPrompt = clack.state.prompts.find(
          (prompt) => prompt.message === 'Repository',
        );
        expect(repositoryPrompt?.options).toEqual([
          { label: 'alpha', hint: 'GitHub octo/app', disabled: false },
          { label: 'beta', hint: '../beta', disabled: false },
          { label: 'Add a repository', hint: undefined, disabled: false },
        ]);
      });

      it.each([
        { setup: 'no Jira settings', jira: false, disabled: true },
        { setup: 'Jira settings', jira: true, disabled: false },
      ])('marks the Jira task source disabled only with $setup', async ({ jira, disabled }) => {
        const config = buildTevuConfig(
          jira ? { trackers: { jira: buildJiraTrackerSettings() } } : {},
        );
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
        });
        scriptAnswers(clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        expect(
          clack.state.prompts.find((prompt) => prompt.message === 'Task source')?.options,
        ).toEqual([
          { label: 'Write it yourself', hint: undefined, disabled: false },
          { label: 'Jira issue', hint: disabled ? "Jira isn't set up" : undefined, disabled },
          { label: 'GitHub issue', hint: undefined, disabled: false },
        ]);
      });
    });

    describe('command check', () => {
      it('saves the typed command line verbatim and shows it in the review', async () => {
        const commandLine = '  CI=1 npm test -- --run | tee "out log" && echo "a: #b"  ';
        const operations = createOperations();
        scriptAnswers(
          ...taskAnswersWithAcceptanceCheck(
            'repo-1',
            commandCheckAnswers({ command: [commandLine] }),
          ),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(requireCreateTaskCall(operations).task.checks.acceptance[0]).toEqual({
          id: 'acc-1',
          description: 'The test suite passes',
          run: commandLine,
        });
        const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
        expect(reviewNote?.message).toContain(`command ${commandLine}, `);
      });

      it('asks for the command with the label Command', async () => {
        const operations = createOperations();
        scriptAnswers(...taskAnswersWithAcceptanceCheck('repo-1', commandCheckAnswers()), true);

        await runCli(['task', 'add'], { operations });

        const messages = clack.state.prompts.map((prompt) => prompt.message);
        const checkStart = messages.indexOf('Acceptance check ID');
        expect(messages.slice(checkStart, checkStart + 8)).toEqual([
          'Acceptance check ID',
          'Check type',
          'Description',
          'Required?',
          'Command',
          'Time limit',
          'Passing exit codes',
          'Check variables',
        ]);
        expect(clack.state.prompts.find((prompt) => prompt.message === 'Command')).toMatchObject({
          placeholder: undefined,
          defaultValue: undefined,
        });
      });

      it.each([
        { description: 'an empty', answer: '' },
        { description: 'a whitespace', answer: '   ' },
      ])('rejects $description command', async ({ answer }) => {
        const operations = createOperations();
        scriptAnswers(
          ...taskAnswersWithAcceptanceCheck(
            'repo-1',
            commandCheckAnswers({ command: [{ invalid: answer }, 'npm test'] }),
          ),
          true,
        );

        await runCli(['task', 'add'], { operations });

        expect(clack.state.rejections).toEqual([
          { kind: 'text', message: 'Command', reason: 'a non-empty value is required' },
        ]);
        expect(requireCreateTaskCall(operations).task.checks.acceptance[0]).toMatchObject({
          run: 'npm test',
        });
      });
    });

    describe('cancellation and framing', () => {
      it.each([
        {
          where: 'a setup prompt',
          exists: false,
          answers: () => ['/tmp/bench-artifacts', clack.CANCEL],
        },
        {
          where: 'a task prompt',
          exists: true,
          answers: () => ['manual', clack.CANCEL],
        },
        {
          where: 'the draft review',
          exists: true,
          answers: () => [...READY_ANSWERS, clack.CANCEL],
        },
        {
          where: 'the save confirmation',
          exists: true,
          answers: () => [...taskInterviewAnswers('repo-1'), false],
        },
      ])(
        'ends with exit 130 and one cancel line when the operator cancels at $where',
        async ({ exists, answers }) => {
          const operations = createOperations({
            configExists: vi.fn(async () => exists),
            loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
            resolveReference: vi.fn(async () => ({
              ok: true as const,
              value: buildResolvedCommitReference(),
            })),
            draftCriteria: vi.fn(async () => ({
              status: 'drafted' as const,
              draft: { acceptance: ['a'], done: ['d'] },
              retainedDirectory: null,
            })),
          });
          scriptAnswers(...answers());

          const { code, err } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expect(clack.state.outros).toEqual([]);
          expect(operations.createTask).not.toHaveBeenCalled();
        },
      );

      it('cancels the next prompt when the command was interrupted between prompts', async () => {
        const controller = new AbortController();
        const operations = createOperations({
          loadConfig: vi.fn(async () => {
            controller.abort();
            return { ok: true as const, value: buildTevuConfig() };
          }),
        });

        const { code, err } = await runCli(['task', 'add'], {
          operations,
          cancellation: controller.signal,
        });

        expect(code).toBe(130);
        expect(err).toEqual([]);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
          'tevu task add',
          'Task source',
        ]);
        expect(operations.createTask).not.toHaveBeenCalled();
      });

      it('cancels the open prompt when the command is interrupted while it waits for input', async () => {
        const controller = new AbortController();
        const operations = createOperations();
        scriptAnswers(interruptWith(controller));

        const { code, err } = await runCli(['task', 'add'], {
          operations,
          cancellation: controller.signal,
        });

        expect(code).toBe(130);
        expect(err).toEqual([]);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(operations.createTask).not.toHaveBeenCalled();
      });

      it('prints the Ctrl-C hint as the first line after the intro', async () => {
        const operations = createOperations();
        scriptAnswers(clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        expect(clack.state.timeline.slice(0, 2)).toEqual(['intro', 'log:message']);
        expect(clack.state.logs[0]).toMatchObject({ kind: 'message' });
        expect(stripVTControlCharacters(clack.state.logs[0]?.message ?? '')).toBe(
          'Press Ctrl-C to cancel.',
        );
      });

      it('closes a saved task with the closing line only', async () => {
        const operations = createOperations();
        scriptAnswers(...taskInterviewAnswers('repo-1'), true);

        await runCli(['task', 'add'], { operations });

        expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
        expect(clack.state.cancels).toEqual([]);
        expect(clack.state.timeline.at(-1)).toBe('outro');
      });

      it('reports a failed write as an error with exit 1 and no closing line', async () => {
        const operations = createOperations({
          createTask: vi.fn(async () => ({
            ok: false as const,
            error: artifactError('write-config', 'disk full'),
          })),
        });
        scriptAnswers(...taskInterviewAnswers('repo-1'), true);

        const { code, err } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(1);
        expect(err).toEqual(['error: artifact operation "write-config" failed: disk full']);
        expect(clack.state.outros).toEqual([]);
        expect(clack.state.cancels).toEqual([]);
      });
    });

    describe('waits', () => {
      type WaitOutcome = 'succeeds' | 'returns an error' | 'throws' | 'aborts the signal';

      type WaitScenario = {
        label: string;
        operation: string;
        argv: string[];
        build: (
          outcome: WaitOutcome,
          controller: AbortController,
        ) => { operations: ProgramOperations; answers: unknown[] };
      };

      function applyOutcome(outcome: WaitOutcome, controller: AbortController): void {
        if (outcome === 'throws') {
          throw new Error('boom');
        }
        if (outcome === 'aborts the signal') {
          controller.abort();
        }
      }

      const SCENARIOS: WaitScenario[] = [
        {
          label: 'Importing issue',
          operation: 'importGitHubIssue',
          argv: ['task', 'add', '--github', 'octo/repo#42'],
          build: (outcome, controller) => ({
            operations: createOperations({
              importGitHubIssue: recordOperation('importGitHubIssue', async () => {
                applyOutcome(outcome, controller);
                return outcome === 'returns an error'
                  ? {
                      ok: false as const,
                      error: {
                        kind: 'IssueImportError' as const,
                        tracker: 'github-issue' as const,
                        reference: 'octo/repo#42',
                        reason: 'not found',
                      },
                    }
                  : { ok: true as const, value: buildJiraIssueSnapshot() };
              }),
            }),
            answers: ['repo-1', clack.CANCEL],
          }),
        },
        {
          label: 'Preparing repository',
          operation: 'ensureManagedCommits',
          argv: ['task', 'add'],
          build: (outcome, controller) => ({
            operations: createOperations({
              loadConfig: vi.fn(async () => ({
                ok: true as const,
                value: buildGitHubRepositoryConfig(),
              })),
              ensureManagedCommits: recordOperation('ensureManagedCommits', async () => {
                applyOutcome(outcome, controller);
                return outcome === 'returns an error'
                  ? { ok: false as const, error: managedCloneFailure() }
                  : { ok: true as const, value: { missing: [] } };
              }),
            }),
            answers: ['manual', 'repo-1', clack.CANCEL],
          }),
        },
        {
          label: 'Resolving reference',
          operation: 'resolveReference',
          argv: ['task', 'add'],
          build: (outcome, controller) => ({
            operations: createOperations({
              resolveReference: recordOperation('resolveReference', async () => {
                applyOutcome(outcome, controller);
                return outcome === 'returns an error'
                  ? {
                      ok: false as const,
                      error: {
                        kind: 'ReferenceResolutionError' as const,
                        reason: 'the answer does not name a commit',
                      },
                    }
                  : { ok: true as const, value: buildResolvedCommitReference() };
              }),
            }),
            answers: ['manual', 'repo-1', 'HEAD~3', clack.CANCEL],
          }),
        },
        {
          label: 'Fetching base commit',
          operation: 'fetchBaseCommit',
          argv: ['task', 'add'],
          build: (outcome, controller) => {
            const fetchBaseCommit = recordOperation('fetchBaseCommit', async () => {
              applyOutcome(outcome, controller);
              return outcome === 'returns an error'
                ? { ok: false as const, error: managedCloneFailure() }
                : { ok: true as const, value: { missing: [] } };
            });
            return {
              operations: createOperations({
                loadConfig: vi.fn(async () => ({
                  ok: true as const,
                  value: buildGitHubRepositoryConfig(),
                })),
                ensureManagedCommits: async (request) =>
                  request.revisions.length === 0
                    ? { ok: true as const, value: { missing: [] } }
                    : fetchBaseCommit(),
              }),
              answers: ['manual', 'repo-1', '', 'abc123', clack.CANCEL],
            };
          },
        },
        {
          label: 'Drafting criteria',
          operation: 'draftCriteria',
          argv: ['task', 'add'],
          build: (outcome, controller) => ({
            operations: createOperations({
              loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
              resolveReference: vi.fn(async () => ({
                ok: true as const,
                value: buildResolvedCommitReference(),
              })),
              draftCriteria: recordOperation('draftCriteria', async () => {
                applyOutcome(outcome, controller);
                return outcome === 'returns an error'
                  ? {
                      status: 'failed' as const,
                      failure: { cause: 'call-failed' as const, detail: 'boom' },
                      retainedDirectory: null,
                    }
                  : {
                      status: 'drafted' as const,
                      draft: { acceptance: ['a'], done: ['d'] },
                      retainedDirectory: null,
                    };
              }),
            }),
            answers: [...READY_ANSWERS, clack.CANCEL],
          }),
        },
        {
          label: 'Checking opencode',
          operation: 'probeAgent',
          argv: ['task', 'add'],
          build: (outcome, controller) => ({
            operations: operationsWithModelCheck({
              probeAgent: recordOperation('probeAgent', async () => {
                applyOutcome(outcome, controller);
                return outcome === 'returns an error'
                  ? {
                      ok: false as const,
                      error: {
                        kind: 'PrerequisiteError' as const,
                        tool: 'opencode',
                        expected: 'an executable command',
                        actual: 'not found',
                      },
                    }
                  : { ok: true as const, value: buildCapabilityReport() };
              }),
            }),
            answers: [...BOOTSTRAP_ANSWERS.slice(0, 6), clack.CANCEL],
          }),
        },
        {
          label: 'Checking model',
          operation: 'inspectModelProvider',
          argv: ['task', 'add'],
          build: (outcome, controller) => ({
            operations: operationsWithModelCheck({
              inspectModelProvider: recordOperation(
                'inspectModelProvider',
                async (_configPath, _agent, model) => {
                  applyOutcome(outcome, controller);
                  return outcome === 'returns an error'
                    ? {
                        ok: false as const,
                        error: {
                          kind: 'ConfigValidationError' as const,
                          findings: [buildFinding({ message: 'cannot read the file' })],
                        },
                      }
                    : {
                        ok: true as const,
                        value: {
                          provider: model.slice(0, model.indexOf('/')),
                          definition: { defined: false as const },
                        },
                      };
                },
              ),
            }),
            answers: [...BOOTSTRAP_ANSWERS.slice(0, 15), clack.CANCEL],
          }),
        },
        {
          label: 'Checking model',
          operation: 'checkModelAccess',
          argv: ['task', 'add'],
          build: (outcome, controller) => ({
            operations: operationsWithModelCheck({
              checkModelAccess: recordOperation('checkModelAccess', async () => {
                applyOutcome(outcome, controller);
                return outcome === 'returns an error'
                  ? { status: 'listing-failed' as const, detail: 'exits with code 3' }
                  : accessOutcome('listed');
              }),
            }),
            answers: [...BOOTSTRAP_ANSWERS.slice(0, 15), clack.CANCEL],
          }),
        },
      ];

      function expectWaitAroundOperation(label: string, operation: string): void {
        const events = clack.state.timeline;
        const operationStart = events.indexOf(`operation:${operation}:start`);
        const operationEnd = events.indexOf(`operation:${operation}:end`);
        const before = events.slice(0, operationStart);
        const after = events.slice(operationEnd + 1);
        const spinnerStart = before.lastIndexOf(`spinner:start:${label}`);
        const discarderStart = before.lastIndexOf('discarder:start');
        const spinnerStop = operationEnd + 1 + after.indexOf(`spinner:stop:${label}`);
        const discarderStop = operationEnd + 1 + after.indexOf('discarder:stop');
        expect(operationStart).toBeGreaterThanOrEqual(0);
        expect(operationEnd).toBeGreaterThan(operationStart);
        expect(spinnerStart).toBeGreaterThanOrEqual(0);
        expect(discarderStart).toBeGreaterThan(before.lastIndexOf('discarder:stop'));
        expect(spinnerStop).toBeGreaterThan(operationEnd);
        expect(discarderStop).toBeGreaterThan(operationEnd);
        const heldSpan = events.slice(
          Math.min(spinnerStart, discarderStart),
          Math.max(spinnerStop, discarderStop) + 1,
        );
        expect(heldSpan.filter((event) => event.startsWith('prompt:'))).toEqual([]);
      }

      describe.each(SCENARIOS)('$label', (scenario) => {
        it.each(['succeeds', 'returns an error', 'throws'] as const)(
          'holds stdin and shows the spinner around the operation when it %s',
          async (outcome) => {
            const controller = new AbortController();
            const { operations, answers } = scenario.build(outcome, controller);
            scriptAnswers(...answers);

            const [settled] = await Promise.allSettled([
              runCli(scenario.argv, { operations, cancellation: controller.signal }),
            ]);

            expect(settled.status).toBe(outcome === 'throws' ? 'rejected' : 'fulfilled');
            expect(clack.state.spinners).toContainEqual({
              label: scenario.label,
              handleSignals: false,
            });
            expectWaitAroundOperation(scenario.label, scenario.operation);
          },
        );

        it('ends with the cancel line and exit 130 when the signal aborts during the wait', async () => {
          const controller = new AbortController();
          const { operations, answers } = scenario.build('aborts the signal', controller);
          scriptAnswers(...answers);

          const { code, err } = await runCli(scenario.argv, {
            operations,
            cancellation: controller.signal,
          });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expect(operations.createTask).not.toHaveBeenCalled();
          expectWaitAroundOperation(scenario.label, scenario.operation);
          const afterWait = clack.state.timeline
            .slice(clack.state.timeline.lastIndexOf(`spinner:stop:${scenario.label}`) + 1)
            .filter((event) => event !== 'discarder:stop');
          expect(afterWait).toEqual(['cancel']);
        });
      });
    });

    describe('warnings', () => {
      type WarningScenario = {
        description: string;
        build: () => { operations: ProgramOperations; answers: unknown[] };
        expected: string;
        composedLines: number[];
      };

      const CLONE_FAILURE_DETAIL =
        'cloning github.com/octo/app failed: git clone exited with code 128';

      const SCENARIOS: WarningScenario[] = [
        {
          description: 'an unusable repository',
          build: () => ({
            operations: createOperations({
              loadConfig: vi.fn(async () => ({
                ok: true as const,
                value: buildGitHubRepositoryConfig(),
              })),
              ensureManagedCommits: vi
                .fn<ProgramOperations['ensureManagedCommits']>()
                .mockResolvedValueOnce({ ok: false, error: managedCloneFailure() }),
            }),
            answers: ['manual', 'repo-1', clack.CANCEL],
          }),
          expected: `Can't use repository repo-1.\n${CLONE_FAILURE_DETAIL}`,
          composedLines: [0],
        },
        {
          description: 'an unresolved reference',
          build: () => ({
            operations: createOperations({
              resolveReference: vi.fn<ProgramOperations['resolveReference']>().mockResolvedValue({
                ok: false,
                error: {
                  kind: 'ReferenceResolutionError',
                  reason: 'the answer does not name a commit',
                },
              }),
            }),
            answers: ['manual', 'repo-1', 'bad-ref', clack.CANCEL],
          }),
          expected: "Can't resolve the reference.\nthe answer does not name a commit",
          composedLines: [0],
        },
        {
          description: 'reference commits that could not be fetched',
          build: () => ({
            operations: createOperations({
              resolveReference: vi.fn<ProgramOperations['resolveReference']>().mockResolvedValue({
                ok: true,
                value: {
                  reference: {
                    kind: 'pull-request',
                    identifier: 'octo/app#128',
                    commits: ['a'.repeat(40)],
                  },
                  pullRequest: {
                    key: 'octo/app#128',
                    state: 'merged',
                    targetBranch: 'main',
                    noProposedBase: 'first commit aaaaaaa has no parent',
                    unfetched: 'commit aaaaaaa could not be fetched',
                  },
                },
              }),
            }),
            answers: ['manual', 'repo-1', 'octo/app#128', clack.CANCEL],
          }),
          expected: "Can't fetch some reference commits.\ncommit aaaaaaa could not be fetched",
          composedLines: [0],
        },
        {
          description: 'a base commit that could not be fetched',
          build: () => ({
            operations: createOperations({
              loadConfig: vi.fn(async () => ({
                ok: true as const,
                value: buildGitHubRepositoryConfig(),
              })),
              ensureManagedCommits: vi
                .fn<ProgramOperations['ensureManagedCommits']>()
                .mockResolvedValueOnce({ ok: true, value: { missing: [] } })
                .mockResolvedValueOnce({ ok: false, error: managedCloneFailure() }),
            }),
            answers: ['manual', 'repo-1', '', 'abc123', clack.CANCEL],
          }),
          expected: `Can't fetch the base commit.\n${CLONE_FAILURE_DETAIL}`,
          composedLines: [0],
        },
        {
          description: 'a base commit missing from the repository',
          build: () => ({
            operations: createOperations({
              loadConfig: vi.fn(async () => ({
                ok: true as const,
                value: buildGitHubRepositoryConfig(),
              })),
              ensureManagedCommits: vi
                .fn<ProgramOperations['ensureManagedCommits']>()
                .mockResolvedValueOnce({ ok: true, value: { missing: [] } })
                .mockResolvedValueOnce({ ok: true, value: { missing: ['abc123'] } }),
            }),
            answers: ['manual', 'repo-1', '', 'abc123', clack.CANCEL],
          }),
          expected:
            "Base commit abc123 isn't in repository repo-1.\nIt can't be fetched from github.com/octo/app.",
          composedLines: [0],
        },
        ...DRAFT_FAILURE_CASES.map(({ name, failure, lines }) => ({
          description: `a failed criteria draft with ${name}`,
          build: () => ({
            operations: createOperations({
              loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
              resolveReference: vi.fn(async () => ({
                ok: true as const,
                value: buildResolvedCommitReference(),
              })),
              draftCriteria: vi.fn(async () => ({
                status: 'failed' as const,
                failure,
                retainedDirectory: null,
              })),
            }),
            answers: [...READY_ANSWERS, clack.CANCEL],
          }),
          expected: draftFailureMessage(lines),
          composedLines: [0, 1, lines.length + 1],
        })),
        {
          description: 'an agent command that cannot run',
          build: () => ({
            operations: operationsWithModelCheck({
              probeAgent: vi.fn<ProgramOperations['probeAgent']>().mockResolvedValue({
                ok: false,
                error: {
                  kind: 'PrerequisiteError',
                  tool: 'nope',
                  expected: 'an executable command',
                  actual: 'not found',
                },
              }),
            }),
            answers: setupAnswers({ command: ['nope', clack.CANCEL] }),
          }),
          expected:
            "Can't run nope.\nexpected an executable command, actual not found\nFix the command below. Press Enter to retry, or Ctrl-C to cancel.",
          composedLines: [0, 2],
        },
        {
          description: 'an OpenCode configuration that cannot be read',
          build: () => ({
            operations: operationsWithModelCheck({
              inspectModelProvider: vi.fn<ProgramOperations['inspectModelProvider']>(async () => ({
                ok: false,
                error: {
                  kind: 'ConfigValidationError',
                  findings: [
                    buildFinding({ message: 'cannot read "/op/opencode.json": EACCES' }),
                    buildFinding({ message: '"/op/config.json": provider is not an object' }),
                  ],
                },
              })),
            }),
            answers: setupAnswers({ firstModel: ['acme/model-a', clack.CANCEL] }),
          }),
          expected:
            'Can\'t read your OpenCode config.\ncannot read "/op/opencode.json": EACCES\n"/op/config.json": provider is not an object\nUpdate your OpenCode settings. Press Enter to retry, or Ctrl-C to cancel.',
          composedLines: [0, 3],
        },
        {
          description: 'a provider that cannot be copied',
          build: () => ({
            operations: operationsWithModelCheck({
              checkModelAccess: vi.fn<ProgramOperations['checkModelAccess']>(async () => ({
                status: 'provider-rejected',
                findings: [
                  buildFinding({
                    message:
                      'options.apiKey of provider "acme" is not a {env:NAME} reference; tevu copies no credential value into a case: set api_key to a variable listed in agents.opencode.secrets',
                  }),
                ],
              })),
            }),
            answers: setupAnswers({ firstModel: ['acme/model-a', clack.CANCEL] }),
          }),
          expected:
            'Can\'t copy provider acme from your OpenCode config.\noptions.apiKey of provider "acme" is not a {env:NAME} reference; tevu copies no credential value into a case: set api_key to a variable listed in agents.opencode.secrets\nUpdate your OpenCode settings. Press Enter to retry, or Ctrl-C to cancel.',
          composedLines: [0, 2],
        },
        {
          description: 'a model the agent cannot find',
          build: () => ({
            operations: operationsWithModelCheck({
              inspectModelProvider: inspectingProviders({
                acme: definedProvider({ keyVariables: ['ACME_KEY'], apiKey: 'reference' }),
              }),
              checkModelAccess: vi.fn(async () => accessOutcome('not-listed')),
            }),
            answers: setupAnswers({ firstModel: ['acme/model-x', clack.CANCEL] }),
          }),
          expected:
            "OpenCode can't find acme/model-x.\nUpdate your OpenCode settings or edit the model below. Press Enter to retry, or Ctrl-C to cancel.",
          composedLines: [0, 1],
        },
        {
          description: 'a listing that failed',
          build: () => ({
            operations: operationsWithModelCheck({
              checkModelAccess: vi.fn<ProgramOperations['checkModelAccess']>(async () => ({
                status: 'listing-failed',
                detail: '"opencode models" exits with code 3',
              })),
            }),
            answers: setupAnswers({ firstModel: ['acme/model-a', clack.CANCEL] }),
          }),
          expected:
            'Can\'t list OpenCode models.\n"opencode models" exits with code 3\nPress Enter to retry, or Ctrl-C to cancel.',
          composedLines: [0, 2],
        },
        {
          description: 'a declared variable that is not set',
          build: () => ({
            operations: operationsWithModelCheck({
              checkModelAccess: vi.fn(async () =>
                accessOutcome('listed', { unsetVariables: ['ACME_KEY'] }),
              ),
            }),
            answers: [...setupAnswers({ secrets: 'ACME_KEY' }), clack.CANCEL],
          }),
          expected: "ACME_KEY isn't set in this terminal. Runs will need it.",
          composedLines: [0],
        },
        {
          description: 'a model kept unchecked while one variable is not set',
          build: () => ({
            operations: operationsWithModelCheck({
              checkModelAccess: vi.fn(async () =>
                accessOutcome('not-listed', { unsetVariables: ['ACME_KEY'] }),
              ),
            }),
            answers: [
              ...setupAnswers({ secrets: 'ACME_KEY', firstModel: ['builtin/model-z'] }),
              clack.CANCEL,
            ],
          }),
          expected:
            "builtin/model-z can't be checked while ACME_KEY isn't set in this terminal, so it is kept as entered.",
          composedLines: [0],
        },
        {
          description: 'a model kept unchecked while several variables are not set',
          build: () => ({
            operations: operationsWithModelCheck({
              checkModelAccess: vi.fn(async () =>
                accessOutcome('not-listed', { unsetVariables: ['ACME_KEY', 'ACME_BASE'] }),
              ),
            }),
            answers: [
              ...setupAnswers({ secrets: 'ACME_KEY ACME_BASE', firstModel: ['builtin/model-z'] }),
              clack.CANCEL,
            ],
          }),
          expected:
            "builtin/model-z can't be checked while ACME_KEY, ACME_BASE aren't set in this terminal, so it is kept as entered.",
          composedLines: [0],
        },
        {
          description: 'a temporary directory that could not be removed',
          build: () => ({
            operations: createOperations({
              loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
              resolveReference: vi.fn(async () => ({
                ok: true as const,
                value: buildResolvedCommitReference(),
              })),
              draftCriteria: vi.fn(async () => ({
                status: 'drafted' as const,
                draft: { acceptance: ['a'], done: ['d'] },
                retainedDirectory: '/tmp/tevu-call-xyz',
              })),
            }),
            answers: [...READY_ANSWERS, clack.CANCEL],
          }),
          expected: "Couldn't remove a temporary directory.\n/tmp/tevu-call-xyz",
          composedLines: [0],
        },
      ];

      it.each(SCENARIOS)(
        'prints the headline, detail lines, and next step for $description',
        async ({ build, expected, composedLines }) => {
          const { operations, answers } = build();
          scriptAnswers(...answers);

          await runCli(['task', 'add'], { operations });

          const [headline = ''] = expected.split('\n');
          const printed = clack.state.logs.find(
            (log) => log.kind === 'warn' && log.message.startsWith(headline),
          );
          expect(printed?.message).toBe(expected);
          const lines = printed?.message.split('\n') ?? [];
          const colonCounts = composedLines.map(
            (index) => (lines[index] ?? '').split(':').length - 1,
          );
          expect(Math.max(...colonCounts)).toBeLessThanOrEqual(1);
        },
      );
    });

    describe('agent command probe', () => {
      it.each([
        {
          name: 'a missing prerequisite',
          error: {
            kind: 'PrerequisiteError' as const,
            tool: 'nope',
            expected: 'an executable command',
            actual: 'not found',
          },
          detail: 'expected an executable command, actual not found',
        },
        {
          name: 'a protocol failure',
          error: {
            kind: 'AgentProtocolError' as const,
            agent: 'opencode',
            context: { phase: 'probe' as const },
            reason: '--version printed no version',
          },
          detail: '--version printed no version',
        },
      ])(
        'prints the failure of $name and asks again with the failed command filled in',
        async ({ error, detail }) => {
          const probeAgent = vi
            .fn<ProgramOperations['probeAgent']>()
            .mockResolvedValueOnce({ ok: false, error })
            .mockResolvedValue({ ok: true, value: buildCapabilityReport() });
          const operations = operationsWithModelCheck({ probeAgent });
          scriptAnswers(...setupAnswers({ command: ['nope', 'opencode'] }), clack.CANCEL);

          await runCli(['task', 'add'], { operations });

          expect(probeAgent.mock.calls).toEqual([
            ['tevu.yaml', 'nope'],
            ['tevu.yaml', 'opencode'],
          ]);
          expect(clack.state.logs).toContainEqual({
            kind: 'warn',
            message: `Can't run nope.\n${detail}\nFix the command below. Press Enter to retry, or Ctrl-C to cancel.`,
          });
          const asked = clack.state.prompts.filter((prompt) => prompt.message === 'Agent command');
          expect(asked.map((prompt) => prompt.initialValue)).toEqual([undefined, 'nope']);
          expect(clack.state.spinners.map((spinner) => spinner.label)).toContain('Checking nope');
          expect(clack.state.spinners.map((spinner) => spinner.label)).toContain(
            'Checking opencode',
          );
        },
      );

      it('stops asking once the probe passes and writes the command as typed', async () => {
        const operations = operationsWithModelCheck();
        scriptAnswers(...fullSetupAnswers({ command: ['./bin/opencode'] }));

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(vi.mocked(operations.probeAgent)).toHaveBeenCalledExactlyOnceWith(
          'tevu.yaml',
          './bin/opencode',
        );
        expect(requireAgentBlock(operations).command).toBe('./bin/opencode');
      });
    });

    describe('provider copying and the API key variable question', () => {
      it('copies a provider whose definition names a key variable without asking for one', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({
            acme: definedProvider({ keyVariables: ['ACME_KEY'], apiKey: 'reference' }),
          }),
        });
        scriptAnswers(
          ...fullSetupAnswers({ firstModel: ['acme/model-a'], secondModel: ['acme/model-b'] }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.prompts.map((prompt) => prompt.message)).not.toContain(
          'API key variable for acme',
        );
        expect(requireAgentBlock(operations)).toEqual({
          command: 'opencode',
          secrets: ['ACME_KEY'],
          env: [],
          providers: [{ id: 'acme' }],
        });
        expect(vi.mocked(operations.checkModelAccess)).toHaveBeenNthCalledWith(
          1,
          'tevu.yaml',
          { command: 'opencode', secrets: ['ACME_KEY'], env: [], providers: [{ id: 'acme' }] },
          'acme/model-a',
        );
      });

      it('asks once for a definition with only other variables and remembers an empty answer for the next model', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: recordOperation(
            'inspectModelProvider',
            inspectingProviders({ acme: definedProvider({ otherVariables: ['ACME_BASE'] }) }),
          ),
          checkModelAccess: recordOperation('checkModelAccess', async () =>
            accessOutcome('listed'),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['acme/model-a', ''],
            secondModel: ['acme/model-b'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        const asked = clack.state.prompts.filter(
          (prompt) => prompt.message === 'API key variable for acme',
        );
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({ kind: 'text', placeholder: 'none', defaultValue: '' });
        expect(requireAgentBlock(operations)).toEqual({
          command: 'opencode',
          secrets: ['ACME_BASE'],
          env: [],
          providers: [{ id: 'acme' }],
        });
        const { timeline } = clack.state;
        const keyPrompt = timeline.indexOf('prompt:API key variable for acme');
        expect(keyPrompt).toBeGreaterThan(timeline.indexOf('operation:inspectModelProvider:end'));
        expect(keyPrompt).toBeLessThan(timeline.indexOf('operation:checkModelAccess:start'));
      });

      it('sets api_key and declares its name when the answer names a variable', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({
            acme: definedProvider({ otherVariables: ['ACME_BASE'] }),
          }),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['acme/model-a', 'ACME_KEY'],
            secondModel: ['acme/model-b'],
          }),
        );

        await runCli(['task', 'add'], { operations });

        expect(requireAgentBlock(operations)).toEqual({
          command: 'opencode',
          secrets: ['ACME_BASE', 'ACME_KEY'],
          env: [],
          providers: [{ id: 'acme', api_key: 'ACME_KEY' }],
        });
        expect(vi.mocked(operations.checkModelAccess)).toHaveBeenNthCalledWith(
          1,
          'tevu.yaml',
          {
            command: 'opencode',
            secrets: ['ACME_BASE', 'ACME_KEY'],
            env: [],
            providers: [{ id: 'acme', api_key: 'ACME_KEY' }],
          },
          'acme/model-a',
        );
      });

      it.each([
        {
          name: 'a literal apiKey and no key variable',
          definition: definedProvider({ apiKey: 'value' }),
        },
        {
          name: 'a literal apiKey beside a credential header variable',
          definition: definedProvider({ keyVariables: ['ACME_HEADER_KEY'], apiKey: 'value' }),
        },
      ])('asks for the variable before checking the model for $name', async ({ definition }) => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({ acme: definition }),
          checkModelAccess: recordOperation('checkModelAccess', async () =>
            accessOutcome('listed'),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['acme/model-a', 'ACME_KEY'],
            secondModel: ['acme/model-b'],
          }),
        );

        await runCli(['task', 'add'], { operations });

        const { timeline } = clack.state;
        expect(timeline.indexOf('prompt:API key variable for acme')).toBeLessThan(
          timeline.indexOf('operation:checkModelAccess:start'),
        );
        expect(requireAgentBlock(operations).providers).toEqual([
          { id: 'acme', api_key: 'ACME_KEY' },
        ]);
      });

      it.each([
        {
          name: 'a fixed name',
          answer: 'PATH',
          reason:
            'PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract',
        },
        {
          name: 'a non-secret variable',
          answer: 'PLAIN_ONE',
          reason: '"PLAIN_ONE" is already configured',
        },
        {
          name: 'a Jira credential variable',
          answer: 'JIRA_TOKEN',
          reason: 'Jira credential variables must not also be passed to the agent',
        },
      ])('rejects $name as the key variable and asks again', async ({ answer, reason }) => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({ acme: definedProvider() }),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            env: 'PLAIN_ONE',
            jira: [true, 'https://example.atlassian.net', 'JIRA_EMAIL', 'JIRA_TOKEN'],
            firstModel: ['acme/model-a', { invalid: answer }, 'ACME_KEY'],
            secondModel: ['acme/model-b'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.rejections).toEqual([
          { kind: 'text', message: 'API key variable for acme', reason },
        ]);
        expect(requireAgentBlock(operations).providers).toEqual([
          { id: 'acme', api_key: 'ACME_KEY' },
        ]);
      });
    });

    describe('model check retries', () => {
      it('prints the not-listed message, asks the same question with the previous answer, and drops what the refused answer added', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({
            other: definedProvider({ keyVariables: ['OTHER_KEY'], apiKey: 'reference' }),
            acme: definedProvider({ keyVariables: ['ACME_KEY'], apiKey: 'reference' }),
          }),
          checkModelAccess: vi.fn(async (_configPath, _agent, model) =>
            accessOutcome(model === 'other/model-x' ? 'not-listed' : 'listed'),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['other/model-x', 'acme/model-a'],
            secondModel: ['acme/model-b'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message:
            "OpenCode can't find other/model-x.\nUpdate your OpenCode settings or edit the model below. Press Enter to retry, or Ctrl-C to cancel.",
        });
        const asked = clack.state.prompts.filter((prompt) => prompt.message === 'Model');
        expect(asked.map((prompt) => prompt.initialValue)).toEqual([
          undefined,
          'other/model-x',
          undefined,
        ]);
        expect(requireAgentBlock(operations)).toEqual({
          command: 'opencode',
          secrets: ['ACME_KEY'],
          env: [],
          providers: [{ id: 'acme' }],
        });
        expect(requireCreateTaskCall(operations).bootstrap?.models[0]?.model).toBe('acme/model-a');
      });

      it('asks for a variable after a not-listed result for an undefined provider and checks again with the answer', async () => {
        const checkModelAccess = vi.fn<ProgramOperations['checkModelAccess']>(
          async (_configPath, agent) =>
            accessOutcome(agent.secrets.includes('BUILTIN_KEY') ? 'listed' : 'not-listed'),
        );
        const operations = operationsWithModelCheck({ checkModelAccess });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['builtin/model-z', 'BUILTIN_KEY'],
            secondModel: ['builtin/model-y'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(
          clack.state.prompts.filter((prompt) => prompt.message === 'API key variable for builtin'),
        ).toHaveLength(1);
        expect(checkModelAccess.mock.calls.map(([, , model]) => model)).toEqual([
          'builtin/model-z',
          'builtin/model-z',
          'builtin/model-y',
        ]);
        expect(requireAgentBlock(operations)).toEqual({
          command: 'opencode',
          secrets: ['BUILTIN_KEY'],
          env: [],
        });
      });

      it('refuses the model and asks it again when the variable answer for an undefined provider is empty', async () => {
        const operations = operationsWithModelCheck({
          checkModelAccess: vi.fn(async (_configPath, _agent, model) =>
            accessOutcome(model === 'builtin/model-z' ? 'not-listed' : 'listed'),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['builtin/model-z', '', 'builtin/model-y'],
            secondModel: ['builtin/model-x'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message:
            "OpenCode can't find builtin/model-z.\nUpdate your OpenCode settings or edit the model below. Press Enter to retry, or Ctrl-C to cancel.",
        });
        const asked = clack.state.prompts.filter((prompt) => prompt.message === 'Model');
        expect(asked[1]?.initialValue).toBe('builtin/model-z');
        expect(requireCreateTaskCall(operations).bootstrap?.models[0]?.model).toBe(
          'builtin/model-y',
        );
      });

      it('keeps a not-listed model of an undefined provider while a declared variable is unset, without asking for a key variable', async () => {
        const operations = operationsWithModelCheck({
          checkModelAccess: vi.fn(async () =>
            accessOutcome('not-listed', { unsetVariables: ['BUILTIN_KEY'] }),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            secrets: 'BUILTIN_KEY',
            firstModel: ['builtin/model-z'],
            secondModel: ['builtin/model-y'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        const unchecked = clack.state.logs.filter((log) => log.kind === 'warn');
        expect(unchecked.map((log) => log.message)).toEqual([
          "builtin/model-z can't be checked while BUILTIN_KEY isn't set in this terminal, so it is kept as entered.",
          "builtin/model-y can't be checked while BUILTIN_KEY isn't set in this terminal, so it is kept as entered.",
        ]);
        expect(clack.state.prompts.map((prompt) => prompt.message)).not.toContain(
          'API key variable for builtin',
        );
        expect(
          requireCreateTaskCall(operations).bootstrap?.models.map((model) => model.model),
        ).toEqual(['builtin/model-z', 'builtin/model-y']);
        expect(requireAgentBlock(operations).secrets).toEqual(['BUILTIN_KEY']);
      });

      it('declares the variable named after a not-listed result and keeps the model unchecked when that variable is unset', async () => {
        const operations = operationsWithModelCheck({
          checkModelAccess: vi.fn(async (_configPath, agent) =>
            accessOutcome('not-listed', {
              unsetVariables: agent.secrets.includes('BUILTIN_KEY') ? ['BUILTIN_KEY'] : [],
            }),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['builtin/model-z', 'BUILTIN_KEY'],
            secondModel: ['builtin/model-y'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(requireAgentBlock(operations).secrets).toEqual(['BUILTIN_KEY']);
        expect(
          requireCreateTaskCall(operations).bootstrap?.models.map((model) => model.model),
        ).toEqual(['builtin/model-z', 'builtin/model-y']);
      });

      it('prints each unset variable once across the models of one run', async () => {
        const operations = operationsWithModelCheck({
          checkModelAccess: vi.fn(async () =>
            accessOutcome('listed', { unsetVariables: ['ACME_KEY', 'ACME_BASE'] }),
          ),
        });
        scriptAnswers(...fullSetupAnswers({ secrets: 'ACME_KEY ACME_BASE' }));

        await runCli(['task', 'add'], { operations });

        expect(
          clack.state.logs.filter((log) => log.kind === 'warn').map((log) => log.message),
        ).toEqual([
          "ACME_KEY isn't set in this terminal. Runs will need it.",
          "ACME_BASE isn't set in this terminal. Runs will need it.",
        ]);
      });

      it('counts a name the unchecked line printed as printed', async () => {
        const checkModelAccess = vi
          .fn<ProgramOperations['checkModelAccess']>()
          .mockResolvedValueOnce(accessOutcome('not-listed', { unsetVariables: ['BUILTIN_KEY'] }))
          .mockResolvedValue(accessOutcome('listed', { unsetVariables: ['BUILTIN_KEY'] }));
        const operations = operationsWithModelCheck({ checkModelAccess });
        scriptAnswers(...fullSetupAnswers({ secrets: 'BUILTIN_KEY' }));

        await runCli(['task', 'add'], { operations });

        expect(clack.state.logs.filter((log) => log.kind === 'warn')).toHaveLength(1);
      });

      it('warns about a call directory it could not remove after a model check', async () => {
        const operations = operationsWithModelCheck({
          checkModelAccess: vi.fn(async () =>
            accessOutcome('listed', { retainedDirectory: '/tmp/tevu-call-xyz' }),
          ),
        });
        scriptAnswers(...fullSetupAnswers({ secondModel: ['provider/model-b'] }));

        await runCli(['task', 'add'], { operations });

        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: "Couldn't remove a temporary directory.\n/tmp/tevu-call-xyz",
        });
      });

      it.each(['first', 'second'] as const)(
        'ends with exit 130, one cancel line, and no write when the check is cancelled on the %s model',
        async (position) => {
          const checkModelAccess = vi
            .fn<ProgramOperations['checkModelAccess']>()
            .mockResolvedValue(accessOutcome('listed'));
          if (position === 'first') {
            checkModelAccess.mockResolvedValueOnce({ status: 'cancelled' });
          } else {
            checkModelAccess
              .mockResolvedValueOnce(accessOutcome('listed'))
              .mockResolvedValueOnce({ status: 'cancelled' });
          }
          const operations = operationsWithModelCheck({ checkModelAccess });
          scriptAnswers(...fullSetupAnswers());

          const { code, err } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expectNoWrites(operations);
        },
      );

      it.each([
        {
          name: 'an inspection failure',
          build: (): Partial<ProgramOperations> => ({
            inspectModelProvider: vi
              .fn<ProgramOperations['inspectModelProvider']>()
              .mockResolvedValueOnce({
                ok: false,
                error: {
                  kind: 'ConfigValidationError',
                  findings: [buildFinding({ message: 'cannot read "/op/opencode.json": EACCES' })],
                },
              })
              .mockResolvedValue({
                ok: true,
                value: { provider: 'provider', definition: { defined: false } },
              }),
          }),
        },
        {
          name: 'a rejected provider',
          build: (): Partial<ProgramOperations> => ({
            checkModelAccess: vi
              .fn<ProgramOperations['checkModelAccess']>()
              .mockResolvedValueOnce({
                status: 'provider-rejected',
                findings: [
                  buildFinding({ message: 'options.apiKey of provider "provider" is a literal' }),
                ],
              })
              .mockResolvedValue(accessOutcome('listed')),
          }),
        },
        {
          name: 'a failed listing',
          build: (): Partial<ProgramOperations> => ({
            checkModelAccess: vi
              .fn<ProgramOperations['checkModelAccess']>()
              .mockResolvedValueOnce({
                status: 'listing-failed',
                detail: '"opencode models" exits with code 3',
              })
              .mockResolvedValue(accessOutcome('listed')),
          }),
        },
      ])(
        'asks the model question again with the previous answer after $name and accepts a later answer',
        async ({ build }) => {
          const operations = operationsWithModelCheck(build());
          scriptAnswers(
            ...fullSetupAnswers({ firstModel: ['provider/model-a', 'provider/model-c'] }),
          );

          const { code } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(0);
          const asked = clack.state.prompts.filter((prompt) => prompt.message === 'Model');
          expect(asked.slice(0, 2).map((prompt) => prompt.initialValue)).toEqual([
            undefined,
            'provider/model-a',
          ]);
          expect(requireCreateTaskCall(operations).bootstrap?.models[0]?.model).toBe(
            'provider/model-c',
          );
        },
      );
    });

    describe('written configuration and review of copied providers', () => {
      const ACME_DEFINITION = definedProvider({ otherVariables: ['ACME_BASE'] });

      it('renders and re-parses the bootstrap answers with the providers and the declared secrets', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({ acme: ACME_DEFINITION }),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            secrets: 'EXTRA_KEY',
            firstModel: ['acme/model-a', 'ACME_KEY'],
            secondModel: ['acme/model-b'],
          }),
        );

        await runCli(['task', 'add'], { operations });

        const parsed = renderAndParseBootstrap(requireCreateTaskCall(operations));
        expect(parsed.agents.opencode).toMatchObject({
          secrets: ['EXTRA_KEY', 'ACME_BASE', 'ACME_KEY'],
          providers: [{ id: 'acme', api_key: 'ACME_KEY' }],
        });
      });

      it('lists the copied providers and their key variables on the review line', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({
            acme: ACME_DEFINITION,
            other: definedProvider({ keyVariables: ['OTHER_KEY'], apiKey: 'reference' }),
          }),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['acme/model-a', 'ACME_KEY'],
            secondModel: ['other/model-b'],
          }),
        );

        await runCli(['task', 'add'], { operations });

        const review = clack.state.notes.find((note) => note.title === 'Review');
        expect(review?.message.split('\n')).toContain(
          '  agents.opencode.providers: acme (api_key ACME_KEY), other',
        );
      });

      it('shows none on the review line when no provider was copied', async () => {
        const operations = operationsWithModelCheck();
        scriptAnswers(...fullSetupAnswers());

        await runCli(['task', 'add'], { operations });

        const review = clack.state.notes.find((note) => note.title === 'Review');
        expect(review?.message.split('\n')).toContain('  agents.opencode.providers: (none)');
        expect(requireAgentBlock(operations)).not.toHaveProperty('providers');
      });
    });

    describe('criteria drafting (AC-1 to AC-6, AC-12, AC-17)', () => {
      function operationsDrafting(draft: {
        acceptance: string[];
        done: string[];
      }): ProgramOperations {
        return createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria: vi.fn(async () => ({
            status: 'drafted' as const,
            draft,
            retainedDirectory: null,
          })),
        });
      }

      function draftNotes(): string[] {
        return clack.state.notes
          .filter((note) => note.title === 'Drafted criteria')
          .map((note) => note.message);
      }

      function promptCount(message: string): number {
        return clack.state.prompts.filter((prompt) => prompt.message === message).length;
      }

      it('never calls draftCriteria when roles.criteria is not declared, telling the operator to enter the criteria (C1)', async () => {
        const operations = createOperations({
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
        });
        scriptAnswers(...READY_ANSWERS, ...taskInterviewAnswers('repo-1').slice(10), true);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(operations.draftCriteria).not.toHaveBeenCalled();
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message: 'No criteria model set. Enter the criteria yourself.',
        });
        expect(clack.state.spinners).not.toContainEqual(
          expect.objectContaining({ label: 'Drafting criteria' }),
        );
      });

      it('hands draftCriteria the same captured bootstrap answers createTask writes when no configuration exists yet', async () => {
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          draft: {
            acceptance: ['The export button appears on the table view.'],
            done: ['The change is documented for users.'],
          },
          retainedDirectory: null,
        }));
        const operations = createOperations({
          configExists: vi.fn(async () => false),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...BOOTSTRAP_ANSWERS,
          false,
          true,
          'openai/criteria-model',
          'high',
          'manual',
          'alpha',
          'HEAD~3',
          '',
          'task-2',
          'Add an export button',
          'Export the current view as CSV.',
          'Implement CSV export for the current view.',
          'Repository is readable',
          false,
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(operations.loadConfig).not.toHaveBeenCalled();
        const call = requireCreateTaskCall(operations);
        expect(draftCriteria).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            configuration: { kind: 'bootstrap', answers: call.bootstrap },
          }),
        );
      });

      it('calls draftCriteria exactly once and saves an unchanged draft as acceptance-<n>/done-<n> checks in reply order (P2, P4, E4)', async () => {
        const config = buildCriteriaConfig();
        const resolveReference = vi.fn(async () => ({
          ok: true as const,
          value: buildResolvedCommitReference(),
        }));
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          draft: {
            acceptance: ['The export button appears on the table view.'],
            done: ['The change is documented for users.'],
          },
          retainedDirectory: null,
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference,
          draftCriteria,
        });
        scriptAnswers(...READY_ANSWERS, 'accept', false, false, true);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(draftCriteria).toHaveBeenCalledExactlyOnceWith({
          configPath: 'tevu.yaml',
          configuration: { kind: 'loaded', config },
          repository: { id: 'repo-1', path: '../repos/fixture' },
          reference: buildResolvedCommitReference(),
          prompt: 'Implement CSV export for the current view.',
          description: 'Export the current view as CSV.',
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'The export button appears on the table view.' },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'The change is documented for users.' },
        ]);
      });

      it('prints one result line after the draft and names no model, effort, or configuration key', async () => {
        const config = buildCriteriaConfig();
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria: vi.fn(async () => ({
            status: 'drafted' as const,
            draft: { acceptance: ['a'], done: ['d'] },
            retainedDirectory: null,
          })),
        });
        scriptAnswers(...READY_ANSWERS, 'accept', false, false, true);

        await runCli(['task', 'add'], { operations });

        const logMessages = clack.state.logs.map((log) => log.message);
        expect(clack.state.logs).toContainEqual({ kind: 'success', message: 'Criteria drafted' });
        expect(
          logMessages.filter((message) => /openai|criteria-model|effort|roles\./i.test(message)),
        ).toEqual([]);
        expect(clack.state.spinners).toContainEqual(
          expect.objectContaining({ label: 'Drafting criteria' }),
        );
      });

      it('titles the review note and asks the review questions with the terse labels', async () => {
        const config = buildCriteriaConfig();
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria: vi.fn(async () => ({
            status: 'drafted' as const,
            draft: {
              acceptance: [`This touches commit ${REFERENCE_HASH.slice(0, 7)} directly.`],
              done: ['The change is documented for users.'],
            },
            retainedDirectory: null,
          })),
        });
        scriptAnswers(...READY_ANSWERS, 'add', clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        const draftNote = clack.state.notes.find((note) => note.title === 'Drafted criteria');
        expect(draftNote?.message.split('\n')[0]).toBe(
          'Agents see every item. Keep outcomes, not details of the reference solution.',
        );
        const prompts = clack.state.prompts.filter((prompt) => prompt.message === 'What next?');
        expect(prompts.map((prompt) => prompt.message)).toEqual(['What next?']);
        expect(prompts[0]?.options).toEqual([
          {
            label: 'Accept',
            hint: '1 item names the reference solution; edit or remove it',
            disabled: true,
          },
          { label: 'Edit an item', hint: undefined, disabled: false },
          { label: 'Remove an item', hint: undefined, disabled: false },
          { label: 'Add an item', hint: undefined, disabled: false },
          { label: 'Write my own instead', hint: undefined, disabled: false },
        ]);
        expect(clack.state.sectionedSelects).toStrictEqual([
          {
            message: 'Add to',
            sections: [
              {
                options: [
                  { value: 'acceptance', label: 'Acceptance Criteria' },
                  { value: 'done', label: 'Definition of Done' },
                ],
              },
            ],
            back: { value: 'back', label: 'Back to the review' },
          },
        ]);
        expect(clack.state.prompts.map((prompt) => prompt.message)).not.toContain('Add to');
      });

      it('falls back to the check questions with no drafted text reaching createTask when the draft fails, warning about a retained call directory', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'failed' as const,
          failure: {
            cause: 'call-failed' as const,
            detail: 'ModelCallError (failed): synthetic failure',
          },
          retainedDirectory: '/tmp/tevu-call-xyz',
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'acc-1',
          'manual',
          'Export produces a CSV',
          true,
          false,
          'dod-1',
          'manual',
          'README documents the button',
          true,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: draftFailureMessage([
            'The OpenCode call failed.',
            'ModelCallError (failed): synthetic failure',
          ]),
        });
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: "Couldn't remove a temporary directory.\n/tmp/tevu-call-xyz",
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acc-1', description: 'Export produces a CSV', manual: true },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'dod-1', description: 'README documents the button', manual: true },
        ]);
      });

      it.each(DRAFT_FAILURE_CASES)(
        'prints the cause of $name and continues with the check questions',
        async ({ failure, lines }) => {
          const operations = createOperations({
            loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
            resolveReference: vi.fn(async () => ({
              ok: true as const,
              value: buildResolvedCommitReference(),
            })),
            draftCriteria: vi.fn(async () => ({
              status: 'failed' as const,
              failure,
              retainedDirectory: null,
            })),
          });
          scriptAnswers(...READY_ANSWERS, ...taskInterviewAnswers('repo-1').slice(10), true);

          const { code } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(0);
          const warnings = clack.state.logs.filter((log) => log.kind === 'warn');
          expect(warnings).toEqual([{ kind: 'warn', message: draftFailureMessage(lines) }]);
          const messages = clack.state.prompts.map((prompt) => prompt.message);
          expect(messages.slice(messages.indexOf('Acceptance check ID'))).toContain(
            'Definition of Done check ID',
          );
          expect(requireCreateTaskCall(operations).task.checks.acceptance).toEqual([
            { id: 'acc-1', description: 'Export produces a CSV', manual: true },
          ]);
        },
      );

      it('names the configuration path exactly as the wizard received it when the model is unavailable', async () => {
        const operations = createOperations({
          locateConfig: vi.fn(async () => ({ ok: true as const, value: '/work/bench/tevu.yaml' })),
          loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria: vi.fn(async () => ({
            status: 'failed' as const,
            failure: { cause: 'model-unavailable' as const, model: 'acme/model-a' },
            retainedDirectory: null,
          })),
        });
        scriptAnswers(...READY_ANSWERS, clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: draftFailureMessage([
            "OpenCode can't find acme/model-a in tevu's environment.",
            'Add its provider to agents.opencode.providers in /work/bench/tevu.yaml.',
          ]),
        });
      });

      it('discards the draft for the by-hand fallback when the operator chooses it in the review (E11)', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          draft: { acceptance: ['Drafted item never saved.'], done: ['Also never saved.'] },
          retainedDirectory: null,
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'by-hand',
          'acc-1',
          'manual',
          'Export produces a CSV',
          true,
          false,
          'dod-1',
          'manual',
          'README documents the button',
          true,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acc-1', description: 'Export produces a CSV', manual: true },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'dod-1', description: 'README documents the button', manual: true },
        ]);
      });

      it('exits 130 without calling createTask when the operator cancels at the draft review (P3)', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          draft: { acceptance: ['a'], done: ['d'] },
          retainedDirectory: null,
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(...READY_ANSWERS, clack.CANCEL);

        const { code, err } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(err).toEqual([]);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(operations.createTask).not.toHaveBeenCalled();
      });

      it('blocks accept while an item names the reference commit, then accepts once the item is removed and replaced (P6)', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          draft: {
            acceptance: [`This touches commit ${REFERENCE_HASH.slice(0, 7)} directly.`],
            done: ['The change is documented for users.'],
          },
          retainedDirectory: null,
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'accept',
          'remove',
          'acceptance:0',
          'add',
          'acceptance',
          'The export button appears on the page.',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: 'Cannot accept yet: 1 item names the reference solution; edit or remove it.',
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'The export button appears on the page.' },
        ]);
      });

      it('edits an item in place through the review', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          draft: { acceptance: ['Original wording.'], done: ['The change is documented.'] },
          retainedDirectory: null,
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'edit',
          'acceptance:0',
          'Edited wording that is clearer.',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'Edited wording that is clearer.' },
        ]);
      });

      it('rejects an edited item that names the reference solution, then accepts the corrected text (R9)', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          draft: { acceptance: ['Original wording.'], done: ['The change is documented.'] },
          retainedDirectory: null,
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'edit',
          'acceptance:0',
          { invalid: `This touches commit ${REFERENCE_HASH.slice(0, 7)} directly.` },
          'Corrected wording without the identity.',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.rejections).toContainEqual({
          kind: 'text',
          message: 'Item',
          reason: `the item names reference commit ${REFERENCE_HASH.slice(0, 7)}; tevu validate rejects a task whose agent prompt contains it`,
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'Corrected wording without the identity.' },
        ]);
      });

      it('blocks accept with a plural hint when more than one item names the reference solution', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          draft: {
            acceptance: [
              `First item touches commit ${REFERENCE_HASH.slice(0, 7)}.`,
              `Second item touches commit ${REFERENCE_HASH.slice(0, 7)}.`,
            ],
            done: ['Clean done item.'],
          },
          retainedDirectory: null,
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'accept',
          'edit',
          'acceptance:0',
          'First item rewritten.',
          'edit',
          'acceptance:1',
          'Second item rewritten.',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: 'Cannot accept yet: 2 items name the reference solution; edit or remove them.',
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'First item rewritten.' },
          { id: 'acceptance-2', description: 'Second item rewritten.' },
        ]);
      });

      it('blocks accept once a list empties, and "Back to the review" leaves both lists unchanged (E7)', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          draft: {
            acceptance: ['Original acceptance item.'],
            done: ['The change is documented.'],
          },
          retainedDirectory: null,
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'remove',
          'acceptance:0',
          'accept',
          'add',
          'back',
          'edit',
          'back',
          'add',
          'acceptance',
          'Replacement acceptance item.',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: 'Cannot accept yet: the acceptance criteria need at least one item.',
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'Replacement acceptance item.' },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'The change is documented.' },
        ]);
      });

      it('stores checks added through the follow-on questions after the drafted checks, rejecting an ID that collides with a drafted one (P15, AC-17)', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          draft: {
            acceptance: ['The export button appears on the table view.'],
            done: ['The change is documented for users.'],
          },
          retainedDirectory: null,
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'accept',
          true,
          { invalid: 'acceptance-1' },
          'acceptance-extra',
          'command',
          'The test suite passes',
          true,
          'npm test',
          '',
          '',
          '',
          false,
          true,
          'done-extra',
          'manual',
          'Manually verified',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.rejections).toContainEqual({
          kind: 'text',
          message: 'Acceptance check ID',
          reason: '"acceptance-1" is already used',
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'The export button appears on the table view.' },
          { id: 'acceptance-extra', description: 'The test suite passes', run: 'npm test' },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'The change is documented for users.' },
          { id: 'done-extra', description: 'Manually verified', manual: true, required: false },
        ]);
        const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
        expect(reviewNote?.message).toContain('acceptance-1');
        expect(reviewNote?.message).toContain('acceptance-extra');
        expect(reviewNote?.message).toContain('done-1');
        expect(reviewNote?.message).toContain('done-extra');
      });

      it('lets an empty drafted Definition of Done list through Accept and asks for one required check', async () => {
        const operations = operationsDrafting({ acceptance: ['A1'], done: [] });
        scriptAnswers(
          ...READY_ANSWERS,
          'accept',
          false,
          'dod-1',
          'manual',
          'README documents the button',
          true,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(draftNotes()[0]?.split('\n').at(-1)).toBe('  (none)');
        const whatNext = clack.state.prompts.find((prompt) => prompt.message === 'What next?');
        expect(whatNext?.options?.[0]).toEqual({
          label: 'Accept',
          hint: undefined,
          disabled: false,
        });
        const messages = clack.state.prompts.map((prompt) => prompt.message);
        expect(messages[messages.indexOf('Definition of Done check ID') - 1]).toBe(
          'Add another acceptance check?',
        );
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([{ id: 'acceptance-1', description: 'A1' }]);
        expect(task.checks.done).toEqual([
          { id: 'dod-1', description: 'README documents the button', manual: true },
        ]);
      });

      it('asks Item to edit and Item to remove through the sectioned select with headed sections and back to the review', async () => {
        const operations = operationsDrafting({ acceptance: ['A1', 'A2'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'edit', 'back', 'remove', 'back', clack.CANCEL);
        const expectedSections = [
          {
            heading: 'Acceptance Criteria',
            options: [
              { value: 'acceptance:0', label: 'A1' },
              { value: 'acceptance:1', label: 'A2' },
            ],
          },
          { heading: 'Definition of Done', options: [{ value: 'done:0', label: 'D1' }] },
        ];
        const expectedBack = { value: 'back', label: 'Back to the review' };

        await runCli(['task', 'add'], { operations });

        expect(clack.state.sectionedSelects).toEqual([
          { message: 'Item to edit', sections: expectedSections, back: expectedBack },
          { message: 'Item to remove', sections: expectedSections, back: expectedBack },
        ]);
        const messages = clack.state.prompts.map((prompt) => prompt.message);
        expect(messages).not.toContain('Item to edit');
        expect(messages).not.toContain('Item to remove');
        expect(promptCount('What next?')).toBe(3);
        expect(promptCount('Item')).toBe(0);
      });

      it('labels an item with its redacted text at Item to edit', async () => {
        const operations = operationsDrafting({ acceptance: ['uses SECRET-X'], done: [] });
        scriptAnswers(...READY_ANSWERS, 'edit', 'back', clack.CANCEL);

        await runCli(['task', 'add'], {
          operations,
          redact: (text) => text.replaceAll('SECRET-X', '[redacted]'),
        });

        expect(clack.state.sectionedSelects[0]?.sections[0]?.options).toEqual([
          { value: 'acceptance:0', label: 'uses [redacted]' },
        ]);
      });

      it('edits the second acceptance item at Item to edit and removes the first Definition of Done item at Item to remove', async () => {
        const operations = operationsDrafting({ acceptance: ['A1', 'A2'], done: ['D1'] });
        scriptAnswers(
          ...READY_ANSWERS,
          'edit',
          'acceptance:1',
          'A2 edited',
          'remove',
          'done:0',
          'accept',
          false,
          'dod-1',
          'manual',
          'README documents the button',
          true,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'A1' },
          { id: 'acceptance-2', description: 'A2 edited' },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'dod-1', description: 'README documents the button', manual: true },
        ]);
      });

      it('cancels the wizard when the item select is cancelled with Ctrl-C at Item to edit', async () => {
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'edit', clack.CANCEL);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(operations.createTask).not.toHaveBeenCalled();
      });

      it('passes an empty options array for a list with no items to Item to edit', async () => {
        const operations = operationsDrafting({ acceptance: [], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'edit', 'back', clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        expect(clack.state.sectionedSelects[0]?.sections).toEqual([
          { heading: 'Acceptance Criteria', options: [] },
          { heading: 'Definition of Done', options: [{ value: 'done:0', label: 'D1' }] },
        ]);
      });

      it('Escape returns from the item select to the review', async () => {
        const operations = operationsDrafting({ acceptance: ['A1', 'A2'], done: ['D1'] });
        scriptAnswers(
          ...READY_ANSWERS,
          'edit',
          clack.ESCAPE,
          'remove',
          clack.ESCAPE,
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.sectionedSelects.map((call) => call.message)).toEqual([
          'Item to edit',
          'Item to remove',
        ]);
        expect(promptCount('What next?')).toBe(3);
        expect(promptCount('Item')).toBe(0);
        const notes = draftNotes();
        expect(notes).toHaveLength(3);
        expect(new Set(notes).size).toBe(1);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'A1' },
          { id: 'acceptance-2', description: 'A2' },
        ]);
        expect(task.checks.done).toEqual([{ id: 'done-1', description: 'D1' }]);
      });

      it('Ctrl-C at Item to remove cancels', async () => {
        const operations = operationsDrafting({ acceptance: ['A1', 'A2'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'edit', clack.ESCAPE, 'remove', clack.CANCEL);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(operations.createTask).not.toHaveBeenCalled();
      });

      it('lays out the Drafted criteria note with a blank line before Definition of Done', async () => {
        vi.stubEnv('FORCE_COLOR', '0');
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        expect(draftNotes()[0]?.split('\n')).toEqual([
          'Agents see every item. Keep outcomes, not details of the reference solution.',
          '',
          'Acceptance Criteria',
          '  1. A1',
          '',
          'Definition of Done',
          '  1. D1',
        ]);
      });

      it('wraps each heading of the Drafted criteria note in bold under color', async () => {
        vi.stubEnv('FORCE_COLOR', '1');
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        const lines = draftNotes()[0]?.split('\n') ?? [];
        expect(lines.map((line) => stripVTControlCharacters(line))).toEqual([
          'Agents see every item. Keep outcomes, not details of the reference solution.',
          '',
          'Acceptance Criteria',
          '  1. A1',
          '',
          'Definition of Done',
          '  1. D1',
        ]);
        expect(lines[2]).toBe('\u001b[1mAcceptance Criteria\u001b[22m');
        expect(lines[5]).toBe('\u001b[1mDefinition of Done\u001b[22m');
      });

      it('adds an item to each list through Add to', async () => {
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(
          ...READY_ANSWERS,
          'add',
          'done',
          'D2',
          'add',
          'acceptance',
          'A2',
          'add',
          'back',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.sectionedSelects.map((call) => call.message)).toEqual([
          'Add to',
          'Add to',
          'Add to',
        ]);
        expect(promptCount('What next?')).toBe(4);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'A1' },
          { id: 'acceptance-2', description: 'A2' },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'D1' },
          { id: 'done-2', description: 'D2' },
        ]);
      });

      it('Escape at Add to returns to the review', async () => {
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'add', clack.ESCAPE, 'accept', false, false, true);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.sectionedSelects.map((call) => call.message)).toEqual(['Add to']);
        expect(promptCount('What next?')).toBe(2);
        expect(promptCount('New acceptance criterion')).toBe(0);
        expect(promptCount('New Definition of Done item')).toBe(0);
        const notes = draftNotes();
        expect(notes).toHaveLength(2);
        expect(new Set(notes).size).toBe(1);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([{ id: 'acceptance-1', description: 'A1' }]);
        expect(task.checks.done).toEqual([{ id: 'done-1', description: 'D1' }]);
      });

      it('Ctrl-C at Add to cancels', async () => {
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'add', clack.CANCEL);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(operations.createTask).not.toHaveBeenCalled();
      });
    });
  });

  describe('the graded check default (P13)', () => {
    function gradedTaskInterviewAnswers(repositoryChoice: string): unknown[] {
      return [
        'manual',
        repositoryChoice,
        '',
        'abc123',
        'task-2',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
        false,
        'acc-1',
        'graded',
        'Export produces a CSV',
        true,
        false,
        'dod-1',
        'graded',
        'README documents the button',
        true,
        false,
      ];
    }

    it('asks only the ID, type, criterion, and required questions for a graded check, with no command sub-questions', async () => {
      const operations = createOperations();
      scriptAnswers(...gradedTaskInterviewAnswers('repo-1'), true);

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      const messages = clack.state.prompts.map((prompt) => prompt.message);
      const checkStart = messages.indexOf('Acceptance check ID');
      expect(messages.slice(checkStart, checkStart + 5)).toEqual([
        'Acceptance check ID',
        'Check type',
        'Criterion',
        'Required?',
        'Add another acceptance check?',
      ]);
      expect(messages).not.toContain('Command');
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task).toMatchObject({
        checks: {
          acceptance: [{ id: 'acc-1', description: 'Export produces a CSV' }],
        },
      });
      expect(
        vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task.checks.acceptance[0],
      ).not.toHaveProperty('run');
      expect(
        vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task.checks.acceptance[0],
      ).not.toHaveProperty('manual');
    });

    it('shows the roles.grader warning line exactly when a graded check is declared and no source declares the role', async () => {
      const withoutRoles = createOperations();
      scriptAnswers(...gradedTaskInterviewAnswers('repo-1'), true);
      await runCli(['task', 'add'], { operations: withoutRoles });
      const reviewWithoutRoles = clack.state.notes.find((note) => note.title === 'Review');

      expect(reviewWithoutRoles?.message).toContain(
        'warning: roles.grader is not declared; tevu validate and tevu run refuse this task until it is',
      );
    });

    it('shows no roles.grader warning line when the existing configuration already declares the role', async () => {
      const configWithGrader: TevuConfig = {
        ...buildTevuConfig(),
        roles: { grader: { model: 'openai/grader-model', effort: 'high', agent: AGENT_NAME } },
      };
      const withRoles = createOperations({
        loadConfig: vi.fn(async () => ({ ok: true as const, value: configWithGrader })),
      });
      scriptAnswers(...gradedTaskInterviewAnswers('repo-1'), true);

      await runCli(['task', 'add'], { operations: withRoles });

      const reviewWithRoles = clack.state.notes.find((note) => note.title === 'Review');
      expect(reviewWithRoles?.message).not.toContain('warning: roles.grader is not declared');
    });

    it('shows no roles.grader warning line when the task declares no graded check', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), true);

      await runCli(['task', 'add'], { operations });

      const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
      expect(reviewNote?.message).not.toContain('warning: roles.grader is not declared');
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
            checks: [
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
          value: buildAssessmentContext({ checks: [] }),
        })),
      });

      const { code, err } = await runCli(['assess', 'run-1', 'case-1'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: the configuration is invalid',
        '  error case-1: case "case-1" has no manual or graded checks; there is nothing to assess',
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

    describe('graded checks', () => {
      it("shows the grader's verdict and records a replacement, kept as replaceExisting: true, when the operator confirms it", async () => {
        const grade: GradeRecord = {
          checkId: 'acc-1',
          category: 'acceptance',
          status: 'graded',
          verdict: 'passed',
          rationale: 'lines 1-4 add escaping',
        };
        const operations = createOperations({
          readAssessmentContext: vi.fn(async () => ({
            ok: true as const,
            value: buildAssessmentContext({
              checks: [buildGradedCheckSummary({ grade, grader: buildGrader() })],
            }),
          })),
        });
        scriptAnswers('alice', true, 'failed', 'overridden after review', true);

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message:
            'Grader verdict for "acc-1": passed (openai/grader-model, effort high): lines 1-4 add escaping',
        });
        expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual(
          expect.arrayContaining([
            'Replace the grader\'s verdict for "acc-1"?',
            'Confirm replacing "acc-1" (grader passed -> failed)?',
          ]),
        );
        expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([
          {
            checkId: 'acc-1',
            verdict: 'failed',
            assessor: 'alice',
            note: 'overridden after review',
            replaceExisting: true,
          },
        ]);
      });

      it('declining the replacement offer for a passed grade records no decision for that check', async () => {
        const grade: GradeRecord = {
          checkId: 'acc-1',
          category: 'acceptance',
          status: 'graded',
          verdict: 'passed',
          rationale: 'ok',
        };
        const operations = createOperations({
          readAssessmentContext: vi.fn(async () => ({
            ok: true as const,
            value: buildAssessmentContext({
              checks: [buildGradedCheckSummary({ grade, grader: buildGrader() })],
            }),
          })),
        });
        scriptAnswers('alice', false);

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([]);
      });

      it('asks directly for a verdict, with replaceExisting: false, when the grade is undetermined', async () => {
        const grade: GradeRecord = {
          checkId: 'acc-1',
          category: 'acceptance',
          status: 'graded',
          verdict: 'undetermined',
          rationale: 'the patch does not touch the relevant file',
        };
        const operations = createOperations({
          readAssessmentContext: vi.fn(async () => ({
            ok: true as const,
            value: buildAssessmentContext({
              checks: [buildGradedCheckSummary({ grade, grader: buildGrader() })],
            }),
          })),
        });
        scriptAnswers('alice', 'failed', 'confirmed manually');

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message:
            'Grader verdict for "acc-1": undetermined (openai/grader-model, effort high): the patch does not touch the relevant file',
        });
        expect(clack.state.prompts.map((prompt) => prompt.message)).not.toContain(
          'Replace the grader\'s verdict for "acc-1"?',
        );
        expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([
          {
            checkId: 'acc-1',
            verdict: 'failed',
            assessor: 'alice',
            note: 'confirmed manually',
            replaceExisting: false,
          },
        ]);
      });

      it('shows the pending reason and asks directly for a verdict, with replaceExisting: false, when the grade is pending', async () => {
        const grade: GradeRecord = {
          checkId: 'acc-1',
          category: 'acceptance',
          status: 'pending',
          reason:
            'the grader call failed: ModelCallError (timed-out): run process did not finish within 30000ms',
        };
        const operations = createOperations({
          readAssessmentContext: vi.fn(async () => ({
            ok: true as const,
            value: buildAssessmentContext({
              checks: [buildGradedCheckSummary({ grade, grader: buildGrader() })],
            }),
          })),
        });
        scriptAnswers('alice', 'passed', 'confirmed manually');

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message:
            '"acc-1" was not graded: the grader call failed: ModelCallError (timed-out): run process did not finish within 30000ms',
        });
        expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([
          {
            checkId: 'acc-1',
            verdict: 'passed',
            assessor: 'alice',
            note: 'confirmed manually',
            replaceExisting: false,
          },
        ]);
      });

      it('shows a no-grading-artifact reason and asks directly for a verdict, with replaceExisting: false, when the case has no grading artifact', async () => {
        const operations = createOperations({
          readAssessmentContext: vi.fn(async () => ({
            ok: true as const,
            value: buildAssessmentContext({
              checks: [buildGradedCheckSummary({ grade: null, grader: null })],
            }),
          })),
        });
        scriptAnswers('alice', 'passed', '');

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message: '"acc-1" was not graded: no grading artifact was saved for this case',
        });
        expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([
          {
            checkId: 'acc-1',
            verdict: 'passed',
            assessor: 'alice',
            note: '',
            replaceExisting: false,
          },
        ]);
      });
    });
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
  describe('status line per wizard run', () => {
    function takeStatusLines(): { messages: string[]; distinct: unknown[] } {
      const entries = clack.state.statusLines;
      clack.state.statusLines = [];
      return {
        messages: entries.map((entry) => entry.message),
        distinct: [...new Set(entries.map((entry) => entry.statusLine))],
      };
    }

    it('gives every prompt of one task add run the same status line and a new one to the next run', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
        resolveReference: vi.fn(async () => ({
          ok: true as const,
          value: buildResolvedCommitReference(),
        })),
        draftCriteria: vi.fn(async () => ({
          status: 'drafted' as const,
          draft: { acceptance: ['The export is documented.'], done: ['The change is reviewed.'] },
          retainedDirectory: null,
        })),
      });

      scriptAnswers(...READY_ANSWERS, 'add', clack.CANCEL);
      await runCli(['task', 'add'], { operations });
      const first = takeStatusLines();
      scriptAnswers(...READY_ANSWERS, 'add', clack.CANCEL);
      await runCli(['task', 'add'], { operations });
      const second = takeStatusLines();

      expect(first.messages).toContain('Add to');
      expect(first.messages.length).toBeGreaterThan(READY_ANSWERS.length);
      expect(first.distinct).toHaveLength(1);
      expect(first.distinct[0]).toEqual(expect.objectContaining({ show: expect.any(Function) }));
      expect(second.messages).toEqual(first.messages);
      expect(second.distinct).toHaveLength(1);
      expect(second.distinct[0]).not.toBe(first.distinct[0]);
    });

    it('gives every prompt of one assess run the same status line and a new one to the next run', async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessmentContext({
            checks: [
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
      await runCli(['assess', 'run-1', 'case-1'], { operations });
      const first = takeStatusLines();
      scriptAnswers('alice', 'passed', '', 'failed', 'loader missing');
      await runCli(['assess', 'run-1', 'case-1'], { operations });
      const second = takeStatusLines();

      expect(first.messages).toContain('Assessor name');
      expect(first.messages.length).toBeGreaterThan(2);
      expect(first.distinct).toHaveLength(1);
      expect(first.distinct[0]).toEqual(expect.objectContaining({ show: expect.any(Function) }));
      expect(second.distinct).toHaveLength(1);
      expect(second.distinct[0]).not.toBe(first.distinct[0]);
    });
  });
});
