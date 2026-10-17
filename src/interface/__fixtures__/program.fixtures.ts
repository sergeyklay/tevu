import { basename } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import { buildJiraTrackerSettings } from '@/__fixtures__/host.fixtures';
import {
  buildManualCheckInput,
  buildModelDefinitionInput,
  buildRepositoryInput,
  buildRunSettingsInput,
  buildTaskDefinition,
  buildTaskInput,
  buildTevuConfig,
  FAKE_AGENT_NAME,
  rekeyToFakeAgent,
} from '@/config/__fixtures__/config.fixtures';
import {
  buildAgentCapabilityReport,
  buildCaseArtifacts,
  buildCaseIdentity,
  buildCaseResult,
  buildGraderIdentity,
  buildProcessResult,
} from '@/evaluation/__fixtures__/report.fixtures';
import { runProgram } from '@/interface/program';
import { createWaitInterrupt } from '@/interface/wait-interrupt';

import { clack, resetClackState } from './scripted-prompts.fixtures';

import type {
  AssessableCheckSummary,
  AssessedCase,
  AssessmentCaseContext,
} from '@/application/assess';
import type { CheckInput, ModelDefinitionInput, TaskInput, TevuConfigInput } from '@/config/schema';
import type { JiraTrackerSettings, TaskDefinition, TevuConfig } from '@/domain/config';
import type { ConfigReadCause, TevuError, ValidationFinding } from '@/domain/errors';
import type { IssueSnapshot } from '@/domain/ports/issue-tracker';
import type {
  AgentCapabilityReport,
  BenchmarkMetrics,
  CaseIdentity,
  CaseResult,
  GraderIdentity,
  ReportResult,
  RunResult,
} from '@/domain/run-records';
import type { BenchmarkPlan, EffortChecks, ValidationReport } from '@/domain/use-cases';
import type { AssessOperations } from '@/interface/commands/assess';
import type { RunOperations } from '@/interface/commands/run';
import type { ProgramIo } from '@/interface/commands/shared';
import type { TaskAddOperations } from '@/interface/commands/task-add';
import type { ProgramDependencies } from '@/interface/program';

/** Every command's operations, so one fake backs all five factories. */
export type ProgramOperations = TaskAddOperations & RunOperations & AssessOperations;

const FIXED_NOW = new Date('2026-09-23T10:00:00.000Z');

export const TEST_VERSION = '9.9.9-fixture';

export function buildCliJiraTrackerSettings(
  overrides: Partial<JiraTrackerSettings> = {},
): JiraTrackerSettings {
  return buildJiraTrackerSettings({
    url: 'https://jira.example.com',
    email: '$JIRA_EMAIL',
    token: '$JIRA_TOKEN',
    ...overrides,
  });
}

function buildCliManualCheck(id: string, overrides: Partial<CheckInput> = {}): CheckInput {
  return buildManualCheckInput({ id, description: `${id} check`, ...overrides });
}

export function buildCliTaskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return buildTaskInput({
    title: 'Fixture task title',
    base_commit: 'abc123',
    description: 'Fixture task description',
    prompt: 'Fixture task prompt',
    readiness: ['Repository is readable'],
    checks: {
      acceptance: [buildCliManualCheck('acc-1')],
      done: [buildCliManualCheck('dod-1')],
    },
    ...overrides,
  });
}

function buildCliModelInput(overrides: Partial<ModelDefinitionInput> = {}): ModelDefinitionInput {
  return buildModelDefinitionInput({ id: 'c1', model: 'provider/model-a', ...overrides });
}

export function buildCliConfig(overrides: Partial<TevuConfigInput> = {}): TevuConfig {
  return rekeyToFakeAgent(
    buildTevuConfig({
      run: buildRunSettingsInput({
        output_dir: '/tmp/artifacts',
        concurrency: 2,
        timeout: '10m',
        stop_grace: '5s',
      }),
      agents: { opencode: { command: 'opencode', secrets: [], env: [] } },
      repositories: [buildRepositoryInput({ path: '../repos/fixture' })],
      models: [
        buildCliModelInput(),
        buildCliModelInput({ id: 'c2', model: 'provider/model-b', effort: 'low' }),
      ],
      tasks: [buildCliTaskInput()],
      ...overrides,
    }),
  );
}

export function buildCliResolvedTask(overrides: Partial<TaskInput> = {}): TaskDefinition {
  return buildTaskDefinition(buildCliTaskInput(overrides));
}

export function buildFinding(overrides: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    severity: 'warning',
    identifier: 'task-1',
    message: 'description is thin',
    ...overrides,
  };
}

export function buildCliCapabilityReport(
  overrides: Partial<AgentCapabilityReport> = {},
): AgentCapabilityReport {
  return buildAgentCapabilityReport({
    executable: 'opencode',
    detectedVersion: '1.18.32',
    ...overrides,
  });
}

/** Every model entry of `config` verified, and no declared role. */
export function buildEffortChecks(config: TevuConfig = buildCliConfig()): EffortChecks {
  return {
    models: Object.fromEntries(config.models.map((model) => [model.id, { status: 'verified' }])),
    roles: {},
  };
}

export function buildValidationReport(overrides: Partial<ValidationReport> = {}): ValidationReport {
  return {
    valid: true,
    findings: [],
    capabilities: { [FAKE_AGENT_NAME]: buildCliCapabilityReport() },
    efforts: buildEffortChecks(),
    ...overrides,
  };
}

export function buildBenchmarkPlan(
  config: TevuConfig = buildCliConfig(),
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
    efforts: { models: buildEffortChecks(config).models, grader: null },
    ...overrides,
  };
}

function buildCliCaseIdentity(overrides: Partial<CaseIdentity> = {}): CaseIdentity {
  return buildCaseIdentity({
    caseId: 'case-c1-task-1',
    modelId: 'c1',
    sourceCommit: 'abc123def',
    model: 'provider/model-a',
    agent: FAKE_AGENT_NAME,
    timeoutMs: 600_000,
    ...overrides,
  });
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

export function buildCliCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return buildCaseResult({
    identity: buildCliCaseIdentity(),
    process: buildProcessResult({
      startedAt: '2026-09-23T10:00:01.000Z',
      endedAt: '2026-09-23T10:00:05.000Z',
      durationMs: 4000,
      terminationStage: 'graceful',
    }),
    metrics: buildMetrics(),
    artifacts: buildCaseArtifacts({ result: null }),
    ...overrides,
  });
}

export function buildAssessedCase(overrides: Partial<AssessedCase> = {}): AssessedCase {
  return { result: buildCliCaseResult(), summary: [], ...overrides };
}

export function buildRunResult(overrides: Partial<RunResult> = {}): RunResult {
  const identity = buildCliCaseIdentity();
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
        agentVersions: { [FAKE_AGENT_NAME]: '1.18.32' },
        agentConfigurationFiles: {},
        copiedProviders: {},
      },
      execution: { concurrency: 2, caseTimeoutMs: 600000, repeat: { value: 1, source: 'config' } },
      cases: [identity],
      efforts: { models: { c1: { status: 'verified' } }, grader: null },
    },
    cases: [buildCliCaseResult({ identity })],
    findings: [],
    exitCode: 0,
    ...overrides,
  };
}

export function buildReportResult(overrides: Partial<ReportResult> = {}): ReportResult {
  return {
    runId: 'run-1',
    normalizedJson: '{}',
    markdown: '# Report\n',
    summary: { attempts: [], findings: [] },
    summaryMarkdown: '# Model comparison summary\n',
    ...overrides,
  };
}

export function buildJiraIssueSnapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    issueKey: 'TEVU-42',
    issueUrl: 'https://jira.example.com/browse/TEVU-42',
    summary: 'Add an export button',
    description: 'Users cannot export the current view.',
    ...overrides,
  };
}

export function buildManualCheckSummary(
  overrides: Partial<AssessableCheckSummary> = {},
): AssessableCheckSummary {
  return {
    checkId: 'acc-1',
    category: 'acceptance',
    name: 'Export produces a CSV',
    required: true,
    evaluator: 'manual',
    ...overrides,
  } as AssessableCheckSummary;
}

export function buildCliGraderIdentity(overrides: Partial<GraderIdentity> = {}): GraderIdentity {
  return buildGraderIdentity({
    model: 'openai/grader-model',
    effort: 'high',
    agent: FAKE_AGENT_NAME,
    ...overrides,
  });
}

export function buildAssessmentContext(
  overrides: Partial<AssessmentCaseContext> = {},
): AssessmentCaseContext {
  return {
    caseName: 'vendor/model-a, high on "Export the current view"',
    checks: [buildManualCheckSummary()],
    existing: [],
    ...overrides,
  };
}

export function artifactError(
  operation: string,
  reason: string,
): Extract<TevuError, { kind: 'ArtifactError' }> {
  return { kind: 'ArtifactError', operation, reason };
}

export function configReadError(
  cause: ConfigReadCause,
  path: string,
  requestedPath: string,
): Extract<TevuError, { kind: 'ConfigReadError' }> {
  return { kind: 'ConfigReadError', path, requestedPath, cause };
}

export function configNotFoundError(
  searchedPaths: [string] | [string, string],
): Extract<TevuError, { kind: 'ConfigNotFoundError' }> {
  return { kind: 'ConfigNotFoundError', searchedPaths };
}

/** Reports every name starting with `UNSET_` as unset in tevu's environment. */
function unsetPrefixedVariables(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith('UNSET_'));
}

export function createOperations(overrides: Partial<ProgramOperations> = {}): ProgramOperations {
  const config = buildCliConfig();
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
    ensureManagedLfsObjects: vi.fn(async () => ({ ok: true as const, value: undefined })),
    checkGitHubRepository: vi.fn(async () => ({ ok: true as const, value: undefined })),
    inspectBaseCommit: vi.fn(async () => ({ ok: true as const, value: undefined })),
    checkRepositoryPlacement: vi.fn(async () => []),
    isGitRepository: vi.fn(async () => true),
    readLocalRepositoryNaming: vi.fn(async (_configPath, repositoryPath) => ({
      directoryName: basename(repositoryPath),
    })),
    unsetVariables: vi.fn(unsetPrefixedVariables),
    draftCriteria: vi.fn(async () => {
      throw new Error(
        'draftCriteria should not be called without a resolved reference and a declared criteria role',
      );
    }),
    probeAgent: vi.fn(async () => ({ ok: true as const, value: buildCliCapabilityReport() })),
    inspectModelProvider: vi.fn(async (_configPath, _agent, model) => ({
      ok: true as const,
      value: {
        provider: model.slice(0, model.indexOf('/')),
        definition: { defined: false as const },
      },
    })),
    checkModelAccess: vi.fn(async () => ({
      status: 'listed' as const,
      variants: null,
      unsetVariables: [],
      retainedDirectory: null,
    })),
    prepareRepositories: vi.fn(async () => ({ ok: true as const, value: [] })),
    createTask: vi.fn(async () => ({
      ok: true as const,
      value: buildCliResolvedTask({ id: 'task-2' }),
    })),
    validateConfig: vi.fn(async () => ({ ok: true as const, value: buildValidationReport() })),
    planBenchmark: vi.fn(() => buildBenchmarkPlan(config)),
    executeBenchmark: vi.fn(async () => ({ ok: true as const, value: buildRunResult() })),
    rebuildRunReport: vi.fn(async () => ({
      ok: true as const,
      value: { report: buildReportResult(), retainedDirectories: [] },
    })),
    readAssessmentContext: vi.fn(async () => ({
      ok: true as const,
      value: buildAssessmentContext(),
    })),
    applyAssessment: vi.fn(async () => ({ ok: true as const, value: buildAssessedCase() })),
    ...overrides,
  };
}

export class MemoryStream extends Writable {
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

export function createIo(ttys: { stdin?: boolean; stdout?: boolean } = {}): ProgramIo {
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

/** Overrides for the program dependencies; `operations` backs every command's factory unless `commands` is given. */
type DependencyOverrides = Partial<Omit<ProgramDependencies, 'commands'>> & {
  operations?: ProgramOperations;
  commands?: ProgramDependencies['commands'];
};

export function createDependencies({
  operations = createOperations(),
  commands = {
    taskAdd: () => operations,
    validate: () => operations,
    run: () => operations,
    assess: () => operations,
    report: () => operations,
  },
  ...overrides
}: DependencyOverrides = {}): ProgramDependencies {
  return {
    io: createIo({ stdin: true, stdout: true }),
    commands,
    version: TEST_VERSION,
    now: () => FIXED_NOW,
    redact: (text) => text,
    cancellation: new AbortController().signal,
    waitInterrupt: createWaitInterrupt(),
    ...overrides,
  };
}

export async function runCli(
  argv: readonly string[],
  overrides: DependencyOverrides = {},
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

/** Wraps a fake operation so the shared timeline shows when it started and ended. */
export function recordOperation<Args extends unknown[], Result>(
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

export function managedCloneFailure(): Extract<TevuError, { kind: 'ManagedCloneError' }> {
  return {
    kind: 'ManagedCloneError',
    operation: 'clone',
    repository: 'github.com/octo/app',
    reason: 'git clone exited with code 128',
  };
}

export function buildGitHubRepositoryConfig(overrides: Partial<TevuConfig> = {}): TevuConfig {
  return {
    ...buildCliConfig({ repositories: [{ id: 'repo-1', github: 'octo/app' }] }),
    ...overrides,
  };
}

export function expectNoWrites(operations: ProgramOperations): void {
  expect(operations.createTask).not.toHaveBeenCalled();
  expect(operations.executeBenchmark).not.toHaveBeenCalled();
  expect(operations.rebuildRunReport).not.toHaveBeenCalled();
  expect(operations.applyAssessment).not.toHaveBeenCalled();
}

/** Registers the hooks every CLI test file runs: a clean prompt recorder before each test and restored environment stubs after it. */
export function registerCliTestHooks(): void {
  beforeEach(resetClackState);

  afterEach(() => {
    vi.unstubAllEnvs();
  });
}
