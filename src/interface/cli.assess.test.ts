// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { buildGraderCall } from '@/evaluation/__fixtures__/report.fixtures';
import { gradeLines } from '@/evaluation/wording';

import {
  artifactError,
  buildAssessedCase,
  buildAssessmentContext,
  buildCliConfig,
  buildCliGraderIdentity,
  buildManualCheckSummary,
  configNotFoundError,
  configReadError,
  createOperations,
  expectNoWrites,
  registerCliTestHooks,
  runCli,
} from './__fixtures__/program.fixtures';
import { clack, scriptAnswers } from './__fixtures__/scripted-prompts.fixtures';

import type { ProgramOperations } from './__fixtures__/program.fixtures';
import type { AssessableCheckSummary } from '@/application/assess';
import type { TevuConfig } from '@/domain/config';
import type { TevuError } from '@/domain/errors';
import type { AssessmentRecord, GradeRecord, GradingSummary } from '@/domain/run-records';

vi.mock('@clack/prompts', async () => {
  const { clackPromptsModule } = await import('./__fixtures__/scripted-prompts.fixtures');
  return clackPromptsModule;
});
vi.mock('./wizard-prompts', async () => {
  const { wizardPromptsModule } = await import('./__fixtures__/scripted-prompts.fixtures');
  return wizardPromptsModule;
});
vi.mock('./sectioned-select', async () => {
  const { sectionedSelectModule } = await import('./__fixtures__/scripted-prompts.fixtures');
  return sectionedSelectModule;
});
vi.mock('yocto-spinner', async () => {
  const { yoctoSpinnerModule } = await import('./__fixtures__/scripted-prompts.fixtures');
  return yoctoSpinnerModule;
});
vi.mock('stdin-discarder', async () => {
  const { stdinDiscarderModule } = await import('./__fixtures__/scripted-prompts.fixtures');
  return stdinDiscarderModule;
});

function buildGradedCheckSummary(
  overrides: Partial<AssessableCheckSummary> & { grade?: GradeRecord | null } = {},
): AssessableCheckSummary {
  return {
    checkId: 'acc-1',
    category: 'acceptance',
    name: 'The criterion holds.',
    required: true,
    evaluator: 'grader',
    grade: null,
    grader: null,
    gradeLines: [],
    ...overrides,
  } as AssessableCheckSummary;
}

type GradingFixture = Pick<GradingSummary, 'grader' | 'call' | 'calls'>;

/** A grading whose single call replied. */
function buildRepliedGrading(): GradingFixture {
  return {
    grader: buildCliGraderIdentity(),
    call: { status: 'replied', reply: '' },
    calls: [buildGraderCall()],
  };
}

/** A grading that ended without a reply after `callCount` calls, the last of which failed with `cause`. */
function buildNoReplyGrading(
  reason: string,
  options: { cause?: 'unfinished' | 'tool-call' | 'other'; callCount?: number } = {},
): GradingFixture {
  const { cause = 'other', callCount = 1 } = options;
  const call = { status: 'no-reply', cause, reason } as const;
  return {
    grader: buildCliGraderIdentity(),
    call,
    calls: Array.from({ length: callCount }, () => buildGraderCall({ outcome: call })),
  };
}

/** A graded check whose wizard lines come from the same function `readAssessmentContext` uses. */
function buildGradedCheckFromGrading(
  grade: GradeRecord | null,
  grading: GradingFixture | null,
): AssessableCheckSummary {
  return buildGradedCheckSummary({
    grade,
    grader: grading?.grader ?? null,
    gradeLines: gradeLines(grade, grading),
  });
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
  registerCliTestHooks();

  describe('assess', () => {
    it('collects verdicts for every manual check in configuration order and splices the cancellation signal', async () => {
      const cancellation = new AbortController().signal;
      let loadedConfig: TevuConfig | undefined;
      const operations = createOperations({
        loadConfig: vi.fn(async () => {
          const config = buildCliConfig();
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
                name: 'Loader is documented',
                category: 'definition-of-done',
                required: false,
              }),
            ],
          }),
        })),
        applyAssessment: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessedCase({
            summary: [
              'vendor/model-a, high on "Export the current view": passed; required checks 1/1 passed.',
              '  Reviewed by TOKEN-VALUE.',
            ],
          }),
        })),
      });
      scriptAnswers('alice', 'passed', '', 'failed', 'loader missing');

      const { code, out } = await runCli(['assess', 'run-1', 'case-1'], {
        operations,
        cancellation,
        redact: (text) => text.replaceAll('TOKEN-VALUE', '[redacted]'),
      });

      expect(code).toBe(0);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Assessment recorded.',
        'vendor/model-a, high on "Export the current view": passed; required checks 1/1 passed.',
        '  Reviewed by [redacted].',
        'Report: /tmp/artifacts/run-1/report.md',
      ]);
      expect(clack.state.logs).toEqual([
        { kind: 'info', message: 'Assessing vendor/model-a, high on "Export the current view".' },
        { kind: 'step', message: 'Export produces a CSV (acceptance, required, manual)' },
        { kind: 'step', message: 'Loader is documented (Definition of Done, optional, manual)' },
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
          'Replace the existing assessment of this check?',
          'Verdict',
          'Confirm replacing the verdict of this check (passed -> failed)?',
        ]),
      );
      expect(clack.state.notes).toContainEqual({
        title: 'Existing assessments',
        message: 'Export produces a CSV: passed by bob at 2026-09-22T09:00:00.000Z',
      });
      expect(clack.state.logs).toContainEqual({
        kind: 'info',
        message: 'Export produces a CSV: passed by bob at 2026-09-22T09:00:00.000Z',
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
        'Replace the existing assessment of this check?',
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
        message: 'Kept the existing assessment.',
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
      const NO_VERDICT_TAIL =
        'This check has no verdict until you record one. Choose a verdict below.';

      function contextWith(check: AssessableCheckSummary): Partial<ProgramOperations> {
        return {
          readAssessmentContext: vi.fn(async () => ({
            ok: true as const,
            value: buildAssessmentContext({ checks: [check] }),
          })),
        };
      }

      function visibleWizardMessages(): string[] {
        return [
          ...clack.state.logs.filter((log) => log.kind === 'step' || log.kind === 'info'),
          ...clack.state.prompts.filter((prompt) => prompt.kind !== 'intro'),
        ].map((entry) => entry.message.split('Technical detail:')[0] ?? '');
      }

      it("shows the grader's verdict and records a replacement, kept as replaceExisting: true, when the operator confirms it", async () => {
        const grade: GradeRecord = {
          checkId: 'acc-1',
          category: 'acceptance',
          status: 'graded',
          verdict: 'passed',
          rationale: 'lines 1-4 add escaping',
        };
        const operations = createOperations(
          contextWith(buildGradedCheckFromGrading(grade, buildRepliedGrading())),
        );
        scriptAnswers('alice', true, 'failed', 'overridden after review', true);

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'step',
          message: 'The criterion holds. (acceptance, required, graded)',
        });
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message:
            'Grader verdict: passed (openai/grader-model, effort high): lines 1-4 add escaping',
        });
        expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual(
          expect.arrayContaining([
            "Replace the grader's verdict for this check?",
            'Verdict',
            "Confirm replacing the grader's verdict for this check (passed -> failed)?",
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

      it('keeps the grader verdict and says so when the replacement is not confirmed', async () => {
        const grade: GradeRecord = {
          checkId: 'acc-1',
          category: 'acceptance',
          status: 'graded',
          verdict: 'failed',
          rationale: 'the loader is missing',
        };
        const operations = createOperations(
          contextWith(buildGradedCheckFromGrading(grade, buildRepliedGrading())),
        );
        scriptAnswers('alice', true, 'passed', '', false);

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message: "Kept the grader's verdict.",
        });
        expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([]);
      });

      it('declining the replacement offer for a passed grade records no decision for that check', async () => {
        const grade: GradeRecord = {
          checkId: 'acc-1',
          category: 'acceptance',
          status: 'graded',
          verdict: 'passed',
          rationale: 'ok',
        };
        const operations = createOperations(
          contextWith(buildGradedCheckFromGrading(grade, buildRepliedGrading())),
        );
        scriptAnswers('alice', false);

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(vi.mocked(operations.applyAssessment).mock.calls[0]?.[1]?.decisions).toEqual([]);
      });

      it('explains an undetermined grade and asks directly for a verdict, with replaceExisting: false', async () => {
        const grade: GradeRecord = {
          checkId: 'acc-1',
          category: 'acceptance',
          status: 'graded',
          verdict: 'undetermined',
          rationale: 'the patch does not touch the relevant file',
        };
        const operations = createOperations(
          contextWith(buildGradedCheckFromGrading(grade, buildRepliedGrading())),
        );
        scriptAnswers('alice', 'failed', 'confirmed manually');

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message:
            'Grader verdict: undetermined (openai/grader-model, effort high): the patch does not touch the relevant file',
        });
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message: `The grading model could not decide this check from the task text and the solution's changes. ${NO_VERDICT_TAIL}`,
        });
        expect(clack.state.prompts.map((prompt) => prompt.message)).not.toContain(
          "Replace the grader's verdict for this check?",
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

      it('explains an unusable grader reply with the grade reason as technical detail and asks directly for a verdict', async () => {
        const grade: GradeRecord = {
          checkId: 'acc-1',
          category: 'acceptance',
          status: 'pending',
          reason: 'the reply named no verdict for this check',
        };
        const operations = createOperations(
          contextWith(buildGradedCheckFromGrading(grade, buildRepliedGrading())),
        );
        scriptAnswers('alice', 'passed', 'confirmed manually');

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message: `The grading model's reply had no usable verdict for this check. ${NO_VERDICT_TAIL} Technical detail: the reply named no verdict for this check`,
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

      it('logs exactly the plain sentence for a grader call without a reply, keeping the reason after the technical detail marker', async () => {
        const reason =
          'the grader call failed: ModelCallError (timed-out): run process did not finish within 30000ms';
        const grade: GradeRecord = {
          checkId: 'acc-1',
          category: 'acceptance',
          status: 'pending',
          reason,
        };
        const operations = createOperations(
          contextWith(buildGradedCheckFromGrading(grade, buildNoReplyGrading(reason))),
        );
        scriptAnswers('alice', 'passed', 'confirmed manually');

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message: `The grading model returned no verdict for this solution. This check has no verdict until you record one. Choose a verdict below. Technical detail: ${reason}`,
        });
      });

      it.each([
        {
          label: 'a model that stopped before finishing after three calls',
          options: { cause: 'unfinished', callCount: 3 } as const,
          sentence: 'After 3 calls, the grading model stopped before finishing its reply.',
        },
        {
          label: 'a session that called a tool',
          options: { cause: 'tool-call', callCount: 1 } as const,
          sentence: 'The grading model asked to use a tool, which grading does not allow.',
        },
      ])(
        'names the cause of a grading without a reply for $label',
        async ({ options, sentence }) => {
          const reason = 'the grader call failed: synthetic detail';
          const grade: GradeRecord = {
            checkId: 'acc-1',
            category: 'acceptance',
            status: 'pending',
            reason,
          };
          const operations = createOperations(
            contextWith(buildGradedCheckFromGrading(grade, buildNoReplyGrading(reason, options))),
          );
          scriptAnswers('alice', 'passed', '');

          await runCli(['assess', 'run-1', 'case-1'], { operations });

          expect(clack.state.logs).toContainEqual({
            kind: 'info',
            message: `${sentence} ${NO_VERDICT_TAIL} Technical detail: ${reason}`,
          });
        },
      );

      it('explains a missing grading artifact and asks directly for a verdict, with replaceExisting: false', async () => {
        const operations = createOperations(contextWith(buildGradedCheckFromGrading(null, null)));
        scriptAnswers('alice', 'passed', '');

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message: `tevu has no grading for this solution. ${NO_VERDICT_TAIL} Technical detail: no grading artifact was saved for this case`,
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

      it.each([
        {
          label: 'a manual check with an existing assessment',
          answers: ['alice', true, 'failed', 'regressed', true],
          operations: () =>
            createOperations({
              readAssessmentContext: vi.fn(async () => ({
                ok: true as const,
                value: buildAssessmentContext({ existing: [buildAssessmentRecord()] }),
              })),
            }),
        },
        {
          label: 'a graded check whose call returned no reply',
          answers: ['alice', 'passed', ''],
          operations: () =>
            createOperations(
              contextWith(
                buildGradedCheckFromGrading(
                  {
                    checkId: 'acc-1',
                    category: 'acceptance',
                    status: 'pending',
                    reason: 'acc-1 failed',
                  },
                  buildNoReplyGrading('acc-1 failed'),
                ),
              ),
            ),
        },
        {
          label: 'a graded check without a grading artifact',
          answers: ['alice', 'passed', ''],
          operations: () => createOperations(contextWith(buildGradedCheckFromGrading(null, null))),
        },
      ])(
        'never shows a check ID before the technical detail for $label',
        async ({ answers, operations }) => {
          scriptAnswers(...answers);

          await runCli(['assess', 'run-1', 'case-1'], { operations: operations() });

          const messages = visibleWizardMessages();
          expect(messages.length).toBeGreaterThan(2);
          for (const message of messages) {
            expect(message).not.toContain('acc-1');
          }
        },
      );
    });
  });
});
