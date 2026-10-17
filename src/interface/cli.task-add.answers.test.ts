// @vitest-environment node

import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { FAKE_AGENT_NAME } from '@/config/__fixtures__/config.fixtures';

import {
  buildCliConfig,
  buildCliJiraTrackerSettings,
  buildCliTaskInput,
  createOperations,
  registerCliTestHooks,
  runCli,
} from './__fixtures__/program.fixtures';
import { clack, scriptAnswers } from './__fixtures__/scripted-prompts.fixtures';
import {
  BOOTSTRAP_ANSWERS,
  criteriaOperations,
  definedProvider,
  fullSetupAnswers,
  inspectingProviders,
  operationsWithModelCheck,
  READY_ANSWERS,
  renderAndParseBootstrap,
  requireCreateTaskCall,
  setupAnswers,
  taskInterviewAnswers,
} from './__fixtures__/task-wizard.fixtures';

import type { ProgramOperations } from './__fixtures__/program.fixtures';
import type { TevuConfig } from '@/domain/config';

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

/** Answers the questions of one command check, each entry listing the answers its question consumes in order. */
function commandCheckAnswers(
  overrides: {
    command?: readonly unknown[];
    timeLimit?: readonly unknown[];
    variables?: readonly unknown[];
  } = {},
): unknown[] {
  return [
    'command',
    'The test suite passes',
    true,
    ...(overrides.command ?? ['npm test -- --run']),
    ...(overrides.timeLimit ?? ['']),
    '',
    ...(overrides.variables ?? ['']),
    false,
  ];
}

/** Answers a whole task interview around a scripted acceptance check, ending after the last check. */
function taskAnswersWithAcceptanceCheck(
  repositoryChoice: string,
  acceptanceCheck: readonly unknown[],
): unknown[] {
  return [
    'manual',
    repositoryChoice,
    '',
    'abc123',
    'Add an export button',
    'Export the current view as CSV.',
    'Implement CSV export for the current view.',
    'Repository is readable',
    false,
    ...acceptanceCheck,
    'manual',
    'README documents the button',
    true,
    false,
  ];
}

describe('tevu CLI', () => {
  registerCliTestHooks();

  describe('task add', () => {
    describe('derived identifiers', () => {
      const COMPLETE_INSPECTION = {
        depth: null,
        maxArrayLength: null,
        maxStringLength: null,
      } as const;

      /** Answers a new configuration's setup from the first question through `Add another model?`, with the given model entries. */
      function setupWithModels(...models: Array<[model: string, effort: string]>): unknown[] {
        return [
          ...BOOTSTRAP_ANSWERS.slice(0, 12),
          ...models.flat(),
          false,
          false,
          false,
          ...taskInterviewAnswers('alpha'),
          true,
        ];
      }

      it('normalizes a provider prefix and dots in a model entry ID', async () => {
        const operations = createOperations({ configExists: vi.fn(async () => false) });
        scriptAnswers(
          ...setupWithModels(['acme/vendor/model-5.6', 'high'], ['provider/model-b', 'low']),
        );

        await runCli(['task', 'add'], { operations });

        expect(
          requireCreateTaskCall(operations).bootstrap?.models.map((model) => model.id),
        ).toEqual(['model-5-6-high', 'model-b-low']);
        expect(clack.state.answers).toEqual([]);
      });

      it('suffixes a model entry ID that collides with an earlier one', async () => {
        const operations = createOperations({ configExists: vi.fn(async () => false) });
        scriptAnswers(
          ...setupWithModels(['acme/vendor/model-5.6', 'high'], ['other/model_5.6', 'high']),
        );

        await runCli(['task', 'add'], { operations });

        expect(
          requireCreateTaskCall(operations).bootstrap?.models.map((model) => model.id),
        ).toEqual(['model-5-6-high', 'model-5-6-high-2']);
        expect(clack.state.answers).toEqual([]);
      });

      it('uses the next free task number', async () => {
        const config = buildCliConfig({
          tasks: [buildCliTaskInput({ id: 'task-1' }), buildCliTaskInput({ id: 'task-3' })],
        });
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
        });
        scriptAnswers(...taskInterviewAnswers('repo-1'), true);

        await runCli(['task', 'add'], { operations });

        expect(requireCreateTaskCall(operations).task.id).toBe('task-2');
        expect(clack.state.answers).toEqual([]);
      });

      it('continues check numbering after drafted criteria', async () => {
        const operations = criteriaOperations({
          draftCriteria: vi.fn(async () => ({
            status: 'drafted' as const,
            effort: { status: 'verified' as const },
            draft: { acceptance: ['A1', 'A2'], done: ['D1'] },
            retainedDirectories: [],
          })),
        });
        scriptAnswers(
          ...READY_ANSWERS,
          'accept',
          true,
          'manual',
          'Added by hand',
          true,
          false,
          true,
          'manual',
          'Added by hand',
          true,
          false,
          true,
        );

        await runCli(['task', 'add'], { operations });

        const { checks } = requireCreateTaskCall(operations).task;
        expect(checks.acceptance.map((check) => check.id)).toEqual([
          'acceptance-1',
          'acceptance-2',
          'acceptance-3',
        ]);
        expect(checks.done.map((check) => check.id)).toEqual(['done-1', 'done-2']);
        expect(clack.state.answers).toEqual([]);
      });

      it('saves a 64-character derived ID that the real writer and parser accept', async () => {
        const operations = createOperations({ configExists: vi.fn(async () => false) });
        const longName = 'a'.repeat(70);
        scriptAnswers(
          ...setupWithModels([`acme/${longName}`, 'high'], ['provider/model-b', 'low']),
        );

        await runCli(['task', 'add'], { operations });

        const call = requireCreateTaskCall(operations);
        expect(call.bootstrap?.models[0]?.id).toBe('a'.repeat(64));
        expect(renderAndParseBootstrap(call).models[0]?.id).toBe('a'.repeat(64));
        expect(clack.state.answers).toEqual([]);
      });

      describe.each([
        {
          configuration: 'a new configuration',
          operations: () => createOperations({ configExists: vi.fn(async () => false) }),
          answers: () => fullSetupAnswers(),
        },
        {
          configuration: 'an existing configuration',
          operations: () => createOperations(),
          answers: () => [...taskInterviewAnswers('repo-1'), true],
        },
        {
          configuration: 'a repository added to an existing configuration',
          operations: () =>
            createOperations({
              ensureManagedCommits: vi.fn(async () => ({
                ok: true as const,
                value: { missing: [] },
              })),
            }),
          answers: () => [
            'manual',
            clack.pickLabel('Add a repository'),
            'github',
            'octo/app',
            ...taskInterviewAnswers('repo-1').slice(2),
            true,
          ],
        },
      ])('for $configuration', ({ operations, answers }) => {
        it('asks no question whose message holds the word ID', async () => {
          const ops = operations();
          scriptAnswers(...answers());

          const { code } = await runCli(['task', 'add'], { operations: ops });

          const questions = clack.state.prompts.map((prompt) => prompt.message);
          expect(code).toBe(0);
          expect(questions.filter((message) => /\bID\b/i.test(message))).toEqual([]);
          expect(clack.state.answers).toEqual([]);
        });
      });

      describe.each([
        {
          form: 'URL',
          originUrl: 'https://user:SENTINEL@host.example/owner/repo.git',
          repositoryId: 'owner-repo',
        },
        {
          form: 'scp-like',
          originUrl: 'user:SENTINEL@host.example:owner/repo.git',
          repositoryId: 'alpha',
        },
      ])('with a credential in an origin $form', ({ originUrl, repositoryId }) => {
        it('keeps a credential in an origin URL out of every output', async () => {
          const readLocalRepositoryNaming = vi.fn<ProgramOperations['readLocalRepositoryNaming']>(
            async () => ({ directoryName: 'alpha', originUrl }),
          );
          const operations = createOperations({
            configExists: vi.fn(async () => false),
            readLocalRepositoryNaming,
          });
          scriptAnswers(
            ...setupAnswers(),
            false,
            false,
            ...taskInterviewAnswers(repositoryId),
            true,
          );

          const { code, out, err } = await runCli(['task', 'add'], { operations });

          const everyCall = Object.values(operations).map((operation) =>
            vi.isMockFunction(operation) ? operation.mock.calls : [],
          );
          const call = requireCreateTaskCall(operations);
          expect(code).toBe(0);
          expect(readLocalRepositoryNaming).toHaveBeenCalledOnce();
          expect(call.bootstrap?.repositories[0]?.id).toBe(repositoryId);
          expect(inspect(clack.state, COMPLETE_INSPECTION)).not.toContain('SENTINEL');
          expect(inspect([out, err], COMPLETE_INSPECTION)).not.toContain('SENTINEL');
          expect(inspect(everyCall, COMPLETE_INSPECTION)).not.toContain('SENTINEL');
          expect(inspect(call, COMPLETE_INSPECTION)).not.toContain('SENTINEL');
          expect(clack.state.answers).toEqual([]);
        });
      });
    });

    describe('defaults and list answers', () => {
      const DEFAULTED_BOOTSTRAP_ANSWERS: unknown[] = [
        '',
        '',
        '',
        '',
        '',
        '',
        ...BOOTSTRAP_ANSWERS.slice(6),
      ];

      it('creates the documented run settings, agent command, and role efforts from empty answers', async () => {
        const operations = createOperations({ configExists: vi.fn(async () => false) });
        scriptAnswers(
          ...DEFAULTED_BOOTSTRAP_ANSWERS,
          true,
          'openai/grader-model',
          '',
          true,
          'openai/criteria-model',
          '',
          ...taskAnswersWithAcceptanceCheck('alpha', commandCheckAnswers()),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(requireCreateTaskCall(operations).bootstrap).toMatchObject({
          run: {
            output_dir: 'runs',
            concurrency: 2,
            timeout: '10m',
            stop_grace: '3s',
            check_timeout: '5m',
          },
          agents: { opencode: { command: 'opencode' } },
          roles: {
            grader: { model: 'openai/grader-model', effort: 'medium' },
            criteria: { model: 'openai/criteria-model', effort: 'high' },
          },
        });
        expect(clack.state.answers).toEqual([]);
      });

      it('shows every default as the placeholder of its prompt', async () => {
        const operations = createOperations({ configExists: vi.fn(async () => false) });
        scriptAnswers(
          ...DEFAULTED_BOOTSTRAP_ANSWERS,
          true,
          'openai/grader-model',
          '',
          true,
          'openai/criteria-model',
          '',
          ...taskAnswersWithAcceptanceCheck('alpha', commandCheckAnswers()),
          true,
        );

        await runCli(['task', 'add'], { operations });

        const defaulted = clack.state.prompts
          .filter((prompt) => prompt.kind === 'text' && prompt.defaultValue !== undefined)
          .map((prompt) => [prompt.message, prompt.defaultValue, prompt.placeholder]);
        expect(defaulted).toEqual([
          ['Output directory', 'runs', 'runs'],
          ['Concurrent cases', '2', '2'],
          ['Agent time limit', '10m', '10m'],
          ['Stop grace period', '3s', '3s'],
          ['Check time limit', '5m', '5m'],
          ['Agent command', 'opencode', 'opencode'],
          ['Secret variable names', '', 'none'],
          ['Non-secret variable names', '', 'none'],
          ['Grader effort', 'medium', 'medium'],
          ['Criteria effort', 'high', 'high'],
          ['Reference PR or commit', '', 'none'],
          ['Description', '', 'none'],
          ['Time limit', '', '5m'],
          ['Passing exit codes', '0', '0'],
          ['Check variables', '', 'none'],
          ['Description', '', 'none'],
        ]);
      });

      it('prints the step lines and asks for a second model when only one is entered', async () => {
        const operations = createOperations({ configExists: vi.fn(async () => false) });
        scriptAnswers(...BOOTSTRAP_ANSWERS, false, false, ...taskInterviewAnswers('alpha'), true);

        await runCli(['task', 'add'], { operations });

        const infoAndSteps = clack.state.logs.filter((log) => log.kind !== 'message');
        expect(infoAndSteps).toEqual([
          { kind: 'step', message: 'New configuration' },
          { kind: 'info', message: 'Add a second model to compare.' },
          { kind: 'step', message: 'New task' },
        ]);
      });

      it.each([
        { separator: ',', description: 'commas' },
        { separator: ' ', description: 'spaces' },
        { separator: ', ', description: 'commas and spaces' },
      ])(
        'reads the secret, non-secret, and check variable lists separated by $description',
        async ({ separator }) => {
          const operations = createOperations({ configExists: vi.fn(async () => false) });
          scriptAnswers(
            ...BOOTSTRAP_ANSWERS.slice(0, 6),
            ['SECRET_ONE', 'SECRET_TWO'].join(separator),
            ['PLAIN_ONE', 'PLAIN_TWO'].join(separator),
            ...BOOTSTRAP_ANSWERS.slice(8),
            false,
            false,
            ...taskAnswersWithAcceptanceCheck(
              'alpha',
              commandCheckAnswers({ variables: [['CHECK_ONE', 'CHECK_TWO'].join(separator)] }),
            ),
            true,
          );

          const { code } = await runCli(['task', 'add'], { operations });

          const call = requireCreateTaskCall(operations);
          expect(code).toBe(0);
          expect(call.bootstrap?.agents).toEqual({
            opencode: {
              command: 'opencode',
              secrets: ['SECRET_ONE', 'SECRET_TWO'],
              env: ['PLAIN_ONE', 'PLAIN_TWO'],
            },
          });
          expect(call.task.checks.acceptance[0]).toMatchObject({ env: ['CHECK_ONE', 'CHECK_TWO'] });
          expect(clack.state.answers).toEqual([]);
        },
      );

      it.each([
        {
          description: 'a name repeated inside one secret list',
          answers: [{ invalid: 'KEY_A KEY_A' }, 'KEY_A', ''],
          rejection: {
            message: 'Secret variable names',
            reason: '"KEY_A" is listed more than once',
          },
        },
        {
          description: 'a secret name repeated in the non-secret list',
          answers: ['SHARED_KEY', { invalid: 'SHARED_KEY' }, 'OTHER_VAR'],
          rejection: {
            message: 'Non-secret variable names',
            reason: '"SHARED_KEY" is already configured',
          },
        },
        {
          description: 'a secret name not set in this terminal',
          answers: [{ invalid: 'KEY_A UNSET_B' }, 'KEY_A', ''],
          rejection: {
            message: 'Secret variable names',
            reason: `"UNSET_B" isn't set in this terminal`,
          },
        },
        {
          description: 'a non-secret name not set in this terminal',
          answers: ['', { invalid: 'UNSET_PLAIN' }, 'PLAIN'],
          rejection: {
            message: 'Non-secret variable names',
            reason: `"UNSET_PLAIN" isn't set in this terminal`,
          },
        },
        {
          description: 'a name the isolation contract fixes',
          answers: [{ invalid: 'PATH' }, '', ''],
          rejection: {
            message: 'Secret variable names',
            reason:
              'PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract',
          },
        },
      ])('rejects $description', async ({ answers, rejection }) => {
        const operations = createOperations({ configExists: vi.fn(async () => false) });
        scriptAnswers(...BOOTSTRAP_ANSWERS.slice(0, 6), ...answers, clack.CANCEL);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(130);
        expect(clack.state.rejections).toEqual([{ kind: 'text', ...rejection }]);
      });

      it('shows the inherited check time limit as the placeholder and writes no timeout for an empty answer', async () => {
        const config = buildCliConfig({
          run: {
            output_dir: '/tmp/artifacts',
            concurrency: 2,
            timeout: '10m',
            stop_grace: '5s',
            check_timeout: '7m',
          },
        });
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
        });
        scriptAnswers(...taskAnswersWithAcceptanceCheck('repo-1', commandCheckAnswers()), true);

        await runCli(['task', 'add'], { operations });

        expect(clack.state.prompts.find((prompt) => prompt.message === 'Time limit')).toMatchObject(
          {
            placeholder: '7m',
          },
        );
        const check = requireCreateTaskCall(operations).task.checks.acceptance[0];
        expect(check).not.toHaveProperty('timeout');
        expect(clack.state.answers).toEqual([]);
      });

      it('writes a typed check time limit', async () => {
        const operations = createOperations();
        scriptAnswers(
          ...taskAnswersWithAcceptanceCheck('repo-1', commandCheckAnswers({ timeLimit: ['2m'] })),
          true,
        );

        await runCli(['task', 'add'], { operations });

        expect(requireCreateTaskCall(operations).task.checks.acceptance[0]).toMatchObject({
          timeout: '2m',
        });
        expect(clack.state.answers).toEqual([]);
      });

      it('requires a check time limit when the configuration has none to inherit', async () => {
        const operations = createOperations();
        scriptAnswers(
          ...taskAnswersWithAcceptanceCheck(
            'repo-1',
            commandCheckAnswers({ timeLimit: [{ invalid: '' }, '2m'] }),
          ),
          true,
        );

        await runCli(['task', 'add'], { operations });

        expect(clack.state.rejections).toEqual([
          { kind: 'text', message: 'Time limit', reason: expect.any(String) },
        ]);
        expect(clack.state.prompts.find((prompt) => prompt.message === 'Time limit')).toMatchObject(
          {
            placeholder: undefined,
          },
        );
        expect(requireCreateTaskCall(operations).task.checks.acceptance[0]).toMatchObject({
          timeout: '2m',
        });
        expect(clack.state.answers).toEqual([]);
      });
    });

    describe('prompt vocabulary', () => {
      async function runFullInterview(): Promise<void> {
        const operations = createOperations({
          configExists: vi.fn(async () => false),
          ensureManagedCommits: vi.fn(async () => ({ ok: true as const, value: { missing: [] } })),
        });
        scriptAnswers(
          ...BOOTSTRAP_ANSWERS.slice(0, 6),
          '',
          '',
          true,
          'https://jira.example.com',
          'JIRA_EMAIL',
          'JIRA_TOKEN',
          'github',
          'octo/app',
          true,
          'path',
          '../beta',
          false,
          ...BOOTSTRAP_ANSWERS.slice(12),
          true,
          'openai/grader-model',
          '',
          true,
          'openai/criteria-model',
          '',
          ...taskAnswersWithAcceptanceCheck('octo-app', commandCheckAnswers()),
          true,
        );

        await runCli(['task', 'add'], { operations });
      }

      it('keeps every label at 40 characters or fewer, without parentheses', async () => {
        await runFullInterview();

        const labels = clack.state.prompts
          .filter((prompt) => prompt.kind !== 'intro')
          .map((prompt) => prompt.message);
        expect(labels).toContain('Jira token variable');
        expect(labels.filter((label) => label.length > 40 || /[()]/.test(label))).toEqual([]);
      });

      it('asks the Jira and repository setup questions in order with the terse labels', async () => {
        await runFullInterview();

        const labels = clack.state.prompts.map((prompt) => prompt.message);
        const jiraStart = labels.indexOf('Import issues from Jira?');
        expect(labels.slice(jiraStart, jiraStart + 10)).toEqual([
          'Import issues from Jira?',
          'Jira site URL',
          'Jira email variable',
          'Jira token variable',
          'Repository source',
          'GitHub repository',
          'Add another repository?',
          'Repository source',
          'Local path',
          'Add another repository?',
        ]);
      });

      it('offers each configured repository by ID with its source as the hint, then adding one', async () => {
        await runFullInterview();

        const repositoryPrompt = clack.state.prompts.find(
          (prompt) => prompt.message === 'Repository',
        );
        expect(repositoryPrompt?.options).toEqual([
          { label: 'octo-app', hint: 'GitHub octo/app', disabled: false },
          { label: 'beta', hint: '../beta', disabled: false },
          { label: 'Add a repository', hint: undefined, disabled: false },
        ]);
      });

      it.each([
        { setup: 'no Jira settings', jira: false, disabled: true },
        { setup: 'Jira settings', jira: true, disabled: false },
      ])('marks the Jira task source disabled only with $setup', async ({ jira, disabled }) => {
        const config = buildCliConfig(
          jira ? { trackers: { jira: buildCliJiraTrackerSettings() } } : {},
        );
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
        });
        scriptAnswers(clack.CANCEL);

        await runCli(['task', 'add'], { operations });

        expect(
          clack.state.prompts.find((prompt) => prompt.message === 'Task source')?.options,
        ).toEqual([
          { label: 'Write it yourself', hint: undefined, disabled: false },
          { label: 'Jira issue', hint: disabled ? "Jira isn't set up" : undefined, disabled },
          { label: 'GitHub issue', hint: undefined, disabled: false },
        ]);
      });
    });

    describe('command check', () => {
      it('saves the typed command line verbatim and shows it in the review', async () => {
        const commandLine = '  CI=1 npm test -- --run | tee "out log" && echo "a: #b"  ';
        const operations = createOperations();
        scriptAnswers(
          ...taskAnswersWithAcceptanceCheck(
            'repo-1',
            commandCheckAnswers({ command: [commandLine] }),
          ),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(requireCreateTaskCall(operations).task.checks.acceptance[0]).toEqual({
          id: 'acceptance-1',
          description: 'The test suite passes',
          run: commandLine,
        });
        const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
        expect(reviewNote?.message).toContain(`command ${commandLine}, `);
        expect(clack.state.answers).toEqual([]);
      });

      it('asks for the command with the label Command', async () => {
        const operations = createOperations();
        scriptAnswers(...taskAnswersWithAcceptanceCheck('repo-1', commandCheckAnswers()), true);

        await runCli(['task', 'add'], { operations });

        const messages = clack.state.prompts.map((prompt) => prompt.message);
        const checkStart = messages.indexOf('Check type');
        expect(messages.slice(checkStart, checkStart + 7)).toEqual([
          'Check type',
          'Description',
          'Required?',
          'Command',
          'Time limit',
          'Passing exit codes',
          'Check variables',
        ]);
        expect(clack.state.prompts.find((prompt) => prompt.message === 'Command')).toMatchObject({
          placeholder: undefined,
          defaultValue: undefined,
        });
      });

      it.each([
        { description: 'an empty', answer: '' },
        { description: 'a whitespace', answer: '   ' },
      ])('rejects $description command', async ({ answer }) => {
        const operations = createOperations();
        scriptAnswers(
          ...taskAnswersWithAcceptanceCheck(
            'repo-1',
            commandCheckAnswers({ command: [{ invalid: answer }, 'npm test'] }),
          ),
          true,
        );

        await runCli(['task', 'add'], { operations });

        expect(clack.state.rejections).toEqual([
          { kind: 'text', message: 'Command', reason: 'a non-empty value is required' },
        ]);
        expect(requireCreateTaskCall(operations).task.checks.acceptance[0]).toMatchObject({
          run: 'npm test',
        });
        expect(clack.state.answers).toEqual([]);
      });

      it('rejects a check variable not set in this terminal and asks again', async () => {
        const operations = createOperations();
        scriptAnswers(
          ...taskAnswersWithAcceptanceCheck(
            'repo-1',
            commandCheckAnswers({ variables: [{ invalid: 'CHECK_A UNSET_B' }, 'CHECK_A'] }),
          ),
          true,
        );

        await runCli(['task', 'add'], { operations });

        expect(clack.state.rejections).toEqual([
          {
            kind: 'text',
            message: 'Check variables',
            reason: `"UNSET_B" isn't set in this terminal`,
          },
        ]);
        expect(requireCreateTaskCall(operations).task.checks.acceptance[0]).toMatchObject({
          env: ['CHECK_A'],
        });
        expect(clack.state.answers).toEqual([]);
      });
    });

    describe('model and Jira site URL answers', () => {
      const PADDED_JIRA_URL = '\u00A0https://example.atlassian.net ';
      const TRIMMED_JIRA_URL = 'https://example.atlassian.net';

      it('accepts a model identifier that holds a line separator and checks it as typed', async () => {
        const model = 'acme/model\u2028x';
        const inspectModelProvider = inspectingProviders({
          acme: definedProvider({ keyVariables: ['ACME_KEY'], apiKey: 'reference' }),
        });
        const operations = operationsWithModelCheck({ inspectModelProvider });
        scriptAnswers(...fullSetupAnswers({ firstModel: [{ invalid: model }] }));

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.rejections).toEqual([]);
        expect(
          vi.mocked(inspectModelProvider).mock.calls.map(([, , checked]) => checked),
        ).toContain(model);
        expect(clack.state.answers).toEqual([]);
      });

      it('refuses a Jira site URL that is not https and asks the question again', async () => {
        const operations = operationsWithModelCheck();
        scriptAnswers(
          ...fullSetupAnswers({
            jira: [
              true,
              { invalid: 'http://jira.example.com' },
              TRIMMED_JIRA_URL,
              'JIRA_EMAIL',
              'JIRA_TOKEN',
            ],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.rejections).toEqual([
          { kind: 'text', message: 'Jira site URL', reason: 'an https:// URL is required' },
        ]);
        expect(
          clack.state.prompts.filter((prompt) => prompt.message === 'Jira site URL'),
        ).toHaveLength(2);
        expect(requireCreateTaskCall(operations).bootstrap?.trackers?.jira?.url).toBe(
          TRIMMED_JIRA_URL,
        );
        expect(clack.state.answers).toEqual([]);
      });

      it('saves a Jira site URL padded with whitespace without the padding', async () => {
        const operations = operationsWithModelCheck();
        scriptAnswers(
          ...fullSetupAnswers({
            jira: [true, { invalid: PADDED_JIRA_URL }, 'JIRA_EMAIL', 'JIRA_TOKEN'],
          }),
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.rejections).toEqual([]);
        expect(requireCreateTaskCall(operations).bootstrap?.trackers?.jira?.url).toBe(
          TRIMMED_JIRA_URL,
        );
        expect(clack.state.answers).toEqual([]);
      });

      it('imports the Jira issue of the same run with the padding removed from the site URL', async () => {
        const operations = operationsWithModelCheck();
        scriptAnswers(
          ...setupAnswers({
            jira: [true, { invalid: PADDED_JIRA_URL }, 'JIRA_EMAIL', 'JIRA_TOKEN'],
          }),
          false,
          false,
          'jira',
          'TEVU-42',
          ...taskInterviewAnswers('alpha').slice(1),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(clack.state.rejections).toEqual([]);
        expect(vi.mocked(operations.importJiraIssue)).toHaveBeenCalledExactlyOnceWith(
          buildCliJiraTrackerSettings({ url: TRIMMED_JIRA_URL }),
          'TEVU-42',
        );
        expect(clack.state.answers).toEqual([]);
      });
    });
  });

  describe('the graded check default (P13)', () => {
    function gradedTaskInterviewAnswers(repositoryChoice: string): unknown[] {
      return [
        'manual',
        repositoryChoice,
        '',
        'abc123',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
        false,
        'graded',
        'Export produces a CSV',
        true,
        false,
        'graded',
        'README documents the button',
        true,
        false,
      ];
    }

    it('asks only the type, criterion, and required questions for a graded check, with no command sub-questions', async () => {
      const operations = createOperations();
      scriptAnswers(...gradedTaskInterviewAnswers('repo-1'), true);

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      const messages = clack.state.prompts.map((prompt) => prompt.message);
      const checkStart = messages.indexOf('Check type');
      expect(messages.slice(checkStart, checkStart + 4)).toEqual([
        'Check type',
        'Criterion',
        'Required?',
        'Add another acceptance check?',
      ]);
      expect(messages).not.toContain('Command');
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task).toMatchObject({
        checks: {
          acceptance: [{ id: 'acceptance-1', description: 'Export produces a CSV' }],
        },
      });
      expect(
        vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task.checks.acceptance[0],
      ).not.toHaveProperty('run');
      expect(
        vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task.checks.acceptance[0],
      ).not.toHaveProperty('manual');
      expect(clack.state.answers).toEqual([]);
    });

    it('shows the roles.grader warning line exactly when a graded check is declared and no source declares the role', async () => {
      const withoutRoles = createOperations();
      scriptAnswers(...gradedTaskInterviewAnswers('repo-1'), true);
      await runCli(['task', 'add'], { operations: withoutRoles });
      const reviewWithoutRoles = clack.state.notes.find((note) => note.title === 'Review');

      expect(reviewWithoutRoles?.message).toContain(
        'warning: roles.grader is not declared; tevu validate and tevu run refuse this task until it is',
      );
      expect(clack.state.answers).toEqual([]);
    });

    it('shows no roles.grader warning line when the existing configuration already declares the role', async () => {
      const configWithGrader: TevuConfig = {
        ...buildCliConfig(),
        roles: { grader: { model: 'openai/grader-model', effort: 'high', agent: FAKE_AGENT_NAME } },
      };
      const withRoles = createOperations({
        loadConfig: vi.fn(async () => ({ ok: true as const, value: configWithGrader })),
      });
      scriptAnswers(...gradedTaskInterviewAnswers('repo-1'), true);

      await runCli(['task', 'add'], { operations: withRoles });

      const reviewWithRoles = clack.state.notes.find((note) => note.title === 'Review');
      expect(reviewWithRoles?.message).not.toContain('warning: roles.grader is not declared');
      expect(clack.state.answers).toEqual([]);
    });

    it('shows no roles.grader warning line when the task declares no graded check', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), true);

      await runCli(['task', 'add'], { operations });

      const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
      expect(reviewNote?.message).not.toContain('warning: roles.grader is not declared');
      expect(clack.state.answers).toEqual([]);
    });
  });
});
