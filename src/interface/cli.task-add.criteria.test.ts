// @vitest-environment node

import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  createOperations,
  expectNoWrites,
  registerCliTestHooks,
  runCli,
} from './__fixtures__/program.fixtures';
import {
  clack,
  eventsAfterWait,
  removalWarnings,
  scriptAnswers,
} from './__fixtures__/scripted-prompts.fixtures';
import {
  BOOTSTRAP_ANSWERS,
  buildCriteriaConfig,
  buildResolvedCommitReference,
  criteriaOperations,
  DRAFT_FAILURE_CASES,
  draftFailureMessage,
  EXIT_QUESTION_WITH_DRAFT,
  READY_ANSWERS,
  REFERENCE_HASH,
  requireCreateTaskCall,
  taskInterviewAnswers,
} from './__fixtures__/task-wizard.fixtures';
import { createWaitInterrupt } from './wait-interrupt';

import type { ProgramOperations } from './__fixtures__/program.fixtures';
import type { CriteriaDraftFailure } from '@/application/draft-criteria';
import type { EffortCheck } from '@/domain/run-records';

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
    describe('the criteria draft retry', () => {
      const RETRYABLE = DRAFT_FAILURE_CASES.filter(({ retryable }) => retryable);
      const FALL_BACK = DRAFT_FAILURE_CASES.filter(({ retryable }) => !retryable);

      function failsOnce(
        failure: CriteriaDraftFailure,
      ): ReturnType<typeof vi.fn<ProgramOperations['draftCriteria']>> {
        return vi
          .fn<ProgramOperations['draftCriteria']>()
          .mockResolvedValueOnce({ status: 'failed', failure, retainedDirectories: [] })
          .mockResolvedValue({
            status: 'drafted',
            effort: { status: 'verified' as const },
            draft: { acceptance: ['Retried acceptance.'], done: ['Retried done.'] },
            retainedDirectories: [],
          });
      }

      it.each(RETRYABLE)(
        'asks Draft the criteria again? after $name and drafts once more on Yes',
        async ({ failure }) => {
          const draftCriteria = failsOnce(failure);
          const operations = criteriaOperations({ draftCriteria });
          scriptAnswers(...READY_ANSWERS, true, 'accept', false, false, true);

          const { code } = await runCli(['task', 'add'], { operations });

          const retry = clack.state.prompts.find(
            (prompt) => prompt.message === 'Draft the criteria again?',
          );
          expect(code).toBe(0);
          expect(retry).toMatchObject({ kind: 'confirm', initialValue: true });
          expect(draftCriteria).toHaveBeenCalledTimes(2);
          expect(draftCriteria.mock.calls[1]).toEqual(draftCriteria.mock.calls[0]);
          expect(
            clack.state.spinners.filter((spinner) => spinner.label === 'Drafting criteria'),
          ).toHaveLength(2);
          expect(requireCreateTaskCall(operations).task.checks.acceptance).toEqual([
            { id: 'acceptance-1', description: 'Retried acceptance.' },
          ]);
          expect(clack.state.answers).toEqual([]);
        },
      );

      it.each(RETRYABLE)(
        'continues with the hand-written check questions and drafts no more after No for $name',
        async ({ failure }) => {
          const draftCriteria = failsOnce(failure);
          const operations = criteriaOperations({ draftCriteria });
          scriptAnswers(...READY_ANSWERS, false, ...taskInterviewAnswers('repo-1').slice(9), true);

          const { code } = await runCli(['task', 'add'], { operations });

          const messages = clack.state.prompts.map((prompt) => prompt.message);
          expect(code).toBe(0);
          expect(draftCriteria).toHaveBeenCalledOnce();
          expect(messages).toContain('Check type');
          expect(messages).not.toContain('What next?');
          expect(requireCreateTaskCall(operations).task.checks.acceptance).toEqual([
            { id: 'acceptance-1', description: 'Export produces a CSV', manual: true },
          ]);
          expect(clack.state.answers).toEqual([]);
        },
      );

      it.each(FALL_BACK)('never asks to draft again after $name', async ({ failure }) => {
        const draftCriteria = failsOnce(failure);
        const operations = criteriaOperations({ draftCriteria });
        scriptAnswers(...READY_ANSWERS, ...taskInterviewAnswers('repo-1').slice(9), true);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(draftCriteria).toHaveBeenCalledOnce();
        expect(clack.state.prompts.map((prompt) => prompt.message)).not.toContain(
          'Draft the criteria again?',
        );
        expect(clack.state.answers).toEqual([]);
      });
    });
    describe('criteria drafting (AC-1 to AC-6, AC-12, AC-17)', () => {
      function operationsDrafting(draft: {
        acceptance: string[];
        done: string[];
      }): ProgramOperations {
        return createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria: vi.fn(async () => ({
            status: 'drafted' as const,
            effort: { status: 'verified' as const },
            draft,
            retainedDirectories: [],
          })),
        });
      }

      function draftNotes(): string[] {
        return clack.state.notes
          .filter((note) => note.title === 'Drafted criteria')
          .map((note) => note.message);
      }

      function promptCount(message: string): number {
        return clack.state.prompts.filter((prompt) => prompt.message === message).length;
      }

      it('never calls draftCriteria when roles.criteria is not declared, telling the operator to enter the criteria (C1)', async () => {
        const operations = createOperations({
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
        });
        scriptAnswers(...READY_ANSWERS, ...taskInterviewAnswers('repo-1').slice(9), true);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(operations.draftCriteria).not.toHaveBeenCalled();
        expect(clack.state.logs).toContainEqual({
          kind: 'info',
          message: 'No criteria model set. Enter the criteria yourself.',
        });
        expect(clack.state.spinners).not.toContainEqual(
          expect.objectContaining({ label: 'Drafting criteria' }),
        );
        expect(clack.state.answers).toEqual([]);
      });

      it('hands draftCriteria the same captured bootstrap answers createTask writes when no configuration exists yet', async () => {
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          effort: { status: 'verified' as const },
          draft: {
            acceptance: ['The export button appears on the table view.'],
            done: ['The change is documented for users.'],
          },
          retainedDirectories: [],
        }));
        const operations = createOperations({
          configExists: vi.fn(async () => false),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...BOOTSTRAP_ANSWERS,
          false,
          true,
          'openai/criteria-model',
          'high',
          'manual',
          'alpha',
          'HEAD~3',
          '',
          'Add an export button',
          'Export the current view as CSV.',
          'Implement CSV export for the current view.',
          'Repository is readable',
          false,
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(operations.loadConfig).not.toHaveBeenCalled();
        const call = requireCreateTaskCall(operations);
        expect(draftCriteria).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            configuration: { kind: 'bootstrap', answers: call.bootstrap },
          }),
        );
        expect(clack.state.answers).toEqual([]);
      });

      it('calls draftCriteria exactly once and saves an unchanged draft as acceptance-<n>/done-<n> checks in reply order (P2, P4, E4)', async () => {
        const config = buildCriteriaConfig();
        const resolveReference = vi.fn(async () => ({
          ok: true as const,
          value: buildResolvedCommitReference(),
        }));
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          effort: { status: 'verified' as const },
          draft: {
            acceptance: ['The export button appears on the table view.'],
            done: ['The change is documented for users.'],
          },
          retainedDirectories: [],
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference,
          draftCriteria,
        });
        scriptAnswers(...READY_ANSWERS, 'accept', false, false, true);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(draftCriteria).toHaveBeenCalledExactlyOnceWith({
          configPath: 'tevu.yaml',
          configuration: { kind: 'loaded', config },
          repository: { id: 'repo-1', path: '../repos/fixture' },
          reference: buildResolvedCommitReference(),
          prompt: 'Implement CSV export for the current view.',
          description: 'Export the current view as CSV.',
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'The export button appears on the table view.' },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'The change is documented for users.' },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('prints one result line after the draft and names no model, effort, or configuration key', async () => {
        const config = buildCriteriaConfig();
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
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
        scriptAnswers(...READY_ANSWERS, 'accept', false, false, true);

        await runCli(['task', 'add'], { operations });

        const logMessages = clack.state.logs.map((log) => log.message);
        expect(clack.state.logs).toContainEqual({ kind: 'success', message: 'Criteria drafted' });
        expect(
          logMessages.filter((message) => /openai|criteria-model|effort|roles\./i.test(message)),
        ).toEqual([]);
        expect(clack.state.spinners).toContainEqual(
          expect.objectContaining({ label: 'Drafting criteria' }),
        );
      });

      it('titles the review note and asks the review questions with the terse labels', async () => {
        const config = buildCriteriaConfig();
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria: vi.fn(async () => ({
            status: 'drafted' as const,
            effort: { status: 'verified' as const },
            draft: {
              acceptance: [`This touches commit ${REFERENCE_HASH.slice(0, 7)} directly.`],
              done: ['The change is documented for users.'],
            },
            retainedDirectories: [],
          })),
        });
        scriptAnswers(...READY_ANSWERS, 'add', clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        const draftNote = clack.state.notes.find((note) => note.title === 'Drafted criteria');
        expect(draftNote?.message.split('\n')[0]).toBe(
          'Agents see every item. Keep outcomes, not details of the reference solution.',
        );
        const prompts = clack.state.prompts.filter((prompt) => prompt.message === 'What next?');
        expect(prompts.map((prompt) => prompt.message)).toEqual(['What next?']);
        expect(prompts[0]?.options).toEqual([
          {
            label: 'Accept',
            hint: '1 item names the reference solution; edit or remove it',
            disabled: true,
          },
          { label: 'Edit an item', hint: undefined, disabled: false },
          { label: 'Remove an item', hint: undefined, disabled: false },
          { label: 'Add an item', hint: undefined, disabled: false },
          { label: 'Write my own instead', hint: undefined, disabled: false },
        ]);
        expect(clack.state.sectionedSelects).toStrictEqual([
          {
            message: 'Add to',
            sections: [
              {
                options: [
                  { value: 'acceptance', label: 'Acceptance Criteria' },
                  { value: 'done', label: 'Definition of Done' },
                ],
              },
            ],
            back: { value: 'back', label: 'Back to the review' },
          },
        ]);
        expect(clack.state.prompts.map((prompt) => prompt.message)).not.toContain('Add to');
      });

      it('falls back to the check questions with no drafted text reaching createTask when the draft fails, warning about a retained call directory', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'failed' as const,
          failure: {
            cause: 'call-failed' as const,
            detail: 'ModelCallError (failed): synthetic failure',
          },
          retainedDirectories: ['/tmp/tevu-call-xyz'],
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          false,
          'manual',
          'Export produces a CSV',
          true,
          false,
          'manual',
          'README documents the button',
          true,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: draftFailureMessage(
            ['The OpenCode call failed.', 'ModelCallError (failed): synthetic failure'],
            true,
          ),
        });
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: "Couldn't remove a temporary directory.\n/tmp/tevu-call-xyz",
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'Export produces a CSV', manual: true },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'README documents the button', manual: true },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it.each(DRAFT_FAILURE_CASES)(
        'prints the cause of $name and continues with the check questions',
        async ({ failure, lines, retryable }) => {
          const operations = createOperations({
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
          });
          scriptAnswers(
            ...READY_ANSWERS,
            ...(retryable ? [false] : []),
            ...taskInterviewAnswers('repo-1').slice(9),
            true,
          );

          const { code } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(0);
          const warnings = clack.state.logs.filter((log) => log.kind === 'warn');
          expect(warnings).toEqual([
            { kind: 'warn', message: draftFailureMessage(lines, retryable) },
          ]);
          const messages = clack.state.prompts.map((prompt) => prompt.message);
          expect(messages.slice(messages.indexOf('Check type'))).toContain(
            'Add another Definition of Done check?',
          );
          expect(requireCreateTaskCall(operations).task.checks.acceptance).toEqual([
            { id: 'acceptance-1', description: 'Export produces a CSV', manual: true },
          ]);
          expect(clack.state.answers).toEqual([]);
        },
      );

      describe('the criteria effort of a drafted outcome', () => {
        function draftsWith(effort: EffortCheck, retainedDirectories: string[] = []) {
          return createOperations({
            loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
            resolveReference: vi.fn(async () => ({
              ok: true as const,
              value: buildResolvedCommitReference(),
            })),
            draftCriteria: vi.fn(async () => ({
              status: 'drafted' as const,
              draft: { acceptance: ['a'], done: ['d'] },
              effort,
              retainedDirectories,
            })),
          });
        }

        function effortWarnings() {
          return clack.state.logs.filter(
            (log) => log.kind === 'warn' && log.message.startsWith('Criteria effort'),
          );
        }

        it.each([
          { status: 'unverified' as const, reason: 'no variant data was reported' },
          { status: 'unsupported' as const, reason: 'a criteria call would use defaults' },
        ])('warns once with the $status status and its reason', async (check) => {
          const operations = draftsWith(check);
          scriptAnswers(...READY_ANSWERS, clack.CANCEL, true);

          await runCli(['task', 'add'], { operations });

          expect(effortWarnings()).toEqual([
            {
              kind: 'warn',
              message: `Criteria effort "high" is ${check.status}.\n${check.reason}`,
            },
          ]);
        });

        it('prints no effort warning for a verified effort', async () => {
          const operations = draftsWith({ status: 'verified' });
          scriptAnswers(...READY_ANSWERS, clack.CANCEL, true);

          await runCli(['task', 'add'], { operations });

          expect(effortWarnings()).toEqual([]);
        });

        it('prints one removal warning per retained directory, in the order the outcome lists them', async () => {
          const operations = draftsWith({ status: 'verified' }, [
            '/tmp/listing-dir',
            '/tmp/call-dir',
          ]);
          scriptAnswers(...READY_ANSWERS, clack.CANCEL, true);

          await runCli(['task', 'add'], { operations });

          expect(
            clack.state.logs.filter(
              (log) => log.kind === 'warn' && log.message.startsWith("Couldn't remove"),
            ),
          ).toEqual([
            {
              kind: 'warn',
              message: "Couldn't remove a temporary directory.\n/tmp/listing-dir",
            },
            { kind: 'warn', message: "Couldn't remove a temporary directory.\n/tmp/call-dir" },
          ]);
        });

        it('prints the retained directories of a failed draft before its cause', async () => {
          const operations = createOperations({
            loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
            resolveReference: vi.fn(async () => ({
              ok: true as const,
              value: buildResolvedCommitReference(),
            })),
            draftCriteria: vi.fn(async () => ({
              status: 'failed' as const,
              failure: {
                cause: 'effort-unsupported' as const,
                model: 'openai/criteria-model',
                effort: 'hihg',
                variants: ['high', 'low'],
              },
              retainedDirectories: ['/tmp/listing-dir'],
            })),
          });
          scriptAnswers(...READY_ANSWERS, ...taskInterviewAnswers('repo-1').slice(9), true);

          await runCli(['task', 'add'], { operations });

          const warnings = clack.state.logs.filter((log) => log.kind === 'warn');
          expect(warnings.map((warning) => warning.message.split('\n')[0])).toEqual([
            "Couldn't remove a temporary directory.",
            "Couldn't draft criteria.",
          ]);
        });
      });

      describe('the retained directories of a draft that ends the wizard', () => {
        const DIRECTORIES = ['/tmp/listing-dir', '/tmp/call-dir'];
        const REMOVAL_WARNINGS = DIRECTORIES.map((directory) => ({
          kind: 'warn',
          message: `Couldn't remove a temporary directory.\n${directory}`,
        }));

        function draftedWith(retainedDirectories: string[]) {
          return {
            status: 'drafted' as const,
            effort: { status: 'verified' as const },
            draft: { acceptance: ['a'], done: ['d'] },
            retainedDirectories,
          };
        }

        it('prints one warning per directory, in order, before the cancel line when the draft is cancelled', async () => {
          const operations = criteriaOperations({
            draftCriteria: vi.fn(async () => ({
              status: 'cancelled' as const,
              retainedDirectories: DIRECTORIES,
            })),
          });
          scriptAnswers(...READY_ANSWERS);

          const { code, err } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(removalWarnings()).toEqual(REMOVAL_WARNINGS);
          expect(eventsAfterWait('Drafting criteria')).toEqual(['log:warn', 'log:warn', 'cancel']);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expectNoWrites(operations);
        });

        it('prints one warning per directory, in order, before the cancel line when the signal aborts during the wait', async () => {
          const controller = new AbortController();
          const operations = criteriaOperations({
            draftCriteria: vi.fn(async () => {
              controller.abort();
              return draftedWith(DIRECTORIES);
            }),
          });
          scriptAnswers(...READY_ANSWERS);

          const { code, err } = await runCli(['task', 'add'], {
            operations,
            cancellation: controller.signal,
          });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(removalWarnings()).toEqual(REMOVAL_WARNINGS);
          expect(eventsAfterWait('Drafting criteria')).toEqual(['log:warn', 'log:warn', 'cancel']);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expectNoWrites(operations);
        });

        it('prints one warning per directory, in order, after the exit question and before the cancel line when it is answered Yes', async () => {
          const waitInterrupt = createWaitInterrupt();
          const operations = criteriaOperations({
            draftCriteria: vi.fn(async () => {
              waitInterrupt.take();
              return draftedWith(DIRECTORIES);
            }),
          });
          scriptAnswers(...READY_ANSWERS, true);

          const { code, err } = await runCli(['task', 'add'], { operations, waitInterrupt });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(removalWarnings()).toEqual(REMOVAL_WARNINGS);
          expect(eventsAfterWait('Drafting criteria')).toEqual([
            `prompt:${EXIT_QUESTION_WITH_DRAFT}`,
            'log:warn',
            'log:warn',
            'cancel',
          ]);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expectNoWrites(operations);
        });
      });

      it('names the configuration path exactly as the wizard received it when the model is unavailable', async () => {
        const operations = createOperations({
          locateConfig: vi.fn(async () => ({ ok: true as const, value: '/work/bench/tevu.yaml' })),
          loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria: vi.fn(async () => ({
            status: 'failed' as const,
            failure: { cause: 'model-unavailable' as const, model: 'acme/model-a' },
            retainedDirectories: [],
          })),
        });
        scriptAnswers(...READY_ANSWERS, clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: draftFailureMessage([
            "OpenCode can't find acme/model-a in tevu's environment.",
            'Add its provider to agents.opencode.providers in /work/bench/tevu.yaml.',
          ]),
        });
      });

      it('discards the draft for the by-hand fallback when the operator chooses it in the review (E11)', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          effort: { status: 'verified' as const },
          draft: { acceptance: ['Drafted item never saved.'], done: ['Also never saved.'] },
          retainedDirectories: [],
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'by-hand',
          'manual',
          'Export produces a CSV',
          true,
          false,
          'manual',
          'README documents the button',
          true,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'Export produces a CSV', manual: true },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'README documents the button', manual: true },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('exits 130 without calling createTask when the operator cancels at the draft review (P3)', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          effort: { status: 'verified' as const },
          draft: { acceptance: ['a'], done: ['d'] },
          retainedDirectories: [],
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(...READY_ANSWERS, clack.CANCEL);

        const { code, err } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(err).toEqual([]);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(operations.createTask).not.toHaveBeenCalled();
      });

      it('blocks accept while an item names the reference commit, then accepts once the item is removed and replaced (P6)', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          effort: { status: 'verified' as const },
          draft: {
            acceptance: [`This touches commit ${REFERENCE_HASH.slice(0, 7)} directly.`],
            done: ['The change is documented for users.'],
          },
          retainedDirectories: [],
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'accept',
          'remove',
          'acceptance:0',
          'add',
          'acceptance',
          'The export button appears on the page.',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: 'Cannot accept yet: 1 item names the reference solution; edit or remove it.',
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'The export button appears on the page.' },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('edits an item in place through the review', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          effort: { status: 'verified' as const },
          draft: { acceptance: ['Original wording.'], done: ['The change is documented.'] },
          retainedDirectories: [],
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'edit',
          'acceptance:0',
          'Edited wording that is clearer.',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'Edited wording that is clearer.' },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('rejects an edited item that names the reference solution, then accepts the corrected text (R9)', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          effort: { status: 'verified' as const },
          draft: { acceptance: ['Original wording.'], done: ['The change is documented.'] },
          retainedDirectories: [],
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'edit',
          'acceptance:0',
          { invalid: `This touches commit ${REFERENCE_HASH.slice(0, 7)} directly.` },
          'Corrected wording without the identity.',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.rejections).toContainEqual({
          kind: 'text',
          message: 'Item',
          reason: `the item names reference commit ${REFERENCE_HASH.slice(0, 7)}; tevu validate rejects a task whose agent prompt contains it`,
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'Corrected wording without the identity.' },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('blocks accept with a plural hint when more than one item names the reference solution', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          effort: { status: 'verified' as const },
          draft: {
            acceptance: [
              `First item touches commit ${REFERENCE_HASH.slice(0, 7)}.`,
              `Second item touches commit ${REFERENCE_HASH.slice(0, 7)}.`,
            ],
            done: ['Clean done item.'],
          },
          retainedDirectories: [],
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'accept',
          'edit',
          'acceptance:0',
          'First item rewritten.',
          'edit',
          'acceptance:1',
          'Second item rewritten.',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: 'Cannot accept yet: 2 items name the reference solution; edit or remove them.',
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'First item rewritten.' },
          { id: 'acceptance-2', description: 'Second item rewritten.' },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('blocks accept once a list empties, and "Back to the review" leaves both lists unchanged (E7)', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          effort: { status: 'verified' as const },
          draft: {
            acceptance: ['Original acceptance item.'],
            done: ['The change is documented.'],
          },
          retainedDirectories: [],
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'remove',
          'acceptance:0',
          'accept',
          'add',
          'back',
          'edit',
          'back',
          'add',
          'acceptance',
          'Replacement acceptance item.',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: 'Cannot accept yet: the acceptance criteria need at least one item.',
        });
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'Replacement acceptance item.' },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'The change is documented.' },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('numbers checks added through the follow-on questions after the drafted checks', async () => {
        const config = buildCriteriaConfig();
        const draftCriteria = vi.fn(async () => ({
          status: 'drafted' as const,
          effort: { status: 'verified' as const },
          draft: {
            acceptance: ['The export button appears on the table view.'],
            done: ['The change is documented for users.'],
          },
          retainedDirectories: [],
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
          resolveReference: vi.fn(async () => ({
            ok: true as const,
            value: buildResolvedCommitReference(),
          })),
          draftCriteria,
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'accept',
          true,
          'command',
          'The test suite passes',
          true,
          'npm test',
          '',
          '',
          '',
          false,
          true,
          'manual',
          'Manually verified',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.rejections).toEqual([]);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'The export button appears on the table view.' },
          { id: 'acceptance-2', description: 'The test suite passes', run: 'npm test' },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'The change is documented for users.' },
          { id: 'done-2', description: 'Manually verified', manual: true, required: false },
        ]);
        const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
        expect(reviewNote?.message).toContain('acceptance-1');
        expect(reviewNote?.message).toContain('acceptance-2');
        expect(reviewNote?.message).toContain('done-1');
        expect(reviewNote?.message).toContain('done-2');
        expect(clack.state.answers).toEqual([]);
      });

      it('lets an empty drafted Definition of Done list through Accept and asks for one required check', async () => {
        const operations = operationsDrafting({ acceptance: ['A1'], done: [] });
        scriptAnswers(
          ...READY_ANSWERS,
          'accept',
          false,
          'manual',
          'README documents the button',
          true,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(draftNotes()[0]?.split('\n').at(-1)).toBe('  (none)');
        const whatNext = clack.state.prompts.find((prompt) => prompt.message === 'What next?');
        expect(whatNext?.options?.[0]).toEqual({
          label: 'Accept',
          hint: undefined,
          disabled: false,
        });
        const messages = clack.state.prompts.map((prompt) => prompt.message);
        expect(messages[messages.lastIndexOf('Check type') - 1]).toBe(
          'Add another acceptance check?',
        );
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([{ id: 'acceptance-1', description: 'A1' }]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'README documents the button', manual: true },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('asks Item to edit and Item to remove through the sectioned select with headed sections and back to the review', async () => {
        const operations = operationsDrafting({ acceptance: ['A1', 'A2'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'edit', 'back', 'remove', 'back', clack.CANCEL);
        const expectedSections = [
          {
            heading: 'Acceptance Criteria',
            options: [
              { value: 'acceptance:0', label: 'A1' },
              { value: 'acceptance:1', label: 'A2' },
            ],
          },
          { heading: 'Definition of Done', options: [{ value: 'done:0', label: 'D1' }] },
        ];
        const expectedBack = { value: 'back', label: 'Back to the review' };

        await runCli(['task', 'add'], { operations });

        expect(clack.state.sectionedSelects).toEqual([
          { message: 'Item to edit', sections: expectedSections, back: expectedBack },
          { message: 'Item to remove', sections: expectedSections, back: expectedBack },
        ]);
        const messages = clack.state.prompts.map((prompt) => prompt.message);
        expect(messages).not.toContain('Item to edit');
        expect(messages).not.toContain('Item to remove');
        expect(promptCount('What next?')).toBe(3);
        expect(promptCount('Item')).toBe(0);
      });

      it('labels an item with its redacted text at Item to edit', async () => {
        const operations = operationsDrafting({ acceptance: ['uses SECRET-X'], done: [] });
        scriptAnswers(...READY_ANSWERS, 'edit', 'back', clack.CANCEL);

        await runCli(['task', 'add'], {
          operations,
          redact: (text) => text.replaceAll('SECRET-X', '[redacted]'),
        });

        expect(clack.state.sectionedSelects[0]?.sections[0]?.options).toEqual([
          { value: 'acceptance:0', label: 'uses [redacted]' },
        ]);
      });

      it('edits the second acceptance item at Item to edit and removes the first Definition of Done item at Item to remove', async () => {
        const operations = operationsDrafting({ acceptance: ['A1', 'A2'], done: ['D1'] });
        scriptAnswers(
          ...READY_ANSWERS,
          'edit',
          'acceptance:1',
          'A2 edited',
          'remove',
          'done:0',
          'accept',
          false,
          'manual',
          'README documents the button',
          true,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'A1' },
          { id: 'acceptance-2', description: 'A2 edited' },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'README documents the button', manual: true },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('cancels the wizard when the item select is cancelled with Ctrl-C at Item to edit', async () => {
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'edit', clack.CANCEL);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(operations.createTask).not.toHaveBeenCalled();
      });

      it('passes an empty options array for a list with no items to Item to edit', async () => {
        const operations = operationsDrafting({ acceptance: [], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'edit', 'back', clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        expect(clack.state.sectionedSelects[0]?.sections).toEqual([
          { heading: 'Acceptance Criteria', options: [] },
          { heading: 'Definition of Done', options: [{ value: 'done:0', label: 'D1' }] },
        ]);
      });

      it('Escape returns from the item select to the review', async () => {
        const operations = operationsDrafting({ acceptance: ['A1', 'A2'], done: ['D1'] });
        scriptAnswers(
          ...READY_ANSWERS,
          'edit',
          clack.ESCAPE,
          'remove',
          clack.ESCAPE,
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.sectionedSelects.map((call) => call.message)).toEqual([
          'Item to edit',
          'Item to remove',
        ]);
        expect(promptCount('What next?')).toBe(3);
        expect(promptCount('Item')).toBe(0);
        const notes = draftNotes();
        expect(notes).toHaveLength(3);
        expect(new Set(notes).size).toBe(1);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'A1' },
          { id: 'acceptance-2', description: 'A2' },
        ]);
        expect(task.checks.done).toEqual([{ id: 'done-1', description: 'D1' }]);
        expect(clack.state.answers).toEqual([]);
      });

      it('Ctrl-C at Item to remove cancels', async () => {
        const operations = operationsDrafting({ acceptance: ['A1', 'A2'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'edit', clack.ESCAPE, 'remove', clack.CANCEL);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(operations.createTask).not.toHaveBeenCalled();
      });

      it('lays out the Drafted criteria note with a blank line before Definition of Done', async () => {
        vi.stubEnv('FORCE_COLOR', '0');
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        expect(draftNotes()[0]?.split('\n')).toEqual([
          'Agents see every item. Keep outcomes, not details of the reference solution.',
          '',
          'Acceptance Criteria',
          '  1. A1',
          '',
          'Definition of Done',
          '  1. D1',
        ]);
      });

      it('wraps each heading of the Drafted criteria note in bold under color', async () => {
        vi.stubEnv('FORCE_COLOR', '1');
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        const lines = draftNotes()[0]?.split('\n') ?? [];
        expect(lines.map((line) => stripVTControlCharacters(line))).toEqual([
          'Agents see every item. Keep outcomes, not details of the reference solution.',
          '',
          'Acceptance Criteria',
          '  1. A1',
          '',
          'Definition of Done',
          '  1. D1',
        ]);
        expect(lines[2]).toBe('\u001b[1mAcceptance Criteria\u001b[22m');
        expect(lines[5]).toBe('\u001b[1mDefinition of Done\u001b[22m');
      });

      it('adds an item to each list through Add to', async () => {
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(
          ...READY_ANSWERS,
          'add',
          'done',
          'D2',
          'add',
          'acceptance',
          'A2',
          'add',
          'back',
          'accept',
          false,
          false,
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.sectionedSelects.map((call) => call.message)).toEqual([
          'Add to',
          'Add to',
          'Add to',
        ]);
        expect(promptCount('What next?')).toBe(4);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([
          { id: 'acceptance-1', description: 'A1' },
          { id: 'acceptance-2', description: 'A2' },
        ]);
        expect(task.checks.done).toEqual([
          { id: 'done-1', description: 'D1' },
          { id: 'done-2', description: 'D2' },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('Escape at Add to returns to the review', async () => {
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'add', clack.ESCAPE, 'accept', false, false, true);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.sectionedSelects.map((call) => call.message)).toEqual(['Add to']);
        expect(promptCount('What next?')).toBe(2);
        expect(promptCount('New acceptance criterion')).toBe(0);
        expect(promptCount('New Definition of Done item')).toBe(0);
        const notes = draftNotes();
        expect(notes).toHaveLength(2);
        expect(new Set(notes).size).toBe(1);
        const task = requireCreateTaskCall(operations).task;
        expect(task.checks.acceptance).toEqual([{ id: 'acceptance-1', description: 'A1' }]);
        expect(task.checks.done).toEqual([{ id: 'done-1', description: 'D1' }]);
        expect(clack.state.answers).toEqual([]);
      });

      it('Ctrl-C at Add to cancels', async () => {
        const operations = operationsDrafting({ acceptance: ['A1'], done: ['D1'] });
        scriptAnswers(...READY_ANSWERS, 'add', clack.CANCEL);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
        expect(operations.createTask).not.toHaveBeenCalled();
      });
    });
  });
});
