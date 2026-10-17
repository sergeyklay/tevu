// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  buildCliCapabilityReport,
  buildFinding,
  expectNoWrites,
  recordOperation,
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
  accessOutcome,
  definedProvider,
  EXIT_QUESTION_NEW_FILE,
  fullSetupAnswers,
  inspectingProviders,
  operationsWithModelCheck,
  renderAndParseBootstrap,
  requireCreateTaskCall,
  setupAnswers,
} from './__fixtures__/task-wizard.fixtures';
import { createWaitInterrupt } from './wait-interrupt';

import type { ProgramOperations } from './__fixtures__/program.fixtures';
import type { TaskWizardInput } from '@/application/create-task';

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

function requireAgentBlock(
  operations: ProgramOperations,
): NonNullable<TaskWizardInput['bootstrap']>['agents']['opencode'] {
  const agent = requireCreateTaskCall(operations).bootstrap?.agents.opencode;
  if (agent === undefined) {
    throw new Error('expected the captured createTask call to carry an agent block');
  }
  return agent;
}

describe('tevu CLI', () => {
  registerCliTestHooks();

  describe('task add', () => {
    describe('agent command probe', () => {
      it.each([
        {
          name: 'a missing prerequisite',
          error: {
            kind: 'PrerequisiteError' as const,
            tool: 'nope',
            expected: 'an executable command',
            actual: 'not found',
          },
          detail: 'expected an executable command, actual not found',
        },
        {
          name: 'a protocol failure',
          error: {
            kind: 'AgentProtocolError' as const,
            agent: 'opencode',
            context: { phase: 'probe' as const },
            reason: '--version printed no version',
          },
          detail: '--version printed no version',
        },
      ])(
        'prints the failure of $name and asks again with the failed command filled in',
        async ({ error, detail }) => {
          const probeAgent = vi
            .fn<ProgramOperations['probeAgent']>()
            .mockResolvedValueOnce({ ok: false, error })
            .mockResolvedValue({ ok: true, value: buildCliCapabilityReport() });
          const operations = operationsWithModelCheck({ probeAgent });
          scriptAnswers(...setupAnswers({ command: ['nope', 'opencode'] }), clack.CANCEL);

          await runCli(['task', 'add'], { operations });

          expect(probeAgent.mock.calls).toEqual([
            ['tevu.yaml', 'nope'],
            ['tevu.yaml', 'opencode'],
          ]);
          expect(clack.state.logs).toContainEqual({
            kind: 'warn',
            message: `Can't run nope.\n${detail}\nFix the command below. Press Enter to retry, or Ctrl-C to cancel.`,
          });
          const asked = clack.state.prompts.filter((prompt) => prompt.message === 'Agent command');
          expect(asked.map((prompt) => prompt.initialValue)).toEqual([undefined, 'nope']);
          expect(clack.state.spinners.map((spinner) => spinner.label)).toContain('Checking nope');
          expect(clack.state.spinners.map((spinner) => spinner.label)).toContain(
            'Checking opencode',
          );
        },
      );

      it('stops asking once the probe passes and writes the command as typed', async () => {
        const operations = operationsWithModelCheck();
        scriptAnswers(...fullSetupAnswers({ command: ['./bin/opencode'] }));

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(vi.mocked(operations.probeAgent)).toHaveBeenCalledExactlyOnceWith(
          'tevu.yaml',
          './bin/opencode',
        );
        expect(requireAgentBlock(operations).command).toBe('./bin/opencode');
        expect(clack.state.answers).toEqual([]);
      });
    });
    describe('provider copying and the API key variable question', () => {
      it('copies a provider whose definition names a key variable without asking for one', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({
            acme: definedProvider({ keyVariables: ['ACME_KEY'], apiKey: 'reference' }),
          }),
        });
        scriptAnswers(
          ...fullSetupAnswers({ firstModel: ['acme/model-a'], secondModel: ['acme/model-b'] }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.prompts.map((prompt) => prompt.message)).not.toContain(
          'API key variable for acme',
        );
        expect(requireAgentBlock(operations)).toEqual({
          command: 'opencode',
          secrets: ['ACME_KEY'],
          env: [],
          providers: [{ id: 'acme' }],
        });
        expect(vi.mocked(operations.checkModelAccess)).toHaveBeenNthCalledWith(
          1,
          'tevu.yaml',
          { command: 'opencode', secrets: ['ACME_KEY'], env: [], providers: [{ id: 'acme' }] },
          'acme/model-a',
        );
        expect(clack.state.answers).toEqual([]);
      });

      it('asks once for a definition with only other variables and remembers an empty answer for the next model', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: recordOperation(
            'inspectModelProvider',
            inspectingProviders({ acme: definedProvider({ otherVariables: ['ACME_BASE'] }) }),
          ),
          checkModelAccess: recordOperation('checkModelAccess', async () =>
            accessOutcome('listed'),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['acme/model-a', ''],
            secondModel: ['acme/model-b'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        const asked = clack.state.prompts.filter(
          (prompt) => prompt.message === 'API key variable for acme',
        );
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({ kind: 'text', placeholder: 'none', defaultValue: '' });
        expect(requireAgentBlock(operations)).toEqual({
          command: 'opencode',
          secrets: ['ACME_BASE'],
          env: [],
          providers: [{ id: 'acme' }],
        });
        const { timeline } = clack.state;
        const keyPrompt = timeline.indexOf('prompt:API key variable for acme');
        expect(keyPrompt).toBeGreaterThan(timeline.indexOf('operation:inspectModelProvider:end'));
        expect(keyPrompt).toBeLessThan(timeline.indexOf('operation:checkModelAccess:start'));
        expect(clack.state.answers).toEqual([]);
      });

      it('sets api_key and declares its name when the answer names a variable', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({
            acme: definedProvider({ otherVariables: ['ACME_BASE'] }),
          }),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['acme/model-a', 'ACME_KEY'],
            secondModel: ['acme/model-b'],
          }),
        );

        await runCli(['task', 'add'], { operations });

        expect(requireAgentBlock(operations)).toEqual({
          command: 'opencode',
          secrets: ['ACME_BASE', 'ACME_KEY'],
          env: [],
          providers: [{ id: 'acme', api_key: 'ACME_KEY' }],
        });
        expect(vi.mocked(operations.checkModelAccess)).toHaveBeenNthCalledWith(
          1,
          'tevu.yaml',
          {
            command: 'opencode',
            secrets: ['ACME_BASE', 'ACME_KEY'],
            env: [],
            providers: [{ id: 'acme', api_key: 'ACME_KEY' }],
          },
          'acme/model-a',
        );
      });

      it.each([
        {
          name: 'a literal apiKey and no key variable',
          definition: definedProvider({ apiKey: 'value' }),
        },
        {
          name: 'a literal apiKey beside a credential header variable',
          definition: definedProvider({ keyVariables: ['ACME_HEADER_KEY'], apiKey: 'value' }),
        },
      ])('asks for the variable before checking the model for $name', async ({ definition }) => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({ acme: definition }),
          checkModelAccess: recordOperation('checkModelAccess', async () =>
            accessOutcome('listed'),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['acme/model-a', 'ACME_KEY'],
            secondModel: ['acme/model-b'],
          }),
        );

        await runCli(['task', 'add'], { operations });

        const { timeline } = clack.state;
        expect(timeline.indexOf('prompt:API key variable for acme')).toBeLessThan(
          timeline.indexOf('operation:checkModelAccess:start'),
        );
        expect(requireAgentBlock(operations).providers).toEqual([
          { id: 'acme', api_key: 'ACME_KEY' },
        ]);
      });

      it.each([
        {
          name: 'a fixed name',
          answer: 'PATH',
          reason:
            'PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract',
        },
        {
          name: 'a non-secret variable',
          answer: 'PLAIN_ONE',
          reason: '"PLAIN_ONE" is already configured',
        },
        {
          name: 'a Jira credential variable',
          answer: 'JIRA_TOKEN',
          reason: 'Jira credential variables must not also be passed to the agent',
        },
        {
          name: 'a variable not set in this terminal',
          answer: 'UNSET_KEY',
          reason: `"UNSET_KEY" isn't set in this terminal`,
        },
      ])('rejects $name as the key variable and asks again', async ({ answer, reason }) => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({ acme: definedProvider() }),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            env: 'PLAIN_ONE',
            jira: [true, 'https://example.atlassian.net', 'JIRA_EMAIL', 'JIRA_TOKEN'],
            firstModel: ['acme/model-a', { invalid: answer }, 'ACME_KEY'],
            secondModel: ['acme/model-b'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.rejections).toEqual([
          { kind: 'text', message: 'API key variable for acme', reason },
        ]);
        expect(requireAgentBlock(operations).providers).toEqual([
          { id: 'acme', api_key: 'ACME_KEY' },
        ]);
        expect(clack.state.answers).toEqual([]);
      });
    });
    describe('model check retries', () => {
      it('prints the not-listed message, asks the same question with the previous answer, and drops what the refused answer added', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({
            other: definedProvider({ keyVariables: ['OTHER_KEY'], apiKey: 'reference' }),
            acme: definedProvider({ keyVariables: ['ACME_KEY'], apiKey: 'reference' }),
          }),
          checkModelAccess: vi.fn(async (_configPath, _agent, model) =>
            accessOutcome(model === 'other/model-x' ? 'not-listed' : 'listed'),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['other/model-x', 'acme/model-a'],
            secondModel: ['acme/model-b'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message:
            "OpenCode can't find other/model-x.\nUpdate your OpenCode settings or edit the model below. Press Enter to retry, or Ctrl-C to cancel.",
        });
        const asked = clack.state.prompts.filter((prompt) => prompt.message === 'Model');
        expect(asked.map((prompt) => prompt.initialValue)).toEqual([
          undefined,
          'other/model-x',
          undefined,
        ]);
        expect(requireAgentBlock(operations)).toEqual({
          command: 'opencode',
          secrets: ['ACME_KEY'],
          env: [],
          providers: [{ id: 'acme' }],
        });
        expect(requireCreateTaskCall(operations).bootstrap?.models[0]?.model).toBe('acme/model-a');
        expect(clack.state.answers).toEqual([]);
      });

      it('asks for a variable after a not-listed result for an undefined provider and checks again with the answer', async () => {
        const checkModelAccess = vi.fn<ProgramOperations['checkModelAccess']>(
          async (_configPath, agent) =>
            accessOutcome(agent.secrets.includes('BUILTIN_KEY') ? 'listed' : 'not-listed'),
        );
        const operations = operationsWithModelCheck({ checkModelAccess });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['builtin/model-z', 'BUILTIN_KEY'],
            secondModel: ['builtin/model-y'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(
          clack.state.prompts.filter((prompt) => prompt.message === 'API key variable for builtin'),
        ).toHaveLength(1);
        expect(checkModelAccess.mock.calls.map(([, , model]) => model)).toEqual([
          'builtin/model-z',
          'builtin/model-z',
          'builtin/model-y',
        ]);
        expect(requireAgentBlock(operations)).toEqual({
          command: 'opencode',
          secrets: ['BUILTIN_KEY'],
          env: [],
        });
        expect(clack.state.answers).toEqual([]);
      });

      it('refuses the model and asks it again when the variable answer for an undefined provider is empty', async () => {
        const operations = operationsWithModelCheck({
          checkModelAccess: vi.fn(async (_configPath, _agent, model) =>
            accessOutcome(model === 'builtin/model-z' ? 'not-listed' : 'listed'),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['builtin/model-z', '', 'builtin/model-y'],
            secondModel: ['builtin/model-x'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message:
            "OpenCode can't find builtin/model-z.\nUpdate your OpenCode settings or edit the model below. Press Enter to retry, or Ctrl-C to cancel.",
        });
        const asked = clack.state.prompts.filter((prompt) => prompt.message === 'Model');
        expect(asked[1]?.initialValue).toBe('builtin/model-z');
        expect(requireCreateTaskCall(operations).bootstrap?.models[0]?.model).toBe(
          'builtin/model-y',
        );
        expect(clack.state.answers).toEqual([]);
      });

      it('keeps a not-listed model of an undefined provider while a declared variable is unset, without asking for a key variable', async () => {
        const operations = operationsWithModelCheck({
          checkModelAccess: vi.fn(async () =>
            accessOutcome('not-listed', { unsetVariables: ['BUILTIN_KEY'] }),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            secrets: 'BUILTIN_KEY',
            firstModel: ['builtin/model-z'],
            secondModel: ['builtin/model-y'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        const unchecked = clack.state.logs.filter((log) => log.kind === 'warn');
        expect(unchecked.map((log) => log.message)).toEqual([
          "builtin/model-z can't be checked while BUILTIN_KEY isn't set in this terminal, so it is kept as entered.",
          "builtin/model-y can't be checked while BUILTIN_KEY isn't set in this terminal, so it is kept as entered.",
        ]);
        expect(clack.state.prompts.map((prompt) => prompt.message)).not.toContain(
          'API key variable for builtin',
        );
        expect(
          requireCreateTaskCall(operations).bootstrap?.models.map((model) => model.model),
        ).toEqual(['builtin/model-z', 'builtin/model-y']);
        expect(requireAgentBlock(operations).secrets).toEqual(['BUILTIN_KEY']);
        expect(clack.state.answers).toEqual([]);
      });

      it('declares the variable named after a not-listed result and keeps the model unchecked when that variable is unset', async () => {
        const operations = operationsWithModelCheck({
          checkModelAccess: vi.fn(async (_configPath, agent) =>
            accessOutcome('not-listed', {
              unsetVariables: agent.secrets.includes('BUILTIN_KEY') ? ['BUILTIN_KEY'] : [],
            }),
          ),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['builtin/model-z', 'BUILTIN_KEY'],
            secondModel: ['builtin/model-y'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(requireAgentBlock(operations).secrets).toEqual(['BUILTIN_KEY']);
        expect(
          requireCreateTaskCall(operations).bootstrap?.models.map((model) => model.model),
        ).toEqual(['builtin/model-z', 'builtin/model-y']);
        expect(clack.state.answers).toEqual([]);
      });

      it('prints each unset variable once across the models of one run', async () => {
        const operations = operationsWithModelCheck({
          checkModelAccess: vi.fn(async () =>
            accessOutcome('listed', { unsetVariables: ['ACME_KEY', 'ACME_BASE'] }),
          ),
        });
        scriptAnswers(...fullSetupAnswers({ secrets: 'ACME_KEY ACME_BASE' }));

        await runCli(['task', 'add'], { operations });

        expect(
          clack.state.logs.filter((log) => log.kind === 'warn').map((log) => log.message),
        ).toEqual([
          "ACME_KEY isn't set in this terminal. Runs will need it.",
          "ACME_BASE isn't set in this terminal. Runs will need it.",
        ]);
      });

      it('counts a name the unchecked line printed as printed', async () => {
        const checkModelAccess = vi
          .fn<ProgramOperations['checkModelAccess']>()
          .mockResolvedValueOnce(accessOutcome('not-listed', { unsetVariables: ['BUILTIN_KEY'] }))
          .mockResolvedValue(accessOutcome('listed', { unsetVariables: ['BUILTIN_KEY'] }));
        const operations = operationsWithModelCheck({ checkModelAccess });
        scriptAnswers(...fullSetupAnswers({ secrets: 'BUILTIN_KEY' }));

        await runCli(['task', 'add'], { operations });

        expect(clack.state.logs.filter((log) => log.kind === 'warn')).toHaveLength(1);
      });

      it('warns about a call directory it could not remove after a model check', async () => {
        const operations = operationsWithModelCheck({
          checkModelAccess: vi.fn(async () =>
            accessOutcome('listed', { retainedDirectory: '/tmp/tevu-call-xyz' }),
          ),
        });
        scriptAnswers(...fullSetupAnswers({ secondModel: ['provider/model-b'] }));

        await runCli(['task', 'add'], { operations });

        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: "Couldn't remove a temporary directory.\n/tmp/tevu-call-xyz",
        });
      });

      describe('the retained directory of a model check', () => {
        const DIRECTORY = '/tmp/tevu-call-xyz';
        const REMOVAL_WARNING = {
          kind: 'warn',
          message: `Couldn't remove a temporary directory.\n${DIRECTORY}`,
        };

        it('prints one warning before the listing failure when the listing failed', async () => {
          const operations = operationsWithModelCheck({
            checkModelAccess: vi.fn<ProgramOperations['checkModelAccess']>(async () => ({
              status: 'listing-failed',
              detail: '"opencode models" exits with code 3',
              retainedDirectory: DIRECTORY,
            })),
          });
          scriptAnswers(...setupAnswers({ firstModel: ['acme/model-a', clack.CANCEL, true] }));

          await runCli(['task', 'add'], { operations });

          const warnings = clack.state.logs.filter((log) => log.kind === 'warn');
          expect(warnings.map((warning) => warning.message.split('\n')[0])).toEqual([
            "Couldn't remove a temporary directory.",
            "Can't list OpenCode models.",
          ]);
          expect(removalWarnings()).toEqual([REMOVAL_WARNING]);
        });

        it('prints one warning before the cancel line when the check is cancelled', async () => {
          const operations = operationsWithModelCheck({
            checkModelAccess: vi.fn<ProgramOperations['checkModelAccess']>(async () => ({
              status: 'cancelled',
              retainedDirectory: DIRECTORY,
            })),
          });
          scriptAnswers(...fullSetupAnswers());

          const { code, err } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(removalWarnings()).toEqual([REMOVAL_WARNING]);
          expect(eventsAfterWait('Checking model')).toEqual(['log:warn', 'cancel']);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expectNoWrites(operations);
        });

        it('prints one warning before the cancel line when the signal aborts during the wait', async () => {
          const controller = new AbortController();
          const operations = operationsWithModelCheck({
            checkModelAccess: vi.fn<ProgramOperations['checkModelAccess']>(async () => {
              controller.abort();
              return accessOutcome('listed', { retainedDirectory: DIRECTORY });
            }),
          });
          scriptAnswers(...fullSetupAnswers());

          const { code, err } = await runCli(['task', 'add'], {
            operations,
            cancellation: controller.signal,
          });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(removalWarnings()).toEqual([REMOVAL_WARNING]);
          expect(eventsAfterWait('Checking model')).toEqual(['log:warn', 'cancel']);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expectNoWrites(operations);
        });

        it('prints one warning after the exit question and before the cancel line when it is answered Yes', async () => {
          const waitInterrupt = createWaitInterrupt();
          const operations = operationsWithModelCheck({
            checkModelAccess: vi.fn<ProgramOperations['checkModelAccess']>(async () => {
              waitInterrupt.take();
              return accessOutcome('listed', { retainedDirectory: DIRECTORY });
            }),
          });
          scriptAnswers(...setupAnswers({ firstModel: ['provider/model-a', true] }));

          const { code, err } = await runCli(['task', 'add'], { operations, waitInterrupt });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(removalWarnings()).toEqual([REMOVAL_WARNING]);
          expect(eventsAfterWait('Checking model')).toEqual([
            `prompt:${EXIT_QUESTION_NEW_FILE}`,
            'log:warn',
            'cancel',
          ]);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expectNoWrites(operations);
        });
      });

      it.each(['first', 'second'] as const)(
        'ends with exit 130, one cancel line, and no write when the check is cancelled on the %s model',
        async (position) => {
          const checkModelAccess = vi
            .fn<ProgramOperations['checkModelAccess']>()
            .mockResolvedValue(accessOutcome('listed'));
          if (position === 'first') {
            checkModelAccess.mockResolvedValueOnce({
              status: 'cancelled',
              retainedDirectory: null,
            });
          } else {
            checkModelAccess
              .mockResolvedValueOnce(accessOutcome('listed'))
              .mockResolvedValueOnce({ status: 'cancelled', retainedDirectory: null });
          }
          const operations = operationsWithModelCheck({ checkModelAccess });
          scriptAnswers(...fullSetupAnswers());

          const { code, err } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expectNoWrites(operations);
        },
      );

      it.each([
        {
          name: 'an inspection failure',
          build: (): Partial<ProgramOperations> => ({
            inspectModelProvider: vi
              .fn<ProgramOperations['inspectModelProvider']>()
              .mockResolvedValueOnce({
                ok: false,
                error: {
                  kind: 'ConfigValidationError',
                  findings: [buildFinding({ message: 'cannot read "/op/opencode.json": EACCES' })],
                },
              })
              .mockResolvedValue({
                ok: true,
                value: { provider: 'provider', definition: { defined: false } },
              }),
          }),
        },
        {
          name: 'a rejected provider',
          build: (): Partial<ProgramOperations> => ({
            checkModelAccess: vi
              .fn<ProgramOperations['checkModelAccess']>()
              .mockResolvedValueOnce({
                status: 'provider-rejected',
                findings: [
                  buildFinding({ message: 'options.apiKey of provider "provider" is a literal' }),
                ],
              })
              .mockResolvedValue(accessOutcome('listed')),
          }),
        },
        {
          name: 'a failed listing',
          build: (): Partial<ProgramOperations> => ({
            checkModelAccess: vi
              .fn<ProgramOperations['checkModelAccess']>()
              .mockResolvedValueOnce({
                status: 'listing-failed',
                detail: '"opencode models" exits with code 3',
                retainedDirectory: null,
              })
              .mockResolvedValue(accessOutcome('listed')),
          }),
        },
      ])(
        'asks the model question again with the previous answer after $name and accepts a later answer',
        async ({ build }) => {
          const operations = operationsWithModelCheck(build());
          scriptAnswers(
            ...fullSetupAnswers({ firstModel: ['provider/model-a', 'provider/model-c'] }),
          );

          const { code } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(0);
          const asked = clack.state.prompts.filter((prompt) => prompt.message === 'Model');
          expect(asked.slice(0, 2).map((prompt) => prompt.initialValue)).toEqual([
            undefined,
            'provider/model-a',
          ]);
          expect(requireCreateTaskCall(operations).bootstrap?.models[0]?.model).toBe(
            'provider/model-c',
          );
          expect(clack.state.answers).toEqual([]);
        },
      );
    });
    describe('written configuration and review of copied providers', () => {
      const ACME_DEFINITION = definedProvider({ otherVariables: ['ACME_BASE'] });

      it('renders and re-parses the bootstrap answers with the providers and the declared secrets', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({ acme: ACME_DEFINITION }),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            secrets: 'EXTRA_KEY',
            firstModel: ['acme/model-a', 'ACME_KEY'],
            secondModel: ['acme/model-b'],
          }),
        );

        await runCli(['task', 'add'], { operations });

        const parsed = renderAndParseBootstrap(requireCreateTaskCall(operations));
        expect(parsed.agents.opencode).toMatchObject({
          secrets: ['EXTRA_KEY', 'ACME_BASE', 'ACME_KEY'],
          providers: [{ id: 'acme', api_key: 'ACME_KEY' }],
        });
        expect(clack.state.answers).toEqual([]);
      });

      it('lists the copied providers and their key variables on the review line', async () => {
        const operations = operationsWithModelCheck({
          inspectModelProvider: inspectingProviders({
            acme: ACME_DEFINITION,
            other: definedProvider({ keyVariables: ['OTHER_KEY'], apiKey: 'reference' }),
          }),
        });
        scriptAnswers(
          ...fullSetupAnswers({
            firstModel: ['acme/model-a', 'ACME_KEY'],
            secondModel: ['other/model-b'],
          }),
        );

        await runCli(['task', 'add'], { operations });

        const review = clack.state.notes.find((note) => note.title === 'Review');
        expect(review?.message.split('\n')).toContain(
          '  agents.opencode.providers: acme (api_key ACME_KEY), other',
        );
      });

      it('shows none on the review line when no provider was copied', async () => {
        const operations = operationsWithModelCheck();
        scriptAnswers(...fullSetupAnswers());

        await runCli(['task', 'add'], { operations });

        const review = clack.state.notes.find((note) => note.title === 'Review');
        expect(review?.message.split('\n')).toContain('  agents.opencode.providers: (none)');
        expect(requireAgentBlock(operations)).not.toHaveProperty('providers');
      });
    });
  });
});
