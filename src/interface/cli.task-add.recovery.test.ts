// @vitest-environment node

import { basename } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildCliConfig,
  buildCliJiraTrackerSettings,
  buildFinding,
  buildGitHubRepositoryConfig,
  buildJiraIssueSnapshot,
  createOperations,
  managedCloneFailure,
  recordOperation,
  registerCliTestHooks,
  runCli,
} from './__fixtures__/program.fixtures';
import { clack, resetClackState, scriptAnswers } from './__fixtures__/scripted-prompts.fixtures';
import {
  BOOTSTRAP_ANSWERS,
  buildResolvedCommitReference,
  criteriaOperations,
  fullSetupAnswers,
  READY_ANSWERS,
  requireCreateTaskCall,
  taskInterviewAnswers,
} from './__fixtures__/task-wizard.fixtures';

import type { ProgramOperations } from './__fixtures__/program.fixtures';
import type { TaskWizardInput } from '@/application/create-task';
import type { TevuError } from '@/domain/errors';

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
    describe('the early base-commit check', () => {
      const REPOSITORY = { id: 'repo-1', path: '../repos/fixture' };
      const WARNING_LAST_LINE =
        'Fix the cause or change the base commit below. Press Enter to retry, or Ctrl-C to cancel.';

      function refusedOnce(
        error: Extract<
          Awaited<ReturnType<ProgramOperations['inspectBaseCommit']>>,
          { ok: false }
        >['error'],
      ): ReturnType<typeof vi.fn<ProgramOperations['inspectBaseCommit']>> {
        return vi
          .fn<ProgramOperations['inspectBaseCommit']>()
          .mockResolvedValueOnce({ ok: false, error })
          .mockResolvedValue({ ok: true, value: undefined });
      }

      async function baselineInput(script: readonly unknown[]): Promise<TaskWizardInput> {
        const operations = createOperations();
        scriptAnswers(...script);
        await runCli(['task', 'add'], { operations });
        const input = requireCreateTaskCall(operations);
        resetClackState();
        return input;
      }

      it('warns, asks Base commit again with the answer filled in before Title, and keeps every earlier answer', async () => {
        const answers = taskInterviewAnswers('repo-1');
        const baseline = await baselineInput([...answers, true]);
        const inspectBaseCommit = refusedOnce({
          kind: 'SourceMaterializationError',
          taskId: 'repo-1',
          reason: 'commit bad123 does not resolve to exactly one commit',
        });
        const operations = createOperations({ inspectBaseCommit });
        scriptAnswers(...answers.slice(0, 3), 'bad123', 'abc123', ...answers.slice(4), true);

        const { code } = await runCli(['task', 'add'], { operations });

        const messages = clack.state.prompts.map((prompt) => prompt.message);
        const askedAgain = clack.state.prompts.filter((prompt) => prompt.message === 'Base commit');
        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: `Can't use base commit bad123.\ncommit bad123 does not resolve to exactly one commit\n${WARNING_LAST_LINE}`,
        });
        expect(askedAgain.map((prompt) => prompt.initialValue)).toEqual([undefined, 'bad123']);
        expect(askedAgain[1]?.defaultValue).toBeUndefined();
        expect(messages.lastIndexOf('Base commit')).toBeLessThan(messages.indexOf('Title'));
        expect(inspectBaseCommit.mock.calls).toEqual([
          ['tevu.yaml', REPOSITORY, 'bad123', undefined],
          ['tevu.yaml', REPOSITORY, 'abc123', undefined],
        ]);
        expect(requireCreateTaskCall(operations)).toEqual(baseline);
        expect(clack.state.answers).toEqual([]);
      });

      it('lists each finding message of a configuration refusal as a detail line', async () => {
        const inspectBaseCommit = refusedOnce({
          kind: 'ConfigValidationError',
          findings: [
            buildFinding({ severity: 'error', message: 'first finding' }),
            buildFinding({ severity: 'error', message: 'second finding' }),
          ],
        });
        const operations = createOperations({ inspectBaseCommit });
        const answers = taskInterviewAnswers('repo-1');
        scriptAnswers(...answers.slice(0, 4), 'abc123', ...answers.slice(4), true);

        await runCli(['task', 'add'], { operations });

        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: `Can't use base commit abc123.\nfirst finding\nsecond finding\n${WARNING_LAST_LINE}`,
        });
      });

      it('runs an edited answer through the inspection as a new answer', async () => {
        const inspectBaseCommit = refusedOnce({
          kind: 'SourceMaterializationError',
          taskId: 'repo-1',
          reason: 'no such commit',
        });
        const operations = createOperations({ inspectBaseCommit });
        const answers = taskInterviewAnswers('repo-1');
        scriptAnswers(...answers.slice(0, 3), 'bad123', 'good456', ...answers.slice(4), true);

        await runCli(['task', 'add'], { operations });

        expect(inspectBaseCommit.mock.calls.map(([, , baseCommit]) => baseCommit)).toEqual([
          'bad123',
          'good456',
        ]);
        expect(requireCreateTaskCall(operations).task.base_commit).toBe('good456');
        expect(clack.state.answers).toEqual([]);
      });

      it('runs neither draftCriteria nor createTask before an inspection succeeds', async () => {
        const inspectBaseCommit = refusedOnce({
          kind: 'SourceMaterializationError',
          taskId: 'repo-1',
          reason: 'no such commit',
        });
        const operations = criteriaOperations({ inspectBaseCommit });
        scriptAnswers(
          'manual',
          'repo-1',
          'HEAD~3',
          'bad123',
          ...READY_ANSWERS.slice(3),
          'accept',
          false,
          false,
          true,
        );

        await runCli(['task', 'add'], { operations });

        const lastInspection = Math.max(...inspectBaseCommit.mock.invocationCallOrder);
        const [draftStart = 0] = vi.mocked(operations.draftCriteria).mock.invocationCallOrder;
        const [saveStart = 0] = vi.mocked(operations.createTask).mock.invocationCallOrder;
        expect(inspectBaseCommit).toHaveBeenCalledTimes(2);
        expect(draftStart).toBeGreaterThan(lastInspection);
        expect(saveStart).toBeGreaterThan(lastInspection);
        expect(clack.state.answers).toEqual([]);
      });

      it('inspects a GitHub entry only after its clone holds the answer', async () => {
        const ensureManagedCommits = recordOperation('ensureManagedCommits', async () => ({
          ok: true as const,
          value: { missing: [] },
        }));
        const inspectBaseCommit = recordOperation('inspectBaseCommit', async () => ({
          ok: true as const,
          value: undefined,
        }));
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({
            ok: true as const,
            value: buildGitHubRepositoryConfig(),
          })),
          ensureManagedCommits,
          inspectBaseCommit,
        });
        scriptAnswers(...taskInterviewAnswers('repo-1'), true);

        await runCli(['task', 'add'], { operations });

        expect(
          clack.state.timeline.filter(
            (event) => event.startsWith('operation:') && event.endsWith(':start'),
          ),
        ).toEqual([
          'operation:ensureManagedCommits:start',
          'operation:ensureManagedCommits:start',
          'operation:inspectBaseCommit:start',
        ]);
        expect(clack.state.spinners.map((spinner) => spinner.label)).toEqual([
          'Preparing repository',
          'Fetching base commit',
          'Fetching Git LFS objects',
          'Checking base commit',
          'Saving task',
        ]);
      });

      it('asks Base commit again with the answer filled in after a failed fetch, then fetches it again', async () => {
        const ensureManagedCommits = vi
          .fn<ProgramOperations['ensureManagedCommits']>()
          .mockResolvedValueOnce({ ok: true, value: { missing: [] } })
          .mockResolvedValueOnce({ ok: false, error: managedCloneFailure() })
          .mockResolvedValue({ ok: true, value: { missing: [] } });
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({
            ok: true as const,
            value: buildGitHubRepositoryConfig(),
          })),
          ensureManagedCommits,
        });
        const answers = taskInterviewAnswers('repo-1');
        scriptAnswers(...answers.slice(0, 4), 'abc123', ...answers.slice(4), true);

        const { code } = await runCli(['task', 'add'], { operations });

        const asked = clack.state.prompts.filter((prompt) => prompt.message === 'Base commit');
        expect(code).toBe(0);
        expect(asked.map((prompt) => prompt.initialValue)).toEqual([undefined, 'abc123']);
        expect(asked[1]?.defaultValue).toBeUndefined();
        expect(ensureManagedCommits.mock.calls.map(([request]) => request.revisions)).toEqual([
          [],
          ['abc123'],
          ['abc123'],
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('inspects the full hash of a pull-request task that the clone does not hold, as typed', async () => {
        const fullHash = 'd'.repeat(40);
        const reference = {
          kind: 'pull-request' as const,
          identifier: 'octo/app#128',
          commits: ['a'.repeat(40)],
        };
        const inspectBaseCommit = vi
          .fn<ProgramOperations['inspectBaseCommit']>()
          .mockResolvedValue({ ok: true, value: undefined });
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({
            ok: true as const,
            value: buildGitHubRepositoryConfig(),
          })),
          ensureManagedCommits: vi
            .fn<ProgramOperations['ensureManagedCommits']>()
            .mockResolvedValueOnce({ ok: true, value: { missing: [] } })
            .mockResolvedValueOnce({ ok: true, value: { missing: [fullHash] } }),
          resolveReference: vi.fn<ProgramOperations['resolveReference']>().mockResolvedValue({
            ok: true,
            value: {
              reference,
              pullRequest: {
                key: 'octo/app#128',
                state: 'merged',
                targetBranch: 'main',
                noProposedBase: 'first commit aaaaaaa has no parent',
              },
            },
          }),
          inspectBaseCommit,
        });
        const answers = taskInterviewAnswers('repo-1');
        scriptAnswers(...answers.slice(0, 2), 'octo/app#128', fullHash, ...answers.slice(4), true);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(inspectBaseCommit).toHaveBeenCalledExactlyOnceWith(
          'tevu.yaml',
          expect.objectContaining({ id: 'repo-1', github: 'octo/app' }),
          fullHash,
          reference,
        );
        expect(
          clack.state.prompts.filter((prompt) => prompt.message === 'Base commit'),
        ).toHaveLength(1);
        expect(requireCreateTaskCall(operations).task.base_commit).toBe(fullHash);
        expect(clack.state.answers).toEqual([]);
      });

      describe('the Git LFS objects of a GitHub entry', () => {
        const GITHUB_ENTRY = { id: 'repo-1', github: 'octo/app' };
        const LFS_FAILURE: Extract<TevuError, { kind: 'ManagedCloneError' }> = {
          kind: 'ManagedCloneError',
          operation: 'lfs-fetch',
          repository: 'github.com/octo/app',
          reason:
            'git lfs fetch exited with code 2: error transferring "abc": [0] remote missing object abc; github.com/octo/app does not have every Git LFS object of this commit; choose another base commit',
        };

        function githubOperations(
          ensureManagedLfsObjects: ProgramOperations['ensureManagedLfsObjects'],
        ): ProgramOperations {
          return createOperations({
            loadConfig: vi.fn(async () => ({
              ok: true as const,
              value: buildGitHubRepositoryConfig(),
            })),
            ensureManagedCommits: vi.fn(async () => ({
              ok: true as const,
              value: { missing: [] },
            })),
            ensureManagedLfsObjects,
          });
        }

        function failingOnce(
          error: Extract<
            Awaited<ReturnType<ProgramOperations['ensureManagedLfsObjects']>>,
            { ok: false }
          >['error'],
        ): ReturnType<typeof vi.fn<ProgramOperations['ensureManagedLfsObjects']>> {
          return vi
            .fn<ProgramOperations['ensureManagedLfsObjects']>()
            .mockResolvedValueOnce({ ok: false, error })
            .mockResolvedValue({ ok: true, value: undefined });
        }

        it('fetches them for the answer once the clone holds it and prints the progress lines the fetch reports', async () => {
          const line =
            'Fetching 2 Git LFS objects from github.com/octo/app into the clone of repository "repo-1"';
          const ensureManagedLfsObjects = vi.fn<ProgramOperations['ensureManagedLfsObjects']>(
            async (_request, onProgress) => {
              onProgress(line);
              return { ok: true, value: undefined };
            },
          );
          const operations = githubOperations(ensureManagedLfsObjects);
          scriptAnswers(...taskInterviewAnswers('repo-1'), true);

          const { code } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(0);
          expect(ensureManagedLfsObjects).toHaveBeenCalledExactlyOnceWith(
            { repository: GITHUB_ENTRY, revision: 'abc123' },
            expect.any(Function),
          );
          expect(clack.state.logs).toContainEqual({ kind: 'step', message: line });
          expect(clack.state.answers).toEqual([]);
        });

        it('prints the headline, the rendered failure, and the next step, then asks Base commit again with the answer filled in', async () => {
          const ensureManagedLfsObjects = failingOnce(LFS_FAILURE);
          const operations = githubOperations(ensureManagedLfsObjects);
          const answers = taskInterviewAnswers('repo-1');
          scriptAnswers(...answers.slice(0, 4), 'abc123', ...answers.slice(4), true);

          const { code } = await runCli(['task', 'add'], { operations });

          const asked = clack.state.prompts.filter((prompt) => prompt.message === 'Base commit');
          expect(code).toBe(0);
          expect(clack.state.logs).toContainEqual({
            kind: 'warn',
            message: `Can't fetch the Git LFS objects of base commit abc123.\nfetching Git LFS objects from github.com/octo/app failed: ${LFS_FAILURE.reason}\n${WARNING_LAST_LINE}`,
          });
          expect(asked.map((prompt) => prompt.initialValue)).toEqual([undefined, 'abc123']);
          expect(asked[1]?.defaultValue).toBeUndefined();
          expect(ensureManagedLfsObjects).toHaveBeenCalledTimes(2);
          expect(clack.state.answers).toEqual([]);
        });

        it('keeps every earlier answer when Enter retries the fetch', async () => {
          const answers = taskInterviewAnswers('repo-1');
          const baselineOperations = githubOperations(
            vi.fn(async () => ({ ok: true as const, value: undefined })),
          );
          scriptAnswers(...answers, true);
          await runCli(['task', 'add'], { operations: baselineOperations });
          const baseline = requireCreateTaskCall(baselineOperations);
          resetClackState();
          const operations = githubOperations(failingOnce(LFS_FAILURE));
          scriptAnswers(...answers.slice(0, 4), 'abc123', ...answers.slice(4), true);

          await runCli(['task', 'add'], { operations });

          expect(requireCreateTaskCall(operations)).toEqual(baseline);
          expect(clack.state.answers).toEqual([]);
        });

        it('renders a missing managed-clone directory as the prerequisite it is', async () => {
          const operations = githubOperations(
            failingOnce({
              kind: 'PrerequisiteError',
              tool: 'managed-clone-directory',
              expected: 'XDG_CACHE_HOME or HOME set to an absolute path',
              actual: 'unset',
            }),
          );
          const answers = taskInterviewAnswers('repo-1');
          scriptAnswers(...answers.slice(0, 4), clack.CANCEL, true);

          await runCli(['task', 'add'], { operations });

          expect(clack.state.logs).toContainEqual({
            kind: 'warn',
            message: expect.stringMatching(
              /^Can't fetch the Git LFS objects of base commit abc123\.\n.*managed-clone-directory.*\n/,
            ),
          });
        });

        it('cancels like every other wait when the fetch reports a cancellation', async () => {
          const operations = githubOperations(
            vi.fn(async () => ({
              ok: false as const,
              error: { kind: 'CancellationError' as const, activeCaseIds: [] },
            })),
          );
          scriptAnswers('manual', 'repo-1', '', 'abc123');

          const { code, err } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(130);
          expect(err).toEqual([]);
          expect(clack.state.cancels).toEqual(['Cancelled. Nothing was saved.']);
          expect(operations.createTask).not.toHaveBeenCalled();
        });

        it('never fetches them for the full hash of a pull-request task that the clone does not hold', async () => {
          const fullHash = 'd'.repeat(40);
          const ensureManagedLfsObjects = vi.fn<ProgramOperations['ensureManagedLfsObjects']>();
          const operations = createOperations({
            loadConfig: vi.fn(async () => ({
              ok: true as const,
              value: buildGitHubRepositoryConfig(),
            })),
            ensureManagedCommits: vi
              .fn<ProgramOperations['ensureManagedCommits']>()
              .mockResolvedValueOnce({ ok: true, value: { missing: [] } })
              .mockResolvedValueOnce({ ok: true, value: { missing: [fullHash] } }),
            ensureManagedLfsObjects,
            resolveReference: vi.fn<ProgramOperations['resolveReference']>().mockResolvedValue({
              ok: true,
              value: {
                reference: {
                  kind: 'pull-request' as const,
                  identifier: 'octo/app#128',
                  commits: ['a'.repeat(40)],
                },
                pullRequest: {
                  key: 'octo/app#128',
                  state: 'merged',
                  targetBranch: 'main',
                  noProposedBase: 'first commit aaaaaaa has no parent',
                },
              },
            }),
          });
          const answers = taskInterviewAnswers('repo-1');
          scriptAnswers(
            ...answers.slice(0, 2),
            'octo/app#128',
            fullHash,
            ...answers.slice(4),
            true,
          );

          const { code } = await runCli(['task', 'add'], { operations });

          expect(code).toBe(0);
          expect(ensureManagedLfsObjects).not.toHaveBeenCalled();
          expect(clack.state.answers).toEqual([]);
        });

        it('never fetches them for a path entry', async () => {
          const operations = createOperations();
          scriptAnswers(...taskInterviewAnswers('repo-1'), true);

          await runCli(['task', 'add'], { operations });

          expect(operations.ensureManagedLfsObjects).not.toHaveBeenCalled();
          expect(clack.state.spinners.map((spinner) => spinner.label)).not.toContain(
            'Fetching Git LFS objects',
          );
        });
      });
    });

    describe('repository recovery', () => {
      const NEW_ENTRY_ANSWERS = ['manual', clack.pickLabel('Add a repository')];
      const PLACEMENT_FINDING = buildFinding({
        severity: 'error',
        identifier: 'repositories.octo-app.github',
        message:
          'repository "octo-app" overlaps the run output directory after real-path resolution',
      });
      const PLACEMENT_LAST_LINE =
        'Choose another repository below, or pick Add a repository to change the answers. Press Enter to retry, or Ctrl-C to cancel.';

      function repositoryPrompts(): typeof clack.state.prompts {
        return clack.state.prompts.filter((prompt) => prompt.message === 'Repository');
      }

      it('asks Repository again after a failed clone of a new entry, lists the entry as its own option, and reuses it', async () => {
        const ensureManagedCommits = vi
          .fn<ProgramOperations['ensureManagedCommits']>()
          .mockResolvedValueOnce({ ok: false, error: managedCloneFailure() })
          .mockResolvedValue({ ok: true, value: { missing: [] } });
        const operations = createOperations({ ensureManagedCommits });
        scriptAnswers(
          ...NEW_ENTRY_ANSWERS,
          'github',
          'octo/app',
          clack.pickLabel('octo-app'),
          ...taskInterviewAnswers('repo-1').slice(2),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        const messages = clack.state.prompts.map((prompt) => prompt.message);
        const [, second] = repositoryPrompts();
        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: `Can't use repository octo-app.\ncloning github.com/octo/app failed: git clone exited with code 128\nFix the cause or choose another repository below. Press Enter to retry, or Ctrl-C to cancel.`,
        });
        expect(second?.initialLabel).toBe('octo-app');
        expect(second?.options).toEqual([
          { label: 'repo-1', hint: '../repos/fixture', disabled: false },
          { label: 'octo-app', hint: 'new, GitHub octo/app', disabled: false },
          { label: 'Add a repository', hint: undefined, disabled: false },
        ]);
        expect(messages.filter((message) => message === 'Repository source')).toHaveLength(1);
        expect(ensureManagedCommits.mock.calls.map(([request]) => request).slice(0, 2)).toEqual([
          { repository: { id: 'octo-app', github: 'octo/app' }, revisions: [] },
          { repository: { id: 'octo-app', github: 'octo/app' }, revisions: [] },
        ]);
        expect(requireCreateTaskCall(operations)).toMatchObject({
          newRepository: { id: 'octo-app', github: 'octo/app' },
          task: { repo: 'octo-app' },
        });
        expect(clack.state.answers).toEqual([]);
      });

      it('asks Repository again with the configured entry as its initial value and no added option after a failed clone', async () => {
        const ensureManagedCommits = vi
          .fn<ProgramOperations['ensureManagedCommits']>()
          .mockResolvedValueOnce({ ok: false, error: managedCloneFailure() })
          .mockResolvedValue({ ok: true, value: { missing: [] } });
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({
            ok: true as const,
            value: buildGitHubRepositoryConfig(),
          })),
          ensureManagedCommits,
        });
        scriptAnswers(
          'manual',
          'repo-1',
          'repo-1',
          ...taskInterviewAnswers('repo-1').slice(2),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        const [first, second] = repositoryPrompts();
        const messages = clack.state.prompts.map((prompt) => prompt.message);
        expect(code).toBe(0);
        expect(second?.initialLabel).toBe('repo-1');
        expect(second?.options).toEqual(first?.options);
        expect(messages.indexOf('Reference PR or commit')).toBeGreaterThan(
          messages.lastIndexOf('Repository'),
        );
        expect(requireCreateTaskCall(operations).newRepository).toBeUndefined();
        expect(clack.state.answers).toEqual([]);
      });

      it('checks a new entry before it prepares the clone, and asks Repository again on findings', async () => {
        const checkRepositoryPlacement = vi
          .fn<ProgramOperations['checkRepositoryPlacement']>()
          .mockResolvedValueOnce([PLACEMENT_FINDING])
          .mockResolvedValue([]);
        const operations = createOperations({
          checkRepositoryPlacement,
          ensureManagedCommits: vi.fn(async () => ({ ok: true as const, value: { missing: [] } })),
        });
        scriptAnswers(
          ...NEW_ENTRY_ANSWERS,
          'github',
          'octo/app',
          clack.pickLabel('octo-app'),
          ...taskInterviewAnswers('repo-1').slice(2),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        const timeline = clack.state.timeline;
        const [, second] = repositoryPrompts();
        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: `Can't add repository octo-app.\nrepositories.octo-app.github: repository "octo-app" overlaps the run output directory after real-path resolution\n${PLACEMENT_LAST_LINE}`,
        });
        expect(second?.initialLabel).toBe('octo-app');
        expect(second?.options?.map((option) => option.label)).toEqual([
          'repo-1',
          'octo-app',
          'Add a repository',
        ]);
        expect(checkRepositoryPlacement.mock.calls).toEqual([
          [
            'tevu.yaml',
            '/tmp/artifacts',
            [
              expect.objectContaining({ id: 'repo-1' }),
              expect.objectContaining({ id: 'octo-app', github: 'octo/app' }),
            ],
          ],
          [
            'tevu.yaml',
            '/tmp/artifacts',
            [
              expect.objectContaining({ id: 'repo-1' }),
              expect.objectContaining({ id: 'octo-app', github: 'octo/app' }),
            ],
          ],
        ]);
        expect(
          clack.state.spinners
            .map((spinner) => spinner.label)
            .filter((label) => ['Checking repositories', 'Preparing repository'].includes(label)),
        ).toEqual(['Checking repositories', 'Checking repositories', 'Preparing repository']);
        expect(timeline.lastIndexOf('prompt:Repository')).toBeLessThan(
          timeline.indexOf('spinner:start:Preparing repository'),
        );
        expect(requireCreateTaskCall(operations).newRepository).toMatchObject({ id: 'octo-app' });
        expect(clack.state.answers).toEqual([]);
      });

      it('leaves a configured entry unchecked for placement', async () => {
        const operations = createOperations();
        scriptAnswers(...taskInterviewAnswers('repo-1'), true);

        await runCli(['task', 'add'], { operations });

        expect(operations.checkRepositoryPlacement).not.toHaveBeenCalled();
      });

      it('opens the repository questions with the refused entry filled in after Add a repository', async () => {
        const checkRepositoryPlacement = vi
          .fn<ProgramOperations['checkRepositoryPlacement']>()
          .mockResolvedValueOnce([PLACEMENT_FINDING])
          .mockResolvedValue([]);
        const operations = createOperations({
          checkRepositoryPlacement,
          ensureManagedCommits: vi.fn(async () => ({ ok: true as const, value: { missing: [] } })),
        });
        scriptAnswers(
          ...NEW_ENTRY_ANSWERS,
          'github',
          'octo/app',
          clack.pickLabel('Add a repository'),
          'github',
          'octo/other',
          ...taskInterviewAnswers('repo-1').slice(2),
          true,
        );

        await runCli(['task', 'add'], { operations });

        const asked = (message: string): unknown[] =>
          clack.state.prompts
            .filter((prompt) => prompt.message === message)
            .map((prompt) => prompt.initialValue ?? prompt.initialLabel);
        expect(asked('Repository source')).toEqual([undefined, 'github']);
        expect(asked('GitHub repository')).toEqual([undefined, 'octo/app']);
      });

      it('asks Answer to change after setup placement findings, before the model questions, and sends a changed output directory on', async () => {
        const checkRepositoryPlacement = vi
          .fn<ProgramOperations['checkRepositoryPlacement']>()
          .mockResolvedValueOnce([
            buildFinding({
              severity: 'error',
              identifier: 'run.output_dir',
              message:
                'run.output_dir must be outside repository "alpha" after real-path resolution',
            }),
          ])
          .mockResolvedValue([]);
        const operations = createOperations({
          configExists: vi.fn(async () => false),
          checkRepositoryPlacement,
        });
        scriptAnswers(
          ...BOOTSTRAP_ANSWERS.slice(0, 12),
          clack.pickLabel('Output directory'),
          '/tmp/other-artifacts',
          ...BOOTSTRAP_ANSWERS.slice(12),
          false,
          false,
          ...taskInterviewAnswers('alpha'),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        const messages = clack.state.prompts.map((prompt) => prompt.message);
        const change = clack.state.prompts.find((prompt) => prompt.message === 'Answer to change');
        const outputPrompts = clack.state.prompts.filter(
          (prompt) => prompt.message === 'Output directory',
        );
        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message:
            'Can\'t save the output directory and repository answers.\nrun.output_dir: run.output_dir must be outside repository "alpha" after real-path resolution\nChoose an answer to change below, or press Ctrl-C to cancel.',
        });
        expect(messages.indexOf('Answer to change')).toBe(
          messages.indexOf('Add another repository?') + 1,
        );
        expect(messages.indexOf('Answer to change')).toBeLessThan(messages.indexOf('Model'));
        expect(change?.options).toEqual([
          { label: 'Output directory', hint: '/tmp/bench-artifacts', disabled: false },
          { label: 'Repository alpha', hint: '../repos/alpha', disabled: false },
        ]);
        expect(change?.initialLabel).toBe('Output directory');
        expect(outputPrompts.map((prompt) => prompt.initialValue)).toEqual([
          undefined,
          '/tmp/bench-artifacts',
        ]);
        expect(outputPrompts[1]?.defaultValue).toBe('runs');
        expect(checkRepositoryPlacement.mock.calls).toEqual([
          ['tevu.yaml', '/tmp/bench-artifacts', [{ id: 'alpha', path: '../repos/alpha' }]],
          ['tevu.yaml', '/tmp/other-artifacts', [{ id: 'alpha', path: '../repos/alpha' }]],
        ]);
        expect(requireCreateTaskCall(operations).bootstrap?.run.output_dir).toBe(
          '/tmp/other-artifacts',
        );
        expect(clack.state.answers).toEqual([]);
      });

      it('re-asks source and location of a changed setup repository with their current values', async () => {
        const checkRepositoryPlacement = vi
          .fn<ProgramOperations['checkRepositoryPlacement']>()
          .mockResolvedValueOnce([
            buildFinding({
              severity: 'error',
              identifier: 'repositories.alpha.path',
              message:
                'repository "alpha" overlaps the run output directory after real-path resolution',
            }),
          ])
          .mockResolvedValue([]);
        const operations = createOperations({
          configExists: vi.fn(async () => false),
          checkRepositoryPlacement,
        });
        scriptAnswers(
          ...BOOTSTRAP_ANSWERS.slice(0, 12),
          clack.pickLabel('Repository alpha'),
          'path',
          '../repos/alpha-fixed',
          ...BOOTSTRAP_ANSWERS.slice(12),
          false,
          false,
          ...taskInterviewAnswers('alpha-fixed'),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        const promptsAfterChange = clack.state.prompts.slice(
          clack.state.prompts.findIndex((prompt) => prompt.message === 'Answer to change') + 1,
        );
        const [source, location] = promptsAfterChange;
        expect(code).toBe(0);
        expect(source).toMatchObject({ message: 'Repository source', initialValue: 'path' });
        expect(location).toMatchObject({ message: 'Local path', initialValue: '../repos/alpha' });
        expect(requireCreateTaskCall(operations).bootstrap?.repositories).toEqual([
          { id: 'alpha-fixed', path: '../repos/alpha-fixed' },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('adds a repository whose derived ID equals a configured repository ID and saves it with a -2 suffix', async () => {
        const operations = createOperations();
        scriptAnswers(
          'manual',
          clack.pickLabel('Add a repository'),
          'path',
          '../elsewhere/repo-1',
          ...taskInterviewAnswers('repo-1').slice(2),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        const call = requireCreateTaskCall(operations);
        expect(code).toBe(0);
        expect(call.newRepository).toEqual({ id: 'repo-1-2', path: '../elsewhere/repo-1' });
        expect(call.task.repo).toBe('repo-1-2');
        expect(clack.state.answers).toEqual([]);
      });

      it('derives the repository ID again from the changed answers after Answer to change', async () => {
        const checkRepositoryPlacement = vi
          .fn<ProgramOperations['checkRepositoryPlacement']>()
          .mockResolvedValueOnce([PLACEMENT_FINDING])
          .mockResolvedValue([]);
        const operations = createOperations({
          configExists: vi.fn(async () => false),
          checkRepositoryPlacement,
        });
        scriptAnswers(
          ...BOOTSTRAP_ANSWERS.slice(0, 9),
          'path',
          '../repos/alpha',
          true,
          'path',
          '../repos/beta',
          false,
          clack.pickLabel('Repository alpha'),
          'path',
          '../repos/gamma',
          ...BOOTSTRAP_ANSWERS.slice(12),
          false,
          false,
          ...taskInterviewAnswers('gamma'),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        const call = requireCreateTaskCall(operations);
        expect(code).toBe(0);
        expect(call.bootstrap?.repositories).toEqual([
          { id: 'gamma', path: '../repos/gamma' },
          { id: 'beta', path: '../repos/beta' },
        ]);
        expect(call.task.repo).toBe('gamma');
        expect(clack.state.answers).toEqual([]);
      });

      it('derives the changed setup repository ID against the other setup repositories only', async () => {
        const checkRepositoryPlacement = vi
          .fn<ProgramOperations['checkRepositoryPlacement']>()
          .mockResolvedValueOnce([PLACEMENT_FINDING])
          .mockResolvedValue([]);
        const operations = createOperations({
          configExists: vi.fn(async () => false),
          checkRepositoryPlacement,
        });
        scriptAnswers(
          ...BOOTSTRAP_ANSWERS.slice(0, 9),
          'path',
          '../repos/alpha',
          true,
          'path',
          '../repos/beta',
          false,
          clack.pickLabel('Repository alpha'),
          'path',
          '../repos/alpha-new/alpha',
          ...BOOTSTRAP_ANSWERS.slice(12),
          false,
          false,
          ...taskInterviewAnswers('alpha'),
          true,
        );

        await runCli(['task', 'add'], { operations });

        expect(requireCreateTaskCall(operations).bootstrap?.repositories).toEqual([
          { id: 'alpha', path: '../repos/alpha-new/alpha' },
          { id: 'beta', path: '../repos/beta' },
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('derives the repository ID again when a refused new repository is filled in through Add a repository', async () => {
        const checkRepositoryPlacement = vi
          .fn<ProgramOperations['checkRepositoryPlacement']>()
          .mockResolvedValueOnce([PLACEMENT_FINDING])
          .mockResolvedValue([]);
        const operations = createOperations({
          checkRepositoryPlacement,
          ensureManagedCommits: vi.fn(async () => ({ ok: true as const, value: { missing: [] } })),
        });
        scriptAnswers(
          ...NEW_ENTRY_ANSWERS,
          'github',
          'octo/app',
          clack.pickLabel('Add a repository'),
          'github',
          'octo/other',
          ...taskInterviewAnswers('repo-1').slice(2),
          true,
        );

        const { code } = await runCli(['task', 'add'], { operations });

        const call = requireCreateTaskCall(operations);
        expect(code).toBe(0);
        expect(call.newRepository).toMatchObject({ id: 'octo-other', github: 'octo/other' });
        expect(call.task.repo).toBe('octo-other');
        expect(clack.state.answers).toEqual([]);
      });

      describe('reading the local repository naming', () => {
        function waitStarts(label: string): number[] {
          return clack.state.timeline.flatMap((event, index) =>
            event === `spinner:start:${label}` ? [index] : [],
          );
        }

        it('reads the local repository naming inside the one Checking wait', async () => {
          const readLocalRepositoryNaming = vi.fn<ProgramOperations['readLocalRepositoryNaming']>(
            recordOperation('readLocalRepositoryNaming', async (_configPath, repositoryPath) => ({
              directoryName: basename(repositoryPath),
            })),
          );
          const operations = createOperations({
            configExists: vi.fn(async () => false),
            readLocalRepositoryNaming,
          });
          scriptAnswers(...fullSetupAnswers());

          await runCli(['task', 'add'], { operations });

          const timeline = clack.state.timeline;
          const [start, ...otherStarts] = waitStarts('Checking ../repos/alpha');
          expect(otherStarts).toEqual([]);
          expect(readLocalRepositoryNaming).toHaveBeenCalledExactlyOnceWith(
            'tevu.yaml',
            '../repos/alpha',
          );
          const read = timeline.indexOf('operation:readLocalRepositoryNaming:start');
          expect(read).toBeGreaterThan(start ?? Infinity);
          expect(timeline.indexOf('operation:readLocalRepositoryNaming:end')).toBeLessThan(
            timeline.indexOf('spinner:stop:Checking ../repos/alpha'),
          );
          expect(clack.state.answers).toEqual([]);
        });

        it('reads no naming for a path that is not in a Git repository', async () => {
          const isGitRepository = vi
            .fn<ProgramOperations['isGitRepository']>()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
          const operations = createOperations({
            configExists: vi.fn(async () => false),
            isGitRepository,
          });
          scriptAnswers(...BOOTSTRAP_ANSWERS.slice(0, 11), '../repos/alpha-fixed', clack.CANCEL);

          await runCli(['task', 'add'], { operations });

          expect(operations.readLocalRepositoryNaming).toHaveBeenCalledExactlyOnceWith(
            'tevu.yaml',
            '../repos/alpha-fixed',
          );
          expect(waitStarts('Checking ../repos/alpha')).toHaveLength(1);
          expect(waitStarts('Checking ../repos/alpha-fixed')).toHaveLength(1);
        });
      });
    });

    describe('issue and reference recovery', () => {
      const GITHUB_ISSUE = 'octo/repo#42';
      const IMPORT_LAST_LINE =
        'Fix the issue below, or clear it to write the task yourself. Press Enter to retry, or Ctrl-C to cancel.';
      const AFTER_IMPORT = taskInterviewAnswers('repo-1').slice(1);

      function failedGitHubImport(
        overrides: { status?: number; reason?: string } = {},
      ): Awaited<ReturnType<ProgramOperations['importGitHubIssue']>> {
        return {
          ok: false,
          error: {
            kind: 'IssueImportError',
            tracker: 'github-issue',
            reference: GITHUB_ISSUE,
            reason: 'not found',
            ...overrides,
          },
        };
      }

      it.each([
        {
          name: 'a GitHub issue given with --github',
          argv: ['task', 'add', '--github', GITHUB_ISSUE],
          question: 'GitHub issue',
        },
        {
          name: 'a GitHub issue asked for',
          argv: ['task', 'add'],
          question: 'GitHub issue',
          prefix: ['github', GITHUB_ISSUE],
        },
      ])(
        'warns, asks the issue again with the reference filled in, and retries on Enter for $name',
        async ({ argv, question, prefix }) => {
          const importGitHubIssue = vi
            .fn<ProgramOperations['importGitHubIssue']>()
            .mockResolvedValueOnce(failedGitHubImport({ status: 404 }))
            .mockResolvedValue({ ok: true, value: buildJiraIssueSnapshot() });
          const operations = createOperations({ importGitHubIssue });
          scriptAnswers(...(prefix ?? []), GITHUB_ISSUE, ...AFTER_IMPORT, true);

          const { code } = await runCli(argv, { operations });

          const asked = clack.state.prompts.filter((prompt) => prompt.message === question);
          expect(code).toBe(0);
          expect(clack.state.logs).toContainEqual({
            kind: 'warn',
            message: `Can't import issue ${GITHUB_ISSUE}.\nstatus 404: not found\n${IMPORT_LAST_LINE}`,
          });
          expect(asked.at(-1)?.initialValue).toBe(GITHUB_ISSUE);
          expect(importGitHubIssue.mock.calls).toEqual([[GITHUB_ISSUE], [GITHUB_ISSUE]]);
          expect(requireCreateTaskCall(operations).task.source).toMatchObject({ kind: 'github' });
          expect(clack.state.answers).toEqual([]);
        },
      );

      it('prints the reason alone when the import error carries no status', async () => {
        const operations = createOperations({
          importGitHubIssue: vi
            .fn<ProgramOperations['importGitHubIssue']>()
            .mockResolvedValueOnce(failedGitHubImport({ reason: 'gh is not signed in' }))
            .mockResolvedValue({ ok: true, value: buildJiraIssueSnapshot() }),
        });
        scriptAnswers(GITHUB_ISSUE, ...AFTER_IMPORT, true);

        await runCli(['task', 'add', '--github', GITHUB_ISSUE], { operations });

        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: `Can't import issue ${GITHUB_ISSUE}.\ngh is not signed in\n${IMPORT_LAST_LINE}`,
        });
      });

      it('retries a Jira issue given with --jira the same way', async () => {
        const jiraSettings = buildCliJiraTrackerSettings();
        const importJiraIssue = vi
          .fn<ProgramOperations['importJiraIssue']>()
          .mockResolvedValueOnce({
            ok: false,
            error: {
              kind: 'IssueImportError',
              tracker: 'jira-cloud',
              reference: 'TEVU-42',
              status: 401,
              reason: 'unauthorized',
            },
          })
          .mockResolvedValue({ ok: true, value: buildJiraIssueSnapshot() });
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({
            ok: true as const,
            value: buildCliConfig({ trackers: { jira: jiraSettings } }),
          })),
          importJiraIssue,
        });
        scriptAnswers('TEVU-43', ...AFTER_IMPORT, true);

        const { code } = await runCli(['task', 'add', '--jira', 'TEVU-42'], { operations });

        const asked = clack.state.prompts.filter((prompt) => prompt.message === 'Jira issue key');
        expect(code).toBe(0);
        expect(clack.state.logs).toContainEqual({
          kind: 'warn',
          message: `Can't import issue TEVU-42.\nstatus 401: unauthorized\n${IMPORT_LAST_LINE}`,
        });
        expect(asked.map((prompt) => prompt.initialValue)).toEqual(['TEVU-42']);
        expect(importJiraIssue.mock.calls).toEqual([
          [jiraSettings, 'TEVU-42'],
          [jiraSettings, 'TEVU-43'],
        ]);
        expect(clack.state.answers).toEqual([]);
      });

      it('continues without a source when the issue answer is cleared after a failure', async () => {
        const importGitHubIssue = vi
          .fn<ProgramOperations['importGitHubIssue']>()
          .mockResolvedValue(failedGitHubImport());
        const operations = createOperations({ importGitHubIssue });
        scriptAnswers('', ...AFTER_IMPORT, true);

        const { code } = await runCli(['task', 'add', '--github', GITHUB_ISSUE], { operations });

        expect(code).toBe(0);
        expect(importGitHubIssue).toHaveBeenCalledOnce();
        expect(clack.state.rejections).toEqual([]);
        expect(requireCreateTaskCall(operations).task).not.toHaveProperty('source');
        expect(clack.state.prompts.find((prompt) => prompt.message === 'Title')?.initialValue).toBe(
          undefined,
        );
        expect(clack.state.answers).toEqual([]);
      });

      it('still refuses an empty issue answer before any failure', async () => {
        const operations = createOperations();
        scriptAnswers('github', { invalid: '  ' }, GITHUB_ISSUE, ...AFTER_IMPORT, true);

        await runCli(['task', 'add'], { operations });

        expect(clack.state.rejections).toEqual([
          expect.objectContaining({ kind: 'text', message: 'GitHub issue' }),
        ]);
      });

      it('asks Reference PR or commit again with the identifier filled in after a failed resolution', async () => {
        const resolveReference = vi
          .fn<ProgramOperations['resolveReference']>()
          .mockResolvedValueOnce({
            ok: false,
            error: {
              kind: 'ReferenceResolutionError',
              reason: 'the answer does not name a commit',
            },
          })
          .mockResolvedValue({ ok: true, value: buildResolvedCommitReference() });
        const operations = createOperations({ resolveReference });
        const answers = taskInterviewAnswers('repo-1');
        scriptAnswers(...answers.slice(0, 2), 'bad-ref', 'bad-ref', ...answers.slice(3), true);

        await runCli(['task', 'add'], { operations });

        const asked = clack.state.prompts.filter(
          (prompt) => prompt.message === 'Reference PR or commit',
        );
        expect(asked.map((prompt) => prompt.initialValue)).toEqual([undefined, 'bad-ref']);
        expect(resolveReference).toHaveBeenCalledTimes(2);
      });

      it('adds the task without a reference when the identifier is cleared after a failure', async () => {
        const resolveReference = vi.fn<ProgramOperations['resolveReference']>().mockResolvedValue({
          ok: false,
          error: { kind: 'ReferenceResolutionError', reason: 'the answer does not name a commit' },
        });
        const operations = createOperations({ resolveReference });
        const answers = taskInterviewAnswers('repo-1');
        scriptAnswers(...answers.slice(0, 2), 'bad-ref', '', ...answers.slice(3), true);

        const { code } = await runCli(['task', 'add'], { operations });

        expect(code).toBe(0);
        expect(resolveReference).toHaveBeenCalledOnce();
        expect(requireCreateTaskCall(operations).task).not.toHaveProperty('reference');
        expect(clack.state.answers).toEqual([]);
      });
    });
  });
});
