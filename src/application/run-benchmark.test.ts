// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  buildModelDefinitionInput,
  buildRepositoryInput,
  buildRunSettingsInput,
  buildTaskInput,
  buildTevuConfig,
  FAKE_AGENT_NAME,
  rekeyToFakeAgent,
} from '@/config/__fixtures__/config.fixtures';
import { durationMs } from '@/config/schema';
import { unwrapError, unwrapOk } from '@/domain/__fixtures__/errors.fixtures';
import { unavailableBenchmarkMetrics } from '@/domain/run-records';
import {
  buildAgentCapabilityReport,
  buildCaseArtifacts,
  buildCaseIdentity,
  buildCaseResult,
  buildProcessResult,
} from '@/evaluation/__fixtures__/report.fixtures';
import { evaluateChecks } from '@/evaluation/checks';

import { buildVerifiedEfforts } from './__fixtures__/effort.fixtures';
import { gradeCase } from './grade-case';
import { planBenchmark, reduceRunExitCode, runBenchmark } from './run-benchmark';
import { buildTaskPrompt } from './task-prompt';

import type { GradeCaseOutcome } from './grade-case';
import type { CheckInput, TaskInput, TevuConfigInput } from '@/config/schema';
import type { RepositoryDefinition, SetupPhase, TevuConfig } from '@/domain/config';
import type { TevuError, TevuResult } from '@/domain/errors';
import type {
  AgentAdapter,
  AgentRegistry,
  AgentRunInput,
  AgentRunResult,
} from '@/domain/ports/agent';
import type { RunRecorder } from '@/domain/ports/artifact-store';
import type { Clock } from '@/domain/ports/clock';
import type {
  CaseEnvironments,
  EnvironmentAdapter,
  IsolatedEnvironment,
  ParentEnvironmentSnapshot,
} from '@/domain/ports/environment';
import type {
  EvaluatorProcessAdapter,
  EvaluatorProcessRequest,
} from '@/domain/ports/evaluator-process';
import type {
  CaseWorkspace,
  CheckStateRequest,
  OverlaySnapshot,
  PatchBase,
} from '@/domain/ports/git-workspace';
import type { RedactedCapture } from '@/domain/ports/managed-process-runner';
import type { HostProbe, PrerequisiteAdapter } from '@/domain/ports/prerequisite';
import type {
  AgentCapabilityReport,
  AgentMetrics,
  BenchmarkMetrics,
  CaseGrading,
  CaseIdentity,
  CaseLifecycle,
  CaseResult,
  CheckResult,
  CheckStateRecord,
  CopiedProvider,
  EnvironmentVariableRecord,
  FailureRecord,
  MetricValue,
  ProcessResult,
  RunFinding,
  RunManifest,
  RunResult,
  SetupCommandRecord,
} from '@/domain/run-records';
import type { RunDependencies } from '@/domain/use-cases';
import type * as ChecksModule from '@/evaluation/checks';

vi.mock('./grade-case', () => ({ gradeCase: vi.fn() }));

vi.mock('@/evaluation/checks', async (importOriginal) => {
  const actual = await importOriginal<typeof ChecksModule>();
  return { ...actual, evaluateChecks: vi.fn(actual.evaluateChecks) };
});

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const RUN_ID = 'run-0001-synthetic';
const CLOCK_BASE = '2026-01-01T00:00:00.000Z';
const CANCELLED_BEFORE_START_MESSAGE =
  'The run was cancelled before this attempt started, so it has no result. Run the comparison again to get one.';
const SCHEDULING_STOPPED_MESSAGE =
  'tevu stopped starting attempts after it failed to save files for an earlier attempt, so this attempt has no result. Fix the failure reported for that attempt and run the comparison again.';

const CONFIG_PATH = '/synthetic/tevu.yaml';

const EMPTY_CAPTURE: RedactedCapture = {
  text: '',
  totalBytes: 0,
  truncated: false,
  incomplete: false,
};

/** Neutral event record the fake agent emits and counts; carries no protocol shape. */
type FakeEventRecord = { kind: 'tool' } | { kind: 'error' };

type FakeRunOutcome = TevuResult<
  AgentRunResult,
  | 'AgentProcessError'
  | 'AgentProtocolError'
  | 'AgentSessionError'
  | 'CaseTimeoutError'
  | 'CancellationError'
>;

type CaseRunFailure = Extract<
  TevuError,
  {
    kind:
      | 'AgentProcessError'
      | 'AgentProtocolError'
      | 'AgentSessionError'
      | 'CaseTimeoutError'
      | 'CancellationError';
  }
>;

type ExportFailure = Extract<TevuError, { kind: 'AgentProcessError' | 'AgentProtocolError' }>;

type RunScript = (input: AgentRunInput) => Promise<FakeRunOutcome>;

function waitForSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function buildCheck(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    id: 'acc-required',
    description: 'acceptance command exits zero',
    run: ['/synthetic/acc-required', '--verify'],
    timeout: '5s',
    exit_codes: [0],
    env: [],
    ...overrides,
  };
}

function buildBenchmarkTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return buildTaskInput({
    title: 'Synthetic task',
    base_commit: COMMIT_A,
    prompt: 'implement the synthetic feature',
    checks: {
      acceptance: [buildCheck({ id: 'acc-required' })],
      done: [
        buildCheck({
          id: 'dod-required',
          run: ['/synthetic/dod-required', '--verify'],
        }),
      ],
    },
    ...overrides,
  });
}

function buildBenchmarkRunSettings(
  overrides: Partial<TevuConfigInput['run']> = {},
): TevuConfigInput['run'] {
  return buildRunSettingsInput({
    concurrency: 2,
    timeout: '60s',
    stop_grace: '500ms',
    ...overrides,
  });
}

function buildBenchmarkConfig(overrides: Partial<TevuConfigInput> = {}): TevuConfig {
  return rekeyToFakeAgent(
    buildTevuConfig({
      run: buildBenchmarkRunSettings(),
      agents: {
        opencode: { command: '/synthetic/fake-agent', secrets: ['TEVU_PROVIDER_KEY'], env: [] },
      },
      repositories: [buildRepositoryInput({ path: '/synthetic/source' })],
      models: [
        buildModelDefinitionInput({ id: 'c1', model: 'synthetic/model-a', effort: 'fast' }),
        buildModelDefinitionInput({ id: 'c2', model: 'synthetic/model-b', effort: 'deep' }),
      ],
      tasks: [buildBenchmarkTask({ id: 'task-1' }), buildBenchmarkTask({ id: 'task-2' })],
      ...overrides,
    }),
  );
}

function buildBenchmarkCaseIdentity(caseId = 'task-1--c1--1'): CaseIdentity {
  return buildCaseIdentity({
    caseId,
    modelId: 'c1',
    attempt: Number(caseId.slice(caseId.lastIndexOf('--') + 2)),
    sourceCommit: COMMIT_A,
    model: 'synthetic/model-a',
    effort: 'fast',
    agent: FAKE_AGENT_NAME,
  });
}

function buildBenchmarkProcessResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return buildProcessResult({
    startedAt: CLOCK_BASE,
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1_000,
    ...overrides,
  });
}

function buildAgentRunResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    process: buildBenchmarkProcessResult(),
    sessionId: 'session-synthetic',
    parseFindings: [],
    ...overrides,
  };
}

function buildFakeAgentCapabilityReport(): AgentCapabilityReport {
  return buildAgentCapabilityReport({
    executable: '/synthetic/fake-agent',
    detectedVersion: '99.0.0-synthetic',
    capabilities: [{ name: 'run command', required: true, availability: 'available' }],
  });
}

function buildHostProbe(): HostProbe {
  return {
    platform: 'linux',
    nodeVersion: 'v24.0.0-synthetic',
    gitVersion: '2.45.0-synthetic',
  };
}

function buildWorkspace(identity: CaseIdentity): CaseWorkspace {
  return {
    caseId: identity.caseId,
    sourceRepositoryPath: `/synthetic/source-${identity.taskId}`,
    sourceCommit: identity.sourceCommit,
    repositoryDirectory: `/synthetic/workspaces/${identity.caseId}/repo.git`,
    worktreeDirectory: `/synthetic/workspaces/${identity.caseId}/worktree`,
    runtimeDirectory: `/synthetic/workspaces/${identity.caseId}/runtime`,
    branch: identity.caseId,
    syntheticCommit: `synthetic-${identity.caseId}`,
  };
}

function buildFakeEnvironment(
  caseId: string,
  recipient: 'agent' | 'evaluator',
  snapshot: ParentEnvironmentSnapshot,
): IsolatedEnvironment {
  const homeDirectory = `/synthetic/workspaces/${caseId}/runtime/${recipient}/home`;
  const temporaryDirectory = `/synthetic/workspaces/${caseId}/runtime/${recipient}/tmp`;
  const agentValues = snapshot.agentValues;
  const variables: Record<string, string> = {
    PATH: snapshot.path,
    HOME: homeDirectory,
    TMPDIR: temporaryDirectory,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: '1',
    ...(recipient === 'agent' ? agentValues : {}),
  };
  const configuredNames =
    recipient === 'agent'
      ? Object.keys(agentValues)
      : Object.keys(snapshot.ordinaryEvaluatorValues);
  const variableManifest: EnvironmentVariableRecord[] = [
    ...['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI'].map((name) => ({
      name,
      classification: 'fixed' as const,
      recipient,
    })),
    ...configuredNames.map((name) => ({
      name,
      classification: recipient === 'agent' ? ('secret' as const) : ('ordinary' as const),
      recipient,
    })),
  ];
  return { caseId, recipient, homeDirectory, temporaryDirectory, variables, variableManifest };
}

function buildBenchmarkCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return buildCaseResult({
    identity: buildBenchmarkCaseIdentity(),
    metrics: unavailableBenchmarkMetrics('synthetic metrics unavailable'),
    artifacts: buildCaseArtifacts({ result: 'task-1--c1--1/result.json' }),
    ...overrides,
  });
}

function buildFailureRecord(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    error: {
      kind: 'AgentProcessError',
      agent: FAKE_AGENT_NAME,
      caseId: 'task-1--c1--1',
      exitCode: 3,
      signal: null,
    },
    occurredAt: CLOCK_BASE,
    ...overrides,
  };
}

function buildRunFinding(overrides: Partial<RunFinding> = {}): RunFinding {
  return { severity: 'warning', caseId: null, message: 'synthetic finding', ...overrides };
}

function defaultRunScript(input: AgentRunInput): Promise<FakeRunOutcome> {
  return successfulRunScript(input);
}

async function successfulRunScript(input: AgentRunInput): Promise<FakeRunOutcome> {
  const sessionId = `session-${input.identity.caseId}`;
  await input.onEvent({ kind: 'tool' } satisfies FakeEventRecord);
  const value = buildAgentRunResult({ sessionId });
  input.onProcess?.(value);
  return { ok: true, value };
}

function failedRunScript(
  error: CaseRunFailure,
  options: { withErrorEvent?: boolean } = {},
): RunScript {
  return async (input) => {
    const sessionId = `session-${input.identity.caseId}`;
    await input.onEvent({ kind: 'tool' } satisfies FakeEventRecord);
    if (options.withErrorEvent === true) {
      await input.onEvent({ kind: 'error' } satisfies FakeEventRecord);
    }
    const value = buildAgentRunResult({
      sessionId,
      process: buildBenchmarkProcessResult({ exitCode: 3, durationMs: 4_321 }),
    });
    input.onProcess?.(value);
    return { ok: false, error };
  };
}

function timedOutRunScript(): RunScript {
  return async (input) => {
    const sessionId = `session-${input.identity.caseId}`;
    await input.onEvent({ kind: 'tool' } satisfies FakeEventRecord);
    await input.onEvent({ kind: 'error' } satisfies FakeEventRecord);
    const value = buildAgentRunResult({
      sessionId,
      process: buildBenchmarkProcessResult({
        exitCode: null,
        signal: 'SIGKILL',
        durationMs: 4_321,
        terminationStage: 'forced',
      }),
    });
    input.onProcess?.(value);
    return {
      ok: false,
      error: {
        kind: 'CaseTimeoutError',
        caseId: input.identity.caseId,
        timeoutMs: input.timeoutMs,
      },
    };
  };
}

/** Sums fixed values matching a fully available root-session export; verified verbatim by the tests below. */
function buildFullMetrics(): AgentMetrics {
  const measured = (value: number, unit: MetricValue['unit']): MetricValue => ({
    value,
    unit,
    availability: { status: 'available', source: 'root-session export' },
    scope: 'root-session',
  });
  return {
    inputTokens: measured(10, 'token'),
    outputTokens: measured(20, 'token'),
    reasoningTokens: measured(3, 'token'),
    cacheReadTokens: measured(4, 'token'),
    cacheWriteTokens: measured(5, 'token'),
    turns: measured(1, 'count'),
    apiCalls: measured(1, 'count'),
    apiErrors: measured(0, 'count'),
    toolCalls: measured(0, 'count'),
    skillCalls: measured(0, 'count'),
    cost: measured(0.25, 'USD'),
  };
}

/** Counts the neutral event records the fake agent's own `run` emitted; mirrors a real adapter's event fallback. */
function buildEventFallbackMetrics(reason: string, events: readonly unknown[]): AgentMetrics {
  const unavailable = (unit: MetricValue['unit']): MetricValue => ({
    value: null,
    unit,
    availability: { status: 'unavailable', reason },
    scope: 'root-session',
  });
  const measured = (value: number, unit: MetricValue['unit']): MetricValue => ({
    value,
    unit,
    availability: { status: 'available', source: 'run events' },
    scope: 'root-session',
  });
  const records = events as FakeEventRecord[];
  return {
    inputTokens: unavailable('token'),
    outputTokens: unavailable('token'),
    reasoningTokens: unavailable('token'),
    cacheReadTokens: unavailable('token'),
    cacheWriteTokens: unavailable('token'),
    turns: unavailable('count'),
    apiCalls: unavailable('count'),
    apiErrors: measured(records.filter((event) => event.kind === 'error').length, 'count'),
    toolCalls: measured(records.filter((event) => event.kind === 'tool').length, 'count'),
    skillCalls: measured(0, 'count'),
    cost: unavailable('USD'),
  };
}

function createHarness(config: TevuConfig) {
  const timeline: string[] = [];
  const lifecycleEvents: Array<{ caseId: string; lifecycle: CaseLifecycle }> = [];
  const cancellationController = new AbortController();

  const gitState = {
    validatedCommits: [] as Array<{ repositoryId: string; commit: string }>,
    createIsolatedCaseCalls: [] as CaseIdentity[],
    createIsolatedCaseRepositories: [] as RepositoryDefinition[],
    unreadableCaseIds: new Set<string>(),
    disposeErrors: new Map<string, Extract<TevuError, { kind: 'ArtifactError' }>>(),
    validateSourceError: null as Extract<TevuError, { kind: 'SourceMaterializationError' }> | null,
    capturePatchError: null as Extract<TevuError, { kind: 'SourceMaterializationError' }> | null,
    capturePatchBases: [] as Array<{ caseId: string; base: PatchBase | undefined }>,
    snapshotPatchBaseError: null as Extract<TevuError, { kind: 'ArtifactError' }> | null,
    createIsolatedCaseError: null as Extract<
      TevuError,
      { kind: 'SourceMaterializationError' | 'IsolationError' }
    > | null,
    readOverlayCalls: [] as string[],
    readOverlayError: null as Extract<TevuError, { kind: 'CheckStateError' }> | null,
    readOverlaySnapshots: new Map<string, OverlaySnapshot>(),
    applyCheckStateCalls: [] as Array<{ caseId: string; request: CheckStateRequest }>,
    applyCheckStateError: null as Extract<TevuError, { kind: 'CheckStateError' }> | null,
    applyCheckStateResults: new Map<string, CheckStateRecord>(),
  };

  type AbortPoint = 'snapshotPatchBase' | 'applyCheckState' | 'writePatch' | 'writeGrading';
  const abortDuring = new Set<AbortPoint>();
  const abortIfRequested = (call: AbortPoint): void => {
    if (abortDuring.has(call)) {
      cancellationController.abort();
    }
  };

  const git: RunDependencies['git'] = {
    async validateSource(repository, commit) {
      gitState.validatedCommits.push({ repositoryId: repository.id, commit });
      timeline.push(`validateSource:${repository.id}`);
      if (gitState.validateSourceError !== null) {
        return { ok: false, error: gitState.validateSourceError };
      }
      return {
        ok: true,
        value: {
          repositoryId: repository.id,
          requestedCommit: commit,
          resolvedCommit: `pinned-${commit}`,
          rootEntries: [],
        },
      };
    },
    async createIsolatedCase(identity, repository) {
      gitState.createIsolatedCaseCalls.push(identity);
      gitState.createIsolatedCaseRepositories.push(repository);
      timeline.push(`prepare:${identity.caseId}`);
      if (gitState.createIsolatedCaseError !== null) {
        return { ok: false, error: gitState.createIsolatedCaseError };
      }
      return { ok: true, value: buildWorkspace(identity) };
    },
    async capturePatch(workspace, base) {
      gitState.capturePatchBases.push({ caseId: workspace.caseId, base });
      timeline.push(`patch:${workspace.caseId}`);
      if (gitState.capturePatchError !== null) {
        return { ok: false, error: gitState.capturePatchError };
      }
      return {
        ok: true,
        value: {
          caseId: workspace.caseId,
          content: `synthetic patch ${workspace.caseId}`,
          isEmpty: false,
        },
      };
    },
    async snapshotPatchBase(workspace) {
      timeline.push(`snapshotPatchBase:${workspace.caseId}`);
      abortIfRequested('snapshotPatchBase');
      if (gitState.snapshotPatchBaseError !== null) {
        return { ok: false, error: gitState.snapshotPatchBaseError };
      }
      return {
        ok: true,
        value: { tree: `tree-${workspace.caseId}`, objectDirectory: `objects-${workspace.caseId}` },
      };
    },
    async dispose(workspace) {
      timeline.push(`dispose:${workspace.caseId}`);
      const error = gitState.disposeErrors.get(workspace.caseId);
      return error === undefined ? { ok: true, value: undefined } : { ok: false, error };
    },
    async isReadable(workspace) {
      timeline.push(`isReadable:${workspace.caseId}`);
      return !gitState.unreadableCaseIds.has(workspace.caseId);
    },
    async readOverlay(directory) {
      gitState.readOverlayCalls.push(directory);
      timeline.push(`readOverlay:${directory}`);
      if (gitState.readOverlayError !== null) {
        return { ok: false, error: gitState.readOverlayError };
      }
      return { ok: true, value: gitState.readOverlaySnapshots.get(directory) ?? [] };
    },
    async applyCheckState(workspace, request) {
      gitState.applyCheckStateCalls.push({ caseId: workspace.caseId, request });
      timeline.push(`applyCheckState:${workspace.caseId}`);
      abortIfRequested('applyCheckState');
      if (gitState.applyCheckStateError !== null) {
        return { ok: false, error: gitState.applyCheckStateError };
      }
      return {
        ok: true,
        value: gitState.applyCheckStateResults.get(workspace.caseId) ?? {
          restore: null,
          overlay: null,
        },
      };
    },
    async initializeEmptyRepository() {
      return {
        ok: false,
        error: {
          kind: 'ArtifactError',
          operation: 'initialize-repository',
          reason: 'not used in these tests',
        },
      };
    },
  };

  let heldRuns: PromiseWithResolvers<void> | null = null;
  const startedSignals = new Map<string, PromiseWithResolvers<void>>();

  const agentState = {
    runCalls: new Map<string, number>(),
    runInputs: [] as AgentRunInput[],
    startedOrder: [] as string[],
    scripts: new Map<string, RunScript>(),
    exportCalls: [] as string[],
    exportFailures: new Map<string, ExportFailure>(),
    activeCount: 0,
    maxActiveCount: 0,
    probeError: null as Extract<
      TevuError,
      { kind: 'PrerequisiteError' | 'AgentProtocolError' }
    > | null,
    providersError: null as Extract<TevuError, { kind: 'ConfigValidationError' }> | null,
  };

  const fakeAdapter: AgentAdapter = {
    async probe() {
      timeline.push('probe');
      if (agentState.probeError !== null) {
        return { ok: false, error: agentState.probeError };
      }
      return { ok: true, value: buildFakeAgentCapabilityReport() };
    },
    async readProviders() {
      if (agentState.providersError !== null) {
        return { ok: false, error: agentState.providersError };
      }
      return {
        ok: true,
        value: { agent: 'fake-agent', configurationFiles: [], findings: [], copiedProviders: [] },
      };
    },
    async inspectOperatorProvider() {
      return { ok: true, value: { defined: false } };
    },
    async listModels() {
      return { outcome: 'listed', models: [], variants: new Map() };
    },
    async probeToolDenial() {
      return { outcome: 'denied' };
    },
    repositoryConfigurationEntries() {
      return [];
    },
    async run(input) {
      const caseId = input.identity.caseId;
      agentState.runCalls.set(caseId, (agentState.runCalls.get(caseId) ?? 0) + 1);
      agentState.startedOrder.push(caseId);
      agentState.runInputs.push(input);
      agentState.activeCount += 1;
      agentState.maxActiveCount = Math.max(agentState.maxActiveCount, agentState.activeCount);
      startedSignals.get(caseId)?.resolve();
      timeline.push(`run:start:${caseId}`);
      if (heldRuns !== null) {
        await heldRuns.promise;
      }
      const script = agentState.scripts.get(caseId) ?? defaultRunScript;
      const outcome = await script(input);
      agentState.activeCount -= 1;
      timeline.push(`run:end:${caseId}`);
      return outcome;
    },
    async exportSession(sessionId) {
      agentState.exportCalls.push(sessionId);
      timeline.push(`exportSession:${sessionId}`);
      const failure = agentState.exportFailures.get(sessionId);
      if (failure !== undefined) {
        return { ok: false, error: failure };
      }
      return { ok: true, value: { rootSessionId: sessionId } };
    },
    normalizeMetrics(input) {
      if (input.sessionExport !== null) {
        return { ok: true, value: buildFullMetrics() };
      }
      const reason = input.exportUnavailableReason ?? 'root session export unavailable';
      return { ok: true, value: buildEventFallbackMetrics(reason, input.events) };
    },
    async callModel() {
      return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
    },
  };
  const agents: AgentRegistry = new Map([[FAKE_AGENT_NAME, fakeAdapter]]);

  const artifactState = {
    failOnce: new Map<string, Extract<TevuError, { kind: 'ArtifactError' }>>(),
    startedManifests: [] as RunManifest[],
    finalizedCases: [] as CaseResult[],
    finalizedRuns: [] as RunResult[],
  };

  const recordArtifactCall = (
    operation: string,
    key: string,
  ): TevuResult<void, 'ArtifactError'> => {
    timeline.push(`${operation}:${key}`);
    const failure = artifactState.failOnce.get(`${operation}:${key}`);
    if (failure !== undefined) {
      artifactState.failOnce.delete(`${operation}:${key}`);
      return { ok: false, error: failure };
    }
    return { ok: true, value: undefined };
  };

  const artifacts: RunRecorder = {
    caseArtifactPaths(caseId) {
      return {
        events: `${caseId}/events.jsonl`,
        diagnostics: `${caseId}/stderr.log`,
        sessionExport: `${caseId}/session.json`,
        solutionPatch: `${caseId}/solution.patch`,
        checks: `${caseId}/checks.json`,
        assessment: `${caseId}/assessment.json`,
        grading: `${caseId}/grading.json`,
        result: `${caseId}/result.json`,
        setupBeforeAgent: `${caseId}/setup-before-agent.log`,
        setupBeforeChecks: `${caseId}/setup-before-checks.log`,
      };
    },
    async startRun(manifest) {
      artifactState.startedManifests.push(manifest);
      return recordArtifactCall('startRun', manifest.runId);
    },
    async appendEvent(caseId) {
      return recordArtifactCall('appendEvent', caseId);
    },
    async appendDiagnostic(caseId) {
      return recordArtifactCall('appendDiagnostic', caseId);
    },
    async writeSessionExport(caseId) {
      return recordArtifactCall('writeSessionExport', caseId);
    },
    async writePatch(caseId) {
      const result = recordArtifactCall('writePatch', caseId);
      abortIfRequested('writePatch');
      return result;
    },
    async writeSetupLog(caseId) {
      return recordArtifactCall('writeSetupLog', caseId);
    },
    async writeChecks(caseId) {
      return recordArtifactCall('writeChecks', caseId);
    },
    async writeGrading(caseId) {
      const result = recordArtifactCall('writeGrading', caseId);
      abortIfRequested('writeGrading');
      return result;
    },
    async finalizeCase(result) {
      artifactState.finalizedCases.push(result);
      return recordArtifactCall('finalizeCase', result.identity.caseId);
    },
    async finalizeRun(result) {
      artifactState.finalizedRuns.push(result);
      return recordArtifactCall('finalizeRun', result.manifest.runId);
    },
  };

  let checkGate: PromiseWithResolvers<void> | null = null;
  const checkSignals = new Map<string, PromiseWithResolvers<void>>();

  const evaluatorState = {
    requests: [] as EvaluatorProcessRequest[],
    exitCodes: new Map<string, number>(),
  };

  const evaluatorProcesses: EvaluatorProcessAdapter = {
    async run(request) {
      evaluatorState.requests.push(request);
      const key = request.argv[0];
      timeline.push(`check:${key}`);
      checkSignals.get(key)?.resolve();
      if (checkGate !== null) {
        await checkGate.promise;
      }
      return {
        launched: true,
        exitCode: evaluatorState.exitCodes.get(key) ?? 0,
        signal: null,
        durationMs: 5,
        timedOut: false,
        terminationStage: 'none',
        stdout: EMPTY_CAPTURE,
        stderr: EMPTY_CAPTURE,
      };
    },
  };

  const environmentState = {
    snapshotValue: {
      path: '/synthetic/bin:/usr/bin',
      agentValues: { TEVU_PROVIDER_KEY: 'synthetic-provider-secret' },
      ordinaryEvaluatorValues: { TEVU_EVAL_VAR: 'synthetic-evaluator-value' },
      secretValues: ['synthetic-provider-secret'],
    } satisfies ParentEnvironmentSnapshot,
    snapshotParentCalls: 0,
    snapshotParentError: null as Extract<TevuError, { kind: 'PrerequisiteError' }> | null,
    snapshotsReceived: [] as ParentEnvironmentSnapshot[],
    created: [] as Array<{ caseId: string; value: CaseEnvironments }>,
  };

  const environments: EnvironmentAdapter = {
    snapshotParent() {
      environmentState.snapshotParentCalls += 1;
      timeline.push('snapshotParent');
      if (environmentState.snapshotParentError !== null) {
        return { ok: false, error: environmentState.snapshotParentError };
      }
      return { ok: true, value: environmentState.snapshotValue };
    },
    unsetVariables() {
      return [];
    },
    async createCaseEnvironments(workspace, snapshot) {
      timeline.push(`environments:${workspace.caseId}`);
      environmentState.snapshotsReceived.push(snapshot);
      const value: CaseEnvironments = {
        agent: buildFakeEnvironment(workspace.caseId, 'agent', snapshot),
        evaluator: buildFakeEnvironment(workspace.caseId, 'evaluator', snapshot),
      };
      environmentState.created.push({ caseId: workspace.caseId, value });
      return { ok: true, value };
    },
    async createModelCallEnvironment() {
      return {
        ok: false,
        error: {
          kind: 'ArtifactError',
          operation: 'create-model-call-directory',
          reason: 'not used in these tests',
        },
      };
    },
  };

  const prerequisitesState = {
    probeHostCalls: 0,
    probeHostError: null as Extract<TevuError, { kind: 'PrerequisiteError' }> | null,
  };

  const prerequisites: PrerequisiteAdapter = {
    async probeHost() {
      prerequisitesState.probeHostCalls += 1;
      timeline.push('probeHost');
      if (prerequisitesState.probeHostError !== null) {
        return { ok: false, error: prerequisitesState.probeHostError };
      }
      return { ok: true, value: buildHostProbe() };
    },
    hasEnvironmentVariable() {
      return true;
    },
    async probeWritableDirectory() {
      return { ok: true, value: undefined };
    },
  };

  let clockTicks = 0;
  const clock: Clock = {
    now: () => new Date(Date.parse(CLOCK_BASE) + (clockTicks += 1) * 1_000),
  };

  const dependencies: RunDependencies = {
    git,
    agents,
    artifacts,
    evaluatorProcesses,
    environments,
    prerequisites,
    clock,
    generateRunId: () => RUN_ID,
    configDigest: () => 'digest-synthetic',
    textDigest: () => 'digest-file-synthetic',
    redact: (text) => text,
    cancellation: cancellationController.signal,
    onLifecycle: (caseId, lifecycle) => lifecycleEvents.push({ caseId, lifecycle }),
    onRetainedGradingDirectory: (directory) =>
      timeline.push(`retainedGradingDirectory:${directory}`),
  };

  const agentHarness = Object.assign(agentState, {
    holdNewRuns(): void {
      heldRuns = Promise.withResolvers<void>();
    },
    releaseHeldRuns(): void {
      heldRuns?.resolve();
      heldRuns = null;
    },
    waitForCaseStart(caseId: string): Promise<void> {
      const existing = startedSignals.get(caseId);
      if (existing !== undefined) {
        return existing.promise;
      }
      const signal = Promise.withResolvers<void>();
      startedSignals.set(caseId, signal);
      return signal.promise;
    },
  });

  const evaluatorHarness = Object.assign(evaluatorState, {
    holdChecks(): void {
      checkGate = Promise.withResolvers<void>();
    },
    releaseChecks(): void {
      checkGate?.resolve();
      checkGate = null;
    },
    waitForCheck(argvKey: string): Promise<void> {
      const existing = checkSignals.get(argvKey);
      if (existing !== undefined) {
        return existing.promise;
      }
      const signal = Promise.withResolvers<void>();
      checkSignals.set(argvKey, signal);
      return signal.promise;
    },
  });

  return {
    config,
    dependencies,
    timeline,
    lifecycleEvents,
    cancellation: cancellationController,
    abortDuring,
    git: gitState,
    agent: agentHarness,
    artifacts: artifactState,
    evaluatorProcesses: evaluatorHarness,
    environments: environmentState,
    prerequisites: prerequisitesState,
  };
}

type Harness = ReturnType<typeof createHarness>;

function caseResultOf(run: RunResult, caseId: string): CaseResult {
  const found = run.cases.find((entry) => entry.identity.caseId === caseId);
  if (found === undefined) {
    throw new Error(`missing case result for ${caseId}`);
  }
  return found;
}

async function runCancelledDuringEvaluation(): Promise<{
  run: RunResult;
  harness: Harness;
}> {
  const config = buildBenchmarkConfig({
    run: buildBenchmarkRunSettings({ concurrency: 1 }),
    tasks: [buildBenchmarkTask()],
  });
  const harness = createHarness(config);
  harness.evaluatorProcesses.holdChecks();
  const firstCheck = harness.evaluatorProcesses.waitForCheck('/synthetic/acc-required');

  const runPromise = runBenchmark(
    planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
    harness.dependencies,
  );
  await firstCheck;
  harness.cancellation.abort();
  harness.evaluatorProcesses.releaseChecks();
  const result = await runPromise;
  return { run: unwrapOk(result), harness };
}

async function runWithFailingExport(
  buildError: (caseId: string) => ExportFailure,
): Promise<{ run: RunResult; harness: Harness }> {
  const config = buildBenchmarkConfig({ tasks: [buildBenchmarkTask()] });
  const harness = createHarness(config);
  harness.agent.exportFailures.set('session-task-1--c1--1', buildError('task-1--c1--1'));
  const result = await runBenchmark(
    planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
    harness.dependencies,
  );
  return { run: unwrapOk(result), harness };
}

function expectAvailableMetric(
  metric: MetricValue,
  value: number,
  unit: MetricValue['unit'],
  source: string,
  scope: MetricValue['scope'] = 'root-session',
): void {
  expect(metric).toEqual({ value, unit, availability: { status: 'available', source }, scope });
}

function expectUnavailableMetric(metric: MetricValue, reasonIncludes: string): void {
  expect(metric.value).toBeNull();
  expect(metric.availability).toMatchObject({ status: 'unavailable' });
  if (metric.availability.status === 'unavailable') {
    expect(metric.availability.reason).toContain(reasonIncludes);
  }
}

describe('planBenchmark', () => {
  it('plans one attempt per pair, in configuration order, with attempt 1 in every case ID, when run.repeat is absent (AC-2)', () => {
    const config = buildBenchmarkConfig({
      tasks: [
        buildBenchmarkTask({ id: 'task-1', base_commit: COMMIT_A }),
        buildBenchmarkTask({ id: 'task-2', base_commit: COMMIT_B }),
      ],
    });

    const plan = planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config));

    expect(plan.config).toBe(config);
    expect(plan.repeat).toEqual({ value: 1, source: 'config' });
    expect(plan.cases).toEqual([
      {
        caseId: 'task-1--c1--1',
        taskId: 'task-1',
        modelId: 'c1',
        attempt: 1,
        sourceCommit: COMMIT_A,
        model: 'synthetic/model-a',
        effort: 'fast',
        agent: FAKE_AGENT_NAME,
        timeoutMs: 60_000,
      },
      {
        caseId: 'task-1--c2--1',
        taskId: 'task-1',
        modelId: 'c2',
        attempt: 1,
        sourceCommit: COMMIT_A,
        model: 'synthetic/model-b',
        effort: 'deep',
        agent: FAKE_AGENT_NAME,
        timeoutMs: 60_000,
      },
      {
        caseId: 'task-2--c1--1',
        taskId: 'task-2',
        modelId: 'c1',
        attempt: 1,
        sourceCommit: COMMIT_B,
        model: 'synthetic/model-a',
        effort: 'fast',
        agent: FAKE_AGENT_NAME,
        timeoutMs: 60_000,
      },
      {
        caseId: 'task-2--c2--1',
        taskId: 'task-2',
        modelId: 'c2',
        attempt: 1,
        sourceCommit: COMMIT_B,
        model: 'synthetic/model-b',
        effort: 'deep',
        agent: FAKE_AGENT_NAME,
        timeoutMs: 60_000,
      },
    ]);
  });

  it('builds each CaseIdentity with keys in the order caseId, taskId, modelId, attempt, sourceCommit, model, effort, agent, timeoutMs', () => {
    const config = buildBenchmarkConfig({
      tasks: [buildBenchmarkTask({ id: 'task-1', base_commit: COMMIT_A })],
    });

    const plan = planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config));

    expect(Object.keys(plan.cases[0] ?? {})).toEqual([
      'caseId',
      'taskId',
      'modelId',
      'attempt',
      'sourceCommit',
      'model',
      'effort',
      'agent',
      'timeoutMs',
    ]);
  });

  it('copies the configured limits and artifact destination into the plan', () => {
    const config = buildBenchmarkConfig();
    const plan = planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config));

    expect(plan.concurrency).toBe(2);
    expect(plan.defaultCaseTimeoutMs).toBe(60_000);
    expect(plan.terminationGraceMs).toBe(500);
    expect(plan.artifactsDirectory).toBe('/synthetic/artifacts');
  });

  it('plans 12 cases ordered attempt-major, then task, then model, for 2 tasks, 2 model entries, and run.repeat: 3 (AC-1)', () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ repeat: 3 }),
      tasks: [
        buildBenchmarkTask({ id: 'task-1', base_commit: COMMIT_A }),
        buildBenchmarkTask({ id: 'task-2', base_commit: COMMIT_B }),
      ],
    });

    const plan = planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config));

    expect(plan.repeat).toEqual({ value: 3, source: 'config' });
    expect(plan.cases).toHaveLength(12);
    expect(plan.cases.map((identity) => identity.caseId)).toEqual([
      'task-1--c1--1',
      'task-1--c2--1',
      'task-2--c1--1',
      'task-2--c2--1',
      'task-1--c1--2',
      'task-1--c2--2',
      'task-2--c1--2',
      'task-2--c2--2',
      'task-1--c1--3',
      'task-1--c2--3',
      'task-2--c1--3',
      'task-2--c2--3',
    ]);
    expect(plan.cases.map((identity) => identity.attempt)).toEqual([
      1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
    ]);
  });

  it('resolves the effective repeat to repeatOverride with source cli, and leaves plan.config.run.repeat at its loaded value (AC-3, verification property 2)', () => {
    const config = buildBenchmarkConfig({ run: buildBenchmarkRunSettings({ repeat: 3 }) });

    const plan = planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config), 2);

    expect(plan.repeat).toEqual({ value: 2, source: 'cli' });
    expect(
      plan.cases.filter((identity) => identity.taskId === 'task-1' && identity.modelId === 'c1'),
    ).toHaveLength(2);
    expect(plan.config).toBe(config);
    expect(plan.config.run.repeat).toBe(3);
  });

  it("resolves plan.repeat.source to cli whatever repeatOverride's value, and to config when it is absent", () => {
    const config = buildBenchmarkConfig({ run: buildBenchmarkRunSettings({ repeat: 3 }) });

    expect(planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config), 3).repeat).toEqual({
      value: 3,
      source: 'cli',
    });
    expect(planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)).repeat).toEqual({
      value: 3,
      source: 'config',
    });
  });

  it("resolves every case's timeoutMs from its own task, leaving other tasks under run.timeout (AC-2)", () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ repeat: 2 }),
      tasks: [
        buildBenchmarkTask({ id: 'task-1', timeout: '20m' }),
        buildBenchmarkTask({ id: 'task-2' }),
      ],
    });

    const plan = planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config));

    expect(plan.cases).toHaveLength(8);
    const task1Cases = plan.cases.filter((identity) => identity.taskId === 'task-1');
    const task2Cases = plan.cases.filter((identity) => identity.taskId === 'task-2');
    const defaultTimeoutMs = durationMs(config.run.timeout);
    expect(task1Cases.map((identity) => identity.timeoutMs)).toEqual(Array(4).fill(1_200_000));
    expect(task2Cases.map((identity) => identity.timeoutMs)).toEqual(
      Array(4).fill(defaultTimeoutMs),
    );
    expect(plan.defaultCaseTimeoutMs).toBe(durationMs(config.run.timeout));
  });

  describe('efforts', () => {
    const unverified = { status: 'unverified', reason: 'synthetic unverified reason' } as const;
    const unsupported = { status: 'unsupported', reason: 'synthetic unsupported reason' } as const;

    it('records the model entry checks and the grader check of the validation', () => {
      const config = buildBenchmarkConfig();

      const plan = planBenchmark(config, CONFIG_PATH, {
        models: { c1: { status: 'verified' }, c2: unsupported },
        roles: { grader: unverified },
      });

      expect(plan.efforts).toEqual({
        models: { c1: { status: 'verified' }, c2: unsupported },
        grader: unverified,
      });
    });

    it('records a null grader check when the validation declared no grader', () => {
      const config = buildBenchmarkConfig();

      const plan = planBenchmark(config, CONFIG_PATH, {
        models: { c1: { status: 'verified' }, c2: { status: 'verified' } },
        roles: {},
      });

      expect(plan.efforts.grader).toBeNull();
    });

    it('leaves the criteria check out of the plan', () => {
      const config = buildBenchmarkConfig();

      const plan = planBenchmark(config, CONFIG_PATH, {
        models: { c1: { status: 'verified' }, c2: { status: 'verified' } },
        roles: { criteria: unsupported },
      });

      expect(plan.efforts).toEqual({
        models: { c1: { status: 'verified' }, c2: { status: 'verified' } },
        grader: null,
      });
    });

    it('leaves the summary check out of the plan', () => {
      const config = buildBenchmarkConfig();

      const plan = planBenchmark(config, CONFIG_PATH, {
        models: { c1: { status: 'verified' }, c2: { status: 'verified' } },
        roles: { summary: unsupported },
      });

      expect(plan.efforts).toEqual({
        models: { c1: { status: 'verified' }, c2: { status: 'verified' } },
        grader: null,
      });
    });

    it('copies the model entry checks, so a later change to the validation does not alter the plan', () => {
      const config = buildBenchmarkConfig();
      const efforts = buildVerifiedEfforts(config);

      const plan = planBenchmark(config, CONFIG_PATH, efforts);
      efforts.models['c1'] = unsupported;

      expect(plan.efforts.models['c1']).toEqual({ status: 'verified' });
      expect(plan.efforts.models).not.toBe(efforts.models);
    });

    it('stays deterministic for the same configuration and checks', () => {
      const config = buildBenchmarkConfig();

      const first = planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config));
      const second = planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config));

      expect(second).toEqual(first);
    });

    it('keeps every case identity effort equal to the configured string whatever its check', () => {
      const config = buildBenchmarkConfig();

      const plan = planBenchmark(config, CONFIG_PATH, {
        models: { c1: unsupported, c2: unverified },
        roles: {},
      });

      expect(
        new Set(plan.cases.map((identity) => `${identity.modelId}:${identity.effort}`)),
      ).toEqual(new Set(['c1:fast', 'c2:deep']));
    });
  });
});

describe('reduceRunExitCode', () => {
  it.each([
    { label: 'no cases and no findings', cases: [], findings: [], cancelled: false, expected: 0 },
    {
      label: 'an explicit cancellation flag',
      cases: [],
      findings: [],
      cancelled: true,
      expected: 130,
    },
    {
      label: 'a cancelled case without the flag',
      cases: [buildBenchmarkCaseResult({ lifecycle: 'cancelled' })],
      findings: [],
      cancelled: false,
      expected: 130,
    },
    {
      label: 'an error-severity finding',
      cases: [],
      findings: [buildRunFinding({ severity: 'error' })],
      cancelled: false,
      expected: 1,
    },
    {
      label: 'an infrastructure-failed case',
      cases: [buildBenchmarkCaseResult({ lifecycle: 'infrastructure-failed' })],
      findings: [],
      cancelled: false,
      expected: 1,
    },
    {
      label: 'a timed-out case',
      cases: [buildBenchmarkCaseResult({ lifecycle: 'timed-out' })],
      findings: [],
      cancelled: false,
      expected: 2,
    },
    {
      label: 'a process-failed case',
      cases: [buildBenchmarkCaseResult({ lifecycle: 'process-failed' })],
      findings: [],
      cancelled: false,
      expected: 2,
    },
    {
      label: 'a failed acceptance outcome',
      cases: [buildBenchmarkCaseResult({ outcome: 'failed' })],
      findings: [],
      cancelled: false,
      expected: 2,
    },
    {
      label: 'a pending acceptance outcome',
      cases: [buildBenchmarkCaseResult({ outcome: 'pending' })],
      findings: [],
      cancelled: false,
      expected: 2,
    },
    {
      label: 'a completed case with a preserved runtime failure',
      cases: [buildBenchmarkCaseResult({ failure: buildFailureRecord() })],
      findings: [],
      cancelled: false,
      expected: 2,
    },
    {
      label: 'cancellation over error findings',
      cases: [buildBenchmarkCaseResult({ lifecycle: 'cancelled' })],
      findings: [buildRunFinding({ severity: 'error' })],
      cancelled: false,
      expected: 130,
    },
    {
      label: 'error findings over degraded cases',
      cases: [buildBenchmarkCaseResult({ lifecycle: 'timed-out' })],
      findings: [buildRunFinding({ severity: 'error' })],
      cancelled: false,
      expected: 1,
    },
    {
      label: 'infrastructure failure over a preserved runtime failure',
      cases: [
        buildBenchmarkCaseResult({ lifecycle: 'infrastructure-failed' }),
        buildBenchmarkCaseResult({ failure: buildFailureRecord() }),
      ],
      findings: [],
      cancelled: false,
      expected: 1,
    },
  ])('reduces $label to exit code $expected', ({ cases, findings, cancelled, expected }) => {
    expect(reduceRunExitCode(cases, findings, cancelled)).toBe(expected);
  });
});

describe('runBenchmark', () => {
  it('writes the plan efforts as the manifest efforts', async () => {
    const config = buildBenchmarkConfig();
    const harness = createHarness(config);
    const plan = planBenchmark(config, CONFIG_PATH, {
      models: {
        c1: { status: 'verified' },
        c2: { status: 'unverified', reason: 'synthetic unverified reason' },
      },
      roles: { grader: { status: 'unsupported', reason: 'synthetic unsupported reason' } },
    });

    unwrapOk(await runBenchmark(plan, harness.dependencies));

    expect(harness.artifacts.startedManifests).toHaveLength(1);
    expect(harness.artifacts.startedManifests[0]?.efforts).toEqual(plan.efforts);
  });

  it('probes the host once, snapshots the parent environment once, and pins commits before the first write', async () => {
    const config = buildBenchmarkConfig();
    const harness = createHarness(config);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    expect(harness.timeline.slice(0, 5)).toEqual([
      'probeHost',
      'snapshotParent',
      'probe',
      'validateSource:repo-1',
      `startRun:${RUN_ID}`,
    ]);
    expect(harness.git.validatedCommits).toEqual([{ repositoryId: 'repo-1', commit: COMMIT_A }]);
    expect(harness.environments.snapshotParentCalls).toBe(1);
    expect(harness.environments.snapshotsReceived).toHaveLength(4);
    expect(
      harness.environments.snapshotsReceived.every((s) => s === harness.environments.snapshotValue),
    ).toBe(true);
    expect(harness.artifacts.startedManifests).toHaveLength(1);
    expect(harness.artifacts.finalizedRuns).toHaveLength(1);
    expect(run.exitCode).toBe(0);
    expect(run.findings).toEqual([]);
  });

  it('writes a manifest with pinned identities, injected provenance, and a completed timestamp', async () => {
    const config = buildBenchmarkConfig();
    const harness = createHarness(config);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    const manifest = run.manifest;
    expect(manifest.runId).toBe(RUN_ID);
    expect(manifest.configDigest).toBe('digest-synthetic');
    expect(manifest.startedAt).toBe('2026-01-01T00:00:01.000Z');
    expect(manifest.completedAt).not.toBeNull();
    expect(manifest.host).toEqual({
      platform: 'linux',
      nodeVersion: 'v24.0.0-synthetic',
    });
    expect(manifest.tools).toEqual({
      gitVersion: '2.45.0-synthetic',
      agentVersions: { [FAKE_AGENT_NAME]: '99.0.0-synthetic' },
      agentConfigurationFiles: { [FAKE_AGENT_NAME]: [] },
      copiedProviders: { [FAKE_AGENT_NAME]: [] },
    });
    expect(manifest.configPath).toBe(CONFIG_PATH);
    expect(manifest.execution).toEqual({
      concurrency: 2,
      caseTimeoutMs: 60_000,
      repeat: { value: 1, source: 'config' },
    });
    expect(manifest.cases).toEqual([
      {
        caseId: 'task-1--c1--1',
        taskId: 'task-1',
        modelId: 'c1',
        attempt: 1,
        sourceCommit: `pinned-${COMMIT_A}`,
        model: 'synthetic/model-a',
        effort: 'fast',
        agent: FAKE_AGENT_NAME,
        timeoutMs: 60_000,
      },
      {
        caseId: 'task-1--c2--1',
        taskId: 'task-1',
        modelId: 'c2',
        attempt: 1,
        sourceCommit: `pinned-${COMMIT_A}`,
        model: 'synthetic/model-b',
        effort: 'deep',
        agent: FAKE_AGENT_NAME,
        timeoutMs: 60_000,
      },
      {
        caseId: 'task-2--c1--1',
        taskId: 'task-2',
        modelId: 'c1',
        attempt: 1,
        sourceCommit: `pinned-${COMMIT_A}`,
        model: 'synthetic/model-a',
        effort: 'fast',
        agent: FAKE_AGENT_NAME,
        timeoutMs: 60_000,
      },
      {
        caseId: 'task-2--c2--1',
        taskId: 'task-2',
        modelId: 'c2',
        attempt: 1,
        sourceCommit: `pinned-${COMMIT_A}`,
        model: 'synthetic/model-b',
        effort: 'deep',
        agent: FAKE_AGENT_NAME,
        timeoutMs: 60_000,
      },
    ]);
    expect(manifest.context?.config).toBe(config);
    expect(
      (manifest.context?.capabilities as Record<string, AgentCapabilityReport>)[FAKE_AGENT_NAME]
        ?.detectedVersion,
    ).toBe('99.0.0-synthetic');
    expect(harness.artifacts.startedManifests[0]?.completedAt).toBeNull();
    expect(run.cases.every((entry) => entry.identity.sourceCommit === `pinned-${COMMIT_A}`)).toBe(
      true,
    );
  });

  describe('copied providers', () => {
    const SECOND_AGENT_NAME = 'second-agent';
    const FIRST_PROVIDERS = [{ id: 'alpha-proxy', pricedModels: ['alpha-large', 'alpha-small'] }];
    const SECOND_PROVIDERS = [
      { id: 'beta-proxy', pricedModels: [] },
      { id: 'gamma-proxy', pricedModels: ['gamma-large'] },
    ];

    function buildTwoAgentHarness() {
      const base = buildBenchmarkConfig();
      const config: TevuConfig = {
        ...base,
        agents: { ...base.agents, [SECOND_AGENT_NAME]: base.agents[FAKE_AGENT_NAME]! },
        models: base.models.map((model) =>
          model.id === 'c2' ? { ...model, agent: SECOND_AGENT_NAME } : model,
        ),
      };
      const harness = createHarness(config);
      const baseAdapter = harness.dependencies.agents.get(FAKE_AGENT_NAME)!;
      const received = new Map<string, readonly CopiedProvider[]>();
      const withProviders = (
        agent: string,
        copiedProviders: readonly CopiedProvider[],
      ): AgentAdapter => ({
        ...baseAdapter,
        async readProviders() {
          return {
            ok: true,
            value: { agent, configurationFiles: [], findings: [], copiedProviders },
          };
        },
        normalizeMetrics(input) {
          received.set(input.caseId, input.copiedProviders);
          return baseAdapter.normalizeMetrics(input);
        },
      });
      harness.dependencies.agents = new Map([
        [FAKE_AGENT_NAME, withProviders(FAKE_AGENT_NAME, FIRST_PROVIDERS)],
        [SECOND_AGENT_NAME, withProviders(SECOND_AGENT_NAME, SECOND_PROVIDERS)],
      ]);
      return { config, harness, received };
    }

    it('writes each read agent its own snapshot copiedProviders under the keys of agentConfigurationFiles, as a copy', async () => {
      const { config, harness } = buildTwoAgentHarness();

      const result = await runBenchmark(
        planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
        harness.dependencies,
      );

      const { tools } = unwrapOk(result).manifest;
      expect(Object.keys(tools.copiedProviders)).toEqual(
        Object.keys(tools.agentConfigurationFiles),
      );
      expect(tools.copiedProviders).toEqual({
        [FAKE_AGENT_NAME]: FIRST_PROVIDERS,
        [SECOND_AGENT_NAME]: SECOND_PROVIDERS,
      });
      const recorded = tools.copiedProviders[FAKE_AGENT_NAME]!;
      expect(recorded).not.toBe(FIRST_PROVIDERS);
      expect(recorded[0]).not.toBe(FIRST_PROVIDERS[0]);
      expect(recorded[0]!.pricedModels).not.toBe(FIRST_PROVIDERS[0]!.pricedModels);
    });

    it('hands each case its own agent snapshot copiedProviders when normalizing metrics', async () => {
      const { config, harness, received } = buildTwoAgentHarness();

      const result = await runBenchmark(
        planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
        harness.dependencies,
      );

      unwrapOk(result);
      expect(received.get('task-1--c1--1')).toEqual(FIRST_PROVIDERS);
      expect(received.get('task-2--c1--1')).toEqual(FIRST_PROVIDERS);
      expect(received.get('task-1--c2--1')).toEqual(SECOND_PROVIDERS);
      expect(received.get('task-2--c2--1')).toEqual(SECOND_PROVIDERS);
      expect(received.size).toBe(4);
    });
  });
  it('gives each attempt its own createIsolatedCase call with its own identity, and its own createCaseEnvironments call (AC-5, verification property 4)', async () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ repeat: 2 }),
      tasks: [buildBenchmarkTask({ id: 'task-1' })],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    expect(run.exitCode).toBe(0);
    const pairCalls = harness.git.createIsolatedCaseCalls.filter(
      (identity) => identity.modelId === 'c1',
    );
    expect(pairCalls.map((identity) => identity.caseId)).toEqual([
      'task-1--c1--1',
      'task-1--c1--2',
    ]);
    expect(pairCalls.map((identity) => identity.attempt)).toEqual([1, 2]);
    const caseIds = harness.git.createIsolatedCaseCalls.map((identity) => identity.caseId);
    expect(new Set(caseIds).size).toBe(caseIds.length);
    const environmentCaseIds = harness.environments.created.map((entry) => entry.caseId);
    expect(new Set(environmentCaseIds).size).toBe(environmentCaseIds.length);
    expect(environmentCaseIds).toHaveLength(caseIds.length);
  });

  it("passes the case's own task repository to createIsolatedCase, not the first configured repository", async () => {
    const config = buildBenchmarkConfig({
      repositories: [
        { id: 'repo-1', path: '/synthetic/source-repo-1' },
        { id: 'repo-2', path: '/synthetic/source-repo-2' },
      ],
      tasks: [buildBenchmarkTask({ id: 'task-1', repo: 'repo-2', base_commit: COMMIT_B })],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    unwrapOk(result);
    expect(harness.git.createIsolatedCaseRepositories.map((repository) => repository.id)).toEqual([
      'repo-2',
      'repo-2',
    ]);
  });

  it('returns the host probe failure before any write', async () => {
    const config = buildBenchmarkConfig();
    const harness = createHarness(config);
    harness.prerequisites.probeHostError = {
      kind: 'PrerequisiteError',
      tool: 'git',
      expected: 'git on PATH',
      actual: 'missing',
    };

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const error = unwrapError(result);
    expect(error.kind).toBe('PrerequisiteError');
    expect(harness.environments.snapshotParentCalls).toBe(0);
    expect(harness.agent.runCalls.size).toBe(0);
    expect(harness.artifacts.startedManifests).toHaveLength(0);
  });

  it('returns the snapshot failure before the capability probe and any write', async () => {
    const config = buildBenchmarkConfig();
    const harness = createHarness(config);
    harness.environments.snapshotParentError = {
      kind: 'PrerequisiteError',
      tool: 'environment',
      expected: 'non-empty parent PATH',
      actual: 'empty',
    };

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const error = unwrapError(result);
    expect(error.kind).toBe('PrerequisiteError');
    expect(harness.prerequisites.probeHostCalls).toBe(1);
    expect(harness.agent.runCalls.size).toBe(0);
    expect(harness.artifacts.startedManifests).toHaveLength(0);
  });

  it('returns the capability probe failure before commit pinning and any write', async () => {
    const config = buildBenchmarkConfig();
    const harness = createHarness(config);
    harness.agent.probeError = {
      kind: 'AgentProtocolError',
      agent: FAKE_AGENT_NAME,
      context: { phase: 'probe' },
      reason: 'synthetic missing run command',
    };

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const error = unwrapError(result);
    expect(error).toMatchObject({ kind: 'AgentProtocolError', context: { phase: 'probe' } });
    expect(harness.git.validatedCommits).toHaveLength(0);
    expect(harness.artifacts.startedManifests).toHaveLength(0);
    expect(harness.lifecycleEvents).toEqual([]);
  });

  it('returns a readProviders failure as ConfigValidationError before any startRun call', async () => {
    const config = buildBenchmarkConfig();
    const harness = createHarness(config);
    harness.agent.providersError = {
      kind: 'ConfigValidationError',
      findings: [
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message: 'synthetic provider read failure',
        },
      ],
    };

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const error = unwrapError(result);
    expect(error).toEqual({
      kind: 'ConfigValidationError',
      findings: [
        {
          severity: 'error',
          identifier: 'agents.opencode.providers.acme',
          message: 'synthetic provider read failure',
        },
      ],
    });
    expect(harness.git.validatedCommits).toHaveLength(0);
    expect(harness.artifacts.startedManifests).toHaveLength(0);
    expect(harness.lifecycleEvents).toEqual([]);
  });

  it('returns a PrerequisiteError naming the agent when no adapter is registered for it', async () => {
    const config = buildBenchmarkConfig();
    const harness = createHarness(config);
    harness.dependencies.agents = new Map();

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'PrerequisiteError',
        tool: FAKE_AGENT_NAME,
        expected: 'a registered agent adapter',
        actual: 'none',
      },
    });
  });

  it('remaps source resolution failures to the owning task before any write', async () => {
    const config = buildBenchmarkConfig();
    const harness = createHarness(config);
    harness.git.validateSourceError = {
      kind: 'SourceMaterializationError',
      taskId: 'repo-1',
      reason: 'synthetic commit is not readable',
    };

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const error = unwrapError(result);
    expect(error).toMatchObject({ kind: 'SourceMaterializationError', taskId: 'task-1' });
    expect(harness.artifacts.startedManifests).toHaveLength(0);
    expect(harness.agent.runCalls.size).toBe(0);
  });

  it("fails before any case starts when a planned case's prompt names its resolved commit", async () => {
    const config = buildBenchmarkConfig({
      tasks: [
        buildBenchmarkTask({ id: 'task-1' }),
        buildBenchmarkTask({ id: 'task-2', prompt: 'the agent prompt names pinned-something' }),
      ],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'SourceMaterializationError',
        taskId: 'task-2',
        reason: 'agent prompt contains resolved base commit pinned-',
      },
    });
    expect(harness.timeline).toEqual([
      'probeHost',
      'snapshotParent',
      'probe',
      'validateSource:repo-1',
    ]);
  });

  it("fails before any case starts when the first, uncached task's prompt names its resolved commit", async () => {
    const config = buildBenchmarkConfig({
      tasks: [
        buildBenchmarkTask({ id: 'task-1', prompt: 'the agent prompt names pinned-something' }),
        buildBenchmarkTask({ id: 'task-2' }),
      ],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'SourceMaterializationError',
        taskId: 'task-1',
        reason: 'agent prompt contains resolved base commit pinned-',
      },
    });
    expect(harness.timeline).toEqual([
      'probeHost',
      'snapshotParent',
      'probe',
      'validateSource:repo-1',
    ]);
  });

  it("fails before any case starts when a planned case's prompt names a reference commit", async () => {
    const referenceCommit = 'fedcba9876543210fedcba9876543210fedcba98';
    const config = buildBenchmarkConfig({
      tasks: [
        buildBenchmarkTask({
          id: 'task-1',
          reference: { kind: 'commit', identifier: 'HEAD~3', commits: [referenceCommit] },
          prompt: `follow the same approach as ${referenceCommit.slice(0, 7)}`,
        }),
      ],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'SourceMaterializationError',
        taskId: 'task-1',
        reason: `agent prompt contains resolved reference commit ${referenceCommit.slice(0, 7)}`,
      },
    });
    expect(harness.artifacts.startedManifests).toHaveLength(0);
    expect(harness.agent.runCalls.size).toBe(0);
  });

  it("fails before any case starts when a planned case's prompt names a pull-request reference", async () => {
    const config = buildBenchmarkConfig({
      tasks: [
        buildBenchmarkTask({
          id: 'task-1',
          reference: {
            kind: 'pull-request',
            identifier: 'octo/app#128',
            commits: ['fedcba9876543210fedcba9876543210fedcba98'],
          },
          prompt: 'follow octo/app#128 exactly',
        }),
      ],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'SourceMaterializationError',
        taskId: 'task-1',
        reason: 'agent prompt contains pull request octo/app#128',
      },
    });
    expect(harness.artifacts.startedManifests).toHaveLength(0);
    expect(harness.agent.runCalls.size).toBe(0);
  });

  it('runs the complete per-case pipeline in order with the patch captured before evaluators', async () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ concurrency: 1 }),
      tasks: [buildBenchmarkTask()],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    const caseTimeline = (caseId: string): string[] => [
      `prepare:${caseId}`,
      `environments:${caseId}`,
      `run:start:${caseId}`,
      `appendEvent:${caseId}`,
      `run:end:${caseId}`,
      `exportSession:session-${caseId}`,
      `writeSessionExport:${caseId}`,
      `patch:${caseId}`,
      `writePatch:${caseId}`,
      'check:/synthetic/acc-required',
      'check:/synthetic/dod-required',
      `writeChecks:${caseId}`,
      `finalizeCase:${caseId}`,
      `dispose:${caseId}`,
    ];
    expect(harness.timeline).toEqual([
      'probeHost',
      'snapshotParent',
      'probe',
      'validateSource:repo-1',
      `startRun:${RUN_ID}`,
      ...caseTimeline('task-1--c1--1'),
      ...caseTimeline('task-1--c2--1'),
      `finalizeRun:${RUN_ID}`,
    ]);
    expect(harness.lifecycleEvents).toEqual([
      { caseId: 'task-1--c1--1', lifecycle: 'queued' },
      { caseId: 'task-1--c2--1', lifecycle: 'queued' },
      { caseId: 'task-1--c1--1', lifecycle: 'preparing' },
      { caseId: 'task-1--c1--1', lifecycle: 'running' },
      { caseId: 'task-1--c1--1', lifecycle: 'evaluating' },
      { caseId: 'task-1--c1--1', lifecycle: 'completed' },
      { caseId: 'task-1--c2--1', lifecycle: 'preparing' },
      { caseId: 'task-1--c2--1', lifecycle: 'running' },
      { caseId: 'task-1--c2--1', lifecycle: 'evaluating' },
      { caseId: 'task-1--c2--1', lifecycle: 'completed' },
    ]);

    const runInput = harness.agent.runInputs[0];
    expect(runInput).toBeDefined();
    expect(runInput?.identity).toEqual({
      ...buildBenchmarkCaseIdentity('task-1--c1--1'),
      sourceCommit: `pinned-${COMMIT_A}`,
    });
    const task = config.tasks[0];
    expect(task).toBeDefined();
    expect(runInput?.prompt).toBe(task === undefined ? undefined : buildTaskPrompt(task));
    expect(runInput?.prompt).not.toContain(`pinned-${COMMIT_A}`);
    expect(runInput?.worktreeDirectory).toBe('/synthetic/workspaces/task-1--c1--1/worktree');
    expect(runInput?.environment).toBe(harness.environments.created[0]?.value.agent);
    expect(runInput?.timeoutMs).toBe(60_000);
    expect(runInput?.terminationGraceMs).toBe(500);
    expect(runInput?.cancellation.aborted).toBe(false);

    const caseRequests = harness.evaluatorProcesses.requests.filter(
      (request) => request.cwd === '/synthetic/workspaces/task-1--c1--1/worktree',
    );
    expect(caseRequests.map((request) => request.argv[0])).toEqual([
      '/synthetic/acc-required',
      '/synthetic/dod-required',
    ]);
    const evaluatorRequest = caseRequests[0];
    expect(evaluatorRequest?.argv).toEqual(['/synthetic/acc-required', '--verify']);
    expect(evaluatorRequest?.cwd).toBe('/synthetic/workspaces/task-1--c1--1/worktree');
    expect(evaluatorRequest?.environment).toEqual(
      harness.environments.created[0]?.value.evaluator.variables,
    );
    expect(evaluatorRequest?.timeoutMs).toBe(5_000);
    expect(evaluatorRequest?.terminationGraceMs).toBe(500);

    const caseResult = caseResultOf(run, 'task-1--c1--1');
    expect(caseResult.lifecycle).toBe('completed');
    expect(caseResult.outcome).toBe('passed');
    expect(caseResult.failure).toBeNull();
    expect(caseResult.process?.exitCode).toBe(0);
    expect(caseResult.checks.map((check) => check.verdict)).toEqual(['passed', 'passed']);
    expect(caseResult.checks[0]?.evidence).toContain('exit code 0');
    expect(caseResult.artifacts).toEqual({
      events: 'task-1--c1--1/events.jsonl',
      diagnostics: null,
      sessionExport: 'task-1--c1--1/session.json',
      solutionPatch: 'task-1--c1--1/solution.patch',
      checks: 'task-1--c1--1/checks.json',
      assessment: null,
      grading: null,
      result: 'task-1--c1--1/result.json',
    });
    expectAvailableMetric(caseResult.metrics.elapsed, 1_000, 'millisecond', 'process', 'case');
    expectAvailableMetric(caseResult.metrics.inputTokens, 10, 'token', 'root-session export');
    expectAvailableMetric(caseResult.metrics.turns, 1, 'count', 'root-session export');
    expectAvailableMetric(caseResult.metrics.apiErrors, 0, 'count', 'root-session export');
    expectAvailableMetric(caseResult.metrics.cost, 0.25, 'USD', 'root-session export');
  });

  it('caps active cases at the configured concurrency', async () => {
    const config = buildBenchmarkConfig();
    const harness = createHarness(config);
    harness.agent.holdNewRuns();
    const firstStart = harness.agent.waitForCaseStart('task-1--c1--1');
    const secondStart = harness.agent.waitForCaseStart('task-1--c2--1');

    const runPromise = runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );
    await Promise.all([firstStart, secondStart]);

    expect(harness.agent.activeCount).toBe(2);
    expect(harness.agent.maxActiveCount).toBe(2);
    expect(harness.agent.startedOrder).toEqual(['task-1--c1--1', 'task-1--c2--1']);

    harness.agent.releaseHeldRuns();
    const result = await runPromise;

    const run = unwrapOk(result);
    expect(harness.agent.maxActiveCount).toBe(2);
    expect(harness.agent.runCalls.size).toBe(4);
    expect(run.cases).toHaveLength(4);
    expect(run.cases.every((entry) => entry.lifecycle === 'completed')).toBe(true);
  });

  it('keeps the concurrency slot held while acceptance checks evaluate', async () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ concurrency: 1 }),
      tasks: [buildBenchmarkTask()],
    });
    const harness = createHarness(config);
    harness.evaluatorProcesses.holdChecks();
    const firstCheck = harness.evaluatorProcesses.waitForCheck('/synthetic/acc-required');

    const runPromise = runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );
    await firstCheck;

    expect(harness.timeline.filter((entry) => entry.startsWith('prepare:'))).toEqual([
      'prepare:task-1--c1--1',
    ]);
    expect([...harness.agent.runCalls.keys()]).toEqual(['task-1--c1--1']);

    harness.evaluatorProcesses.releaseChecks();
    const result = await runPromise;

    unwrapOk(result);
    expect(harness.agent.runCalls.size).toBe(2);
    expect(harness.timeline.filter((entry) => entry.startsWith('prepare:'))).toEqual([
      'prepare:task-1--c1--1',
      'prepare:task-1--c2--1',
    ]);
  });

  describe.each([
    {
      label: 'readable agent process failure',
      buildError: (caseId: string): CaseRunFailure => ({
        kind: 'AgentProcessError',
        agent: FAKE_AGENT_NAME,
        caseId,
        exitCode: 3,
        signal: null,
      }),
    },
    {
      label: 'readable case-context agent protocol failure',
      buildError: (caseId: string): CaseRunFailure => ({
        kind: 'AgentProtocolError',
        agent: FAKE_AGENT_NAME,
        context: { phase: 'case', caseId },
        reason: 'synthetic malformed event identity',
      }),
    },
  ])('$label', ({ buildError }) => {
    it('completes evaluation, preserves the runtime failure, and forces exit 2 without retrying', async () => {
      const config = buildBenchmarkConfig({ tasks: [buildBenchmarkTask()] });
      const harness = createHarness(config);
      harness.agent.scripts.set('task-1--c1--1', failedRunScript(buildError('task-1--c1--1')));

      const result = await runBenchmark(
        planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
        harness.dependencies,
      );

      const run = unwrapOk(result);
      const failedCase = caseResultOf(run, 'task-1--c1--1');
      expect(failedCase.lifecycle).toBe('completed');
      expect(failedCase.outcome).toBe('passed');
      expect(failedCase.failure?.error).toEqual(buildError('task-1--c1--1'));
      expect(failedCase.process?.exitCode).toBe(3);
      expect(failedCase.checks.map((check) => check.verdict)).toEqual(['passed', 'passed']);
      expect(failedCase.artifacts.sessionExport).toBe('task-1--c1--1/session.json');
      expect(failedCase.artifacts.solutionPatch).toBe('task-1--c1--1/solution.patch');
      expect(failedCase.artifacts.checks).toBe('task-1--c1--1/checks.json');
      expect(failedCase.artifacts.assessment).toBeNull();
      expectAvailableMetric(failedCase.metrics.elapsed, 4_321, 'millisecond', 'process', 'case');
      expectAvailableMetric(failedCase.metrics.inputTokens, 10, 'token', 'root-session export');
      expect(harness.agent.exportCalls).toHaveLength(2);
      expect(harness.agent.exportCalls).toContain('session-task-1--c1--1');
      expect(harness.agent.runCalls.get('task-1--c1--1')).toBe(1);
      expect(run.exitCode).toBe(2);

      const independentCase = caseResultOf(run, 'task-1--c2--1');
      expect(independentCase.lifecycle).toBe('completed');
      expect(independentCase.outcome).toBe('passed');
      expect(independentCase.failure).toBeNull();
    });
  });

  describe.each([
    {
      label: 'agent process error',
      buildError: (caseId: string): ExportFailure => ({
        kind: 'AgentProcessError',
        agent: FAKE_AGENT_NAME,
        caseId,
        exitCode: 2,
        signal: null,
      }),
    },
    {
      label: 'case-context agent protocol error',
      buildError: (caseId: string): ExportFailure => ({
        kind: 'AgentProtocolError',
        agent: FAKE_AGENT_NAME,
        context: { phase: 'case', caseId },
        reason: 'synthetic export identity failure',
      }),
    },
  ])('failing root-session export with a $label', ({ buildError }) => {
    it('completes eligible checks with truthfully unavailable export metrics and continues independent cases', async () => {
      const { run, harness } = await runWithFailingExport(buildError);

      const failedExportCase = caseResultOf(run, 'task-1--c1--1');
      expect(failedExportCase.lifecycle).toBe('completed');
      expect(failedExportCase.outcome).toBe('passed');
      expect(failedExportCase.process?.exitCode).toBe(0);
      expect(failedExportCase.checks).toHaveLength(2);
      expect(failedExportCase.checks.map((check) => check.verdict)).toEqual(['passed', 'passed']);
      expect(failedExportCase.artifacts.sessionExport).toBeNull();
      expect(failedExportCase.artifacts.checks).toBe('task-1--c1--1/checks.json');
      expectAvailableMetric(
        failedExportCase.metrics.elapsed,
        1_000,
        'millisecond',
        'process',
        'case',
      );
      expectAvailableMetric(failedExportCase.metrics.toolCalls, 1, 'count', 'run events');
      expectUnavailableMetric(failedExportCase.metrics.inputTokens, 'export failed');
      expectUnavailableMetric(failedExportCase.metrics.turns, 'export failed');
      expect(harness.agent.exportCalls).toContain('session-task-1--c1--1');

      const independentCase = caseResultOf(run, 'task-1--c2--1');
      expect(independentCase.lifecycle).toBe('completed');
      expect(independentCase.outcome).toBe('passed');
      expectAvailableMetric(
        independentCase.metrics.inputTokens,
        10,
        'token',
        'root-session export',
      );
    });

    it('preserves the failing export as the case runtime failure', async () => {
      const { run } = await runWithFailingExport(buildError);

      const failedExportCase = caseResultOf(run, 'task-1--c1--1');
      expect(failedExportCase.failure?.error).toEqual(buildError('task-1--c1--1'));
    });

    it('forces run exit 2 despite the passed acceptance outcome', async () => {
      const { run } = await runWithFailingExport(buildError);

      expect(run.exitCode).toBe(2);
    });
  });

  it('marks an unreadable workspace as process-failed and skips export, patch, and checks', async () => {
    const config = buildBenchmarkConfig({ tasks: [buildBenchmarkTask()] });
    const harness = createHarness(config);
    harness.git.unreadableCaseIds.add('task-1--c1--1');
    harness.agent.scripts.set(
      'task-1--c1--1',
      failedRunScript(
        {
          kind: 'AgentProcessError',
          agent: FAKE_AGENT_NAME,
          caseId: 'task-1--c1--1',
          exitCode: 3,
          signal: null,
        },
        { withErrorEvent: true },
      ),
    );

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    const failedCase = caseResultOf(run, 'task-1--c1--1');
    expect(failedCase.lifecycle).toBe('process-failed');
    expect(failedCase.outcome).toBe('not-evaluated');
    expect(failedCase.checks).toEqual([]);
    expect(failedCase.failure?.error.kind).toBe('AgentProcessError');
    expect(failedCase.process?.exitCode).toBe(3);
    expect(failedCase.artifacts.events).toBe('task-1--c1--1/events.jsonl');
    expect(failedCase.artifacts.sessionExport).toBeNull();
    expect(failedCase.artifacts.solutionPatch).toBeNull();
    expect(failedCase.artifacts.checks).toBeNull();
    expectAvailableMetric(failedCase.metrics.elapsed, 4_321, 'millisecond', 'process', 'case');
    expectAvailableMetric(failedCase.metrics.apiErrors, 1, 'count', 'run events');
    expectAvailableMetric(failedCase.metrics.toolCalls, 1, 'count', 'run events');
    expectUnavailableMetric(failedCase.metrics.inputTokens, 'unreadable');
    expect(harness.agent.exportCalls).not.toContain('session-task-1--c1--1');
    expect(harness.agent.runCalls.get('task-1--c1--1')).toBe(1);
    expect(harness.timeline).not.toContain(`patch:task-1--c1--1`);
    expect(
      harness.evaluatorProcesses.requests.every(
        (request) => request.cwd !== '/synthetic/workspaces/task-1--c1--1/worktree',
      ),
    ).toBe(true);
    expect(run.exitCode).toBe(2);

    const independentCase = caseResultOf(run, 'task-1--c2--1');
    expect(independentCase.lifecycle).toBe('completed');
    expect(independentCase.outcome).toBe('passed');
  });

  it('marks an unreadable workspace as process-failed after an agent session error and skips export, patch, and checks', async () => {
    const config = buildBenchmarkConfig({ tasks: [buildBenchmarkTask()] });
    const harness = createHarness(config);
    harness.git.unreadableCaseIds.add('task-1--c1--1');
    harness.agent.scripts.set(
      'task-1--c1--1',
      failedRunScript(
        { kind: 'AgentSessionError', agent: FAKE_AGENT_NAME, caseId: 'task-1--c1--1' },
        { withErrorEvent: true },
      ),
    );

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    const failedCase = caseResultOf(run, 'task-1--c1--1');
    expect(failedCase.lifecycle).toBe('process-failed');
    expect(failedCase.outcome).toBe('not-evaluated');
    expect(failedCase.checks).toEqual([]);
    expect(failedCase.failure?.error.kind).toBe('AgentSessionError');
    expect(failedCase.artifacts.sessionExport).toBeNull();
    expect(failedCase.artifacts.solutionPatch).toBeNull();
    expect(failedCase.artifacts.checks).toBeNull();
    expectAvailableMetric(failedCase.metrics.apiErrors, 1, 'count', 'run events');
    expectUnavailableMetric(
      failedCase.metrics.inputTokens,
      `the workspace was unreadable after the failure: agent "${FAKE_AGENT_NAME}" reported a session error`,
    );
    expect(harness.agent.exportCalls).not.toContain('session-task-1--c1--1');
    expect(harness.timeline).not.toContain('patch:task-1--c1--1');
    expect(run.exitCode).toBe(2);
  });

  it('times out, skips all checks, attempts the patch, and falls back to event metrics', async () => {
    const config = buildBenchmarkConfig({ tasks: [buildBenchmarkTask()] });
    const harness = createHarness(config);
    harness.agent.scripts.set('task-1--c1--1', timedOutRunScript());

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    const timedOutCase = caseResultOf(run, 'task-1--c1--1');
    expect(timedOutCase.lifecycle).toBe('timed-out');
    expect(timedOutCase.outcome).toBe('not-evaluated');
    expect(timedOutCase.checks).toEqual([]);
    expect(timedOutCase.failure?.error.kind).toBe('CaseTimeoutError');
    expect(timedOutCase.process?.terminationStage).toBe('forced');
    expect(timedOutCase.artifacts.sessionExport).toBeNull();
    expect(timedOutCase.artifacts.solutionPatch).toBe('task-1--c1--1/solution.patch');
    expect(timedOutCase.artifacts.checks).toBeNull();
    expectAvailableMetric(timedOutCase.metrics.elapsed, 4_321, 'millisecond', 'process', 'case');
    expectAvailableMetric(timedOutCase.metrics.apiErrors, 1, 'count', 'run events');
    expectAvailableMetric(timedOutCase.metrics.toolCalls, 1, 'count', 'run events');
    expectUnavailableMetric(timedOutCase.metrics.inputTokens, 'timed out');
    expect(harness.agent.exportCalls).not.toContain('session-task-1--c1--1');
    expect(harness.agent.runCalls.get('task-1--c1--1')).toBe(1);
    expect(harness.timeline).not.toContain(`exportSession:session-task-1--c1--1`);
    expect(
      harness.evaluatorProcesses.requests.every(
        (request) => request.cwd !== '/synthetic/workspaces/task-1--c1--1/worktree',
      ),
    ).toBe(true);
    expect(run.exitCode).toBe(2);
  });

  it('passes each case its own task timeout, distinct from run.timeout, to the agent and to CaseTimeoutError (AC-3)', async () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ repeat: 2 }),
      tasks: [
        buildBenchmarkTask({ id: 'task-1', timeout: '20m' }),
        buildBenchmarkTask({ id: 'task-2' }),
      ],
    });
    const harness = createHarness(config);
    harness.agent.scripts.set('task-1--c1--1', timedOutRunScript());
    const plan = planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config));

    const result = await runBenchmark(plan, harness.dependencies);

    const run = unwrapOk(result);
    const identitiesByCaseId = new Map(plan.cases.map((identity) => [identity.caseId, identity]));
    expect(harness.agent.runInputs.length).toBeGreaterThan(0);
    for (const input of harness.agent.runInputs) {
      expect(input.timeoutMs).toBe(identitiesByCaseId.get(input.identity.caseId)?.timeoutMs);
    }
    const timedOutCase = caseResultOf(run, 'task-1--c1--1');
    expect(timedOutCase.failure?.error).toEqual({
      kind: 'CaseTimeoutError',
      caseId: 'task-1--c1--1',
      timeoutMs: 1_200_000,
    });
    expect(durationMs(config.run.timeout)).not.toBe(1_200_000);
  });

  it('stops scheduling queued cases after an artifact failure and reports every planned case', async () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ concurrency: 1 }),
      tasks: [buildBenchmarkTask()],
    });
    const harness = createHarness(config);
    harness.artifacts.failOnce.set('appendEvent:task-1--c1--1', {
      kind: 'ArtifactError',
      operation: 'append-event',
      reason: 'synthetic disk full',
    });

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    const failedCase = caseResultOf(run, 'task-1--c1--1');
    expect(failedCase.lifecycle).toBe('infrastructure-failed');
    expect(failedCase.outcome).toBe('not-evaluated');
    expect(failedCase.failure?.error.kind).toBe('ArtifactError');
    expect(failedCase.artifacts.sessionExport).toBeNull();
    expect(harness.agent.exportCalls).not.toContain('session-task-1--c1--1');
    expect(harness.agent.runCalls.get('task-1--c1--1')).toBe(1);
    expect(harness.agent.runCalls.has('task-1--c2--1')).toBe(false);

    expect(run.cases.map((entry) => entry.identity.caseId)).toEqual(['task-1--c1--1']);
    expect(run.findings).toEqual([
      {
        severity: 'error',
        caseId: 'task-1--c2--1',
        message: SCHEDULING_STOPPED_MESSAGE,
      },
    ]);
    for (const plannedCaseId of ['task-1--c1--1', 'task-1--c2--1']) {
      const covered =
        run.cases.some((entry) => entry.identity.caseId === plannedCaseId) ||
        run.findings.some((finding) => finding.caseId === plannedCaseId);
      expect(covered).toBe(true);
    }
    expect(run.exitCode).toBe(1);
  });

  it('finalizes the run with queued-case findings when cancelled during a case', async () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ concurrency: 1 }),
      tasks: [buildBenchmarkTask()],
    });
    const harness = createHarness(config);
    harness.agent.scripts.set('task-1--c1--1', async (input) => {
      await waitForSignal(input.cancellation);
      return { ok: false, error: { kind: 'CancellationError', activeCaseIds: ['task-1--c1--1'] } };
    });
    const caseStart = harness.agent.waitForCaseStart('task-1--c1--1');

    const runPromise = runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );
    await caseStart;
    harness.cancellation.abort();
    const result = await runPromise;

    const run = unwrapOk(result);
    const cancelledCase = caseResultOf(run, 'task-1--c1--1');
    expect(cancelledCase.lifecycle).toBe('cancelled');
    expect(cancelledCase.outcome).toBe('not-evaluated');
    expect(cancelledCase.failure?.error.kind).toBe('CancellationError');
    expect(cancelledCase.artifacts.sessionExport).toBeNull();
    expect(harness.agent.exportCalls).not.toContain('session-task-1--c1--1');
    expect(harness.agent.runCalls.has('task-1--c2--1')).toBe(false);
    expect(run.findings).toEqual([
      {
        severity: 'warning',
        caseId: 'task-1--c2--1',
        message: CANCELLED_BEFORE_START_MESSAGE,
      },
    ]);
    expect(run.exitCode).toBe(130);
    expect(harness.artifacts.finalizedRuns).toHaveLength(1);
    expect(harness.lifecycleEvents).toContainEqual({
      caseId: 'task-1--c1--1',
      lifecycle: 'cancelled',
    });
  });

  it('finishes the case as cancelled with the evaluator request carrying the case signal when cancelled during evaluation', async () => {
    const { run, harness } = await runCancelledDuringEvaluation();

    const cancelledCase = caseResultOf(run, 'task-1--c1--1');
    expect(cancelledCase.lifecycle).toBe('cancelled');
    expect(cancelledCase.outcome).toBe('not-evaluated');
    expect(cancelledCase.artifacts.sessionExport).toBe('task-1--c1--1/session.json');
    expect(cancelledCase.artifacts.solutionPatch).toBe('task-1--c1--1/solution.patch');
    expect(cancelledCase.artifacts.checks).toBe('task-1--c1--1/checks.json');
    expect(harness.evaluatorProcesses.requests[0]?.cancellation).toBeDefined();
    expect(harness.agent.runCalls.has('task-1--c2--1')).toBe(false);
    expect(run.findings).toEqual([
      {
        severity: 'warning',
        caseId: 'task-1--c2--1',
        message: CANCELLED_BEFORE_START_MESSAGE,
      },
    ]);
    expect(run.exitCode).toBe(130);
    expect(harness.artifacts.finalizedRuns).toHaveLength(1);
  });

  it('aborts the case cancellation signal when the run is cancelled during evaluation', async () => {
    const { harness } = await runCancelledDuringEvaluation();

    expect(harness.evaluatorProcesses.requests[0]?.cancellation?.aborted).toBe(true);
  });

  it('skips remaining checks when the run is cancelled during evaluation', async () => {
    const { run } = await runCancelledDuringEvaluation();

    const cancelledCase = caseResultOf(run, 'task-1--c1--1');
    expect(cancelledCase.checks).toHaveLength(1);
    expect(cancelledCase.checks[0]).toMatchObject({ checkId: 'acc-required', verdict: 'passed' });
  });

  it('returns CancellationError without any writes when the run signal is already aborted', async () => {
    const config = buildBenchmarkConfig();
    const harness = createHarness(config);
    harness.cancellation.abort();

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const error = unwrapError(result);
    expect(error).toMatchObject({ kind: 'CancellationError', activeCaseIds: [] });
    expect(harness.prerequisites.probeHostCalls).toBe(0);
    expect(harness.git.validatedCommits).toHaveLength(0);
    expect(harness.agent.runCalls.size).toBe(0);
    expect(harness.artifacts.startedManifests).toHaveLength(0);
    expect(harness.artifacts.finalizedRuns).toHaveLength(0);
  });

  it('records preparation failure as infrastructure-failed without starting the process', async () => {
    const config = buildBenchmarkConfig({ tasks: [buildBenchmarkTask()] });
    const harness = createHarness(config);
    harness.git.createIsolatedCaseError = {
      kind: 'IsolationError',
      caseId: 'task-1--c1--1',
      reason: 'synthetic isolation failure',
    };

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    expect(run.cases).toHaveLength(2);
    for (const entry of run.cases) {
      expect(entry.lifecycle).toBe('infrastructure-failed');
      expect(entry.outcome).toBe('not-evaluated');
      expect(entry.failure?.error.kind).toBe('IsolationError');
      expect(entry.artifacts.result).toBe(`${entry.identity.caseId}/result.json`);
      expect(entry.artifacts.events).toBeNull();
      expectUnavailableMetric(entry.metrics.elapsed, 'case preparation failed');
    }
    expect(harness.agent.runCalls.size).toBe(0);
    expect(harness.timeline.filter((entry) => entry.startsWith('dispose:'))).toEqual([]);
    expect(run.exitCode).toBe(1);
  });

  it('records a cleanup warning with the retained path when disposal fails', async () => {
    const config = buildBenchmarkConfig({ tasks: [buildBenchmarkTask()] });
    const harness = createHarness(config);
    harness.git.disposeErrors.set('task-1--c1--1', {
      kind: 'ArtifactError',
      operation: 'dispose-case-workspace',
      reason: 'synthetic disposal failure',
    });

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    const disposedCase = caseResultOf(run, 'task-1--c1--1');
    expect(disposedCase.lifecycle).toBe('completed');
    expect(disposedCase.outcome).toBe('passed');
    expect(run.findings).toEqual([
      {
        severity: 'warning',
        caseId: 'task-1--c1--1',
        message:
          'tevu could not delete the workspace of this attempt, which is kept at `/synthetic/workspaces/task-1--c1--1/worktree`. The results are not affected. Delete it when you no longer need it. Technical detail: synthetic disposal failure',
      },
    ]);
    expect(run.exitCode).toBe(0);
  });

  it('stops scheduling and retains the workspace when case persistence fails', async () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ concurrency: 1 }),
      tasks: [buildBenchmarkTask()],
    });
    const harness = createHarness(config);
    harness.artifacts.failOnce.set('finalizeCase:task-1--c1--1', {
      kind: 'ArtifactError',
      operation: 'finalize-case',
      reason: 'synthetic persistence failure',
    });

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    const persistedCase = caseResultOf(run, 'task-1--c1--1');
    expect(persistedCase.lifecycle).toBe('completed');
    expect(harness.timeline).not.toContain('dispose:task-1--c1--1');
    expect(harness.agent.runCalls.has('task-1--c2--1')).toBe(false);
    expect(run.findings).toEqual([
      {
        severity: 'error',
        caseId: 'task-1--c1--1',
        message:
          'tevu could not save the result of this attempt, so the report of this run cannot be built; its workspace is kept at `/synthetic/workspaces/task-1--c1--1/worktree`. Check free space and permissions of the output directory, run the comparison again, and delete the kept workspace when you no longer need it. Technical detail: synthetic persistence failure',
      },
      {
        severity: 'error',
        caseId: 'task-1--c2--1',
        message: SCHEDULING_STOPPED_MESSAGE,
      },
    ]);
    expect(run.exitCode).toBe(1);
  });

  it('reports a failed save without a workspace when preparation fails and its result cannot be persisted', async () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ concurrency: 1 }),
      tasks: [buildBenchmarkTask()],
    });
    const harness = createHarness(config);
    harness.git.createIsolatedCaseError = {
      kind: 'IsolationError',
      caseId: 'task-1--c1--1',
      reason: 'synthetic isolation failure',
    };
    harness.artifacts.failOnce.set('finalizeCase:task-1--c1--1', {
      kind: 'ArtifactError',
      operation: 'finalize-case',
      reason: 'synthetic persistence failure',
    });

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    expect(run.findings).toContainEqual({
      severity: 'error',
      caseId: 'task-1--c1--1',
      message:
        'tevu could not save the result of this attempt, so the report of this run cannot be built. Check free space and permissions of the output directory, then run the comparison again. Technical detail: synthetic persistence failure',
    });
  });

  it('warns that the solution patch is missing when it cannot be captured after a timeout', async () => {
    const config = buildBenchmarkConfig({ tasks: [buildBenchmarkTask()] });
    const harness = createHarness(config);
    harness.agent.scripts.set('task-1--c1--1', timedOutRunScript());
    harness.git.capturePatchError = {
      kind: 'SourceMaterializationError',
      taskId: 'task-1',
      reason: 'synthetic patch failure',
    };

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    expect(caseResultOf(run, 'task-1--c1--1').lifecycle).toBe('timed-out');
    expect(run.findings).toEqual([
      {
        severity: 'warning',
        caseId: 'task-1--c1--1',
        message:
          'tevu could not save the changes this attempt made before its time limit ended it, so its solution patch is missing. The attempt counts as not evaluated either way. Nothing more is needed for this run. Technical detail: source materialization failed: synthetic patch failure',
      },
    ]);
  });

  it.each([
    {
      label: 'a failed required acceptance command',
      manualDefinitionOfDone: false,
      acceptanceExitCode: 1,
      expectedOutcome: 'failed',
    },
    {
      label: 'an unassessed required manual check',
      manualDefinitionOfDone: true,
      acceptanceExitCode: 0,
      expectedOutcome: 'pending',
    },
  ])(
    'completes $label with outcome $expectedOutcome and forces exit 2',
    async ({ manualDefinitionOfDone, acceptanceExitCode, expectedOutcome }) => {
      const config = buildBenchmarkConfig({
        tasks: [
          buildBenchmarkTask({
            checks: {
              acceptance: [buildCheck({ id: 'acc-required' })],
              done: manualDefinitionOfDone
                ? [
                    {
                      id: 'dod-required',
                      description: 'manual Definition of Done review',
                      manual: true,
                    },
                  ]
                : [
                    buildCheck({
                      id: 'dod-required',
                      run: ['/synthetic/dod-required', '--verify'],
                    }),
                  ],
            },
          }),
        ],
      });
      const harness = createHarness(config);
      if (acceptanceExitCode !== 0) {
        harness.evaluatorProcesses.exitCodes.set('/synthetic/acc-required', acceptanceExitCode);
      }

      const result = await runBenchmark(
        planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
        harness.dependencies,
      );

      const run = unwrapOk(result);
      const caseResult = caseResultOf(run, 'task-1--c1--1');
      expect(caseResult.lifecycle).toBe('completed');
      expect(caseResult.outcome).toBe(expectedOutcome);
      expect(caseResult.failure).toBeNull();
      expect(caseResult.process?.exitCode).toBe(0);
      expect(run.exitCode).toBe(2);
    },
  );
});

describe('runBenchmark repository setup orchestration (P5, P6, AC-2, AC-3)', () => {
  it('ends a failing before_agent command as not-evaluated, never starting the agent, and names the phase and command (AC-2, P5)', async () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ concurrency: 1 }),
      repositories: [
        {
          id: 'repo-1',
          path: '/synthetic/source',
          setup: { before_agent: [['/synthetic/setup-before-agent']], timeout: '5s', env: [] },
        },
      ],
      tasks: [buildBenchmarkTask()],
    });
    const harness = createHarness(config);
    harness.evaluatorProcesses.exitCodes.set('/synthetic/setup-before-agent', 7);

    const run = unwrapOk(
      await runBenchmark(
        planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
        harness.dependencies,
      ),
    );

    const caseResult = caseResultOf(run, 'task-1--c1--1');
    expect(caseResult.lifecycle).toBe('infrastructure-failed');
    expect(caseResult.outcome).toBe('not-evaluated');
    expect(harness.agent.runCalls.size).toBe(0);
    expect(caseResult.failure?.error).toMatchObject({
      kind: 'SetupError',
      phase: 'before_agent',
      argv: ['/synthetic/setup-before-agent'],
    });
    expect(caseResult.setup?.commands).toEqual([
      expect.objectContaining({
        phase: 'before_agent',
        argv: ['/synthetic/setup-before-agent'],
        outcome: 'failed',
      }),
    ]);
  });

  it('ends a failing before_checks command as not-evaluated with no check started and the solution patch preserved (AC-3, P6)', async () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ concurrency: 1 }),
      repositories: [
        {
          id: 'repo-1',
          path: '/synthetic/source',
          setup: { before_checks: [['/synthetic/setup-before-checks']], timeout: '5s', env: [] },
        },
      ],
      tasks: [buildBenchmarkTask()],
    });
    const harness = createHarness(config);
    harness.evaluatorProcesses.exitCodes.set('/synthetic/setup-before-checks', 9);

    const run = unwrapOk(
      await runBenchmark(
        planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
        harness.dependencies,
      ),
    );

    const caseResult = caseResultOf(run, 'task-1--c1--1');
    expect(caseResult.lifecycle).toBe('infrastructure-failed');
    expect(caseResult.outcome).toBe('not-evaluated');
    expect(caseResult.artifacts.solutionPatch).toBe('task-1--c1--1/solution.patch');
    expect(
      harness.evaluatorProcesses.requests.every(
        (request) =>
          request.argv[0] !== '/synthetic/acc-required' &&
          request.argv[0] !== '/synthetic/dod-required',
      ),
    ).toBe(true);
    expect(caseResult.failure?.error).toMatchObject({
      kind: 'SetupError',
      phase: 'before_checks',
      argv: ['/synthetic/setup-before-checks'],
    });
  });
});

describe('runBenchmark check-state orchestration', () => {
  function buildOverlaySnapshot(): OverlaySnapshot {
    return [
      { kind: 'file', path: 'hidden.txt', executable: false, bytes: new Uint8Array([1, 2, 3]) },
    ];
  }

  it('reads each distinct overlay directory once between the last validateSource call and the run start, and calls applyCheckState once per case between the patch write and the first evaluator process', async () => {
    const overlaySnapshot = buildOverlaySnapshot();
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ concurrency: 1 }),
      tasks: [
        buildBenchmarkTask({
          id: 'task-1',
          checks: {
            ...buildBenchmarkTask().checks,
            restore: ['tests/**'],
            overlay: '/synthetic/overlay-a',
          },
        }),
      ],
    });
    const harness = createHarness(config);
    harness.git.readOverlaySnapshots.set('/synthetic/overlay-a', overlaySnapshot);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    expect(harness.git.readOverlayCalls).toEqual(['/synthetic/overlay-a']);
    const readOverlayIndex = harness.timeline.indexOf('readOverlay:/synthetic/overlay-a');
    const lastValidateSourceIndex = harness.timeline.lastIndexOf('validateSource:repo-1');
    const startRunIndex = harness.timeline.findIndex((entry) => entry.startsWith('startRun:'));
    expect(readOverlayIndex).toBeGreaterThan(lastValidateSourceIndex);
    expect(readOverlayIndex).toBeLessThan(startRunIndex);

    expect(harness.git.applyCheckStateCalls).toHaveLength(2);
    for (const call of harness.git.applyCheckStateCalls) {
      expect(call.request).toEqual({ restore: ['tests/**'], overlay: overlaySnapshot });
    }
    const firstCaseId = harness.git.applyCheckStateCalls[0]?.caseId;
    const applyIndex = harness.timeline.indexOf(`applyCheckState:${firstCaseId}`);
    const patchWriteIndex = harness.timeline.indexOf(`writePatch:${firstCaseId}`);
    const firstCheckIndex = harness.timeline.findIndex((entry) => entry.startsWith('check:'));
    expect(applyIndex).toBeGreaterThan(patchWriteIndex);
    expect(applyIndex).toBeLessThan(firstCheckIndex);
    expect(run.exitCode).toBe(0);
  });

  it('ends the case as infrastructure-failed with no checks and no evaluator process when applyCheckState fails', async () => {
    const config = buildBenchmarkConfig({
      run: buildBenchmarkRunSettings({ concurrency: 1 }),
      tasks: [
        buildBenchmarkTask({
          id: 'task-1',
          checks: { ...buildBenchmarkTask().checks, restore: ['tests/**'] },
        }),
      ],
    });
    const harness = createHarness(config);
    const failure: Extract<TevuError, { kind: 'CheckStateError' }> = {
      kind: 'CheckStateError',
      step: 'restore',
      reason: 'synthetic restore failure',
    };
    harness.git.applyCheckStateError = failure;

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    const failedCase = caseResultOf(run, 'task-1--c1--1');
    expect(failedCase.lifecycle).toBe('infrastructure-failed');
    expect(failedCase.outcome).toBe('not-evaluated');
    expect(failedCase.checks).toEqual([]);
    expect(failedCase.artifacts.checks).toBeNull();
    expect(failedCase.artifacts.solutionPatch).toBe('task-1--c1--1/solution.patch');
    expect(failedCase.failure?.error).toEqual(failure);
    expect(harness.timeline.filter((entry) => entry.startsWith('check:'))).toEqual([]);
    expect(run.exitCode).toBe(1);
  });

  it('never calls applyCheckState or readOverlay, and omits checkState, for a task declaring neither key', async () => {
    const config = buildBenchmarkConfig({ tasks: [buildBenchmarkTask({ id: 'task-1' })] });
    const harness = createHarness(config);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    expect(harness.git.readOverlayCalls).toEqual([]);
    expect(harness.git.applyCheckStateCalls).toEqual([]);
    for (const caseResult of run.cases) {
      expect(Object.hasOwn(caseResult, 'checkState')).toBe(false);
    }
  });

  it('never calls applyCheckState and omits checkState for a task declaring an empty restore array without an overlay', async () => {
    const config = buildBenchmarkConfig({
      tasks: [
        buildBenchmarkTask({
          id: 'task-1',
          checks: { ...buildBenchmarkTask().checks, restore: [] },
        }),
      ],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    const run = unwrapOk(result);
    expect(harness.git.applyCheckStateCalls).toEqual([]);
    expect(Object.hasOwn(caseResultOf(run, 'task-1--c1--1'), 'checkState')).toBe(false);
  });

  it('returns the readOverlay failure unchanged before the run starts, any case is prepared, or any agent runs', async () => {
    const config = buildBenchmarkConfig({
      tasks: [
        buildBenchmarkTask({
          id: 'task-1',
          checks: { ...buildBenchmarkTask().checks, overlay: '/synthetic/overlay-a' },
        }),
      ],
    });
    const harness = createHarness(config);
    const failure: Extract<TevuError, { kind: 'CheckStateError' }> = {
      kind: 'CheckStateError',
      step: 'overlay',
      reason: 'synthetic overlay unreadable',
    };
    harness.git.readOverlayError = failure;

    const result = await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    );

    expect(result).toEqual({ ok: false, error: failure });
    expect(harness.timeline.some((entry) => entry.startsWith('startRun:'))).toBe(false);
    expect(harness.timeline.some((entry) => entry.startsWith('prepare:'))).toBe(false);
    expect(harness.agent.runCalls.size).toBe(0);
  });
});

const FIRST_CASE_ID = 'task-1--c1--1';
const SECOND_CASE_ID = 'task-1--c2--1';
const FIRST_CASE_FAILURE_OCCURRED_AT = '2026-01-01T00:00:02.000Z';
const EVENTS_PATH = `${FIRST_CASE_ID}/events.jsonl`;
const DIAGNOSTICS_PATH = `${FIRST_CASE_ID}/stderr.log`;
const SESSION_EXPORT_PATH = `${FIRST_CASE_ID}/session.json`;
const PATCH_PATH = `${FIRST_CASE_ID}/solution.patch`;
const CHECKS_PATH = `${FIRST_CASE_ID}/checks.json`;
const GRADING_PATH = `${FIRST_CASE_ID}/grading.json`;
const SETUP_ARGV: Record<SetupPhase, string> = {
  before_agent: '/synthetic/setup-before-agent',
  before_checks: '/synthetic/setup-before-checks',
};
const SETUP_LOG_PATH: Record<SetupPhase, string> = {
  before_agent: `${FIRST_CASE_ID}/setup-before-agent.log`,
  before_checks: `${FIRST_CASE_ID}/setup-before-checks.log`,
};
const TOOL_EVENT: FakeEventRecord = { kind: 'tool' };
const ERROR_EVENT: FakeEventRecord = { kind: 'error' };
const UNIDENTIFIED_SESSION_REASON = 'root session could not be identified';
const AGENT_NOT_STARTED_BY_CANCELLATION_REASON = 'the case was cancelled before the agent started';
const PATCH_FAILURE_WARNING =
  'tevu could not save the changes this attempt made before its time limit ended it, so its solution patch is missing. The attempt counts as not evaluated either way. Nothing more is needed for this run. Technical detail: source materialization failed: synthetic patch failure';

type CaseArtifactIndex = CaseResult['artifacts'];
type SetupEvidence = NonNullable<CaseResult['setup']>;
type RepositoriesOverride = Pick<TevuConfigInput, 'repositories'>;

function buildSingleCaseConfig(overrides: Partial<TevuConfigInput> = {}): TevuConfig {
  const config = buildBenchmarkConfig({
    run: buildBenchmarkRunSettings({ concurrency: 1 }),
    tasks: [buildBenchmarkTask()],
    ...overrides,
  });
  return { ...config, models: config.models.slice(0, 1) };
}

function buildTwoCaseConfig(overrides: Partial<TevuConfigInput> = {}): TevuConfig {
  return buildBenchmarkConfig({
    run: buildBenchmarkRunSettings({ concurrency: 1 }),
    tasks: [buildBenchmarkTask()],
    ...overrides,
  });
}

function buildGradedConfig(build: (overrides: Partial<TevuConfigInput>) => TevuConfig): TevuConfig {
  const config = build({
    tasks: [
      buildBenchmarkTask({
        checks: {
          acceptance: [buildCheck({ id: 'acc-required' })],
          done: [{ id: 'dod-graded', description: 'the change is explained' }],
        },
      }),
    ],
  });
  return {
    ...config,
    roles: { grader: { model: 'synthetic/grader-model', effort: 'high', agent: FAKE_AGENT_NAME } },
  };
}

function declareSetup(...phases: SetupPhase[]): RepositoriesOverride {
  return {
    repositories: [
      {
        id: 'repo-1',
        path: '/synthetic/source',
        setup: {
          ...(phases.includes('before_agent') ? { before_agent: [[SETUP_ARGV.before_agent]] } : {}),
          ...(phases.includes('before_checks')
            ? { before_checks: [[SETUP_ARGV.before_checks]] }
            : {}),
          timeout: '5s',
          env: [],
        },
      },
    ],
  };
}

async function runConfigured(config: TevuConfig, harness: Harness): Promise<RunResult> {
  return unwrapOk(
    await runBenchmark(
      planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
      harness.dependencies,
    ),
  );
}

async function runCancelledWhileCommandRuns(
  config: TevuConfig,
  harness: Harness,
  command: string,
): Promise<RunResult> {
  harness.evaluatorProcesses.holdChecks();
  const commandStarted = harness.evaluatorProcesses.waitForCheck(command);

  const runPromise = runConfigured(config, harness);
  await commandStarted;
  harness.cancellation.abort();
  harness.evaluatorProcesses.releaseChecks();

  return runPromise;
}

function finalizedCaseOf(harness: Harness, caseId = FIRST_CASE_ID): CaseResult {
  const found = harness.artifacts.finalizedCases.find((entry) => entry.identity.caseId === caseId);
  if (found === undefined) {
    throw new Error(`no case was finalized for ${caseId}`);
  }
  return found;
}

function timelineOf(harness: Harness, entries: readonly string[]): string[] {
  return harness.timeline.filter((entry) => entries.includes(entry));
}

function timelineAfter(harness: Harness, entry: string): string[] {
  return harness.timeline.slice(harness.timeline.indexOf(entry) + 1);
}

function buildPinnedIdentity(caseId = FIRST_CASE_ID): CaseIdentity {
  return { ...buildBenchmarkCaseIdentity(caseId), sourceCommit: `pinned-${COMMIT_A}` };
}

function buildArtifactError(
  operation: string,
  reason: string,
): Extract<TevuError, { kind: 'ArtifactError' }> {
  return { kind: 'ArtifactError', operation, reason };
}

function buildAgentProcessError(
  exitCode: number,
): Extract<TevuError, { kind: 'AgentProcessError' }> {
  return {
    kind: 'AgentProcessError',
    agent: FAKE_AGENT_NAME,
    caseId: FIRST_CASE_ID,
    exitCode,
    signal: null,
  };
}

function buildPatchCaptureError(): Extract<TevuError, { kind: 'SourceMaterializationError' }> {
  return {
    kind: 'SourceMaterializationError',
    taskId: 'task-1',
    reason: 'synthetic patch failure',
  };
}

function buildCancellationError(): Extract<TevuError, { kind: 'CancellationError' }> {
  return { kind: 'CancellationError', activeCaseIds: [FIRST_CASE_ID] };
}

function buildTimeoutError(): Extract<TevuError, { kind: 'CaseTimeoutError' }> {
  return { kind: 'CaseTimeoutError', caseId: FIRST_CASE_ID, timeoutMs: 60_000 };
}

function buildTimedOutProcess(): ProcessResult {
  return buildBenchmarkProcessResult({
    exitCode: null,
    signal: 'SIGKILL',
    durationMs: 4_321,
    terminationStage: 'forced',
  });
}

function buildFailedProcess(): ProcessResult {
  return buildBenchmarkProcessResult({ exitCode: 3, durationMs: 4_321 });
}

function recordedFailure(error: TevuError): FailureRecord {
  return buildFailureRecord({ error, occurredAt: FIRST_CASE_FAILURE_OCCURRED_AT });
}

function buildFirstCaseArtifacts(overrides: Partial<CaseArtifactIndex> = {}): CaseArtifactIndex {
  return buildCaseArtifacts({ result: `${FIRST_CASE_ID}/result.json`, ...overrides });
}

function buildMeasuredElapsed(durationMs: number): MetricValue {
  return {
    value: durationMs,
    unit: 'millisecond',
    availability: { status: 'available', source: 'process' },
    scope: 'case',
  };
}

function buildExportedMetrics(durationMs: number): BenchmarkMetrics {
  return { elapsed: buildMeasuredElapsed(durationMs), ...buildFullMetrics() };
}

function buildFallbackMetrics(
  durationMs: number,
  reason: string,
  events: readonly FakeEventRecord[],
): BenchmarkMetrics {
  return {
    elapsed: buildMeasuredElapsed(durationMs),
    ...buildEventFallbackMetrics(reason, events),
  };
}

function buildPassedCheck(checkId: string, category: CheckResult['category']): CheckResult {
  return {
    checkId,
    category,
    verdict: 'passed',
    evidence: 'exit code 0\nstdout (0 bytes)\nstderr (0 bytes)',
    durationMs: 5,
  };
}

function buildPassedChecks(): CheckResult[] {
  return [
    buildPassedCheck('acc-required', 'acceptance'),
    buildPassedCheck('dod-required', 'definition-of-done'),
  ];
}

function buildAwaitingGraderCheck(): CheckResult {
  return {
    checkId: 'dod-graded',
    category: 'definition-of-done',
    verdict: 'pending',
    evidence: 'awaiting the grader',
    durationMs: null,
  };
}

function buildGradedCheck(): CheckResult {
  return {
    checkId: 'dod-graded',
    category: 'definition-of-done',
    verdict: 'passed',
    evidence:
      'graded passed by synthetic/grader-model (effort high, agent fake-agent): synthetic rationale',
    durationMs: null,
  };
}

function buildCaseGrading(): CaseGrading {
  return {
    grader: { model: 'synthetic/grader-model', effort: 'high', agent: FAKE_AGENT_NAME },
    call: { status: 'replied', reply: 'synthetic reply' },
    calls: [],
    metrics: buildFullMetrics(),
    grades: [
      {
        checkId: 'dod-graded',
        category: 'definition-of-done',
        status: 'graded',
        verdict: 'passed',
        rationale: 'synthetic rationale',
      },
    ],
  };
}

function buildGradedOutcome(retainedDirectories: readonly string[] = []): GradeCaseOutcome {
  return { status: 'graded', grading: buildCaseGrading(), retainedDirectories };
}

function buildCheckStateRecord(overrides: Partial<CheckStateRecord> = {}): CheckStateRecord {
  return {
    restore: { restored: ['tests/restored.test.ts'], removed: ['tests/extra.test.ts'] },
    overlay: null,
    ...overrides,
  };
}

function buildSetupCommandRecord(
  phase: SetupPhase,
  overrides: Partial<SetupCommandRecord> = {},
): SetupCommandRecord {
  return {
    phase,
    argv: [SETUP_ARGV[phase]],
    exitCode: 0,
    durationMs: 5,
    outcome: 'passed',
    ...overrides,
  };
}

function buildSetupEvidence(
  logs: Partial<SetupEvidence['logs']>,
  commands: SetupCommandRecord[],
): SetupEvidence {
  return { logs: { beforeAgent: null, beforeChecks: null, ...logs }, commands };
}

function buildContext(harness: Harness): NonNullable<CaseResult['context']> {
  const created = harness.environments.created.find((entry) => entry.caseId === FIRST_CASE_ID);
  if (created === undefined) {
    throw new Error(`no environments were created for ${FIRST_CASE_ID}`);
  }
  return {
    sourceRepositoryPath: '/synthetic/source-task-1',
    syntheticCommit: `synthetic-${FIRST_CASE_ID}`,
    environment: [
      ...created.value.agent.variableManifest,
      ...created.value.evaluator.variableManifest,
    ],
  };
}

/** The default record of a first case whose agent ran, whose export and patch were written, and whose checks all passed. */
function buildAgentRanCase(harness: Harness, overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    schemaVersion: 1,
    identity: buildPinnedIdentity(),
    lifecycle: 'completed',
    process: buildBenchmarkProcessResult(),
    outcome: 'passed',
    checks: buildPassedChecks(),
    metrics: buildExportedMetrics(1_000),
    artifacts: buildFirstCaseArtifacts({
      events: EVENTS_PATH,
      sessionExport: SESSION_EXPORT_PATH,
      solutionPatch: PATCH_PATH,
      checks: CHECKS_PATH,
    }),
    failure: null,
    context: buildContext(harness),
    ...overrides,
  };
}

function buildNotEvaluatedCase(
  harness: Harness,
  overrides: Partial<CaseResult> & Pick<CaseResult, 'lifecycle'>,
): CaseResult {
  return buildAgentRanCase(harness, { outcome: 'not-evaluated', checks: [], ...overrides });
}

function buildAgentNotStartedCase(
  lifecycle: 'infrastructure-failed' | 'cancelled',
  failure: TevuError,
  reason: string,
  setup: SetupEvidence,
): CaseResult {
  return {
    schemaVersion: 1,
    identity: buildPinnedIdentity(),
    lifecycle,
    process: null,
    outcome: 'not-evaluated',
    checks: [],
    metrics: unavailableBenchmarkMetrics(reason),
    artifacts: buildFirstCaseArtifacts(),
    failure: recordedFailure(failure),
    setup,
  };
}

function sessionlessRunScript(error?: CaseRunFailure): RunScript {
  return async (input) => {
    await input.onEvent(TOOL_EVENT);
    const value = buildAgentRunResult({
      sessionId: null,
      ...(error === undefined ? {} : { process: buildFailedProcess() }),
    });
    input.onProcess?.(value);
    return error === undefined ? { ok: true, value } : { ok: false, error };
  };
}

function abortingRunScript(harness: Harness, script: RunScript = successfulRunScript): RunScript {
  return async (input) => {
    const outcome = await script(input);
    harness.cancellation.abort();
    return outcome;
  };
}

describe('case lifecycle: result record shape', () => {
  it('orders the keys of a completed case result and of its artifact index', async () => {
    const config = buildSingleCaseConfig();
    const harness = createHarness(config);

    await runConfigured(config, harness);

    const completed = finalizedCaseOf(harness);
    expect(Object.keys(completed)).toEqual([
      'schemaVersion',
      'identity',
      'lifecycle',
      'process',
      'outcome',
      'checks',
      'metrics',
      'artifacts',
      'failure',
      'context',
    ]);
    expect(Object.keys(completed.artifacts)).toEqual([
      'events',
      'diagnostics',
      'sessionExport',
      'solutionPatch',
      'checks',
      'assessment',
      'grading',
      'result',
    ]);
  });

  it('places checkState and setup between failure and context, with the before_agent log listed first', async () => {
    const config = buildSingleCaseConfig({
      ...declareSetup('before_agent', 'before_checks'),
      tasks: [
        buildBenchmarkTask({ checks: { ...buildBenchmarkTask().checks, restore: ['tests/**'] } }),
      ],
    });
    const harness = createHarness(config);

    await runConfigured(config, harness);

    const completed = finalizedCaseOf(harness);
    expect(Object.keys(completed)).toEqual([
      'schemaVersion',
      'identity',
      'lifecycle',
      'process',
      'outcome',
      'checks',
      'metrics',
      'artifacts',
      'failure',
      'checkState',
      'setup',
      'context',
    ]);
    expect(Object.keys(completed.setup ?? {})).toEqual(['logs', 'commands']);
    expect(Object.keys(completed.setup?.logs ?? {})).toEqual(['beforeAgent', 'beforeChecks']);
  });

  it('orders the keys of a case result for a case whose agent never started', async () => {
    const config = buildSingleCaseConfig(declareSetup('before_agent'));
    const harness = createHarness(config);
    harness.evaluatorProcesses.exitCodes.set(SETUP_ARGV.before_agent, 7);

    await runConfigured(config, harness);

    expect(Object.keys(finalizedCaseOf(harness))).toEqual([
      'schemaVersion',
      'identity',
      'lifecycle',
      'process',
      'outcome',
      'checks',
      'metrics',
      'artifacts',
      'failure',
      'setup',
    ]);
  });
});

describe('case lifecycle: before the agent', () => {
  it('captures the patch without a patch base when the repository declares no before_agent', async () => {
    const config = buildSingleCaseConfig();
    const harness = createHarness(config);

    await runConfigured(config, harness);

    expect(harness.git.capturePatchBases).toEqual([{ caseId: FIRST_CASE_ID, base: undefined }]);
    expect(harness.timeline.some((entry) => entry.startsWith('snapshotPatchBase:'))).toBe(false);
  });

  it('ends the case without starting the agent and stops scheduling when the before_agent log cannot be written', async () => {
    const config = buildTwoCaseConfig(declareSetup('before_agent'));
    const harness = createHarness(config);
    const logFailure = buildArtifactError('write-setup-log', 'synthetic setup log failure');
    harness.artifacts.failOnce.set(`writeSetupLog:${FIRST_CASE_ID}`, logFailure);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentNotStartedCase(
        'infrastructure-failed',
        logFailure,
        'the setup.before_agent log could not be written; the agent did not start',
        buildSetupEvidence({}, [buildSetupCommandRecord('before_agent')]),
      ),
    );
    expect(harness.agent.runCalls.size).toBe(0);
    expect(run.findings).toEqual([
      { severity: 'error', caseId: SECOND_CASE_ID, message: SCHEDULING_STOPPED_MESSAGE },
    ]);
    expect(run.exitCode).toBe(1);
  });

  it('reports the log write failure rather than the command failure when a failing before_agent command also loses its log', async () => {
    const config = buildTwoCaseConfig(declareSetup('before_agent'));
    const harness = createHarness(config);
    const logFailure = buildArtifactError('write-setup-log', 'synthetic setup log failure');
    harness.evaluatorProcesses.exitCodes.set(SETUP_ARGV.before_agent, 7);
    harness.artifacts.failOnce.set(`writeSetupLog:${FIRST_CASE_ID}`, logFailure);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentNotStartedCase(
        'infrastructure-failed',
        logFailure,
        'the setup.before_agent log could not be written; the agent did not start',
        buildSetupEvidence({}, [
          buildSetupCommandRecord('before_agent', { exitCode: 7, outcome: 'failed' }),
        ]),
      ),
    );
    expect(run.findings).toEqual([
      { severity: 'error', caseId: SECOND_CASE_ID, message: SCHEDULING_STOPPED_MESSAGE },
    ]);
  });

  it('ends the case without starting the agent and keeps scheduling when a before_agent command fails', async () => {
    const config = buildTwoCaseConfig(declareSetup('before_agent'));
    const harness = createHarness(config);
    harness.evaluatorProcesses.exitCodes.set(SETUP_ARGV.before_agent, 7);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentNotStartedCase(
        'infrastructure-failed',
        {
          kind: 'SetupError',
          phase: 'before_agent',
          argv: [SETUP_ARGV.before_agent],
          reason: 'exited with code 7',
        },
        'setup.before_agent failed; the agent did not start',
        buildSetupEvidence({ beforeAgent: SETUP_LOG_PATH.before_agent }, [
          buildSetupCommandRecord('before_agent', { exitCode: 7, outcome: 'failed' }),
        ]),
      ),
    );
    expect(harness.agent.runCalls.size).toBe(0);
    expect(run.cases.map((entry) => entry.lifecycle)).toEqual([
      'infrastructure-failed',
      'infrastructure-failed',
    ]);
    expect(run.findings).toEqual([]);
  });

  it.each([
    {
      label: 'a command that reports its cancellation',
      exitCode: 1,
      command: buildSetupCommandRecord('before_agent', { exitCode: 1, outcome: 'cancelled' }),
    },
    {
      label: 'a command that passes while the run is cancelled',
      exitCode: 0,
      command: buildSetupCommandRecord('before_agent'),
    },
  ])(
    'ends the case as cancelled without starting the agent when the run is cancelled during before_agent with $label',
    async ({ exitCode, command }) => {
      const config = buildSingleCaseConfig(declareSetup('before_agent'));
      const harness = createHarness(config);
      harness.evaluatorProcesses.exitCodes.set(SETUP_ARGV.before_agent, exitCode);

      const run = await runCancelledWhileCommandRuns(config, harness, SETUP_ARGV.before_agent);

      expect(finalizedCaseOf(harness)).toEqual(
        buildAgentNotStartedCase(
          'cancelled',
          buildCancellationError(),
          AGENT_NOT_STARTED_BY_CANCELLATION_REASON,
          buildSetupEvidence({ beforeAgent: SETUP_LOG_PATH.before_agent }, [command]),
        ),
      );
      expect(harness.agent.runCalls.size).toBe(0);
      expect(harness.timeline.some((entry) => entry.startsWith('snapshotPatchBase:'))).toBe(false);
      expect(run.exitCode).toBe(130);
    },
  );

  it('ends the case without starting the agent and keeps scheduling when the patch base cannot be recorded', async () => {
    const config = buildTwoCaseConfig(declareSetup('before_agent'));
    const harness = createHarness(config);
    const baseFailure = buildArtifactError('snapshot-patch-base', 'synthetic patch base failure');
    harness.git.snapshotPatchBaseError = baseFailure;

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentNotStartedCase(
        'infrastructure-failed',
        baseFailure,
        'the patch base could not be recorded; the agent did not start',
        buildSetupEvidence({ beforeAgent: SETUP_LOG_PATH.before_agent }, [
          buildSetupCommandRecord('before_agent'),
        ]),
      ),
    );
    expect(harness.agent.runCalls.size).toBe(0);
    expect(run.cases.map((entry) => entry.lifecycle)).toEqual([
      'infrastructure-failed',
      'infrastructure-failed',
    ]);
    expect(run.findings).toEqual([]);
  });

  it('ends the case as cancelled without starting the agent when the run is cancelled while the patch base is recorded', async () => {
    const config = buildSingleCaseConfig(declareSetup('before_agent'));
    const harness = createHarness(config);
    harness.abortDuring.add('snapshotPatchBase');

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentNotStartedCase(
        'cancelled',
        buildCancellationError(),
        AGENT_NOT_STARTED_BY_CANCELLATION_REASON,
        buildSetupEvidence({ beforeAgent: SETUP_LOG_PATH.before_agent }, [
          buildSetupCommandRecord('before_agent'),
        ]),
      ),
    );
    expect(harness.agent.runCalls.size).toBe(0);
    expect(timelineOf(harness, [`snapshotPatchBase:${FIRST_CASE_ID}`])).toEqual([
      `snapshotPatchBase:${FIRST_CASE_ID}`,
    ]);
    expect(run.exitCode).toBe(130);
  });

  it('records the before_agent evidence and hands the recorded patch base to patch capture when before_agent passes', async () => {
    const config = buildSingleCaseConfig(declareSetup('before_agent'));
    const harness = createHarness(config);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentRanCase(harness, {
        setup: buildSetupEvidence({ beforeAgent: SETUP_LOG_PATH.before_agent }, [
          buildSetupCommandRecord('before_agent'),
        ]),
      }),
    );
    expect(harness.git.capturePatchBases).toEqual([
      {
        caseId: FIRST_CASE_ID,
        base: { tree: `tree-${FIRST_CASE_ID}`, objectDirectory: `objects-${FIRST_CASE_ID}` },
      },
    ]);
    expect(
      timelineOf(harness, [
        `writeSetupLog:${FIRST_CASE_ID}`,
        `snapshotPatchBase:${FIRST_CASE_ID}`,
        `run:start:${FIRST_CASE_ID}`,
      ]),
    ).toEqual([
      `writeSetupLog:${FIRST_CASE_ID}`,
      `snapshotPatchBase:${FIRST_CASE_ID}`,
      `run:start:${FIRST_CASE_ID}`,
    ]);
    expect(run.exitCode).toBe(0);
  });

  it.each([
    { callback: 'onEvent', operation: 'appendEvent' },
    { callback: 'onDiagnostic', operation: 'appendDiagnostic' },
  ] as const)(
    'aborts the agent run and hands the append failure back to the adapter when $callback cannot append',
    async ({ callback, operation }) => {
      const config = buildSingleCaseConfig();
      const harness = createHarness(config);
      const appendFailure = buildArtifactError(operation, 'synthetic disk full');
      harness.artifacts.failOnce.set(`${operation}:${FIRST_CASE_ID}`, appendFailure);
      const observed: { abortedBefore?: boolean; appended?: unknown; abortedAfter?: boolean } = {};
      harness.agent.scripts.set(FIRST_CASE_ID, async (input) => {
        observed.abortedBefore = input.cancellation.aborted;
        observed.appended =
          callback === 'onEvent'
            ? await input.onEvent(TOOL_EVENT)
            : await input.onDiagnostic('synthetic stderr line');
        observed.abortedAfter = input.cancellation.aborted;
        const value = buildAgentRunResult({ sessionId: `session-${FIRST_CASE_ID}` });
        input.onProcess?.(value);
        return { ok: true, value };
      });

      await runConfigured(config, harness);

      expect(observed).toEqual({
        abortedBefore: false,
        appended: { ok: false, error: appendFailure },
        abortedAfter: true,
      });
    },
  );

  it('ends the case on the first artifact failure, counts the later diagnostic, and stops scheduling the queued case', async () => {
    const config = buildTwoCaseConfig();
    const harness = createHarness(config);
    const eventFailure = buildArtifactError('append-event', 'synthetic event disk full');
    harness.artifacts.failOnce.set(`appendEvent:${FIRST_CASE_ID}`, eventFailure);
    harness.artifacts.failOnce.set(
      `appendDiagnostic:${FIRST_CASE_ID}`,
      buildArtifactError('append-diagnostic', 'synthetic diagnostic disk full'),
    );
    harness.agent.scripts.set(FIRST_CASE_ID, async (input) => {
      await input.onEvent(TOOL_EVENT);
      await input.onDiagnostic('synthetic stderr line');
      const value = buildAgentRunResult({ sessionId: `session-${FIRST_CASE_ID}` });
      input.onProcess?.(value);
      return { ok: true, value };
    });

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'infrastructure-failed',
        failure: recordedFailure(eventFailure),
        metrics: buildFallbackMetrics(
          1_000,
          'an artifact failure ended the case before the root session could be exported',
          [TOOL_EVENT],
        ),
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          diagnostics: DIAGNOSTICS_PATH,
        }),
      }),
    );
    expect(harness.agent.exportCalls).toEqual([]);
    expect(run.findings).toEqual([
      { severity: 'error', caseId: SECOND_CASE_ID, message: SCHEDULING_STOPPED_MESSAGE },
    ]);
    expect(run.exitCode).toBe(1);
  });
});

describe('case lifecycle: agent outcome', () => {
  it('ends a cancelled agent run as cancelled with event metrics and no export', async () => {
    const config = buildSingleCaseConfig();
    const harness = createHarness(config);
    harness.agent.scripts.set(FIRST_CASE_ID, failedRunScript(buildCancellationError()));

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'cancelled',
        process: buildFailedProcess(),
        failure: recordedFailure(buildCancellationError()),
        metrics: buildFallbackMetrics(
          4_321,
          'the case was cancelled before the root session could be exported',
          [TOOL_EVENT],
        ),
        artifacts: buildFirstCaseArtifacts({ events: EVENTS_PATH }),
      }),
    );
    expect(harness.agent.exportCalls).toEqual([]);
    expect(run.exitCode).toBe(130);
  });

  it('ends a timed-out agent run as timed-out with its solution patch and event metrics', async () => {
    const config = buildSingleCaseConfig();
    const harness = createHarness(config);
    harness.agent.scripts.set(FIRST_CASE_ID, timedOutRunScript());

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'timed-out',
        process: buildTimedOutProcess(),
        failure: recordedFailure(buildTimeoutError()),
        metrics: buildFallbackMetrics(
          4_321,
          'the case timed out before the root session could be exported',
          [TOOL_EVENT, ERROR_EVENT],
        ),
        artifacts: buildFirstCaseArtifacts({ events: EVENTS_PATH, solutionPatch: PATCH_PATH }),
      }),
    );
    expect(harness.agent.exportCalls).toEqual([]);
    expect(run.exitCode).toBe(2);
  });

  it('ends a timed-out agent run as infrastructure-failed and stops scheduling when its patch cannot be written', async () => {
    const config = buildTwoCaseConfig();
    const harness = createHarness(config);
    const writeFailure = buildArtifactError('write-patch', 'synthetic patch write failure');
    harness.agent.scripts.set(FIRST_CASE_ID, timedOutRunScript());
    harness.artifacts.failOnce.set(`writePatch:${FIRST_CASE_ID}`, writeFailure);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'infrastructure-failed',
        process: buildTimedOutProcess(),
        failure: recordedFailure(writeFailure),
        metrics: buildFallbackMetrics(
          4_321,
          'the case timed out before the root session could be exported',
          [TOOL_EVENT, ERROR_EVENT],
        ),
        artifacts: buildFirstCaseArtifacts({ events: EVENTS_PATH }),
      }),
    );
    expect(run.findings).toEqual([
      { severity: 'error', caseId: SECOND_CASE_ID, message: SCHEDULING_STOPPED_MESSAGE },
    ]);
    expect(run.exitCode).toBe(1);
  });

  it('ends a timed-out agent run as timed-out and warns when its patch cannot be captured', async () => {
    const config = buildSingleCaseConfig();
    const harness = createHarness(config);
    harness.agent.scripts.set(FIRST_CASE_ID, timedOutRunScript());
    harness.git.capturePatchError = buildPatchCaptureError();

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'timed-out',
        process: buildTimedOutProcess(),
        failure: recordedFailure(buildTimeoutError()),
        metrics: buildFallbackMetrics(
          4_321,
          'the case timed out before the root session could be exported',
          [TOOL_EVENT, ERROR_EVENT],
        ),
        artifacts: buildFirstCaseArtifacts({ events: EVENTS_PATH }),
      }),
    );
    expect(run.findings).toEqual([
      { severity: 'warning', caseId: FIRST_CASE_ID, message: PATCH_FAILURE_WARNING },
    ]);
    expect(run.exitCode).toBe(2);
  });
});

describe('case lifecycle: export and patch', () => {
  it.each([
    {
      label: 'a clean exit',
      script: sessionlessRunScript(),
      process: buildBenchmarkProcessResult(),
      durationMs: 1_000,
      failure: null,
      reason: UNIDENTIFIED_SESSION_REASON,
      exitCode: 0,
    },
    {
      label: 'a failed run',
      script: sessionlessRunScript(buildAgentProcessError(3)),
      process: buildFailedProcess(),
      durationMs: 4_321,
      failure: buildAgentProcessError(3),
      reason: `${UNIDENTIFIED_SESSION_REASON} after the failure: agent "fake-agent" process ended with exit code 3 and signal null`,
      exitCode: 2,
    },
  ])(
    'completes the case without an export and names the missing session in the metrics after $label',
    async ({ script, process, durationMs, failure, reason, exitCode }) => {
      const config = buildSingleCaseConfig();
      const harness = createHarness(config);
      harness.agent.scripts.set(FIRST_CASE_ID, script);

      const run = await runConfigured(config, harness);

      expect(finalizedCaseOf(harness)).toEqual(
        buildAgentRanCase(harness, {
          process,
          failure: failure === null ? null : recordedFailure(failure),
          metrics: buildFallbackMetrics(durationMs, reason, [TOOL_EVENT]),
          artifacts: buildFirstCaseArtifacts({
            events: EVENTS_PATH,
            solutionPatch: PATCH_PATH,
            checks: CHECKS_PATH,
          }),
        }),
      );
      expect(harness.agent.exportCalls).toEqual([]);
      expect(run.exitCode).toBe(exitCode);
    },
  );

  it('ends the case as infrastructure-failed and stops scheduling when the session export cannot be written', async () => {
    const config = buildTwoCaseConfig();
    const harness = createHarness(config);
    const writeFailure = buildArtifactError(
      'write-session-export',
      'synthetic export write failure',
    );
    harness.artifacts.failOnce.set(`writeSessionExport:${FIRST_CASE_ID}`, writeFailure);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'infrastructure-failed',
        failure: recordedFailure(writeFailure),
        metrics: buildFallbackMetrics(
          1_000,
          'session export could not be persisted: synthetic export write failure',
          [TOOL_EVENT],
        ),
        artifacts: buildFirstCaseArtifacts({ events: EVENTS_PATH }),
      }),
    );
    expect(harness.agent.exportCalls).toEqual([`session-${FIRST_CASE_ID}`]);
    expect(run.findings).toEqual([
      { severity: 'error', caseId: SECOND_CASE_ID, message: SCHEDULING_STOPPED_MESSAGE },
    ]);
    expect(run.exitCode).toBe(1);
  });

  it('keeps the runtime failure of the agent run when the session export fails as well', async () => {
    const config = buildSingleCaseConfig();
    const harness = createHarness(config);
    harness.agent.scripts.set(FIRST_CASE_ID, failedRunScript(buildAgentProcessError(3)));
    harness.agent.exportFailures.set(`session-${FIRST_CASE_ID}`, buildAgentProcessError(2));

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentRanCase(harness, {
        process: buildFailedProcess(),
        failure: recordedFailure(buildAgentProcessError(3)),
        metrics: buildFallbackMetrics(
          4_321,
          'root session export failed: agent "fake-agent" process ended with exit code 2 and signal null',
          [TOOL_EVENT],
        ),
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          solutionPatch: PATCH_PATH,
          checks: CHECKS_PATH,
        }),
      }),
    );
    expect(run.exitCode).toBe(2);
  });

  it.each([
    {
      label: 'an unidentifiable session',
      script: sessionlessRunScript(),
      exportFailure: null,
      failure: null,
      metrics: buildFallbackMetrics(1_000, UNIDENTIFIED_SESSION_REASON, [TOOL_EVENT]),
      artifacts: { events: EVENTS_PATH },
    },
    {
      label: 'a written session export',
      script: successfulRunScript,
      exportFailure: null,
      failure: null,
      metrics: buildExportedMetrics(1_000),
      artifacts: { events: EVENTS_PATH, sessionExport: SESSION_EXPORT_PATH },
    },
    {
      label: 'a failed session export',
      script: successfulRunScript,
      exportFailure: buildAgentProcessError(2),
      failure: buildAgentProcessError(2),
      metrics: buildFallbackMetrics(
        1_000,
        'root session export failed: agent "fake-agent" process ended with exit code 2 and signal null',
        [TOOL_EVENT],
      ),
      artifacts: { events: EVENTS_PATH },
    },
  ])(
    'ends the case as cancelled before capturing the patch when the run is already cancelled after $label',
    async ({ script, exportFailure, failure, metrics, artifacts }) => {
      const config = buildSingleCaseConfig();
      const harness = createHarness(config);
      harness.agent.scripts.set(FIRST_CASE_ID, abortingRunScript(harness, script));
      if (exportFailure !== null) {
        harness.agent.exportFailures.set(`session-${FIRST_CASE_ID}`, exportFailure);
      }

      const run = await runConfigured(config, harness);

      expect(finalizedCaseOf(harness)).toEqual(
        buildNotEvaluatedCase(harness, {
          lifecycle: 'cancelled',
          failure: failure === null ? null : recordedFailure(failure),
          metrics,
          artifacts: buildFirstCaseArtifacts(artifacts),
        }),
      );
      expect(harness.git.capturePatchBases).toEqual([]);
      expect(run.exitCode).toBe(130);
    },
  );

  it('ends the case as infrastructure-failed and keeps scheduling when the patch cannot be captured', async () => {
    const config = buildTwoCaseConfig();
    const harness = createHarness(config);
    harness.git.capturePatchError = buildPatchCaptureError();

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'infrastructure-failed',
        failure: recordedFailure(buildPatchCaptureError()),
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          sessionExport: SESSION_EXPORT_PATH,
        }),
      }),
    );
    expect(run.cases.map((entry) => entry.lifecycle)).toEqual([
      'infrastructure-failed',
      'infrastructure-failed',
    ]);
    expect(run.findings).toEqual([]);
    expect(run.exitCode).toBe(1);
  });

  it('ends the case as infrastructure-failed and stops scheduling when the patch cannot be written', async () => {
    const config = buildTwoCaseConfig();
    const harness = createHarness(config);
    const writeFailure = buildArtifactError('write-patch', 'synthetic patch write failure');
    harness.artifacts.failOnce.set(`writePatch:${FIRST_CASE_ID}`, writeFailure);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'infrastructure-failed',
        failure: recordedFailure(writeFailure),
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          sessionExport: SESSION_EXPORT_PATH,
        }),
      }),
    );
    expect(run.findings).toEqual([
      { severity: 'error', caseId: SECOND_CASE_ID, message: SCHEDULING_STOPPED_MESSAGE },
    ]);
    expect(run.exitCode).toBe(1);
  });

  it('ends the case as cancelled with its written patch when the run is cancelled while the patch is written', async () => {
    const config = buildSingleCaseConfig();
    const harness = createHarness(config);
    harness.abortDuring.add('writePatch');

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'cancelled',
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          sessionExport: SESSION_EXPORT_PATH,
          solutionPatch: PATCH_PATH,
        }),
      }),
    );
    expect(harness.timeline.some((entry) => entry.startsWith('check:'))).toBe(false);
    expect(run.exitCode).toBe(130);
  });
});

describe('case lifecycle: checks', () => {
  it('records the applied check state on the completed case', async () => {
    const checkState = buildCheckStateRecord();
    const config = buildSingleCaseConfig({
      tasks: [
        buildBenchmarkTask({ checks: { ...buildBenchmarkTask().checks, restore: ['tests/**'] } }),
      ],
    });
    const harness = createHarness(config);
    harness.git.applyCheckStateResults.set(FIRST_CASE_ID, checkState);

    await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(buildAgentRanCase(harness, { checkState }));
  });

  it('ends the case as infrastructure-failed and stops scheduling when the before_checks log cannot be written', async () => {
    const config = buildTwoCaseConfig(declareSetup('before_checks'));
    const harness = createHarness(config);
    const logFailure = buildArtifactError('write-setup-log', 'synthetic setup log failure');
    harness.artifacts.failOnce.set(`writeSetupLog:${FIRST_CASE_ID}`, logFailure);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'infrastructure-failed',
        failure: recordedFailure(logFailure),
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          sessionExport: SESSION_EXPORT_PATH,
          solutionPatch: PATCH_PATH,
        }),
        setup: buildSetupEvidence({}, [buildSetupCommandRecord('before_checks')]),
      }),
    );
    expect(run.findings).toEqual([
      { severity: 'error', caseId: SECOND_CASE_ID, message: SCHEDULING_STOPPED_MESSAGE },
    ]);
    expect(run.exitCode).toBe(1);
  });

  it('ends the case as infrastructure-failed without starting a check when a before_checks command fails', async () => {
    const config = buildTwoCaseConfig(declareSetup('before_checks'));
    const harness = createHarness(config);
    harness.evaluatorProcesses.exitCodes.set(SETUP_ARGV.before_checks, 9);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'infrastructure-failed',
        failure: recordedFailure({
          kind: 'SetupError',
          phase: 'before_checks',
          argv: [SETUP_ARGV.before_checks],
          reason: 'exited with code 9',
        }),
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          sessionExport: SESSION_EXPORT_PATH,
          solutionPatch: PATCH_PATH,
        }),
        setup: buildSetupEvidence({ beforeChecks: SETUP_LOG_PATH.before_checks }, [
          buildSetupCommandRecord('before_checks', { exitCode: 9, outcome: 'failed' }),
        ]),
      }),
    );
    expect(harness.evaluatorProcesses.requests.map((request) => request.argv[0])).toEqual([
      SETUP_ARGV.before_checks,
      SETUP_ARGV.before_checks,
    ]);
    expect(run.cases.map((entry) => entry.lifecycle)).toEqual([
      'infrastructure-failed',
      'infrastructure-failed',
    ]);
    expect(run.findings).toEqual([]);
  });

  it.each([
    {
      label: 'a command that reports its cancellation',
      exitCode: 1,
      command: buildSetupCommandRecord('before_checks', { exitCode: 1, outcome: 'cancelled' }),
    },
    {
      label: 'a command that passes while the run is cancelled',
      exitCode: 0,
      command: buildSetupCommandRecord('before_checks'),
    },
  ])(
    'ends the case as cancelled with its patch and no check started when the run is cancelled during before_checks with $label',
    async ({ exitCode, command }) => {
      const config = buildSingleCaseConfig(declareSetup('before_checks'));
      const harness = createHarness(config);
      harness.evaluatorProcesses.exitCodes.set(SETUP_ARGV.before_checks, exitCode);

      const run = await runCancelledWhileCommandRuns(config, harness, SETUP_ARGV.before_checks);

      expect(finalizedCaseOf(harness)).toEqual(
        buildNotEvaluatedCase(harness, {
          lifecycle: 'cancelled',
          artifacts: buildFirstCaseArtifacts({
            events: EVENTS_PATH,
            sessionExport: SESSION_EXPORT_PATH,
            solutionPatch: PATCH_PATH,
          }),
          setup: buildSetupEvidence({ beforeChecks: SETUP_LOG_PATH.before_checks }, [command]),
        }),
      );
      expect(harness.timeline.filter((entry) => entry.startsWith('check:'))).toEqual([
        `check:${SETUP_ARGV.before_checks}`,
      ]);
      expect(run.exitCode).toBe(130);
    },
  );

  it('records the before_checks evidence and runs the checks after its log is written when before_checks passes', async () => {
    const config = buildSingleCaseConfig(declareSetup('before_checks'));
    const harness = createHarness(config);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentRanCase(harness, {
        setup: buildSetupEvidence({ beforeChecks: SETUP_LOG_PATH.before_checks }, [
          buildSetupCommandRecord('before_checks'),
        ]),
      }),
    );
    expect(
      timelineOf(harness, [
        `writePatch:${FIRST_CASE_ID}`,
        `writeSetupLog:${FIRST_CASE_ID}`,
        'check:/synthetic/acc-required',
      ]),
    ).toEqual([
      `writePatch:${FIRST_CASE_ID}`,
      `writeSetupLog:${FIRST_CASE_ID}`,
      'check:/synthetic/acc-required',
    ]);
    expect(run.exitCode).toBe(0);
  });

  it('records both setup logs and both command lists, before_agent first, on the completed case', async () => {
    const config = buildSingleCaseConfig(declareSetup('before_agent', 'before_checks'));
    const harness = createHarness(config);

    await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentRanCase(harness, {
        setup: buildSetupEvidence(
          {
            beforeAgent: SETUP_LOG_PATH.before_agent,
            beforeChecks: SETUP_LOG_PATH.before_checks,
          },
          [buildSetupCommandRecord('before_agent'), buildSetupCommandRecord('before_checks')],
        ),
      }),
    );
  });

  it('keeps the before_agent evidence and the applied check state on the record when before_checks fails', async () => {
    const checkState = buildCheckStateRecord();
    const config = buildSingleCaseConfig({
      ...declareSetup('before_agent', 'before_checks'),
      tasks: [
        buildBenchmarkTask({ checks: { ...buildBenchmarkTask().checks, restore: ['tests/**'] } }),
      ],
    });
    const harness = createHarness(config);
    harness.git.applyCheckStateResults.set(FIRST_CASE_ID, checkState);
    harness.evaluatorProcesses.exitCodes.set(SETUP_ARGV.before_checks, 9);

    await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'infrastructure-failed',
        failure: recordedFailure({
          kind: 'SetupError',
          phase: 'before_checks',
          argv: [SETUP_ARGV.before_checks],
          reason: 'exited with code 9',
        }),
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          sessionExport: SESSION_EXPORT_PATH,
          solutionPatch: PATCH_PATH,
        }),
        checkState,
        setup: buildSetupEvidence(
          {
            beforeAgent: SETUP_LOG_PATH.before_agent,
            beforeChecks: SETUP_LOG_PATH.before_checks,
          },
          [
            buildSetupCommandRecord('before_agent'),
            buildSetupCommandRecord('before_checks', { exitCode: 9, outcome: 'failed' }),
          ],
        ),
      }),
    );
  });

  it('reports the log write failure rather than the command failure and stops scheduling when a failing before_checks command also loses its log', async () => {
    const config = buildTwoCaseConfig(declareSetup('before_checks'));
    const harness = createHarness(config);
    const logFailure = buildArtifactError('write-setup-log', 'synthetic setup log failure');
    harness.evaluatorProcesses.exitCodes.set(SETUP_ARGV.before_checks, 9);
    harness.artifacts.failOnce.set(`writeSetupLog:${FIRST_CASE_ID}`, logFailure);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'infrastructure-failed',
        failure: recordedFailure(logFailure),
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          sessionExport: SESSION_EXPORT_PATH,
          solutionPatch: PATCH_PATH,
        }),
        setup: buildSetupEvidence({}, [
          buildSetupCommandRecord('before_checks', { exitCode: 9, outcome: 'failed' }),
        ]),
      }),
    );
    expect(run.findings).toEqual([
      { severity: 'error', caseId: SECOND_CASE_ID, message: SCHEDULING_STOPPED_MESSAGE },
    ]);
  });

  it('ends the case as cancelled without a before_checks log when the run is cancelled before its first command starts', async () => {
    const checkState = buildCheckStateRecord();
    const config = buildSingleCaseConfig({
      ...declareSetup('before_agent', 'before_checks'),
      tasks: [
        buildBenchmarkTask({ checks: { ...buildBenchmarkTask().checks, restore: ['tests/**'] } }),
      ],
    });
    const harness = createHarness(config);
    harness.git.applyCheckStateResults.set(FIRST_CASE_ID, checkState);
    harness.abortDuring.add('applyCheckState');

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'cancelled',
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          sessionExport: SESSION_EXPORT_PATH,
          solutionPatch: PATCH_PATH,
        }),
        checkState,
        setup: buildSetupEvidence({ beforeAgent: SETUP_LOG_PATH.before_agent }, [
          buildSetupCommandRecord('before_agent'),
        ]),
      }),
    );
    expect(timelineOf(harness, [`writeSetupLog:${FIRST_CASE_ID}`])).toEqual([
      `writeSetupLog:${FIRST_CASE_ID}`,
    ]);
    expect(harness.evaluatorProcesses.requests.map((request) => request.argv[0])).toEqual([
      SETUP_ARGV.before_agent,
    ]);
    expect(run.exitCode).toBe(130);
  });

  it('records one failed check for the check an evaluation error names', async () => {
    const config = buildSingleCaseConfig();
    const harness = createHarness(config);
    vi.mocked(evaluateChecks).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: 'EvaluationError',
        caseId: FIRST_CASE_ID,
        checkId: 'dod-required',
        reason: 'synthetic evaluation failure',
      },
    });

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentRanCase(harness, {
        outcome: 'failed',
        checks: [
          {
            checkId: 'dod-required',
            category: 'definition-of-done',
            verdict: 'failed',
            evidence: 'check evaluation failed: synthetic evaluation failure',
            durationMs: null,
          },
        ],
      }),
    );
    expect(run.exitCode).toBe(2);
  });

  it('keeps the evaluated checks on the record, without a checks artifact, and stops scheduling when checks.json cannot be written', async () => {
    const config = buildTwoCaseConfig();
    const harness = createHarness(config);
    const writeFailure = buildArtifactError('write-checks', 'synthetic checks write failure');
    harness.artifacts.failOnce.set(`writeChecks:${FIRST_CASE_ID}`, writeFailure);

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentRanCase(harness, {
        lifecycle: 'infrastructure-failed',
        outcome: 'not-evaluated',
        failure: recordedFailure(writeFailure),
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          sessionExport: SESSION_EXPORT_PATH,
          solutionPatch: PATCH_PATH,
        }),
      }),
    );
    expect(run.findings).toEqual([
      { severity: 'error', caseId: SECOND_CASE_ID, message: SCHEDULING_STOPPED_MESSAGE },
    ]);
    expect(run.exitCode).toBe(1);
  });
});

describe('case lifecycle: grading', () => {
  it('completes without calling the grader when the task declares no graded check', async () => {
    const config = buildSingleCaseConfig();
    const harness = createHarness(config);

    await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(buildAgentRanCase(harness));
    expect(vi.mocked(gradeCase)).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'a graded outcome',
      outcome: buildGradedOutcome(['/synthetic/grading/call-1', '/synthetic/grading/call-2']),
      writesGrading: true,
    },
    {
      label: 'a cancelled outcome',
      outcome: {
        status: 'cancelled',
        retainedDirectories: ['/synthetic/grading/call-1', '/synthetic/grading/call-2'],
      } satisfies GradeCaseOutcome,
      writesGrading: false,
    },
  ])(
    'reports every retained grading directory in order before it acts on $label',
    async ({ outcome, writesGrading }) => {
      const config = buildGradedConfig(buildSingleCaseConfig);
      const harness = createHarness(config);
      vi.mocked(gradeCase).mockResolvedValueOnce(outcome);

      const run = await runConfigured(config, harness);

      const retention = (directory: string): string =>
        `tevu could not delete the temporary directory of this attempt's grading call. The results are not affected. Delete \`${directory}\` when no tevu command uses it.`;
      expect(run.findings).toEqual([
        {
          severity: 'warning',
          caseId: FIRST_CASE_ID,
          message: retention('/synthetic/grading/call-1'),
        },
        {
          severity: 'warning',
          caseId: FIRST_CASE_ID,
          message: retention('/synthetic/grading/call-2'),
        },
      ]);
      expect(timelineAfter(harness, `writeChecks:${FIRST_CASE_ID}`)).toEqual([
        'retainedGradingDirectory:/synthetic/grading/call-1',
        'retainedGradingDirectory:/synthetic/grading/call-2',
        ...(writesGrading ? [`writeGrading:${FIRST_CASE_ID}`] : []),
        `finalizeCase:${FIRST_CASE_ID}`,
        `dispose:${FIRST_CASE_ID}`,
        `finalizeRun:${RUN_ID}`,
      ]);
    },
  );

  it('ends the case as cancelled without writing a grading when the grader outcome is cancelled', async () => {
    const config = buildGradedConfig(buildSingleCaseConfig);
    const harness = createHarness(config);
    vi.mocked(gradeCase).mockImplementationOnce(async (): Promise<GradeCaseOutcome> => {
      harness.cancellation.abort();
      return { status: 'cancelled', retainedDirectories: [] };
    });

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'cancelled',
        checks: [buildPassedCheck('acc-required', 'acceptance'), buildAwaitingGraderCheck()],
      }),
    );
    expect(harness.timeline.some((entry) => entry.startsWith('writeGrading:'))).toBe(false);
    expect(run.exitCode).toBe(130);
  });

  it('ends the case as infrastructure-failed without the grades and stops scheduling when grading.json cannot be written', async () => {
    const config = buildGradedConfig(buildTwoCaseConfig);
    const harness = createHarness(config);
    const writeFailure = buildArtifactError('write-grading', 'synthetic grading write failure');
    harness.artifacts.failOnce.set(`writeGrading:${FIRST_CASE_ID}`, writeFailure);
    vi.mocked(gradeCase).mockResolvedValueOnce(buildGradedOutcome());

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'infrastructure-failed',
        failure: recordedFailure(writeFailure),
        checks: [buildPassedCheck('acc-required', 'acceptance'), buildAwaitingGraderCheck()],
      }),
    );
    expect(run.findings).toEqual([
      { severity: 'error', caseId: SECOND_CASE_ID, message: SCHEDULING_STOPPED_MESSAGE },
    ]);
    expect(run.exitCode).toBe(1);
  });

  it('ends the case as cancelled with its grading when the run is cancelled while grading.json is written', async () => {
    const config = buildGradedConfig(buildSingleCaseConfig);
    const harness = createHarness(config);
    harness.abortDuring.add('writeGrading');
    vi.mocked(gradeCase).mockResolvedValueOnce(buildGradedOutcome());

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildNotEvaluatedCase(harness, {
        lifecycle: 'cancelled',
        checks: [buildPassedCheck('acc-required', 'acceptance'), buildGradedCheck()],
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          sessionExport: SESSION_EXPORT_PATH,
          solutionPatch: PATCH_PATH,
          checks: CHECKS_PATH,
          grading: GRADING_PATH,
        }),
      }),
    );
    expect(run.exitCode).toBe(130);
  });

  it('completes the case with the written grading applied to its checks, grading the captured patch', async () => {
    const config = buildGradedConfig(buildSingleCaseConfig);
    const harness = createHarness(config);
    vi.mocked(gradeCase).mockResolvedValueOnce(buildGradedOutcome());

    const run = await runConfigured(config, harness);

    expect(finalizedCaseOf(harness)).toEqual(
      buildAgentRanCase(harness, {
        checks: [buildPassedCheck('acc-required', 'acceptance'), buildGradedCheck()],
        artifacts: buildFirstCaseArtifacts({
          events: EVENTS_PATH,
          sessionExport: SESSION_EXPORT_PATH,
          solutionPatch: PATCH_PATH,
          checks: CHECKS_PATH,
          grading: GRADING_PATH,
        }),
      }),
    );
    expect(vi.mocked(gradeCase).mock.calls[0]?.[0].patch).toBe(`synthetic patch ${FIRST_CASE_ID}`);
    expect(run.exitCode).toBe(0);
  });
});
