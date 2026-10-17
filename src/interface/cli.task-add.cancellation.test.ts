// @vitest-environment node

import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  artifactError,
  buildCliConfig,
  buildCliResolvedTask,
  createOperations,
  expectNoWrites,
  registerCliTestHooks,
  runCli,
} from './__fixtures__/program.fixtures';
import { clack, resetClackState, scriptAnswers } from './__fixtures__/scripted-prompts.fixtures';
import {
  buildCriteriaConfig,
  buildResolvedCommitReference,
  criteriaOperations,
  EXIT_QUESTION,
  EXIT_QUESTION_NEW_FILE,
  EXIT_QUESTION_WITH_DRAFT,
  fullSetupAnswers,
  READY_ANSWERS,
  requireCreateTaskCall,
  taskInterviewAnswers,
} from './__fixtures__/task-wizard.fixtures';
import { createWaitInterrupt } from './wait-interrupt';

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

/** A scripted answer that interrupts the command while the prompt that consumes it is open. */
function interruptWith(controller: AbortController): () => void {
  return () => {
    controller.abort();
  };
}

/** Runs `task add` on a script and returns the prompts it drew, leaving the recorded state clean. */
async function drawnPrompts(
  answers: readonly unknown[],
  operations: ProgramOperations = createOperations(),
): Promise<typeof clack.state.prompts> {
  scriptAnswers(...answers);
  await runCli(['task', 'add'], { operations });
  const prompts = clack.state.prompts;
  resetClackState();
  return prompts;
}

describe('tevu CLI', () => {
  registerCliTestHooks();

  describe('task add', () => {
    describe('cancellation and framing', () => {
      it.each([
        {
          where: 'a setup prompt',
          exists: false,
          answers: () => ['/tmp/bench-artifacts', clack.CANCEL, true],
        },
        {
          where: 'a task prompt',
          exists: true,
          answers: () => ['manual', clack.CANCEL, true],
        },
        {
          where: 'the draft review',
          exists: true,
          answers: () => [...READY_ANSWERS, clack.CANCEL, true],
        },
        {
          where: 'the save confirmation',
          exists: true,
          answers: () => [...taskInterviewAnswers('repo-1'), false, true],
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
              effort: { status: 'verified' as const },
              draft: { acceptance: ['a'], done: ['d'] },
              retainedDirectories: [],
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
            return { ok: true as const, value: buildCliConfig() };
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
        expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
          'tevu task add',
          'Task source',
        ]);
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
        expect(clack.state.answers).toEqual([]);
      });
    });

    describe('Escape at a question', () => {
      const SCRIPT = [...taskInterviewAnswers('repo-1'), true];

      it.each([
        { kind: 'select', at: 0 },
        { kind: 'text', at: 3 },
        { kind: 'confirm', at: 8 },
      ])('ignores Escape at a $kind question and asks nothing extra', async ({ kind, at }) => {
        const baseline = createOperations();
        const baselinePrompts = await drawnPrompts(SCRIPT, baseline);
        const operations = createOperations();
        scriptAnswers(...SCRIPT.slice(0, at), clack.ESCAPE, ...SCRIPT.slice(at));

        const { code, err } = await runCli(['task', 'add'], { operations });

        expect(baselinePrompts[at + 1]?.kind).toBe(kind);
        expect(code).toBe(0);
        expect(err).toEqual([]);
        expect(clack.state.cancels).toEqual([]);
        expect(clack.state.prompts).toEqual(baselinePrompts);
        expect(requireCreateTaskCall(operations)).toEqual(requireCreateTaskCall(baseline));
        expect(clack.state.answers).toEqual([]);
      });

      it('ignores Escape at What next? of the draft review', async () => {
        const script = [...READY_ANSWERS, 'accept', false, false, true];
        const baseline = criteriaOperations();
        const baselinePrompts = await drawnPrompts(script, baseline);
        const operations = criteriaOperations();
        scriptAnswers(...READY_ANSWERS, clack.ESCAPE, ...script.slice(READY_ANSWERS.length));

        const { code, err } = await runCli(['task', 'add'], { operations });

        expect(baselinePrompts.find((prompt) => prompt.message === 'What next?')?.kind).toBe(
          'select',
        );
        expect(code).toBe(0);
        expect(err).toEqual([]);
        expect(clack.state.cancels).toEqual([]);
        expect(clack.state.prompts).toEqual(baselinePrompts);
        expect(requireCreateTaskCall(operations)).toEqual(requireCreateTaskCall(baseline));
        expect(clack.state.answers).toEqual([]);
      });
    });

    describe('the exit question', () => {
      function exitPrompts(): typeof clack.state.prompts {
        return clack.state.prompts.filter((prompt) => prompt.message.startsWith('Exit without'));
      }

      it.each([
        {
          name: 'an existing file',
          exists: true,
          answers: [...taskInterviewAnswers('repo-1'), false],
          expected: EXIT_QUESTION,
        },
        {
          name: 'a file that is not created',
          exists: false,
          answers: fullSetupAnswers().slice(0, -1).concat(false),
          expected: EXIT_QUESTION_NEW_FILE,
        },
      ])('asks with No selected for $name', async ({ exists, answers, expected }) => {
        const operations = createOperations({ configExists: vi.fn(async () => exists) });
        scriptAnswers(...answers, true);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(exitPrompts()).toEqual([
          expect.objectContaining({ kind: 'confirm', message: expected, initialValue: false }),
        ]);
        expect(clack.state.prompts.at(-1)?.message).toBe(expected);
      });

      it('names the path exactly as the wizard received it', async () => {
        const operations = createOperations();
        scriptAnswers(...taskInterviewAnswers('repo-1'), false, true);

        await runCli(['task', 'add', '--config', 'suites/tevu.yaml'], { operations });

        expect(exitPrompts().map((prompt) => prompt.message)).toEqual([
          'Exit without saving? Every answer so far is lost, and suites/tevu.yaml stays unchanged.',
        ]);
      });

      it('ends with one cancel line, exit 130, and no write on Ctrl-C at the exit question', async () => {
        const operations = createOperations();
        scriptAnswers(...taskInterviewAnswers('repo-1'), false, clack.CANCEL);

        const { code, err } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(err).toEqual([]);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(clack.state.prompts.at(-1)?.message).toBe(EXIT_QUESTION);
        expectNoWrites(operations);
      });

      it('ends at a cancelled question with exit 130 and no exit question', async () => {
        const operations = createOperations();
        scriptAnswers(clack.CANCEL);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(exitPrompts()).toEqual([]);
        expectNoWrites(operations);
      });
    });

    describe('cancellation without the exit question', () => {
      it('cancels an assess question at once with exit 130', async () => {
        const operations = createOperations();
        scriptAnswers(clack.CANCEL);

        const { code } = await runCli(['assess', 'run-1', 'case-1'], { operations });

        expect(code).toBe(130);
        expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
          'tevu assess run-1 case-1',
          'Assessor name',
        ]);
      });

      it('ends a task add wait that the signal aborted without an exit question', async () => {
        const controller = new AbortController();
        const operations = createOperations({
          resolveReference: vi.fn(async () => {
            controller.abort();
            return { ok: true as const, value: buildResolvedCommitReference() };
          }),
        });
        scriptAnswers('manual', 'repo-1', 'HEAD~3');

        const { code } = await runCli(['task', 'add'], {
          operations,
          cancellation: controller.signal,
        });

        expect(code).toBe(130);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
          'tevu task add',
          'Task source',
          'Repository',
          'Reference PR or commit',
        ]);
      });
    });

    describe('Ctrl-C during a wait', () => {
      const NOTICE =
        'Press Ctrl-C again to exit now. Every answer so far is lost, and tevu.yaml stays unchanged.\nOtherwise tevu asks whether to exit when this step ends.';
      const SAVING_NOTICE =
        'Press Ctrl-C again to stop saving. If the save stops before the write, every answer so far is lost, and tevu.yaml stays unchanged.\nOtherwise tevu saves the task, or asks whether to exit if the save fails.';
      const BEFORE_REFERENCE = taskInterviewAnswers('repo-1').slice(0, 2);
      const AFTER_REFERENCE = taskInterviewAnswers('repo-1').slice(3);

      function noticeLogs(): typeof clack.state.logs {
        return clack.state.logs.filter((log) => log.message.startsWith('Press Ctrl-C again'));
      }

      function eventsAfter(marker: string): string[] {
        return clack.state.timeline.slice(clack.state.timeline.indexOf(marker) + 1);
      }

      function referenceTaking(
        waitInterrupt: ReturnType<typeof createWaitInterrupt>,
        taken: boolean[],
      ): ProgramOperations['resolveReference'] {
        return vi.fn<ProgramOperations['resolveReference']>(async () => {
          taken.push(waitInterrupt.take(), waitInterrupt.take());
          return { ok: true as const, value: buildResolvedCommitReference() };
        });
      }

      it('keeps the wait running, prints the notice once, and opens the exit question when the step ends', async () => {
        const waitInterrupt = createWaitInterrupt();
        const controller = new AbortController();
        const taken: boolean[] = [];
        const operations = createOperations({
          resolveReference: referenceTaking(waitInterrupt, taken),
        });
        scriptAnswers(
          ...BEFORE_REFERENCE,
          'HEAD~3',
          false,
          ...READY_ANSWERS.slice(3),
          ...AFTER_REFERENCE.slice(6),
          true,
        );

        const { code } = await runCli(['task', 'add'], {
          operations,
          waitInterrupt,
          cancellation: controller.signal,
        });

        const stopped = eventsAfter('spinner:start:Resolving reference');
        expect(code).toBe(0);
        expect(taken).toEqual([true, false]);
        expect(controller.signal.aborted).toBe(false);
        expect(noticeLogs()).toEqual([{ kind: 'warn', message: NOTICE }]);
        expect(stopped.indexOf('log:warn')).toBeLessThan(
          stopped.indexOf('spinner:stop:Resolving reference'),
        );
        expect(
          eventsAfter('spinner:stop:Resolving reference').find((event) =>
            event.startsWith('prompt:'),
          ),
        ).toBe(`prompt:${EXIT_QUESTION}`);
        expect(
          clack.state.prompts.find((prompt) => prompt.message === EXIT_QUESTION),
        ).toMatchObject({ kind: 'confirm', initialValue: false });
        expect(clack.state.answers).toEqual([]);
      });

      it('continues as the same script without the take when the exit question is answered No', async () => {
        const script = [
          ...BEFORE_REFERENCE,
          'HEAD~3',
          ...READY_ANSWERS.slice(3),
          ...AFTER_REFERENCE.slice(6),
          true,
        ];
        const baseline = createOperations({
          resolveReference: referenceTaking(createWaitInterrupt(), []),
        });
        scriptAnswers(...script);
        await runCli(['task', 'add'], { operations: baseline });
        resetClackState();
        const waitInterrupt = createWaitInterrupt();
        const operations = createOperations({
          resolveReference: referenceTaking(waitInterrupt, []),
        });
        scriptAnswers(
          ...BEFORE_REFERENCE,
          'HEAD~3',
          false,
          ...READY_ANSWERS.slice(3),
          ...AFTER_REFERENCE.slice(6),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations, waitInterrupt });

        expect(code).toBe(0);
        expect(requireCreateTaskCall(operations)).toEqual(requireCreateTaskCall(baseline));
        expect(clack.state.answers).toEqual([]);
      });

      it('ends with one cancel line and exit 130 when the exit question is answered Yes', async () => {
        const waitInterrupt = createWaitInterrupt();
        const operations = createOperations({
          resolveReference: referenceTaking(waitInterrupt, []),
        });
        scriptAnswers(...BEFORE_REFERENCE, 'HEAD~3', true);

        const { code, err } = await runCli(['task', 'add'], { operations, waitInterrupt });

        expect(code).toBe(130);
        expect(err).toEqual([]);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(clack.state.prompts.at(-1)?.message).toBe(EXIT_QUESTION);
        expectNoWrites(operations);
      });

      it('asks the exit question before the warning of a step that failed', async () => {
        const waitInterrupt = createWaitInterrupt();
        const resolveReference = vi
          .fn<ProgramOperations['resolveReference']>()
          .mockImplementationOnce(async () => {
            waitInterrupt.take();
            return {
              ok: false,
              error: {
                kind: 'ReferenceResolutionError',
                reason: 'the answer does not name a commit',
              },
            };
          });
        const operations = createOperations({ resolveReference });
        scriptAnswers(...BEFORE_REFERENCE, 'bad-ref', false, '', ...AFTER_REFERENCE, true);

        await runCli(['task', 'add'], { operations, waitInterrupt });

        const afterWait = eventsAfter('spinner:stop:Resolving reference');
        expect(afterWait.slice(0, 4)).toEqual([
          'discarder:stop',
          `prompt:${EXIT_QUESTION}`,
          'log:warn',
          'prompt:Reference PR or commit',
        ]);
        expect(clack.state.logs.map((log) => log.message.split('\n')[0])).toEqual(
          expect.arrayContaining([NOTICE.split('\n')[0], "Can't resolve the reference."]),
        );
      });

      it('names the criteria draft in the exit question after a draft wait that returned a draft', async () => {
        const waitInterrupt = createWaitInterrupt();
        const draftCriteria = vi.fn<ProgramOperations['draftCriteria']>(async () => {
          waitInterrupt.take();
          return {
            status: 'drafted' as const,
            effort: { status: 'verified' as const },
            draft: { acceptance: ['a'], done: ['d'] },
            retainedDirectories: [],
          };
        });
        const operations = criteriaOperations({ draftCriteria });
        scriptAnswers(...READY_ANSWERS, false, 'accept', false, false, true);

        const { code } = await runCli(['task', 'add'], { operations, waitInterrupt });

        const afterWait = eventsAfter('spinner:stop:Drafting criteria');
        expect(code).toBe(0);
        expect(noticeLogs()).toEqual([{ kind: 'warn', message: NOTICE }]);
        expect(
          clack.state.prompts.some((prompt) => prompt.message === EXIT_QUESTION_WITH_DRAFT),
        ).toBe(true);
        expect(afterWait.indexOf(`prompt:${EXIT_QUESTION_WITH_DRAFT}`)).toBeLessThan(
          afterWait.indexOf('log:success'),
        );
        expect(clack.state.answers).toEqual([]);
      });

      it('takes a Ctrl-C during each later wait separately', async () => {
        const waitInterrupt = createWaitInterrupt();
        const taken: boolean[] = [];
        const operations = createOperations({
          resolveReference: referenceTaking(waitInterrupt, taken),
          inspectBaseCommit: vi.fn(async () => {
            taken.push(waitInterrupt.take());
            return { ok: true as const, value: undefined };
          }),
        });
        scriptAnswers(
          ...BEFORE_REFERENCE,
          'HEAD~3',
          false,
          ...READY_ANSWERS.slice(3, 4),
          false,
          ...READY_ANSWERS.slice(4),
          ...AFTER_REFERENCE.slice(6),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations, waitInterrupt });

        expect(code).toBe(0);
        expect(taken).toEqual([true, false, true]);
        expect(noticeLogs()).toHaveLength(2);
        expect(clack.state.answers).toEqual([]);
      });

      describe('during Saving task', () => {
        function savingTaking(
          waitInterrupt: ReturnType<typeof createWaitInterrupt>,
          result: Awaited<ReturnType<ProgramOperations['createTask']>>,
        ): ProgramOperations['createTask'] {
          return vi.fn<ProgramOperations['createTask']>(async () => {
            waitInterrupt.take();
            return result;
          });
        }

        it('prints the saving notice and lets an ok save stand without an exit question', async () => {
          const waitInterrupt = createWaitInterrupt();
          const createTask = savingTaking(waitInterrupt, {
            ok: true,
            value: buildCliResolvedTask({ id: 'task-2' }),
          });
          const operations = createOperations({ createTask });
          scriptAnswers(...taskInterviewAnswers('repo-1'), true);

          const { code } = await runCli(['task', 'add'], { operations, waitInterrupt });

          expect(code).toBe(0);
          expect(noticeLogs()).toEqual([{ kind: 'warn', message: SAVING_NOTICE }]);
          expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
          expect(clack.state.cancels).toEqual([]);
          expect(clack.state.prompts.map((prompt) => prompt.message)).not.toContain(EXIT_QUESTION);
          expect(clack.state.answers).toEqual([]);
        });

        it('states the criteria draft in the saving notice once a draft is held', async () => {
          const waitInterrupt = createWaitInterrupt();
          const createTask = savingTaking(waitInterrupt, {
            ok: true,
            value: buildCliResolvedTask({ id: 'task-2' }),
          });
          const operations = criteriaOperations({ createTask });
          scriptAnswers(...READY_ANSWERS, 'accept', false, false, true);

          await runCli(['task', 'add'], { operations, waitInterrupt });

          expect(noticeLogs().map((log) => log.message)).toEqual([
            SAVING_NOTICE.replace('lost, and', 'lost, including the criteria draft, and'),
          ]);
        });

        it('warns after the exit question when the save failed and No continues', async () => {
          const waitInterrupt = createWaitInterrupt();
          const createTask = vi
            .fn<ProgramOperations['createTask']>()
            .mockImplementationOnce(async () => {
              waitInterrupt.take();
              return { ok: false, error: artifactError('write-config', 'disk full') };
            })
            .mockResolvedValue({ ok: true, value: buildCliResolvedTask({ id: 'task-2' }) });
          const operations = createOperations({ createTask });
          scriptAnswers(...taskInterviewAnswers('repo-1'), true, false, true);

          const { code } = await runCli(['task', 'add'], { operations, waitInterrupt });

          const afterWait = eventsAfter('spinner:stop:Saving task');
          expect(code).toBe(0);
          expect(afterWait.filter((event) => event !== 'discarder:stop').slice(0, 3)).toEqual([
            `prompt:${EXIT_QUESTION}`,
            'log:warn',
            'prompt:Save to tevu.yaml?',
          ]);
          expect(createTask).toHaveBeenCalledTimes(2);
          expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
          expect(clack.state.answers).toEqual([]);
        });

        it('ends cancelled without the failure warning when Yes answers the exit question after a failed save', async () => {
          const waitInterrupt = createWaitInterrupt();
          const createTask = savingTaking(waitInterrupt, {
            ok: false,
            error: artifactError('write-config', 'disk full'),
          });
          const operations = createOperations({ createTask });
          scriptAnswers(...taskInterviewAnswers('repo-1'), true, true);

          const { code, err } = await runCli(['task', 'add'], { operations, waitInterrupt });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expect(clack.state.logs.map((log) => log.message)).not.toContainEqual(
            expect.stringContaining("Couldn't save the task"),
          );
        });
      });
    });
  });
});
