// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createArtifactStore } from '@/adapters/artifact-store';
import { createRedactor } from '@/adapters/process';
import { assessCase, rebuildReport } from '@/application/assess';
import { TevuConfigSchema } from '@/config/schema';
import { unavailableAgentMetrics, unavailableBenchmarkMetrics } from '@/domain/types';
import { combineCaseMetrics } from '@/evaluation/metrics';

import { createOpenCodeAdapter } from './opencode';
import { decodeEvent, decodeExport } from './protocol';

import type { OpenCodeExport, OpenCodeRunEvent } from './protocol';
import type { ModelDefinitionInput, TaskInput, TevuConfigInput } from '@/config/schema';
import type {
  AgentCapabilityReport,
  AgentEventRecord,
  AgentRegistry,
  AgentSessionExport,
  ArtifactStore,
  AssessmentArtifact,
  CaseGrading,
  CaseIdentity,
  CaseResult,
  CheckResult,
  ConclusionsArtifact,
  ProcessResult,
  RepositoryDefinition,
  RunFinding,
  RunManifest,
  RunResult,
  TevuConfig,
  TevuResult,
} from '@/domain/types';

const PROVIDER_SECRET = 'synthetic-provider-secret-9f2';
const PROVIDER_ENV_NAME = 'TEVU_PROVIDER_KEY';
const TRANSCRIPT_BODY = 'TEVU-TRANSCRIPT-BODY model output text';
const PATCH_BODY = 'TEVU-PATCH-BODY diff --git a/src/welcome.ts b/src/welcome.ts';
const CONFIG_PATH = '/synthetic/tevu.yaml';

const FIXTURE_DIRECTORY = new URL('./fixtures/', import.meta.url);

/**
 * A registry holding the real OpenCode adapter under "opencode", matching the
 * synthetic run's saved agent name. Only `normalizeMetrics` is invoked by
 * report regeneration; the other methods are never called.
 */
const AGENTS_REGISTRY: AgentRegistry = new Map([
  [
    'opencode',
    createOpenCodeAdapter(
      {
        agent: 'opencode',
        executable: '/synthetic/opencode',
        providers: [],
        declaredVariables: { secrets: [], env: [] },
      },
      {
        runProcess: () => Promise.reject(new Error('unused in report regeneration')),
        secrets: {
          secretValues: () => [],
          redactText: (text) => text,
          redactValue: (value) => ({ ok: true, value }),
        },
        probeEnvironment: {},
        probeDirectory: '/synthetic',
        operatorDirectories: { home: undefined, xdgConfigHome: undefined },
      },
    ),
  ],
]);

function requireOpenCodeAdapter() {
  const adapter = AGENTS_REGISTRY.get('opencode');
  if (adapter === undefined) {
    throw new Error('expected AGENTS_REGISTRY to register the opencode adapter');
  }
  return adapter;
}

function readTextFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIRECTORY), 'utf8');
}

function readJsonFixture(name: string): unknown {
  return JSON.parse(readTextFixture(name)) as unknown;
}

function decodeFixtureEvents(text: string): OpenCodeRunEvent[] {
  const events: OpenCodeRunEvent[] = [];
  for (const [index, line] of text.trim().split('\n').entries()) {
    const decoded = decodeEvent(
      JSON.parse(line) as unknown,
      { phase: 'case', caseId: 'fixture' },
      index + 1,
    );
    if (decoded.ok && decoded.value !== null) {
      events.push(decoded.value);
    }
  }
  return events;
}

function buildModel(overrides: Partial<ModelDefinitionInput> = {}): ModelDefinitionInput {
  return { id: 'alpha', model: 'vendor/model-alpha-synth', effort: 'effort-high', ...overrides };
}

function buildRepository(overrides: Partial<RepositoryDefinition> = {}): RepositoryDefinition {
  return { id: 'repo-1', path: '/tevu-synthetic/repo-1', ...overrides };
}

function buildTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    title: 'Synthetic welcome-route task',
    repo: 'repo-1',
    base_commit: '0123456789abcdef0123456789abcdef01234567',
    description: 'synthetic task description for the welcome route',
    prompt: 'TEVU-PROMPT-BODY implement the welcome route',
    readiness: ['synthetic ready item'],
    checks: {
      acceptance: [
        {
          id: 'acc-acceptance-command',
          description: 'acceptance command exits zero',
          run: ['/synthetic/acceptance-probe', '--suite', 'synthetic'],
          timeout: '5s',
          exit_codes: [0],
          env: ['TEVU_EVAL_ORDINARY'],
        },
      ],
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
      title: 'TEVU-JIRA-SUMMARY imported issue title',
      body: 'TEVU-JIRA-DESCRIPTION full imported body',
    },
    ...overrides,
  });
}

function buildSyntheticConfig(): TevuConfig {
  const config: TevuConfigInput = {
    version: 1,
    run: {
      output_dir: '/tevu-synthetic/artifacts',
      concurrency: 2,
      timeout: '60s',
      stop_grace: '1s',
    },
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
    agent: 'opencode',
    timeoutMs: 60_000,
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
    executable: '/synthetic/opencode',
    detectedVersion: '9.9.9-synthetic',
    capabilities: [
      { name: 'run command', required: true, availability: 'available' },
      { name: 'export command', required: true, availability: 'available' },
      { name: 'run --format json', required: true, availability: 'available' },
      { name: 'run --model', required: true, availability: 'available' },
      { name: 'run --variant', required: true, availability: 'available' },
    ],
    isolation: { denyOutsideWorktree: 'unavailable' },
    ...overrides,
  };
}

const BETA_EFFORT_REASON =
  '"effort-low" is not among the variants "opencode models --verbose" reports for "vendor/model-alpha-synth" (effort-high), and the repository of each task may define it: task-1 (opencode.json)';
const GAMMA_EFFORT_REASON =
  '"effort-high" is not among the variants "opencode models --verbose" reports for "vendor/model-gamma-synth" (max), and these tasks have no agent configuration at the root of their base commit: task-2; their cases would run "vendor/model-gamma-synth" with its default options';

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
    configPath: CONFIG_PATH,
    startedAt: '2026-09-23T00:00:00.000Z',
    completedAt: null,
    host: { platform: 'linux', nodeVersion: 'v24.21.0' },
    tools: {
      gitVersion: 'git version 2.45.0',
      agentVersions: { opencode: capabilities.detectedVersion },
      agentConfigurationFiles: { opencode: [] },
      copiedProviders: { opencode: [] },
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
    efforts: {
      models: {
        alpha: { status: 'verified' },
        beta: { status: 'unverified', reason: BETA_EFFORT_REASON },
        gamma: { status: 'unsupported', reason: GAMMA_EFFORT_REASON },
      },
      grader: null,
    },
    context: { config, capabilities: { opencode: capabilities } },
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
  exportRecord: OpenCodeExport;
  events: OpenCodeRunEvent[];
};

function buildSyntheticRecords(): SyntheticRecords {
  const config = buildSyntheticConfig();
  const capabilities = buildCapabilityReport();
  const runId = '20260923t000000z-synthetic';
  const manifest = buildManifest(runId, config, capabilities, [
    'task-1--alpha--1',
    'task-1--beta--1',
    'task-2--gamma--1',
  ]);

  const parsedExport = structuredClone(readJsonFixture('session-valid.json')) as {
    messages: Array<{ parts: Array<Record<string, unknown>> }>;
  };
  parsedExport.messages[1].parts.push({
    id: 'prt-x9',
    sessionID: 'ses-root-0001',
    messageID: 'msg-a1',
    type: 'text',
    text: TRANSCRIPT_BODY,
  });
  const decodedExport = decodeExport(parsedExport, { phase: 'case', caseId: 'task-1--alpha--1' });
  if (!decodedExport.ok) {
    throw new Error(`valid export fixture must decode: ${decodedExport.error.reason}`);
  }

  const secretError: OpenCodeRunEvent = {
    type: 'error',
    timestamp: 2000,
    sessionID: 'ses-root-0001',
    error: { message: `leak ${PROVIDER_SECRET} marker` },
  };
  const events = [...decodeFixtureEvents(readTextFixture('events-valid.jsonl')), secretError];

  const alphaNormalized = requireOpenCodeAdapter().normalizeMetrics({
    caseId: 'task-1--alpha--1',
    sessionId: 'ses-root-0001',
    sessionExport: decodedExport.value.view,
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
        agent: 'opencode',
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
    exportRecord: decodedExport.value.view,
    events,
  };
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
  const exportWrite = await store.writeSessionExport(
    'task-1--alpha--1',
    records.exportRecord as AgentSessionExport,
  );
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

  const betaError: OpenCodeRunEvent = {
    type: 'error',
    timestamp: 3000,
    sessionID: 'ses-beta-0001',
    error: { message: 'synthetic provider outage' },
  };
  const betaToolUse: OpenCodeRunEvent = {
    type: 'tool_use',
    timestamp: 3100,
    sessionID: 'ses-beta-0001',
    part: {
      id: 'prt-beta-1',
      sessionID: 'ses-beta-0001',
      messageID: 'msg-beta-1',
      type: 'tool',
      callID: 'call-beta-1',
      tool: 'bash',
      state: { status: 'completed' },
    },
  };
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

function storedEfforts(manifest: Record<string, unknown>): Record<string, unknown> {
  return manifest['efforts'] as Record<string, unknown>;
}

function storedEffortModels(manifest: Record<string, unknown>): Record<string, unknown> {
  return storedEfforts(manifest)['models'] as Record<string, unknown>;
}

beforeAll(() => {
  process.env[PROVIDER_ENV_NAME] = PROVIDER_SECRET;
});

afterAll(() => {
  delete process.env[PROVIDER_ENV_NAME];
});

describe('OpenCode report regeneration matches the pinned baseline', () => {
  it('rebuilds byte-identically to the pinned baseline fixtures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-p4-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const rebuilt = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;

      expect(rebuilt.value.report.normalizedJson).toBe(readTextFixture('report-baseline.json'));
      expect(rebuilt.value.report.markdown).toBe(readTextFixture('report-baseline.md'));

      const again = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.value).toEqual(rebuilt.value);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns identical bytes and leaves source-artifact digests unchanged across two consecutive rebuilds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-p5-'));
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
      expect(second.value.report.normalizedJson).toBe(first.value.report.normalizedJson);
      expect(second.value.report.markdown).toBe(first.value.report.markdown);
      expect(digestsAfterFirst).toEqual(digestsBefore);
      expect(digestsAfterSecond).toEqual(digestsBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes byte-identical run.json and root result.json across two rebuilds, with the regenerated configPath equal to the stored one (V9)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-p9-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const runJsonPath = join(root, 'artifacts', runId, 'run.json');
      const resultJsonPath = join(root, 'artifacts', runId, 'result.json');

      const first = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(first.ok).toBe(true);
      const runJsonAfterFirst = await readFile(runJsonPath, 'utf8');
      const resultJsonAfterFirst = await readFile(resultJsonPath, 'utf8');
      const second = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(second.ok).toBe(true);
      const runJsonAfterSecond = await readFile(runJsonPath, 'utf8');
      const resultJsonAfterSecond = await readFile(resultJsonPath, 'utf8');

      expect(runJsonAfterSecond).toBe(runJsonAfterFirst);
      expect(resultJsonAfterSecond).toBe(resultJsonAfterFirst);
      const storedManifest = JSON.parse(runJsonAfterFirst) as { manifest: { configPath: string } };
      expect(storedManifest.manifest.configPath).toBe(CONFIG_PATH);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a run whose case result is missing identity.agent, before any write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-p8-case-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const resultPath = caseFile(root, runId, 'task-1--alpha--1', 'result.json');
      const before = await readFile(resultPath, 'utf8');
      const stored = JSON.parse(before) as { identity: Record<string, unknown> };
      delete stored.identity['agent'];
      await writeFile(resultPath, JSON.stringify(stored, null, 2), 'utf8');
      const corrupted = await readFile(resultPath, 'utf8');
      const reportPath = join(root, 'artifacts', runId, 'report.md');

      const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('ArtifactError');
      expect(await readFile(resultPath, 'utf8')).toBe(corrupted);
      expect(existsSync(reportPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a run whose manifest is missing tools.agentVersions, before any write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-p8-manifest-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const runJsonPath = join(root, 'artifacts', runId, 'run.json');
      const before = await readFile(runJsonPath, 'utf8');
      const stored = JSON.parse(before) as { manifest: { tools: Record<string, unknown> } };
      const { agentVersions, ...toolsWithoutAgentVersions } = stored.manifest.tools;
      stored.manifest.tools = { ...toolsWithoutAgentVersions, opencodeVersion: agentVersions };
      await writeFile(runJsonPath, JSON.stringify(stored, null, 2), 'utf8');
      const corrupted = await readFile(runJsonPath, 'utf8');
      const reportPath = join(root, 'artifacts', runId, 'report.md');

      const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('ArtifactError');
      expect(await readFile(runJsonPath, 'utf8')).toBe(corrupted);
      expect(existsSync(reportPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a run whose manifest is missing execution.repeat, before any write (AC-12)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-p8-repeat-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const runJsonPath = join(root, 'artifacts', runId, 'run.json');
      const before = await readFile(runJsonPath, 'utf8');
      const stored = JSON.parse(before) as { manifest: { execution: Record<string, unknown> } };
      delete stored.manifest.execution['repeat'];
      await writeFile(runJsonPath, JSON.stringify(stored, null, 2), 'utf8');
      const corrupted = await readFile(runJsonPath, 'utf8');
      const reportPath = join(root, 'artifacts', runId, 'report.md');

      const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('ArtifactError');
      expect(await readFile(runJsonPath, 'utf8')).toBe(corrupted);
      expect(existsSync(reportPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a run whose case result is missing identity.attempt, before any write (AC-12)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-p8-attempt-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const resultPath = caseFile(root, runId, 'task-1--alpha--1', 'result.json');
      const before = await readFile(resultPath, 'utf8');
      const stored = JSON.parse(before) as { identity: Record<string, unknown> };
      delete stored.identity['attempt'];
      await writeFile(resultPath, JSON.stringify(stored, null, 2), 'utf8');
      const corrupted = await readFile(resultPath, 'utf8');
      const reportPath = join(root, 'artifacts', runId, 'report.md');

      const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('ArtifactError');
      expect(await readFile(resultPath, 'utf8')).toBe(corrupted);
      expect(existsSync(reportPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a run whose case result is missing identity.timeoutMs, before any write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-p8-timeoutms-case-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const resultPath = caseFile(root, runId, 'task-1--alpha--1', 'result.json');
      const before = await readFile(resultPath, 'utf8');
      const stored = JSON.parse(before) as { identity: Record<string, unknown> };
      delete stored.identity['timeoutMs'];
      await writeFile(resultPath, JSON.stringify(stored, null, 2), 'utf8');
      const corrupted = await readFile(resultPath, 'utf8');
      const reportPath = join(root, 'artifacts', runId, 'report.md');

      const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('ArtifactError');
      expect(await readFile(resultPath, 'utf8')).toBe(corrupted);
      expect(existsSync(reportPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a run whose manifest case is missing timeoutMs, before any write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-p8-timeoutms-manifest-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const runJsonPath = join(root, 'artifacts', runId, 'run.json');
      const before = await readFile(runJsonPath, 'utf8');
      const stored = JSON.parse(before) as {
        manifest: { cases: Array<Record<string, unknown>> };
      };
      delete stored.manifest.cases[0]?.['timeoutMs'];
      await writeFile(runJsonPath, JSON.stringify(stored, null, 2), 'utf8');
      const corrupted = await readFile(runJsonPath, 'utf8');
      const reportPath = join(root, 'artifacts', runId, 'report.md');

      const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('ArtifactError');
      expect(await readFile(runJsonPath, 'utf8')).toBe(corrupted);
      expect(existsSync(reportPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'a missing configPath',
      mutate: (manifest: Record<string, unknown>) => delete manifest['configPath'],
    },
    {
      label: 'an empty configPath',
      mutate: (manifest: Record<string, unknown>) => {
        manifest['configPath'] = '';
      },
    },
    {
      label: 'no efforts',
      mutate: (manifest: Record<string, unknown>) => delete manifest['efforts'],
    },
    {
      label: 'efforts that is not an object',
      mutate: (manifest: Record<string, unknown>) => {
        manifest['efforts'] = [];
      },
    },
    {
      label: 'efforts without models',
      mutate: (manifest: Record<string, unknown>) => {
        delete storedEfforts(manifest)['models'];
      },
    },
    {
      label: 'efforts.models without the model entry of a case',
      mutate: (manifest: Record<string, unknown>) => {
        delete storedEffortModels(manifest)['beta'];
      },
    },
    {
      label: 'an effort check with an unknown status',
      mutate: (manifest: Record<string, unknown>) => {
        storedEffortModels(manifest)['alpha'] = { status: 'confirmed' };
      },
    },
    {
      label: 'an unverified effort check without a reason',
      mutate: (manifest: Record<string, unknown>) => {
        storedEffortModels(manifest)['beta'] = { status: 'unverified' };
      },
    },
    {
      label: 'an unsupported effort check with an empty reason',
      mutate: (manifest: Record<string, unknown>) => {
        storedEffortModels(manifest)['beta'] = { status: 'unsupported', reason: '' };
      },
    },
    {
      label: 'efforts without a grader key',
      mutate: (manifest: Record<string, unknown>) => {
        delete storedEfforts(manifest)['grader'];
      },
    },
    {
      label: 'a null grader effort check while its configuration snapshot declares a grader',
      mutate: (manifest: Record<string, unknown>) => {
        const context = manifest['context'] as { config: Record<string, unknown> };
        context.config['roles'] = {
          grader: { model: 'vendor/grader-synth', effort: 'effort-high' },
        };
        storedEfforts(manifest)['grader'] = null;
      },
    },
    {
      label: 'a grader effort check while its configuration snapshot declares no grader',
      mutate: (manifest: Record<string, unknown>) => {
        storedEfforts(manifest)['grader'] = { status: 'verified' };
      },
    },
    {
      label: 'an invalid grader effort check',
      mutate: (manifest: Record<string, unknown>) => {
        storedEfforts(manifest)['grader'] = { status: 'unverified' };
      },
    },
  ])(
    'refuses a run whose manifest has $label, before any write for both report and assess (V10)',
    async ({ mutate }) => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-p10-'));
      try {
        const { runId, store } = await createSyntheticRun(root);
        const runJsonPath = join(root, 'artifacts', runId, 'run.json');
        const before = await readFile(runJsonPath, 'utf8');
        const stored = JSON.parse(before) as { manifest: Record<string, unknown> };
        mutate(stored.manifest);
        await writeFile(runJsonPath, JSON.stringify(stored, null, 2), 'utf8');
        const corrupted = await readFile(runJsonPath, 'utf8');
        const reportPath = join(root, 'artifacts', runId, 'report.md');

        const reported = await rebuildReport(runId, store, AGENTS_REGISTRY);
        const assessed = await assessCase(
          {
            runId,
            caseId: 'task-1--alpha--1',
            decisions: [
              {
                checkId: 'man-optional-polish',
                verdict: 'passed',
                assessor: 'curator',
                note: 'unreachable: the manifest read fails first',
                replaceExisting: false,
              },
            ],
            assessedAt: '2026-09-23T02:00:00.000Z',
          },
          store,
          AGENTS_REGISTRY,
        );

        expect(reported.ok).toBe(false);
        if (!reported.ok) expect(reported.error.kind).toBe('ArtifactError');
        expect(assessed.ok).toBe(false);
        if (!assessed.ok) expect(assessed.error.kind).toBe('ArtifactError');
        expect(await readFile(runJsonPath, 'utf8')).toBe(corrupted);
        expect(existsSync(reportPath)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('OpenCode report regeneration of effort checks', () => {
  async function rebuildMarkdown(
    edit?: (manifest: {
      cases: Array<{ modelId: string }>;
      efforts: { models: Record<string, unknown> };
    }) => void,
  ): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-efforts-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      if (edit !== undefined) {
        const runJsonPath = join(root, 'artifacts', runId, 'run.json');
        const stored = JSON.parse(await readFile(runJsonPath, 'utf8')) as {
          manifest: {
            cases: Array<{ modelId: string }>;
            efforts: { models: Record<string, unknown> };
          };
        };
        edit(stored.manifest);
        await writeFile(runJsonPath, JSON.stringify(stored, null, 2), 'utf8');
      }
      const rebuilt = await rebuildReport(runId, store, AGENTS_REGISTRY);
      if (!rebuilt.ok) {
        throw new Error(`rebuildReport failed: ${JSON.stringify(rebuilt.error)}`);
      }
      return rebuilt.value.report.markdown;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it('lists one Model entry line per configured entry between the Repeat and exit code lines', async () => {
    const markdown = await rebuildMarkdown();

    expect(markdown).toContain(
      [
        '- Repeat: 1 (source: config)',
        '- model-alpha-synth, effort-high: effort verified',
        `- model-alpha-synth, effort-low: effort unverified. tevu could not confirm that the agent offers effort "effort-low" for this model. The effort was passed as requested; if the agent does not offer it, the model ran with its default options. Before the next run, check the effort against the variants the agent lists for the model. Technical detail: ${BETA_EFFORT_REASON}`,
        `- model-gamma-synth, effort-high: effort unsupported. The agent does not list effort "effort-high" for this model. Where no task repository defines it, the model ran with its default options. Choose an effort the agent lists for the model and run the comparison again. Technical detail: ${GAMMA_EFFORT_REASON}`,
        '- Run exit code: 2',
      ].join('\n'),
    );
  });

  it('labels the case table effort with the check of its model entry', async () => {
    const markdown = await rebuildMarkdown();

    expect(markdown).toContain('| model-alpha-synth | effort-high | passed');
    expect(markdown).toContain('| model-alpha-synth | effort-low, unverified | failed');
  });

  it('labels the effort of a case with the check of its model entry', async () => {
    const markdown = await rebuildMarkdown();

    expect(markdown).toContain('\n- Model: vendor/model-alpha-synth, effort effort-high\n');
    expect(markdown).toContain(
      '\n- Model: vendor/model-alpha-synth, effort effort-low, unverified\n',
    );
    expect(markdown).toContain(
      '\n- Model: vendor/model-gamma-synth, effort effort-high, unsupported\n',
    );
  });

  it('marks an effort as not checked for a model entry the run planned no case for', async () => {
    const markdown = await rebuildMarkdown((manifest) => {
      manifest.cases = manifest.cases.filter((entry) => entry.modelId !== 'gamma');
      delete manifest.efforts.models['gamma'];
    });

    expect(markdown).toContain('\n- model-gamma-synth, effort-high: effort not checked\n');
  });
});

describe('OpenCode report regeneration of copied providers', () => {
  const UNPRICED = [{ id: 'acme-proxy', pricedModels: [] }];
  const PRICED = [{ id: 'acme-proxy', pricedModels: ['acme-large'] }];
  const NO_PRICE_REASON =
    'the copied definition of provider "acme-proxy" defines no price for model "acme-large"';

  async function editStoredManifest(
    root: string,
    runId: string,
    edit: (manifest: { tools: Record<string, unknown> }) => void,
  ): Promise<string> {
    const runJsonPath = join(root, 'artifacts', runId, 'run.json');
    const stored = JSON.parse(await readFile(runJsonPath, 'utf8')) as {
      manifest: { tools: Record<string, unknown> };
    };
    edit(stored.manifest);
    await writeFile(runJsonPath, JSON.stringify(stored, null, 2), 'utf8');
    return runJsonPath;
  }

  async function replaceAlphaExport(root: string, runId: string, name: string): Promise<void> {
    await writeFile(
      caseFile(root, runId, 'task-1--alpha--1', 'session.json'),
      readTextFixture(name),
      'utf8',
    );
  }

  function alphaCost(normalizedJson: string): unknown {
    const report = JSON.parse(normalizedJson) as {
      cases: Array<{ identity: { caseId: string }; metrics: { cost: unknown } }>;
    };
    return report.cases.find((entry) => entry.identity.caseId === 'task-1--alpha--1')?.metrics.cost;
  }

  it.each([
    {
      name: 'an unpriced model',
      copiedProviders: UNPRICED,
      expectedCost: {
        value: null,
        unit: 'USD',
        availability: { status: 'unavailable', reason: NO_PRICE_REASON },
        scope: 'root-session',
      },
    },
    {
      name: 'a priced model',
      copiedProviders: PRICED,
      expectedCost: {
        value: 0,
        unit: 'USD',
        availability: { status: 'available', source: 'root-session export' },
        scope: 'root-session',
      },
    },
  ])(
    'recomputes the case cost of $name from the copied providers the manifest records',
    async ({ copiedProviders, expectedCost }) => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-cost-'));
      try {
        const { runId, store } = await createSyntheticRun(root);
        await editStoredManifest(root, runId, (manifest) => {
          manifest.tools['copiedProviders'] = { opencode: copiedProviders };
        });
        await replaceAlphaExport(root, runId, 'session-unpriced.json');

        const rebuilt = await rebuildReport(runId, store, AGENTS_REGISTRY);

        expect(rebuilt.ok).toBe(true);
        if (!rebuilt.ok) return;
        expect(alphaCost(rebuilt.value.report.normalizedJson)).toEqual(expectedCost);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('reports the unavailable cost in the Markdown and returns identical bytes across two rebuilds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-cost-bytes-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      await editStoredManifest(root, runId, (manifest) => {
        manifest.tools['copiedProviders'] = { opencode: UNPRICED };
      });
      await replaceAlphaExport(root, runId, 'session-unpriced.json');

      const first = await rebuildReport(runId, store, AGENTS_REGISTRY);
      const second = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.value.report.markdown).toContain(
        `\n- Not measured: Cost. tevu has no value for this measurement. It is unknown, not zero. This run's saved files cannot supply it; to measure it, fix the cause in the technical detail and run the comparison again. Technical detail: ${NO_PRICE_REASON}\n`,
      );
      expect(second.value.report.normalizedJson).toBe(first.value.report.normalizedJson);
      expect(second.value.report.markdown).toBe(first.value.report.markdown);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'missing', copiedProviders: undefined, defectPath: 'manifest.tools.copiedProviders' },
    { name: 'null', copiedProviders: null, defectPath: 'manifest.tools.copiedProviders' },
    { name: 'a list', copiedProviders: [], defectPath: 'manifest.tools.copiedProviders' },
    {
      name: 'without an entry for the case agent',
      copiedProviders: {},
      defectPath: 'manifest.cases.0.agent',
    },
    {
      name: 'holding a non-list value',
      copiedProviders: { opencode: 'acme-proxy' },
      defectPath: 'manifest.tools.copiedProviders.opencode',
    },
    {
      name: 'holding an entry without an id',
      copiedProviders: { opencode: [{ pricedModels: [] }] },
      defectPath: 'manifest.tools.copiedProviders.opencode.0.id',
    },
    {
      name: 'holding an entry with an empty id',
      copiedProviders: { opencode: [{ id: '', pricedModels: [] }] },
      defectPath: 'manifest.tools.copiedProviders.opencode.0.id',
    },
    {
      name: 'holding pricedModels that is not a list',
      copiedProviders: { opencode: [{ id: 'acme-proxy', pricedModels: 'acme-large' }] },
      defectPath: 'manifest.tools.copiedProviders.opencode.0.pricedModels',
    },
    {
      name: 'holding pricedModels with a non-string model',
      copiedProviders: { opencode: [{ id: 'acme-proxy', pricedModels: ['acme-large', 7] }] },
      defectPath: 'manifest.tools.copiedProviders.opencode.0.pricedModels.1',
    },
  ])(
    'refuses a run whose manifest has copiedProviders $name, before any write',
    async ({ copiedProviders, defectPath }) => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-copied-'));
      try {
        const { runId, store } = await createSyntheticRun(root);
        const runJsonPath = await editStoredManifest(root, runId, (manifest) => {
          if (copiedProviders === undefined) {
            delete manifest.tools['copiedProviders'];
          } else {
            manifest.tools['copiedProviders'] = copiedProviders;
          }
        });
        const corrupted = await readFile(runJsonPath, 'utf8');
        const reportPath = join(root, 'artifacts', runId, 'report.md');

        const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

        expect(result).toMatchObject({
          ok: false,
          error: {
            kind: 'ArtifactError',
            reason: `run result for "${runId}" has a malformed shape or mismatched identity at ${defectPath}`,
          },
        });
        expect(await readFile(runJsonPath, 'utf8')).toBe(corrupted);
        expect(existsSync(reportPath)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('refuses a case result whose agent has a registered adapter but no copiedProviders entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-own-key-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const resultPath = caseFile(root, runId, 'task-1--alpha--1', 'result.json');
      const stored = JSON.parse(await readFile(resultPath, 'utf8')) as {
        identity: Record<string, unknown>;
      };
      stored.identity['agent'] = 'second-agent';
      await writeFile(resultPath, JSON.stringify(stored, null, 2), 'utf8');
      const registry: AgentRegistry = new Map([
        ...AGENTS_REGISTRY,
        ['second-agent', requireOpenCodeAdapter()],
      ]);

      const result = await rebuildReport(runId, store, registry);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ArtifactError',
          operation: 'rebuild-report',
          reason:
            'case "task-1--alpha--1" names agent "second-agent", which has no tools.copiedProviders entry in run.json',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const SECRET_KEY = 'synthetic-acme-secret-value';

function buildGrading(): CaseGrading {
  const grader: CaseGrading['grader'] = {
    model: 'vendor/grader-synth',
    effort: 'effort-high',
    agent: 'opencode',
  };
  return {
    grader,
    call: { status: 'replied', reply: 'synthetic grader reply' },
    calls: [
      {
        outcome: { status: 'replied' },
        metrics: unavailableAgentMetrics('synthetic'),
        events: [{ type: 'text', anything: 1 }],
        diagnostics: 'synthetic stderr',
        session: { info: { id: 'ses-grader' }, messages: [] },
      },
    ],
    metrics: unavailableAgentMetrics('synthetic'),
    grades: [
      {
        checkId: 'acc-acceptance-command',
        category: 'acceptance',
        status: 'graded',
        verdict: 'passed',
        rationale: 'synthetic rationale',
      },
    ],
  };
}

function buildConclusions(runId: string): ConclusionsArtifact {
  return {
    schemaVersion: 1,
    runId,
    tasks: [
      {
        taskId: 'task-1',
        facts: {
          task: 'Synthetic welcome-route task',
          repository: 'repo-1',
          when: '2026-09-23',
          repeat: 1,
          requiredChecksPerAttempt: 1,
          settings: [],
          separation: null,
          cost: { kind: 'none-did-the-task' },
          speed: { kind: 'none-did-the-task' },
        },
        table: ['| setting |'],
        conclusions: { correctness: 'c1', cost: 'c2', speed: 'c3' },
        call: null,
      },
    ],
  };
}

/** Every path under `root` with its text, so a refused write is shown to leave the tree as it was. */
async function snapshotTree(root: string): Promise<Record<string, string | null>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const tree: Record<string, string | null> = {};
  for (const entry of entries) {
    const entryPath = join(entry.parentPath, entry.name);
    tree[entryPath] = entry.isDirectory() ? null : await readFile(entryPath, 'utf8');
  }
  return tree;
}

type SyntheticStore = {
  store: ArtifactStore;
  records: SyntheticRecords;
  artifactsDirectory: string;
};

function createSyntheticStore(root: string): SyntheticStore {
  const artifactsDirectory = join(root, 'artifacts');
  return {
    store: createArtifactStore({ artifactsDirectory, redact: createRedactor([PROVIDER_SECRET]) }),
    records: buildSyntheticRecords(),
    artifactsDirectory,
  };
}

async function startSyntheticStore(root: string): Promise<SyntheticStore> {
  const synthetic = createSyntheticStore(root);
  expect(await synthetic.store.startRun(synthetic.records.manifest)).toEqual({
    ok: true,
    value: undefined,
  });
  return synthetic;
}

function unwrap<T>(result: TevuResult<T, 'ArtifactError'>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/** Builds a finalized run that also holds a grading, an assessment, and conclusions. */
async function createCompleteRun(root: string): Promise<SyntheticStore & { runId: string }> {
  const synthetic = await startSyntheticStore(root);
  const { store, records } = synthetic;
  const [alpha, beta, gamma] = records.caseResults as [CaseResult, CaseResult, CaseResult];
  unwrap(await store.writeChecks('task-1--alpha--1', alpha.checks));
  unwrap(await store.writeChecks('task-1--beta--1', beta.checks));
  unwrap(await store.writeGrading('task-1--alpha--1', buildGrading()));
  for (const result of [alpha, beta, gamma]) {
    unwrap(await store.finalizeCase(result));
  }
  unwrap(
    await store.finalizeRun({
      schemaVersion: 1,
      manifest: records.manifest,
      cases: records.caseResults,
      findings: records.findings,
      exitCode: 2,
    }),
  );
  unwrap(await store.replaceAssessment(records.assessment));
  unwrap(await store.writeConclusions(buildConclusions(records.runId)));
  return { ...synthetic, runId: records.runId };
}

type WriterCase = {
  name: string;
  operation: string;
  setup: (root: string) => Promise<SyntheticStore & { runId: string }>;
  write: (
    synthetic: SyntheticStore & { runId: string },
  ) => Promise<TevuResult<void, 'ArtifactError'>>;
  reason: (runId: string) => string;
};

async function createStartedRun(root: string): Promise<SyntheticStore & { runId: string }> {
  const synthetic = await startSyntheticStore(root);
  return { ...synthetic, runId: synthetic.records.runId };
}

async function createUnstartedRun(root: string): Promise<SyntheticStore & { runId: string }> {
  const synthetic = createSyntheticStore(root);
  return { ...synthetic, runId: synthetic.records.runId };
}

function withUnexpectedKey<T extends object>(value: T): T {
  return { ...value, unexpected: 1 };
}

const WRITER_CASES: WriterCase[] = [
  {
    name: 'startRun',
    operation: 'start-run',
    setup: createUnstartedRun,
    write: ({ store, records }) => store.startRun(withUnexpectedKey(records.manifest)),
    reason: (runId) =>
      `stored manifest for run "${runId}" has a malformed shape or mismatched identity at unexpected`,
  },
  {
    name: 'writeChecks',
    operation: 'write-checks',
    setup: createStartedRun,
    write: ({ store, records }) =>
      store.writeChecks(
        'task-1--alpha--1',
        (records.caseResults[0] as CaseResult).checks.map(withUnexpectedKey),
      ),
    reason: (runId) =>
      `checks artifact for "task-1--alpha--1" in run "${runId}" has a malformed shape at checks.0.unexpected`,
  },
  {
    name: 'writeGrading',
    operation: 'write-grading',
    setup: createStartedRun,
    write: ({ store }) => store.writeGrading('task-1--alpha--1', withUnexpectedKey(buildGrading())),
    reason: (runId) =>
      `grading artifact for "task-1--alpha--1" in run "${runId}" has a malformed shape at unexpected`,
  },
  {
    name: 'finalizeCase',
    operation: 'finalize-case',
    setup: createStartedRun,
    write: ({ store, records }) =>
      store.finalizeCase(withUnexpectedKey(records.caseResults[0] as CaseResult)),
    reason: (runId) =>
      `case result for "task-1--alpha--1" in run "${runId}" has a malformed shape at unexpected`,
  },
  {
    name: 'replaceCaseResult',
    operation: 'replace-case-result',
    setup: createCompleteRun,
    write: ({ store, records, runId }) =>
      store.replaceCaseResult(runId, withUnexpectedKey(records.caseResults[0] as CaseResult)),
    reason: (runId) =>
      `case result for "task-1--alpha--1" in run "${runId}" has a malformed shape at unexpected`,
  },
  {
    name: 'finalizeRun',
    operation: 'finalize-run',
    setup: createStartedRun,
    write: ({ store, records }) =>
      store.finalizeRun(
        withUnexpectedKey({
          schemaVersion: 1,
          manifest: records.manifest,
          cases: records.caseResults,
          findings: records.findings,
          exitCode: 2,
        } satisfies RunResult),
      ),
    reason: (runId) =>
      `run result for "${runId}" has a malformed shape or mismatched identity at unexpected`,
  },
  {
    name: 'replaceAssessment',
    operation: 'replace-assessment',
    setup: createCompleteRun,
    write: ({ store, records }) => store.replaceAssessment(withUnexpectedKey(records.assessment)),
    reason: (runId) =>
      `assessment artifact for "task-1--alpha--1" in run "${runId}" has a malformed shape or mismatched identity at unexpected`,
  },
  {
    name: 'writeConclusions',
    operation: 'write-conclusions',
    setup: createCompleteRun,
    write: ({ store, runId }) => store.writeConclusions(withUnexpectedKey(buildConclusions(runId))),
    reason: (runId) =>
      `conclusions.json of run "${runId}" is malformed; delete it to make the summary use template sentences: it has a malformed shape or mismatched identity at unexpected`,
  },
];

describe('OpenCode report regeneration refuses a defective run record', () => {
  it('returns the malformed case of run.json, throws nothing, and writes no file (AC-1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-ac1-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const runJsonPath = join(root, 'artifacts', runId, 'run.json');
      const stored = JSON.parse(await readFile(runJsonPath, 'utf8')) as {
        cases: Array<Record<string, unknown>>;
      };
      delete stored.cases[0]?.['metrics'];
      await writeFile(runJsonPath, JSON.stringify(stored, null, 2), 'utf8');
      const before = await snapshotTree(root);

      const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ArtifactError',
          operation: 'read-run-result',
          reason: `run result for "${runId}" has a malformed shape or mismatched identity at cases.0.metrics`,
        },
      });
      expect(await snapshotTree(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a defective case record from assessCase without throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-ac1-assess-'));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const resultPath = caseFile(root, runId, 'task-1--alpha--1', 'result.json');
      const stored = JSON.parse(await readFile(resultPath, 'utf8')) as Record<string, unknown>;
      delete stored['metrics'];
      await writeFile(resultPath, JSON.stringify(stored, null, 2), 'utf8');
      const before = await snapshotTree(root);

      const assessed = await assessCase(
        {
          runId,
          caseId: 'task-1--alpha--1',
          decisions: [
            {
              checkId: 'man-optional-polish',
              verdict: 'passed',
              assessor: 'curator',
              note: 'unreachable: the case record read fails first',
              replaceExisting: false,
            },
          ],
          assessedAt: '2026-09-23T02:00:00.000Z',
        },
        store,
        AGENTS_REGISTRY,
      );

      expect(assessed).toEqual({
        ok: false,
        error: {
          kind: 'ArtifactError',
          operation: 'read-case-result',
          reason: `case result for "task-1--alpha--1" in run "${runId}" has a malformed shape at metrics`,
        },
      });
      expect(await snapshotTree(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('FileArtifactStore writers parse what they write', () => {
  it.each(WRITER_CASES)(
    '$name refuses a value its reader refuses and leaves every file as it was',
    async (writer) => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-writer-'));
      try {
        const synthetic = await writer.setup(root);
        const before = await snapshotTree(root);

        const result = await writer.write(synthetic);

        expect(result).toEqual({
          ok: false,
          error: {
            kind: 'ArtifactError',
            operation: writer.operation,
            reason: writer.reason(synthetic.runId),
          },
        });
        expect(await snapshotTree(root)).toEqual(before);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('creates no directory when startRun refuses the manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-start-run-'));
    try {
      const { store, records, artifactsDirectory } = createSyntheticStore(root);

      const result = await store.startRun(withUnexpectedKey(records.manifest));

      expect(result.ok).toBe(false);
      expect(existsSync(artifactsDirectory)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes files that parse back to the values it wrote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-round-trip-'));
    try {
      const { store, runId } = await createCompleteRun(root);
      const readText = async (...segments: string[]) =>
        readFile(join(root, 'artifacts', runId, ...segments), 'utf8');
      const caseId = 'task-1--alpha--1';

      const written = {
        run: JSON.parse(await readText('run.json')) as { manifest: unknown },
        case: JSON.parse(await readText('cases', caseId, 'result.json')) as unknown,
        checks: JSON.parse(await readText('cases', caseId, 'checks.json')) as { checks: unknown },
        grading: JSON.parse(await readText('cases', caseId, 'grading.json')) as unknown,
        assessment: JSON.parse(await readText('cases', caseId, 'assessment.json')) as unknown,
        conclusions: JSON.parse(await readText('conclusions.json')) as unknown,
      };

      expect(unwrap(await store.readRunResult(runId))).toEqual(written.run);
      expect(unwrap(await store.readRunManifest(runId))).toEqual(written.run.manifest);
      expect(unwrap(await store.readCaseResult(runId, caseId))).toEqual(written.case);
      expect(unwrap(await store.readChecks(runId, caseId))).toEqual(written.checks.checks);
      expect(unwrap(await store.readGrading(runId, caseId))).toEqual(written.grading);
      expect(unwrap(await store.readAssessment(runId, caseId))).toEqual(written.assessment);
      expect(unwrap(await store.readConclusions(runId))).toEqual(written.conclusions);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

type ReaderCase = {
  name: string;
  operation: string;
  file: string[];
  read: (store: ArtifactStore, runId: string) => Promise<TevuResult<unknown, 'ArtifactError'>>;
  /** Where the checked field sits in the stored file, and where the reader reports it. */
  field: { stored: string[]; reported: string };
  /** The object of the stored file that receives an unknown key, and where the reader reports it. */
  container: { stored: string[]; reported: string };
  sentence: (runId: string) => string;
};

const ALPHA = 'task-1--alpha--1';

const READER_CASES: ReaderCase[] = [
  {
    name: 'readRunManifest',
    operation: 'read-run-manifest',
    file: ['run.json'],
    read: (store, runId) => store.readRunManifest(runId),
    field: { stored: ['manifest', 'execution', 'concurrency'], reported: 'execution.concurrency' },
    container: { stored: ['manifest'], reported: '' },
    sentence: (runId) =>
      `stored manifest for run "${runId}" has a malformed shape or mismatched identity`,
  },
  {
    name: 'readRunResult',
    operation: 'read-run-result',
    file: ['run.json'],
    read: (store, runId) => store.readRunResult(runId),
    field: {
      stored: ['cases', '0', 'metrics', 'cost', 'value'],
      reported: 'cases.0.metrics.cost.value',
    },
    container: { stored: [], reported: '' },
    sentence: (runId) => `run result for "${runId}" has a malformed shape or mismatched identity`,
  },
  {
    name: 'readCaseResult',
    operation: 'read-case-result',
    file: ['cases', ALPHA, 'result.json'],
    read: (store, runId) => store.readCaseResult(runId, ALPHA),
    field: { stored: ['identity', 'attempt'], reported: 'identity.attempt' },
    container: { stored: [], reported: '' },
    sentence: (runId) => `case result for "${ALPHA}" in run "${runId}" has a malformed shape`,
  },
  {
    name: 'readChecks',
    operation: 'read-checks',
    file: ['cases', ALPHA, 'checks.json'],
    read: (store, runId) => store.readChecks(runId, ALPHA),
    field: { stored: ['checks', '0', 'durationMs'], reported: 'checks.0.durationMs' },
    container: { stored: [], reported: '' },
    sentence: (runId) => `checks artifact for "${ALPHA}" in run "${runId}" has a malformed shape`,
  },
  {
    name: 'readGrading',
    operation: 'read-grading',
    file: ['cases', ALPHA, 'grading.json'],
    read: (store, runId) => store.readGrading(runId, ALPHA),
    field: { stored: ['calls', '0', 'events'], reported: 'calls.0.events' },
    container: { stored: [], reported: '' },
    sentence: (runId) => `grading artifact for "${ALPHA}" in run "${runId}" has a malformed shape`,
  },
  {
    name: 'readAssessment',
    operation: 'read-assessment',
    file: ['cases', ALPHA, 'assessment.json'],
    read: (store, runId) => store.readAssessment(runId, ALPHA),
    field: { stored: ['revision'], reported: 'revision' },
    container: { stored: ['current', '0'], reported: 'current.0' },
    sentence: (runId) =>
      `assessment artifact for "${ALPHA}" in run "${runId}" has a malformed shape or mismatched identity`,
  },
  {
    name: 'readConclusions',
    operation: 'read-conclusions',
    file: ['conclusions.json'],
    read: (store, runId) => store.readConclusions(runId),
    field: { stored: ['tasks', '0', 'facts', 'repeat'], reported: 'tasks.0.facts.repeat' },
    container: { stored: ['tasks', '0', 'conclusions'], reported: 'tasks.0.conclusions' },
    sentence: (runId) =>
      `conclusions.json of run "${runId}" is malformed; delete it to make the summary use template sentences: it has a malformed shape or mismatched identity`,
  },
];

async function editStoredJson(
  filePath: string,
  edit: (stored: Record<string, unknown>) => void,
): Promise<void> {
  const stored = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  edit(stored);
  await writeFile(filePath, JSON.stringify(stored, null, 2), 'utf8');
}

function objectAt(
  root: Record<string, unknown>,
  segments: readonly string[],
): Record<string, unknown> {
  let current: unknown = root;
  for (const segment of segments) {
    current = (current as Record<string, unknown>)[segment];
  }
  return current as Record<string, unknown>;
}

describe('FileArtifactStore readers refuse what their parsers refuse', () => {
  it.each(READER_CASES)(
    '$name names the field that holds a value of another type',
    async (reader) => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-reader-'));
      try {
        const { store, runId } = await createCompleteRun(root);
        const [fieldName, ...parentSegments] = [...reader.field.stored].reverse();
        await editStoredJson(join(root, 'artifacts', runId, ...reader.file), (stored) => {
          objectAt(stored, parentSegments.reverse())[fieldName as string] = { wrong: [true] };
        });

        const result = await reader.read(store, runId);

        expect(result).toEqual({
          ok: false,
          error: {
            kind: 'ArtifactError',
            operation: reader.operation,
            reason: `${reader.sentence(runId)} at ${reader.field.reported}`,
          },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(READER_CASES)(
    '$name keeps an unknown key out of the artifact and redacts it on the terminal',
    async (reader) => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-reader-secret-'));
      try {
        const { store, runId } = await createCompleteRun(root);
        await editStoredJson(join(root, 'artifacts', runId, ...reader.file), (stored) => {
          objectAt(stored, reader.container.stored)[SECRET_KEY] = 'value-for-the-unknown-key';
        });

        const result = await reader.read(store, runId);

        const reportedPath =
          reader.container.reported === ''
            ? SECRET_KEY
            : `${reader.container.reported}.${SECRET_KEY}`;
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.reason).toBe(`${reader.sentence(runId)} at ${reportedPath}`);
        const printed = createRedactor([SECRET_KEY])(result.error.reason);
        expect(printed).toBe(
          `${reader.sentence(runId)} at ${reportedPath.replace(SECRET_KEY, '[REDACTED]')}`,
        );
        expect(printed).not.toContain(SECRET_KEY);
        expect(result.error.reason).not.toContain('value-for-the-unknown-key');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(READER_CASES)(
    '$name keeps the value of a mistyped field out of the reason',
    async (reader) => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-reader-value-'));
      try {
        const { store, runId } = await createCompleteRun(root);
        const [fieldName, ...parentSegments] = [...reader.field.stored].reverse();
        await editStoredJson(join(root, 'artifacts', runId, ...reader.file), (stored) => {
          objectAt(stored, parentSegments.reverse())[fieldName as string] = SECRET_KEY;
        });

        const result = await reader.read(store, runId);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.reason).not.toContain(SECRET_KEY);
        expect(result.error.reason).toContain(` at ${reader.field.reported}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('FileArtifactStore refuses before it touches the filesystem', () => {
  it('creates no directory when the redactor throws while startRun redacts the manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-start-run-redaction-'));
    try {
      const artifactsDirectory = join(root, 'artifacts');
      const store = createArtifactStore({
        artifactsDirectory,
        redact: () => {
          throw new Error('synthetic redactor failure');
        },
      });

      const result = await store.startRun(buildSyntheticRecords().manifest);

      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'ArtifactError', operation: 'start-run' },
      });
      if (!result.ok) {
        expect(result.error.reason).toMatch(/^redaction failed; write aborted: /);
      }
      expect(existsSync(artifactsDirectory)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves the store free to start the run after a refused manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-start-run-retry-'));
    try {
      const { store, records } = createSyntheticStore(root);
      expect((await store.startRun(withUnexpectedKey(records.manifest))).ok).toBe(false);

      const result = await store.startRun(records.manifest);

      expect(result).toEqual({ ok: true, value: undefined });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'replaceAssessment',
      operation: 'replace-assessment',
      write: (store: ArtifactStore, assessment: AssessmentArtifact) =>
        store.replaceAssessment(withUnexpectedKey({ ...assessment, caseId: 'task-9--ghost--1' })),
      reason: (runId: string) => `case "task-9--ghost--1" does not exist in run "${runId}"`,
    },
    {
      name: 'writeConclusions',
      operation: 'write-conclusions',
      write: (store: ArtifactStore, assessment: AssessmentArtifact) =>
        store.writeConclusions(withUnexpectedKey(buildConclusions(`${assessment.runId}-missing`))),
      reason: (runId: string) => `run directory for "${runId}-missing" does not exist`,
    },
  ])(
    '$name reports the missing directory before the defect of the value',
    async ({ operation, write, reason }) => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-precedence-'));
      try {
        const { store, records, runId } = await createCompleteRun(root);
        const before = await snapshotTree(root);

        const result = await write(store, records.assessment);

        expect(result).toEqual({
          ok: false,
          error: { kind: 'ArtifactError', operation, reason: reason(runId) },
        });
        expect(await snapshotTree(root)).toEqual(before);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      name: 'replaceAssessment',
      write: (store: ArtifactStore, assessment: AssessmentArtifact) =>
        store.replaceAssessment(withUnexpectedKey({ ...assessment, runId: '../escape' })),
      reason: 'run ID "../escape" is not a valid identifier',
    },
    {
      name: 'writeConclusions',
      write: (store: ArtifactStore) =>
        store.writeConclusions(withUnexpectedKey(buildConclusions('../escape'))),
      reason: 'run ID "../escape" is not a valid identifier',
    },
  ])('$name reports an invalid identifier before the defect of the value', async (writer) => {
    const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-identifier-'));
    try {
      const { store, records } = await createCompleteRun(root);

      const result = await writer.write(store, records.assessment);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe(writer.reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('FileArtifactStore readers refuse a file stored under another identity', () => {
  const IDENTITY_CASES = [
    { reader: 'readRunManifest', segments: ['manifest', 'runId'], reported: 'runId' },
    { reader: 'readRunResult', segments: ['manifest', 'runId'], reported: 'manifest.runId' },
    { reader: 'readCaseResult', segments: ['identity', 'caseId'], reported: 'identity.caseId' },
    { reader: 'readChecks', segments: ['runId'], reported: 'runId' },
    { reader: 'readChecks', segments: ['caseId'], reported: 'caseId' },
    { reader: 'readGrading', segments: ['runId'], reported: 'runId' },
    { reader: 'readGrading', segments: ['caseId'], reported: 'caseId' },
    { reader: 'readAssessment', segments: ['runId'], reported: 'runId' },
    { reader: 'readAssessment', segments: ['caseId'], reported: 'caseId' },
    { reader: 'readConclusions', segments: ['runId'], reported: 'runId' },
  ];

  it.each(IDENTITY_CASES)(
    '$reader names $reported when the stored value belongs to another run or case',
    async ({ reader, segments, reported }) => {
      const root = await mkdtemp(join(tmpdir(), 'tevu-opencode-report-identity-'));
      try {
        const { store, runId } = await createCompleteRun(root);
        const readerCase = READER_CASES.find((candidate) => candidate.name === reader);
        if (readerCase === undefined) throw new Error(`no reader case named ${reader}`);
        const [fieldName, ...parentSegments] = [...segments].reverse();
        await editStoredJson(join(root, 'artifacts', runId, ...readerCase.file), (stored) => {
          objectAt(stored, parentSegments.reverse())[fieldName as string] = 'another-identity';
        });

        const result = await readerCase.read(store, runId);

        expect(result).toEqual({
          ok: false,
          error: {
            kind: 'ArtifactError',
            operation: readerCase.operation,
            reason: `${readerCase.sentence(runId)} at ${reported}`,
          },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
