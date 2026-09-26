// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createArtifactStore, createConfigStore } from '@/adapters/artifact-store';
import {
  createEnvironmentAdapter,
  createEvaluatorProcessAdapter,
  createRedactor,
} from '@/adapters/process';
import { assessCase, rebuildReport } from '@/application/assess';
import { buildEnvironmentVariableNames } from '@/application/environment-variable-names';
import { renderConfigDocument } from '@/config/document';
import { loadConfig } from '@/config/load';
import { decodeRunConfig } from '@/config/run-snapshot';
import { TevuConfigSchema } from '@/config/schema';
import { unavailableBenchmarkMetrics } from '@/domain/types';

import {
  buildCheckEnvironment,
  evaluateChecks,
  orderTaskChecks,
  reduceRequiredOutcome,
} from './checks';
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
  CaseIdentity,
  CaseResult,
  CheckRecord,
  CheckResult,
  CommandCheck,
  EvaluatorProcessAdapter,
  EvaluatorProcessRequest,
  EvaluatorProcessResult,
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
      run: () => Promise.reject(new Error('unused in report regeneration')),
      exportSession: () => Promise.reject(new Error('unused in report regeneration')),
      normalizeMetrics(input) {
        if (input.sessionExport !== null) {
          return { ok: true, value: buildFullMetrics() };
        }
        const reason = input.exportUnavailableReason ?? 'root session export unavailable';
        return { ok: true, value: buildEventFallbackMetrics(reason, input.events) };
      },
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
    repositoryId: 'repo-1',
    startCommit: '0123456789abcdef0123456789abcdef01234567',
    description: 'synthetic task description for the welcome route',
    source: { kind: 'manual', reference: null, title: 'Synthetic welcome-route task' },
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
    result: `cases/${caseId}/result.json`,
  };
  return {
    events: present.has('events') ? paths.events : null,
    diagnostics: present.has('diagnostics') ? paths.diagnostics : null,
    sessionExport: present.has('sessionExport') ? paths.sessionExport : null,
    solutionPatch: present.has('solutionPatch') ? paths.solutionPatch : null,
    checks: present.has('checks') ? paths.checks : null,
    assessment: present.has('assessment') ? paths.assessment : null,
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
    },
    execution: {
      concurrency: config.run.concurrency,
      caseTimeoutMs: 60_000,
      repeat: { value: config.run.repeat, source: 'config' },
    },
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
    'task-2--alpha--1',
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
      caseId: 'task-2--alpha--1',
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
    artifacts: buildArtifactIndex('task-2--alpha--1', new Set([])),
    failure: {
      error: { kind: 'CaseTimeoutError', caseId: 'task-2--alpha--1', timeoutMs: 60000 },
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
    stdout: { text: '', totalBytes: 0, truncated: false },
    stderr: { text: '', totalBytes: 0, truncated: false },
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
      succeeded(7, { stdout: { text: 'step failed', totalBytes: 11, truncated: false } }),
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
        stdout: { text: `token=${PROVIDER_SECRET}`, totalBytes: 40, truncated: false },
        stderr: { text: `trace ${PARENT_SENTINEL}`, totalBytes: 30, truncated: false },
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
        stdout: { text: 'partial capture', totalBytes: 999, truncated: true },
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
  '{\n  "assessments": [],\n  "capabilities": {},\n  "cases": [\n    {\n      "artifacts": {\n        "assessment": null,\n        "checks": null,\n        "diagnostics": null,\n        "events": null,\n        "result": "cases/task-1--alpha--1/result.json",\n        "sessionExport": null,\n        "solutionPatch": null\n      },\n      "checks": [],\n      "failure": null,\n      "identity": {\n        "agent": "opencode",\n        "attempt": 1,\n        "caseId": "task-1--alpha--1",\n        "effort": "effort-high",\n        "model": "vendor/model-alpha-synth",\n        "modelId": "alpha",\n        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",\n        "taskId": "task-1",\n        "timeoutMs": 1000\n      },\n      "lifecycle": "completed",\n      "metrics": {\n        "apiCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "apiErrors": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "cacheReadTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "cacheWriteTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "cost": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "USD",\n          "value": null\n        },\n        "elapsed": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "case",\n          "unit": "millisecond",\n          "value": null\n        },\n        "inputTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "outputTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "reasoningTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "skillCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "toolCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "turns": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        }\n      },\n      "outcome": "passed",\n      "process": {\n        "durationMs": 1500,\n        "endedAt": "2026-09-23T00:00:01.500Z",\n        "exitCode": 0,\n        "signal": null,\n        "startedAt": "2026-09-23T00:00:00.000Z",\n        "terminationStage": "none"\n      },\n      "schemaVersion": 1\n    },\n    {\n      "artifacts": {\n        "assessment": null,\n        "checks": null,\n        "diagnostics": null,\n        "events": null,\n        "result": "cases/task-2--alpha--1/result.json",\n        "sessionExport": null,\n        "solutionPatch": null\n      },\n      "checks": [],\n      "failure": null,\n      "identity": {\n        "agent": "opencode",\n        "attempt": 1,\n        "caseId": "task-2--alpha--1",\n        "effort": "effort-high",\n        "model": "vendor/model-alpha-synth",\n        "modelId": "alpha",\n        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",\n        "taskId": "task-2",\n        "timeoutMs": 1000\n      },\n      "lifecycle": "completed",\n      "metrics": {\n        "apiCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "apiErrors": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "cacheReadTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "cacheWriteTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "cost": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "USD",\n          "value": null\n        },\n        "elapsed": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "case",\n          "unit": "millisecond",\n          "value": null\n        },\n        "inputTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "outputTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "reasoningTokens": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "token",\n          "value": null\n        },\n        "skillCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "toolCalls": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        },\n        "turns": {\n          "availability": {\n            "reason": "not yet normalized",\n            "status": "unavailable"\n          },\n          "scope": "root-session",\n          "unit": "count",\n          "value": null\n        }\n      },\n      "outcome": "passed",\n      "process": {\n        "durationMs": 1500,\n        "endedAt": "2026-09-23T00:00:01.500Z",\n        "exitCode": 0,\n        "signal": null,\n        "startedAt": "2026-09-23T00:00:00.000Z",\n        "terminationStage": "none"\n      },\n      "schemaVersion": 1\n    }\n  ],\n  "exitCode": 0,\n  "findings": [],\n  "manifest": {\n    "cases": [\n      {\n        "agent": "opencode",\n        "attempt": 1,\n        "caseId": "task-1--alpha--1",\n        "effort": "effort-high",\n        "model": "vendor/model-alpha-synth",\n        "modelId": "alpha",\n        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",\n        "taskId": "task-1",\n        "timeoutMs": 1000\n      },\n      {\n        "agent": "opencode",\n        "attempt": 1,\n        "caseId": "task-2--alpha--1",\n        "effort": "effort-high",\n        "model": "vendor/model-alpha-synth",\n        "modelId": "alpha",\n        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",\n        "taskId": "task-2",\n        "timeoutMs": 1000\n      }\n    ],\n    "completedAt": "2026-01-01T00:05:00.000Z",\n    "configDigest": "sha256-golden-digest",\n    "configPath": "/synthetic/tevu.yaml",\n    "execution": {\n      "caseTimeoutMs": 1000,\n      "concurrency": 1,\n      "repeat": {\n        "source": "config",\n        "value": 1\n      }\n    },\n    "host": {\n      "nodeVersion": "v24.21.0",\n      "platform": "linux"\n    },\n    "runId": "20260101t000000z-golden",\n    "schemaVersion": 1,\n    "startedAt": "2026-01-01T00:00:00.000Z",\n    "tools": {\n      "agentVersions": {\n        "opencode": null\n      },\n      "gitVersion": "git version 2.45.0"\n    }\n  },\n  "models": [],\n  "pairs": [\n    {\n      "allPassed": true,\n      "modelId": "alpha",\n      "outcomes": {\n        "failed": 0,\n        "not-evaluated": 0,\n        "passed": 1,\n        "pending": 0\n      },\n      "passedOfPlanned": "1/1",\n      "planned": 1,\n      "taskId": "task-1"\n    },\n    {\n      "allPassed": true,\n      "modelId": "alpha",\n      "outcomes": {\n        "failed": 0,\n        "not-evaluated": 0,\n        "passed": 1,\n        "pending": 0\n      },\n      "passedOfPlanned": "1/1",\n      "planned": 1,\n      "taskId": "task-2"\n    }\n  ],\n  "repositories": [],\n  "schemaVersion": 1,\n  "tasks": [\n    {\n      "checks": [\n        {\n          "category": "acceptance",\n          "description": "acceptance command exits zero",\n          "evaluator": "command",\n          "id": "acc-acceptance-command",\n          "required": true\n        },\n        {\n          "category": "definition-of-done",\n          "description": "manual Definition of Done review",\n          "evaluator": "manual",\n          "id": "dod-manual-review",\n          "required": true\n        },\n        {\n          "category": "definition-of-done",\n          "description": "optional manual polish review",\n          "evaluator": "manual",\n          "id": "man-optional-polish",\n          "required": false\n        }\n      ],\n      "description": "synthetic task description for the welcome route",\n      "id": "task-1",\n      "repositoryId": "repo-1",\n      "source": {\n        "kind": "manual",\n        "reference": null,\n        "title": "Synthetic welcome-route task"\n      },\n      "startCommit": "0123456789abcdef0123456789abcdef01234567"\n    },\n    {\n      "checks": [\n        {\n          "category": "acceptance",\n          "description": "acceptance command exits zero",\n          "evaluator": "command",\n          "id": "acc-acceptance-command",\n          "required": true\n        },\n        {\n          "category": "definition-of-done",\n          "description": "manual Definition of Done review",\n          "evaluator": "manual",\n          "id": "dod-manual-review",\n          "required": true\n        },\n        {\n          "category": "definition-of-done",\n          "description": "optional manual polish review",\n          "evaluator": "manual",\n          "id": "man-optional-polish",\n          "required": false\n        }\n      ],\n      "description": "synthetic task description for the welcome route",\n      "id": "task-2",\n      "repositoryId": "repo-1",\n      "source": {\n        "issueKey": "TEVU-999",\n        "issueUrl": "https://jira.example.com/browse/TEVU-999",\n        "kind": "jira-cloud"\n      },\n      "startCommit": "0123456789abcdef0123456789abcdef01234567"\n    }\n  ]\n}\n';

const GOLDEN_MARKDOWN =
  '# tevu run 20260101t000000z-golden\n\n> **Sensitive data:** the tevu configuration file and this artifact directory can contain\n> sensitive private repository, task, Jira, model-output, and evaluator data. They rely on\n> host filesystem access controls.\n>\n> **Isolation boundary:** context isolation is non-adversarial. It withholds sibling runs,\n> later Git history, host agent state, and benchmark artifacts from normal discovery.\n> It does not claim that a model with shell access cannot probe arbitrary host paths.\n\n## Run\n\n- Configuration digest: `sha256-golden-digest`\n- Started: 2026-01-01T00:00:00.000Z\n- Completed: 2026-01-01T00:05:00.000Z\n- Host: linux, Node.js v24.21.0, Git git version 2.45.0\n- Agent "opencode" version (detected provenance only): not detected\n- Agent "opencode" isolation control (deny outside worktree): not probed\n- Concurrency: 1\n- Case timeout: 1000ms\n- Repeat: 1 (source: config)\n- Run exit code: 0\n\n## Task task-1\n\nsynthetic task description for the welcome route\n\n- Repository: repo-1\n- Source commit: `0123456789abcdef0123456789abcdef01234567`\n- Source: manual — Synthetic welcome-route task\n\nPair summary:\n\n| Model entry | Planned | passed | failed | pending | not-evaluated | Passed of planned | All passed |\n|---|---|---|---|---|---|---|---|\n| alpha | 1 | 1 | 0 | 0 | 0 | 1/1 | yes |\n\n| Outcome | Model entry | Attempt | Model | Effort | Lifecycle | Runtime failure | Elapsed |\n|---|---|---|---|---|---|---|---|\n| passed | alpha | 1 | vendor/model-alpha-synth | effort-high | completed | none | unavailable: not yet normalized |\n\n### Case task-1--alpha--1\n\n- Model entry: alpha (vendor/model-alpha-synth, effort effort-high)\n- Lifecycle: completed\n- Task outcome: passed\n- Process: exit code 0, 1500ms, termination stage none\n\nMetrics:\n\n- apiCalls: unavailable: not yet normalized\n- apiErrors: unavailable: not yet normalized\n- cacheReadTokens: unavailable: not yet normalized\n- cacheWriteTokens: unavailable: not yet normalized\n- cost: unavailable: not yet normalized\n- elapsed: unavailable: not yet normalized\n- inputTokens: unavailable: not yet normalized\n- outputTokens: unavailable: not yet normalized\n- reasoningTokens: unavailable: not yet normalized\n- skillCalls: unavailable: not yet normalized\n- toolCalls: unavailable: not yet normalized\n- turns: unavailable: not yet normalized\n\nArtifacts:\n\n- Solution patch: missing\n- Events: missing\n- Diagnostics: missing\n- Session export: missing\n- Check evidence: missing\n- Result: [cases/task-1--alpha--1/result.json](cases/task-1--alpha--1/result.json)\n\n## Task task-2\n\nsynthetic task description for the welcome route\n\n- Repository: repo-1\n- Source commit: `0123456789abcdef0123456789abcdef01234567`\n- Source: Jira snapshot — [TEVU-999](https://jira.example.com/browse/TEVU-999)\n\nPair summary:\n\n| Model entry | Planned | passed | failed | pending | not-evaluated | Passed of planned | All passed |\n|---|---|---|---|---|---|---|---|\n| alpha | 1 | 1 | 0 | 0 | 0 | 1/1 | yes |\n\n| Outcome | Model entry | Attempt | Model | Effort | Lifecycle | Runtime failure | Elapsed |\n|---|---|---|---|---|---|---|---|\n| passed | alpha | 1 | vendor/model-alpha-synth | effort-high | completed | none | unavailable: not yet normalized |\n\n### Case task-2--alpha--1\n\n- Model entry: alpha (vendor/model-alpha-synth, effort effort-high)\n- Lifecycle: completed\n- Task outcome: passed\n- Process: exit code 0, 1500ms, termination stage none\n\nMetrics:\n\n- apiCalls: unavailable: not yet normalized\n- apiErrors: unavailable: not yet normalized\n- cacheReadTokens: unavailable: not yet normalized\n- cacheWriteTokens: unavailable: not yet normalized\n- cost: unavailable: not yet normalized\n- elapsed: unavailable: not yet normalized\n- inputTokens: unavailable: not yet normalized\n- outputTokens: unavailable: not yet normalized\n- reasoningTokens: unavailable: not yet normalized\n- skillCalls: unavailable: not yet normalized\n- toolCalls: unavailable: not yet normalized\n- turns: unavailable: not yet normalized\n\nArtifacts:\n\n- Solution patch: missing\n- Events: missing\n- Diagnostics: missing\n- Session export: missing\n- Check evidence: missing\n- Result: [cases/task-2--alpha--1/result.json](cases/task-2--alpha--1/result.json)\n\n---\n\nTask outcome, runtime failure, and run exit status are reported independently.\nCommand check output is configured acceptance evidence, not an additional model-quality metric.\nNo composite score or winner is computed.\n';

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
    };
    const reordered = {
      run,
      capabilities: { [AGENT_NAME]: records.capabilities },
      tasks: [...decoded.value.tasks].reverse(),
      models: [...decoded.value.models].reverse(),
      repositories: [...decoded.value.repositories].reverse(),
      assessments: [records.assessment],
    };

    const model = buildNormalizedRun(input);

    expect(model.cases.map((entry) => entry.identity.caseId)).toEqual([
      'task-1--alpha--1',
      'task-1--beta--1',
      'task-2--alpha--1',
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
      tools: { gitVersion: 'git version 2.45.0', agentVersions: { opencode: null } },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 1, source: 'config' } },
      cases: [manualCase.identity, jiraCase.identity],
    };
    const input: ReportInput = {
      run: { schemaVersion: 1, manifest, cases: [manualCase, jiraCase], findings: [], exitCode: 0 },
      capabilities: {},
      tasks: [manualTask, jiraTask],
      models: [],
      repositories: [],
      assessments: [],
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
      tools: { gitVersion: 'git version 2.45.0', agentVersions: { opencode: null } },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 1, source: 'config' } },
      cases: [githubCase.identity],
    };
    const input: ReportInput = {
      run: { schemaVersion: 1, manifest, cases: [githubCase], findings: [], exitCode: 0 },
      capabilities: {},
      tasks: [githubTask],
      models: [],
      repositories: [],
      assessments: [],
    };

    const result = buildReport(input);

    expect(result.markdown).toContain(
      '- Source: GitHub issue snapshot — [octo/repo#42](https://github.com/octo/repo/issues/42)',
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
      tools: { gitVersion: 'git version 2.45.0', agentVersions: {} },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 3, source: 'config' } },
      cases: [passed.identity, failed.identity, notEvaluatedIdentity],
    };
    const input: ReportInput = {
      run: { schemaVersion: 1, manifest, cases: [passed, failed], findings: [], exitCode: 2 },
      capabilities: {},
      tasks: [buildTaskRecord()],
      models: [],
      repositories: [],
      assessments: [],
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
      tools: { gitVersion: 'git version 2.45.0', agentVersions: {} },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 10, source: 'config' } },
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
    };

    const model = buildNormalizedRun(input);
    const markdown = buildReport(input).markdown;

    expect(model.findings.map((finding) => finding.caseId)).toEqual([
      'task-1--alpha--9',
      'task-1--alpha--10',
    ]);
    const nineIndex = markdown.indexOf('case task-1--alpha--9)');
    const tenIndex = markdown.indexOf('case task-1--alpha--10)');
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
      tools: { gitVersion: 'git version 2.45.0', agentVersions: {} },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 1, source: 'config' } },
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
      '- Tasks with their own case timeout: task-a 2000ms, task-a 3000ms, task-b 500ms',
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
      tools: { gitVersion: 'git version 2.45.0', agentVersions: {} },
      execution: { concurrency: 1, caseTimeoutMs: 1000, repeat: { value: 1, source: 'config' } },
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

      const gamma = await store.readCaseResult(runId, 'task-2--alpha--1');
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

      expect(markdown.indexOf('## Task task-1')).toBeLessThan(markdown.indexOf('## Task task-2'));
      expect(markdown).toContain(
        '| passed | alpha | 1 | vendor/model-alpha-synth | effort-high | completed | none |',
      );
      expect(markdown.indexOf('| passed | alpha |')).toBeLessThan(
        markdown.indexOf('| failed | beta |'),
      );
      expect(markdown).toContain(
        'Jira snapshot — [TEVU-999](https://jira.example.com/browse/TEVU-999)',
      );

      expect(markdown).toContain(
        'Runtime failure (preserved independently of the task outcome): AgentProcessError',
      );
      expect(markdown).toContain(
        'Runtime failure (preserved independently of the task outcome): CaseTimeoutError',
      );

      expect(markdown).toContain(
        '- apiErrors: 1 count (root-session, source: root-session export)',
      );
      expect(markdown).toContain(
        '- inputTokens: unavailable: the preserved case artifacts contain no session export\n',
      );
      expect(markdown).toContain('- skillCalls: 0 count (root-session, source: run events)');
      expect(markdown).toContain('- elapsed: 42000 millisecond (case, source: process)');

      expect(markdown).toContain('Assessments (revision 2):');
      expect(markdown).toContain(
        '- dod-manual-review: passed by curator at 2026-09-23T01:00:00.000Z',
      );
      expect(markdown).toContain('Pending manual checks: man-optional-polish.');

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
      expect(assessed.value.outcome).toBe('failed');
      expect(
        assessed.value.checks.find((check) => check.checkId === 'dod-manual-review')?.evidence,
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
      expect(assessed.value.outcome).toBe('passed');

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
      const loaded = await loadConfig(configPath, configStore);
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
      const loaded = await loadConfig(configPath, configStore);
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
