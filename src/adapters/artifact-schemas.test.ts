import { describe, expect, it } from 'vitest';

import {
  parseAssessmentArtifact,
  parseCaseResult,
  parseChecksArtifact,
  parseConclusionsArtifact,
  parseGradingArtifact,
  parseRunManifest,
  parseRunResult,
} from '@/adapters/artifact-schemas';
import { unavailableAgentMetrics, unavailableBenchmarkMetrics } from '@/domain/types';

import type { ChecksArtifact } from '@/adapters/artifact-schemas';
import type {
  AgentMetrics,
  AssessmentArtifact,
  CaseResult,
  ConclusionsArtifact,
  GradingArtifact,
  RunManifest,
  RunResult,
} from '@/domain/types';

const RUN_ID = '20260923t000000z-synthetic';
const CASE_ID = 'task-1--alpha--1';
const SECRET = 'synthetic-acme-secret-value';

type JsonObject = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function buildMetrics(): AgentMetrics {
  return {
    ...unavailableAgentMetrics('not reported'),
    inputTokens: {
      value: 120,
      unit: 'token',
      availability: { status: 'available', source: 'export' },
      scope: 'root-session',
    },
  };
}

function buildManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    configDigest: 'sha256-synthetic',
    configPath: '/synthetic/tevu.yaml',
    startedAt: '2026-09-23T00:00:00.000Z',
    completedAt: null,
    host: { platform: 'linux', nodeVersion: 'v24.0.0' },
    tools: {
      gitVersion: 'git version 2.45.0',
      agentVersions: { opencode: '1.2.3', other: null },
      agentConfigurationFiles: { opencode: [{ path: 'opencode/opencode.json', sha256: 'ab' }] },
      copiedProviders: { opencode: [{ id: 'acme', pricedModels: ['m1'] }] },
    },
    execution: { concurrency: 2, caseTimeoutMs: 60_000, repeat: { value: 1, source: 'config' } },
    cases: [
      {
        caseId: CASE_ID,
        taskId: 'task-1',
        modelId: 'alpha',
        attempt: 1,
        sourceCommit: '0123456789abcdef0123456789abcdef01234567',
        model: 'vendor/model-alpha',
        effort: 'high',
        agent: 'opencode',
        timeoutMs: 60_000,
      },
    ],
    efforts: {
      models: { alpha: { status: 'unverified', reason: 'not reported' } },
      grader: { status: 'verified' },
    },
    context: {
      config: { roles: { grader: { model: 'vendor/grader' } }, anything: [1, 'two'] },
      capabilities: {
        opencode: {
          executable: '/synthetic/opencode',
          detectedVersion: null,
          capabilities: [{ name: 'run command', required: true, availability: 'available' }],
          isolation: { denyOutsideWorktree: 'unavailable' },
        },
      },
    },
    ...overrides,
  };
}

function buildCaseResult(): CaseResult {
  const manifestCase = buildManifest().cases[0];
  if (manifestCase === undefined) {
    throw new Error('the synthetic manifest holds one case');
  }
  return {
    schemaVersion: 1,
    identity: manifestCase,
    lifecycle: 'infrastructure-failed',
    process: {
      exitCode: null,
      signal: 'SIGKILL',
      startedAt: '2026-09-23T00:00:00.000Z',
      endedAt: '2026-09-23T00:00:01.000Z',
      durationMs: 1000,
      terminationStage: 'forced',
    },
    outcome: 'not-evaluated',
    checks: [
      {
        checkId: 'acc-1',
        category: 'acceptance',
        verdict: 'not-run',
        evidence: 'skipped',
        durationMs: null,
      },
    ],
    metrics: unavailableBenchmarkMetrics('no export'),
    artifacts: {
      events: `cases/${CASE_ID}/events.jsonl`,
      diagnostics: null,
      sessionExport: null,
      solutionPatch: null,
      checks: `cases/${CASE_ID}/checks.json`,
      assessment: null,
      grading: `cases/${CASE_ID}/grading.json`,
      result: `cases/${CASE_ID}/result.json`,
    },
    failure: {
      error: {
        kind: 'AgentProtocolError',
        agent: 'opencode',
        context: { phase: 'case', caseId: CASE_ID },
        line: 3,
        reason: 'event record does not match',
      },
      occurredAt: '2026-09-23T00:00:02.000Z',
    },
    checkState: {
      restore: { restored: ['a.ts'], removed: [] },
      overlay: { files: [{ path: 'b.test.ts', sha256: 'cd' }], removed: ['c'] },
    },
    setup: {
      logs: { beforeAgent: 'cases/x/setup-before-agent.log', beforeChecks: null },
      commands: [
        {
          phase: 'before_agent',
          argv: ['npm', 'ci'],
          exitCode: 0,
          durationMs: 5,
          outcome: 'passed',
        },
      ],
    },
    context: {
      sourceRepositoryPath: '/synthetic/repo',
      syntheticCommit: 'feedface',
      environment: [{ name: 'HOME', classification: 'fixed', recipient: 'agent' }],
    },
  };
}

function buildRunResult(): RunResult {
  return {
    schemaVersion: 1,
    manifest: buildManifest(),
    cases: [buildCaseResult()],
    findings: [{ severity: 'warning', caseId: null, message: 'cleanup warning' }],
    exitCode: 130,
  };
}

function buildChecks(): ChecksArtifact {
  return { schemaVersion: 1, runId: RUN_ID, caseId: CASE_ID, checks: buildCaseResult().checks };
}

function buildGrading(): GradingArtifact {
  const grader = { model: 'vendor/grader', effort: 'high', agent: 'opencode' } as const;
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    caseId: CASE_ID,
    grader,
    call: { status: 'replied', reply: 'PASS' },
    calls: [
      {
        outcome: { status: 'no-reply', cause: 'unfinished', reason: 'stopped early' },
        metrics: buildMetrics(),
        events: [{ type: 'text', anything: [1] }, 'opaque'],
        diagnostics: 'stderr text',
        session: { info: { id: 'ses-1' }, extra: true },
      },
      {
        outcome: { status: 'replied' },
        metrics: buildMetrics(),
        events: [],
        diagnostics: '',
        session: null,
      },
    ],
    metrics: buildMetrics(),
    grades: [
      {
        checkId: 'acc-2',
        category: 'acceptance',
        status: 'graded',
        verdict: 'undetermined',
        rationale: 'unclear',
      },
      { checkId: 'dod-1', category: 'definition-of-done', status: 'pending', reason: 'no reply' },
    ],
  };
}

function buildAssessment(): AssessmentArtifact {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    caseId: CASE_ID,
    revision: 3,
    current: [
      {
        checkId: 'man-1',
        verdict: 'passed',
        assessor: 'curator',
        note: 'confirmed',
        assessedAt: '2026-09-23T01:00:00.000Z',
      },
    ],
    history: [
      {
        checkId: 'man-1',
        verdict: 'failed',
        assessor: 'curator',
        note: 'rework',
        assessedAt: '2026-09-23T00:30:00.000Z',
        source: 'operator',
        replacedAt: '2026-09-23T01:00:00.000Z',
      },
      {
        source: 'grader',
        checkId: 'gr-1',
        verdict: 'failed',
        rationale: 'missing test',
        grader: { model: 'vendor/grader', effort: 'high', agent: 'opencode' },
        replacedAt: '2026-09-23T01:00:00.000Z',
      },
    ],
  };
}

function buildConclusions(): ConclusionsArtifact {
  const known = { status: 'known', value: 3, text: '$3', reportedAttempts: 2 } as const;
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    tasks: [
      {
        taskId: 'task-1',
        facts: {
          task: 'Task one',
          repository: 'repo-1',
          when: '2026-09-23',
          repeat: 2,
          requiredChecksPerAttempt: 3,
          settings: [
            {
              name: 'alpha',
              model: 'vendor/model-alpha',
              effort: 'high',
              planned: 2,
              outcomes: { passed: 1, failed: 0, pending: 0, notEvaluated: 1 },
              requiredChecks: { passed: 3, failed: 0, pending: 0, notRun: 3, total: 6 },
              didTask: false,
              cost: known,
              elapsed: { status: 'unknown' },
              dropout: { timedOut: 0, failedToRun: 1, failedToRunLabels: ['launch'], waiting: 0 },
            },
          ],
          separation: 'passed',
          cost: {
            kind: 'leader',
            leaders: ['alpha'],
            value: '$3',
            next: { value: '$4', margin: { kind: 'percent', value: '25' } },
            unknown: [],
            partial: [{ name: 'beta', reportedAttempts: 1 }],
          },
          speed: { kind: 'none-did-the-task' },
        },
        table: ['| a | b |'],
        conclusions: { correctness: 'c1', cost: 'c2', speed: 'c3' },
        call: {
          model: { model: 'vendor/summary', effort: 'high', agent: 'opencode' },
          outcome: { status: 'rejected', reply: 'text', reason: 'too long' },
          metrics: buildMetrics(),
        },
      },
      {
        taskId: 'task-2',
        facts: {
          task: 'Task two',
          repository: 'repo-1',
          when: '2026-09-23',
          repeat: 1,
          requiredChecksPerAttempt: 0,
          settings: [],
          separation: null,
          cost: { kind: 'only-setting', leader: 'alpha' },
          speed: { kind: 'not-enough-data', unknown: ['beta'] },
        },
        table: [],
        conclusions: { correctness: 'c1', cost: 'c2', speed: 'c3' },
        call: null,
      },
    ],
  };
}

type Parser = {
  name: string;
  build: () => unknown;
  parse: (value: unknown) => { ok: true; value: unknown } | { ok: false; defectPath: string };
  recordPaths: string[];
  opaquePaths: string[];
};

const PARSERS: Parser[] = [
  {
    name: 'parseRunManifest',
    build: buildManifest,
    parse: (value) => parseRunManifest(value, RUN_ID),
    recordPaths: [
      'tools.agentVersions',
      'tools.agentConfigurationFiles',
      'tools.copiedProviders',
      'efforts.models',
      'context.capabilities',
    ],
    opaquePaths: ['context.config'],
  },
  {
    name: 'parseRunResult',
    build: buildRunResult,
    parse: (value) => parseRunResult(value, RUN_ID),
    recordPaths: [
      'manifest.tools.agentVersions',
      'manifest.tools.agentConfigurationFiles',
      'manifest.tools.copiedProviders',
      'manifest.efforts.models',
      'manifest.context.capabilities',
    ],
    opaquePaths: ['manifest.context.config'],
  },
  {
    name: 'parseCaseResult',
    build: buildCaseResult,
    parse: (value) => parseCaseResult(value, CASE_ID),
    recordPaths: [],
    opaquePaths: [],
  },
  {
    name: 'parseChecksArtifact',
    build: buildChecks,
    parse: (value) => parseChecksArtifact(value, RUN_ID, CASE_ID),
    recordPaths: [],
    opaquePaths: [],
  },
  {
    name: 'parseGradingArtifact',
    build: buildGrading,
    parse: (value) => parseGradingArtifact(value, RUN_ID, CASE_ID),
    recordPaths: [],
    opaquePaths: ['calls.0.session', 'calls.0.events.0'],
  },
  {
    name: 'parseAssessmentArtifact',
    build: buildAssessment,
    parse: (value) => parseAssessmentArtifact(value, RUN_ID, CASE_ID),
    recordPaths: [],
    opaquePaths: [],
  },
  {
    name: 'parseConclusionsArtifact',
    build: buildConclusions,
    parse: (value) => parseConclusionsArtifact(value, RUN_ID),
    recordPaths: [],
    opaquePaths: [],
  },
];

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childPath(parent: string, segment: string | number): string {
  return parent === '' ? String(segment) : `${parent}.${segment}`;
}

/** Paths of every strict object of the value: the places an unknown key is a defect. */
function strictObjectPaths(parser: Parser, value: unknown, path = ''): string[] {
  if (parser.opaquePaths.includes(path)) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      strictObjectPaths(parser, entry, childPath(path, index)),
    );
  }
  if (!isObject(value)) {
    return [];
  }
  const own = parser.recordPaths.includes(path) ? [] : [path];
  const nested = Object.entries(value).flatMap(([key, entry]) =>
    strictObjectPaths(parser, entry, childPath(path, key)),
  );
  return [...own, ...nested];
}

function segmentsOf(path: string): string[] {
  return path === '' ? [] : path.split('.');
}

function readAt(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of segmentsOf(path)) {
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writeAt(value: unknown, path: string, replacement: unknown): void {
  const segments = segmentsOf(path);
  const last = segments.pop();
  if (last === undefined) {
    throw new Error('the root cannot be replaced in place');
  }
  const parent = readAt(value, segments.join('.')) as Record<string, unknown>;
  parent[last] = replacement;
}

function deleteAt(value: unknown, path: string): void {
  const segments = segmentsOf(path);
  const last = segments.pop();
  if (last === undefined) {
    throw new Error('the root cannot be deleted');
  }
  delete (readAt(value, segments.join('.')) as Record<string, unknown>)[last];
}

function withReplacement(parser: Parser, path: string, replacement: unknown): unknown {
  const value = clone(parser.build());
  writeAt(value, path, replacement);
  return value;
}

describe('parse functions on values shaped like the real producers write them', () => {
  it.each(PARSERS)('$name accepts its representative value and keeps its key order', (parser) => {
    const input = parser.build();

    const parsed = parser.parse(input);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(JSON.stringify(parsed.value)).toBe(JSON.stringify(input));
    }
  });

  it('accepts a manifest without a context and without a grader check', () => {
    const manifest = buildManifest();
    delete manifest.context;
    manifest.efforts.grader = null;

    expect(parseRunManifest(manifest, RUN_ID).ok).toBe(true);
  });

  it('accepts a case result without its optional records', () => {
    const result = buildCaseResult();
    delete result.checkState;
    delete result.setup;
    delete result.context;
    result.process = null;
    result.failure = null;
    result.artifacts.grading = null;

    expect(parseCaseResult(result, CASE_ID).ok).toBe(true);
  });

  it('accepts every tevu error variant a case failure can hold', () => {
    const errors: unknown[] = [
      {
        kind: 'ConfigParseError',
        findings: [{ severity: 'error', identifier: 'a', message: 'b' }],
      },
      { kind: 'ConfigValidationError', findings: [] },
      { kind: 'ConfigReadError', path: '/a', requestedPath: 'a', cause: 'not-found' },
      { kind: 'ConfigNotFoundError', searchedPaths: ['/a', '/b'] },
      { kind: 'PrerequisiteError', tool: 'git', expected: '2', actual: '1' },
      { kind: 'SourceMaterializationError', taskId: 't', reason: 'r' },
      { kind: 'IsolationError', caseId: CASE_ID, reason: 'r' },
      {
        kind: 'IssueImportError',
        tracker: 'jira-cloud',
        reference: 'K-1',
        status: 404,
        reason: 'r',
      },
      { kind: 'AgentProcessError', agent: 'a', caseId: CASE_ID, exitCode: 1, signal: null },
      {
        kind: 'AgentProtocolError',
        agent: 'a',
        context: { phase: 'call', role: 'grader' },
        reason: 'r',
      },
      { kind: 'AgentProtocolError', agent: 'a', context: { phase: 'probe' }, reason: 'r' },
      { kind: 'AgentSessionError', agent: 'a', caseId: CASE_ID, agentMessage: 'm' },
      { kind: 'ModelCallError', role: 'summary', agent: 'a', cause: 'timed-out', reason: 'r' },
      { kind: 'CaseTimeoutError', caseId: CASE_ID, timeoutMs: 5 },
      { kind: 'EvaluationError', caseId: CASE_ID, checkId: 'c', reason: 'r' },
      { kind: 'AssessmentConflictError', runId: RUN_ID, caseId: CASE_ID, reason: 'r' },
      { kind: 'ArtifactError', operation: 'o', reason: 'r' },
      { kind: 'RedactionError', reason: 'r' },
      { kind: 'CancellationError', activeCaseIds: [CASE_ID] },
      { kind: 'CheckStateError', step: 'overlay', reason: 'r' },
      { kind: 'SetupError', phase: 'before_checks', argv: ['x'], reason: 'r' },
      { kind: 'ReferenceResolutionError', reason: 'r' },
      { kind: 'ManagedCloneError', operation: 'lfs-fetch', repository: 'a/b', reason: 'r' },
    ];

    for (const error of errors) {
      const value = withReplacement(PARSERS[2] as Parser, 'failure.error', error);
      const parsed = parseCaseResult(value, CASE_ID);
      expect(parsed.ok, JSON.stringify(error)).toBe(true);
    }
  });
});

describe('a checked field holding a value of another JSON type', () => {
  const TABLE: Array<[parser: string, path: string, replacement: unknown]> = [
    ['parseRunManifest', 'runId', 5],
    ['parseRunManifest', 'configPath', ''],
    ['parseRunManifest', 'completedAt', 7],
    ['parseRunManifest', 'host.platform', 'win32'],
    ['parseRunManifest', 'tools.agentVersions.opencode', 3],
    ['parseRunManifest', 'tools.copiedProviders.opencode.0.pricedModels', 'm1'],
    ['parseRunManifest', 'tools.copiedProviders.opencode.0.id', ''],
    ['parseRunManifest', 'execution.repeat.value', 0],
    ['parseRunManifest', 'execution.repeat.source', 'env'],
    ['parseRunManifest', 'cases.0.attempt', '1'],
    ['parseRunManifest', 'cases.0.timeoutMs', 1.5],
    ['parseRunManifest', 'cases.0.agent', ''],
    ['parseRunManifest', 'efforts.models.alpha.reason', ''],
    ['parseRunManifest', 'efforts.models.alpha.status', 'checked'],
    ['parseRunManifest', 'efforts.grader', 'verified'],
    ['parseRunManifest', 'context.capabilities.opencode.capabilities', {}],
    ['parseRunResult', 'cases', {}],
    ['parseRunResult', 'cases.0.metrics', 'none'],
    ['parseRunResult', 'cases.0.metrics.cost.value', '5'],
    ['parseRunResult', 'cases.0.metrics.cost.availability', 5],
    ['parseRunResult', 'cases.0.metrics.cost.availability.status', 'missing'],
    ['parseRunResult', 'cases.0.failure.error.kind', 'Unknown'],
    ['parseRunResult', 'exitCode', 3],
    ['parseRunResult', 'exitCode', '1'],
    ['parseRunResult', 'findings.0.severity', 'info'],
    ['parseRunResult', 'manifest.efforts', null],
    ['parseCaseResult', 'identity', []],
    ['parseCaseResult', 'identity.attempt', 0],
    ['parseCaseResult', 'identity.agent', 7],
    ['parseCaseResult', 'lifecycle', 'running-forever'],
    ['parseCaseResult', 'process.durationMs', '5'],
    ['parseCaseResult', 'outcome', true],
    ['parseCaseResult', 'checks', 'none'],
    ['parseCaseResult', 'checks.0.verdict', 'skipped'],
    ['parseCaseResult', 'metrics.turns.unit', 'bytes'],
    ['parseCaseResult', 'metrics.turns.scope', 'tree'],
    ['parseCaseResult', 'artifacts.grading', ''],
    ['parseCaseResult', 'artifacts.events', 3],
    ['parseCaseResult', 'failure.occurredAt', 3],
    ['parseCaseResult', 'failure.error', 'boom'],
    ['parseCaseResult', 'failure.error.context.phase', 'run'],
    ['parseCaseResult', 'checkState.restore.restored', 'a.ts'],
    ['parseCaseResult', 'setup.commands.0.outcome', 'ok'],
    ['parseCaseResult', 'context.environment.0.classification', 'public'],
    ['parseChecksArtifact', 'schemaVersion', 2],
    ['parseChecksArtifact', 'checks.0.checkId', ''],
    ['parseChecksArtifact', 'checks.0.durationMs', 'fast'],
    ['parseGradingArtifact', 'grader', 'model'],
    ['parseGradingArtifact', 'grader.model', 'no-slash'],
    ['parseGradingArtifact', 'grader.effort', ''],
    ['parseGradingArtifact', 'call', null],
    ['parseGradingArtifact', 'call.status', 'maybe'],
    ['parseGradingArtifact', 'calls.0.outcome.cause', 'crash'],
    ['parseGradingArtifact', 'calls.0.events', {}],
    ['parseGradingArtifact', 'calls.0.session', 'export'],
    ['parseGradingArtifact', 'calls.1.session', []],
    ['parseGradingArtifact', 'metrics.cost', null],
    ['parseGradingArtifact', 'metrics.inputTokens.availability.source', 5],
    ['parseGradingArtifact', 'grades.0.verdict', 'maybe'],
    ['parseGradingArtifact', 'grades.1.reason', 5],
    ['parseGradingArtifact', 'grades.0.checkId', ''],
    ['parseAssessmentArtifact', 'revision', 0],
    ['parseAssessmentArtifact', 'revision', 2.5],
    ['parseAssessmentArtifact', 'current.0.checkId', ''],
    ['parseAssessmentArtifact', 'current.0.verdict', 'undetermined'],
    ['parseAssessmentArtifact', 'history.0.replacedAt', ''],
    ['parseAssessmentArtifact', 'history.0.source', 'robot'],
    ['parseAssessmentArtifact', 'history.1.grader', null],
    ['parseAssessmentArtifact', 'history.1.verdict', 'maybe'],
    ['parseConclusionsArtifact', 'tasks', {}],
    ['parseConclusionsArtifact', 'tasks.0.taskId', ''],
    ['parseConclusionsArtifact', 'tasks.0.table', 'row'],
    ['parseConclusionsArtifact', 'tasks.0.conclusions.cost', 5],
    ['parseConclusionsArtifact', 'tasks.0.call', 'none'],
    ['parseConclusionsArtifact', 'tasks.0.call.outcome.status', 'declined'],
    ['parseConclusionsArtifact', 'tasks.0.facts.repeat', -1],
    ['parseConclusionsArtifact', 'tasks.0.facts.settings.0.planned', 1.5],
    ['parseConclusionsArtifact', 'tasks.0.facts.settings.0.outcomes.failed', '0'],
    ['parseConclusionsArtifact', 'tasks.0.facts.settings.0.cost.reportedAttempts', -1],
    ['parseConclusionsArtifact', 'tasks.0.facts.settings.0.dropout.failedToRunLabels', 'launch'],
    ['parseConclusionsArtifact', 'tasks.0.facts.separation', 'both'],
    ['parseConclusionsArtifact', 'tasks.0.facts.cost.kind', 'winner'],
    ['parseConclusionsArtifact', 'tasks.0.facts.cost.next.margin.kind', 'ratio'],
    ['parseConclusionsArtifact', 'tasks.0.facts.cost.partial.0.reportedAttempts', 'one'],
    ['parseConclusionsArtifact', 'tasks.1.facts.speed.unknown', 'beta'],
  ];

  it.each(TABLE)('%s names %s', (parserName, path, replacement) => {
    const parser = PARSERS.find((entry) => entry.name === parserName) as Parser;

    const parsed = parser.parse(withReplacement(parser, path, replacement));

    expect(parsed).toEqual({ ok: false, defectPath: path });
  });

  it.each(PARSERS)('$name names a missing top-level field', (parser) => {
    const value = clone(parser.build());
    const firstKey = Object.keys(value as JsonObject)[0] as string;
    deleteAt(value, firstKey);

    expect(parser.parse(value)).toEqual({ ok: false, defectPath: firstKey });
  });

  it('names a missing metrics record inside a held case', () => {
    const value = clone(buildRunResult());
    delete (value.cases[0] as Partial<CaseResult>).metrics;

    expect(parseRunResult(value, RUN_ID)).toEqual({ ok: false, defectPath: 'cases.0.metrics' });
  });

  it.each([null, 5, 'text', []])('rejects the non-object root %j at the root', (root) => {
    for (const parser of PARSERS) {
      expect(parser.parse(root), parser.name).toEqual({ ok: false, defectPath: '(root)' });
    }
  });

  it('rejects an unsafe integer where a safe one is required', () => {
    const value = withReplacement(PARSERS[2] as Parser, 'identity.attempt', 2 ** 53);

    expect(parseCaseResult(value, CASE_ID)).toEqual({ ok: false, defectPath: 'identity.attempt' });
  });
});

describe('an unknown key at any object level', () => {
  it.each(PARSERS)('$name names the key it does not write', (parser) => {
    const paths = strictObjectPaths(parser, parser.build());
    expect(paths.length).toBeGreaterThan(0);

    for (const path of paths) {
      const value = clone(parser.build());
      const target = path === '' ? value : readAt(value, path);
      (target as JsonObject)['unexpected'] = 1;

      expect(parser.parse(value), `object at "${path}"`).toEqual({
        ok: false,
        defectPath: childPath(path, 'unexpected'),
      });
    }
  });

  it('keeps unknown keys inside the opaque parts of a stored artifact', () => {
    const manifest = buildManifest();
    (manifest.context as { config: JsonObject }).config['unexpected'] = 1;
    const grading = buildGrading();
    (grading.calls[0] as { session: JsonObject }).session['unexpected'] = 1;
    (grading.calls[0] as { events: unknown[] }).events.push({ unexpected: 1 });

    expect(parseRunManifest(manifest, RUN_ID).ok).toBe(true);
    expect(parseGradingArtifact(grading, RUN_ID, CASE_ID).ok).toBe(true);
  });
});

describe('identity rules', () => {
  it('refuses a manifest of another run at runId', () => {
    expect(parseRunManifest(buildManifest(), 'other-run')).toEqual({
      ok: false,
      defectPath: 'runId',
    });
  });

  it('refuses a run result whose manifest names another run at manifest.runId', () => {
    expect(parseRunResult(buildRunResult(), 'other-run')).toEqual({
      ok: false,
      defectPath: 'manifest.runId',
    });
  });

  it('refuses a case result of another case at identity.caseId', () => {
    expect(parseCaseResult(buildCaseResult(), 'task-1--beta--1')).toEqual({
      ok: false,
      defectPath: 'identity.caseId',
    });
  });

  it('refuses a conclusions artifact of another run at runId', () => {
    expect(parseConclusionsArtifact(buildConclusions(), 'other-run')).toEqual({
      ok: false,
      defectPath: 'runId',
    });
  });

  it.each([
    ['parseChecksArtifact', parseChecksArtifact, buildChecks],
    ['parseGradingArtifact', parseGradingArtifact, buildGrading],
    ['parseAssessmentArtifact', parseAssessmentArtifact, buildAssessment],
  ] as const)('%s checks the run ID, then the case ID', (_name, parse, build) => {
    expect(parse(build(), 'other-run', CASE_ID)).toEqual({ ok: false, defectPath: 'runId' });
    expect(parse(build(), RUN_ID, 'task-1--beta--1')).toEqual({ ok: false, defectPath: 'caseId' });
    expect(parse(build(), 'other-run', 'task-1--beta--1')).toEqual({
      ok: false,
      defectPath: 'runId',
    });
  });

  it('reports a shape defect before an identity mismatch', () => {
    const value = withReplacement(PARSERS[2] as Parser, 'identity.attempt', 0);

    expect(parseCaseResult(value, 'task-1--beta--1')).toEqual({
      ok: false,
      defectPath: 'identity.attempt',
    });
  });
});

describe('manifest cross-field rules', () => {
  it('names the case whose agent has no copied-providers entry', () => {
    const manifest = buildManifest();
    manifest.cases.push({ ...(manifest.cases[0] as RunManifest['cases'][number]), agent: 'ghost' });

    expect(parseRunManifest(manifest, RUN_ID)).toEqual({ ok: false, defectPath: 'cases.1.agent' });
  });

  it('names the case whose model entry has no effort check', () => {
    const manifest = buildManifest();
    manifest.cases.push({
      ...(manifest.cases[0] as RunManifest['cases'][number]),
      modelId: 'ghost',
    });

    expect(parseRunManifest(manifest, RUN_ID)).toEqual({
      ok: false,
      defectPath: 'cases.1.modelId',
    });
  });

  it('refuses a grader check that the snapshot does not declare', () => {
    const manifest = buildManifest();
    (manifest.context as { config: unknown }).config = { roles: {} };

    expect(parseRunManifest(manifest, RUN_ID)).toEqual({ ok: false, defectPath: 'efforts.grader' });
  });

  it('refuses a missing grader check when the snapshot declares a grader', () => {
    const manifest = buildManifest();
    manifest.efforts.grader = null;

    expect(parseRunManifest(manifest, RUN_ID)).toEqual({ ok: false, defectPath: 'efforts.grader' });
  });

  it('checks the agent, then the model entry, then the grader', () => {
    const manifest = buildManifest();
    manifest.cases.push({
      ...(manifest.cases[0] as RunManifest['cases'][number]),
      agent: 'ghost',
      modelId: 'ghost',
    });
    manifest.efforts.grader = null;

    expect(parseRunManifest(manifest, RUN_ID)).toEqual({ ok: false, defectPath: 'cases.1.agent' });
  });

  it('treats an inherited property name as absent', () => {
    const manifest = buildManifest();
    manifest.cases.push({
      ...(manifest.cases[0] as RunManifest['cases'][number]),
      agent: 'toString',
    });

    expect(parseRunManifest(manifest, RUN_ID)).toEqual({ ok: false, defectPath: 'cases.1.agent' });
  });

  it('reports them under manifest. for a run result', () => {
    const run = buildRunResult();
    run.manifest.efforts.grader = null;

    expect(parseRunResult(run, RUN_ID)).toEqual({
      ok: false,
      defectPath: 'manifest.efforts.grader',
    });
  });

  it('does not evaluate them when the manifest shape failed', () => {
    const manifest = buildManifest();
    manifest.efforts.grader = null;
    (manifest as { configPath: unknown }).configPath = 7;

    expect(parseRunManifest(manifest, RUN_ID)).toEqual({ ok: false, defectPath: 'configPath' });
  });
});

describe('ordering and secrets', () => {
  it('reports the first of two defects in schema key order', () => {
    const value = clone(buildCaseResult()) as unknown as JsonObject;
    (value['artifacts'] as JsonObject)['grading'] = '';
    (value['identity'] as JsonObject)['attempt'] = 0;

    expect(parseCaseResult(value, CASE_ID)).toEqual({ ok: false, defectPath: 'identity.attempt' });
  });

  it('keeps a value out of the defect path when a field holds another type', () => {
    const value = withReplacement(PARSERS[2] as Parser, 'identity.attempt', SECRET);

    const parsed = parseCaseResult(value, CASE_ID);

    expect(parsed).toEqual({ ok: false, defectPath: 'identity.attempt' });
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it('keeps the string out of the defect path at every nested boundary', () => {
    for (const parser of PARSERS) {
      for (const path of strictObjectPaths(parser, parser.build())) {
        const value = clone(parser.build());
        const target = path === '' ? value : readAt(value, path);
        const key = Object.keys(target as JsonObject)[0];
        if (key === undefined) {
          continue;
        }
        const original = (target as JsonObject)[key];
        if (typeof original === 'object') {
          (target as JsonObject)[key] = SECRET;
          const parsed = parser.parse(value);
          expect(JSON.stringify(parsed), `${parser.name} ${path}.${key}`).not.toContain(SECRET);
        }
      }
    }
  });

  it('names an unknown key that holds the string and nothing it carries', () => {
    const value = clone(buildCaseResult()) as unknown as JsonObject;
    value[SECRET] = SECRET.toUpperCase();

    const parsed = parseCaseResult(value, CASE_ID);

    expect(parsed).toEqual({ ok: false, defectPath: SECRET });
    expect(JSON.stringify(parsed)).not.toContain(SECRET.toUpperCase());
  });

  it('names an unknown key nested in a record entry', () => {
    const manifest = clone(buildManifest());
    (manifest.tools.copiedProviders['opencode']?.[0] as unknown as JsonObject)[SECRET] = 1;

    expect(parseRunManifest(manifest, RUN_ID)).toEqual({
      ok: false,
      defectPath: `tools.copiedProviders.opencode.0.${SECRET}`,
    });
  });
});
