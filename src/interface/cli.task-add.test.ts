// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { createGitHubPullRequestReader } from '@/adapters/trackers/github-issues';
import { resolveReferenceSolution } from '@/application/reference-solution';

import {
  buildCliConfig,
  buildCliGraderIdentity,
  buildCliJiraTrackerSettings,
  buildFinding,
  buildJiraIssueSnapshot,
  configNotFoundError,
  configReadError,
  createOperations,
  expectNoWrites,
  registerCliTestHooks,
  runCli,
} from './__fixtures__/program.fixtures';
import { clack, scriptAnswers } from './__fixtures__/scripted-prompts.fixtures';
import {
  BOOTSTRAP_ANSWERS,
  renderAndParseBootstrap,
  requireCreateTaskCall,
  taskInterviewAnswers,
} from './__fixtures__/task-wizard.fixtures';

import type { ProgramOperations } from './__fixtures__/program.fixtures';
import type { GhRun } from '@/adapters/trackers/github-issues';
import type { JiraTrackerSettings } from '@/domain/config';
import type { TevuError, ValidationFinding } from '@/domain/errors';
import type { ManagedCloneAdapter } from '@/domain/ports/managed-clone';

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

function configParseError(
  findings: ValidationFinding[],
): Extract<TevuError, { kind: 'ConfigParseError' }> {
  return { kind: 'ConfigParseError', findings };
}

function failingManagedCloneAdapter(): ManagedCloneAdapter {
  const fail = (): never => {
    throw new Error('unexpected managed-clone call for a path repository');
  };
  return {
    inspectClone: fail,
    clone: fail,
    fetchCommits: fail,
    fetchBranchesAndTags: fail,
    checkRemote: fail,
    fetchLfsObjects: fail,
  };
}

const BOOTSTRAP_PROMPTS = [
  'Output directory',
  'Concurrent cases',
  'Agent time limit',
  'Stop grace period',
  'Check time limit',
  'Agent command',
  'Secret variable names',
  'Non-secret variable names',
  'Import issues from Jira?',
  'Repository source',
  'Local path',
  'Add another repository?',
  'Model',
  'Reasoning effort',
  'Model',
  'Reasoning effort',
  'Add another model?',
  'Grade checks with a model?',
];

describe('tevu CLI', () => {
  registerCliTestHooks();

  describe('task add', () => {
    it('rejects combining --jira and --github before any operation is called', async () => {
      const operations = createOperations();

      const { code, err } = await runCli(
        ['task', 'add', '--jira', 'TEVU-42', '--github', 'octo/repo#42'],
        { operations },
      );

      expect(code).toBe(1);
      expect(err[0]).toBe(
        "error: option '--github <reference>' cannot be used with option '--jira <issue-key>'",
      );
      expect(clack.state.prompts).toEqual([]);
      expect(operations.configExists).not.toHaveBeenCalled();
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('rejects --jira before any question when the configuration has no Jira settings', async () => {
      const operations = createOperations();

      const { code, err } = await runCli(['task', 'add', '--jira', 'TEVU-42'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: the configuration is invalid',
        '  error trackers.jira: task add --jira requires trackers.jira in the existing configuration',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('bootstraps the configuration before the first task question and cancels without a write', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(...BOOTSTRAP_ANSWERS, clack.CANCEL);

      const { code, err } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(err).toEqual([]);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
        'tevu task add',
        ...BOOTSTRAP_PROMPTS,
      ]);
      expect(vi.mocked(operations.configExists)).toHaveBeenCalledExactlyOnceWith('tevu.yaml');
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.createTask).not.toHaveBeenCalled();
      expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
    });

    const GITHUB_GRAMMAR_MESSAGE =
      'github must be OWNER/REPO or https://HOST/OWNER/REPO, with a HOST of letters, digits, hyphens, and dots, and without surrounding spaces, user info, a port, a query, or a fragment';

    it('offers the GitHub repository option during bootstrap and re-prompts on a malformed answer (AC-7)', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        '/tmp/bench-artifacts',
        '4',
        '10m',
        '5s',
        '',
        'opencode',
        '',
        '',
        false,
        'github',
        { invalid: 'bad repo' },
        'octo/app',
        clack.CANCEL,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
        'tevu task add',
        ...BOOTSTRAP_PROMPTS.slice(0, 9),
        'Repository source',
        'GitHub repository',
        'GitHub repository',
        'Add another repository?',
      ]);
      expect(clack.state.rejections).toEqual([
        { kind: 'text', message: 'GitHub repository', reason: GITHUB_GRAMMAR_MESSAGE },
      ]);
      expect(operations.checkGitHubRepository).toHaveBeenCalledExactlyOnceWith({
        host: 'github.com',
        owner: 'octo',
        repo: 'app',
      });
    });

    it('warns and asks the GitHub repository again, filled in, when it cannot be read', async () => {
      const checkGitHubRepository = vi
        .fn<ProgramOperations['checkGitHubRepository']>()
        .mockResolvedValueOnce({
          ok: false,
          error: {
            kind: 'ManagedCloneError',
            operation: 'ls-remote',
            repository: 'github.com/octo/missing',
            reason: 'git ls-remote exited with code 128: repository not found',
          },
        })
        .mockResolvedValueOnce({ ok: true, value: undefined });
      const operations = createOperations({
        configExists: vi.fn(async () => false),
        checkGitHubRepository,
      });
      scriptAnswers(
        ...BOOTSTRAP_ANSWERS.slice(0, 9),
        'github',
        'octo/missing',
        'octo/app',
        clack.CANCEL,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(clack.state.logs).toContainEqual({
        kind: 'warn',
        message: [
          "Can't read octo/missing from GitHub.",
          'reading github.com/octo/missing failed: git ls-remote exited with code 128: repository not found',
          'Fix the repository below. Press Enter to retry, or Ctrl-C to cancel.',
        ].join('\n'),
      });
      expect(
        clack.state.prompts
          .filter((prompt) => prompt.message === 'GitHub repository')
          .map((prompt) => prompt.initialValue),
      ).toEqual([undefined, 'octo/missing']);
      expect(checkGitHubRepository).toHaveBeenCalledTimes(2);
      expect(clack.state.prompts.at(-1)?.message).toBe('Add another repository?');
    });

    it('cancels without saving when the GitHub repository read is cancelled', async () => {
      const operations = createOperations({
        configExists: vi.fn(async () => false),
        checkGitHubRepository: vi.fn(async () => ({
          ok: false as const,
          error: { kind: 'CancellationError' as const, activeCaseIds: [] },
        })),
      });
      scriptAnswers(...BOOTSTRAP_ANSWERS.slice(0, 9), 'github', 'octo/app');

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(operations.createTask).not.toHaveBeenCalled();
      expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
    });

    it('warns and asks the local path again, filled in, until it lies in a Git repository', async () => {
      const isGitRepository = vi
        .fn<ProgramOperations['isGitRepository']>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const operations = createOperations({
        configExists: vi.fn(async () => false),
        isGitRepository,
      });
      scriptAnswers(...BOOTSTRAP_ANSWERS.slice(0, 11), '../repos/alpha-fixed', clack.CANCEL);

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(clack.state.logs).toContainEqual({
        kind: 'warn',
        message: [
          "../repos/alpha isn't a Git repository.",
          'Fix the path below. Press Enter to retry, or Ctrl-C to cancel.',
        ].join('\n'),
      });
      expect(
        clack.state.prompts
          .filter((prompt) => prompt.message === 'Local path')
          .map((prompt) => prompt.initialValue),
      ).toEqual([undefined, '../repos/alpha']);
      expect(isGitRepository.mock.calls).toEqual([
        ['tevu.yaml', '../repos/alpha'],
        ['tevu.yaml', '../repos/alpha-fixed'],
      ]);
      expect(clack.state.prompts.at(-1)?.message).toBe('Add another repository?');
    });

    it('rejects Jira credential variables not set in this terminal and asks again', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        ...BOOTSTRAP_ANSWERS.slice(0, 8),
        true,
        'https://example.atlassian.net',
        { invalid: 'UNSET_EMAIL' },
        'JIRA_EMAIL',
        { invalid: 'UNSET_TOKEN' },
        'JIRA_TOKEN',
        clack.CANCEL,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(clack.state.rejections).toEqual([
        {
          kind: 'text',
          message: 'Jira email variable',
          reason: `"UNSET_EMAIL" isn't set in this terminal`,
        },
        {
          kind: 'text',
          message: 'Jira token variable',
          reason: `"UNSET_TOKEN" isn't set in this terminal`,
        },
      ]);
    });

    it('re-asks the Repository select on a ManagedCloneError, keeping every earlier answer (AC-9)', async () => {
      const config = buildCliConfig({
        repositories: [{ id: 'repo-1', github: 'octo/app' }],
      });
      const ensureManagedCommits = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false as const,
          error: {
            kind: 'ManagedCloneError' as const,
            operation: 'clone' as const,
            repository: 'github.com/octo/app',
            reason: 'git clone exited with code 128',
          },
        })
        .mockResolvedValue({ ok: true as const, value: { missing: [] } });
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
        ensureManagedCommits,
      });
      const remainingTaskAnswers = taskInterviewAnswers('repo-1').slice(2);
      scriptAnswers('manual', 'repo-1', 'repo-1', ...remainingTaskAnswers, true);

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(clack.state.prompts.filter((prompt) => prompt.message === 'Repository')).toHaveLength(
        2,
      );
      expect(clack.state.logs).toContainEqual({
        kind: 'warn',
        message:
          "Can't use repository repo-1.\ncloning github.com/octo/app failed: git clone exited with code 128\nFix the cause or choose another repository below. Press Enter to retry, or Ctrl-C to cancel.",
      });
      expect(ensureManagedCommits).toHaveBeenCalledWith(
        { repository: { id: 'repo-1', github: 'octo/app' }, revisions: [] },
        expect.any(Function),
      );
      expect(clack.state.answers).toEqual([]);
    });

    it('bootstraps the complete configuration, re-prompts invalid integers, and lets createTask perform the only write', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        '/tmp/bench-artifacts',
        { invalid: 'abc' },
        ...BOOTSTRAP_ANSWERS.slice(1),
        false,
        false,
        ...taskInterviewAnswers('alpha'),
        true,
      );

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
      expect(clack.state.rejections).toEqual([
        {
          kind: 'text',
          message: 'Concurrent cases',
          reason: 'enter an integer from 1 through 32',
        },
      ]);
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(vi.mocked(operations.createTask)).toHaveBeenCalledOnce();
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]).toEqual({
        configPath: 'tevu.yaml',
        bootstrap: {
          run: {
            output_dir: '/tmp/bench-artifacts',
            concurrency: 4,
            timeout: '10m',
            stop_grace: '5s',
            check_timeout: '5m',
          },
          agents: { opencode: { command: 'opencode', secrets: [], env: [] } },
          repositories: [{ id: 'alpha', path: '../repos/alpha' }],
          models: [
            { id: 'model-a-high', model: 'provider/model-a', effort: 'high' },
            { id: 'model-b-low', model: 'provider/model-b', effort: 'low' },
          ],
        },
        task: {
          id: 'task-1',
          title: 'Add an export button',
          repo: 'alpha',
          base_commit: 'abc123',
          description: 'Export the current view as CSV.',
          prompt: 'Implement CSV export for the current view.',
          readiness: ['Repository is readable'],
          checks: {
            acceptance: [
              { id: 'acceptance-1', description: 'Export produces a CSV', manual: true },
            ],
            done: [{ id: 'done-1', description: 'README documents the button', manual: true }],
          },
        },
      });
      expect(clack.state.answers).toEqual([]);
    });

    it('declares roles.grader in the bootstrap answers when the operator opts in, and the written configuration parses with the role (P11)', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        ...BOOTSTRAP_ANSWERS,
        true,
        'openai/grader-model',
        'high',
        false,
        ...taskInterviewAnswers('alpha'),
        true,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual(
        expect.arrayContaining([...BOOTSTRAP_PROMPTS, 'Grader model', 'Grader effort']),
      );
      const call = requireCreateTaskCall(operations);
      expect(call.bootstrap?.roles).toEqual({
        grader: { model: 'openai/grader-model', effort: 'high' },
      });

      const parsed = renderAndParseBootstrap(call);

      expect(parsed.roles?.grader).toEqual(buildCliGraderIdentity({ agent: 'opencode' }));
      expect(clack.state.answers).toEqual([]);
    });

    it('asks the criteria question after the grader question and declares roles.criteria when the operator opts in (E5)', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        ...BOOTSTRAP_ANSWERS,
        false,
        true,
        'openai/criteria-model',
        'high',
        ...taskInterviewAnswers('alpha'),
        true,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      const graderIndex = clack.state.prompts.findIndex(
        (prompt) => prompt.message === 'Grade checks with a model?',
      );
      const criteriaIndex = clack.state.prompts.findIndex(
        (prompt) => prompt.message === 'Draft criteria with a model?',
      );
      expect(graderIndex).toBeGreaterThanOrEqual(0);
      expect(criteriaIndex).toBeGreaterThan(graderIndex);
      const call = requireCreateTaskCall(operations);
      expect(call.bootstrap?.roles).toEqual({
        criteria: { model: 'openai/criteria-model', effort: 'high' },
      });

      const parsed = renderAndParseBootstrap(call);

      expect(parsed.roles?.criteria).toEqual({
        model: 'openai/criteria-model',
        effort: 'high',
        agent: 'opencode',
      });
      expect(clack.state.answers).toEqual([]);
    });

    it('omits roles from the bootstrap answers when the operator declines a grader model, and the written configuration still parses (P11)', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(...BOOTSTRAP_ANSWERS, false, false, ...taskInterviewAnswers('alpha'), true);

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      const call = requireCreateTaskCall(operations);
      expect(call.bootstrap?.roles).toBeUndefined();

      const parsed = renderAndParseBootstrap(call);

      expect(parsed.roles?.grader).toBeUndefined();
      expect(parsed.roles?.criteria).toBeUndefined();
      expect(clack.state.answers).toEqual([]);
    });

    it('re-prompts the grader model question until the answer is a valid provider/model identifier', async () => {
      const operations = createOperations({ configExists: vi.fn(async () => false) });
      scriptAnswers(
        ...BOOTSTRAP_ANSWERS,
        true,
        { invalid: 'not-a-model' },
        'openai/grader-model',
        clack.CANCEL,
      );

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(clack.state.prompts.map((prompt) => prompt.message)).toEqual([
        'tevu task add',
        ...BOOTSTRAP_PROMPTS,
        'Grader model',
        'Grader model',
        'Grader effort',
      ]);
      expect(clack.state.rejections).toEqual([
        { kind: 'text', message: 'Grader model', reason: 'model must be "<provider>/<model>"' },
      ]);
      expect(operations.createTask).not.toHaveBeenCalled();
    });

    it('captures a task against an existing configuration and lets createTask perform the only write', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), true);

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
      expect(vi.mocked(operations.configExists)).toHaveBeenCalledExactlyOnceWith('tevu.yaml');
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledOnce();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(vi.mocked(operations.createTask)).toHaveBeenCalledOnce();
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]).toEqual({
        configPath: 'tevu.yaml',
        task: {
          id: 'task-2',
          title: 'Add an export button',
          repo: 'repo-1',
          base_commit: 'abc123',
          description: 'Export the current view as CSV.',
          prompt: 'Implement CSV export for the current view.',
          readiness: ['Repository is readable'],
          checks: {
            acceptance: [
              { id: 'acceptance-1', description: 'Export produces a CSV', manual: true },
            ],
            done: [{ id: 'done-1', description: 'README documents the button', manual: true }],
          },
        },
      });
      expect(clack.state.answers).toEqual([]);
    });

    it('appends to a found search candidate and prints it as both the Configuration line and the added-to target (AC-2)', async () => {
      const foundPath = '/home/u/.config/tevu/tevu.yaml';
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({ ok: true as const, value: foundPath })),
      });
      scriptAnswers(...taskInterviewAnswers('repo-1'), true);

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual([`Configuration: ${foundPath}`]);
      expect(clack.state.outros).toEqual([`Task task-2 added to ${foundPath}`]);
      expect(vi.mocked(operations.configExists)).toHaveBeenCalledExactlyOnceWith(foundPath);
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith(foundPath);
      expect(clack.state.answers).toEqual([]);
    });

    it('creates the current-directory file named by searchedPaths[0] when the search reports ConfigNotFoundError (AC-2)', async () => {
      const operations = createOperations({
        configExists: vi.fn(async () => false),
        locateConfig: vi.fn(async () => ({
          ok: false as const,
          error: configNotFoundError(['/work/tevu.yaml', '/home/u/.config/tevu/tevu.yaml']),
        })),
      });
      scriptAnswers(...BOOTSTRAP_ANSWERS, false, false, ...taskInterviewAnswers('alpha'), true);

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: /work/tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to /work/tevu.yaml']);
      expect(vi.mocked(operations.configExists)).toHaveBeenCalledExactlyOnceWith('/work/tevu.yaml');
      expect(vi.mocked(operations.requireConfigDirectory)).toHaveBeenCalledExactlyOnceWith(
        '/work/tevu.yaml',
      );
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(clack.state.answers).toEqual([]);
    });

    it("exits 1 before the wizard's first question and before configExists or requireConfigDirectory when the search reports a ConfigReadError", async () => {
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('permission-denied', '/work/tevu.yaml', 'tevu.yaml'),
        })),
      });

      const { code, err } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: cannot read configuration file /work/tevu.yaml: permission denied',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expect(operations.configExists).not.toHaveBeenCalled();
      expect(operations.requireConfigDirectory).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('imports a Jira issue exactly once and travels the snapshot inside the wizard input', async () => {
      const jiraSettings = buildCliJiraTrackerSettings();
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildCliConfig({ trackers: { jira: jiraSettings } }),
        })),
      });
      scriptAnswers(
        'repo-1',
        '',
        'abc123',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
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

      const { code, out } = await runCli(['task', 'add', '--jira', 'TEVU-42'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
      expect(vi.mocked(operations.importJiraIssue)).toHaveBeenCalledExactlyOnceWith(
        jiraSettings,
        'TEVU-42',
      );
      expect(clack.state.notes).toContainEqual({
        title: 'Imported TEVU-42',
        message: 'Add an export button\n\nUsers cannot export the current view.',
      });
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task.source).toEqual({
        kind: 'jira',
        key: 'TEVU-42',
        url: 'https://jira.example.com/browse/TEVU-42',
        imported_at: '2026-09-23T10:00:00.000Z',
        title: 'Add an export button',
        body: 'Users cannot export the current view.',
      });
      expect(clack.state.answers).toEqual([]);
    });

    it('imports a GitHub issue exactly once and travels the snapshot inside the wizard input', async () => {
      const githubSnapshot = buildJiraIssueSnapshot({
        issueKey: 'octo/repo#42',
        issueUrl: 'https://github.com/octo/repo/issues/42',
        summary: 'Add an export button',
        description: 'Users cannot export the current view.',
      });
      const operations = createOperations({
        importGitHubIssue: vi.fn(async () => ({ ok: true as const, value: githubSnapshot })),
      });
      scriptAnswers(
        'repo-1',
        '',
        'abc123',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
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

      const { code, out } = await runCli(['task', 'add', '--github', 'octo/repo#42'], {
        operations,
      });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
      expect(vi.mocked(operations.importGitHubIssue)).toHaveBeenCalledExactlyOnceWith(
        'octo/repo#42',
      );
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(clack.state.notes).toContainEqual({
        title: 'Imported octo/repo#42',
        message: 'Add an export button\n\nUsers cannot export the current view.',
      });
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task.source).toEqual({
        kind: 'github',
        key: 'octo/repo#42',
        url: 'https://github.com/octo/repo/issues/42',
        imported_at: '2026-09-23T10:00:00.000Z',
        title: 'Add an export button',
        body: 'Users cannot export the current view.',
      });
      expect(clack.state.answers).toEqual([]);
    });

    it.each([
      {
        description: 'Jira',
        argv: ['task', 'add', '--jira', 'TEVU-42'],
        operationsOverrides: (jiraSettings: JiraTrackerSettings) => ({
          loadConfig: vi.fn(async () => ({
            ok: true as const,
            value: buildCliConfig({ trackers: { jira: jiraSettings } }),
          })),
          importJiraIssue: vi.fn(async () => ({
            ok: false as const,
            error: { kind: 'CancellationError' as const, activeCaseIds: [] },
          })),
        }),
      },
      {
        description: 'GitHub',
        argv: ['task', 'add', '--github', 'octo/repo#42'],
        operationsOverrides: () => ({
          importGitHubIssue: vi.fn(async () => ({
            ok: false as const,
            error: { kind: 'CancellationError' as const, activeCaseIds: [] },
          })),
        }),
      },
    ])(
      'converts a $description import cancellation into the standard cancellation exit and message',
      async ({ argv, operationsOverrides }) => {
        const operations = createOperations(operationsOverrides(buildCliJiraTrackerSettings()));

        const { code, err } = await runCli(argv, { operations });

        expect(code).toBe(130);
        expect(err).toEqual([]);
        expect(operations.createTask).not.toHaveBeenCalled();
        expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
      },
    );

    it('cancels at the review confirmation without calling createTask', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), false, true);

      const { code, err } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(130);
      expect(err).toEqual([]);
      expect(operations.createTask).not.toHaveBeenCalled();
      expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
    });

    it('maps a configuration parse failure to exit 1 before any question', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configParseError([
            buildFinding({
              severity: 'error',
              identifier: 'version',
              message: 'unsupported version',
            }),
          ]),
        })),
      });

      const { code, err } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: the configuration could not be parsed',
        '  error version: unsupported version',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expectNoWrites(operations);
    });

    it('fails before the intro on a permission-denied read without starting the interview', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('permission-denied', '/work/locked/tevu.yaml', 'locked/tevu.yaml'),
        })),
      });

      const { code, err } = await runCli(['task', 'add', '--config', 'locked/tevu.yaml'], {
        operations,
      });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: cannot read configuration file /work/locked/tevu.yaml: permission denied',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expect(clack.state.notes).toEqual([]);
      expect(clack.state.logs).toEqual([]);
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('fails before the intro when the configuration directory does not exist', async () => {
      const operations = createOperations({
        configExists: vi.fn(async () => false),
        requireConfigDirectory: vi.fn(async () => ({
          ok: false as const,
          error: {
            kind: 'PrerequisiteError' as const,
            tool: 'configuration directory',
            expected: 'an existing directory',
            actual: '/nonexistent does not exist',
          },
        })),
      });

      const { code, err } = await runCli(['task', 'add', '--config', '/nonexistent/tevu.yaml'], {
        operations,
      });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: prerequisite "configuration directory" is not satisfied; expected an existing directory, actual /nonexistent does not exist',
      ]);
      expect(clack.state.prompts).toEqual([]);
      expect(clack.state.notes).toEqual([]);
      expect(clack.state.logs).toEqual([]);
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('never probes the configuration directory when the configuration file exists', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), true);

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(operations.requireConfigDirectory).not.toHaveBeenCalled();
      expect(clack.state.answers).toEqual([]);
    });

    it('adds a task exactly as without a reference when the reference question is left empty', async () => {
      const operations = createOperations();
      scriptAnswers(...taskInterviewAnswers('repo-1'), true);

      const { code } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(operations.resolveReference).not.toHaveBeenCalled();
      expect(operations.draftCriteria).not.toHaveBeenCalled();
      expect(
        clack.state.prompts.find((prompt) => prompt.message === 'Reference PR or commit'),
      ).toMatchObject({
        placeholder: 'none',
        defaultValue: '',
      });
      expect(clack.state.prompts.find((prompt) => prompt.message === 'Base commit')).toMatchObject({
        placeholder: undefined,
        defaultValue: undefined,
      });
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task).not.toHaveProperty(
        'reference',
      );
      const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
      expect(reviewNote?.message).not.toContain('reference');
      expect(clack.state.answers).toEqual([]);
    });

    it('resolves a local commit reference, retries after a failed resolution, and proposes its parent as the base commit', async () => {
      const hash = '0123456789abcdef0123456789abcdef01234567';
      const parent = 'fedcba9876543210fedcba9876543210fedcba98';
      const resolveReference = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false as const,
          error: {
            kind: 'ReferenceResolutionError' as const,
            reason: 'the answer does not name a commit',
          },
        })
        .mockResolvedValueOnce({
          ok: true as const,
          value: {
            reference: { kind: 'commit' as const, identifier: 'HEAD~3', commits: [hash] },
            proposedBase: { commit: parent, basis: 'commit-parent' as const },
          },
        });
      const operations = createOperations({ resolveReference });
      scriptAnswers(
        'manual',
        'repo-1',
        'bad-ref',
        'HEAD~3',
        '',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
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

      const { code, out } = await runCli(['task', 'add'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(clack.state.outros).toEqual(['Task task-2 added to tevu.yaml']);
      expect(resolveReference).toHaveBeenCalledTimes(2);
      expect(resolveReference.mock.calls[0]?.[0]).toEqual({
        configPath: 'tevu.yaml',
        repository: { id: 'repo-1', path: '../repos/fixture' },
        identifier: 'bad-ref',
      });
      expect(resolveReference.mock.calls[1]?.[0]).toEqual({
        configPath: 'tevu.yaml',
        repository: { id: 'repo-1', path: '../repos/fixture' },
        identifier: 'HEAD~3',
      });
      expect(clack.state.logs).toContainEqual({
        kind: 'warn',
        message:
          "Can't resolve the reference.\nthe answer does not name a commit\nFix the reference below, or clear it to add the task without one. Press Enter to retry, or Ctrl-C to cancel.",
      });
      expect(clack.state.notes).toContainEqual({
        title: 'Reference solution',
        message: `Commit ${hash} in "repo-1"\nProposed base: ${parent} (the parent of the reference commit)`,
      });
      expect(clack.state.prompts.find((prompt) => prompt.message === 'Base commit')).toMatchObject({
        placeholder: parent,
        defaultValue: parent,
      });
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task).toMatchObject({
        base_commit: parent,
        reference: { kind: 'commit', identifier: 'HEAD~3', commits: [hash] },
      });
      const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
      expect(reviewNote?.message).toContain('  reference: commit HEAD~3\n  reference commits: 1');
      expect(clack.state.answers).toEqual([]);
    });

    it('resolves a pull-request reference through resolveReferenceSolution over a fake gh, recording its merge commit', async () => {
      const headHash = 'a'.repeat(40);
      const parentHash = 'b'.repeat(40);
      const targetTipHash = 'c'.repeat(40);
      const mergeHash = 'd'.repeat(40);
      const page = {
        data: {
          repository: {
            pullRequest: {
              number: 128,
              url: 'https://github.com/octo/app/pull/128',
              state: 'MERGED',
              headRefOid: headHash,
              baseRefName: 'main',
              baseRef: { target: { oid: targetTipHash } },
              mergeCommit: { oid: mergeHash },
              mergeable: 'MERGEABLE',
              commits: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    commit: {
                      oid: headHash,
                      parents: { totalCount: 1, nodes: [{ oid: parentHash }] },
                    },
                  },
                ],
              },
            },
          },
        },
      };
      const runGh: GhRun = vi.fn(async () => ({
        launched: true as const,
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        stdout: { text: JSON.stringify([page]), truncated: false },
        stderr: { text: '', truncated: false },
      }));
      const operations = createOperations({
        resolveReference: (request, onProgress) =>
          resolveReferenceSolution(request, {
            git: { resolveCommit: async () => ({ kind: 'not-found' as const }) },
            clones: failingManagedCloneAdapter(),
            managedCloneRoot: undefined,
            onProgress,
            pullRequests: createGitHubPullRequestReader({
              runGh,
              parentEnvironment: {},
              cancellation: new AbortController().signal,
            }),
          }),
      });
      scriptAnswers(
        'manual',
        'repo-1',
        'octo/app#128',
        '',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
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
      expect(runGh).toHaveBeenCalledTimes(1);
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task).toMatchObject({
        base_commit: parentHash,
        reference: {
          kind: 'pull-request',
          identifier: 'octo/app#128',
          commits: [headHash],
          merge_commit: mergeHash,
        },
      });
      expect(clack.state.notes).toContainEqual({
        title: 'Reference solution',
        message: `Pull request octo/app#128 (merged) into main\nCommits: 1, merge commit ${mergeHash}\nProposed base: ${parentHash} (the parent of the pull request's first commit)`,
      });
      const reviewNote = clack.state.notes.find((note) => note.title === 'Review');
      expect(reviewNote?.message).toContain(`  reference merge commit: ${mergeHash}`);
      expect(clack.state.answers).toEqual([]);
    });

    it.each([
      {
        description: 'a conflicting pull request',
        snapshotOverrides: { mergeable: 'CONFLICTING' },
        expectedWarning:
          'Pull request octo/app#128 conflicts with main; the proposed base is the parent of its first commit, not the tip of main',
      },
      {
        description: 'a closed, mergeable pull request',
        snapshotOverrides: { state: 'CLOSED' },
        expectedWarning:
          'Pull request octo/app#128 is closed, and GitHub does not recheck closed pull requests against main; the proposed base is the tip of main; if it conflicts, enter bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, the parent of its first commit',
      },
      {
        description: 'a pull request with unknown mergeability',
        snapshotOverrides: { mergeable: null },
        expectedWarning:
          'GitHub has not determined whether pull request octo/app#128 conflicts with main; the proposed base is the tip of main; if it conflicts, enter bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, the parent of its first commit',
      },
      {
        description: 'a pull request whose target branch was deleted',
        snapshotOverrides: { baseRef: null },
        expectedWarning:
          'Branch main of pull request octo/app#128 no longer exists on GitHub; the proposed base is the parent of its first commit',
      },
    ])('prints the warning for $description', async ({ snapshotOverrides, expectedWarning }) => {
      const headHash = 'a'.repeat(40);
      const parentHash = 'b'.repeat(40);
      const targetTipHash = 'c'.repeat(40);
      const page = {
        data: {
          repository: {
            pullRequest: {
              number: 128,
              url: 'https://github.com/octo/app/pull/128',
              state: 'OPEN',
              headRefOid: headHash,
              baseRefName: 'main',
              baseRef: { target: { oid: targetTipHash } },
              mergeCommit: null,
              mergeable: 'MERGEABLE',
              commits: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    commit: {
                      oid: headHash,
                      parents: { totalCount: 1, nodes: [{ oid: parentHash }] },
                    },
                  },
                ],
              },
              ...snapshotOverrides,
            },
          },
        },
      };
      const runGh: GhRun = vi.fn(async () => ({
        launched: true as const,
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        stdout: { text: JSON.stringify([page]), truncated: false },
        stderr: { text: '', truncated: false },
      }));
      const operations = createOperations({
        resolveReference: (request, onProgress) =>
          resolveReferenceSolution(request, {
            git: { resolveCommit: async () => ({ kind: 'not-found' as const }) },
            clones: failingManagedCloneAdapter(),
            managedCloneRoot: undefined,
            onProgress,
            pullRequests: createGitHubPullRequestReader({
              runGh,
              parentEnvironment: {},
              cancellation: new AbortController().signal,
            }),
          }),
      });
      scriptAnswers(
        'manual',
        'repo-1',
        'octo/app#128',
        '',
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
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
      expect(clack.state.logs).toContainEqual({ kind: 'warn', message: expectedWarning });
      expect(clack.state.answers).toEqual([]);
    });

    it("records the reference and asks today's base commit question when no base is proposed", async () => {
      const firstCommit = 'a'.repeat(40);
      const noProposedBase = `first commit ${firstCommit.slice(0, 7)} of pull request octo/app#128 has no parent`;
      const resolveReference = vi.fn(async () => ({
        ok: true as const,
        value: {
          reference: {
            kind: 'pull-request' as const,
            identifier: 'octo/app#128',
            commits: [firstCommit],
          },
          pullRequest: {
            key: 'octo/app#128',
            state: 'merged' as const,
            targetBranch: 'main',
            noProposedBase,
          },
        },
      }));
      const operations = createOperations({ resolveReference });
      const base = 'abcdef0123456789abcdef0123456789abcdef01';
      scriptAnswers(
        'manual',
        'repo-1',
        'octo/app#128',
        base,
        'Add an export button',
        'Export the current view as CSV.',
        'Implement CSV export for the current view.',
        'Repository is readable',
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
        message: `No base commit is proposed: ${noProposedBase}`,
      });
      expect(clack.state.prompts.find((prompt) => prompt.message === 'Base commit')).toMatchObject({
        placeholder: undefined,
        defaultValue: undefined,
      });
      expect(clack.state.notes).toContainEqual({
        title: 'Reference solution',
        message: 'Pull request octo/app#128 (merged) into main\nCommits: 1\nProposed base: none',
      });
      expect(vi.mocked(operations.createTask).mock.calls[0]?.[0]?.task).toMatchObject({
        base_commit: base,
        reference: { kind: 'pull-request', identifier: 'octo/app#128', commits: [firstCommit] },
      });
      expect(clack.state.answers).toEqual([]);
    });
  });
});
