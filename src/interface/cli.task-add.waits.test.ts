// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  artifactError,
  buildCliCapabilityReport,
  buildCliResolvedTask,
  buildFinding,
  buildGitHubRepositoryConfig,
  buildJiraIssueSnapshot,
  createOperations,
  expectNoWrites,
  managedCloneFailure,
  recordOperation,
  registerCliTestHooks,
  runCli,
} from './__fixtures__/program.fixtures';
import { clack, scriptAnswers } from './__fixtures__/scripted-prompts.fixtures';
import {
  accessOutcome,
  BOOTSTRAP_ANSWERS,
  buildCriteriaConfig,
  buildResolvedCommitReference,
  definedProvider,
  DRAFT_FAILURE_CASES,
  draftFailureMessage,
  EXIT_QUESTION,
  inspectingProviders,
  operationsWithModelCheck,
  READY_ANSWERS,
  setupAnswers,
  taskInterviewAnswers,
} from './__fixtures__/task-wizard.fixtures';

import type { ProgramOperations } from './__fixtures__/program.fixtures';

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

describe('tevu CLI', () => {
  registerCliTestHooks();

  describe('task add', () => {
    describe('the save loop', () => {
      const SAVE_PROMPT = 'Save to tevu.yaml?';
      const SAVE_LAST_LINE = 'Fix the cause, then press Enter to save again, or Ctrl-C to cancel.';

      function failsThenSaves(
        error: Extract<
          Awaited<ReturnType<ProgramOperations['createTask']>>,
          { ok: false }
        >['error'],
      ): ReturnType<typeof vi.fn<ProgramOperations['createTask']>> {
        return vi
          .fn<ProgramOperations['createTask']>()
          .mockResolvedValueOnce({ ok: false, error })
          .mockResolvedValue({ ok: true, value: buildCliResolvedTask({ id: 'task-2' }) });
      }

      it('warns, asks Save again with Yes selected, and saves the same input on Yes', async () => {
        const createTask = failsThenSaves(artifactError('write-config', 'disk full'));
        const operations = createOperations({ createTask });
        scriptAnswers(...taskInterviewAnswers('repo-1'), true, true);

        const { code, err } = await runCli(['task', 'add'], { operations });

        const savePrompts = clack.state.prompts.filter((prompt) => prompt.message === SAVE_PROMPT);
        expect(code).toBe(0);
        expect(err).toEqual([]);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: `Couldn't save the task to tevu.yaml.\nartifact operation "write-config" failed: disk full\n${SAVE_LAST_LINE}`,
        });
        expect(savePrompts.map((prompt) => prompt.initialValue)).toEqual([true, true]);
        expect(createTask).toHaveBeenCalledTimes(2);
        expect(createTask.mock.calls[1]).toEqual(createTask.mock.calls[0]);
        expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
        expect(clack.state.cancels).toEqual([]);
        expect(clack.state.answers).toEqual([]);
      });

      it('keeps every rendered line of a multi-line error as a detail line', async () => {
        const createTask = failsThenSaves({
          kind: 'ConfigValidationError',
          findings: [
            buildFinding({ severity: 'error', identifier: 'tasks', message: 'the file changed' }),
          ],
        });
        const operations = createOperations({ createTask });
        scriptAnswers(...taskInterviewAnswers('repo-1'), true, true);

        await runCli(['task', 'add'], { operations });

        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: `Couldn't save the task to tevu.yaml.\nthe configuration is invalid\n  error tasks: the file changed\n${SAVE_LAST_LINE}`,
        });
      });

      it('redacts a secret that the write error quotes', async () => {
        const createTask = failsThenSaves(artifactError('write-config', 'rejected token hunter2'));
        const operations = createOperations({ createTask });
        scriptAnswers(...taskInterviewAnswers('repo-1'), true, true);

        await runCli(['task', 'add'], {
          operations,
          redact: (text) => text.replaceAll('hunter2', '[redacted]'),
        });

        const warning = clack.state.logs.find((log) =>
          log.message.startsWith("Couldn't save the task"),
        );
        expect(warning?.message).toContain('rejected token [redacted]');
        expect(warning?.message).not.toContain('hunter2');
      });

      it('retries on every failure until a save stands', async () => {
        const createTask = vi
          .fn<ProgramOperations['createTask']>()
          .mockResolvedValueOnce({ ok: false, error: artifactError('write-config', 'disk full') })
          .mockResolvedValueOnce({ ok: false, error: artifactError('write-config', 'disk full') })
          .mockResolvedValue({ ok: true, value: buildCliResolvedTask({ id: 'task-2' }) });
        const operations = createOperations({ createTask });
        scriptAnswers(...taskInterviewAnswers('repo-1'), true, true, true);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(createTask).toHaveBeenCalledTimes(3);
        expect(clack.state.answers).toEqual([]);
      });

      it('ends cancelled on Ctrl-C at the Save question after a failed save', async () => {
        const createTask = failsThenSaves(artifactError('write-config', 'disk full'));
        const operations = createOperations({ createTask });
        scriptAnswers(...taskInterviewAnswers('repo-1'), true, clack.CANCEL);

        const { code, err } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(err).toEqual([]);
        expect(createTask).toHaveBeenCalledOnce();
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
      });

      it('asks the exit question after No at the Save question, and Save again after No there', async () => {
        const operations = createOperations();
        scriptAnswers(...taskInterviewAnswers('repo-1'), false, false, true);

        const { code } = await runCli(['task', 'add'], { operations });

        const messages = clack.state.prompts.map((prompt) => prompt.message);
        expect(code).toBe(0);
        expect(messages.slice(-3)).toEqual([SAVE_PROMPT, EXIT_QUESTION, SAVE_PROMPT]);
        expect(operations.createTask).toHaveBeenCalledOnce();
        expect(clack.state.answers).toEqual([]);
      });

      it('ends with one cancel line, exit 130, and no write on Yes at the exit question', async () => {
        const operations = createOperations();
        scriptAnswers(...taskInterviewAnswers('repo-1'), false, true);

        const { code, err } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(err).toEqual([]);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(clack.state.prompts.at(-1)?.message).toBe(EXIT_QUESTION);
        expectNoWrites(operations);
      });

      it('prints the added line and exits 0 for an ok save when the signal aborted during Saving task', async () => {
        const controller = new AbortController();
        const createTask = vi.fn<ProgramOperations['createTask']>(async () => {
          controller.abort();
          return { ok: true, value: buildCliResolvedTask({ id: 'task-2' }) };
        });
        const operations = createOperations({ createTask });
        scriptAnswers(...taskInterviewAnswers('repo-1'), true);

        const { code, err } = await runCli(['task', 'add'], {
          operations,
          cancellation: controller.signal,
        });

        expect(code).toBe(0);
        expect(err).toEqual([]);
        expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
        expect(clack.state.cancels).toEqual([]);
        expect(clack.state.answers).toEqual([]);
      });

      it('ends cancelled without a failure warning when the signal aborted and the save failed', async () => {
        const controller = new AbortController();
        const createTask = vi.fn<ProgramOperations['createTask']>(async () => {
          controller.abort();
          return { ok: false, error: artifactError('write-config', 'interrupted') };
        });
        const operations = createOperations({ createTask });
        scriptAnswers(...taskInterviewAnswers('repo-1'), true);

        const { code } = await runCli(['task', 'add'], {
          operations,
          cancellation: controller.signal,
        });

        expect(code).toBe(130);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(clack.state.logs.map((log) => log.message)).not.toContainEqual(
          expect.stringContaining("Couldn't save the task"),
        );
        expect(clack.state.prompts.map((prompt) => prompt.message)).not.toContain(EXIT_QUESTION);
      });

      it('ends cancelled when the write reports a cancellation', async () => {
        const createTask = vi.fn<ProgramOperations['createTask']>(async () => ({
          ok: false,
          error: { kind: 'CancellationError', activeCaseIds: [] },
        }));
        const operations = createOperations({ createTask });
        scriptAnswers(...taskInterviewAnswers('repo-1'), true);

        const { code, err } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(err).toEqual([]);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
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
            answers: ['repo-1', clack.CANCEL, true],
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
            answers: ['manual', 'repo-1', clack.CANCEL, true],
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
            answers: ['manual', 'repo-1', 'HEAD~3', clack.CANCEL, true],
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
              answers: ['manual', 'repo-1', '', 'abc123', clack.CANCEL, true],
            };
          },
        },
        {
          label: 'Fetching Git LFS objects',
          operation: 'ensureManagedLfsObjects',
          argv: ['task', 'add'],
          build: (outcome, controller) => ({
            operations: createOperations({
              loadConfig: vi.fn(async () => ({
                ok: true as const,
                value: buildGitHubRepositoryConfig(),
              })),
              ensureManagedCommits: async () => ({ ok: true as const, value: { missing: [] } }),
              ensureManagedLfsObjects: recordOperation('ensureManagedLfsObjects', async () => {
                applyOutcome(outcome, controller);
                return outcome === 'returns an error'
                  ? { ok: false as const, error: managedCloneFailure() }
                  : { ok: true as const, value: undefined };
              }),
            }),
            answers: ['manual', 'repo-1', '', 'abc123', clack.CANCEL, true],
          }),
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
                      retainedDirectories: [],
                    }
                  : {
                      status: 'drafted' as const,
                      effort: { status: 'verified' as const },
                      draft: { acceptance: ['a'], done: ['d'] },
                      retainedDirectories: [],
                    };
              }),
            }),
            answers: [...READY_ANSWERS, clack.CANCEL, true],
          }),
        },
        {
          label: 'Checking base commit',
          operation: 'inspectBaseCommit',
          argv: ['task', 'add'],
          build: (outcome, controller) => ({
            operations: createOperations({
              inspectBaseCommit: recordOperation('inspectBaseCommit', async () => {
                applyOutcome(outcome, controller);
                return outcome === 'returns an error'
                  ? {
                      ok: false as const,
                      error: {
                        kind: 'SourceMaterializationError' as const,
                        taskId: 'repo-1',
                        reason: 'no such commit',
                      },
                    }
                  : { ok: true as const, value: undefined };
              }),
            }),
            answers: ['manual', 'repo-1', '', 'abc123', clack.CANCEL, true],
          }),
        },
        {
          label: 'Checking repositories',
          operation: 'checkRepositoryPlacement',
          argv: ['task', 'add'],
          build: (outcome, controller) => ({
            operations: createOperations({
              checkRepositoryPlacement: recordOperation('checkRepositoryPlacement', async () => {
                applyOutcome(outcome, controller);
                return outcome === 'returns an error' ? [buildFinding({ severity: 'error' })] : [];
              }),
            }),
            answers: [
              'manual',
              clack.pickLabel('Add a repository'),
              'path',
              '../repos/new',
              clack.CANCEL,
              true,
            ],
          }),
        },
        {
          label: 'Checking repositories',
          operation: 'checkRepositoryPlacement',
          argv: ['task', 'add'],
          build: (outcome, controller) => ({
            operations: operationsWithModelCheck({
              checkRepositoryPlacement: recordOperation('checkRepositoryPlacement', async () => {
                applyOutcome(outcome, controller);
                return outcome === 'returns an error' ? [buildFinding({ severity: 'error' })] : [];
              }),
            }),
            answers: [...BOOTSTRAP_ANSWERS.slice(0, 12), clack.CANCEL, true],
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
                  : { ok: true as const, value: buildCliCapabilityReport() };
              }),
            }),
            answers: [...BOOTSTRAP_ANSWERS.slice(0, 6), clack.CANCEL, true],
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
            answers: [...BOOTSTRAP_ANSWERS.slice(0, 13), clack.CANCEL, true],
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
                  ? {
                      status: 'listing-failed' as const,
                      detail: 'exits with code 3',
                      retainedDirectory: null,
                    }
                  : accessOutcome('listed');
              }),
            }),
            answers: [...BOOTSTRAP_ANSWERS.slice(0, 13), clack.CANCEL, true],
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

      describe('Saving task', () => {
        function savingOperations(outcome: WaitOutcome): ProgramOperations {
          return createOperations({
            createTask: recordOperation('createTask', async () => {
              if (outcome === 'throws') {
                throw new Error('boom');
              }
              return outcome === 'returns an error'
                ? { ok: false as const, error: artifactError('write-config', 'disk full') }
                : { ok: true as const, value: buildCliResolvedTask({ id: 'task-2' }) };
            }),
          });
        }

        it.each(['succeeds', 'returns an error', 'throws'] as const)(
          'holds stdin and shows the spinner around the operation when it %s',
          async (outcome) => {
            const operations = savingOperations(outcome);
            scriptAnswers(
              ...taskInterviewAnswers('repo-1'),
              true,
              ...(outcome === 'returns an error' ? [clack.CANCEL, true] : []),
            );

            const [settled] = await Promise.allSettled([runCli(['task', 'add'], { operations })]);

            expect(settled.status).toBe(outcome === 'throws' ? 'rejected' : 'fulfilled');
            expect(clack.state.spinners).toContainEqual({
              label: 'Saving task',
              handleSignals: false,
            });
            expectWaitAroundOperation('Saving task', 'createTask');
          },
        );
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
            answers: ['manual', 'repo-1', clack.CANCEL, true],
          }),
          expected: `Can't use repository repo-1.\n${CLONE_FAILURE_DETAIL}\nFix the cause or choose another repository below. Press Enter to retry, or Ctrl-C to cancel.`,
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
            answers: ['manual', 'repo-1', 'bad-ref', clack.CANCEL, true],
          }),
          expected:
            "Can't resolve the reference.\nthe answer does not name a commit\nFix the reference below, or clear it to add the task without one. Press Enter to retry, or Ctrl-C to cancel.",
          composedLines: [0, 2],
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
            answers: ['manual', 'repo-1', 'octo/app#128', clack.CANCEL, true],
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
            answers: ['manual', 'repo-1', '', 'abc123', clack.CANCEL, true],
          }),
          expected: `Can't fetch the base commit.\n${CLONE_FAILURE_DETAIL}\nFix the cause or change the base commit below. Press Enter to retry, or Ctrl-C to cancel.`,
          composedLines: [0, 2],
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
            answers: ['manual', 'repo-1', '', 'abc123', clack.CANCEL, true],
          }),
          expected:
            "Base commit abc123 isn't in repository repo-1.\nIt can't be fetched from github.com/octo/app.\nFix the cause or change the base commit below. Press Enter to retry, or Ctrl-C to cancel.",
          composedLines: [0, 2],
        },
        ...DRAFT_FAILURE_CASES.map(({ name, failure, lines, retryable }) => ({
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
                retainedDirectories: [],
              })),
            }),
            answers: [...READY_ANSWERS, clack.CANCEL, true],
          }),
          expected: draftFailureMessage(lines, retryable),
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
            answers: setupAnswers({ command: ['nope', clack.CANCEL, true] }),
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
            answers: setupAnswers({ firstModel: ['acme/model-a', clack.CANCEL, true] }),
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
            answers: setupAnswers({ firstModel: ['acme/model-a', clack.CANCEL, true] }),
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
            answers: setupAnswers({ firstModel: ['acme/model-x', clack.CANCEL, true] }),
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
                retainedDirectory: null,
              })),
            }),
            answers: setupAnswers({ firstModel: ['acme/model-a', clack.CANCEL, true] }),
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
            answers: [...setupAnswers({ secrets: 'ACME_KEY' }), clack.CANCEL, true],
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
              true,
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
              true,
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
                effort: { status: 'verified' as const },
                draft: { acceptance: ['a'], done: ['d'] },
                retainedDirectories: ['/tmp/tevu-call-xyz'],
              })),
            }),
            answers: [...READY_ANSWERS, clack.CANCEL, true],
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
  });
});
