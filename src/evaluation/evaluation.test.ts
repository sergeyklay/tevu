// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createArtifactStore, createConfigStore } from '@/adapters/artifact-store';
import {
  createEnvironmentAdapter,
  createEvaluatorProcessAdapter,
  createRedactor,
} from '@/adapters/process';
import { assessCase, readAssessmentContext, rebuildReport } from '@/application/assess';
import { buildEnvironmentVariableNames } from '@/application/environment-variable-names';
import { renderConfigDocument } from '@/config/document';
import { loadConfig } from '@/config/load';
import { decodeRunConfig } from '@/config/run-snapshot';
import { TevuConfigSchema } from '@/config/schema';
import {
  unavailableAgentMetrics,
  unavailableBenchmarkMetrics,
  unavailableMetric,
} from '@/domain/types';

import { buildGraderCall } from './__fixtures__/report.fixtures';
import {
  buildCheckEnvironment,
  evaluateChecks,
  orderTaskChecks,
  reduceRequiredOutcome,
} from './checks';
import { sumGraderCallMetrics } from './grading';
import { combineCaseMetrics } from './metrics';
import { buildNormalizedRun, buildReport, serializeNormalizedRun } from './report';

import type { CheckEvaluationInput, OrderedCheck } from './checks';
import type { ReportInput } from './report';
import type { CheckInput, ModelDefinitionInput, TaskInput, TevuConfigInput } from '@/config/schema';
import type {
  AgentAdapter,
  AgentCapabilityReport,
  AgentEventRecord,
  AgentMetrics,
  AgentRegistry,
  AgentSessionExport,
  ArtifactStore,
  AssessmentArtifact,
  AssessmentDecision,
  BenchmarkMetrics,
  CaseIdentity,
  CaseResult,
  CheckRecord,
  CheckResult,
  CommandCheck,
  EvaluatorProcessAdapter,
  EvaluatorProcessRequest,
  EvaluatorProcessResult,
  FailureRecord,
  GraderIdentity,
  GradingArtifact,
  MetricValue,
  ModelRecord,
  ProcessResult,
  RepositoryDefinition,
  RunFinding,
  RunManifest,
  RunResult,
  TaskRecord,
  TevuConfig,
  TevuResult,
} from '@/domain/types';

const PROVIDER_SECRET = 'synthetic-provider-secret-9f2';
const PROVIDER_ENV_NAME = 'TEVU_PROVIDER_KEY';
const ORDINARY_ENV_NAME = 'TEVU_EVAL_ORDINARY';
const ORDINARY_VALUE = 'ordinary-evaluator-value';
const OTHER_ORDINARY_NAME = 'TEVU_EVAL_OTHER';
const PARENT_SENTINEL = 'parent-only-value';
const TASK_PROMPT_BODY = 'TEVU-PROMPT-BODY implement the welcome route';
const JIRA_SUMMARY = 'TEVU-JIRA-SUMMARY imported issue title';
const JIRA_DESCRIPTION = 'TEVU-JIRA-DESCRIPTION full imported body';
const TRANSCRIPT_BODY = 'TEVU-TRANSCRIPT-BODY model output text';
const PATCH_BODY = 'TEVU-PATCH-BODY diff --git a/src/welcome.ts b/src/welcome.ts';

const AGENT_NAME = 'fake-agent';

/** Neutral event record the fake agent emits; carries no opencode protocol shape. */
type FakeEventRecord = { kind: 'tool' } | { kind: 'error'; message: string };

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

/** Sums fixed values matching a fully available root-session export; verified verbatim by the tests below. */
function buildFullMetrics(): AgentMetrics {
  return buildAgentMetrics();
}

/** Counts the neutral event records the fake agent's own run emitted; mirrors a real adapter's event fallback. */
function buildEventFallbackMetrics(reason: string, events: readonly unknown[]): AgentMetrics {
  const unavailable = (unit: 'count' | 'token' | 'USD'): AgentMetrics['cost'] => ({
    value: null,
    unit,
    availability: { status: 'unavailable', reason },
    scope: 'root-session',
  });
  const measured = (value: number, unit: 'count' | 'token' | 'USD'): AgentMetrics['cost'] => ({
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

/**
 * A registry holding a fake agent under "fake-agent", so `rebuildReport`/
 * `assessCase` can resolve the synthetic run's saved agent name. Only
 * `normalizeMetrics` and `probe` are ever invoked by report regeneration; the
 * other methods are never called.
 */
const AGENTS_REGISTRY: AgentRegistry = new Map<string, AgentAdapter>([
  [
    AGENT_NAME,
    {
      probe: () => Promise.resolve({ ok: true, value: buildCapabilityReport() }),
      readProviders: () =>
        Promise.resolve({
          ok: true,
          value: { agent: AGENT_NAME, configurationFiles: [], findings: [], copiedProviders: [] },
        }),
      inspectOperatorProvider: () => Promise.resolve({ ok: true, value: { defined: false } }),
      listModels: () => Promise.resolve({ outcome: 'listed', models: [], variants: new Map() }),
      repositoryConfigurationEntries: () => [],
      run: () => Promise.reject(new Error('unused in report regeneration')),
      exportSession: () => Promise.reject(new Error('unused in report regeneration')),
      normalizeMetrics(input) {
        if (input.sessionExport !== null) {
          return { ok: true, value: buildFullMetrics() };
        }
        const reason = input.exportUnavailableReason ?? 'root session export unavailable';
        return { ok: true, value: buildEventFallbackMetrics(reason, input.events) };
      },
      callModel: () => Promise.reject(new Error('unused in report regeneration')),
    },
  ],
]);

function requireFakeAdapter(): AgentAdapter {
  const adapter = AGENTS_REGISTRY.get(AGENT_NAME);
  if (adapter === undefined) {
    throw new Error(`expected AGENTS_REGISTRY to register "${AGENT_NAME}"`);
  }
  return adapter;
}

function buildCheckDefinition(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    id: 'acc-acceptance-command',
    description: 'acceptance command exits zero',
    run: ['/synthetic/acceptance-probe', '--suite', 'synthetic'],
    timeout: '5s',
    exit_codes: [0],
    env: [ORDINARY_ENV_NAME],
    ...overrides,
  };
}

function buildTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    title: 'Synthetic welcome-route task',
    repo: 'repo-1',
    base_commit: '0123456789abcdef0123456789abcdef01234567',
    description: 'synthetic task description for the welcome route',
    prompt: TASK_PROMPT_BODY,
    readiness: ['synthetic ready item'],
    checks: {
      acceptance: [buildCheckDefinition()],
      done: [
        { id: 'dod-manual-review', description: 'manual Definition of Done review', manual: true },
        {
          id: 'man-optional-polish',
          description: 'optional manual polish review',
          manual: true,
          required: false,
        },
      ],
    },
    ...overrides,
  };
}

function buildJiraTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return buildTask({
    id: 'task-2',
    title: 'Synthetic imported task',
    source: {
      kind: 'jira',
      key: 'TEVU-999',
      url: 'https://jira.example.com/browse/TEVU-999',
      imported_at: '2026-09-22T12:00:00.000Z',
      title: JIRA_SUMMARY,
      body: JIRA_DESCRIPTION,
    },
    ...overrides,
  });
}

function buildModel(overrides: Partial<ModelDefinitionInput> = {}): ModelDefinitionInput {
  return { id: 'alpha', model: 'vendor/model-alpha-synth', effort: 'effort-high', ...overrides };
}

function buildRepository(overrides: Partial<RepositoryDefinition> = {}): RepositoryDefinition {
  return { id: 'repo-1', path: '/tevu-synthetic/repo-1', ...overrides };
}

function buildSyntheticConfig(outputDirectory = '/tevu-synthetic/artifacts'): TevuConfig {
  const config: TevuConfigInput = {
    version: 1,
    run: { output_dir: outputDirectory, concurrency: 2, timeout: '60s', stop_grace: '1s' },
    agents: { opencode: { command: '/synthetic/opencode', secrets: [PROVIDER_ENV_NAME], env: [] } },
    repositories: [buildRepository()],
    models: [
      buildModel(),
      buildModel({ id: 'beta', effort: 'effort-low' }),
      buildModel({ id: 'gamma', model: 'vendor/model-gamma-synth' }),
    ],
    tasks: [
      buildTask(),
      buildJiraTask({ base_commit: 'fedcba9876543210fedcba9876543210fedcba98' }),
    ],
  };
  return TevuConfigSchema.parse(config);
}

function buildCaseIdentity(overrides: Partial<CaseIdentity> = {}): CaseIdentity {
  return {
    caseId: 'task-1--alpha--1',
    taskId: 'task-1',
    modelId: 'alpha',
    attempt: 1,
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    model: 'vendor/model-alpha-synth',
    effort: 'effort-high',
    agent: AGENT_NAME,
    timeoutMs: 60_000,
    ...overrides,
  };
}

function buildCheckRecord(overrides: Partial<CheckRecord> & Pick<CheckRecord, 'id'>): CheckRecord {
  return {
    category: 'acceptance',
    description: `synthetic check ${overrides.id}`,
    required: true,
    evaluator: 'command',
    ...overrides,
  };
}

/** A `TaskRecord`-shaped fixture, matching what `decodeRunConfig` projects from a stored run. */
function buildTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: 'Synthetic welcome-route task',
    repositoryId: 'repo-1',
    startCommit: '0123456789abcdef0123456789abcdef01234567',
    description: 'synthetic task description for the welcome route',
    source: { kind: 'manual' },
    checks: [
      buildCheckRecord({
        id: 'acc-acceptance-command',
        description: 'acceptance command exits zero',
      }),
      buildCheckRecord({
        id: 'dod-manual-review',
        category: 'definition-of-done',
        description: 'manual Definition of Done review',
        evaluator: 'manual',
      }),
      buildCheckRecord({
        id: 'man-optional-polish',
        category: 'definition-of-done',
        description: 'optional manual polish review',
        required: false,
        evaluator: 'manual',
      }),
    ],
    ...overrides,
  };
}

function buildProcessResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    startedAt: '2026-09-23T00:00:00.000Z',
    endedAt: '2026-09-23T00:00:01.500Z',
    durationMs: 1500,
    terminationStage: 'none',
    ...overrides,
  };
}

function buildCheckResult(
  overrides: Partial<CheckResult> & Pick<CheckResult, 'checkId'>,
): CheckResult {
  return {
    category: 'acceptance',
    verdict: 'passed',
    evidence: 'exit code 0',
    durationMs: 12,
    ...overrides,
  };
}

function buildArtifactIndex(caseId: string, present: ReadonlySet<string>): CaseResult['artifacts'] {
  const paths: Record<string, string> = {
    events: `cases/${caseId}/events.jsonl`,
    diagnostics: `cases/${caseId}/stderr.log`,
    sessionExport: `cases/${caseId}/session.json`,
    solutionPatch: `cases/${caseId}/solution.patch`,
    checks: `cases/${caseId}/checks.json`,
    assessment: `cases/${caseId}/assessment.json`,
    grading: `cases/${caseId}/grading.json`,
    result: `cases/${caseId}/result.json`,
  };
  return {
    events: present.has('events') ? paths.events : null,
    diagnostics: present.has('diagnostics') ? paths.diagnostics : null,
    sessionExport: present.has('sessionExport') ? paths.sessionExport : null,
    solutionPatch: present.has('solutionPatch') ? paths.solutionPatch : null,
    checks: present.has('checks') ? paths.checks : null,
    assessment: present.has('assessment') ? paths.assessment : null,
    grading: present.has('grading') ? paths.grading : null,
    result: paths.result,
  };
}

function buildCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    schemaVersion: 1,
    identity: buildCaseIdentity(),
    lifecycle: 'completed',
    process: buildProcessResult(),
    outcome: 'passed',
    checks: [],
    metrics: unavailableBenchmarkMetrics('not yet normalized'),
    artifacts: buildArtifactIndex('task-1--alpha--1', new Set(['result'])),
    failure: null,
    ...overrides,
  };
}

function buildAssessmentArtifact(overrides: Partial<AssessmentArtifact> = {}): AssessmentArtifact {
  return {
    schemaVersion: 1,
    runId: '20260923t000000z-synthetic',
    caseId: 'task-1--alpha--1',
    revision: 2,
    current: [
      {
        checkId: 'dod-manual-review',
        verdict: 'passed',
        assessor: 'curator',
        note: 'confirmed by reviewer',
        assessedAt: '2026-09-23T01:00:00.000Z',
      },
    ],
    history: [
      {
        source: 'operator',
        checkId: 'dod-manual-review',
        verdict: 'failed',
        assessor: 'curator',
        note: 'needs rework',
        assessedAt: '2026-09-23T00:30:00.000Z',
        replacedAt: '2026-09-23T01:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function buildCapabilityReport(
  overrides: Partial<AgentCapabilityReport> = {},
): AgentCapabilityReport {
  return {
    executable: `/synthetic/${AGENT_NAME}`,
    detectedVersion: '9.9.9-synthetic',
    capabilities: [{ name: 'run command', required: true, availability: 'available' }],
    isolation: { denyOutsideWorktree: 'unavailable' },
    ...overrides,
  };
}

function buildEfforts(
  modelIds: readonly string[] = ['alpha'],
  grader: RunManifest['efforts']['grader'] = null,
): RunManifest['efforts'] {
  return {
    models: Object.fromEntries(modelIds.map((id) => [id, { status: 'verified' as const }])),
    grader,
  };
}

function buildManifest(
  runId: string,
  config: TevuConfig,
  capabilities: AgentCapabilityReport,
  caseIds: readonly string[],
): RunManifest {
  return {
    schemaVersion: 1,
    runId,
    configDigest: 'sha256-synthetic-digest',
    configPath: '/synthetic/tevu.yaml',
    startedAt: '2026-09-23T00:00:00.000Z',
    completedAt: null,
    host: { platform: 'linux', nodeVersion: 'v24.21.0' },
    tools: {
      gitVersion: 'git version 2.45.0',
      agentVersions: { [AGENT_NAME]: capabilities.detectedVersion },
      agentConfigurationFiles: {},
      copiedProviders: { [AGENT_NAME]: [] },
    },
    execution: {
      concurrency: config.run.concurrency,
      caseTimeoutMs: 60_000,
      repeat: { value: config.run.repeat, source: 'config' },
    },
    efforts: buildEfforts(
      config.models.map((entry) => entry.id),
      config.roles?.grader === undefined ? null : { status: 'verified' },
    ),
    cases: caseIds.map((caseId) => {
      const [taskId, modelId, attempt] = caseId.split('--') as [string, string, string];
      const model = config.models.find((entry) => entry.id === modelId);
      const task = config.tasks.find((entry) => entry.id === taskId);
      return buildCaseIdentity({
        caseId,
        taskId,
        modelId,
        attempt: Number(attempt),
        sourceCommit: task?.base_commit ?? '0123456789abcdef0123456789abcdef01234567',
        model: model?.model ?? 'vendor/model-alpha-synth',
        effort: model?.effort ?? 'effort-high',
      });
    }),
    context: { config, capabilities: { [AGENT_NAME]: capabilities } },
  };
}

type SyntheticRecords = {
  runId: string;
  config: TevuConfig;
  capabilities: AgentCapabilityReport;
  manifest: RunManifest;
  caseResults: CaseResult[];
  assessment: AssessmentArtifact;
  findings: RunFinding[];
  exportRecord: AgentSessionExport;
  events: AgentEventRecord[];
};

function buildSyntheticRecords(): SyntheticRecords {
  const config = rekeyToFakeAgent(buildSyntheticConfig());
  const capabilities = buildCapabilityReport();
  const runId = '20260923t000000z-synthetic';
  const manifest = buildManifest(runId, config, capabilities, [
    'task-1--alpha--1',
    'task-1--beta--1',
    'task-2--gamma--1',
  ]);

  // Neutral record: no opencode event or export shape. The
  // `additiveTopLevelField` key lets the fail-closed redaction test below
  // trigger its synthetic failure on this record's serialized text.
  const exportRecord: AgentSessionExport = {
    rootSessionId: 'ses-root-0001',
    transcript: TRANSCRIPT_BODY,
    additiveTopLevelField: 'synthetic-forward-compat',
  };

  const neutralEvents: FakeEventRecord[] = Array.from(
    { length: 8 },
    () => ({ kind: 'tool' }) as FakeEventRecord,
  );
  const secretError: FakeEventRecord = { kind: 'error', message: `leak ${PROVIDER_SECRET} marker` };
  const events: AgentEventRecord[] = [...neutralEvents, secretError];

  const alphaNormalized = requireFakeAdapter().normalizeMetrics({
    caseId: 'task-1--alpha--1',
    sessionId: null,
    sessionExport: exportRecord,
    events,
    copiedProviders: [],
  });
  if (!alphaNormalized.ok) {
    throw new Error(`fixture metrics must normalize: ${alphaNormalized.error.reason}`);
  }
  const alphaMetrics = combineCaseMetrics({
    durationMs: 1500,
    elapsedUnavailableReason: 'unused',
    normalized: alphaNormalized,
  });

  const alpha = buildCaseResult({
    identity: buildCaseIdentity({ caseId: 'task-1--alpha--1' }),
    lifecycle: 'completed',
    outcome: 'pending',
    checks: [
      buildCheckResult({ checkId: 'acc-acceptance-command' }),
      buildCheckResult({
        checkId: 'dod-manual-review',
        category: 'definition-of-done',
        verdict: 'pending',
        evidence: 'awaiting manual assessment',
        durationMs: null,
      }),
      buildCheckResult({
        checkId: 'man-optional-polish',
        category: 'definition-of-done',
        verdict: 'pending',
        evidence: 'awaiting manual assessment',
        durationMs: null,
      }),
    ],
    metrics: alphaMetrics.metrics,
    artifacts: buildArtifactIndex(
      'task-1--alpha--1',
      new Set(['events', 'diagnostics', 'sessionExport', 'solutionPatch', 'checks', 'result']),
    ),
  });

  const beta = buildCaseResult({
    identity: buildCaseIdentity({
      caseId: 'task-1--beta--1',
      modelId: 'beta',
      effort: 'effort-low',
    }),
    lifecycle: 'completed',
    outcome: 'failed',
    process: buildProcessResult({
      exitCode: 1,
      endedAt: '2026-09-23T00:00:00.900Z',
      durationMs: 900,
    }),
    checks: [
      buildCheckResult({
        checkId: 'acc-acceptance-command',
        verdict: 'failed',
        evidence: 'exit code 1 (not a declared success exit code)',
      }),
    ],
    metrics: unavailableBenchmarkMetrics('root session export unavailable'),
    artifacts: buildArtifactIndex(
      'task-1--beta--1',
      new Set(['events', 'diagnostics', 'checks', 'result']),
    ),
    failure: {
      error: {
        kind: 'AgentProcessError',
        agent: AGENT_NAME,
        caseId: 'task-1--beta--1',
        exitCode: 1,
        signal: null,
      },
      occurredAt: '2026-09-23T00:00:00.950Z',
    },
  });

  const gamma = buildCaseResult({
    identity: buildCaseIdentity({
      caseId: 'task-2--gamma--1',
      taskId: 'task-2',
      modelId: 'gamma',
      model: 'vendor/model-gamma-synth',
      sourceCommit: 'fedcba9876543210fedcba9876543210fedcba98',
    }),
    lifecycle: 'timed-out',
    process: buildProcessResult({
      exitCode: null,
      signal: 'SIGKILL',
      endedAt: '2026-09-23T00:00:42.000Z',
      durationMs: 42000,
      terminationStage: 'forced',
    }),
    outcome: 'not-evaluated',
    checks: [],
    metrics: unavailableBenchmarkMetrics('case timed out; checks were not run'),
    artifacts: buildArtifactIndex('task-2--gamma--1', new Set([])),
    failure: {
      error: { kind: 'CaseTimeoutError', caseId: 'task-2--gamma--1', timeoutMs: 60000 },
      occurredAt: '2026-09-23T00:00:42.100Z',
    },
  });

  return {
    runId,
    config,
    capabilities,
    manifest,
    caseResults: [alpha, beta, gamma],
    assessment: buildAssessmentArtifact({ runId }),
    findings: [
      { severity: 'warning', caseId: null, message: 'cleanup warning: retained synthetic path' },
    ],
    exportRecord,
    events,
  };
}

function succeeded(
  exitCode: number,
  overrides: Partial<Extract<EvaluatorProcessResult, { launched: true }>> = {},
): EvaluatorProcessResult {
  return {
    launched: true,
    exitCode,
    signal: null,
    durationMs: 12,
    timedOut: false,
    terminationStage: 'none',
    stdout: { text: '', totalBytes: 0, truncated: false, incomplete: false },
    stderr: { text: '', totalBytes: 0, truncated: false, incomplete: false },
    ...overrides,
  };
}

function fakeEvaluatorProcess(
  respond: (
    request: EvaluatorProcessRequest,
    call: number,
  ) => Promise<EvaluatorProcessResult> | EvaluatorProcessResult,
): { adapter: EvaluatorProcessAdapter; requests: EvaluatorProcessRequest[]; log: string[] } {
  const requests: EvaluatorProcessRequest[] = [];
  const log: string[] = [];
  let call = 0;
  return {
    requests,
    log,
    adapter: {
      async run(request) {
        const index = call;
        call += 1;
        requests.push(request);
        log.push(`start-${index}`);
        const outcome = await respond(request, index);
        log.push(`end-${index}`);
        return outcome;
      },
    },
  };
}

function buildEvaluationInput(overrides: Partial<CheckEvaluationInput> = {}): CheckEvaluationInput {
  return {
    caseId: 'task-1--alpha--1',
    checks: [],
    workspace: {
      caseId: 'task-1--alpha--1',
      sourceRepositoryPath: '/tevu-synthetic/repo-1',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      repositoryDirectory: '/tevu-synthetic/case/repo',
      worktreeDirectory: '/tevu-synthetic/case/worktree',
      runtimeDirectory: '/tevu-synthetic/case/runtime',
      branch: 'tevu/task-1--alpha--1',
      syntheticCommit: '0synthetic0000000000000000000000000000000c',
    },
    environment: {
      caseId: 'task-1--alpha--1',
      recipient: 'evaluator',
      homeDirectory: '/tevu-synthetic/case/runtime/evaluator/home',
      temporaryDirectory: '/tevu-synthetic/case/runtime/evaluator/tmp',
      variables: {
        PATH: '/synthetic/evaluator-path',
        HOME: '/tevu-synthetic/case/runtime/evaluator/home',
        XDG_CONFIG_HOME: '/tevu-synthetic/case/runtime/evaluator/home/.config',
        XDG_DATA_HOME: '/tevu-synthetic/case/runtime/evaluator/home/.local/share',
        XDG_CACHE_HOME: '/tevu-synthetic/case/runtime/evaluator/home/.cache',
        XDG_STATE_HOME: '/tevu-synthetic/case/runtime/evaluator/home/.local/state',
        TMPDIR: '/tevu-synthetic/case/runtime/evaluator/tmp',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        CI: '1',
      },
      variableManifest: [],
    },
    snapshot: {
      path: '/synthetic/parent-path',
      agentValues: { [PROVIDER_ENV_NAME]: PROVIDER_SECRET },
      ordinaryEvaluatorValues: {
        [ORDINARY_ENV_NAME]: ORDINARY_VALUE,
        [OTHER_ORDINARY_NAME]: 'other-ordinary-value',
      },
      secretValues: [PROVIDER_SECRET],
    },
    terminationGraceMs: 250,
    processes: { run: async () => succeeded(0) },
    redact: (text) => text,
    ...overrides,
  };
}

function commandCheck(id: string, overrides: Partial<CommandCheck> = {}): OrderedCheck {
  return {
    definition: {
      id,
      description: `synthetic check ${id}`,
      run: ['/synthetic/acceptance-probe', '--suite', 'synthetic'],
      timeout: '5s',
      exit_codes: [0],
      env: [],
      required: true,
      ...overrides,
    },
    category: 'acceptance',
  };
}

function manualCheck(id: string, required: boolean): OrderedCheck {
  return {
    definition: { id, description: `synthetic manual check ${id}`, manual: true, required },
    category: 'definition-of-done',
  };
}

function caseFile(root: string, runId: string, caseId: string, file: string): string {
  return join(root, 'artifacts', runId, 'cases', caseId, file);
}

async function digestFile(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function collectSourceDigests(root: string, runId: string): Promise<string[]> {
  const alpha = [
    'events.jsonl',
    'session.json',
    'solution.patch',
    'checks.json',
    'assessment.json',
  ];
  const beta = ['events.jsonl', 'checks.json'];
  const digests: string[] = [];
  for (const file of alpha) {
    digests.push(await digestFile(caseFile(root, runId, 'task-1--alpha--1', file)));
  }
  for (const file of beta) {
    digests.push(await digestFile(caseFile(root, runId, 'task-1--beta--1', file)));
  }
  return digests;
}

async function appendOrThrow(
  store: ReturnType<typeof createArtifactStore>,
  caseId: string,
  event: AgentEventRecord,
): Promise<void> {
  const appended = await store.appendEvent(caseId, event);
  if (!appended.ok) {
    throw new Error(`appendEvent failed: ${JSON.stringify(appended.error)}`);
  }
}

async function writeChecksOrThrow(
  store: ReturnType<typeof createArtifactStore>,
  caseId: string,
  checks: CheckResult[],
): Promise<void> {
  const written = await store.writeChecks(caseId, checks);
  if (!written.ok) {
    throw new Error(`writeChecks failed: ${JSON.stringify(written.error)}`);
  }
}

async function createSyntheticRun(root: string): Promise<{
  runId: string;
  store: ReturnType<typeof createArtifactStore>;
  records: SyntheticRecords;
}> {
  const records = buildSyntheticRecords();
  const store = createArtifactStore({
    artifactsDirectory: join(root, 'artifacts'),
    redact: createRedactor([PROVIDER_SECRET]),
  });

  const started = await store.startRun(records.manifest);
  if (!started.ok) {
    throw new Error(`startRun failed: ${JSON.stringify(started.error)}`);
  }

  for (const event of records.events) {
    await appendOrThrow(store, 'task-1--alpha--1', event);
  }
  const diagnostic = await store.appendDiagnostic(
    'task-1--alpha--1',
    `synthetic diagnostic ${PROVIDER_SECRET}`,
  );
  if (!diagnostic.ok) {
    throw new Error(`appendDiagnostic failed: ${JSON.stringify(diagnostic.error)}`);
  }
  const exportWrite = await store.writeSessionExport('task-1--alpha--1', records.exportRecord);
  if (!exportWrite.ok) {
    throw new Error(`writeSessionExport failed: ${JSON.stringify(exportWrite.error)}`);
  }
  const patchWrite = await store.writePatch('task-1--alpha--1', {
    caseId: 'task-1--alpha--1',
    content: `${PATCH_BODY}\n`,
    isEmpty: false,
  });
  if (!patchWrite.ok) {
    throw new Error(`writePatch failed: ${JSON.stringify(patchWrite.error)}`);
  }
  await writeChecksOrThrow(store, 'task-1--alpha--1', records.caseResults[0].checks);

  const betaError: FakeEventRecord = { kind: 'error', message: 'synthetic provider outage' };
  const betaToolUse: FakeEventRecord = { kind: 'tool' };
  await appendOrThrow(store, 'task-1--beta--1', betaError);
  await appendOrThrow(store, 'task-1--beta--1', betaToolUse);
  const betaDiagnostic = await store.appendDiagnostic(
    'task-1--beta--1',
    'synthetic beta diagnostic',
  );
  if (!betaDiagnostic.ok) {
    throw new Error(`appendDiagnostic failed: ${JSON.stringify(betaDiagnostic.error)}`);
  }
  await writeChecksOrThrow(store, 'task-1--beta--1', records.caseResults[1].checks);

  for (const result of records.caseResults) {
    const finalized = await store.finalizeCase(result);
    if (!finalized.ok) {
      throw new Error(`finalizeCase failed: ${JSON.stringify(finalized.error)}`);
    }
  }

  const run: RunResult = {
    schemaVersion: 1,
    manifest: records.manifest,
    cases: records.caseResults,
    findings: records.findings,
    exitCode: 2,
  };
  const runFinalized = await store.finalizeRun(run);
  if (!runFinalized.ok) {
    throw new Error(`finalizeRun failed: ${JSON.stringify(runFinalized.error)}`);
  }

  const assessment = await store.replaceAssessment(records.assessment);
  if (!assessment.ok) {
    throw new Error(`replaceAssessment failed: ${JSON.stringify(assessment.error)}`);
  }

  return { runId: records.runId, store, records };
}

beforeAll(() => {
  process.env[PROVIDER_ENV_NAME] = PROVIDER_SECRET;
  process.env[ORDINARY_ENV_NAME] = ORDINARY_VALUE;
  process.env['TEVU_PARENT_SENTINEL'] = PARENT_SENTINEL;
});

afterAll(() => {
  delete process.env[PROVIDER_ENV_NAME];
  delete process.env[ORDINARY_ENV_NAME];
  delete process.env['TEVU_PARENT_SENTINEL'];
});

describe('orderTaskChecks', () => {
  it('orders acceptance criteria before Definition of Done with categories attached', () => {
    const task = buildSyntheticConfig().tasks.find((entry) => entry.id === 'task-1');
    if (task === undefined) throw new Error('synthetic config must define task-1');
    const ordered = orderTaskChecks(task);

    expect(ordered.map((check) => check.definition.id)).toEqual([
      'acc-acceptance-command',
      'dod-manual-review',
      'man-optional-polish',
    ]);
    expect(ordered.map((check) => check.category)).toEqual([
      'acceptance',
      'definition-of-done',
      'definition-of-done',
    ]);
  });
});

describe('buildCheckEnvironment', () => {
  it('adds only allowlisted ordinary snapshot values to the fixed evaluator base', () => {
    const input = buildEvaluationInput();

    const variables = buildCheckEnvironment(input.environment, input.snapshot, [
      ORDINARY_ENV_NAME,
      OTHER_ORDINARY_NAME,
    ]);

    expect(Object.keys(variables)).toHaveLength(12);
    expect(variables[ORDINARY_ENV_NAME]).toBe(ORDINARY_VALUE);
    expect(variables[OTHER_ORDINARY_NAME]).toBe('other-ordinary-value');
    expect(variables['CI']).toBe('1');
    expect(variables['LANG']).toBe('C.UTF-8');
  });

  it('never lets an allowlisted name replace a fixed base variable', () => {
    const input = buildEvaluationInput();

    const variables = buildCheckEnvironment(input.environment, input.snapshot, [
      'PATH',
      'HOME',
      'XDG_CONFIG_HOME',
    ]);

    expect(variables['PATH']).toBe('/synthetic/evaluator-path');
    expect(variables['HOME']).toBe(input.environment.homeDirectory);
    expect(variables['XDG_CONFIG_HOME']).toBe(input.environment.variables['XDG_CONFIG_HOME']);
  });

  it('omits allowlisted names that carry no snapshot value', () => {
    const input = buildEvaluationInput();

    const variables = buildCheckEnvironment(input.environment, input.snapshot, [
      'TEVU_EVAL_UNKNOWN',
    ]);

    expect(variables['TEVU_EVAL_UNKNOWN']).toBeUndefined();
    expect(Object.keys(variables)).toHaveLength(10);
  });

  it('never admits provider credentials through the allowlist', () => {
    const input = buildEvaluationInput();

    const variables = buildCheckEnvironment(input.environment, input.snapshot, [PROVIDER_ENV_NAME]);

    expect(variables[PROVIDER_ENV_NAME]).toBeUndefined();
    expect(JSON.stringify(variables)).not.toContain(PROVIDER_SECRET);
  });
});

describe('evaluateChecks', () => {
  it('runs command checks sequentially in declared order with the case worktree as cwd', async () => {
    const checks = [
      commandCheck('acc-second'),
      commandCheck('acc-first'),
      manualCheck('man-only', false),
    ];
    const { adapter, requests, log } = fakeEvaluatorProcess(() => succeeded(0));
    const input = buildEvaluationInput({ checks, processes: adapter });

    const result = await evaluateChecks(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((check) => check.checkId)).toEqual([
      'acc-second',
      'acc-first',
      'man-only',
    ]);
    expect(result.value[2]).toEqual({
      checkId: 'man-only',
      category: 'definition-of-done',
      verdict: 'pending',
      evidence: 'awaiting manual assessment',
      durationMs: null,
    });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.cwd).toBe(input.workspace.worktreeDirectory);
      expect(request.argv).toEqual(['/synthetic/acceptance-probe', '--suite', 'synthetic']);
      expect(request.timeoutMs).toBe(5000);
      expect(request.terminationGraceMs).toBe(250);
    }
    expect(log).toEqual(['start-0', 'end-0', 'start-1', 'end-1']);
  });

  it('passes a check only for a declared success exit code', async () => {
    const checks = [
      commandCheck('acc-zero', { exit_codes: [0] }),
      commandCheck('acc-three', { exit_codes: [0, 3] }),
    ];
    const { adapter } = fakeEvaluatorProcess((request, call) => succeeded(call === 0 ? 0 : 3));
    const input = buildEvaluationInput({ checks, processes: adapter });

    const result = await evaluateChecks(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((check) => check.verdict)).toEqual(['passed', 'passed']);
  });

  it('fails a check whose exit code is not declared as a success exit code', async () => {
    const { adapter } = fakeEvaluatorProcess(() =>
      succeeded(7, {
        stdout: { text: 'step failed', totalBytes: 11, truncated: false, incomplete: false },
      }),
    );
    const input = buildEvaluationInput({
      checks: [commandCheck('acc-undeclared')],
      processes: adapter,
    });

    const result = await evaluateChecks(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].verdict).toBe('failed');
    expect(result.value[0].evidence).toContain('exit code 7 (not a declared success exit code)');
    expect(result.value[0].evidence).toContain('stdout (11 bytes): step failed');
    expect(result.value[0].evidence).toContain('stderr (0 bytes)');
  });

  it('fails a check that exceeds its timeout and reports the termination stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-timeout-'));
    try {
      const processes = createEvaluatorProcessAdapter(() => []);
      const checks = [
        commandCheck('acc-timeout', {
          run: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'],
          timeout: '250ms',
        }),
      ];
      const input = buildEvaluationInput({
        checks,
        processes,
        workspace: {
          ...buildEvaluationInput().workspace,
          worktreeDirectory: root,
        },
      });

      const result = await evaluateChecks(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0].verdict).toBe('failed');
      expect(result.value[0].evidence).toContain('timed out after 250ms (termination: graceful)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails a check terminated by a signal and reports the signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-signal-'));
    try {
      const processes = createEvaluatorProcessAdapter(() => []);
      const checks = [
        commandCheck('acc-signal', {
          run: [process.execPath, '-e', "process.kill(process.pid, 'SIGKILL')"],
          timeout: '15s',
        }),
      ];
      const input = buildEvaluationInput({
        checks,
        processes,
        workspace: { ...buildEvaluationInput().workspace, worktreeDirectory: root },
      });

      const result = await evaluateChecks(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0].verdict).toBe('failed');
      expect(result.value[0].evidence).toContain('terminated by signal SIGKILL');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails a check whose process cannot be launched without throwing', async () => {
    const { adapter } = fakeEvaluatorProcess(() => ({
      launched: false,
      reason: 'spawn synthetic ENOENT',
    }));
    const input = buildEvaluationInput({
      checks: [commandCheck('acc-launch')],
      processes: adapter,
    });

    const result = await evaluateChecks(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].verdict).toBe('failed');
    expect(result.value[0].evidence).toBe('launch failed: spawn synthetic ENOENT');
    expect(result.value[0].durationMs).toBeNull();
  });

  it('keeps a thrown process-adapter failure as failed-check evidence', async () => {
    const { adapter } = fakeEvaluatorProcess(() => {
      throw new Error('adapter exploded');
    });
    const input = buildEvaluationInput({
      checks: [commandCheck('acc-thrown')],
      processes: adapter,
    });

    const result = await evaluateChecks(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].verdict).toBe('failed');
    expect(result.value[0].evidence).toBe('launch failed: adapter exploded');
  });

  it('redacts credential secrets from captured evidence before it leaves the module', async () => {
    const { adapter } = fakeEvaluatorProcess(() =>
      succeeded(1, {
        stdout: {
          text: `token=${PROVIDER_SECRET}`,
          totalBytes: 40,
          truncated: false,
          incomplete: false,
        },
        stderr: {
          text: `trace ${PARENT_SENTINEL}`,
          totalBytes: 30,
          truncated: false,
          incomplete: false,
        },
      }),
    );
    const input = buildEvaluationInput({
      checks: [commandCheck('acc-redaction')],
      processes: adapter,
      redact: createRedactor([PROVIDER_SECRET, PARENT_SENTINEL]),
    });

    const result = await evaluateChecks(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.value[0].evidence;
    expect(evidence).toContain('[REDACTED]');
    expect(evidence).not.toContain(PROVIDER_SECRET);
    expect(evidence).not.toContain(PARENT_SENTINEL);
  });

  it('reports capture size and truncation in the evidence', async () => {
    const { adapter } = fakeEvaluatorProcess(() =>
      succeeded(0, {
        stdout: { text: 'partial capture', totalBytes: 999, truncated: true, incomplete: false },
      }),
    );
    const input = buildEvaluationInput({
      checks: [commandCheck('acc-capture')],
      processes: adapter,
    });

    const result = await evaluateChecks(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].evidence).toContain('stdout (999 bytes, truncated): partial capture');
    expect(result.value[0].evidence).toContain('stderr (0 bytes)');
  });

  it('stops before the next check once cancellation is requested', async () => {
    const controller = new AbortController();
    const { adapter, requests } = fakeEvaluatorProcess(() => {
      controller.abort();
      return succeeded(0);
    });
    const input = buildEvaluationInput({
      checks: [commandCheck('acc-second'), commandCheck('acc-third')],
      processes: adapter,
      cancellation: controller.signal,
    });

    const result = await evaluateChecks(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((check) => check.checkId)).toEqual(['acc-second']);
    expect(requests).toHaveLength(1);
  });

  it('executes a real acceptance command with exactly the fixed evaluator environment plus its allowlisted values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-real-env-'));
    try {
      const environments = createEnvironmentAdapter();
      const config = rekeyToFakeAgent(buildSyntheticConfig());
      const environmentNames = buildEnvironmentVariableNames(config);
      const snapshot = environments.snapshotParent(environmentNames);
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) return;
      const worktreeDirectory = join(root, 'worktree');
      await mkdir(worktreeDirectory, { recursive: true });
      const workspace = {
        caseId: 'task-1--alpha--1',
        sourceRepositoryPath: '/tevu-synthetic/repo-1',
        sourceCommit: '0123456789abcdef0123456789abcdef01234567',
        repositoryDirectory: join(root, 'repo'),
        worktreeDirectory,
        runtimeDirectory: join(root, 'runtime'),
        branch: 'tevu/task-1--alpha--1',
        syntheticCommit: '0synthetic0000000000000000000000000000000c',
      };

      const created = await environments.createCaseEnvironments(
        workspace,
        snapshot.value,
        environmentNames,
        AGENT_NAME,
        [],
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { evaluator, agent } = created.value;

      expect(
        evaluator.homeDirectory.startsWith(join(workspace.runtimeDirectory, 'evaluator')),
      ).toBe(true);
      expect(agent.homeDirectory.startsWith(join(workspace.runtimeDirectory, 'agent'))).toBe(true);
      expect(evaluator.homeDirectory).not.toBe(agent.homeDirectory);
      expect(evaluator.temporaryDirectory).not.toBe(agent.temporaryDirectory);
      expect(Object.keys(evaluator.variables).sort()).toEqual([
        'CI',
        'HOME',
        'LANG',
        'LC_ALL',
        'PATH',
        'TMPDIR',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
      ]);
      expect(evaluator.variables).not.toHaveProperty(PROVIDER_ENV_NAME);
      expect(evaluator.variableManifest).toContainEqual({
        name: ORDINARY_ENV_NAME,
        classification: 'ordinary',
        recipient: 'evaluator',
      });
      for (const record of evaluator.variableManifest) {
        expect(JSON.stringify(record)).not.toContain(PROVIDER_SECRET);
      }

      const argv = [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync('evaluator-created.txt', 'evaluator change'); process.stdout.write(JSON.stringify({ argv: process.argv, cwd: process.cwd(), env: process.env }));",
        'literal-flag',
        'literal-value',
      ] as [string, ...string[]];
      const input = buildEvaluationInput({
        checks: [
          commandCheck('acc-real-env', {
            run: argv,
            timeout: '15s',
            exit_codes: [0],
            env: [ORDINARY_ENV_NAME],
          }),
        ],
        workspace,
        environment: evaluator,
        snapshot: snapshot.value,
        processes: createEvaluatorProcessAdapter(() => [PROVIDER_SECRET]),
        redact: createRedactor([PROVIDER_SECRET, PARENT_SENTINEL]),
      });

      const result = await evaluateChecks(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0].verdict).toBe('passed');
      const stdoutLine = result.value[0].evidence.split('\n')[1];
      const reported = JSON.parse(stdoutLine.slice(stdoutLine.indexOf('): ') + 3)) as {
        argv: string[];
        cwd: string;
        env: Record<string, string>;
      };
      expect(reported.argv).toEqual([process.execPath, 'literal-flag', 'literal-value']);
      expect(reported.cwd).toBe(worktreeDirectory);
      expect(Object.keys(reported.env).sort()).toEqual([
        'CI',
        'HOME',
        'LANG',
        'LC_ALL',
        'PATH',
        ORDINARY_ENV_NAME,
        'TMPDIR',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
      ]);
      expect(reported.env['PATH']).toBe(snapshot.value.path);
      expect(reported.env['HOME']).toBe(evaluator.homeDirectory);
      expect(reported.env['TMPDIR']).toBe(evaluator.temporaryDirectory);
      expect(reported.env['LANG']).toBe('C.UTF-8');
      expect(reported.env['LC_ALL']).toBe('C.UTF-8');
      expect(reported.env['CI']).toBe('1');
      expect(reported.env[ORDINARY_ENV_NAME]).toBe(ORDINARY_VALUE);
      expect(JSON.stringify(reported.env)).not.toContain(PROVIDER_SECRET);
      expect(JSON.stringify(reported.env)).not.toContain(PARENT_SENTINEL);
      expect(existsSync(join(worktreeDirectory, 'evaluator-created.txt'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('a command check with a string run', () => {
  const COMMAND_LINE = '  CI=1 npm test -- --run | tee "out log" && echo "a: #b"  ';

  describe('with a fake process adapter', () => {
    it('hands the string to /bin/sh -c exactly as written', async () => {
      const { adapter, requests } = fakeEvaluatorProcess(() => succeeded(0));
      const input = buildEvaluationInput({
        checks: [commandCheck('acc-string', { run: COMMAND_LINE })],
        processes: adapter,
      });

      await evaluateChecks(input);

      expect(requests[0]?.argv).toEqual(['/bin/sh', '-c', COMMAND_LINE]);
    });

    it('runs an array without a shell and gives both forms the same directory, limits, and cancellation', async () => {
      const controller = new AbortController();
      const { adapter, requests } = fakeEvaluatorProcess(() => succeeded(0));
      const input = buildEvaluationInput({
        checks: [
          commandCheck('acc-string', { run: 'npm test' }),
          commandCheck('acc-array', { run: ['npm', 'test'] }),
        ],
        processes: adapter,
        cancellation: controller.signal,
      });

      await evaluateChecks(input);

      const [fromString, fromArray] = requests;
      expect(fromArray?.argv).toEqual(['npm', 'test']);
      expect({ ...fromString, argv: undefined }).toEqual({ ...fromArray, argv: undefined });
    });
  });

  describe('with the real /bin/sh', () => {
    async function withWorktree<T>(run: (worktree: string) => Promise<T>): Promise<T> {
      const root = await mkdtemp(join(tmpdir(), 'tevu-eval-shell-'));
      try {
        return await run(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    function buildShellInput(
      worktree: string,
      check: OrderedCheck,
      overrides: Partial<CheckEvaluationInput> = {},
    ): CheckEvaluationInput {
      const base = buildEvaluationInput();
      return buildEvaluationInput({
        checks: [check],
        processes: createEvaluatorProcessAdapter(() => []),
        workspace: { ...base.workspace, worktreeDirectory: worktree },
        environment: {
          ...base.environment,
          variables: {
            ...base.environment.variables,
            PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          },
        },
        ...overrides,
      });
    }

    async function tickCount(worktree: string): Promise<number> {
      const text = await readFile(join(worktree, 'ticks.log'), 'utf8').catch(() => '');
      return text.split('\n').filter((line) => line.length > 0).length;
    }

    const BACKGROUND_TICKER = '(while :; do echo tick >> ticks.log; sleep 0.05; done) & wait';

    it('expands a declared variable and leaves an undeclared parent variable empty', async () => {
      const command = `printf '%s|%s' "$${ORDINARY_ENV_NAME}" "$TEVU_PARENT_SENTINEL"`;

      const result = await withWorktree((worktree) =>
        evaluateChecks(
          buildShellInput(
            worktree,
            commandCheck('acc-env', { run: command, env: [ORDINARY_ENV_NAME] }),
          ),
        ),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.verdict).toBe('passed');
      expect(result.value[0]?.evidence).toContain(`: ${ORDINARY_VALUE}|`);
      expect(result.value[0]?.evidence).not.toContain(PARENT_SENTINEL);
    });

    it.each([
      { command: 'true && false', exitCodes: [0], verdict: 'failed' },
      { command: 'true && exit 3', exitCodes: [3], verdict: 'passed' },
      { command: 'false | true', exitCodes: [0], verdict: 'passed' },
      { command: 'true | false', exitCodes: [0], verdict: 'failed' },
    ])(
      'decides the verdict of "$command" from its shell status against exit_codes',
      async ({ command, exitCodes, verdict }) => {
        const result = await withWorktree((worktree) =>
          evaluateChecks(
            buildShellInput(
              worktree,
              commandCheck('acc-status', { run: command, exit_codes: exitCodes }),
            ),
          ),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value[0]?.verdict).toBe(verdict);
      },
    );

    it('exits 127 with the shell message as evidence when the command cannot be found', async () => {
      const result = await withWorktree((worktree) =>
        evaluateChecks(
          buildShellInput(worktree, commandCheck('acc-missing', { run: 'tevu-no-such-command' })),
        ),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.verdict).toBe('failed');
      expect(result.value[0]?.evidence).toContain('exit code 127');
      expect(result.value[0]?.evidence).toMatch(/tevu-no-such-command.*not found/);
    });

    it('finds the shell by its absolute path when the evaluator PATH does not hold it', async () => {
      const result = await withWorktree((worktree) => {
        const base = buildShellInput(worktree, commandCheck('acc-path', { run: 'echo ok' }));
        return evaluateChecks({
          ...base,
          environment: {
            ...base.environment,
            variables: { ...base.environment.variables, PATH: '/tevu-synthetic/no-such-bin' },
          },
        });
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.verdict).toBe('passed');
    });

    it('leaves no background process running after the check times out', async () => {
      await withWorktree(async (worktree) => {
        const check = commandCheck('acc-timeout', { run: BACKGROUND_TICKER, timeout: '1s' });

        const result = await evaluateChecks(buildShellInput(worktree, check));

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value[0]?.evidence).toContain('timed out after 1000ms');
        const ticksAtEnd = await tickCount(worktree);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(ticksAtEnd).toBeGreaterThan(0);
        expect(await tickCount(worktree)).toBe(ticksAtEnd);
      });
    });

    it('leaves no background process running after the check is cancelled', async () => {
      await withWorktree(async (worktree) => {
        const controller = new AbortController();
        const check = commandCheck('acc-cancel', { run: BACKGROUND_TICKER, timeout: '30s' });

        const pending = evaluateChecks(
          buildShellInput(worktree, check, { cancellation: controller.signal }),
        );
        await vi.waitFor(async () => expect(await tickCount(worktree)).toBeGreaterThan(0));
        controller.abort();
        await pending;

        const ticksAtEnd = await tickCount(worktree);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(await tickCount(worktree)).toBe(ticksAtEnd);
      });
    });
  });
});

describe('reduceRequiredOutcome', () => {
  it.each([
    {
      scenario: 'all required checks pass while an optional check fails',
      checks: [commandCheck('acc-a'), manualCheck('dod-a', true), manualCheck('man-a', false)],
      results: [
        buildCheckResult({ checkId: 'acc-a' }),
        buildCheckResult({ checkId: 'dod-a', category: 'definition-of-done' }),
        buildCheckResult({ checkId: 'man-a', category: 'definition-of-done', verdict: 'failed' }),
      ],
      expected: 'passed',
    },
    {
      scenario: 'a required check fails',
      checks: [commandCheck('acc-a'), manualCheck('dod-a', true)],
      results: [
        buildCheckResult({ checkId: 'acc-a', verdict: 'failed' }),
        buildCheckResult({ checkId: 'dod-a', category: 'definition-of-done' }),
      ],
      expected: 'failed',
    },
    {
      scenario: 'a required manual check is still pending',
      checks: [commandCheck('acc-a'), manualCheck('dod-a', true)],
      results: [
        buildCheckResult({ checkId: 'acc-a' }),
        buildCheckResult({
          checkId: 'dod-a',
          category: 'definition-of-done',
          verdict: 'pending',
          durationMs: null,
        }),
      ],
      expected: 'pending',
    },
    {
      scenario: 'a required check never produced a result',
      checks: [commandCheck('acc-a'), manualCheck('dod-a', true)],
      results: [buildCheckResult({ checkId: 'acc-a' })],
      expected: 'pending',
    },
    {
      scenario: 'an optional manual check stays pending without changing a passed outcome',
      checks: [commandCheck('acc-a'), manualCheck('man-a', false)],
      results: [
        buildCheckResult({ checkId: 'acc-a' }),
        buildCheckResult({
          checkId: 'man-a',
          category: 'definition-of-done',
          verdict: 'pending',
          durationMs: null,
        }),
      ],
      expected: 'passed',
    },
  ])('reduces the outcome to $expected when $scenario', ({ checks, results, expected }) => {
    const requirements = checks.map((check) => ({
      id: check.definition.id,
      required: check.definition.required,
    }));
    expect(reduceRequiredOutcome(requirements, results)).toBe(expected);
  });
});

function buildAgentMetrics(overrides: Partial<AgentMetrics> = {}): AgentMetrics {
  const measured = (value: number, unit: 'count' | 'token' | 'USD'): AgentMetrics['cost'] => ({
    value,
    unit,
    availability: { status: 'available', source: 'root-session export' },
    scope: 'root-session',
  });
  return {
    inputTokens: measured(130, 'token'),
    outputTokens: measured(45, 'token'),
    reasoningTokens: measured(16, 'token'),
    cacheReadTokens: measured(30, 'token'),
    cacheWriteTokens: measured(10, 'token'),
    turns: measured(1, 'count'),
    apiCalls: measured(2, 'count'),
    apiErrors: measured(1, 'count'),
    toolCalls: measured(2, 'count'),
    skillCalls: measured(1, 'count'),
    cost: measured(0.0125, 'USD'),
    ...overrides,
  };
}

describe('combineCaseMetrics', () => {
  it("reads elapsed from a measured process duration and every other field from the agent's normalized value", () => {
    const combined = combineCaseMetrics({
      durationMs: 1500,
      elapsedUnavailableReason: 'unused',
      normalized: { ok: true, value: buildAgentMetrics() },
    });

    expect(combined.protocolFailure).toBeNull();
    expect(combined.metrics.elapsed).toEqual({
      value: 1500,
      unit: 'millisecond',
      availability: { status: 'available', source: 'process' },
      scope: 'case',
    });
    expect(combined.metrics.inputTokens).toEqual(buildAgentMetrics().inputTokens);
    expect(Object.keys(combined.metrics)).toEqual([
      'elapsed',
      'inputTokens',
      'outputTokens',
      'reasoningTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'turns',
      'apiCalls',
      'apiErrors',
      'toolCalls',
      'skillCalls',
      'cost',
    ]);
  });

  it('marks elapsed unavailable with the supplied reason when no process timing exists', () => {
    const combined = combineCaseMetrics({
      durationMs: null,
      elapsedUnavailableReason: 'the agent process produced no timing evidence',
      normalized: { ok: true, value: buildAgentMetrics() },
    });

    expect(combined.metrics.elapsed).toEqual({
      value: null,
      unit: 'millisecond',
      availability: {
        status: 'unavailable',
        reason: 'the agent process produced no timing evidence',
      },
      scope: 'case',
    });
  });

  it("marks every field unavailable with the protocol failure's reason and preserves the failure", () => {
    const failure = {
      kind: 'AgentProtocolError' as const,
      agent: 'opencode',
      context: { phase: 'case' as const, caseId: 'task-1--alpha--1' },
      reason: 'part identity (sessionID, messageID, id) is missing or malformed',
    };

    const combined = combineCaseMetrics({
      durationMs: 1500,
      elapsedUnavailableReason: 'unused',
      normalized: { ok: false, error: failure },
    });

    expect(combined.protocolFailure).toEqual(failure);
    for (const [name, metric] of Object.entries(combined.metrics)) {
      if (name === 'elapsed') continue;
      expect(metric).toMatchObject({
        value: null,
        availability: { status: 'unavailable', reason: failure.reason },
      });
    }
    expect(combined.metrics.elapsed).toEqual({
      value: 1500,
      unit: 'millisecond',
      availability: { status: 'available', source: 'process' },
      scope: 'case',
    });
  });

  it('leaves elapsed unavailable too when a protocol failure coincides with no measured duration', () => {
    const failure = {
      kind: 'AgentProtocolError' as const,
      agent: 'opencode',
      context: { phase: 'case' as const, caseId: 'task-1--alpha--1' },
      reason: 'run output did not identify a root session',
    };

    const combined = combineCaseMetrics({
      durationMs: null,
      elapsedUnavailableReason: 'the agent process produced no timing evidence',
      normalized: { ok: false, error: failure },
    });

    expect(combined.metrics.elapsed).toMatchObject({
      value: null,
      availability: { status: 'unavailable', reason: failure.reason },
    });
  });
});

describe('unavailableBenchmarkMetrics', () => {
  it('returns every metric unavailable with one reason and no fake zeros', () => {
    const metrics = unavailableBenchmarkMetrics('case timed out; checks were not run');

    for (const [name, metric] of Object.entries(metrics)) {
      expect(metric).toMatchObject({
        value: null,
        availability: { status: 'unavailable', reason: 'case timed out; checks were not run' },
      });
      expect(metric.scope).toBe(name === 'elapsed' ? 'case' : 'root-session');
      expect(metric.scope).not.toBe('session-tree');
    }
  });
});

const GOLDEN_NORMALIZED_JSON =
  '{\n  "assessments": [],\n  "capabilities": {},\n  "cases": [\n    {\n      "artifacts": {\n        "assessment": null,\n        "checks": null,\n        "diagnostics": null,\n        "events": null,\n        "grading": null,\n        "result": "cases/task-1--alpha--1/result.json",\n        "sessionExport": null,\n        "solutionPatch": null\n      },\n      "checks": [],\n      "failure": null,\n      "identity": {\n        "agent": "opencode",\n        "attempt": 1,\n        "caseId": "task-1--alpha--1",\n        "effort": "effort-high",\n        "model": "vendor/model-alpha-synth",\n        "modelId": "alpha",\n        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",\n        "taskId": "task-1",\n        "timeoutMs": 1000\n      },\n      "lifecycle": "completed",\n      "metrics": {\n        "apiCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "apiErrors": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "cacheReadTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "cacheWriteTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "cost": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "USD",\n          "value": null\n        },\n        "elapsed": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "case",\n          "unit": "millisecond",\n          "value": null\n        },\n        "inputTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "outputTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "reasoningTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "skillCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "toolCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "turns": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        }\n      },\n      "outcome": "passed",\n      "process": {\n        "durationMs": 1500,\n        "endedAt": "2026-09-23T00:00:01.500Z",\n        "exitCode": 0,\n        "signal": null,\n        "startedAt": "2026-09-23T00:00:00.000Z",\n        "terminationStage": "none"\n      },\n      "schemaVersion": 1\n    },\n    {\n      "artifacts": {\n        "assessment": null,\n        "checks": null,\n        "diagnostics": null,\n        "events": null,\n        "grading": null,\n        "result": "cases/task-2--alpha--1/result.json",\n        "sessionExport": null,\n        "solutionPatch": null\n      },\n      "checks": [],\n      "failure": null,\n      "identity": {\n        "agent": "opencode",\n        "attempt": 1,\n        "caseId": "task-2--alpha--1",\n        "effort": "effort-high",\n        "model": "vendor/model-alpha-synth",\n        "modelId": "alpha",\n        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",\n        "taskId": "task-2",\n        "timeoutMs": 1000\n      },\n      "lifecycle": "completed",\n      "metrics": {\n        "apiCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "apiErrors": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "cacheReadTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "cacheWriteTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "cost": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "USD",\n          "value": null\n        },\n        "elapsed": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "case",\n          "unit": "millisecond",\n          "value": null\n        },\n        "inputTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "outputTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "reasoningTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "skillCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "toolCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "turns": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        }\n      },\n      "outcome": "passed",\n      "process": {\n        "durationMs": 1500,\n        "endedAt": "2026-09-23T00:00:01.500Z",\n        "exitCode": 0,\n        "signal": null,\n        "startedAt": "2026-09-23T00:00:00.000Z",\n        "terminationStage": "none"\n      },\n      "schemaVersion": 1\n    }\n  ],\n  "exitCode": 0,\n  "findings": [],\n  "graders": [],\n  "gradings": [],\n  "manifest": {\n    "cases": [\n      {\n        "agent": "opencode",\n        "attempt": 1,\n        "caseId": "task-1--alpha--1",\n        "effort": "effort-high",\n        "model": "vendor/model-alpha-synth",\n        "modelId": "alpha",\n        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",\n        "taskId": "task-1",\n        "timeoutMs": 1000\n      },\n      {\n        "agent": "opencode",\n        "attempt": 1,\n        "caseId": "task-2--alpha--1",\n        "effort": "effort-high",\n        "model": "vendor/model-alpha-synth",\n        "modelId": "alpha",\n        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",\n        "taskId": "task-2",\n        "timeoutMs": 1000\n      }\n    ],\n    "completedAt": "2026-01-01T00:05:00.000Z",\n    "configDigest": "sha256-golden-digest",\n    "configPath": "/synthetic/tevu.yaml",\n    "efforts": {\n      "grader": null,\n      "models": {\n        "alpha": {\n          "status": "verified"\n        }\n      }\n    },\n    "execution": {\n      "caseTimeoutMs": 1000,\n      "concurrency": 1,\n      "repeat": {\n        "source": "config",\n        "value": 1\n      }\n    },\n    "host": {\n      "nodeVersion": "v24.21.0",\n      "platform": "linux"\n    },\n    "runId": "20260101t000000z-golden",\n    "schemaVersion": 1,\n    "startedAt": "2026-01-01T00:00:00.000Z",\n    "tools": {\n      "agentConfigurationFiles": {},\n      "agentVersions": {\n        "opencode": null\n      },\n      "copiedProviders": {},\n      "gitVersion": "git version 2.45.0"\n    }\n  },\n  "models": [],\n  "pairs": [\n    {\n      "allPassed": true,\n      "modelId": "alpha",\n      "outcomes": {\n        "failed": 0,\n        "not-evaluated": 0,\n        "passed": 1,\n        "pending": 0\n      },\n      "passedOfPlanned": "1/1",\n      "planned": 1,\n      "taskId": "task-1"\n    },\n    {\n      "allPassed": true,\n      "modelId": "alpha",\n      "outcomes": {\n        "failed": 0,\n        "not-evaluated": 0,\n        "passed": 1,\n        "pending": 0\n      },\n      "passedOfPlanned": "1/1",\n      "planned": 1,\n      "taskId": "task-2"\n    }\n  ],\n  "repositories": [],\n  "schemaVersion": 1,\n  "tasks": [\n    {\n      "checks": [\n        {\n          "category": "acceptance",\n          "description": "acceptance command exits zero",\n          "evaluator": "command",\n          "id": "acc-acceptance-command",\n          "required": true\n        },\n        {\n          "category": "definition-of-done",\n          "description": "manual Definition of Done review",\n          "evaluator": "manual",\n          "id": "dod-manual-review",\n          "required": true\n        },\n        {\n          "category": "definition-of-done",\n          "description": "optional manual polish review",\n          "evaluator": "manual",\n          "id": "man-optional-polish",\n          "required": false\n        }\n      ],\n      "description": "synthetic task description for the welcome route",\n      "id": "task-1",\n      "repositoryId": "repo-1",\n      "source": {\n        "kind": "manual"\n      },\n      "startCommit": "0123456789abcdef0123456789abcdef01234567",\n      "title": "Synthetic welcome-route task"\n    },\n    {\n      "checks": [\n        {\n          "category": "acceptance",\n          "description": "acceptance command exits zero",\n          "evaluator": "command",\n          "id": "acc-acceptance-command",\n          "required": true\n        },\n        {\n          "category": "definition-of-done",\n          "description": "manual Definition of Done review",\n          "evaluator": "manual",\n          "id": "dod-manual-review",\n          "required": true\n        },\n        {\n          "category": "definition-of-done",\n          "description": "optional manual polish review",\n          "evaluator": "manual",\n          "id": "man-optional-polish",\n          "required": false\n        }\n      ],\n      "description": "synthetic task description for the welcome route",\n      "id": "task-2",\n      "repositoryId": "repo-1",\n      "source": {\n        "issueKey": "TEVU-999",\n        "issueUrl": "https://jira.example.com/browse/TEVU-999",\n        "kind": "jira-cloud"\n      },\n      "startCommit": "0123456789abcdef0123456789abcdef01234567",\n      "title": "Synthetic imported task"\n    }\n  ]\n}\n';

const GOLDEN_MARKDOWN =
  '# tevu run 20260101t000000z-golden\n\n## Comparison: Synthetic welcome-route task\n\n| Model | Effort | Outcome | Required checks | Elapsed | Cost | Turns | Tool calls | Input | Cache read | Cache write | Output | Reasoning | API errors | Runtime failure |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n| [alpha](#case-task-1--alpha--1) | effort-high | passed | 0/2 passed, 2 not run | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | none |\n\n1. alpha: tevu has no value for this measurement. It is unknown, not zero. This run\'s saved files cannot supply it; to measure it, fix the cause in the technical detail and run the comparison again. Technical detail: not yet normalized\n\n## Comparison: Synthetic imported task\n\n| Model | Effort | Outcome | Required checks | Elapsed | Cost | Turns | Tool calls | Input | Cache read | Cache write | Output | Reasoning | API errors | Runtime failure |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n| [alpha](#case-task-2--alpha--1) | effort-high | passed | 0/2 passed, 2 not run | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | - \\[1\\] | none |\n\n1. alpha: tevu has no value for this measurement. It is unknown, not zero. This run\'s saved files cannot supply it; to measure it, fix the cause in the technical detail and run the comparison again. Technical detail: not yet normalized\n\n> **Sensitive data:** the tevu configuration file and this artifact directory can contain\n> sensitive private repository, task, Jira, model-output, and evaluator data. They rely on\n> host filesystem access controls.\n>\n> **Isolation boundary:** context isolation is non-adversarial. It withholds sibling runs,\n> later Git history, host agent state, and benchmark artifacts from normal discovery.\n> It does not claim that a model with shell access cannot probe arbitrary host paths.\n\n## Run\n\n- Configuration digest: `sha256-golden-digest`\n- Started: 2026-01-01T00:00:00.000Z\n- Completed: 2026-01-01T00:05:00.000Z\n- Host: linux, Node.js v24.21.0, Git git version 2.45.0\n- Agent "opencode" version (detected provenance only): not detected\n- Agent "opencode" isolation control (deny outside worktree): not probed\n- Concurrency: 1\n- Case timeout: 1000ms\n- Repeat: 1 (source: config)\n- Run exit code: 0\n\n## Task: Synthetic welcome-route task\n\nsynthetic task description for the welcome route\n\n- Repository: `repo-1`\n- Source commit: `0123456789abcdef0123456789abcdef01234567`\n\nPair summary:\n\n| Model setting | Planned | passed | failed | pending | not-evaluated | Passed of planned | All passed |\n|---|---|---|---|---|---|---|---|\n| alpha | 1 | 1 | 0 | 0 | 0 | 1/1 | yes |\n\n| Attempt | Outcome | Required checks | Runtime failure | Elapsed |\n|---|---|---|---|---|\n| [alpha](#case-task-1--alpha--1) | passed | 0/2 passed, 2 not run | none | - |\n\n<a id="case-task-1--alpha--1"></a>\n\n### alpha\n\n- Outcome: passed; required checks 0/2 passed, 2 not run\n- Model: vendor/model-alpha-synth, effort effort-high\n- Agent process: exited with code 0 after 1.5 s\n\nRecord or replace verdicts with `tevu assess 20260101t000000z-golden task-1--alpha--1`.\n\nMetrics:\n\n- Not measured: Elapsed, Cost, Turns, API calls, Tool calls, Skill calls, Input tokens, Cache read tokens, Cache write tokens, Output tokens, Reasoning tokens, API errors. tevu has no value for these measurements. They are unknown, not zero. This run\'s saved files cannot supply them; to measure them, fix the cause in the technical detail and run the comparison again. Technical detail: not yet normalized\n\nArtifacts:\n\n- Solution patch: missing\n- Events: missing\n- Diagnostics: missing\n- Session export: missing\n- Check evidence: missing\n- Result: [result.json](cases/task-1--alpha--1/result.json)\n\n## Task: Synthetic imported task\n\nsynthetic task description for the welcome route\n\n- Repository: `repo-1`\n- Source commit: `0123456789abcdef0123456789abcdef01234567`\n- Source: imported from Jira issue [TEVU-999](https://jira.example.com/browse/TEVU-999)\n\nPair summary:\n\n| Model setting | Planned | passed | failed | pending | not-evaluated | Passed of planned | All passed |\n|---|---|---|---|---|---|---|---|\n| alpha | 1 | 1 | 0 | 0 | 0 | 1/1 | yes |\n\n| Attempt | Outcome | Required checks | Runtime failure | Elapsed |\n|---|---|---|---|---|\n| [alpha](#case-task-2--alpha--1) | passed | 0/2 passed, 2 not run | none | - |\n\n<a id="case-task-2--alpha--1"></a>\n\n### alpha\n\n- Outcome: passed; required checks 0/2 passed, 2 not run\n- Model: vendor/model-alpha-synth, effort effort-high\n- Agent process: exited with code 0 after 1.5 s\n\nRecord or replace verdicts with `tevu assess 20260101t000000z-golden task-2--alpha--1`.\n\nMetrics:\n\n- Not measured: Elapsed, Cost, Turns, API calls, Tool calls, Skill calls, Input tokens, Cache read tokens, Cache write tokens, Output tokens, Reasoning tokens, API errors. tevu has no value for these measurements. They are unknown, not zero. This run\'s saved files cannot supply them; to measure them, fix the cause in the technical detail and run the comparison again. Technical detail: not yet normalized\n\nArtifacts:\n\n- Solution patch: missing\n- Events: missing\n- Diagnostics: missing\n- Session export: missing\n- Check evidence: missing\n- Result: [result.json](cases/task-2--alpha--1/result.json)\n\n---\n\nTask outcome, runtime failure, and run exit status are reported independently.\nCommand check output is configured acceptance evidence, not an additional model-quality metric.\nNo composite score or winner is computed.\n';

describe('deterministic report regeneration', () => {
  it('sorts every collection by stable identity regardless of input order', () => {
    const records = buildSyntheticRecords();
    const config = rekeyToFakeAgent(buildSyntheticConfig());
    const decoded = decodeRunConfig(config);
    if (!decoded.ok) throw new Error('synthetic config must decode');
    const run: RunResult = {
      schemaVersion: 1,
      manifest: records.manifest,
      cases: [...records.caseResults].reverse(),
      findings: [...records.findings],
      exitCode: 2,
    };
    const input = {
      run: { ...run, cases: records.caseResults },
      capabilities: { [AGENT_NAME]: records.capabilities },
      tasks: decoded.value.tasks,
      models: decoded.value.models,
      repositories: decoded.value.repositories,
      assessments: [records.assessment],
      gradings: [],
    };
    const reordered = {
      run,
      capabilities: { [AGENT_NAME]: records.capabilities },
      tasks: [...decoded.value.tasks].reverse(),
      models: decoded.value.models,
      repositories: [...decoded.value.repositories].reverse(),
      assessments: [records.assessment],
      gradings: [],
    };

    const model = buildNormalizedRun(input);

    expect(model.cases.map((entry) => entry.identity.caseId)).toEqual([
      'task-1--alpha--1',
      'task-1--beta--1',
      'task-2--gamma--1',
    ]);
    expect(model.tasks.map((task) => task.id)).toEqual(['task-1', 'task-2']);
    expect(model.models.map((entry) => entry.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(model.cases[0].checks.map((check) => check.checkId)).toEqual([
      'acc-acceptance-command',
      'dod-manual-review',
      'man-optional-polish',
    ]);
    expect(serializeNormalizedRun(buildNormalizedRun(reordered))).toBe(
      serializeNormalizedRun(model),
    );
    expect(buildReport(reordered).markdown).toBe(buildReport(input).markdown);
  });

  it('renders manual and Jira task sources byte-identically to the pre-GitHub-import report output', () => {
    const manualTask = buildTaskRecord();
    const jiraTask = buildTaskRecord({
      id: 'task-2',
      title: 'Synthetic imported task',
      source: {
        kind: 'jira-cloud',
        issueKey: 'TEVU-999',
        issueUrl: 'https://jira.example.com/browse/TEVU-999',
      },
    });
    // This golden fixture pins report output that predates the agent-adapter
    // migration; its identities stay literally "opencode" so the pinned
    // bytes below never change. No `AgentRegistry` is involved here.
    const manualCase = buildCaseResult({
      identity: buildCaseIdentity({ agent: 'opencode', timeoutMs: 1000 }),
    });
    const jiraCase = buildCaseResult({
      identity: buildCaseIdentity({
        caseId: 'task-2--alpha--1',
        taskId: 'task-2',
        sourceCommit: jiraTask.startCommit,
        agent: 'opencode',
        timeoutMs: 1000,
      }),
      artifacts: buildArtifactIndex('task-2--alpha--1', new Set(['result'])),
    });
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: '20260101t000000z-golden',
      configDigest: 'sha256-golden-digest',
      configPath: '/synthetic/tevu.yaml',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
      host: { platform: 'linux', nodeVersion: 'v24.21.0' },
      tools: {
        gitVersion: 'git version 2.45.0',
        agentVersions: { opencode: null },
        agentConfigurationFiles: {},
        copiedProviders: {},
      },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 1, source: 'config' } },
      efforts: buildEfforts(),
      cases: [manualCase.identity, jiraCase.identity],
    };
    const input: ReportInput = {
      run: { schemaVersion: 1, manifest, cases: [manualCase, jiraCase], findings: [], exitCode: 0 },
      capabilities: {},
      tasks: [manualTask, jiraTask],
      models: [],
      repositories: [],
      assessments: [],
      gradings: [],
    };

    const result = buildReport(input);

    expect(result.normalizedJson).toBe(GOLDEN_NORMALIZED_JSON);
    expect(result.markdown).toBe(GOLDEN_MARKDOWN);
  });

  it('renders the GitHub issue source line and result.json entry for a github-issue task', () => {
    const githubTask = buildTaskRecord({
      id: 'task-3',
      source: {
        kind: 'github-issue',
        issueKey: 'octo/repo#42',
        issueUrl: 'https://github.com/octo/repo/issues/42',
      },
    });
    const githubCase = buildCaseResult({
      identity: buildCaseIdentity({
        caseId: 'task-3--alpha--1',
        taskId: 'task-3',
        sourceCommit: githubTask.startCommit,
      }),
      artifacts: buildArtifactIndex('task-3--alpha--1', new Set(['result'])),
    });
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: '20260101t000000z-golden-github',
      configDigest: 'sha256-golden-digest',
      configPath: '/synthetic/tevu.yaml',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
      host: { platform: 'linux', nodeVersion: 'v24.21.0' },
      tools: {
        gitVersion: 'git version 2.45.0',
        agentVersions: { opencode: null },
        agentConfigurationFiles: {},
        copiedProviders: {},
      },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 1, source: 'config' } },
      efforts: buildEfforts(),
      cases: [githubCase.identity],
    };
    const input: ReportInput = {
      run: { schemaVersion: 1, manifest, cases: [githubCase], findings: [], exitCode: 0 },
      capabilities: {},
      tasks: [githubTask],
      models: [],
      repositories: [],
      assessments: [],
      gradings: [],
    };

    const result = buildReport(input);

    expect(result.markdown).toContain(
      '- Source: imported from GitHub issue [octo/repo#42](https://github.com/octo/repo/issues/42)',
    );
    const normalized = JSON.parse(result.normalizedJson) as {
      tasks: Array<{ id: string; source: unknown }>;
    };
    const githubSource = normalized.tasks.find((task) => task.id === 'task-3')?.source;
    expect(githubSource).toEqual({
      kind: 'github-issue',
      issueKey: 'octo/repo#42',
      issueUrl: 'https://github.com/octo/repo/issues/42',
    });
  });

  it("computes each PairSummary's outcome counts, passedOfPlanned, and allPassed, topping up not-evaluated by the unmatched planned attempts, and renders the pair row (AC-6)", () => {
    const passed = buildCaseResult({
      identity: buildCaseIdentity({ caseId: 'task-1--alpha--1', attempt: 1 }),
      outcome: 'passed',
    });
    const failed = buildCaseResult({
      identity: buildCaseIdentity({ caseId: 'task-1--alpha--2', attempt: 2 }),
      outcome: 'failed',
    });
    const notEvaluatedIdentity = buildCaseIdentity({ caseId: 'task-1--alpha--3', attempt: 3 });
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: '20260101t000000z-pairs',
      configDigest: 'sha256-pairs-digest',
      configPath: '/synthetic/tevu.yaml',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
      host: { platform: 'linux', nodeVersion: 'v24.21.0' },
      tools: {
        gitVersion: 'git version 2.45.0',
        agentVersions: {},
        agentConfigurationFiles: {},
        copiedProviders: {},
      },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 3, source: 'config' } },
      efforts: buildEfforts(),
      cases: [passed.identity, failed.identity, notEvaluatedIdentity],
    };
    const input: ReportInput = {
      run: { schemaVersion: 1, manifest, cases: [passed, failed], findings: [], exitCode: 2 },
      capabilities: {},
      tasks: [buildTaskRecord()],
      models: [],
      repositories: [],
      assessments: [],
      gradings: [],
    };

    const model = buildNormalizedRun(input);
    const markdown = buildReport(input).markdown;

    expect(model.pairs).toEqual([
      {
        taskId: 'task-1',
        modelId: 'alpha',
        planned: 3,
        outcomes: { passed: 1, failed: 1, pending: 0, 'not-evaluated': 1 },
        passedOfPlanned: '1/3',
        allPassed: false,
      },
    ]);
    expect(markdown).toContain('| alpha | 3 | 1 | 1 | 0 | 1 | 1/3 | no |');
    const normalized = JSON.parse(serializeNormalizedRun(model)) as { pairs: unknown };
    expect(normalized.pairs).toEqual([
      {
        allPassed: false,
        modelId: 'alpha',
        outcomes: { failed: 1, 'not-evaluated': 1, passed: 1, pending: 0 },
        passedOfPlanned: '1/3',
        planned: 3,
        taskId: 'task-1',
      },
    ]);
  });

  it('orders findings and their rendered Run findings list by attempt number, not the caseId string, for repeat 10 (AC-11)', () => {
    const identities = Array.from({ length: 10 }, (_, index) =>
      buildCaseIdentity({ caseId: `task-1--alpha--${index + 1}`, attempt: index + 1 }),
    );
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: '20260101t000000z-order',
      configDigest: 'sha256-order-digest',
      configPath: '/synthetic/tevu.yaml',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
      host: { platform: 'linux', nodeVersion: 'v24.21.0' },
      tools: {
        gitVersion: 'git version 2.45.0',
        agentVersions: {},
        agentConfigurationFiles: {},
        copiedProviders: {},
      },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 10, source: 'config' } },
      efforts: buildEfforts(),
      cases: identities,
    };
    const findings: RunFinding[] = [
      { severity: 'warning', caseId: 'task-1--alpha--10', message: 'synthetic finding ten' },
      { severity: 'warning', caseId: 'task-1--alpha--9', message: 'synthetic finding nine' },
    ];
    const input: ReportInput = {
      run: { schemaVersion: 1, manifest, cases: [], findings, exitCode: 1 },
      capabilities: {},
      tasks: [],
      models: [],
      repositories: [],
      assessments: [],
      gradings: [],
    };

    const model = buildNormalizedRun(input);
    const markdown = buildReport(input).markdown;

    expect(model.findings.map((finding) => finding.caseId)).toEqual([
      'task-1--alpha--9',
      'task-1--alpha--10',
    ]);
    const nineIndex = markdown.indexOf('- Warning for alpha, attempt 9 on "task-1": ');
    const tenIndex = markdown.indexOf('- Warning for alpha, attempt 10 on "task-1": ');
    expect(nineIndex).toBeGreaterThan(-1);
    expect(tenIndex).toBeGreaterThan(-1);
    expect(nineIndex).toBeLessThan(tenIndex);
  });

  it('lists distinct (taskId, timeoutMs) pairs that differ from the default, sorted by task ID then by timeoutMs ascending, independent of manifest.cases order (R-13, R-10)', () => {
    const buildManifestWithCases = (cases: CaseIdentity[]): RunManifest => ({
      schemaVersion: 1,
      runId: '20260101t000000z-case-timeouts',
      configDigest: 'sha256-case-timeouts-digest',
      configPath: '/synthetic/tevu.yaml',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
      host: { platform: 'linux', nodeVersion: 'v24.21.0' },
      tools: {
        gitVersion: 'git version 2.45.0',
        agentVersions: {},
        agentConfigurationFiles: {},
        copiedProviders: {},
      },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 1, source: 'config' } },
      efforts: buildEfforts(),
      cases,
    });
    const buildInputWithCases = (cases: CaseIdentity[]): ReportInput => ({
      run: {
        schemaVersion: 1,
        manifest: buildManifestWithCases(cases),
        cases: [],
        findings: [],
        exitCode: 0,
      },
      capabilities: {},
      tasks: [],
      models: [],
      repositories: [],
      assessments: [],
      gradings: [],
    });
    const identities = [
      buildCaseIdentity({ caseId: 'task-a--alpha--1', taskId: 'task-a', timeoutMs: 3000 }),
      buildCaseIdentity({
        caseId: 'task-a--alpha--2',
        taskId: 'task-a',
        attempt: 2,
        timeoutMs: 2000,
      }),
      buildCaseIdentity({ caseId: 'task-b--alpha--1', taskId: 'task-b', timeoutMs: 500 }),
    ];

    const markdown = buildReport(buildInputWithCases(identities)).markdown;
    const reversedMarkdown = buildReport(buildInputWithCases([...identities].reverse())).markdown;

    expect(markdown).toContain(
      '- Tasks with their own case timeout: "task-a" 2000ms, "task-a" 3000ms, "task-b" 500ms',
    );
    expect(reversedMarkdown).toBe(markdown);
  });

  it('omits the "Tasks with their own case timeout" line when every case shares the default timeout', () => {
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: '20260101t000000z-no-task-timeouts',
      configDigest: 'sha256-no-task-timeouts-digest',
      configPath: '/synthetic/tevu.yaml',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
      host: { platform: 'linux', nodeVersion: 'v24.21.0' },
      tools: {
        gitVersion: 'git version 2.45.0',
        agentVersions: {},
        agentConfigurationFiles: {},
        copiedProviders: {},
      },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 1, source: 'config' } },
      efforts: buildEfforts(),
      cases: [
        buildCaseIdentity({ caseId: 'task-a--alpha--1', taskId: 'task-a', timeoutMs: 1000 }),
        buildCaseIdentity({ caseId: 'task-b--alpha--1', taskId: 'task-b', timeoutMs: 1000 }),
      ],
    };
    const input: ReportInput = {
      run: { schemaVersion: 1, manifest, cases: [], findings: [], exitCode: 0 },
      capabilities: {},
      tasks: [],
      models: [],
      repositories: [],
      assessments: [],
      gradings: [],
    };

    const markdown = buildReport(input).markdown;

    expect(markdown).not.toContain('Tasks with their own case timeout');
  });

  it('regenerates byte-identical normalized JSON and Markdown from unchanged source artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-regen-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const digestsBefore = await collectSourceDigests(root, runId);

      const first = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(first.ok).toBe(true);
      const digestsAfterFirst = await collectSourceDigests(root, runId);
      const second = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(second.ok).toBe(true);
      const digestsAfterSecond = await collectSourceDigests(root, runId);

      if (!first.ok || !second.ok) return;
      expect(second.value.normalizedJson).toBe(first.value.normalizedJson);
      expect(second.value.markdown).toBe(first.value.markdown);
      expect(JSON.parse(first.value.normalizedJson)).toMatchObject({ schemaVersion: 1 });
      expect(first.value.normalizedJson.endsWith('\n')).toBe(true);
      expect(digestsAfterFirst).toEqual(digestsBefore);
      expect(digestsAfterSecond).toEqual(digestsBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a run whose configuration snapshot is in the previous layout, before any write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-previous-layout-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const runJsonPath = join(root, 'artifacts', runId, 'run.json');
      const before = await readFile(runJsonPath, 'utf8');
      const stored = JSON.parse(before) as {
        manifest: { context: { config: Record<string, unknown> } };
      };
      const { models, ...configWithoutModels } = stored.manifest.context.config;
      stored.manifest.context.config = { ...configWithoutModels, contenders: models };
      await writeFile(runJsonPath, JSON.stringify(stored, null, 2), 'utf8');
      const corrupted = await readFile(runJsonPath, 'utf8');
      const reportPath = join(root, 'artifacts', runId, 'report.md');

      const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ArtifactError',
          operation: 'decode-run-configuration',
          reason:
            'run configuration snapshot does not match the current configuration layout at models',
        },
      });
      expect(await readFile(runJsonPath, 'utf8')).toBe(corrupted);
      expect(existsSync(reportPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a run whose case names an agent with no registered adapter, before any write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-unregistered-agent-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const resultPath = caseFile(root, runId, 'task-1--alpha--1', 'result.json');
      const before = await readFile(resultPath, 'utf8');
      const stored = JSON.parse(before) as { identity: Record<string, unknown> };
      stored.identity['agent'] = 'ghost-agent';
      await writeFile(resultPath, JSON.stringify(stored, null, 2), 'utf8');
      const corrupted = await readFile(resultPath, 'utf8');
      const reportPath = join(root, 'artifacts', runId, 'report.md');

      const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ArtifactError',
          operation: 'rebuild-report',
          reason:
            'case "task-1--alpha--1" names agent "ghost-agent", which has no registered adapter',
        },
      });
      expect(await readFile(resultPath, 'utf8')).toBe(corrupted);
      expect(existsSync(reportPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a run whose manifest lacks execution.repeat, before any write (AC-12, verification property 10)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-no-repeat-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const runJsonPath = join(root, 'artifacts', runId, 'run.json');
      const before = await readFile(runJsonPath, 'utf8');
      const stored = JSON.parse(before) as { manifest: { execution: Record<string, unknown> } };
      delete stored.manifest.execution['repeat'];
      await writeFile(runJsonPath, JSON.stringify(stored, null, 2), 'utf8');
      const corrupted = await readFile(runJsonPath, 'utf8');
      const reportPath = join(root, 'artifacts', runId, 'report.md');

      const manifestResult = await store.readRunManifest(runId);
      const runResult = await store.readRunResult(runId);
      const rebuilt = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(manifestResult.ok).toBe(false);
      expect(runResult.ok).toBe(false);
      expect(rebuilt.ok).toBe(false);
      expect(await readFile(runJsonPath, 'utf8')).toBe(corrupted);
      expect(existsSync(reportPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a case result missing identity.attempt, before any write (AC-12, verification property 10)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-no-attempt-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const resultPath = caseFile(root, runId, 'task-1--alpha--1', 'result.json');
      const before = await readFile(resultPath, 'utf8');
      const stored = JSON.parse(before) as { identity: Record<string, unknown> };
      delete stored.identity['attempt'];
      await writeFile(resultPath, JSON.stringify(stored, null, 2), 'utf8');
      const corrupted = await readFile(resultPath, 'utf8');

      const result = await store.readCaseResult(runId, 'task-1--alpha--1');

      expect(result.ok).toBe(false);
      expect(await readFile(resultPath, 'utf8')).toBe(corrupted);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns ArtifactError and creates no run directory for a manifest whose execution.repeat fails isRepeatSetting (verification property 11)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-bad-repeat-'));
    try {
      const records = buildSyntheticRecords();
      const store = createArtifactStore({
        artifactsDirectory: join(root, 'artifacts'),
        redact: (text) => text,
      });
      const manifest: RunManifest = {
        ...records.manifest,
        runId: '20260101t000000z-bad-repeat',
        execution: { ...records.manifest.execution, repeat: { value: 0, source: 'cli' } },
      };

      const result = await store.startRun(manifest);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ArtifactError',
          operation: 'start-run',
          reason:
            'run manifest execution.repeat must be a whole number of at least 1 with source "config" or "cli"',
        },
      });
      expect(existsSync(join(root, 'artifacts', manifest.runId))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recomputes outcomes from current assessments while history stays evidence-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-assess-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const rebuilt = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;

      const alpha = await store.readCaseResult(runId, 'task-1--alpha--1');
      expect(alpha.ok).toBe(true);
      if (!alpha.ok) return;
      expect(alpha.value.outcome).toBe('passed');
      expect(
        alpha.value.checks.find((check) => check.checkId === 'dod-manual-review'),
      ).toMatchObject({
        verdict: 'passed',
      });
      expect(
        alpha.value.checks.find((check) => check.checkId === 'dod-manual-review')?.evidence,
      ).toContain('manually assessed by curator');
      expect(
        alpha.value.checks.find((check) => check.checkId === 'man-optional-polish')?.verdict,
      ).toBe('pending');

      const beta = await store.readCaseResult(runId, 'task-1--beta--1');
      expect(beta.ok).toBe(true);
      if (!beta.ok) return;
      expect(beta.value.outcome).toBe('failed');
      expect(beta.value.failure?.error.kind).toBe('AgentProcessError');

      const gamma = await store.readCaseResult(runId, 'task-2--gamma--1');
      expect(gamma.ok).toBe(true);
      if (!gamma.ok) return;
      expect(gamma.value.outcome).toBe('not-evaluated');
      expect(gamma.value.checks).toEqual([]);

      const run = await store.readRunResult(runId);
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.value.exitCode).toBe(2);

      const assessment = await store.readAssessment(runId, 'task-1--alpha--1');
      expect(assessment.ok).toBe(true);
      if (!assessment.ok) return;
      expect(assessment.value?.current).toHaveLength(1);
      expect(assessment.value?.history).toHaveLength(1);
      expect(rebuilt.value.normalizedJson).toContain('needs rework');
      expect(rebuilt.value.markdown).not.toContain('needs rework');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists the regenerated normalized result.json and report.md at the run root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-write-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const rebuilt = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;
      expect(rebuilt.value.runId).toBe(runId);

      const normalizedOnDisk = await readFile(
        join(root, 'artifacts', runId, 'result.json'),
        'utf8',
      );
      const markdownOnDisk = await readFile(join(root, 'artifacts', runId, 'report.md'), 'utf8');
      expect(normalizedOnDisk).toBe(rebuilt.value.normalizedJson);
      expect(markdownOnDisk).toBe(rebuilt.value.markdown);
      expect(JSON.parse(normalizedOnDisk)).toMatchObject({ schemaVersion: 1, manifest: { runId } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders provenance, isolation capability, availability reasons, and omits forbidden bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-render-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const rebuilt = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;
      const markdown = rebuilt.value.markdown;

      expect(markdown).toContain(
        `Agent "${AGENT_NAME}" version (detected provenance only): 9.9.9-synthetic`,
      );
      expect(markdown).toContain(
        `Agent "${AGENT_NAME}" isolation control (deny outside worktree): unavailable`,
      );
      expect(markdown).toContain('Configuration digest: `sha256-synthetic-digest`');
      expect(markdown).toContain('Run exit code: 2');
      expect(markdown).toContain('No composite score or winner is computed.');
      expect(markdown).toContain('**Sensitive data:**');
      expect(markdown).toContain('non-adversarial');

      expect(markdown.indexOf('## Task: Synthetic welcome-route task')).toBeLessThan(
        markdown.indexOf('## Task: Synthetic imported task'),
      );
      expect(markdown).toContain(
        '| [vendor/model-alpha-synth, effort-high](#case-task-1--alpha--1) | passed | 2/2 passed | none | 1.5 s |',
      );
      expect(
        markdown.indexOf(
          '| [vendor/model-alpha-synth, effort-high](#case-task-1--alpha--1) | passed |',
        ),
      ).toBeLessThan(
        markdown.indexOf(
          '| [vendor/model-alpha-synth, effort-low](#case-task-1--beta--1) | failed |',
        ),
      );
      expect(markdown).toContain(
        '- Source: imported from Jira issue [TEVU-999](https://jira.example.com/browse/TEVU-999)',
      );

      expect(markdown).toContain(
        '| [vendor/model-alpha-synth, effort-low](#case-task-1--beta--1) | failed | 0/2 passed, 1 failed, 1 not run | agent process failed | 0.9 s |',
      );
      expect(markdown).toContain(
        '| [vendor/model-gamma-synth, effort-high](#case-task-2--gamma--1) | not-evaluated | 0/2 passed, 2 not run | time limit reached | 42.0 s |',
      );

      expect(markdown).toContain('\n- API errors: 1\n');
      expect(markdown).toContain(
        '- Not measured: Cost, Turns, API calls, Input tokens, Cache read tokens, Cache write tokens, Output tokens, Reasoning tokens. tevu has no value for these measurements.',
      );
      expect(markdown).toContain(
        'Technical detail: the preserved case artifacts contain no session export\n',
      );
      expect(markdown).toContain('\n- Skill calls: 1\n');
      expect(markdown).toContain('\n- Elapsed: 42.0 s\n');

      expect(markdown).toContain('Assessments (revision 2):');
      expect(markdown).toContain(
        '- manual Definition of Done review: passed by curator at 2026-09-23T01:00:00.000Z; note: confirmed by reviewer',
      );
      expect(markdown).toContain(
        "1 optional manual check waits for a person's verdict. Optional checks do not change the outcome, which stays passed.",
      );

      expect(markdown).not.toContain(TASK_PROMPT_BODY);
      expect(markdown).not.toContain(JIRA_SUMMARY);
      expect(markdown).not.toContain(JIRA_DESCRIPTION);
      expect(markdown).not.toContain(TRANSCRIPT_BODY);
      expect(markdown).not.toContain(PATCH_BODY);

      expect(rebuilt.value.normalizedJson).not.toContain(TRANSCRIPT_BODY);

      const sessionOnDisk = await readFile(
        caseFile(root, runId, 'task-1--alpha--1', 'session.json'),
        'utf8',
      );
      expect(sessionOnDisk).toContain(TRANSCRIPT_BODY);
      const patchOnDisk = await readFile(
        caseFile(root, runId, 'task-1--alpha--1', 'solution.patch'),
        'utf8',
      );
      expect(patchOnDisk).toContain(PATCH_BODY);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redacts credential secrets at every designated sink while preserving source evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-redact-'));
    try {
      const { runId, store } = await createSyntheticRun(root);

      const rawEvents = await readFile(
        caseFile(root, runId, 'task-1--alpha--1', 'events.jsonl'),
        'utf8',
      );
      expect(rawEvents).not.toContain(PROVIDER_SECRET);
      expect(rawEvents).toContain('[REDACTED]');
      for (const line of rawEvents.trim().split('\n')) {
        JSON.parse(line);
      }

      const diagnostics = await readFile(
        caseFile(root, runId, 'task-1--alpha--1', 'stderr.log'),
        'utf8',
      );
      expect(diagnostics).toContain('[REDACTED]');
      expect(diagnostics).not.toContain(PROVIDER_SECRET);

      const events = await store.readEvents(runId, 'task-1--alpha--1');
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      expect(events.value).toHaveLength(9);
      expect(JSON.stringify(events.value)).not.toContain(PROVIDER_SECRET);
      expect(events.value[0]).toMatchObject({ kind: 'tool' });

      const sessionExport = await store.readSessionExport(runId, 'task-1--alpha--1');
      expect(sessionExport.ok).toBe(true);
      if (!sessionExport.ok) return;
      // The store persists an opaque record; this fixture's own shape is
      // known here only because the test constructed it.
      expect((sessionExport.value as { rootSessionId?: unknown } | null)?.rootSessionId).toBe(
        'ses-root-0001',
      );
      expect(JSON.stringify(sessionExport.value)).toContain('additiveTopLevelField');

      const checks = await store.readChecks(runId, 'task-1--alpha--1');
      expect(checks.ok).toBe(true);
      if (!checks.ok) return;
      expect(checks.value).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('aborts writes and raises ArtifactError when redaction fails instead of sinking unredacted text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-failclosed-'));
    try {
      const records = buildSyntheticRecords();

      const failingStore = createArtifactStore({
        artifactsDirectory: join(root, 'artifacts'),
        redact: (text) => {
          if (text.includes('additive')) {
            throw new Error('synthetic redaction failure');
          }
          return text;
        },
      });
      const started = await failingStore.startRun(
        buildManifest('20260923t010000z-redact', records.config, records.capabilities, [
          'task-1--alpha--1',
        ]),
      );
      expect(started.ok).toBe(true);

      const attempt = await failingStore.writeSessionExport(
        'task-1--alpha--1',
        records.exportRecord,
      );
      expect(attempt.ok).toBe(false);
      if (attempt.ok) return;
      expect(attempt.error.kind).toBe('ArtifactError');
      expect(attempt.error.reason).toContain('redaction failed');
      expect(
        existsSync(caseFile(root, '20260923t010000z-redact', 'task-1--alpha--1', 'session.json')),
      ).toBe(false);

      const nonStringStore = createArtifactStore({
        artifactsDirectory: join(root, 'artifacts'),
        redact: ((text: string) => (text.includes('"checkId"') ? 42 : text)) as unknown as (
          text: string,
        ) => string,
      });
      const nonStringRun = await nonStringStore.startRun(
        buildManifest('20260923t010000z-redact2', records.config, records.capabilities, [
          'task-1--alpha--1',
        ]),
      );
      expect(nonStringRun.ok).toBe(true);
      const nonStringWrite = await nonStringStore.writeChecks('task-1--alpha--1', [
        buildCheckResult({ checkId: 'acc-acceptance-command' }),
      ]);
      expect(nonStringWrite.ok).toBe(false);
      if (nonStringWrite.ok) return;
      expect(nonStringWrite.error.reason).toContain('redaction returned no text');
      expect(
        existsSync(caseFile(root, '20260923t010000z-redact2', 'task-1--alpha--1', 'checks.json')),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('comparison table in the report', () => {
  type ResultOverrides = Partial<Omit<CaseResult, 'identity' | 'metrics'>> & {
    metrics?: Partial<BenchmarkMetrics>;
  };

  type ComparisonOptions = {
    models?: readonly ModelRecord[];
    taskIds?: readonly string[];
    tasks?: readonly TaskRecord[];
    /** The agent of each model entry's cases; entries not listed use the fixture agent. */
    agents?: Readonly<Record<string, string>>;
    repeat?: number;
    /** Returns `null` for an attempt whose case result was never saved. */
    results?: (identity: CaseIdentity) => ResultOverrides | null;
    gradings?: readonly GradingArtifact[];
    efforts?: RunManifest['efforts'];
  };

  type FailureKind = 'AgentProcessError' | 'CaseTimeoutError';

  const NOTICE_START = '> **Sensitive data:**';
  const HEADER_ROW =
    '| Model | Effort | Outcome | Required checks | Elapsed | Cost | Turns | Tool calls | Input | Cache read | Cache write | Output | Reasoning | API errors | Runtime failure |';
  const SEPARATOR_ROW = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const FIRST_MARKER = '\\[1\\]';
  const NO_CASE_RESULT = 'no case result was saved';
  const MEASUREMENT_COLUMNS = [
    'Elapsed',
    'Cost',
    'Turns',
    'Tool calls',
    'Input',
    'Cache read',
    'Cache write',
    'Output',
    'Reasoning',
    'API errors',
  ];

  function buildModelRecord(overrides: Partial<ModelRecord> = {}): ModelRecord {
    return { id: 'alpha', model: 'vendor/model-alpha-synth', effort: 'effort-high', ...overrides };
  }

  /** The distinct title each comparison fixture task carries, so no task name takes a position suffix. */
  function taskTitleOf(taskId: string): string {
    return `Task ${taskId}`;
  }

  const SETTING = 'vendor/model-alpha-synth, effort-high';

  /** The measurement-gap statement of spec 3.3.2 for one measurement, rendered with its technical detail. */
  function gapText(detail: string, options: { graderLine?: boolean } = {}): string {
    const source = options.graderLine === true ? ' of its grading' : '';
    return `tevu has no value for this measurement${source}. It is unknown, not zero. This run's saved files cannot supply it; to measure it, fix the cause in the technical detail and run the comparison again. Technical detail: ${detail}`;
  }

  /** The no-result statement of spec 3.3.2, rendered with its technical detail. */
  function noResultText(caseId: string): string {
    return `tevu saved no result for this attempt. It has no outcome or measurements, so it counts as not evaluated. Run the comparison again to get a result for this attempt. Technical detail: case ${caseId}: ${NO_CASE_RESULT}`;
  }

  const SEPARATION_NOTE_START = 'Every model setting ';

  /** The separation note of spec 3.2 for one task, as it renders in the block. */
  function separationNote(
    outcome: 'passed' | 'failed',
    options: { task?: string; settings?: string; repeat?: number } = {},
  ): string {
    const {
      task = taskTitleOf('task-1'),
      settings = 'vendor/model-alpha-synth, effort-high; vendor/model-beta-synth, effort-high',
      repeat = 1,
    } = options;
    const attempts = repeat > 1 ? ' in every attempt' : '';
    const cannotTellApart =
      'The outcomes cannot tell the settings apart on this task, and a difference in time or cost does not show which setting produces the better solution';
    const moreAttempts =
      'To tell the settings apart, run more attempts with `run.repeat` or `--repeat`,';
    return outcome === 'passed'
      ? `Every model setting passed every required check of "${task}"${attempts}: ${settings}. ${cannotTellApart}. ${moreAttempts} compare them on a harder task, or add checks that capture more of what a good solution does.`
      : `Every model setting failed at least one required check of "${task}"${attempts}: ${settings}. ${cannotTellApart}; the Required checks column still shows how many required checks each setting passed. ${moreAttempts} compare them on an easier task, or confirm in the attempt sections below that a correct solution can pass the failed checks.`;
  }

  function separationNotesOf(
    markdown: string,
    taskId: string,
    title = taskTitleOf(taskId),
  ): string[] {
    return comparisonBlock(markdown, taskId, title).filter((line) =>
      line.startsWith(SEPARATION_NOTE_START),
    );
  }

  function markers(...numbers: number[]): string {
    return numbers.map((number) => `\\[${number}\\]`).join(' ');
  }

  /** Entries that differ in model, so no Model cell carries an entry ID suffix. */
  function buildDistinctModels(ids: readonly string[]): ModelRecord[] {
    return ids.map((id) => buildModelRecord({ id, model: `vendor/model-${id}-synth` }));
  }

  function linkTo(taskId: string, modelId: string, attempt = 1): string {
    return `[vendor/model-${modelId}-synth](#case-${taskId}--${modelId}--${attempt})`;
  }

  function reported(value: number, unit: MetricValue['unit']): MetricValue {
    return {
      value,
      unit,
      availability: { status: 'available', source: 'root-session export' },
      scope: unit === 'millisecond' ? 'case' : 'root-session',
    };
  }

  function availableWithoutValue(unit: MetricValue['unit']): MetricValue {
    return { ...reported(0, unit), value: null };
  }

  function byAttempt<T>(identity: CaseIdentity, values: readonly T[]): T {
    const value = values[identity.attempt - 1];
    if (value === undefined) {
      throw new Error(`no value for attempt ${identity.attempt}`);
    }
    return value;
  }

  function buildFailure(kind: FailureKind, caseId: string): FailureRecord {
    const occurredAt = '2026-09-23T00:00:00.950Z';
    return kind === 'AgentProcessError'
      ? { error: { kind, agent: AGENT_NAME, caseId, exitCode: 1, signal: null }, occurredAt }
      : { error: { kind, caseId, timeoutMs: 60_000 }, occurredAt };
  }

  function passedChecks(checkIds: readonly string[]): CheckResult[] {
    return checkIds.map((checkId) => buildCheckResult({ checkId }));
  }

  function buildComparisonInput(options: ComparisonOptions = {}): ReportInput {
    const {
      models = [buildModelRecord()],
      taskIds = ['task-1'],
      repeat = 1,
      results = (): ResultOverrides => ({}),
      gradings = [],
    } = options;
    const identities = taskIds.flatMap((taskId) =>
      models.flatMap((entry) =>
        Array.from({ length: repeat }, (_, index) =>
          buildCaseIdentity({
            caseId: `${taskId}--${entry.id}--${index + 1}`,
            taskId,
            modelId: entry.id,
            attempt: index + 1,
            model: entry.model,
            effort: entry.effort,
            agent: options.agents?.[entry.id] ?? AGENT_NAME,
          }),
        ),
      ),
    );
    const defaultMetrics: BenchmarkMetrics = {
      elapsed: reported(1500, 'millisecond'),
      ...buildAgentMetrics(),
    };
    const cases = identities.flatMap((identity) => {
      const overrides = results(identity);
      if (overrides === null) {
        return [];
      }
      const { metrics, ...rest } = overrides;
      return [
        buildCaseResult({
          identity,
          artifacts: buildArtifactIndex(identity.caseId, new Set(['result'])),
          metrics: { ...defaultMetrics, ...metrics },
          ...rest,
        }),
      ];
    });
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: '20260923t000000z-comparison',
      configDigest: 'sha256-comparison-digest',
      configPath: '/synthetic/tevu.yaml',
      startedAt: '2026-09-23T00:00:00.000Z',
      completedAt: '2026-09-23T00:05:00.000Z',
      host: { platform: 'linux', nodeVersion: 'v24.21.0' },
      tools: {
        gitVersion: 'git version 2.45.0',
        agentVersions: { [AGENT_NAME]: null },
        agentConfigurationFiles: {},
        copiedProviders: {},
      },
      execution: {
        concurrency: 1,
        caseTimeoutMs: 60_000,
        repeat: { value: repeat, source: 'config' },
      },
      efforts: options.efforts ?? buildEfforts(models.map((entry) => entry.id)),
      cases: identities,
    };
    return {
      run: { schemaVersion: 1, manifest, cases, findings: [], exitCode: 0 },
      capabilities: {},
      tasks:
        options.tasks ??
        taskIds.map((taskId) => buildTaskRecord({ id: taskId, title: taskTitleOf(taskId) })),
      models,
      repositories: [],
      assessments: [],
      gradings,
    };
  }

  /** The lines of one comparison block, from its heading through its closing empty line. */
  function comparisonBlock(
    markdown: string,
    taskId: string,
    title = taskTitleOf(taskId),
  ): string[] {
    const lines = markdown.split('\n');
    const start = lines.indexOf(`## Comparison: ${title}`);
    if (start === -1) {
      throw new Error(`no comparison block for ${taskId}`);
    }
    const length = lines
      .slice(start + 1)
      .findIndex((line) => line.startsWith('## ') || line.startsWith(NOTICE_START));
    return lines.slice(start, start + 1 + length);
  }

  function footnotesOf(markdown: string, taskId: string, title = taskTitleOf(taskId)): string[] {
    return comparisonBlock(markdown, taskId, title).filter((line) => /^\d+\. /.test(line));
  }

  function splitRow(line: string): string[] {
    return line.slice(2, -2).split(' | ');
  }

  function comparisonRows(
    markdown: string,
    taskId = 'task-1',
    title = taskTitleOf(taskId),
  ): Record<string, string>[] {
    const [header, , ...rows] = comparisonBlock(markdown, taskId, title).filter((line) =>
      line.startsWith('|'),
    );
    if (header === undefined) {
      throw new Error(`no table in the comparison block of ${taskId}`);
    }
    const columns = splitRow(header);
    return rows.map((row) =>
      Object.fromEntries(
        splitRow(row).map((value, index) => [columns[index] ?? `column ${index}`, value]),
      ),
    );
  }

  function comparisonRow(
    markdown: string,
    taskId = 'task-1',
    title = taskTitleOf(taskId),
  ): Record<string, string> {
    const [row] = comparisonRows(markdown, taskId, title);
    if (row === undefined) {
      throw new Error(`no row in the comparison block of ${taskId}`);
    }
    return row;
  }

  function reportOf(options: ComparisonOptions = {}): string {
    return buildReport(buildComparisonInput(options)).markdown;
  }

  describe('layout', () => {
    it('opens with the title, then one block per task in task ID order, ahead of the notice', () => {
      const input = buildComparisonInput({ taskIds: ['task-2', 'task-1'] });

      const lines = buildReport(input).markdown.split('\n');

      const noticeIndex = lines.findIndex((line) => line.startsWith(NOTICE_START));
      expect(lines.slice(0, 3)).toEqual([
        `# tevu run ${input.run.manifest.runId}`,
        '',
        '## Comparison: Task task-1',
      ]);
      expect(lines.filter((line) => line.startsWith('## '))).toEqual([
        '## Comparison: Task task-1',
        '## Comparison: Task task-2',
        '## Run',
        '## Task: Task task-1',
        '## Task: Task task-2',
      ]);
      expect(lines[noticeIndex - 1]).toBe('');
      expect(lines[noticeIndex - 2]).toMatch(/^\| /);
    });

    it('renders no block when the run plans no case', () => {
      const input = buildComparisonInput({ taskIds: [] });

      const markdown = buildReport(input).markdown;

      expect(markdown).not.toContain('## Comparison');
      expect(markdown.startsWith(`# tevu run ${input.run.manifest.runId}\n\n${NOTICE_START}`)).toBe(
        true,
      );
    });

    it.each(['task-1', 'task-2'])(
      'renders the fixed header and separator rows in the block of %s',
      (taskId) => {
        const markdown = reportOf({ taskIds: ['task-1', 'task-2'] });

        const block = comparisonBlock(markdown, taskId);

        expect(block.slice(2, 4)).toEqual([HEADER_ROW, SEPARATOR_ROW]);
      },
    );

    it('renders every column of a fully reported row in column order', () => {
      const markdown = reportOf({
        results: () => ({
          checks: [
            buildCheckResult({ checkId: 'acc-acceptance-command' }),
            buildCheckResult({
              checkId: 'dod-manual-review',
              category: 'definition-of-done',
            }),
          ],
        }),
      });

      const block = comparisonBlock(markdown, 'task-1');

      expect(block).toEqual([
        '## Comparison: Task task-1',
        '',
        HEADER_ROW,
        SEPARATOR_ROW,
        '| [vendor/model-alpha-synth](#case-task-1--alpha--1) | effort-high | passed | 2/2 passed | 1.5 s | $0.0125 | 1 | 2 | 130 | 30 | 10 | 45 | 16 | 1 | none |',
        '',
      ]);
    });

    it('shows the effort check status in the Effort cell', () => {
      const models = buildDistinctModels(['alpha', 'beta', 'gamma', 'delta']);
      const efforts: RunManifest['efforts'] = {
        models: {
          alpha: { status: 'verified' },
          beta: { status: 'unverified', reason: 'no variant data was reported' },
          gamma: { status: 'unsupported', reason: 'the model has no variants' },
        },
        grader: null,
      };

      const rows = comparisonRows(reportOf({ models, efforts }));

      expect(rows.map((row) => row['Effort'])).toEqual([
        'effort-high',
        'effort-high, unverified',
        'effort-high, unsupported',
        'effort-high, not checked',
      ]);
    });

    it('escapes table-breaking characters in model text and footnote text', () => {
      const models = [buildModelRecord({ model: 'vendor/odd|model' })];

      const markdown = reportOf({
        models,
        results: () => ({ metrics: { cost: unavailableMetric('USD', 'upstream said a|b') } }),
      });

      expect(comparisonRow(markdown)['Model']).toBe('[vendor/odd\\|model](#case-task-1--alpha--1)');
      expect(footnotesOf(markdown, 'task-1')).toEqual([
        `1. vendor/odd\\|model, effort-high: ${gapText('upstream said a\\|b')}`,
      ]);
    });

    it('escapes brackets and backslashes in linked model text so the link stays intact', () => {
      const models = [buildModelRecord({ model: 'vendor/odd]model[\\x' })];

      const markdown = reportOf({ models });

      expect(comparisonRow(markdown)['Model']).toBe(
        '[vendor/odd\\]model\\[\\\\x](#case-task-1--alpha--1)',
      );
    });
  });

  describe('Model cell', () => {
    it('links a row with a case result to its case section and leaves a row without one as plain text', () => {
      const models = buildDistinctModels(['alpha', 'beta']);

      const markdown = reportOf({
        models,
        results: (identity) => (identity.modelId === 'beta' ? null : {}),
      });

      expect(comparisonRows(markdown).map((row) => row['Model'])).toEqual([
        linkTo('task-1', 'alpha'),
        'vendor/model-beta-synth',
      ]);
      expect(markdown).toContain(
        '<a id="case-task-1--alpha--1"></a>\n\n### vendor/model-alpha-synth, effort-high\n',
      );
    });

    it('links to the lowest attempt that has a case result', () => {
      const markdown = reportOf({
        repeat: 2,
        results: (identity) => (identity.attempt === 1 ? null : {}),
      });

      expect(comparisonRow(markdown)['Model']).toBe(
        '[vendor/model-alpha-synth](#case-task-1--alpha--2)',
      );
      expect(markdown).toContain(
        '<a id="case-task-1--alpha--2"></a>\n\n### vendor/model-alpha-synth, effort-high, attempt 2\n',
      );
    });

    it('appends the shared agent and the position, inside the link text, to rows that share model, effort, and agent', () => {
      const models = [
        buildModelRecord({ id: 'alpha' }),
        buildModelRecord({ id: 'beta', effort: 'effort-low' }),
        buildModelRecord({ id: 'delta' }),
      ];

      const rows = comparisonRows(reportOf({ models }));

      expect(rows.map((row) => row['Model'])).toEqual([
        `[vendor/model-alpha-synth, ${AGENT_NAME} (1)](#case-task-1--alpha--1)`,
        '[vendor/model-alpha-synth](#case-task-1--beta--1)',
        `[vendor/model-alpha-synth, ${AGENT_NAME} (2)](#case-task-1--delta--1)`,
      ]);
    });

    it('tells rows that share model and effort apart by their agent alone when the agents differ', () => {
      const models = [buildModelRecord({ id: 'alpha' }), buildModelRecord({ id: 'delta' })];

      const markdown = reportOf({ models, agents: { alpha: 'agent-a', delta: 'agent-b' } });

      expect(comparisonRows(markdown).map((row) => row['Model'])).toEqual([
        '[vendor/model-alpha-synth, agent-a](#case-task-1--alpha--1)',
        '[vendor/model-alpha-synth, agent-b](#case-task-1--delta--1)',
      ]);
      expect(markdown).toContain('\n### vendor/model-alpha-synth, effort-high, agent-a\n');
      expect(markdown).toContain(
        '- vendor/model-alpha-synth, effort-high, agent-b: effort verified\n',
      );
    });

    it('drops every suffix once the efforts differ', () => {
      const models = [
        buildModelRecord({ id: 'alpha' }),
        buildModelRecord({ id: 'beta', effort: 'effort-low' }),
        buildModelRecord({ id: 'delta', effort: 'effort-medium' }),
      ];

      const rows = comparisonRows(reportOf({ models }));

      expect(rows.map((row) => row['Model'])).toEqual([
        '[vendor/model-alpha-synth](#case-task-1--alpha--1)',
        '[vendor/model-alpha-synth](#case-task-1--beta--1)',
        '[vendor/model-alpha-synth](#case-task-1--delta--1)',
      ]);
    });

    it('renders the suffixed text of a colliding row without a case result as plain text', () => {
      const models = [buildModelRecord({ id: 'alpha' }), buildModelRecord({ id: 'delta' })];

      const rows = comparisonRows(
        reportOf({ models, results: (identity) => (identity.modelId === 'delta' ? null : {}) }),
      );

      expect(rows.map((row) => row['Model'])).toEqual([
        `[vendor/model-alpha-synth, ${AGENT_NAME} (1)](#case-task-1--alpha--1)`,
        `vendor/model-alpha-synth, ${AGENT_NAME} (2)`,
      ]);
    });

    it('compares the raw effort, so a different effort check status does not remove the suffix', () => {
      const models = [buildModelRecord({ id: 'alpha' }), buildModelRecord({ id: 'delta' })];
      const efforts: RunManifest['efforts'] = {
        models: {
          alpha: { status: 'verified' },
          delta: { status: 'unverified', reason: 'no variant data was reported' },
        },
        grader: null,
      };

      const rows = comparisonRows(reportOf({ models, efforts }));

      expect(rows.map((row) => row['Model'])).toEqual([
        `[vendor/model-alpha-synth, ${AGENT_NAME} (1)](#case-task-1--alpha--1)`,
        `[vendor/model-alpha-synth, ${AGENT_NAME} (2)](#case-task-1--delta--1)`,
      ]);
      expect(rows.map((row) => row['Effort'])).toEqual(['effort-high', 'effort-high, unverified']);
    });
  });

  describe('row order', () => {
    const models = buildDistinctModels(['gamma', 'alpha', 'beta']);

    it.each(['task-1', 'task-2'])('lists the rows of %s in configuration order', (taskId) => {
      const input = buildComparisonInput({ models, taskIds: ['task-1', 'task-2'] });

      const markdown = buildReport(input).markdown;
      const reversed = buildReport({ ...input, models: [...models].reverse() }).markdown;

      expect(comparisonRows(markdown, taskId).map((row) => row['Model'])).toEqual([
        linkTo(taskId, 'gamma'),
        linkTo(taskId, 'alpha'),
        linkTo(taskId, 'beta'),
      ]);
      expect(comparisonRows(reversed, taskId).map((row) => row['Model'])).toEqual([
        linkTo(taskId, 'beta'),
        linkTo(taskId, 'alpha'),
        linkTo(taskId, 'gamma'),
      ]);
    });

    it('keeps the normalized JSON and every line outside the blocks unchanged when the order changes', () => {
      const input = buildComparisonInput({ models, taskIds: ['task-1', 'task-2'] });

      const original = buildReport(input);
      const reversed = buildReport({ ...input, models: [...models].reverse() });

      expect(reversed.normalizedJson).toBe(original.normalizedJson);
      expect(reversed.markdown.slice(reversed.markdown.indexOf(NOTICE_START))).toBe(
        original.markdown.slice(original.markdown.indexOf(NOTICE_START)),
      );
    });

    it('places entries missing from the configuration after the configured ones, in pair order', () => {
      const input = buildComparisonInput({ models });

      const markdown = buildReport({
        ...input,
        models: models.filter((entry) => entry.id === 'beta'),
      }).markdown;

      expect(comparisonRows(markdown).map((row) => row['Model'])).toEqual([
        linkTo('task-1', 'beta'),
        '[alpha](#case-task-1--alpha--1)',
        '[gamma](#case-task-1--gamma--1)',
      ]);
    });
  });

  describe('unavailable values and footnotes', () => {
    const REASON = 'the provider reported no cost';

    it('renders a measured zero as a number and an unavailable value as a dash with a footnote', () => {
      const models = buildDistinctModels(['alpha', 'beta', 'gamma']);

      const markdown = reportOf({
        models,
        results: ({ modelId }) => ({
          outcome: modelId === 'gamma' ? 'failed' : 'passed',
          metrics:
            modelId === 'alpha'
              ? { apiErrors: reported(0, 'count') }
              : modelId === 'beta'
                ? { cost: reported(0, 'USD') }
                : { cost: unavailableMetric('USD', REASON) },
        }),
      });

      const rows = comparisonRows(markdown);
      const block = comparisonBlock(markdown, 'task-1');
      expect(rows.map((row) => row['API errors'])).toEqual(['0', '1', '1']);
      expect(rows.map((row) => row['Cost'])).toEqual(['$0.0125', '$0.0000', `- ${FIRST_MARKER}`]);
      expect(block.slice(-3)).toEqual([
        '',
        `1. vendor/model-gamma-synth, effort-high: ${gapText(REASON)}`,
        '',
      ]);
      expect(block[block.length - 4]).toMatch(/^\| /);
    });

    it('reads an available metric without a value as no value recorded', () => {
      const markdown = reportOf({
        results: () => ({ metrics: { turns: availableWithoutValue('count') } }),
      });

      expect(comparisonRow(markdown)['Turns']).toBe(`- ${FIRST_MARKER}`);
      expect(footnotesOf(markdown, 'task-1')).toEqual([
        `1. ${SETTING}: ${gapText('no value recorded')}`,
      ]);
    });

    it('gives each attempt its own footnote even for an equal reason and restarts the numbering in each block', () => {
      const models = buildDistinctModels(['alpha', 'beta']);

      const markdown = reportOf({
        models,
        taskIds: ['task-1', 'task-2'],
        results: ({ taskId, modelId }) => {
          const cost = unavailableMetric('USD', 'cost was not reported');
          return taskId === 'task-1' && modelId === 'alpha'
            ? {
                metrics: {
                  cost,
                  elapsed: unavailableMetric('millisecond', 'elapsed was not recorded'),
                },
              }
            : { metrics: { cost } };
        },
      });

      const firstRows = comparisonRows(markdown, 'task-1');
      expect(firstRows.map((row) => row['Elapsed'])).toEqual([`- ${markers(1)}`, '1.5 s']);
      expect(firstRows.map((row) => row['Cost'])).toEqual([`- ${markers(2)}`, `- ${markers(3)}`]);
      expect(footnotesOf(markdown, 'task-1')).toEqual([
        `1. vendor/model-alpha-synth, effort-high: ${gapText('elapsed was not recorded')}`,
        `2. vendor/model-alpha-synth, effort-high: ${gapText('cost was not reported')}`,
        `3. vendor/model-beta-synth, effort-high: ${gapText('cost was not reported')}`,
      ]);
      expect(comparisonRows(markdown, 'task-2').map((row) => row['Cost'])).toEqual([
        `- ${markers(1)}`,
        `- ${markers(2)}`,
      ]);
      expect(footnotesOf(markdown, 'task-2')).toEqual([
        `1. vendor/model-alpha-synth, effort-high: ${gapText('cost was not reported')}`,
        `2. vendor/model-beta-synth, effort-high: ${gapText('cost was not reported')}`,
      ]);
    });

    it('shares one number between the cells of one attempt whose footnote texts are equal', () => {
      const unreported = unavailableMetric('count', 'the export was not saved');

      const markdown = reportOf({
        results: () => ({ metrics: { turns: unreported, apiCalls: unreported } }),
      });

      const row = comparisonRow(markdown);
      expect([row['Turns'], row['API errors']]).toEqual([`- ${markers(1)}`, '1']);
      expect(footnotesOf(markdown, 'task-1')).toEqual([
        `1. ${SETTING}: ${gapText('the export was not saved')}`,
      ]);
    });

    it('writes every marker with escaped brackets so a link reference definition in a task description cannot capture it', () => {
      const description = 'Imported issue text.\n\n[1]: https://example.com';
      const taskIds = ['task-1', 'task-2'];

      const markdown = reportOf({
        taskIds,
        tasks: taskIds.map((id) => buildTaskRecord({ id, description })),
        results: () => ({ metrics: { cost: unavailableMetric('USD', REASON) } }),
      });

      const blocks = markdown.slice(0, markdown.indexOf(NOTICE_START));
      expect(markdown).toContain('[1]: https://example.com');
      expect(blocks).toContain(FIRST_MARKER);
      expect(blocks).not.toMatch(/(?<!\\)\[\d+\]/);
    });
  });

  describe('value formats', () => {
    type FormatCase = {
      column: string;
      metric: keyof BenchmarkMetrics;
      unit: MetricValue['unit'];
      value: number;
      expected: string;
    };

    it.each<FormatCase>([
      { column: 'Turns', metric: 'turns', unit: 'count', value: 0, expected: '0' },
      { column: 'Turns', metric: 'turns', unit: 'count', value: 999, expected: '999' },
      { column: 'Turns', metric: 'turns', unit: 'count', value: 1000, expected: '1,000' },
      {
        column: 'Input',
        metric: 'inputTokens',
        unit: 'token',
        value: 1_234_567,
        expected: '1,234,567',
      },
      { column: 'Turns', metric: 'turns', unit: 'count', value: 1234.5, expected: '1234.5' },
      { column: 'Turns', metric: 'turns', unit: 'count', value: -5, expected: '-5' },
      { column: 'Cost', metric: 'cost', unit: 'USD', value: 0.0125, expected: '$0.0125' },
      { column: 'Cost', metric: 'cost', unit: 'USD', value: 0, expected: '$0.0000' },
      { column: 'Cost', metric: 'cost', unit: 'USD', value: 0.00004, expected: '$0.0000' },
      { column: 'Cost', metric: 'cost', unit: 'USD', value: 0.00005, expected: '$0.0001' },
      { column: 'Cost', metric: 'cost', unit: 'USD', value: 1.23, expected: '$1.2300' },
      { column: 'Elapsed', metric: 'elapsed', unit: 'millisecond', value: 0, expected: '0.0 s' },
      { column: 'Elapsed', metric: 'elapsed', unit: 'millisecond', value: 900, expected: '0.9 s' },
      {
        column: 'Elapsed',
        metric: 'elapsed',
        unit: 'millisecond',
        value: 59_949,
        expected: '59.9 s',
      },
      {
        column: 'Elapsed',
        metric: 'elapsed',
        unit: 'millisecond',
        value: 59_950,
        expected: '1.0 min',
      },
      {
        column: 'Elapsed',
        metric: 'elapsed',
        unit: 'millisecond',
        value: 522_000,
        expected: '8.7 min',
      },
      {
        column: 'Elapsed',
        metric: 'elapsed',
        unit: 'millisecond',
        value: 7_200_000,
        expected: '120.0 min',
      },
    ])(
      'renders $value in the $column column as $expected',
      ({ column, metric, unit, value, expected }) => {
        const markdown = reportOf({
          results: () => ({ metrics: { [metric]: reported(value, unit) } }),
        });

        expect(comparisonRow(markdown)[column]).toBe(expected);
      },
    );
  });

  describe('repeats', () => {
    const COST_REASON = 'the provider reported no cost';

    it('counts outcomes, takes the lower median, and marks a partly reported cost with its count', () => {
      const markdown = reportOf({
        repeat: 3,
        results: (identity) => ({
          outcome: byAttempt<CaseResult['outcome']>(identity, ['passed', 'failed', 'passed']),
          metrics: {
            elapsed: reported(byAttempt(identity, [120_000, 60_000, 90_000]), 'millisecond'),
            cost: byAttempt(identity, [
              reported(0.03, 'USD'),
              unavailableMetric('USD', COST_REASON),
              reported(0.01, 'USD'),
            ]),
          },
        }),
      });

      const row = comparisonRow(markdown);

      expect(row['Outcome']).toBe('2/3 passed, 1/3 failed');
      expect(row['Elapsed']).toBe('1.5 min');
      expect(row['Cost']).toBe(`$0.0100 (2/3) ${FIRST_MARKER}`);
      expect(row['Runtime failure']).toBe('none');
      expect(footnotesOf(markdown, 'task-1')).toEqual([
        `1. ${SETTING}, attempt 2: ${gapText(COST_REASON)}`,
      ]);
    });

    it('lists every outcome above zero in the fixed outcome order', () => {
      const markdown = reportOf({
        repeat: 4,
        results: (identity) => ({
          outcome: byAttempt<CaseResult['outcome']>(identity, [
            'not-evaluated',
            'pending',
            'failed',
            'passed',
          ]),
        }),
      });

      expect(comparisonRow(markdown)['Outcome']).toBe(
        '1/4 passed, 1/4 failed, 1/4 pending, 1/4 not-evaluated',
      );
    });

    it('lists the markers of every lacking attempt in attempt order, with the no-result footnote shared across cells', () => {
      const markdown = reportOf({
        repeat: 4,
        results: (identity) =>
          identity.attempt === 2
            ? null
            : {
                metrics: {
                  cost:
                    identity.attempt === 4
                      ? reported(0.0125, 'USD')
                      : unavailableMetric('USD', 'reason X'),
                },
              },
      });

      const row = comparisonRow(markdown);

      expect(row['Elapsed']).toBe(`1.5 s (3/4) ${markers(1)}`);
      expect(row['Cost']).toBe(`$0.0125 (1/4) ${markers(1, 2, 3)}`);
      expect(row['Runtime failure']).toBe(`none ${markers(1)}`);
      expect(footnotesOf(markdown, 'task-1')).toEqual([
        `1. ${SETTING}, attempt 2: ${noResultText('task-1--alpha--2')}`,
        `2. ${SETTING}, attempt 1: ${gapText('reason X')}`,
        `3. ${SETTING}, attempt 3: ${gapText('reason X')}`,
      ]);
    });
  });

  describe('Required checks cell', () => {
    function buildRequiredChecksTask(): TaskRecord {
      return buildTaskRecord({
        title: taskTitleOf('task-1'),
        checks: [
          ...['req-1', 'req-2', 'req-3', 'req-4', 'req-5', 'req-6'].map((id) =>
            buildCheckRecord({ id }),
          ),
          buildCheckRecord({ id: 'opt-1', required: false }),
        ],
      });
    }

    it('counts passed required checks across attempts and ignores optional and undefined checks', () => {
      const requiredIds = ['req-1', 'req-2', 'req-3', 'req-4', 'req-5', 'req-6'];

      const markdown = reportOf({
        repeat: 3,
        tasks: [buildRequiredChecksTask()],
        results: (identity) => ({
          checks: [
            ...passedChecks([...requiredIds.slice(0, 5), 'opt-1', 'undefined-check']),
            buildCheckResult({
              checkId: 'req-6',
              verdict: identity.attempt === 3 ? 'failed' : 'passed',
            }),
          ],
        }),
      });

      expect(comparisonRow(markdown)['Required checks']).toBe('17/18 passed, 1 failed');
    });

    it('adds nothing to the passed count for an attempt without a case result but keeps its required checks', () => {
      const markdown = reportOf({
        repeat: 2,
        results: (identity) =>
          identity.attempt === 2
            ? null
            : { checks: passedChecks(['acc-acceptance-command', 'dod-manual-review']) },
      });

      expect(comparisonRow(markdown)['Required checks']).toBe('2/4 passed, 2 not run');
    });
  });

  describe('Runtime failure cell', () => {
    it.each<{
      name: string;
      kinds: readonly (FailureKind | null)[];
      expected: string;
    }>([
      {
        name: 'one failed attempt',
        kinds: ['AgentProcessError'],
        expected: `agent process failed ${markers(1)}`,
      },
      { name: 'one attempt without a failure', kinds: [null], expected: 'none' },
      {
        name: 'one failure among three attempts',
        kinds: [null, 'AgentProcessError', null],
        expected: `1/3 agent process failed ${markers(1)}`,
      },
      { name: 'three attempts without a failure', kinds: [null, null, null], expected: 'none' },
      {
        name: 'two kinds across three attempts',
        kinds: ['CaseTimeoutError', 'AgentProcessError', 'AgentProcessError'],
        expected: `2/3 agent process failed, 1/3 time limit reached ${markers(1, 2, 3)}`,
      },
    ])('renders $expected for $name', ({ kinds, expected }) => {
      const markdown = reportOf({
        repeat: kinds.length,
        results: (identity) => {
          const kind = byAttempt(identity, kinds);
          return { failure: kind === null ? null : buildFailure(kind, identity.caseId) };
        },
      });

      expect(comparisonRow(markdown)['Runtime failure']).toBe(expected);
    });

    it('ends with a space and the marker when some attempts have no case result', () => {
      const markdown = reportOf({
        repeat: 3,
        results: (identity) =>
          identity.attempt === 3
            ? null
            : {
                failure:
                  identity.attempt === 1
                    ? buildFailure('AgentProcessError', identity.caseId)
                    : null,
              },
      });

      expect(comparisonRow(markdown)['Runtime failure']).toBe(
        `1/3 agent process failed ${markers(1, 2)}`,
      );
      expect(footnotesOf(markdown, 'task-1')).toEqual([
        `1. ${SETTING}, attempt 3: ${noResultText('task-1--alpha--3')}`,
        `2. ${SETTING}, attempt 1: The agent process stopped with an error. Its solution was still checked, so the outcome comes from its checks. Read the attempt's diagnostics log to find out why. Technical detail: case task-1--alpha--1: AgentProcessError, exit code 1, signal none`,
      ]);
    });
  });

  describe('attempts without a case result', () => {
    it('marks every measurement and the runtime failure of ten planned attempts with a shared footnote', () => {
      const markdown = reportOf({
        repeat: 10,
        tasks: [buildTaskRecord({ title: taskTitleOf('task-1'), checks: [] })],
        results: () => null,
      });

      const row = comparisonRow(markdown);

      const allTen = markers(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
      expect(row['Model']).toBe('vendor/model-alpha-synth');
      expect(row['Outcome']).toBe(`10/10 not-evaluated ${allTen}`);
      expect(row['Required checks']).toBe('0/0 passed');
      expect([...MEASUREMENT_COLUMNS, 'Runtime failure'].map((column) => row[column])).toEqual(
        Array.from({ length: MEASUREMENT_COLUMNS.length + 1 }, () => `- ${allTen}`),
      );
      expect(footnotesOf(markdown, 'task-1')).toEqual(
        Array.from(
          { length: 10 },
          (_, index) =>
            `${index + 1}. ${SETTING}, attempt ${index + 1}: ${noResultText(`task-1--alpha--${index + 1}`)}`,
        ),
      );
    });

    it('names the single planned attempt of a row without a case result in its footnote', () => {
      const markdown = reportOf({ results: () => null });

      expect(comparisonRow(markdown)['Outcome']).toBe(`not-evaluated ${markers(1)}`);
      expect(footnotesOf(markdown, 'task-1')).toEqual([
        `1. ${SETTING}: ${noResultText('task-1--alpha--1')}`,
      ]);
    });
  });

  describe('separation note', () => {
    const REQUIRED_CHECK = 'acc-acceptance-command';
    const MANUAL_CHECK = 'dod-manual-review';
    const OPTIONAL_CHECK = 'man-optional-polish';
    const models = buildDistinctModels(['alpha', 'beta']);

    function verdictsOf(
      acceptance: CheckResult['verdict'],
      manual: CheckResult['verdict'],
      optional: CheckResult['verdict'],
    ): CheckResult[] {
      return [
        buildCheckResult({ checkId: REQUIRED_CHECK, verdict: acceptance }),
        buildCheckResult({
          checkId: MANUAL_CHECK,
          category: 'definition-of-done',
          verdict: manual,
        }),
        buildCheckResult({
          checkId: OPTIONAL_CHECK,
          category: 'definition-of-done',
          verdict: optional,
        }),
      ];
    }

    describe('when the outcomes do not separate the settings', () => {
      it.each([
        { outcome: 'passed', repeat: 1 },
        { outcome: 'passed', repeat: 2 },
        { outcome: 'failed', repeat: 1 },
        { outcome: 'failed', repeat: 2 },
      ] as const)(
        'puts one $outcome note at repeat $repeat on the line after the table and its empty line',
        ({ outcome, repeat }) => {
          const markdown = reportOf({ models, repeat, results: () => ({ outcome }) });

          const block = comparisonBlock(markdown, 'task-1');

          expect(block).toHaveLength(9);
          expect(block.slice(2, 4)).toEqual([HEADER_ROW, SEPARATOR_ROW]);
          expect(block.slice(4, 6).every((line) => line.startsWith('| '))).toBe(true);
          expect(block.slice(6)).toEqual(['', separationNote(outcome, { repeat }), '']);
          expect(separationNotesOf(markdown, 'task-1')).toHaveLength(1);
        },
      );

      it('lists the settings in the row order of the configuration', () => {
        const reversed = buildDistinctModels(['beta', 'alpha']);

        const markdown = reportOf({ models: reversed });

        expect(separationNotesOf(markdown, 'task-1')).toEqual([
          separationNote('passed', {
            settings: 'vendor/model-beta-synth, effort-high; vendor/model-alpha-synth, effort-high',
          }),
        ]);
      });

      it('gives each task of a run its own note with its own name', () => {
        const markdown = reportOf({
          models,
          taskIds: ['task-1', 'task-2'],
          results: ({ taskId }) => ({ outcome: taskId === 'task-1' ? 'passed' : 'failed' }),
        });

        expect(separationNotesOf(markdown, 'task-1')).toEqual([separationNote('passed')]);
        expect(separationNotesOf(markdown, 'task-2')).toEqual([
          separationNote('failed', { task: taskTitleOf('task-2') }),
        ]);
      });

      it('keeps the note outside the footnotes, numbers the footnotes from 1 without gaps, and refers to no footnote from the note', () => {
        const markdown = reportOf({
          models,
          results: ({ modelId }) => ({
            metrics:
              modelId === 'alpha'
                ? { cost: unavailableMetric('USD', 'cost reason') }
                : { elapsed: unavailableMetric('millisecond', 'elapsed reason') },
          }),
        });

        const block = comparisonBlock(markdown, 'task-1');

        const note = separationNote('passed');
        const rows = comparisonRows(markdown);
        expect(rows.map((row) => row['Cost'])).toEqual([`- ${markers(1)}`, '$0.0125']);
        expect(rows.map((row) => row['Elapsed'])).toEqual(['1.5 s', `- ${markers(2)}`]);
        expect(footnotesOf(markdown, 'task-1')).toEqual([
          `1. vendor/model-alpha-synth, effort-high: ${gapText('cost reason')}`,
          `2. vendor/model-beta-synth, effort-high: ${gapText('elapsed reason')}`,
        ]);
        expect(block.filter((line) => line === note)).toHaveLength(1);
        expect(note).not.toMatch(/\\\[\d+\\\]/);
        expect(block.indexOf(note)).toBeLessThan(
          block.indexOf(footnotesOf(markdown, 'task-1')[0]!),
        );
      });

      it('still shows the note when an optional check failed, because optional checks take no part', () => {
        const markdown = reportOf({
          models,
          results: () => ({ outcome: 'passed', checks: verdictsOf('passed', 'passed', 'failed') }),
        });

        expect(separationNotesOf(markdown, 'task-1')).toEqual([separationNote('passed')]);
      });
    });

    describe('when the outcomes separate the settings or are not all evaluated', () => {
      it.each([
        {
          label: 'rows with different outcomes',
          repeat: 1,
          results: ({ modelId }: CaseIdentity): ResultOverrides => ({
            outcome: modelId === 'alpha' ? 'passed' : 'failed',
          }),
        },
        {
          label: 'attempts of one row with different outcomes',
          repeat: 2,
          results: ({ modelId, attempt }: CaseIdentity): ResultOverrides => ({
            outcome: modelId === 'alpha' && attempt === 2 ? 'failed' : 'passed',
          }),
        },
        {
          label: 'one not-evaluated attempt among passed ones',
          repeat: 2,
          results: ({ modelId, attempt }: CaseIdentity): ResultOverrides => ({
            outcome: modelId === 'beta' && attempt === 2 ? 'not-evaluated' : 'passed',
          }),
        },
        {
          label: 'every attempt pending',
          repeat: 1,
          results: (): ResultOverrides => ({ outcome: 'pending' }),
        },
        {
          label: 'every attempt not-evaluated',
          repeat: 1,
          results: (): ResultOverrides => ({ outcome: 'not-evaluated' }),
        },
        {
          label: 'a planned attempt without a case result among passed ones',
          repeat: 1,
          results: ({ modelId }: CaseIdentity): ResultOverrides | null =>
            modelId === 'beta' ? null : { outcome: 'passed' },
        },
        {
          label: 'a planned attempt without a case result among failed ones',
          repeat: 1,
          results: ({ modelId }: CaseIdentity): ResultOverrides | null =>
            modelId === 'beta' ? null : { outcome: 'failed' },
        },
        {
          label: 'no case result at all',
          repeat: 1,
          results: (): null => null,
        },
      ])('puts no note under $label', ({ repeat, results }) => {
        const markdown = reportOf({ models, repeat, results });

        expect(separationNotesOf(markdown, 'task-1')).toEqual([]);
        expect(markdown).not.toContain('cannot tell the settings apart');
      });

      it('puts no note under a task with one row, even when every attempt passed', () => {
        const markdown = reportOf({ repeat: 2 });

        expect(separationNotesOf(markdown, 'task-1')).toEqual([]);
      });
    });

    describe('pending verdicts', () => {
      it.each([
        {
          label: 'a required check when every outcome is pending',
          results: (): ResultOverrides => ({
            outcome: 'pending',
            checks: verdictsOf('passed', 'pending', 'passed'),
          }),
        },
        {
          label: 'a required check when every outcome is failed',
          results: (): ResultOverrides => ({
            outcome: 'failed',
            checks: verdictsOf('failed', 'pending', 'passed'),
          }),
        },
        {
          label: 'an optional check when every outcome is passed',
          results: (): ResultOverrides => ({
            outcome: 'passed',
            checks: verdictsOf('passed', 'passed', 'pending'),
          }),
        },
        {
          label: 'an optional check when every outcome is failed',
          results: (): ResultOverrides => ({
            outcome: 'failed',
            checks: verdictsOf('failed', 'passed', 'pending'),
          }),
        },
        {
          label: 'an optional check in one attempt of one row only',
          results: ({ modelId, attempt }: CaseIdentity): ResultOverrides => ({
            outcome: 'passed',
            checks:
              modelId === 'beta' && attempt === 2
                ? verdictsOf('passed', 'passed', 'pending')
                : verdictsOf('passed', 'passed', 'passed'),
          }),
        },
      ])('puts no note while $label has a pending verdict', ({ results }) => {
        const markdown = reportOf({ models, repeat: 2, results });

        expect(separationNotesOf(markdown, 'task-1')).toEqual([]);
      });

      it.each([
        {
          outcome: 'passed',
          checks: verdictsOf('passed', 'passed', 'passed'),
        },
        {
          outcome: 'failed',
          checks: verdictsOf('failed', 'passed', 'passed'),
        },
      ] as const)(
        'puts the $outcome note once every verdict is recorded',
        ({ outcome, checks }) => {
          const markdown = reportOf({ models, repeat: 2, results: () => ({ outcome, checks }) });

          expect(separationNotesOf(markdown, 'task-1')).toEqual([
            separationNote(outcome, { repeat: 2 }),
          ]);
        },
      );
    });

    describe('derived output', () => {
      const results = (): ResultOverrides => ({ outcome: 'passed' });

      it('keeps the note out of the normalized JSON and the summary and adds no field', () => {
        const input = buildComparisonInput({ models, repeat: 2, results });

        const { markdown, normalizedJson, summary } = buildReport(input);

        const parsed = JSON.parse(normalizedJson) as { pairs: object[] };
        expect(separationNotesOf(markdown, 'task-1')).toHaveLength(1);
        expect(normalizedJson).not.toContain('cannot tell the settings apart');
        expect(summary.attempts.flatMap((attempt) => attempt.lines).join('\n')).not.toContain(
          'cannot tell the settings apart',
        );
        expect(Object.keys(parsed).sort()).toEqual([
          'assessments',
          'capabilities',
          'cases',
          'exitCode',
          'findings',
          'graders',
          'gradings',
          'manifest',
          'models',
          'pairs',
          'repositories',
          'schemaVersion',
          'tasks',
        ]);
        expect(Object.keys(parsed.pairs[0] ?? {}).sort()).toEqual([
          'allPassed',
          'modelId',
          'outcomes',
          'passedOfPlanned',
          'planned',
          'taskId',
        ]);
      });

      it('returns identical markdown for equal inputs and for case results in another order', () => {
        const input = buildComparisonInput({ models, repeat: 2, results });
        const reordered: ReportInput = {
          ...input,
          run: { ...input.run, cases: [...input.run.cases].reverse() },
        };

        const first = buildReport(input).markdown;

        expect(buildReport(structuredClone(input)).markdown).toBe(first);
        expect(buildReport(reordered).markdown).toBe(first);
        expect(separationNotesOf(first, 'task-1')).toHaveLength(1);
      });
    });
  });

  describe('grader line', () => {
    const GRADER_LINE_START = 'Grading model total for this task, not added to any row: ';

    function graderLineOf(markdown: string, taskId: string): string | undefined {
      return comparisonBlock(markdown, taskId).find((line) => line.startsWith(GRADER_LINE_START));
    }

    it('keeps grader usage out of the rows and states it on the line', () => {
      const withGradings = buildComparisonInput({
        gradings: [
          buildGradingArtifact({
            metrics: buildAgentMetrics({ inputTokens: reported(7000, 'token') }),
          }),
        ],
      });
      const withoutGradings = { ...withGradings, gradings: [] };

      const markdown = buildReport(withGradings).markdown;
      const markdownWithoutGradings = buildReport(withoutGradings).markdown;

      expect(comparisonRow(markdown)['Input']).toBe('130');
      expect(graderLineOf(markdown, 'task-1')).toContain('input 7,000');
      expect(comparisonRows(markdown)).toEqual(comparisonRows(markdownWithoutGradings));
    });

    it('keeps the strings that locate the case sections out of the part before the first task', () => {
      const markdown = reportOf({ gradings: [buildGradingArtifact()] });

      const beforeTasks = markdown.slice(0, markdown.indexOf('## Task: '));

      expect(markdown).toContain('Grades by openai/grader-model');
      expect(beforeTasks).not.toContain('Metrics:');
      expect(beforeTasks).not.toContain('Grades by');
      expect(beforeTasks).not.toContain('Grader metrics');
    });

    it('sums the gradings of the task and shares the footnote numbering with the rows', () => {
      const models = buildDistinctModels(['alpha', 'beta']);
      const unreportedReasoning = unavailableMetric('token', 'the grader reported no reasoning');

      const markdown = reportOf({
        models,
        results: ({ modelId }) =>
          modelId === 'alpha' ? { metrics: { cost: unavailableMetric('USD', 'row reason') } } : {},
        gradings: [
          buildGradingArtifact({
            caseId: 'task-1--alpha--1',
            metrics: buildAgentMetrics({
              inputTokens: reported(1000, 'token'),
              cacheReadTokens: reported(0, 'token'),
              cacheWriteTokens: reported(0, 'token'),
              outputTokens: reported(300, 'token'),
              reasoningTokens: unreportedReasoning,
              cost: reported(0.003, 'USD'),
            }),
          }),
          buildGradingArtifact({
            caseId: 'task-1--beta--1',
            metrics: buildAgentMetrics({
              inputTokens: reported(200, 'token'),
              cacheReadTokens: reported(0, 'token'),
              cacheWriteTokens: reported(0, 'token'),
              outputTokens: reported(40, 'token'),
              reasoningTokens: unreportedReasoning,
              cost: reported(0.0012, 'USD'),
            }),
          }),
        ],
      });

      expect(comparisonBlock(markdown, 'task-1').slice(-7)).toEqual([
        '',
        `${GRADER_LINE_START}2 calls, input 1,200, cache read 0, cache write 0, output 340, reasoning - ${markers(2, 3)}, cost $0.0042.`,
        '',
        `1. vendor/model-alpha-synth, effort-high: ${gapText('row reason')}`,
        `2. vendor/model-alpha-synth, effort-high: ${gapText('the grader reported no reasoning', { graderLine: true })}`,
        `3. vendor/model-beta-synth, effort-high: ${gapText('the grader reported no reasoning', { graderLine: true })}`,
        '',
      ]);
    });

    it('names a single graded case in the singular and gives the bare reason of a missing value', () => {
      const markdown = reportOf({
        gradings: [
          buildGradingArtifact({
            metrics: buildAgentMetrics({
              reasoningTokens: unavailableMetric('token', 'the grader export is missing'),
            }),
          }),
        ],
      });

      expect(graderLineOf(markdown, 'task-1')).toBe(
        `${GRADER_LINE_START}1 call, input 130, cache read 30, cache write 10, output 45, reasoning - ${markers(1)}, cost $0.0125.`,
      );
      expect(footnotesOf(markdown, 'task-1')).toEqual([
        `1. ${SETTING}: ${gapText('the grader export is missing', { graderLine: true })}`,
      ]);
    });

    it('marks a total that only some gradings reported with its reporting count', () => {
      const models = buildDistinctModels(['alpha', 'beta']);

      const markdown = reportOf({
        models,
        gradings: [
          buildGradingArtifact({ caseId: 'task-1--alpha--1', metrics: buildAgentMetrics() }),
          buildGradingArtifact({
            caseId: 'task-1--beta--1',
            metrics: buildAgentMetrics({
              cost: unavailableMetric('USD', 'grader cost unavailable'),
            }),
          }),
        ],
      });

      expect(graderLineOf(markdown, 'task-1')).toContain(`cost $0.0125 (1/2) ${markers(1)}.`);
      expect(footnotesOf(markdown, 'task-1')).toEqual([
        `1. vendor/model-beta-synth, effort-high: ${gapText('grader cost unavailable', { graderLine: true })}`,
      ]);
    });

    it('counts the calls of every grading and those that ended without a verdict', () => {
      const models = buildDistinctModels(['alpha', 'beta']);
      const stopped = buildGraderCall({
        outcome: { status: 'no-reply', cause: 'unfinished', reason: 'the model stopped' },
      });

      const markdown = reportOf({
        models,
        gradings: [
          buildGradingArtifact({
            caseId: 'task-1--alpha--1',
            calls: [stopped, buildGraderCall()],
            metrics: buildAgentMetrics(),
          }),
          buildGradingArtifact({ caseId: 'task-1--beta--1', metrics: buildAgentMetrics() }),
        ],
      });

      expect(graderLineOf(markdown, 'task-1')).toContain(
        `${GRADER_LINE_START}3 calls, 1 without a verdict, input `,
      );
    });

    it('reads 0 calls for a task whose only grading made no call', () => {
      const markdown = reportOf({
        gradings: [
          buildGradingArtifact({
            call: {
              status: 'no-reply',
              cause: 'other',
              reason: 'the grader prompt could not be redacted; the grader was not called',
            },
            calls: [],
          }),
        ],
      });

      const line = graderLineOf(markdown, 'task-1');

      expect(line).toContain(`${GRADER_LINE_START}0 calls, input `);
      expect(line).not.toContain('without a verdict');
    });

    it('leaves a metric that one call of a grading lacks out of the grader total with the grader-line footnote', () => {
      const first = buildAgentMetrics();
      const second = buildAgentMetrics({ cost: unavailableMetric('USD', 'the call timed out') });
      const markdown = reportOf({
        gradings: [
          buildGradingArtifact({
            call: { status: 'no-reply', cause: 'other', reason: 'the grader call failed' },
            calls: [
              buildGraderCall({ metrics: first }),
              buildGraderCall({
                outcome: { status: 'no-reply', cause: 'other', reason: 'the grader call failed' },
                metrics: second,
              }),
            ],
            metrics: sumGraderCallMetrics([first, second]),
          }),
        ],
      });

      const line = graderLineOf(markdown, 'task-1');

      expect(line).toBe(
        `${GRADER_LINE_START}2 calls, 1 without a verdict, input 260, cache read 60, cache write 20, output 90, reasoning 32, cost - ${markers(1)}.`,
      );
      expect(footnotesOf(markdown, 'task-1')).toEqual([
        `1. ${SETTING}: ${gapText('the call timed out', { graderLine: true })}`,
      ]);
    });

    it('renders the line only in the block of the task whose case was graded', () => {
      const markdown = reportOf({
        taskIds: ['task-1', 'task-2'],
        gradings: [buildGradingArtifact({ caseId: 'task-2--alpha--1' })],
      });

      expect(graderLineOf(markdown, 'task-1')).toBeUndefined();
      expect(graderLineOf(markdown, 'task-2')).toContain('1 call, ');
    });

    it('renders no line for a grading whose case has no case result', () => {
      const markdown = reportOf({
        results: () => null,
        gradings: [buildGradingArtifact()],
      });

      expect(graderLineOf(markdown, 'task-1')).toBeUndefined();
    });
  });

  describe('grading block', () => {
    const NO_REPLY = {
      status: 'no-reply',
      cause: 'unfinished',
      reason: 'the grader call failed: the model stopped',
    } as const;

    function gradingHeaderOf(markdown: string): string | undefined {
      return markdown.split('\n').find((line) => line.startsWith('Grades by '));
    }

    it('adds no call count to the header of a grading that made one call', () => {
      const markdown = reportOf({ gradings: [buildGradingArtifact()] });

      expect(gradingHeaderOf(markdown)).toMatch(/^Grades by openai\/grader-model \(.*\):$/);
    });

    it.each([2, 3])('names the %i calls after the closing parenthesis of the header', (count) => {
      const calls = Array.from({ length: count }, () => buildGraderCall({ outcome: NO_REPLY }));

      const markdown = reportOf({
        gradings: [buildGradingArtifact({ call: NO_REPLY, calls, metrics: buildAgentMetrics() })],
      });

      expect(gradingHeaderOf(markdown)).toMatch(
        new RegExp(`^Grades by openai/grader-model \\(.*\\), after ${count} calls:$`),
      );
    });

    it('renders the grader metrics of a grading that returned no reply', () => {
      const markdown = reportOf({
        gradings: [
          buildGradingArtifact({
            call: { ...NO_REPLY, cause: 'tool-call' },
            calls: [buildGraderCall({ outcome: { ...NO_REPLY, cause: 'tool-call' } })],
            metrics: buildAgentMetrics({ cost: reported(0.0125, 'USD') }),
          }),
        ],
      });

      expect(markdown).toContain(
        'Grader metrics (separate from the agent metrics above; never added to them):',
      );
      expect(markdown).toContain('- Cost: $0.0125');
    });
  });

  describe('grader calls in the normalized run', () => {
    const RECORDS = {
      events: [{ type: 'text' }],
      diagnostics: 'KEPT IN THE INPUT',
      session: { info: { id: 'session-1' } },
    };

    function multiCallGrading(): GradingArtifact {
      return buildGradingArtifact({
        calls: [
          buildGraderCall({
            outcome: { status: 'no-reply', cause: 'unfinished', reason: 'the model stopped' },
            ...RECORDS,
          }),
          buildGraderCall(RECORDS),
        ],
        metrics: buildAgentMetrics(),
      });
    }

    it('holds only the outcome and metrics of each call, in call order, and leaves the input untouched', () => {
      const grading = multiCallGrading();

      const model = buildNormalizedRun(buildComparisonInput({ gradings: [grading] }));

      expect(model.gradings.flatMap(({ calls }) => calls)).toEqual([
        { outcome: grading.calls[0]?.outcome, metrics: grading.calls[0]?.metrics },
        { outcome: { status: 'replied' }, metrics: grading.calls[1]?.metrics },
      ]);
      expect(grading.calls.map((call) => call.diagnostics)).toEqual([
        RECORDS.diagnostics,
        RECORDS.diagnostics,
      ]);
    });

    it('serializes without any run event, diagnostics, or session export of a call', () => {
      const model = buildNormalizedRun(buildComparisonInput({ gradings: [multiCallGrading()] }));

      const json = serializeNormalizedRun(model);

      expect(json).not.toContain(RECORDS.diagnostics);
      expect(json).not.toContain('session-1');
    });

    it('rebuilds byte-identical JSON and Markdown from unchanged input', () => {
      const input = buildComparisonInput({ gradings: [multiCallGrading()] });

      const first = buildReport(input);
      const second = buildReport(input);

      expect(second.normalizedJson).toBe(first.normalizedJson);
      expect(second.markdown).toBe(first.markdown);
    });
  });

  describe('reader-friendly names, anchors, and statements', () => {
    const TITLE = 'Fix the login redirect';
    const GRADER_REASON =
      'the grader call failed: ModelCallError (failed): final assistant message finished with "tool-calls"';
    const ANCHOR_LINE = /^<a id="case-[^"]+"><\/a>$/;

    function expectEveryCaseSectionAnchored(markdown: string): void {
      const lines = markdown.split('\n');
      const destinations = new Set(
        [...markdown.matchAll(/\]\(#case-([^)]+)\)/g)].map((match) => match[1]),
      );

      expect(destinations.size).toBeGreaterThan(0);
      for (const id of destinations) {
        expect(lines.filter((line) => line === `<a id="case-${id}"></a>`)).toHaveLength(1);
      }
      lines.forEach((line, index) => {
        if (line.startsWith('### ')) {
          expect(lines[index - 2]).toMatch(ANCHOR_LINE);
          expect(lines[index - 1]).toBe('');
        }
      });
    }

    describe('headings and anchors', () => {
      const models = [buildModelRecord({ id: 'm1', model: 'vendor/model-a', effort: 'high' })];
      const tasks = [buildTaskRecord({ id: 'task-1', title: TITLE })];

      it('names the comparison block, the task section, and the case section by title and setting at repeat 1', () => {
        const lines = reportOf({ models, tasks }).split('\n');

        expect(lines).toContain(`## Comparison: ${TITLE}`);
        expect(lines).toContain(`## Task: ${TITLE}`);
        expect(lines).toContain('### vendor/model-a, high');
      });

      it('names each case section by setting and attempt number at repeat 2', () => {
        const lines = reportOf({ models, tasks, repeat: 2 }).split('\n');

        expect(lines).toContain('### vendor/model-a, high, attempt 1');
        expect(lines).toContain('### vendor/model-a, high, attempt 2');
      });

      it.each([1, 2])('anchors every linked case section exactly once at repeat %i', (repeat) => {
        const markdown = reportOf({
          models: [...models, buildModelRecord({ id: 'm2', model: 'vendor/model-b' })],
          tasks,
          repeat,
          results: (identity) => (identity.modelId === 'm2' && identity.attempt === 1 ? null : {}),
        });

        expectEveryCaseSectionAnchored(markdown);
      });
    });

    type RichIds = {
      task: string;
      repository: string;
      m1: string;
      m2: string;
      acceptance: string;
      graded: string;
      manual: string;
    };

    const READABLE_IDS: RichIds = {
      task: 'task-1',
      repository: 'repo-1',
      m1: 'm1',
      m2: 'm2',
      acceptance: 'acc',
      graded: 'graded',
      manual: 'manual',
    };

    /** A task with one check of each evaluator, two models, and repeat 2, covering every statement kind. */
    function buildRichInput(ids: RichIds, effortReason = 'agent listing failed'): ReportInput {
      const task = buildTaskRecord({
        id: ids.task,
        title: TITLE,
        repositoryId: ids.repository,
        checks: [
          buildCheckRecord({
            id: ids.acceptance,
            description: 'Redirect lands on the dashboard',
          }),
          buildCheckRecord({
            id: ids.graded,
            category: 'definition-of-done',
            description: 'Greeting matches the design',
            evaluator: 'grader',
          }),
          buildCheckRecord({
            id: ids.manual,
            category: 'definition-of-done',
            description: 'Reviewer approves the copy',
            evaluator: 'manual',
          }),
        ],
      });
      const models = [
        buildModelRecord({ id: ids.m1, model: 'vendor/model-a', effort: 'high' }),
        buildModelRecord({ id: ids.m2, model: 'vendor/model-b', effort: 'high' }),
      ];
      const caseId = (modelId: string, attempt: number): string =>
        `${ids.task}--${modelId}--${attempt}`;
      const base = buildComparisonInput({
        models,
        tasks: [task],
        taskIds: [ids.task],
        repeat: 2,
        efforts: {
          models: {
            [ids.m1]: { status: 'unverified', reason: effortReason },
            [ids.m2]: { status: 'verified' },
          },
          grader: null,
        },
        results: (identity) => {
          if (identity.modelId === ids.m1 && identity.attempt === 1) {
            return {
              outcome: 'pending',
              failure: buildFailure('AgentProcessError', identity.caseId),
              checks: [
                buildCheckResult({ checkId: ids.acceptance }),
                buildCheckResult({ checkId: ids.graded, verdict: 'pending' }),
                buildCheckResult({ checkId: ids.manual, verdict: 'pending' }),
              ],
            };
          }
          if (identity.modelId === ids.m1) {
            return {
              lifecycle: 'timed-out',
              outcome: 'not-evaluated',
              failure: buildFailure('CaseTimeoutError', identity.caseId),
            };
          }
          if (identity.attempt === 1) {
            return null;
          }
          return {
            outcome: 'failed',
            checks: [
              buildCheckResult({ checkId: ids.acceptance, verdict: 'failed' }),
              buildCheckResult({ checkId: ids.graded }),
              buildCheckResult({ checkId: ids.manual }),
            ],
            metrics: { cost: unavailableMetric('USD', 'no price listed') },
          };
        },
        gradings: [
          buildGradingArtifact({
            caseId: caseId(ids.m1, 1),
            call: {
              status: 'no-reply',
              cause: 'other',
              reason: `${GRADER_REASON} for ${ids.task}`,
            },
            grades: [
              {
                checkId: ids.graded,
                category: 'definition-of-done',
                status: 'pending',
                reason: GRADER_REASON,
              },
            ],
          }),
        ],
      });
      return {
        ...base,
        run: {
          ...base.run,
          findings: [
            {
              severity: 'warning',
              caseId: caseId(ids.m2, 2),
              message: 'cleanup left a temporary directory',
            },
          ],
        },
        repositories: [{ id: ids.repository, path: `/repos/${ids.repository}` }],
      };
    }

    describe('configuration IDs that are opaque hexadecimal strings', () => {
      const OPAQUE_IDS: RichIds = {
        task: 'a1b2c3d4',
        repository: 'd4e5f6a7',
        m1: 'b2c3d4e5',
        m2: 'c3d4e5f6',
        acceptance: 'e5f6a7b8',
        graded: 'f6a7b8c9',
        manual: 'a7b8c9d0',
      };

      function withoutAllowedIdText(text: string): string {
        return text
          .split('\n')
          .filter((line) => !ANCHOR_LINE.test(line))
          .map((line) =>
            line
              .replace(/\]\([^)]*\)/g, ']()')
              .replace(/`[^`]*`/g, '``')
              .replace(/Technical detail:.*$/, 'Technical detail:'),
          )
          .join('\n');
      }

      it('uses fixture IDs that are distinct hexadecimal strings and none a substring of another', () => {
        const ids = Object.values(OPAQUE_IDS);

        for (const id of ids) {
          expect(id).toMatch(/^[a-f][0-9a-f]{7,}$/);
          expect(ids.filter((other) => other !== id && other.includes(id))).toEqual([]);
        }
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('never uses an ID as a name outside code spans, link destinations, anchors, and technical detail', () => {
        const input = buildRichInput(OPAQUE_IDS, `the agent listing for ${OPAQUE_IDS.task} failed`);

        const { markdown, summary } = buildReport(input);

        for (const id of [OPAQUE_IDS.task, OPAQUE_IDS.m1, OPAQUE_IDS.m2, OPAQUE_IDS.repository]) {
          expect(markdown).toContain(id);
        }
        const visible = [
          withoutAllowedIdText(markdown),
          ...summary.attempts.flatMap((attempt) => attempt.lines.map(withoutAllowedIdText)),
          ...summary.findings.map(withoutAllowedIdText),
        ].join('\n');
        for (const id of Object.values(OPAQUE_IDS)) {
          expect(visible).not.toContain(id);
        }
        expect(visible).toContain(`## Task: ${TITLE}`);
      });

      it('names the task and settings in the separation note instead of their IDs when every row passed', () => {
        const input = buildComparisonInput({
          models: [
            buildModelRecord({ id: OPAQUE_IDS.m1, model: 'vendor/model-a', effort: 'high' }),
            buildModelRecord({ id: OPAQUE_IDS.m2, model: 'vendor/model-b', effort: 'high' }),
          ],
          taskIds: [OPAQUE_IDS.task],
          tasks: [
            buildTaskRecord({
              id: OPAQUE_IDS.task,
              title: TITLE,
              repositoryId: OPAQUE_IDS.repository,
              checks: [
                buildCheckRecord({
                  id: OPAQUE_IDS.acceptance,
                  description: 'Redirect lands on the dashboard',
                }),
              ],
            }),
          ],
        });

        const { markdown, summary } = buildReport(input);

        const visible = [
          withoutAllowedIdText(markdown),
          ...summary.attempts.flatMap((attempt) => attempt.lines.map(withoutAllowedIdText)),
        ].join('\n');
        expect(visible).toContain(
          withoutAllowedIdText(
            separationNote('passed', {
              task: TITLE,
              settings: 'vendor/model-a, high; vendor/model-b, high',
            }),
          ),
        );
        for (const id of Object.values(OPAQUE_IDS)) {
          expect(visible).not.toContain(id);
        }
      });
    });

    describe('a grader call that returned no reply', () => {
      const ids: RichIds = { ...READABLE_IDS };
      const CASE_ID = 'task-1--m1--1';
      const RUN_ID = '20260923t000000z-comparison';
      const NO_REPLY_TEXT =
        "The grading model returned no verdict for this solution, so 5 required graded checks wait for a person's verdict. " +
        'The outcome stays pending until every required check has a verdict. ' +
        `Record the verdicts with \`tevu assess ${RUN_ID} ${CASE_ID}\`. ` +
        `Technical detail: case ${CASE_ID}: ${GRADER_REASON}`;
      const GRADED_IDS = ['g1', 'g2', 'g3', 'g4', 'g5'];

      function buildNoReplyInput(): ReportInput {
        const task = buildTaskRecord({
          id: ids.task,
          title: TITLE,
          checks: [
            buildCheckRecord({ id: 'acc-command' }),
            ...GRADED_IDS.map((id) => buildCheckRecord({ id, evaluator: 'grader' })),
          ],
        });
        return buildComparisonInput({
          models: [buildModelRecord({ id: 'm1', model: 'vendor/model-a', effort: 'high' })],
          tasks: [task],
          results: () => ({
            outcome: 'pending',
            checks: [
              buildCheckResult({ checkId: 'acc-command' }),
              ...GRADED_IDS.map((checkId) => buildCheckResult({ checkId, verdict: 'pending' })),
            ],
          }),
          gradings: [
            buildGradingArtifact({
              caseId: CASE_ID,
              call: { status: 'no-reply', cause: 'other', reason: GRADER_REASON },
              grades: GRADED_IDS.map((checkId) => ({
                checkId,
                category: 'acceptance' as const,
                status: 'pending' as const,
                reason: GRADER_REASON,
              })),
            }),
          ],
        });
      }

      it('marks the Outcome cell and states the next step with the internal reason only in the technical detail', () => {
        const markdown = buildReport(buildNoReplyInput()).markdown;

        expect(comparisonRow(markdown, 'task-1', TITLE)['Outcome']).toBe('pending \\[1\\]');
        expect(footnotesOf(markdown, 'task-1', TITLE)[0]).toBe(
          `1. vendor/model-a, high: ${NO_REPLY_TEXT}`,
        );
        const lines = markdown.split('\n').filter((line) => line.includes('ModelCallError'));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(line.indexOf('ModelCallError')).toBeGreaterThan(line.indexOf('Technical detail:'));
        }
      });

      it('counts its pending checks apart from passed ones', () => {
        const markdown = buildReport(buildNoReplyInput()).markdown;

        expect(comparisonRow(markdown, 'task-1', TITLE)['Required checks']).toBe(
          '1/6 passed, 5 pending',
        );
      });

      it('gives the terminal summary the same statement as the footnote', () => {
        const { summary } = buildReport(buildNoReplyInput());

        expect(summary.attempts.find((attempt) => attempt.caseId === CASE_ID)?.lines).toEqual([
          `vendor/model-a, high on "${TITLE}": pending; required checks 1/6 passed, 5 pending.`,
          `  ${NO_REPLY_TEXT}`,
        ]);
      });

      it('counts the call on the grader line as one call without a verdict', () => {
        const markdown = buildReport(buildNoReplyInput()).markdown;

        const graderLine = comparisonBlock(markdown, 'task-1', TITLE).find((line) =>
          line.startsWith('Grading model total for this task'),
        );

        expect(graderLine).toMatch(
          /^Grading model total for this task, not added to any row: 1 call, 1 without a verdict, input /,
        );
      });
    });

    describe('case section', () => {
      const SECTION_MODELS = [buildModelRecord()];

      function caseSectionOf(markdown: string): string {
        const start = markdown.indexOf('<a id="case-task-1--alpha--1"></a>');
        return markdown.slice(start);
      }

      it.each([
        { label: 'no process', process: null, expected: 'did not start' },
        {
          label: 'a clean exit',
          process: buildProcessResult({ durationMs: 90_000 }),
          expected: 'exited with code 0 after 1.5 min',
        },
        {
          label: 'a graceful stop',
          process: buildProcessResult({
            exitCode: 1,
            durationMs: 500,
            terminationStage: 'graceful',
          }),
          expected: 'exited with code 1 after 0.5 s; tevu asked it to stop',
        },
        {
          label: 'a forced stop by signal',
          process: buildProcessResult({
            exitCode: null,
            signal: 'SIGKILL',
            terminationStage: 'forced',
          }),
          expected: 'ended by signal SIGKILL after 1.5 s; tevu forced it to stop',
        },
        {
          label: 'a signal that the record does not name',
          process: buildProcessResult({ exitCode: null, signal: null }),
          expected: 'ended by signal unknown after 1.5 s',
        },
      ])('describes $label in the process line', ({ process, expected }) => {
        const markdown = reportOf({ models: SECTION_MODELS, results: () => ({ process }) });

        expect(markdown).toContain(`\n- Agent process: ${expected}\n`);
      });

      it('replaces the lifecycle and pending lines with statements and lists the setup logs before the result', () => {
        const markdown = reportOf({
          models: SECTION_MODELS,
          results: (identity) => ({
            setup: {
              logs: {
                beforeAgent: `cases/${identity.caseId}/setup-before-agent.log`,
                beforeChecks: null,
              },
              commands: [],
            },
          }),
        });

        expect(markdown).not.toContain('Lifecycle:');
        expect(markdown).not.toContain('Pending manual checks:');
        expect(markdown).toContain(
          '- Check evidence: missing\n- Setup log before the agent: [setup-before-agent.log](cases/task-1--alpha--1/setup-before-agent.log)\n- Result: ',
        );
        expect(markdown).not.toContain('Setup log before the checks');
      });

      it('reads a check without a definition as unknown in the Required and Evaluator columns', () => {
        const markdown = reportOf({
          models: SECTION_MODELS,
          results: () => ({ checks: [buildCheckResult({ checkId: 'removed-check' })] }),
        });

        expect(caseSectionOf(markdown)).toContain(
          '| passed | removed-check | acceptance | unknown | unknown | 12ms | missing |',
        );
      });

      it('lists each kind of grade on its own line with the reply problem only in the technical detail', () => {
        const gradedIds = ['first', 'second', 'third'];
        const task = buildTaskRecord({
          title: taskTitleOf('task-1'),
          checks: gradedIds.map((id) =>
            buildCheckRecord({ id, description: `Criterion ${id}`, evaluator: 'grader' }),
          ),
        });

        const markdown = reportOf({
          models: SECTION_MODELS,
          tasks: [task],
          gradings: [
            buildGradingArtifact({
              caseId: 'task-1--alpha--1',
              grades: [
                {
                  checkId: 'first',
                  category: 'acceptance',
                  status: 'graded',
                  verdict: 'undetermined',
                  rationale: 'the patch is unrelated',
                },
                {
                  checkId: 'second',
                  category: 'acceptance',
                  status: 'pending',
                  reason: 'the reply was not JSON',
                },
                {
                  checkId: 'third',
                  category: 'acceptance',
                  status: 'graded',
                  verdict: 'failed',
                  rationale: 'the loader is missing',
                },
              ],
            }),
          ],
        });

        expect(caseSectionOf(markdown)).toContain(
          [
            '- Criterion first: undetermined. the patch is unrelated',
            '- Criterion second: no usable verdict. Technical detail: the reply was not JSON',
            '- Criterion third: failed. the loader is missing',
          ].join('\n'),
        );
      });
    });

    describe('required checks over several attempts of a task with six required checks', () => {
      const requiredIds = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
      const task = buildTaskRecord({
        title: taskTitleOf('task-1'),
        checks: requiredIds.map((id) => buildCheckRecord({ id })),
      });

      it('reads each class apart from the others', () => {
        const verdictsByModel: Record<string, CheckResult['verdict'][]> = {
          m1: ['passed', 'passed', 'passed', 'passed', 'failed', 'pending'],
          m2: ['passed', 'passed', 'passed', 'passed', 'passed', 'passed'],
        };
        const models = ['m1', 'm2', 'm3'].map((id) =>
          buildModelRecord({ id, model: `vendor/model-${id}` }),
        );

        const markdown = reportOf({
          models,
          tasks: [task],
          results: ({ modelId, caseId }) => {
            const verdicts = verdictsByModel[modelId];
            return verdicts === undefined
              ? {
                  lifecycle: 'timed-out',
                  outcome: 'not-evaluated',
                  failure: buildFailure('CaseTimeoutError', caseId),
                }
              : {
                  checks: verdicts.map((verdict, index) =>
                    buildCheckResult({ checkId: requiredIds[index] ?? 'unknown', verdict }),
                  ),
                };
          },
        });

        expect(comparisonRows(markdown).map((row) => row['Required checks'])).toEqual([
          '4/6 passed, 1 failed, 1 pending',
          '6/6 passed',
          '0/6 passed, 6 not run',
        ]);
      });
    });

    describe('properties of the report model', () => {
      const input = buildRichInput(READABLE_IDS);

      it('returns identical markdown, normalized JSON, and summary for equal inputs', () => {
        const first = buildReport(input);

        const second = buildReport(structuredClone(input));

        expect(second).toEqual(first);
      });

      it('keeps names, suffixes, and footnote numbers stable when the case results arrive in another order', () => {
        const reordered: ReportInput = {
          ...input,
          run: { ...input.run, cases: [...input.run.cases].reverse() },
        };

        expect(buildReport(reordered)).toEqual(buildReport(input));
      });

      it('lists exactly one summary entry per planned attempt, including attempts without a case result', () => {
        const { summary } = buildReport(input);

        const planned = input.run.manifest.cases.map((identity) => identity.caseId);

        expect(summary.attempts.map((attempt) => attempt.caseId).sort()).toEqual(
          [...planned].sort(),
        );
      });

      it('numbers footnotes from 1 without gaps, refers only to listed footnotes, and never repeats a text', () => {
        const { markdown } = buildReport(input);
        const block = comparisonBlock(markdown, 'task-1', TITLE);

        const footnotes = block.flatMap((line) => {
          const match = /^(\d+)\. (.*)$/.exec(line);
          return match === null ? [] : [{ number: Number(match[1]), text: match[2] ?? '' }];
        });
        const used = [
          ...block
            .filter((line) => line.startsWith('|') || line.startsWith('Grading model total'))
            .join('\n')
            .matchAll(/\\\[(\d+)\\\]/g),
        ].map((match) => Number(match[1]));

        expect(footnotes.map((footnote) => footnote.number)).toEqual(
          footnotes.map((_, index) => index + 1),
        );
        expect(footnotes.length).toBeGreaterThan(1);
        for (const number of used) {
          expect(footnotes.map((footnote) => footnote.number)).toContain(number);
        }
        expect(new Set(footnotes.map((footnote) => footnote.text)).size).toBe(footnotes.length);
      });

      it('gives every summary statement line the text of its footnote after the attempt name', () => {
        const { markdown, summary } = buildReport(input);
        const footnoteTexts = footnotesOf(markdown, 'task-1', TITLE).map((line) =>
          line.replace(/^\d+\. /, ''),
        );

        const statementLines = summary.attempts.flatMap(({ lines }) => {
          const attemptName = (lines[0] ?? '').split(` on "${TITLE}": `)[0] ?? '';
          return lines.slice(1).map((line) => ({ attemptName, text: line.replace(/^ {2}/, '') }));
        });

        expect(statementLines).toHaveLength(4);
        for (const { attemptName, text } of statementLines) {
          expect(footnoteTexts).toContain(`${attemptName}: ${text}`);
        }
      });

      it('prints the finding of a planned case under that case name in the report and the summary', () => {
        const { markdown, summary } = buildReport(input);

        const line =
          'Warning for vendor/model-b, high, attempt 2 on "Fix the login redirect": cleanup left a temporary directory';

        expect(markdown).toContain(`\n- ${line}\n`);
        expect(summary.findings).toEqual([line]);
      });
    });
  });

  describe('regeneration from saved artifacts', () => {
    function pendingManualChecks(): CheckResult[] {
      return [
        buildCheckResult({ checkId: 'acc-acceptance-command' }),
        buildCheckResult({
          checkId: 'dod-manual-review',
          category: 'definition-of-done',
          verdict: 'pending',
          evidence: 'awaiting manual assessment',
          durationMs: null,
        }),
      ];
    }

    async function createRunWithPendingManualCheck(
      root: string,
      checksOf: () => CheckResult[] = pendingManualChecks,
    ): Promise<{
      runId: string;
      store: ReturnType<typeof createArtifactStore>;
    }> {
      const runId = '20260923t000000z-comparison-regen';
      const store = createArtifactStore({
        artifactsDirectory: join(root, 'artifacts'),
        redact: (text) => text,
      });
      const config = rekeyToFakeAgent(buildSyntheticConfig());
      const manifest = buildManifest(
        runId,
        { ...config, models: [...config.models].reverse() },
        buildCapabilityReport(),
        ['task-1--alpha--1', 'task-1--beta--1'],
      );
      const started = await store.startRun(manifest);
      if (!started.ok) {
        throw new Error(`startRun failed: ${JSON.stringify(started.error)}`);
      }
      const cases = manifest.cases.map((identity) =>
        buildCaseResult({
          identity,
          outcome: 'pending',
          checks: checksOf(),
          artifacts: buildArtifactIndex(identity.caseId, new Set(['result', 'checks'])),
        }),
      );
      for (const caseResult of cases) {
        await writeChecksOrThrow(store, caseResult.identity.caseId, caseResult.checks);
        const finalized = await store.finalizeCase(caseResult);
        if (!finalized.ok) {
          throw new Error(`finalizeCase failed: ${JSON.stringify(finalized.error)}`);
        }
      }
      const runFinalized = await store.finalizeRun({
        schemaVersion: 1,
        manifest,
        cases,
        findings: [],
        exitCode: 2,
      });
      if (!runFinalized.ok) {
        throw new Error(`finalizeRun failed: ${JSON.stringify(runFinalized.error)}`);
      }
      return { runId, store };
    }

    const SYNTHETIC_TASK_TITLE = 'Synthetic welcome-route task';
    const BETA_LINK = '[vendor/model-alpha-synth](#case-task-1--beta--1)';
    const ALPHA_LINK = '[vendor/model-alpha-synth](#case-task-1--alpha--1)';

    it('regenerates identical blocks in the order of the saved configuration', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-eval-comparison-regen-'));
      try {
        const { runId, store } = await createRunWithPendingManualCheck(root);

        const first = await rebuildReport(runId, store, AGENTS_REGISTRY);
        const second = await rebuildReport(runId, store, AGENTS_REGISTRY);

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(second.value.markdown).toBe(first.value.markdown);
        expect(
          comparisonRows(first.value.markdown, 'task-1', SYNTHETIC_TASK_TITLE).map(
            (row) => row['Model'],
          ),
        ).toEqual([BETA_LINK, ALPHA_LINK]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('shows the new outcome and checks of a row after a manual verdict is recorded', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-eval-comparison-assess-'));
      try {
        const { runId, store } = await createRunWithPendingManualCheck(root);
        const before = await rebuildReport(runId, store, AGENTS_REGISTRY);
        expect(before.ok).toBe(true);
        if (!before.ok) return;

        const assessed = await assessCase(
          {
            runId,
            caseId: 'task-1--alpha--1',
            decisions: [
              {
                checkId: 'dod-manual-review',
                verdict: 'passed',
                assessor: 'curator',
                note: 'confirmed by reviewer',
                replaceExisting: false,
              },
              {
                checkId: 'man-optional-polish',
                verdict: 'passed',
                assessor: 'curator',
                note: 'polish confirmed',
                replaceExisting: false,
              },
            ],
            assessedAt: '2026-09-23T02:00:00.000Z',
          },
          store,
          AGENTS_REGISTRY,
        );

        expect(assessed.ok).toBe(true);
        const after = await readFile(join(root, 'artifacts', runId, 'report.md'), 'utf8');
        const summarize = (markdown: string): string[][] =>
          comparisonRows(markdown, 'task-1', SYNTHETIC_TASK_TITLE).map((row) => [
            row['Model'] ?? '',
            row['Outcome'] ?? '',
            row['Required checks'] ?? '',
          ]);
        expect(summarize(before.value.markdown)).toEqual([
          [BETA_LINK, `pending ${markers(1)}`, '1/2 passed, 1 pending'],
          [ALPHA_LINK, `pending ${markers(3)}`, '1/2 passed, 1 pending'],
        ]);
        expect(summarize(after)).toEqual([
          [BETA_LINK, `pending ${markers(1)}`, '1/2 passed, 1 pending'],
          [ALPHA_LINK, 'passed', '2/2 passed'],
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    describe('separation note', () => {
      const ROW_SETTINGS =
        'vendor/model-alpha-synth, effort-low; vendor/model-alpha-synth, effort-high';
      const PASSED_NOTE = separationNote('passed', {
        task: SYNTHETIC_TASK_TITLE,
        settings: ROW_SETTINGS,
      });
      const FAILED_NOTE = separationNote('failed', {
        task: SYNTHETIC_TASK_TITLE,
        settings: ROW_SETTINGS,
      });

      function allChecks(
        manual: CheckResult['verdict'],
        optional: CheckResult['verdict'],
      ): () => CheckResult[] {
        return () => [
          buildCheckResult({ checkId: 'acc-acceptance-command' }),
          buildCheckResult({
            checkId: 'dod-manual-review',
            category: 'definition-of-done',
            verdict: manual,
          }),
          buildCheckResult({
            checkId: 'man-optional-polish',
            category: 'definition-of-done',
            verdict: optional,
          }),
        ];
      }

      function decide(
        checkId: string,
        verdict: 'passed' | 'failed',
        replaceExisting = false,
      ): AssessmentDecision {
        return {
          checkId,
          verdict,
          assessor: 'curator',
          note: `${verdict} by curator`,
          replaceExisting,
        };
      }

      function decideBoth(verdict: 'passed' | 'failed'): AssessmentDecision[] {
        return [decide('dod-manual-review', verdict), decide('man-optional-polish', 'passed')];
      }

      async function recordVerdicts(
        root: string,
        runId: string,
        store: ReturnType<typeof createArtifactStore>,
        attempt: 'alpha' | 'beta',
        decisions: AssessmentDecision[],
      ): Promise<string[]> {
        const assessed = await assessCase(
          {
            runId,
            caseId: `task-1--${attempt}--1`,
            decisions,
            assessedAt: '2026-09-23T02:00:00.000Z',
          },
          store,
          AGENTS_REGISTRY,
        );
        expect(assessed.ok).toBe(true);
        const report = await readFile(join(root, 'artifacts', runId, 'report.md'), 'utf8');
        return separationNotesOf(report, 'task-1', SYNTHETIC_TASK_TITLE);
      }

      it('adds the note once the last waiting required verdict is recorded', async () => {
        const root = await mkdtemp(join(tmpdir(), 'tevu-eval-note-required-'));
        try {
          const { runId, store } = await createRunWithPendingManualCheck(root);
          const before = await rebuildReport(runId, store, AGENTS_REGISTRY);
          expect(before.ok).toBe(true);
          if (!before.ok) return;

          const afterFirst = await recordVerdicts(
            root,
            runId,
            store,
            'alpha',
            decideBoth('passed'),
          );
          const afterSecond = await recordVerdicts(
            root,
            runId,
            store,
            'beta',
            decideBoth('passed'),
          );

          expect(separationNotesOf(before.value.markdown, 'task-1', SYNTHETIC_TASK_TITLE)).toEqual(
            [],
          );
          expect(afterFirst).toEqual([]);
          expect(afterSecond).toEqual([PASSED_NOTE]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });

      it('waits for an optional verdict in a block whose attempts all passed until it is recorded', async () => {
        const root = await mkdtemp(join(tmpdir(), 'tevu-eval-note-optional-'));
        try {
          const { runId, store } = await createRunWithPendingManualCheck(
            root,
            allChecks('passed', 'pending'),
          );
          const before = await rebuildReport(runId, store, AGENTS_REGISTRY);
          expect(before.ok).toBe(true);
          if (!before.ok) return;

          const afterFirst = await recordVerdicts(
            root,
            runId,
            store,
            'alpha',
            decideBoth('passed'),
          );
          const afterSecond = await recordVerdicts(
            root,
            runId,
            store,
            'beta',
            decideBoth('passed'),
          );

          expect(
            comparisonRows(before.value.markdown, 'task-1', SYNTHETIC_TASK_TITLE).map(
              (row) => row['Outcome'],
            ),
          ).toEqual([`passed ${markers(1)}`, `passed ${markers(3)}`]);
          expect(separationNotesOf(before.value.markdown, 'task-1', SYNTHETIC_TASK_TITLE)).toEqual(
            [],
          );
          expect(afterFirst).toEqual([]);
          expect(afterSecond).toEqual([PASSED_NOTE]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });

      it('drops the note when a replaced verdict makes the outcomes differ and swaps it when every outcome fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'tevu-eval-note-drop-'));
        try {
          const { runId, store } = await createRunWithPendingManualCheck(root);
          await recordVerdicts(root, runId, store, 'alpha', decideBoth('passed'));
          const withNote = await recordVerdicts(root, runId, store, 'beta', decideBoth('passed'));

          const outcomesDiffer = await recordVerdicts(root, runId, store, 'beta', [
            decide('dod-manual-review', 'failed', true),
          ]);
          const everyOutcomeFailed = await recordVerdicts(root, runId, store, 'alpha', [
            decide('dod-manual-review', 'failed', true),
          ]);

          expect(withNote).toEqual([PASSED_NOTE]);
          expect(outcomesDiffer).toEqual([]);
          expect(everyOutcomeFailed).toEqual([FAILED_NOTE]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });

      it('rebuilds a byte-identical report.md that holds the note from unchanged artifacts', async () => {
        const root = await mkdtemp(join(tmpdir(), 'tevu-eval-note-regen-'));
        try {
          const { runId, store } = await createRunWithPendingManualCheck(
            root,
            allChecks('passed', 'passed'),
          );
          const reportPath = join(root, 'artifacts', runId, 'report.md');

          const first = await rebuildReport(runId, store, AGENTS_REGISTRY);
          const firstBytes = await readFile(reportPath, 'utf8');
          const second = await rebuildReport(runId, store, AGENTS_REGISTRY);
          const secondBytes = await readFile(reportPath, 'utf8');

          expect(first.ok && second.ok).toBe(true);
          expect(secondBytes).toBe(firstBytes);
          expect(separationNotesOf(firstBytes, 'task-1', SYNTHETIC_TASK_TITLE)).toEqual([
            PASSED_NOTE,
          ]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    });
  });
});

function storeAbortingOnReadAssessment(
  store: ArtifactStore,
  controller: AbortController,
): ArtifactStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'readAssessment') {
        return (runId: string, caseId: string) => {
          controller.abort();
          return target.readAssessment(runId, caseId);
        };
      }
      return Reflect.get(target, property) as unknown;
    },
  });
}

function storeFailingWriteReport(store: ArtifactStore): ArtifactStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'writeReport') {
        return (): Promise<TevuResult<void, 'ArtifactError'>> =>
          Promise.resolve({
            ok: false,
            error: {
              kind: 'ArtifactError',
              operation: 'write-report',
              reason: 'synthetic derived write failure',
            },
          });
      }
      return Reflect.get(target, property) as unknown;
    },
  });
}

async function readSyntheticAssessmentBytes(root: string, runId: string): Promise<string> {
  return readFile(caseFile(root, runId, 'task-1--alpha--1', 'assessment.json'), 'utf8');
}

describe('assessCase locking, revision, and recovery', () => {
  it('rejects assessment while another assessor holds the case lock and leaves every artifact byte unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-conflict-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const seeded = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(seeded.ok).toBe(true);
      const artifactPaths = [
        caseFile(root, runId, 'task-1--alpha--1', 'assessment.json'),
        caseFile(root, runId, 'task-1--alpha--1', 'result.json'),
        join(root, 'artifacts', runId, 'report.md'),
      ];
      const before = await Promise.all(artifactPaths.map((filePath) => readFile(filePath, 'utf8')));

      const lock = await store.acquireAssessmentLock(runId, 'task-1--alpha--1');
      expect(lock.ok).toBe(true);
      if (!lock.ok) return;

      const attempted = await assessCase(
        {
          runId,
          caseId: 'task-1--alpha--1',
          decisions: [
            {
              checkId: 'man-optional-polish',
              verdict: 'passed',
              assessor: 'second curator',
              note: 'confirmed independently',
              replaceExisting: false,
            },
          ],
          assessedAt: '2026-09-23T02:00:00.000Z',
        },
        store,
        AGENTS_REGISTRY,
      );

      expect(attempted.ok).toBe(false);
      if (attempted.ok || attempted.error.kind !== 'AssessmentConflictError') {
        throw new Error(`expected AssessmentConflictError, got ${JSON.stringify(attempted)}`);
      }
      expect(attempted.error.runId).toBe(runId);
      expect(attempted.error.caseId).toBe('task-1--alpha--1');
      expect(attempted.error.reason).toContain('assessment lock already exists');

      const after = await Promise.all(artifactPaths.map((filePath) => readFile(filePath, 'utf8')));
      expect(after).toEqual(before);

      const released = await lock.value.release();
      expect(released.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('increments the revision exactly once per invocation and moves replaced records to history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-revision-'));
    try {
      const { runId, store } = await createSyntheticRun(root);

      const assessed = await assessCase(
        {
          runId,
          caseId: 'task-1--alpha--1',
          decisions: [
            {
              checkId: 'dod-manual-review',
              verdict: 'failed',
              assessor: 'curator-2',
              note: 'regressed after rework',
              replaceExisting: true,
            },
            {
              checkId: 'man-optional-polish',
              verdict: 'passed',
              assessor: 'curator-2',
              note: 'polish confirmed',
              replaceExisting: false,
            },
          ],
          assessedAt: '2026-09-23T02:00:00.000Z',
        },
        store,
        AGENTS_REGISTRY,
      );

      expect(assessed.ok).toBe(true);
      if (!assessed.ok) return;
      expect(assessed.value.result.outcome).toBe('failed');
      expect(assessed.value.summary).toEqual([
        'vendor/model-alpha-synth, effort-high on "Synthetic welcome-route task": failed; required checks 1/2 passed, 1 failed.',
      ]);
      expect(
        assessed.value.result.checks.find((check) => check.checkId === 'dod-manual-review')
          ?.evidence,
      ).toContain(
        'manually assessed by curator-2 at 2026-09-23T02:00:00.000Z: regressed after rework',
      );

      const assessment = await store.readAssessment(runId, 'task-1--alpha--1');
      expect(assessment.ok).toBe(true);
      if (!assessment.ok || assessment.value === null) return;
      expect(assessment.value.revision).toBe(3);
      expect(assessment.value.current).toHaveLength(2);
      const currentByCheck = new Map(
        assessment.value.current.map((record) => [record.checkId, record]),
      );
      expect(currentByCheck.get('dod-manual-review')).toMatchObject({
        verdict: 'failed',
        assessor: 'curator-2',
        note: 'regressed after rework',
        assessedAt: '2026-09-23T02:00:00.000Z',
      });
      expect(currentByCheck.get('man-optional-polish')).toMatchObject({
        verdict: 'passed',
        assessor: 'curator-2',
      });
      expect(assessment.value.history).toHaveLength(2);
      expect(assessment.value.history[1]).toEqual({
        source: 'operator',
        checkId: 'dod-manual-review',
        verdict: 'passed',
        assessor: 'curator',
        note: 'confirmed by reviewer',
        assessedAt: '2026-09-23T01:00:00.000Z',
        replacedAt: '2026-09-23T02:00:00.000Z',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves unreplaced current assessment records unchanged while committing one revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-preserve-'));
    try {
      const { runId, store } = await createSyntheticRun(root);

      const assessed = await assessCase(
        {
          runId,
          caseId: 'task-1--alpha--1',
          decisions: [
            {
              checkId: 'man-optional-polish',
              verdict: 'passed',
              assessor: 'curator-2',
              note: 'polish confirmed',
              replaceExisting: false,
            },
          ],
          assessedAt: '2026-09-23T02:00:00.000Z',
        },
        store,
        AGENTS_REGISTRY,
      );

      expect(assessed.ok).toBe(true);
      if (!assessed.ok) return;
      expect(assessed.value.result.outcome).toBe('passed');
      expect(assessed.value.summary).toEqual([
        'vendor/model-alpha-synth, effort-high on "Synthetic welcome-route task": passed; required checks 2/2 passed.',
      ]);

      const assessment = await store.readAssessment(runId, 'task-1--alpha--1');
      expect(assessment.ok).toBe(true);
      if (!assessment.ok || assessment.value === null) return;
      expect(assessment.value.revision).toBe(3);
      const currentByCheck = new Map(
        assessment.value.current.map((record) => [record.checkId, record]),
      );
      expect(currentByCheck.get('dod-manual-review')).toEqual({
        checkId: 'dod-manual-review',
        verdict: 'passed',
        assessor: 'curator',
        note: 'confirmed by reviewer',
        assessedAt: '2026-09-23T01:00:00.000Z',
      });
      expect(assessment.value.history).toHaveLength(1);

      const run = await store.readRunResult(runId);
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.value.exitCode).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each<{
    scenario: string;
    decision: AssessmentDecision;
    message: string;
  }>([
    {
      scenario: 'the assessor name is empty',
      decision: {
        checkId: 'man-optional-polish',
        verdict: 'passed',
        assessor: '   ',
        note: 'confirmed',
        replaceExisting: false,
      },
      message: 'assessor must not be empty',
    },
    {
      scenario: 'a failed verdict carries no note',
      decision: {
        checkId: 'man-optional-polish',
        verdict: 'failed',
        assessor: 'curator-2',
        note: '  ',
        replaceExisting: false,
      },
      message: 'a failed verdict requires a non-empty note',
    },
    {
      scenario: 'an existing assessment is replaced without confirmation',
      decision: {
        checkId: 'dod-manual-review',
        verdict: 'passed',
        assessor: 'curator-2',
        note: 're-reviewed',
        replaceExisting: false,
      },
      message:
        'check "dod-manual-review" is already assessed; replacement must be selected and confirmed',
    },
    {
      scenario: 'replacement is declared for a check with no existing assessment',
      decision: {
        checkId: 'man-optional-polish',
        verdict: 'passed',
        assessor: 'curator-2',
        note: 'confirmed',
        replaceExisting: true,
      },
      message: 'check "man-optional-polish" has no existing assessment to replace',
    },
  ])(
    'rejects the whole invocation when $scenario and leaves the assessment and lock untouched',
    async ({ decision, message }) => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-eval-decision-'));
      try {
        const { runId, store } = await createSyntheticRun(root);
        const before = await readSyntheticAssessmentBytes(root, runId);

        const attempted = await assessCase(
          {
            runId,
            caseId: 'task-1--alpha--1',
            decisions: [decision],
            assessedAt: '2026-09-23T02:00:00.000Z',
          },
          store,
          AGENTS_REGISTRY,
        );

        expect(attempted.ok).toBe(false);
        if (attempted.ok || attempted.error.kind !== 'ConfigValidationError') {
          throw new Error(`expected ConfigValidationError, got ${JSON.stringify(attempted)}`);
        }
        expect(attempted.error.findings.some((finding) => finding.message === message)).toBe(true);
        expect(await readSyntheticAssessmentBytes(root, runId)).toBe(before);

        const lock = await store.acquireAssessmentLock(runId, 'task-1--alpha--1');
        expect(lock.ok).toBe(true);
        if (lock.ok) {
          const released = await lock.value.release();
          expect(released.ok).toBe(true);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('stops before committing when cancellation fires mid-invocation and releases the lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-cancel-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const before = await readSyntheticAssessmentBytes(root, runId);
      const controller = new AbortController();

      const attempted = await assessCase(
        {
          runId,
          caseId: 'task-1--alpha--1',
          decisions: [
            {
              checkId: 'man-optional-polish',
              verdict: 'passed',
              assessor: 'curator-2',
              note: 'confirmed',
              replaceExisting: false,
            },
          ],
          assessedAt: '2026-09-23T02:00:00.000Z',
          cancellation: controller.signal,
        },
        storeAbortingOnReadAssessment(store, controller),
        AGENTS_REGISTRY,
      );

      expect(attempted.ok).toBe(false);
      if (attempted.ok || attempted.error.kind !== 'CancellationError') {
        throw new Error(`expected CancellationError, got ${JSON.stringify(attempted)}`);
      }
      expect(attempted.error.activeCaseIds).toEqual([]);
      expect(await readSyntheticAssessmentBytes(root, runId)).toBe(before);

      const reacquired = await store.acquireAssessmentLock(runId, 'task-1--alpha--1');
      expect(reacquired.ok).toBe(true);
      if (reacquired.ok) {
        const released = await reacquired.value.release();
        expect(released.ok).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the committed assessment when a derived write fails and recovers through rebuildReport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-recover-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const reportPath = join(root, 'artifacts', runId, 'report.md');
      expect(existsSync(reportPath)).toBe(false);

      const attempted = await assessCase(
        {
          runId,
          caseId: 'task-1--alpha--1',
          decisions: [
            {
              checkId: 'man-optional-polish',
              verdict: 'passed',
              assessor: 'curator-2',
              note: 'polish confirmed',
              replaceExisting: false,
            },
          ],
          assessedAt: '2026-09-23T02:00:00.000Z',
        },
        storeFailingWriteReport(store),
        AGENTS_REGISTRY,
      );

      expect(attempted.ok).toBe(false);
      if (attempted.ok || attempted.error.kind !== 'ArtifactError') {
        throw new Error(`expected ArtifactError, got ${JSON.stringify(attempted)}`);
      }
      expect(attempted.error.operation).toBe('assess-case');
      expect(attempted.error.reason).toContain('is committed');
      expect(attempted.error.reason).toContain(`tevu report ${runId}`);

      const committed = await store.readAssessment(runId, 'task-1--alpha--1');
      expect(committed.ok).toBe(true);
      if (!committed.ok || committed.value === null) return;
      expect(committed.value.revision).toBe(3);
      expect(committed.value.current.map((record) => record.checkId).sort()).toEqual([
        'dod-manual-review',
        'man-optional-polish',
      ]);

      const recovered = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;
      const repeat = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(repeat.ok).toBe(true);
      if (!repeat.ok) return;
      expect(repeat.value.normalizedJson).toBe(recovered.value.normalizedJson);
      expect(repeat.value.markdown).toBe(recovered.value.markdown);
      expect(existsSync(reportPath)).toBe(true);

      const derived = await store.readCaseResult(runId, 'task-1--alpha--1');
      expect(derived.ok).toBe(true);
      if (!derived.ok) return;
      expect(derived.value.outcome).toBe('passed');
      const polish = derived.value.checks.find((check) => check.checkId === 'man-optional-polish');
      expect(polish?.verdict).toBe('passed');
      expect(polish?.evidence).toContain('manually assessed by curator-2');

      const assessmentAfterRecovery = await store.readAssessment(runId, 'task-1--alpha--1');
      expect(assessmentAfterRecovery.ok).toBe(true);
      if (!assessmentAfterRecovery.ok || assessmentAfterRecovery.value === null) return;
      expect(assessmentAfterRecovery.value.revision).toBe(3);
      expect(recovered.value.normalizedJson).toContain('polish confirmed');

      const run = await store.readRunResult(runId);
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.value.exitCode).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Credential-secret redaction at serialization boundaries.
//
// Corpus from the JSON/YAML value grammar: a secret containing newline, quote,
// and backslash (serializers escape it, so a literal byte match on serialized
// output can never find it), and a digit-only secret equal to a legitimate
// numeric metric value (byte-level replacement corrupts numbers and framing).
//
// This corpus keeps an opencode-shaped literal on purpose: the store persists
// an opaque record regardless of shape, and this block proves redaction
// survives a realistic nested JSON grammar rather than exercising any
// agent-specific decoding.

/** Structural identity shared by every opencode-shaped test message part. */
type RedactionTestPart = { id: string; sessionID: string; messageID: string; type: string };

/** opencode-shaped root-session export literal used only as a redaction test fixture. */
type RedactionTestExport = {
  info: { id: string; parentID?: string };
  messages: Array<{
    info:
      | { id: string; sessionID: string; role: 'user' }
      | {
          id: string;
          sessionID: string;
          role: 'assistant';
          parentID: string;
          finish?: string;
          cost: number;
          tokens: {
            input: number;
            output: number;
            reasoning: number;
            cache: { read: number; write: number };
          };
        };
    parts: RedactionTestPart[];
  }>;
};

/** opencode-shaped run event literal used only as a redaction test fixture. */
type RedactionTestEvent = {
  type: 'error';
  timestamp: number;
  sessionID: string;
  error: { message: string };
};

const QUOTED_SECRET = 'tevu"sec\\ret\nx';
const TOKEN_DIGIT_SECRET = '120';
const YAML_DIGIT_SECRET = '1000';

function buildRedactionExport(): RedactionTestExport {
  const userPart: Record<string, unknown> = {
    id: 'prt-u1',
    sessionID: 'ses-redact-0001',
    messageID: 'msg-u1',
    type: 'text',
    text: `approval code ${TOKEN_DIGIT_SECRET} attached`,
  };
  return {
    info: { id: 'ses-redact-0001' },
    messages: [
      {
        info: { id: 'msg-u1', sessionID: 'ses-redact-0001', role: 'user' },
        parts: [userPart as unknown as RedactionTestPart],
      },
      {
        info: {
          id: 'msg-a1',
          sessionID: 'ses-redact-0001',
          role: 'assistant',
          parentID: 'msg-u1',
          finish: 'stop',
          cost: 0.0125,
          tokens: { input: 120, output: 45, reasoning: 16, cache: { read: 30, write: 10 } },
        },
        parts: [],
      },
    ],
  };
}

describe('credential-secret redaction at serialization boundaries', () => {
  it('removes a secret containing newline, quote, and backslash from the decoded session export sink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-redact-json-'));
    try {
      const runId = '20260923t030000z-redact';
      const store = createArtifactStore({
        artifactsDirectory: join(root, 'artifacts'),
        redact: createRedactor([QUOTED_SECRET]),
      });
      const started = await store.startRun(
        buildManifest(runId, buildSyntheticConfig(), buildCapabilityReport(), ['task-1--alpha--1']),
      );
      expect(started.ok).toBe(true);
      const exportWithSecret = buildRedactionExport();
      (exportWithSecret.messages[0].parts[0] as unknown as { text: string }).text =
        `note ${QUOTED_SECRET} end`;

      const written = await store.writeSessionExport('task-1--alpha--1', exportWithSecret);
      expect(written.ok).toBe(true);
      const raw = await readFile(caseFile(root, runId, 'task-1--alpha--1', 'session.json'), 'utf8');
      const storedDocument = JSON.parse(raw) as unknown;
      expect(storedDocument).toMatchObject({ info: { id: 'ses-redact-0001' } });
      const readBack = await store.readSessionExport(runId, 'task-1--alpha--1');
      expect(readBack.ok).toBe(true);
      if (!readBack.ok || readBack.value === null) return;
      // The store persists an opaque record; this fixture's own shape is
      // known here only because the test constructed it.
      const readBackExport = readBack.value as unknown as RedactionTestExport;
      const text = (readBackExport.messages[0].parts[0] as Record<string, unknown>)['text'];
      expect(typeof text).toBe('string');
      expect(
        String(text).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
      ).not.toContain(QUOTED_SECRET);
      expect(String(text)).not.toContain(QUOTED_SECRET);
      expect(String(text)).toContain('[REDACTED]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a digit-only secret equal to a token metric unchanged in numbers while redacting its string occurrences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-redact-digit-'));
    try {
      const runId = '20260923t030000z-redact';
      const store = createArtifactStore({
        artifactsDirectory: join(root, 'artifacts'),
        redact: createRedactor([TOKEN_DIGIT_SECRET]),
      });
      const started = await store.startRun(
        buildManifest(runId, buildSyntheticConfig(), buildCapabilityReport(), ['task-1--alpha--1']),
      );
      expect(started.ok).toBe(true);

      const written = await store.writeSessionExport('task-1--alpha--1', buildRedactionExport());
      expect(written.ok).toBe(true);
      const raw = await readFile(caseFile(root, runId, 'task-1--alpha--1', 'session.json'), 'utf8');
      const storedDocument = JSON.parse(raw) as {
        messages: Array<{
          info: { tokens?: { input?: unknown; output?: unknown }; cost?: unknown };
        }>;
      };
      expect(typeof storedDocument.messages[1].info.tokens?.input).toBe('number');
      expect(storedDocument.messages[1].info.tokens?.input).toBe(120);
      expect(storedDocument.messages[1].info.cost).toBe(0.0125);
      const readBack = await store.readSessionExport(runId, 'task-1--alpha--1');
      expect(readBack.ok).toBe(true);
      if (!readBack.ok || readBack.value === null) return;
      // The store persists an opaque record; this fixture's own shape is
      // known here only because the test constructed it.
      const readBackExport = readBack.value as unknown as RedactionTestExport;
      const assistantInfo = readBackExport.messages[1].info as unknown as {
        tokens?: { input?: unknown; output?: unknown };
        cost?: unknown;
      };
      expect(assistantInfo.tokens?.input).toBe(120);
      expect(assistantInfo.cost).toBe(0.0125);
      const userText = (readBackExport.messages[0].parts[0] as Record<string, unknown>)['text'];
      expect(String(userText)).not.toContain(TOKEN_DIGIT_SECRET);
      expect(String(userText)).toContain('[REDACTED]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes an escape-serialized secret from the decoded events JSONL sink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-redact-jsonl-'));
    try {
      const runId = '20260923t030000z-redact';
      const store = createArtifactStore({
        artifactsDirectory: join(root, 'artifacts'),
        redact: createRedactor([QUOTED_SECRET]),
      });
      const started = await store.startRun(
        buildManifest(runId, buildSyntheticConfig(), buildCapabilityReport(), ['task-1--alpha--1']),
      );
      expect(started.ok).toBe(true);
      const secretEvent: RedactionTestEvent = {
        type: 'error',
        timestamp: 4000,
        sessionID: 'ses-redact-0001',
        error: { message: `provider said ${QUOTED_SECRET} today` },
      };
      const appended = await store.appendEvent('task-1--alpha--1', secretEvent);
      expect(appended.ok).toBe(true);

      const raw = await readFile(caseFile(root, runId, 'task-1--alpha--1', 'events.jsonl'), 'utf8');
      const storedLine = raw.trim();
      expect(() => JSON.parse(storedLine)).not.toThrow();
      const readBack = await store.readEvents(runId, 'task-1--alpha--1');
      expect(readBack.ok).toBe(true);
      if (!readBack.ok) return;
      const errorPayload = readBack.value[0] as unknown as { error: { message?: unknown } };
      const message = String(errorPayload.error['message']);
      expect(String(message)).not.toContain(QUOTED_SECRET);
      expect(String(message)).toContain('[REDACTED]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redacts an escape-serialized secret from the YAML configuration sink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-redact-yaml-'));
    try {
      const configPath = join(root, 'tevu.yaml');
      // This round trip writes the config and re-validates it against the
      // strict schema, which accepts only the literal "opencode" key, so it
      // stays un-rekeyed rather than using "fake-agent".
      const config = buildSyntheticConfig(join(root, 'artifacts'));
      config.repositories[0].path = join(root, 'repo-1');
      config.tasks[0].prompt = `note ${QUOTED_SECRET} end`;
      const redact = createRedactor([QUOTED_SECRET]);
      // A materialized TevuConfig is always a valid TevuConfigInput value (every
      // default already filled in); the compiler cannot see that a Record-typed
      // agents block still holds the schema-derived literal key at runtime.
      const rendered = renderConfigDocument(config as unknown as TevuConfigInput, { redact });
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;
      const configStore = createConfigStore({ redact });

      const replaced = await configStore.replaceText(configPath, rendered.value);
      expect(replaced.ok).toBe(true);
      const loaded = await loadConfig(configPath, configStore, undefined);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.run.stop_grace).toBe('1s');
      expect(loaded.value.tasks[0].prompt).not.toContain(QUOTED_SECRET);
      expect(loaded.value.tasks[0].prompt).toContain('[REDACTED]');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a digit-only secret equal to a configured duration intact in the YAML sink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-redact-yaml-digit-'));
    try {
      const configPath = join(root, 'tevu.yaml');
      const config = buildSyntheticConfig(join(root, 'artifacts'));
      config.repositories[0].path = join(root, 'repo-1');
      const redact = createRedactor([YAML_DIGIT_SECRET]);
      // A materialized TevuConfig is always a valid TevuConfigInput value (every
      // default already filled in); the compiler cannot see that a Record-typed
      // agents block still holds the schema-derived literal key at runtime.
      const rendered = renderConfigDocument(config as unknown as TevuConfigInput, { redact });
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;
      const configStore = createConfigStore({ redact });

      const replaced = await configStore.replaceText(configPath, rendered.value);
      expect(replaced.ok).toBe(true);
      const loaded = await loadConfig(configPath, configStore, undefined);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.run.stop_grace).toBe('1s');
      expect(loaded.value.run.concurrency).toBe(2);
      expect(loaded.value.version).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function buildGrader(overrides: Partial<GraderIdentity> = {}): GraderIdentity {
  return { model: 'openai/grader-model', effort: 'high', agent: AGENT_NAME, ...overrides };
}

function buildGradingArtifact(overrides: Partial<GradingArtifact> = {}): GradingArtifact {
  const call = overrides.call ?? { status: 'replied', reply: '{"grades":[]}' };
  const metrics = overrides.metrics ?? unavailableAgentMetrics('unused in this fixture');
  return {
    schemaVersion: 1,
    runId: '20260923t000000z-grading',
    caseId: 'task-1--alpha--1',
    grader: buildGrader(),
    call,
    calls: [
      buildGraderCall({
        outcome: call.status === 'replied' ? { status: 'replied' } : call,
        metrics,
      }),
    ],
    metrics,
    grades: [],
    ...overrides,
  };
}

function buildGradingManifest(
  caseIds: readonly string[],
  grader: RunManifest['efforts']['grader'] = { status: 'verified' },
): RunManifest {
  return {
    schemaVersion: 1,
    runId: '20260923t000000z-grading',
    configDigest: 'sha256-grading-digest',
    configPath: '/synthetic/tevu.yaml',
    startedAt: '2026-09-23T00:00:00.000Z',
    completedAt: '2026-09-23T00:05:00.000Z',
    host: { platform: 'linux', nodeVersion: 'v24.21.0' },
    tools: {
      gitVersion: 'git version 2.45.0',
      agentVersions: { [AGENT_NAME]: null },
      agentConfigurationFiles: {},
      copiedProviders: {},
    },
    execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 1, source: 'config' } },
    efforts: buildEfforts(['alpha'], grader),
    cases: caseIds.map((caseId) => buildCaseIdentity({ caseId })),
  };
}

describe('grading rendered in the report', () => {
  function buildGradedTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return buildTaskRecord({
      checks: [
        buildCheckRecord({
          id: 'csv-content',
          description: 'escapes every value correctly',
          evaluator: 'grader',
        }),
      ],
      ...overrides,
    });
  }

  it('renders the grader run-section line, one grade line per check, and the separate Grader metrics block', () => {
    const graderCase = buildCaseResult({
      checks: [
        buildCheckResult({
          checkId: 'csv-content',
          verdict: 'passed',
          evidence: `graded passed by ${buildGrader().model} (effort high, agent ${AGENT_NAME}): lines 1-4 add escaping`,
        }),
      ],
      artifacts: buildArtifactIndex('task-1--alpha--1', new Set(['result', 'grading'])),
    });
    const grading = buildGradingArtifact({
      grades: [
        {
          checkId: 'csv-content',
          category: 'acceptance',
          status: 'graded',
          verdict: 'passed',
          rationale: 'lines 1-4 add escaping',
        },
      ],
    });
    const input: ReportInput = {
      run: {
        schemaVersion: 1,
        manifest: buildGradingManifest(['task-1--alpha--1']),
        cases: [graderCase],
        findings: [],
        exitCode: 0,
      },
      capabilities: {},
      tasks: [buildGradedTaskRecord()],
      models: [],
      repositories: [],
      assessments: [],
      gradings: [grading],
    };

    const markdown = buildReport(input).markdown;

    expect(markdown).toContain('- Grader: openai/grader-model (effort high, agent fake-agent)');
    expect(markdown).toContain('Grades by openai/grader-model (effort high, agent fake-agent):');
    expect(markdown).toContain('- escapes every value correctly: passed. lines 1-4 add escaping');
    expect(markdown).toContain(
      'Grader metrics (separate from the agent metrics above; never added to them):',
    );
    expect(markdown).toContain('- Grading: [grading.json](cases/task-1--alpha--1/grading.json)');
  });

  it.each([
    {
      name: 'an unverified check',
      check: { status: 'unverified', reason: 'no variant data was reported' } as const,
      label: 'high, unverified',
      explanation:
        '. tevu could not confirm that the agent offers effort "high" for this model. The effort was passed as requested; if the agent does not offer it, the model ran with its default options. Before the next run, check the effort against the variants the agent lists for the model. Technical detail: no variant data was reported',
    },
    {
      name: 'an unsupported check',
      check: { status: 'unsupported', reason: 'a grader call would use defaults' } as const,
      label: 'high, unsupported',
      explanation:
        '. The agent does not list effort "high" for this model. Where no task repository defines it, the model ran with its default options. Choose an effort the agent lists for the model and run the comparison again. Technical detail: a grader call would use defaults',
    },
    {
      name: 'a verified check',
      check: { status: 'verified' } as const,
      label: 'high',
      explanation: '',
    },
    { name: 'no recorded check', check: null, label: 'high, not checked', explanation: '' },
  ])('labels the grader effort and explains it for $name', ({ check, label, explanation }) => {
    const input: ReportInput = {
      run: {
        schemaVersion: 1,
        manifest: buildGradingManifest(['task-1--alpha--1'], check),
        cases: [
          buildCaseResult({
            artifacts: buildArtifactIndex('task-1--alpha--1', new Set(['result', 'grading'])),
          }),
        ],
        findings: [],
        exitCode: 0,
      },
      capabilities: {},
      tasks: [buildGradedTaskRecord()],
      models: [],
      repositories: [],
      assessments: [],
      gradings: [buildGradingArtifact()],
    };

    const markdown = buildReport(input).markdown;

    expect(markdown).toContain(
      `- Grader: openai/grader-model (effort ${label}, agent fake-agent)${explanation}\n`,
    );
    expect(markdown).toContain(
      `Grades by openai/grader-model (effort ${label}, agent fake-agent):\n`,
    );
  });

  it('keeps the grader check out of the model entry lines and case labels', () => {
    const input: ReportInput = {
      run: {
        schemaVersion: 1,
        manifest: buildGradingManifest(['task-1--alpha--1'], {
          status: 'unsupported',
          reason: 'grader-only reason',
        }),
        cases: [
          buildCaseResult({
            artifacts: buildArtifactIndex('task-1--alpha--1', new Set(['result', 'grading'])),
          }),
        ],
        findings: [],
        exitCode: 0,
      },
      capabilities: {},
      tasks: [buildGradedTaskRecord()],
      models: [{ id: 'alpha', model: 'vendor/model-alpha-synth', effort: 'effort-high' }],
      repositories: [],
      assessments: [],
      gradings: [buildGradingArtifact()],
    };

    const markdown = buildReport(input).markdown;

    expect(markdown).toContain('\n- vendor/model-alpha-synth, effort-high: effort verified\n');
    expect(markdown).toContain('[vendor/model-alpha-synth, effort-high](#case-task-1--alpha--1)');
    expect(markdown).not.toContain('effort-high, unsupported');
  });

  it('does not read an inherited property as the check of a model entry id', () => {
    const input: ReportInput = {
      run: {
        schemaVersion: 1,
        manifest: buildGradingManifest(['task-1--alpha--1']),
        cases: [buildCaseResult()],
        findings: [],
        exitCode: 0,
      },
      capabilities: {},
      tasks: [buildGradedTaskRecord()],
      models: [{ id: 'constructor', model: 'vendor/model-ctor-synth', effort: 'e' }],
      repositories: [],
      assessments: [],
      gradings: [],
    };

    const markdown = buildReport(input).markdown;

    expect(markdown).toContain('\n- vendor/model-ctor-synth, e: effort not checked\n');
  });

  it('renders the shared-model-entry note only when the grader model equals a benchmarked model entry exactly', () => {
    const buildInput = (models: ReportInput['models']): ReportInput => ({
      run: {
        schemaVersion: 1,
        manifest: buildGradingManifest(['task-1--alpha--1']),
        cases: [
          buildCaseResult({
            artifacts: buildArtifactIndex('task-1--alpha--1', new Set(['result', 'grading'])),
          }),
        ],
        findings: [],
        exitCode: 0,
      },
      capabilities: {},
      tasks: [buildGradedTaskRecord()],
      models,
      repositories: [],
      assessments: [],
      gradings: [buildGradingArtifact()],
    });

    const withSharedEntry = buildReport(
      buildInput([
        { id: 'benched-grader', model: 'openai/grader-model', effort: 'medium' },
        { id: 'benched-grader-low', model: 'openai/grader-model', effort: 'low' },
      ]),
    ).markdown;
    const withoutSharedEntry = buildReport(
      buildInput([{ id: 'other-model', model: 'openai/other-model', effort: 'medium' }]),
    ).markdown;

    expect(withSharedEntry).toContain(
      '- Grader model openai/grader-model is also benchmarked as openai/grader-model, medium; openai/grader-model, low (informational; tevu does not forbid it)',
    );
    expect(withoutSharedEntry).not.toContain('is also benchmarked as');
  });

  it('explains a no-reply grading in the grades block and as the pending state of the attempt, keeping the reason in the technical detail', () => {
    const pendingCase = buildCaseResult({
      outcome: 'pending',
      checks: [
        buildCheckResult({
          checkId: 'csv-content',
          verdict: 'pending',
          evidence:
            'not graded: the grader call failed: ModelCallError (timed-out): run process did not finish within 30000ms',
          durationMs: null,
        }),
      ],
      artifacts: buildArtifactIndex('task-1--alpha--1', new Set(['result', 'grading'])),
    });
    const grading = buildGradingArtifact({
      call: {
        status: 'no-reply',
        cause: 'other',
        reason:
          'the grader call failed: ModelCallError (timed-out): run process did not finish within 30000ms',
      },
      grades: [
        {
          checkId: 'csv-content',
          category: 'acceptance',
          status: 'pending',
          reason:
            'the grader call failed: ModelCallError (timed-out): run process did not finish within 30000ms',
        },
      ],
    });
    const input: ReportInput = {
      run: {
        schemaVersion: 1,
        manifest: buildGradingManifest(['task-1--alpha--1']),
        cases: [pendingCase],
        findings: [],
        exitCode: 2,
      },
      capabilities: {},
      tasks: [buildGradedTaskRecord()],
      models: [],
      repositories: [],
      assessments: [],
      gradings: [grading],
    };

    const markdown = buildReport(input).markdown;

    const reason =
      'the grader call failed: ModelCallError (timed-out): run process did not finish within 30000ms';
    const assess = '`tevu assess 20260923t000000z-grading task-1--alpha--1`';
    expect(markdown).toContain(
      `\nThe grading model returned no verdict for this solution, so 1 required graded check waits for a person's verdict. The outcome stays pending until every required check has a verdict. Record the verdict with ${assess}. Technical detail: case task-1--alpha--1: ${reason}\n`,
    );
    expect(markdown).toContain(
      `Grades by openai/grader-model (effort high, agent fake-agent):\n\n- The grading model returned no verdict for this solution, so 1 required graded check still waits for a person's verdict. The grader total for the task counts a measurement of this grading only when tevu has it for the whole grading. Record the verdict with ${assess}. Technical detail: case task-1--alpha--1: ${reason}\n- escapes every value correctly: no verdict.\n`,
    );
    expect(markdown).not.toContain('Pending graded checks:');
    expect(markdown).not.toContain('Grader call:');
  });

  it('keeps case metrics and grader metrics in separate blocks, sharing no field, and reports a costless grader export as unavailable with its reason', () => {
    const caseResult = buildCaseResult({
      metrics: {
        ...unavailableBenchmarkMetrics('unused'),
        cost: {
          value: 1.23,
          unit: 'USD',
          availability: { status: 'available', source: 'root-session export' },
          scope: 'root-session',
        },
      },
      checks: [buildCheckResult({ checkId: 'csv-content' })],
      artifacts: buildArtifactIndex('task-1--alpha--1', new Set(['result', 'grading'])),
    });
    const grading = buildGradingArtifact({
      metrics: {
        ...unavailableAgentMetrics('field "cost" is absent in export message "msg-1"'),
      },
      grades: [
        {
          checkId: 'csv-content',
          category: 'acceptance',
          status: 'graded',
          verdict: 'passed',
          rationale: 'ok',
        },
      ],
    });
    const input: ReportInput = {
      run: {
        schemaVersion: 1,
        manifest: buildGradingManifest(['task-1--alpha--1']),
        cases: [caseResult],
        findings: [],
        exitCode: 0,
      },
      capabilities: {},
      tasks: [buildGradedTaskRecord()],
      models: [],
      repositories: [],
      assessments: [],
      gradings: [grading],
    };

    const markdown = buildReport(input).markdown;
    const metricsIndex = markdown.indexOf('Metrics:');
    const gradesIndex = markdown.indexOf('Grades by');
    const graderMetricsIndex = markdown.indexOf('Grader metrics');

    expect(metricsIndex).toBeGreaterThan(-1);
    expect(gradesIndex).toBeGreaterThan(metricsIndex);
    expect(graderMetricsIndex).toBeGreaterThan(gradesIndex);
    expect(markdown.slice(metricsIndex, gradesIndex)).toContain('\n- Cost: $1.2300\n');
    const graderMetrics = markdown.slice(graderMetricsIndex, markdown.indexOf('Artifacts:'));
    expect(graderMetrics).not.toContain('$1.2300');
    expect(graderMetrics).toContain(
      '- Not measured: Cost, Turns, API calls, Tool calls, Skill calls, Input tokens, Cache read tokens, Cache write tokens, Output tokens, Reasoning tokens, API errors. tevu has no value for these measurements.',
    );
    expect(graderMetrics).toContain(
      'Technical detail: field "cost" is absent in export message "msg-1"',
    );
  });
});

describe('grading and report regeneration stay byte-identical (P7)', () => {
  const CALL_RECORDS = {
    events: [{ type: 'text', part: { text: 'EVENT_RECORD_MARKER' } }],
    diagnostics: 'DIAGNOSTICS_MARKER',
    session: { info: { id: 'SESSION_RECORD_MARKER' } },
  };

  async function createGradedSyntheticRun(root: string): Promise<{
    runId: string;
    store: ReturnType<typeof createArtifactStore>;
  }> {
    const runId = '20260923t000000z-grading-regen';
    const store = createArtifactStore({
      artifactsDirectory: join(root, 'artifacts'),
      redact: (text) => text,
    });
    const config = rekeyToFakeAgent(buildSyntheticConfig());
    const configWithGrader: TevuConfig = {
      ...config,
      roles: { grader: buildGrader() },
    };
    const manifest = buildManifest(runId, configWithGrader, buildCapabilityReport(), [
      'task-1--alpha--1',
    ]);
    const started = await store.startRun(manifest);
    if (!started.ok) {
      throw new Error(`startRun failed: ${JSON.stringify(started.error)}`);
    }
    const caseResult = buildCaseResult({
      checks: [
        buildCheckResult({
          checkId: 'acc-acceptance-command',
          evidence: `graded passed by ${buildGrader().model} (effort high, agent ${AGENT_NAME}): ok`,
        }),
      ],
      artifacts: buildArtifactIndex('task-1--alpha--1', new Set(['result', 'checks', 'grading'])),
    });
    await writeChecksOrThrow(store, 'task-1--alpha--1', caseResult.checks);
    const gradingWrite = await store.writeGrading(
      'task-1--alpha--1',
      buildGradingArtifact({
        runId,
        calls: [buildGraderCall(CALL_RECORDS)],
        grades: [
          {
            checkId: 'acc-acceptance-command',
            category: 'acceptance',
            status: 'graded',
            verdict: 'passed',
            rationale: 'ok',
          },
        ],
      }),
    );
    if (!gradingWrite.ok) {
      throw new Error(`writeGrading failed: ${JSON.stringify(gradingWrite.error)}`);
    }
    const finalized = await store.finalizeCase(caseResult);
    if (!finalized.ok) {
      throw new Error(`finalizeCase failed: ${JSON.stringify(finalized.error)}`);
    }
    const run: RunResult = {
      schemaVersion: 1,
      manifest,
      cases: [caseResult],
      findings: [],
      exitCode: 0,
    };
    const runFinalized = await store.finalizeRun(run);
    if (!runFinalized.ok) {
      throw new Error(`finalizeRun failed: ${JSON.stringify(runFinalized.error)}`);
    }
    return { runId, store };
  }

  it('regenerates byte-identical output across two runs, and reads only saved grades: rebuildReport calls no AgentAdapter method other than normalizeMetrics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-grading-regen-'));
    try {
      const { runId, store } = await createGradedSyntheticRun(root);

      const first = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(first.ok).toBe(true);
      const second = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      expect(second.value.normalizedJson).toBe(first.value.normalizedJson);
      expect(second.value.markdown).toBe(first.value.markdown);
      expect(first.value.markdown).toContain('Grades by openai/grader-model');
      expect(first.value.markdown).toContain(
        '- Grader: openai/grader-model (effort high, agent fake-agent)',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the run events, diagnostics, and session export of every grader call out of the normalized JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-grading-records-'));
    try {
      const { runId, store } = await createGradedSyntheticRun(root);

      const rebuilt = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;
      const normalized = JSON.parse(rebuilt.value.normalizedJson) as {
        gradings: { calls: Record<string, unknown>[] }[];
      };
      const calls = normalized.gradings.flatMap((grading) => grading.calls);
      expect(calls.map((call) => Object.keys(call).sort())).toEqual([['metrics', 'outcome']]);
      for (const marker of ['EVENT_RECORD_MARKER', 'DIAGNOSTICS_MARKER', 'SESSION_RECORD_MARKER']) {
        expect(rebuilt.value.normalizedJson).not.toContain(marker);
        expect(rebuilt.value.markdown).not.toContain(marker);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('assessCase for graded checks (P9)', () => {
  function buildGradedAssessmentConfig(): TevuConfig {
    const input: TevuConfigInput = {
      version: 1,
      run: {
        output_dir: '/tevu-synthetic/artifacts',
        concurrency: 1,
        timeout: '60s',
        stop_grace: '1s',
      },
      agents: { opencode: { command: '/synthetic/opencode', secrets: [], env: [] } },
      repositories: [buildRepository()],
      models: [buildModel(), buildModel({ id: 'beta', effort: 'effort-low' })],
      roles: { grader: { model: 'openai/grader-model', effort: 'high' } },
      tasks: [
        {
          id: 'graded-assess-task',
          title: 'Graded assessment task',
          repo: 'repo-1',
          base_commit: '0123456789abcdef0123456789abcdef01234567',
          description: 'synthetic graded assessment task',
          prompt: 'synthetic graded assessment prompt',
          readiness: ['synthetic ready item'],
          checks: {
            acceptance: [{ id: 'graded-check', description: 'The criterion holds.' }],
            done: [buildCheckDefinition({ id: 'trivial-done' })],
          },
        },
      ],
    };
    return rekeyToFakeAgent(TevuConfigSchema.parse(input));
  }

  type GradeScenario = 'passed' | 'failed' | 'undetermined' | 'pending' | 'none';

  async function createGradedAssessmentRun(
    root: string,
    scenario: GradeScenario,
  ): Promise<{
    runId: string;
    store: ReturnType<typeof createArtifactStore>;
    grader: GraderIdentity;
  }> {
    const runId = `20260923t000000z-assess-${scenario}`;
    const store = createArtifactStore({
      artifactsDirectory: join(root, 'artifacts'),
      redact: (text) => text,
    });
    const config = buildGradedAssessmentConfig();
    const capabilities = buildCapabilityReport();
    const manifest = buildManifest(runId, config, capabilities, ['graded-assess-task--alpha--1']);
    const started = await store.startRun(manifest);
    if (!started.ok) {
      throw new Error(`startRun failed: ${JSON.stringify(started.error)}`);
    }
    const grader = buildGrader();
    const hasGrading = scenario !== 'none';
    const checks = [
      buildCheckResult({
        checkId: 'graded-check',
        verdict: scenario === 'passed' ? 'passed' : scenario === 'failed' ? 'failed' : 'pending',
        evidence: 'synthetic evidence',
        durationMs: scenario === 'passed' || scenario === 'failed' ? 12 : null,
      }),
      buildCheckResult({ checkId: 'trivial-done', category: 'definition-of-done' }),
    ];
    await writeChecksOrThrow(store, 'graded-assess-task--alpha--1', checks);
    if (hasGrading) {
      const grade: GradingArtifact['grades'][number] =
        scenario === 'pending'
          ? {
              checkId: 'graded-check',
              category: 'acceptance',
              status: 'pending',
              reason: 'the grader call failed',
            }
          : {
              checkId: 'graded-check',
              category: 'acceptance',
              status: 'graded',
              verdict: scenario,
              rationale: 'rationale text',
            };
      const gradingWrite = await store.writeGrading('graded-assess-task--alpha--1', {
        grader,
        call: { status: 'replied', reply: '{"grades":[]}' },
        calls: [buildGraderCall({ metrics: unavailableAgentMetrics('unused in this fixture') })],
        metrics: unavailableAgentMetrics('unused in this fixture'),
        grades: [grade],
      });
      if (!gradingWrite.ok) {
        throw new Error(`writeGrading failed: ${JSON.stringify(gradingWrite.error)}`);
      }
    }
    const caseResult = buildCaseResult({
      identity: buildCaseIdentity({
        caseId: 'graded-assess-task--alpha--1',
        taskId: 'graded-assess-task',
      }),
      checks,
      artifacts: buildArtifactIndex(
        'graded-assess-task--alpha--1',
        new Set(hasGrading ? ['result', 'checks', 'grading'] : ['result', 'checks']),
      ),
    });
    const finalized = await store.finalizeCase(caseResult);
    if (!finalized.ok) {
      throw new Error(`finalizeCase failed: ${JSON.stringify(finalized.error)}`);
    }
    const run: RunResult = {
      schemaVersion: 1,
      manifest,
      cases: [caseResult],
      findings: [],
      exitCode: 2,
    };
    const runFinalized = await store.finalizeRun(run);
    if (!runFinalized.ok) {
      throw new Error(`finalizeRun failed: ${JSON.stringify(runFinalized.error)}`);
    }
    return { runId, store, grader };
  }

  it.each<{ scenario: GradeScenario; gradeLines: string[] }>([
    {
      scenario: 'passed',
      gradeLines: ['Grader verdict: passed (openai/grader-model, effort high): rationale text'],
    },
    {
      scenario: 'pending',
      gradeLines: [
        "The grading model's reply had no usable verdict for this check. This check has no verdict until you record one. Choose a verdict below. Technical detail: the grader call failed",
      ],
    },
    {
      scenario: 'none',
      gradeLines: [
        'tevu has no grading for this solution. This check has no verdict until you record one. Choose a verdict below. Technical detail: no grading artifact was saved for this case',
      ],
    },
  ])(
    'reads the case name, the check name, and the grade lines of a $scenario grade for the wizard',
    async ({ scenario, gradeLines }) => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-eval-assess-context-'));
      try {
        const { runId, store } = await createGradedAssessmentRun(root, scenario);

        const context = await readAssessmentContext(runId, 'graded-assess-task--alpha--1', store);

        expect(context.ok).toBe(true);
        if (!context.ok) return;
        expect(context.value.caseName).toBe(
          'vendor/model-alpha-synth, effort-high on "Graded assessment task"',
        );
        expect(context.value.checks).toHaveLength(1);
        expect(context.value.checks[0]).toMatchObject({
          checkId: 'graded-check',
          name: 'The criterion holds.',
          evaluator: 'grader',
          gradeLines,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps the grader's verdict in history when an operator replaces a passed grade with no prior operator record", async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-assess-graded-passed-'));
    try {
      const { runId, store, grader } = await createGradedAssessmentRun(root, 'passed');

      const assessed = await assessCase(
        {
          runId,
          caseId: 'graded-assess-task--alpha--1',
          decisions: [
            {
              checkId: 'graded-check',
              verdict: 'failed',
              assessor: 'curator',
              note: 'overridden after review',
              replaceExisting: true,
            },
          ],
          assessedAt: '2026-09-23T02:00:00.000Z',
        },
        store,
        AGENTS_REGISTRY,
      );

      expect(assessed.ok).toBe(true);
      const assessment = await store.readAssessment(runId, 'graded-assess-task--alpha--1');
      expect(assessment.ok).toBe(true);
      if (!assessment.ok || assessment.value === null) return;
      expect(assessment.value.history).toEqual([
        {
          source: 'grader',
          checkId: 'graded-check',
          verdict: 'passed',
          rationale: 'rationale text',
          grader,
          replacedAt: '2026-09-23T02:00:00.000Z',
        },
      ]);
      expect(assessment.value.current).toEqual([
        {
          checkId: 'graded-check',
          verdict: 'failed',
          assessor: 'curator',
          note: 'overridden after review',
          assessedAt: '2026-09-23T02:00:00.000Z',
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each<{ scenario: GradeScenario }>([
    { scenario: 'undetermined' },
    { scenario: 'pending' },
    { scenario: 'none' },
  ])(
    'rejects replaceExisting: true with "has no existing assessment to replace" when the grade is $scenario',
    async ({ scenario }) => {
      const root = await mkdtemp(join(tmpdir(), `tevu-eval-assess-graded-${scenario}-reject-`));
      try {
        const { runId, store } = await createGradedAssessmentRun(root, scenario);

        const attempted = await assessCase(
          {
            runId,
            caseId: 'graded-assess-task--alpha--1',
            decisions: [
              {
                checkId: 'graded-check',
                verdict: 'passed',
                assessor: 'curator',
                note: 'confirmed',
                replaceExisting: true,
              },
            ],
            assessedAt: '2026-09-23T02:00:00.000Z',
          },
          store,
          AGENTS_REGISTRY,
        );

        expect(attempted.ok).toBe(false);
        if (attempted.ok || attempted.error.kind !== 'ConfigValidationError') {
          throw new Error(`expected ConfigValidationError, got ${JSON.stringify(attempted)}`);
        }
        expect(attempted.error.findings).toContainEqual({
          severity: 'error',
          identifier: 'graded-check',
          message: 'check "graded-check" has no existing assessment to replace',
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each<{ scenario: GradeScenario }>([
    { scenario: 'undetermined' },
    { scenario: 'pending' },
    { scenario: 'none' },
  ])(
    'records a decision with replaceExisting: false and adds no history entry when the grade is $scenario',
    async ({ scenario }) => {
      const root = await mkdtemp(join(tmpdir(), `tevu-eval-assess-graded-${scenario}-accept-`));
      try {
        const { runId, store } = await createGradedAssessmentRun(root, scenario);

        const assessed = await assessCase(
          {
            runId,
            caseId: 'graded-assess-task--alpha--1',
            decisions: [
              {
                checkId: 'graded-check',
                verdict: 'passed',
                assessor: 'curator',
                note: 'confirmed',
                replaceExisting: false,
              },
            ],
            assessedAt: '2026-09-23T02:00:00.000Z',
          },
          store,
          AGENTS_REGISTRY,
        );

        expect(assessed.ok).toBe(true);
        const assessment = await store.readAssessment(runId, 'graded-assess-task--alpha--1');
        expect(assessment.ok).toBe(true);
        if (!assessment.ok || assessment.value === null) return;
        expect(assessment.value.history).toEqual([]);
        expect(assessment.value.current).toEqual([
          {
            checkId: 'graded-check',
            verdict: 'passed',
            assessor: 'curator',
            note: 'confirmed',
            assessedAt: '2026-09-23T02:00:00.000Z',
          },
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('requires every pending graded check to be decided, and rejects an operator record replacement without confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-eval-assess-graded-pending-required-'));
    try {
      const { runId, store } = await createGradedAssessmentRun(root, 'pending');

      const noDecision = await assessCase(
        {
          runId,
          caseId: 'graded-assess-task--alpha--1',
          decisions: [],
          assessedAt: '2026-09-23T02:00:00.000Z',
        },
        store,
        AGENTS_REGISTRY,
      );
      expect(noDecision.ok).toBe(false);
      if (noDecision.ok || noDecision.error.kind !== 'ConfigValidationError') {
        throw new Error(`expected ConfigValidationError, got ${JSON.stringify(noDecision)}`);
      }
      expect(noDecision.error.findings).toContainEqual({
        severity: 'error',
        identifier: 'graded-check',
        message:
          'pending graded check "graded-check" has no decision; every pending graded check must be assessed',
      });

      const first = await assessCase(
        {
          runId,
          caseId: 'graded-assess-task--alpha--1',
          decisions: [
            {
              checkId: 'graded-check',
              verdict: 'passed',
              assessor: 'curator',
              note: 'confirmed',
              replaceExisting: false,
            },
          ],
          assessedAt: '2026-09-23T02:00:00.000Z',
        },
        store,
        AGENTS_REGISTRY,
      );
      expect(first.ok).toBe(true);

      const unconfirmedReplacement = await assessCase(
        {
          runId,
          caseId: 'graded-assess-task--alpha--1',
          decisions: [
            {
              checkId: 'graded-check',
              verdict: 'failed',
              assessor: 'curator-2',
              note: 're-reviewed',
              replaceExisting: false,
            },
          ],
          assessedAt: '2026-09-23T03:00:00.000Z',
        },
        store,
        AGENTS_REGISTRY,
      );
      expect(unconfirmedReplacement.ok).toBe(false);
      if (
        unconfirmedReplacement.ok ||
        unconfirmedReplacement.error.kind !== 'ConfigValidationError'
      ) {
        throw new Error(
          `expected ConfigValidationError, got ${JSON.stringify(unconfirmedReplacement)}`,
        );
      }
      expect(unconfirmedReplacement.error.findings).toContainEqual({
        severity: 'error',
        identifier: 'graded-check',
        message:
          'check "graded-check" is already assessed; replacement must be selected and confirmed',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
