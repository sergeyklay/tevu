// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildCaseIdentity,
  buildCaseResult,
  buildCheckRecord,
  buildCheckResult,
  buildFailure,
  buildGradedGrade,
  buildGradingArtifact,
  buildModelRecord,
  buildMultiCallGradingArtifact,
  buildPendingGrade,
  buildTaskRecord,
  FIXTURE_RUN_ID,
} from './__fixtures__/report.fixtures';
import {
  buildReaderNames,
  countRequiredChecks,
  describeAttempt,
  effortStatement,
  failureLabel,
  formatCount,
  formatRequiredChecks,
  gradeLines,
  gradingGapStatement,
  measurementGapStatement,
  renderStatement,
} from './wording';

import type { AttemptFacts } from './wording';
import type { CheckRecord, CheckResult, GradingArtifact, TevuError } from '@/domain/types';

type NoReplyCause = Extract<GradingArtifact['call'], { status: 'no-reply' }>['cause'];

const NO_REPLY_CASES: Array<{
  cause: NoReplyCause;
  base: string;
  opening: string;
}> = [
  {
    cause: 'unfinished',
    base: 'the grading model stopped before finishing its reply',
    opening: 'The grading model stopped before finishing its reply',
  },
  {
    cause: 'tool-call',
    base: 'the grading model asked to use a tool, which grading does not allow',
    opening: 'The grading model asked to use a tool, which grading does not allow',
  },
  {
    cause: 'other',
    base: 'the grading model returned no verdict for this solution',
    opening: 'The grading model returned no verdict for this solution',
  },
];

const CASE_ID = 'task-1--m1--1';

function buildNames(
  overrides: Partial<Parameters<typeof buildReaderNames>[0]> = {},
): ReturnType<typeof buildReaderNames> {
  return buildReaderNames({
    tasks: [buildTaskRecord()],
    models: [buildModelRecord()],
    repeat: 1,
    cases: [{ modelId: 'm1', agent: 'opencode' }],
    ...overrides,
  });
}

describe('buildReaderNames', () => {
  describe('task names', () => {
    it('collapses each whitespace run to one space and trims the title', () => {
      const names = buildNames({
        tasks: [buildTaskRecord({ title: '  Fix\tthe  login\n redirect  ' })],
      });

      expect(names.task('task-1')).toBe('Fix the login redirect');
    });

    it('appends the 1-based position to every task that shares a name after collapsing', () => {
      const names = buildNames({
        tasks: [
          buildTaskRecord({ id: 't1', title: 'Fix  it' }),
          buildTaskRecord({ id: 't2', title: 'Other' }),
          buildTaskRecord({ id: 't3', title: 'Fix it' }),
        ],
      });

      expect([names.task('t1'), names.task('t2'), names.task('t3')]).toEqual([
        'Fix it (1)',
        'Other',
        'Fix it (2)',
      ]);
    });

    it('returns an ID that no record names as itself', () => {
      const names = buildNames();

      expect(names.task('unknown-task')).toBe('unknown-task');
    });
  });

  describe('check names', () => {
    it('collapses and trims the description', () => {
      const names = buildNames({
        tasks: [
          buildTaskRecord({
            checks: [buildCheckRecord({ id: 'c1', description: '  The  page\nredirects ' })],
          }),
        ],
      });

      expect(names.check('task-1', 'c1')).toBe('The page redirects');
    });

    it('numbers an empty description by its position in its own category', () => {
      const names = buildNames({
        tasks: [
          buildTaskRecord({
            checks: [
              buildCheckRecord({ id: 'a1', description: 'Named' }),
              buildCheckRecord({ id: 'a2', description: ' \n ' }),
              buildCheckRecord({ id: 'd1', category: 'definition-of-done', description: '' }),
              buildCheckRecord({ id: 'd2', category: 'definition-of-done', description: '  ' }),
            ],
          }),
        ],
      });

      expect(['a2', 'd1', 'd2'].map((id) => names.check('task-1', id))).toEqual([
        'Acceptance check 2',
        'Definition of Done check 1',
        'Definition of Done check 2',
      ]);
    });

    it('suffixes duplicate names within one task but not across tasks', () => {
      const duplicated = [
        buildCheckRecord({ id: 'c1', description: 'Works' }),
        buildCheckRecord({ id: 'c2', description: 'Works' }),
      ];
      const names = buildNames({
        tasks: [
          buildTaskRecord({ id: 't1', title: 'One', checks: duplicated }),
          buildTaskRecord({
            id: 't2',
            title: 'Two',
            checks: [buildCheckRecord({ id: 'c1', description: 'Works' })],
          }),
        ],
      });

      expect([names.check('t1', 'c1'), names.check('t1', 'c2'), names.check('t2', 'c1')]).toEqual([
        'Works (1)',
        'Works (2)',
        'Works',
      ]);
    });

    it('returns a check ID that no record names as itself', () => {
      const names = buildNames();

      expect(names.check('task-1', 'missing-check')).toBe('missing-check');
    });
  });

  describe('setting, attempt, and case names', () => {
    it('names a setting by its model and effort and omits the attempt at repeat 1', () => {
      const names = buildNames();
      const identity = { taskId: 'task-1', modelId: 'm1', attempt: 1 };

      expect([
        names.setting('m1'),
        names.settingModel('m1'),
        names.attempt(identity),
        names.caseName(identity),
      ]).toEqual([
        'vendor/model-a, high',
        'vendor/model-a',
        'vendor/model-a, high',
        'vendor/model-a, high on "Fix the login redirect"',
      ]);
    });

    it('appends the attempt number above repeat 1', () => {
      const names = buildNames({ repeat: 2 });
      const identity = { taskId: 'task-1', modelId: 'm1', attempt: 2 };

      expect([names.attempt(identity), names.caseName(identity)]).toEqual([
        'vendor/model-a, high, attempt 2',
        'vendor/model-a, high, attempt 2 on "Fix the login redirect"',
      ]);
    });

    it('returns a model ID that no record names as itself', () => {
      const names = buildNames();

      expect(names.setting('unknown-model')).toBe('unknown-model');
    });

    it('adds no agent part to entries that differ in model or effort', () => {
      const names = buildNames({
        models: [
          buildModelRecord({ id: 'm1', effort: 'high' }),
          buildModelRecord({ id: 'm2', effort: 'low' }),
          buildModelRecord({ id: 'm3', model: 'vendor/model-b', effort: 'high' }),
        ],
        cases: [
          { modelId: 'm1', agent: 'a' },
          { modelId: 'm2', agent: 'b' },
          { modelId: 'm3', agent: 'c' },
        ],
      });

      expect(['m1', 'm2', 'm3'].map((id) => names.setting(id))).toEqual([
        'vendor/model-a, high',
        'vendor/model-a, low',
        'vendor/model-b, high',
      ]);
    });

    describe('entries that share model and effort', () => {
      const models = [buildModelRecord({ id: 'm1' }), buildModelRecord({ id: 'm2' })];

      it('tells them apart by agent in setting and setting model', () => {
        const names = buildNames({
          models,
          cases: [
            { modelId: 'm1', agent: 'a' },
            { modelId: 'm2', agent: 'b' },
          ],
        });

        expect([
          names.setting('m1'),
          names.setting('m2'),
          names.settingModel('m1'),
          names.settingModel('m2'),
        ]).toEqual([
          'vendor/model-a, high, a',
          'vendor/model-a, high, b',
          'vendor/model-a, a',
          'vendor/model-a, b',
        ]);
      });

      it('carries the agent into attempt and case names', () => {
        const names = buildNames({
          models,
          repeat: 2,
          cases: [
            { modelId: 'm1', agent: 'a' },
            { modelId: 'm2', agent: 'b' },
          ],
        });
        const identity = { taskId: 'task-1', modelId: 'm2', attempt: 2 };

        expect([names.attempt(identity), names.caseName(identity)]).toEqual([
          'vendor/model-a, high, b, attempt 2',
          'vendor/model-a, high, b, attempt 2 on "Fix the login redirect"',
        ]);
      });

      it('falls back to the position suffix when the agent is shared too', () => {
        const names = buildNames({
          models,
          cases: [
            { modelId: 'm1', agent: 'a' },
            { modelId: 'm2', agent: 'a' },
          ],
        });

        expect([
          names.setting('m1'),
          names.setting('m2'),
          names.settingModel('m1'),
          names.settingModel('m2'),
        ]).toEqual([
          'vendor/model-a, high, a (1)',
          'vendor/model-a, high, a (2)',
          'vendor/model-a, a (1)',
          'vendor/model-a, a (2)',
        ]);
      });

      it('gives an entry that no case names no agent part and the position suffix', () => {
        const names = buildNames({ models, cases: [{ modelId: 'm1', agent: 'a' }] });

        expect([names.setting('m1'), names.setting('m2'), names.settingModel('m2')]).toEqual([
          'vendor/model-a, high, a',
          'vendor/model-a, high',
          'vendor/model-a',
        ]);
      });

      it('suffixes two entries that no case names by position', () => {
        const names = buildNames({ models, cases: [] });

        expect([names.setting('m1'), names.setting('m2')]).toEqual([
          'vendor/model-a, high (1)',
          'vendor/model-a, high (2)',
        ]);
      });
    });
  });
});

describe('renderStatement', () => {
  const statement = { happened: 'It broke.', means: 'It counts.', next: 'Retry.' };

  it('joins the three parts with single spaces when there is no detail', () => {
    expect(renderStatement({ ...statement, detail: null })).toBe('It broke. It counts. Retry.');
  });

  it('appends the detail after the technical detail marker', () => {
    expect(renderStatement({ ...statement, detail: 'case c1: boom' })).toBe(
      'It broke. It counts. Retry. Technical detail: case c1: boom',
    );
  });

  it('turns every newline in any part into a space', () => {
    const rendered = renderStatement({ ...statement, happened: 'It\nbroke.', detail: 'a\r\nb\nc' });

    expect(rendered).toBe('It broke. It counts. Retry. Technical detail: a b c');
  });
});

describe('countRequiredChecks and formatRequiredChecks', () => {
  const requiredChecks = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => buildCheckRecord({ id }));

  function attemptWith(verdicts: readonly CheckResult['verdict'][]): {
    result: ReturnType<typeof buildCaseResult>;
  } {
    return {
      result: buildCaseResult({
        checks: verdicts.map((verdict, index) =>
          buildCheckResult({ checkId: `c${index + 1}`, verdict }),
        ),
      }),
    };
  }

  it.each([
    {
      label: 'one passed and five pending',
      attempts: [attemptWith(['passed', 'pending', 'pending', 'pending', 'pending', 'pending'])],
      expected: '1/6 passed, 5 pending',
    },
    {
      label: 'four passed, one failed, one pending',
      attempts: [attemptWith(['passed', 'passed', 'passed', 'passed', 'failed', 'pending'])],
      expected: '4/6 passed, 1 failed, 1 pending',
    },
    {
      label: 'an attempt without a case result',
      attempts: [{ result: undefined }],
      expected: '0/6 passed, 6 not run',
    },
    {
      label: 'three attempts with one failure',
      attempts: [
        attemptWith(['passed', 'passed', 'passed', 'passed', 'passed', 'passed']),
        attemptWith(['passed', 'passed', 'passed', 'passed', 'passed', 'passed']),
        attemptWith(['passed', 'passed', 'passed', 'passed', 'passed', 'failed']),
      ],
      expected: '17/18 passed, 1 failed',
    },
  ])('reads $expected for $label', ({ attempts, expected }) => {
    const counts = countRequiredChecks(attempts, requiredChecks);

    expect(formatRequiredChecks(counts)).toBe(expected);
  });

  it('counts a missing check result and the verdict not-run as not run', () => {
    const attempts = [attemptWith(['passed', 'not-run'])];

    const counts = countRequiredChecks(attempts, requiredChecks.slice(0, 3));

    expect(counts).toEqual({ passed: 1, failed: 0, pending: 0, notRun: 2, total: 3 });
  });

  it('ignores optional checks', () => {
    const checks = [
      buildCheckRecord({ id: 'c1' }),
      buildCheckRecord({ id: 'c2', required: false }),
    ];
    const attempts = [attemptWith(['passed', 'failed'])];

    const counts = countRequiredChecks(attempts, checks);

    expect(counts).toEqual({ passed: 1, failed: 0, pending: 0, notRun: 0, total: 1 });
  });

  it('reads 0/0 passed for a task without required checks', () => {
    const counts = countRequiredChecks(
      [attemptWith(['passed'])],
      [buildCheckRecord({ id: 'c1', required: false })],
    );

    expect(formatRequiredChecks(counts)).toBe('0/0 passed');
  });

  it('groups digits of every number through formatCount', () => {
    const counts = { passed: 1_000, failed: 2_000, pending: 3_000, notRun: 4_000, total: 10_000 };

    expect(formatRequiredChecks(counts)).toBe(
      '1,000/10,000 passed, 2,000 failed, 3,000 pending, 4,000 not run',
    );
  });

  it.each([
    { label: 'all passed', verdicts: Array(6).fill('passed') },
    { label: 'mixed', verdicts: ['passed', 'failed', 'pending', 'not-run', 'passed'] },
    { label: 'none recorded', verdicts: [] },
  ] as const)(
    'classifies every pair of attempt and required check exactly once ($label)',
    ({ verdicts }) => {
      const attempts = [attemptWith(verdicts), attemptWith(['failed']), { result: undefined }];

      const counts = countRequiredChecks(attempts, requiredChecks);

      expect(counts.passed + counts.failed + counts.pending + counts.notRun).toBe(
        requiredChecks.length * attempts.length,
      );
      expect(counts.total).toBe(requiredChecks.length * attempts.length);
    },
  );

  it('formats counts below one thousand without grouping', () => {
    expect(formatCount(999)).toBe('999');
  });
});

describe('failureLabel', () => {
  it.each([
    { kind: 'CaseTimeoutError', label: 'time limit reached' },
    { kind: 'CancellationError', label: 'cancelled' },
    { kind: 'AgentProcessError', label: 'agent process failed' },
    { kind: 'AgentSessionError', label: 'agent reported an error' },
    { kind: 'AgentProtocolError', label: 'agent records unreadable' },
    { kind: 'SetupError', label: 'setup command failed' },
    { kind: 'CheckStateError', label: 'check files not prepared' },
    { kind: 'ArtifactError', label: 'files not saved' },
    { kind: 'IsolationError', label: 'workspace not prepared' },
    { kind: 'SourceMaterializationError', label: 'workspace not prepared' },
    { kind: 'EvaluationError', label: 'tevu error' },
    { kind: 'SomethingNew', label: 'tevu error' },
  ])('maps $kind to "$label"', ({ kind, label }) => {
    expect(failureLabel(kind)).toBe(label);
  });
});

function buildFacts(overrides: Partial<AttemptFacts> = {}): AttemptFacts {
  return {
    identity: buildCaseIdentity(),
    result: buildCaseResult(),
    checks: [],
    grading: undefined,
    checkName: (checkId) => checkId,
    ...overrides,
  };
}

const COMPLETED_MEANS = 'Its solution was still checked, so the outcome comes from its checks.';
const NOT_COMPLETED_MEANS =
  'The attempt did not complete its checks, so it counts as not evaluated.';
const AGAIN = 'Run the comparison again to get a result for this attempt.';

describe('describeAttempt', () => {
  describe('an attempt without a case result', () => {
    it('shares one no-result statement between stop and failure', () => {
      const facts = buildFacts({ result: undefined });

      const statements = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(statements).toEqual({
        stop: {
          happened: 'tevu saved no result for this attempt.',
          means: 'It has no outcome or measurements, so it counts as not evaluated.',
          next: AGAIN,
          detail: `case ${CASE_ID}: no case result was saved`,
        },
        failure: expect.objectContaining({ detail: `case ${CASE_ID}: no case result was saved` }),
        pending: null,
      });
      expect(statements.failure).toBe(statements.stop);
    });
  });

  describe('a cancelled attempt', () => {
    it('stops with the cancellation row and failure equal to stop for a CancellationError', () => {
      const facts = buildFacts({
        result: buildCaseResult({
          lifecycle: 'cancelled',
          failure: buildFailure({ kind: 'CancellationError', activeCaseIds: [CASE_ID] }),
        }),
      });

      const statements = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(statements.stop).toEqual({
        happened: 'The run was cancelled before this attempt finished.',
        means: NOT_COMPLETED_MEANS,
        next: AGAIN,
        detail: `case ${CASE_ID}, lifecycle cancelled: CancellationError`,
      });
      expect(statements.failure).toEqual(statements.stop);
      expect(statements.pending).toBeNull();
    });

    it('has no failure and no error text in the detail when no error was recorded', () => {
      const facts = buildFacts({ result: buildCaseResult({ lifecycle: 'cancelled' }) });

      const statements = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(statements.stop?.detail).toBe(`case ${CASE_ID}, lifecycle cancelled`);
      expect(statements.failure).toBeNull();
    });

    it('keeps the cancellation stop and adds the row of another recorded error as failure', () => {
      const facts = buildFacts({
        result: buildCaseResult({
          lifecycle: 'cancelled',
          failure: buildFailure({
            kind: 'AgentProcessError',
            agent: 'opencode',
            caseId: CASE_ID,
            exitCode: 1,
            signal: null,
          }),
        }),
      });

      const statements = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(statements.stop?.happened).toBe('The run was cancelled before this attempt finished.');
      expect(statements.failure).toEqual({
        happened: 'The agent process stopped with an error.',
        means: NOT_COMPLETED_MEANS,
        next: "Read the attempt's diagnostics log to find out why.",
        detail: `case ${CASE_ID}, lifecycle cancelled: AgentProcessError, exit code 1, signal none`,
      });
    });
  });

  describe('an attempt that ended before completing', () => {
    it('uses the tevu error row for stop when no error was recorded, and records no failure', () => {
      const facts = buildFacts({ result: buildCaseResult({ lifecycle: 'infrastructure-failed' }) });

      const statements = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(statements).toEqual({
        stop: {
          happened: 'tevu stopped this attempt because of an error of its own.',
          means: NOT_COMPLETED_MEANS,
          next: 'Run the comparison again; if the error repeats, report it with the technical detail.',
          detail: `case ${CASE_ID}, lifecycle infrastructure-failed`,
        },
        failure: null,
        pending: null,
      });
    });

    it('shares stop and failure and names the lifecycle before the error detail', () => {
      const facts = buildFacts({
        result: buildCaseResult({
          lifecycle: 'timed-out',
          failure: buildFailure({ kind: 'CaseTimeoutError', caseId: CASE_ID, timeoutMs: 90_000 }),
        }),
      });

      const statements = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(statements.stop).toEqual({
        happened: 'The model did not finish within its time limit of 1.5 min.',
        means: NOT_COMPLETED_MEANS,
        next: "To give it more time, raise the task's time limit (`timeout`, or `run.timeout`) and run the comparison again.",
        detail: `case ${CASE_ID}, lifecycle timed-out: CaseTimeoutError, limit 90000 ms`,
      });
      expect(statements.failure).toBe(statements.stop);
    });

    it('says the checks did not run when the workspace could not be read', () => {
      const facts = buildFacts({
        result: buildCaseResult({
          lifecycle: 'process-failed',
          failure: buildFailure({
            kind: 'AgentProcessError',
            agent: 'opencode',
            caseId: CASE_ID,
            exitCode: null,
            signal: 'SIGKILL',
          }),
        }),
      });

      const statements = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(statements.stop?.means).toBe(
        'tevu could not read its workspace afterwards, so its checks did not run and the attempt counts as not evaluated.',
      );
      expect(statements.stop?.detail).toBe(
        `case ${CASE_ID}, lifecycle process-failed: AgentProcessError, exit code none, signal SIGKILL`,
      );
    });
  });

  describe('a completed attempt with a runtime failure', () => {
    const rows: {
      label: string;
      error: TevuError;
      happened: string;
      next: string;
      detail: string;
    }[] = [
      {
        label: 'CaseTimeoutError',
        error: { kind: 'CaseTimeoutError', caseId: CASE_ID, timeoutMs: 30_000 },
        happened: 'The model did not finish within its time limit of 30.0 s.',
        next: "To give it more time, raise the task's time limit (`timeout`, or `run.timeout`) and run the comparison again.",
        detail: 'CaseTimeoutError, limit 30000 ms',
      },
      {
        label: 'CancellationError',
        error: { kind: 'CancellationError', activeCaseIds: [] },
        happened: 'The run was cancelled before this attempt finished.',
        next: AGAIN,
        detail: 'CancellationError',
      },
      {
        label: 'AgentProcessError with an exit code',
        error: {
          kind: 'AgentProcessError',
          agent: 'opencode',
          caseId: CASE_ID,
          exitCode: 2,
          signal: null,
        },
        happened: 'The agent process stopped with an error.',
        next: "Read the attempt's diagnostics log to find out why.",
        detail: 'AgentProcessError, exit code 2, signal none',
      },
      {
        label: 'AgentSessionError with a message',
        error: {
          kind: 'AgentSessionError',
          agent: 'opencode',
          caseId: CASE_ID,
          agentMessage: 'rate limited',
        },
        happened: 'The agent reported an error during its session.',
        next: "Read the agent's message in the technical detail and the attempt's event log.",
        detail: 'AgentSessionError: rate limited',
      },
      {
        label: 'AgentSessionError without a message',
        error: { kind: 'AgentSessionError', agent: 'opencode', caseId: CASE_ID },
        happened: 'The agent reported an error during its session.',
        next: "Read the attempt's event log to find out why.",
        detail: 'AgentSessionError',
      },
      {
        label: 'AgentProtocolError',
        error: {
          kind: 'AgentProtocolError',
          agent: 'opencode',
          context: { phase: 'case', caseId: CASE_ID },
          reason: 'line 3 is not JSON',
        },
        happened: 'tevu could not read the records the agent wrote.',
        next: "Find the record the technical detail names in the attempt's event log or session export.",
        detail: 'AgentProtocolError: line 3 is not JSON',
      },
      {
        label: 'SetupError before the agent',
        error: {
          kind: 'SetupError',
          phase: 'before_agent',
          argv: ['npm', 'ci'],
          reason: 'exit code 1',
        },
        happened: 'A repository setup command failed before the agent started.',
        next: "Fix the command, using its setup log among the attempt's artifacts, and run the comparison again.",
        detail: 'SetupError, phase before_agent, command ["npm","ci"]: exit code 1',
      },
      {
        label: 'SetupError before the checks',
        error: { kind: 'SetupError', phase: 'before_checks', argv: ['make'], reason: 'timed out' },
        happened: 'A repository setup command failed before the checks ran.',
        next: "Fix the command, using its setup log among the attempt's artifacts, and run the comparison again.",
        detail: 'SetupError, phase before_checks, command ["make"]: timed out',
      },
      {
        label: 'CheckStateError during restore',
        error: { kind: 'CheckStateError', step: 'restore', reason: 'read-only directory' },
        happened: 'tevu could not restore the check files after the agent finished.',
        next: 'Fix the cause the technical detail names, such as a read-only directory the agent left, and run the comparison again.',
        detail: 'CheckStateError, step restore: read-only directory',
      },
      {
        label: 'CheckStateError during overlay',
        error: { kind: 'CheckStateError', step: 'overlay', reason: 'file exists' },
        happened: 'tevu could not overlay the check files after the agent finished.',
        next: 'Fix the cause the technical detail names, such as a read-only directory the agent left, and run the comparison again.',
        detail: 'CheckStateError, step overlay: file exists',
      },
      {
        label: 'ArtifactError',
        error: { kind: 'ArtifactError', operation: 'write-case-result', reason: 'disk full' },
        happened: "tevu could not save this attempt's files.",
        next: 'Check free space and permissions of the output directory, then run the comparison again.',
        detail: 'ArtifactError, operation write-case-result: disk full',
      },
      {
        label: 'IsolationError',
        error: { kind: 'IsolationError', caseId: CASE_ID, reason: 'home leak' },
        happened: 'tevu could not prepare the workspace for this attempt.',
        next: 'Run `tevu validate`, fix what it reports, and run the comparison again.',
        detail: 'IsolationError: home leak',
      },
      {
        label: 'SourceMaterializationError',
        error: { kind: 'SourceMaterializationError', taskId: 'task-1', reason: 'bad commit' },
        happened: 'tevu could not prepare the workspace for this attempt.',
        next: 'Run `tevu validate`, fix what it reports, and run the comparison again.',
        detail: 'SourceMaterializationError: bad commit',
      },
      {
        label: 'an error kind with a reason that has no row of its own',
        error: { kind: 'ReferenceResolutionError', reason: 'no such ref' },
        happened: 'tevu stopped this attempt because of an error of its own.',
        next: 'Run the comparison again; if the error repeats, report it with the technical detail.',
        detail: 'ReferenceResolutionError: no such ref',
      },
      {
        label: 'an error kind without a reason that has no row of its own',
        error: { kind: 'PrerequisiteError', tool: 'git', expected: '>=2.40' },
        happened: 'tevu stopped this attempt because of an error of its own.',
        next: 'Run the comparison again; if the error repeats, report it with the technical detail.',
        detail: 'PrerequisiteError',
      },
    ];

    it.each(rows)('states $label as a failure of a completed attempt', (row) => {
      const facts = buildFacts({ result: buildCaseResult({ failure: buildFailure(row.error) }) });

      const statements = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(statements.stop).toBeNull();
      expect(statements.failure).toEqual({
        happened: row.happened,
        means: COMPLETED_MEANS,
        next: row.next,
        detail: `case ${CASE_ID}: ${row.detail}`,
      });
    });

    it('has no statement at all when the attempt completed cleanly with no pending check', () => {
      const facts = buildFacts();

      const statements = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(statements).toEqual({ stop: null, failure: null, pending: null });
    });
  });

  describe('pending statement', () => {
    const manualCheck = (id: string, required = true): CheckRecord =>
      buildCheckRecord({ id, evaluator: 'manual', required });
    const gradedCheck = (id: string, required = true): CheckRecord =>
      buildCheckRecord({ id, evaluator: 'grader', required });

    function pendingFacts(options: {
      checks: CheckRecord[];
      grading?: GradingArtifact;
      outcome?: 'pending' | 'failed' | 'passed';
      lifecycle?: 'completed' | 'timed-out';
    }): AttemptFacts {
      return buildFacts({
        checks: options.checks,
        grading: options.grading,
        result: buildCaseResult({
          lifecycle: options.lifecycle ?? 'completed',
          outcome: options.outcome ?? 'pending',
          checks: options.checks.map((check) =>
            buildCheckResult({ checkId: check.id, verdict: 'pending' }),
          ),
        }),
      });
    }

    const noReply = buildGradingArtifact({
      call: {
        status: 'no-reply',
        cause: 'other',
        reason: 'the grader call failed: ModelCallError (failed)',
      },
    });

    it.each([
      {
        cause: 'manual',
        facts: pendingFacts({ checks: [manualCheck('m1')] }),
        happened: "1 required manual check waits for a person's verdict.",
        detail: `case ${CASE_ID}`,
      },
      {
        cause: 'no reply',
        facts: pendingFacts({ checks: [gradedCheck('g1')], grading: noReply }),
        happened:
          "The grading model returned no verdict for this solution, so 1 required graded check waits for a person's verdict.",
        detail: `case ${CASE_ID}: the grader call failed: ModelCallError (failed)`,
      },
      {
        cause: 'unusable reply',
        facts: pendingFacts({
          checks: [gradedCheck('g1')],
          grading: buildGradingArtifact({
            grades: [buildPendingGrade({ checkId: 'g1', reason: 'reply was not JSON' })],
          }),
        }),
        happened:
          "The grading model's reply had no usable verdict for 1 required graded check, so it waits for a person's verdict.",
        detail: `case ${CASE_ID}: reply was not JSON`,
      },
      {
        cause: 'undetermined',
        facts: pendingFacts({
          checks: [gradedCheck('g1')],
          grading: buildGradingArtifact({
            grades: [buildGradedGrade({ checkId: 'g1', verdict: 'undetermined' })],
          }),
        }),
        happened:
          "The grading model could not decide 1 required graded check from the task text and the solution's changes, so it waits for a person's verdict.",
        detail: `case ${CASE_ID}`,
      },
      {
        cause: 'not graded because no grading was saved',
        facts: pendingFacts({ checks: [gradedCheck('g1')] }),
        happened:
          "tevu has no grading for this solution, so 1 required graded check waits for a person's verdict.",
        detail: `case ${CASE_ID}`,
      },
      {
        cause: 'not graded because the grading has no grade for the check',
        facts: pendingFacts({ checks: [gradedCheck('g1')], grading: buildGradingArtifact() }),
        happened:
          "tevu has no grading for this solution, so 1 required graded check waits for a person's verdict.",
        detail: `case ${CASE_ID}`,
      },
      {
        cause: 'no verdict from a command check',
        facts: pendingFacts({ checks: [buildCheckRecord({ id: 'c1' })] }),
        happened: '1 required check has no verdict.',
        detail: `case ${CASE_ID}`,
      },
    ])('names the $cause cause', ({ facts, happened, detail }) => {
      const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(pending).toEqual({
        happened,
        means: 'The outcome stays pending until every required check has a verdict.',
        next: `Record the verdict with \`tevu assess ${FIXTURE_RUN_ID} ${CASE_ID}\`.`,
        detail,
      });
    });

    it('counts a pending result without a definition as optional with no verdict', () => {
      const facts = buildFacts({
        checks: [],
        result: buildCaseResult({
          checks: [buildCheckResult({ checkId: 'gone', verdict: 'pending' })],
        }),
      });

      const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(pending?.happened).toBe('1 optional check has no verdict.');
    });

    it('splits required from optional and uses the plural for several checks', () => {
      const facts = pendingFacts({
        checks: [manualCheck('m1'), manualCheck('m2'), manualCheck('m3', false)],
      });

      const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(pending?.happened).toBe(
        "2 required and 1 optional manual checks wait for a person's verdict.",
      );
      expect(pending?.next).toBe(
        `Record the verdicts with \`tevu assess ${FIXTURE_RUN_ID} ${CASE_ID}\`.`,
      );
    });

    it('states an optional-only count without a required part', () => {
      const facts = pendingFacts({ checks: [manualCheck('m1', false)], outcome: 'passed' });

      const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(pending?.happened).toBe("1 optional manual check waits for a person's verdict.");
    });

    it('says an optional check does not change a passed outcome', () => {
      const facts = pendingFacts({ checks: [manualCheck('m1', false)], outcome: 'passed' });

      const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(pending?.means).toBe('Optional checks do not change the outcome, which stays passed.');
    });

    it('names the failed required checks by their run names and softens the advice once the outcome is failed', () => {
      const failedChecks = [
        buildCheckRecord({ id: 'c1', description: 'Type checking and the test suite pass.' }),
        buildCheckRecord({ id: 'c2', description: 'Lint passes' }),
        buildCheckRecord({ id: 'c3', description: 'Optional build passes.', required: false }),
      ];
      const facts = buildFacts({
        checks: [...failedChecks, manualCheck('m1'), manualCheck('m2')],
        checkName: (checkId) =>
          checkId === 'c2'
            ? 'Lint passes (2)'
            : (failedChecks.find((check) => check.id === checkId)?.description ?? checkId),
        result: buildCaseResult({
          lifecycle: 'completed',
          outcome: 'failed',
          checks: [
            ...failedChecks.map((check) =>
              buildCheckResult({ checkId: check.id, verdict: 'failed' }),
            ),
            buildCheckResult({ checkId: 'm1', verdict: 'pending' }),
            buildCheckResult({ checkId: 'm2', verdict: 'pending' }),
          ],
        }),
      });

      const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(pending?.means).toBe(
        'The outcome is already failed, whatever these verdicts are. Failed: Type checking and the test suite pass; Lint passes (2).',
      );
      expect(pending?.next).toBe(
        `These verdicts no longer change the outcome; you can still record them for completeness with \`tevu assess ${FIXTURE_RUN_ID} ${CASE_ID}\`.`,
      );
    });

    it('joins the sentences of the causes present in table order', () => {
      const facts = pendingFacts({
        checks: [gradedCheck('g1'), manualCheck('m1'), gradedCheck('g2')],
        grading: buildGradingArtifact({
          grades: [
            buildGradedGrade({ checkId: 'g1', verdict: 'undetermined' }),
            buildPendingGrade({ checkId: 'g2', reason: 'reply was not JSON' }),
          ],
        }),
      });

      const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(pending?.happened).toBe(
        "1 required manual check waits for a person's verdict. " +
          "The grading model's reply had no usable verdict for 1 required graded check, so it waits for a person's verdict. " +
          "The grading model could not decide 1 required graded check from the task text and the solution's changes, so it waits for a person's verdict.",
      );
      expect(pending?.detail).toBe(`case ${CASE_ID}: reply was not JSON`);
    });

    it('lists each distinct unusable reply reason once, in check order', () => {
      const facts = pendingFacts({
        checks: [gradedCheck('g1'), gradedCheck('g2'), gradedCheck('g3')],
        grading: buildGradingArtifact({
          grades: [
            buildPendingGrade({ checkId: 'g1', reason: 'first reason' }),
            buildPendingGrade({ checkId: 'g2', reason: 'second reason' }),
            buildPendingGrade({ checkId: 'g3', reason: 'first reason' }),
          ],
        }),
      });

      const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(pending?.detail).toBe(`case ${CASE_ID}: first reason; second reason`);
      expect(pending?.next).toBe(
        `Record the verdicts with \`tevu assess ${FIXTURE_RUN_ID} ${CASE_ID}\`.`,
      );
    });

    describe.each(NO_REPLY_CASES)('no reply with cause $cause', ({ cause, base, opening }) => {
      const reason = `the grader call failed: ${cause} detail`;
      const gradingOf = (callCount: number): GradingArtifact =>
        buildMultiCallGradingArtifact(callCount, {
          call: { status: 'no-reply', cause, reason },
        });

      it('opens with the cause alone after one call', () => {
        const facts = pendingFacts({
          checks: [gradedCheck('g1')],
          grading: buildGradingArtifact({ call: { status: 'no-reply', cause, reason } }),
        });

        const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

        expect(pending?.happened).toBe(
          `${opening}, so 1 required graded check waits for a person's verdict.`,
        );
        expect(pending?.detail).toBe(`case ${CASE_ID}: ${reason}`);
      });

      it('opens with the call count after three calls', () => {
        const facts = pendingFacts({
          checks: [gradedCheck('g1'), gradedCheck('g2', false)],
          grading: gradingOf(3),
        });

        const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

        expect(pending?.happened).toBe(
          `After 3 calls, ${base}, so 1 required and 1 optional graded checks wait for a person's verdict.`,
        );
      });
    });

    it('puts the grader call reason in the detail of an attempt that also waits on a manual check', () => {
      const facts = pendingFacts({
        checks: [manualCheck('m1'), gradedCheck('g1')],
        grading: noReply,
      });

      const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(pending?.detail).toBe(
        `case ${CASE_ID}: the grader call failed: ModelCallError (failed)`,
      );
    });

    it('sets no pending statement when the lifecycle is not completed', () => {
      const facts = pendingFacts({ checks: [manualCheck('m1')], lifecycle: 'timed-out' });

      const { pending } = describeAttempt(facts, FIXTURE_RUN_ID);

      expect(pending).toBeNull();
    });
  });
});

describe('gradingGapStatement', () => {
  const baseFacts = {
    runId: FIXTURE_RUN_ID,
    caseId: CASE_ID,
    grading: buildGradingArtifact({
      call: { status: 'no-reply', cause: 'other', reason: 'call failed' },
    }),
    lifecycle: 'completed' as const,
    pendingGradedChecks: { required: 5, optional: 0 },
  };

  it('names the waiting graded checks and the assess command when some are pending', () => {
    const statement = gradingGapStatement(baseFacts);

    expect(statement).toEqual({
      happened:
        "The grading model returned no verdict for this solution, so 5 required graded checks still wait for a person's verdict.",
      means:
        'The grader total for the task counts a measurement of this grading only when tevu has it for the whole grading.',
      next: `Record the verdicts with \`tevu assess ${FIXTURE_RUN_ID} ${CASE_ID}\`.`,
      detail: `case ${CASE_ID}: call failed`,
    });
  });

  it('uses the singular for one waiting check and splits required from optional', () => {
    const one = gradingGapStatement({
      ...baseFacts,
      pendingGradedChecks: { required: 0, optional: 1 },
    });
    const both = gradingGapStatement({
      ...baseFacts,
      pendingGradedChecks: { required: 1, optional: 2 },
    });

    expect(one?.happened).toBe(
      "The grading model returned no verdict for this solution, so 1 optional graded check still waits for a person's verdict.",
    );
    expect(both?.happened).toContain('so 1 required and 2 optional graded checks still wait for');
  });

  it.each([
    {
      label: 'no graded check waits',
      overrides: { pendingGradedChecks: { required: 0, optional: 0 } },
    },
    { label: 'the attempt did not complete', overrides: { lifecycle: 'timed-out' as const } },
    { label: 'the lifecycle is unknown', overrides: { lifecycle: undefined } },
  ])('mentions no waiting check and needs nothing more when $label', ({ overrides }) => {
    const statement = gradingGapStatement({ ...baseFacts, ...overrides });

    expect(statement).toEqual({
      happened: 'The grading model returned no verdict for this solution.',
      means:
        'The grader total for the task counts a measurement of this grading only when tevu has it for the whole grading.',
      next: 'Nothing more is needed for this grading.',
      detail: `case ${CASE_ID}: call failed`,
    });
  });

  describe.each(NO_REPLY_CASES)('cause $cause', ({ cause, base, opening }) => {
    const reason = `call failed: ${cause} detail`;

    it('names the cause alone after one call', () => {
      const grading = buildGradingArtifact({ call: { status: 'no-reply', cause, reason } });

      const statement = gradingGapStatement({ ...baseFacts, grading });

      expect(statement?.happened).toBe(
        `${opening}, so 5 required graded checks still wait for a person's verdict.`,
      );
      expect(statement?.detail).toBe(`case ${CASE_ID}: ${reason}`);
    });

    it('opens with the call count after three calls', () => {
      const grading = buildMultiCallGradingArtifact(3, {
        call: { status: 'no-reply', cause, reason },
      });

      const statement = gradingGapStatement({
        ...baseFacts,
        grading,
        pendingGradedChecks: { required: 0, optional: 0 },
      });

      expect(statement?.happened).toBe(`After 3 calls, ${base}.`);
    });
  });

  it('returns null for a call that replied', () => {
    const statement = gradingGapStatement({ ...baseFacts, grading: buildGradingArtifact() });

    expect(statement).toBeNull();
  });
});

describe('measurementGapStatement', () => {
  it('describes one measurement of the agent in the singular', () => {
    const statement = measurementGapStatement({
      reason: 'no price listed',
      count: 1,
      graderLine: false,
    });

    expect(statement).toEqual({
      happened: 'tevu has no value for this measurement.',
      means: 'It is unknown, not zero.',
      next: "This run's saved files cannot supply it; to measure it, fix the cause in the technical detail and run the comparison again.",
      detail: 'no price listed',
    });
  });

  it('describes several measurements of a grading in the plural', () => {
    const statement = measurementGapStatement({ reason: 'no export', count: 3, graderLine: true });

    expect(statement).toEqual({
      happened: 'tevu has no value for these measurements of its grading.',
      means: 'They are unknown, not zero.',
      next: "This run's saved files cannot supply them; to measure them, fix the cause in the technical detail and run the comparison again.",
      detail: 'no export',
    });
  });
});

describe('effortStatement', () => {
  it('explains an unverified effort with the check reason as detail', () => {
    const statement = effortStatement('high', {
      status: 'unverified',
      reason: 'agent listing failed',
    });

    expect(statement).toEqual({
      happened: 'tevu could not confirm that the agent offers effort "high" for this model.',
      means:
        'The effort was passed as requested; if the agent does not offer it, the model ran with its default options.',
      next: 'Before the next run, check the effort against the variants the agent lists for the model.',
      detail: 'agent listing failed',
    });
  });

  it('explains an unsupported effort with the check reason as detail', () => {
    const statement = effortStatement('xhigh', {
      status: 'unsupported',
      reason: 'variants: low, high',
    });

    expect(statement).toEqual({
      happened: 'The agent does not list effort "xhigh" for this model.',
      means: 'Where no task repository defines it, the model ran with its default options.',
      next: 'Choose an effort the agent lists for the model and run the comparison again.',
      detail: 'variants: low, high',
    });
  });

  it.each([
    { label: 'verified', check: { status: 'verified' } as const },
    { label: 'null', check: null },
    { label: 'undefined', check: undefined },
  ])('returns null for a $label check', ({ check }) => {
    expect(effortStatement('high', check)).toBeNull();
  });
});

describe('gradeLines', () => {
  const NO_VERDICT_TAIL = 'This check has no verdict until you record one. Choose a verdict below.';

  it('states that no grading was saved when there is neither grade nor grading', () => {
    expect(gradeLines(null, null)).toEqual([
      `tevu has no grading for this solution. ${NO_VERDICT_TAIL} Technical detail: no grading artifact was saved for this case`,
    ]);
  });

  it('states that the grading lacks the check when there is a grading but no grade', () => {
    expect(gradeLines(null, buildGradingArtifact())).toEqual([
      `tevu has no grading for this solution. ${NO_VERDICT_TAIL} Technical detail: the grading has no grade for this check`,
    ]);
  });

  it.each(NO_REPLY_CASES)(
    'puts the call reason of a no-reply grading with cause $cause after the technical detail marker',
    ({ cause, opening }) => {
      const grading = buildGradingArtifact({
        call: { status: 'no-reply', cause, reason: 'call failed: boom' },
      });

      const lines = gradeLines(buildPendingGrade({ checkId: 'g1' }), grading);

      expect(lines).toEqual([`${opening}. ${NO_VERDICT_TAIL} Technical detail: call failed: boom`]);
    },
  );

  it.each(NO_REPLY_CASES)(
    'opens with the call count for a no-reply grading with cause $cause after three calls',
    ({ cause, base }) => {
      const grading = buildMultiCallGradingArtifact(3, {
        call: { status: 'no-reply', cause, reason: 'call failed: boom' },
      });

      const lines = gradeLines(buildPendingGrade({ checkId: 'g1' }), grading);

      expect(lines).toEqual([
        `After 3 calls, ${base}. ${NO_VERDICT_TAIL} Technical detail: call failed: boom`,
      ]);
    },
  );

  it('puts the grade reason of a replied grading after the technical detail marker', () => {
    const grade = buildPendingGrade({ checkId: 'g1', reason: 'reply was not JSON' });

    const lines = gradeLines(grade, buildGradingArtifact());

    expect(lines).toEqual([
      `The grading model's reply had no usable verdict for this check. ${NO_VERDICT_TAIL} Technical detail: reply was not JSON`,
    ]);
  });

  it('adds the verdict line before an explanation when the grader could not decide', () => {
    const grade = buildGradedGrade({
      checkId: 'g1',
      verdict: 'undetermined',
      rationale: 'unclear',
    });

    const lines = gradeLines(grade, buildGradingArtifact());

    expect(lines).toEqual([
      'Grader verdict: undetermined (vendor/grader-model, effort medium): unclear',
      `The grading model could not decide this check from the task text and the solution's changes. ${NO_VERDICT_TAIL}`,
    ]);
  });

  it.each(['passed', 'failed'] as const)(
    'shows only the verdict line for a %s grade',
    (verdict) => {
      const grade = buildGradedGrade({ checkId: 'g1', verdict, rationale: 'because' });

      const lines = gradeLines(grade, buildGradingArtifact());

      expect(lines).toEqual([
        `Grader verdict: ${verdict} (vendor/grader-model, effort medium): because`,
      ]);
    },
  );
});
