// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  artifactError,
  buildBenchmarkPlan,
  buildCliCaseResult,
  buildCliConfig,
  buildCliTaskInput,
  buildEffortChecks,
  buildFinding,
  buildReportResult,
  buildRunResult,
  buildValidationReport,
  configNotFoundError,
  configReadError,
  createIo,
  createOperations,
  expectNoWrites,
  registerCliTestHooks,
  runCli,
} from './__fixtures__/program.fixtures';

import type { TevuConfig } from '@/domain/config';
import type { TevuError } from '@/domain/errors';
import type { EffortCheck, RunFinding, RunResult } from '@/domain/run-records';
import type { BenchmarkPlan, EffortChecks } from '@/domain/use-cases';
import type { BenchmarkExecutionHooks } from '@/interface/commands/run';

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

function buildRunFinding(overrides: Partial<RunFinding> = {}): RunFinding {
  return {
    severity: 'warning',
    caseId: 'case-c1-task-1',
    message: 'diagnostics truncated',
    ...overrides,
  };
}

const EXECUTE_FAILURE_CASES: Array<{
  name: string;
  error: Extract<
    TevuError,
    { kind: 'CancellationError' | 'PrerequisiteError' | 'CheckStateError' }
  >;
  code: number;
  stderr: string;
}> = [
  {
    name: 'cancellation',
    error: { kind: 'CancellationError', activeCaseIds: [] },
    code: 130,
    stderr: 'Cancelled.',
  },
  {
    name: 'prerequisite',
    error: { kind: 'PrerequisiteError', tool: 'fake-agent', expected: 'a fake-agent executable' },
    code: 1,
    stderr: 'error: prerequisite "fake-agent" is not satisfied; expected a fake-agent executable',
  },
  {
    name: 'check-state',
    error: {
      kind: 'CheckStateError',
      step: 'overlay',
      reason: 'overlay directory "/hidden/checks" does not exist',
    },
    code: 1,
    stderr: 'error: check-state overlay failed: overlay directory "/hidden/checks" does not exist',
  },
];

describe('tevu CLI', () => {
  registerCliTestHooks();

  describe('run dry-run', () => {
    it('prints the plan, limits, destination, and capability report with exit 0', async () => {
      const { code, out, err } = await runCli(['run', '--dry-run']);

      expect(code).toBe(0);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Dry run: no artifact, workspace, Jira call, or agent model session is created.',
        'Planned cases (2, execution order):',
        '  case-c1-task-1: task task-1, model entry c1 (provider/model-a, effort high), commit abc123def, timeout 600000ms',
        '  case-c2-task-1: task task-1, model entry c2 (provider/model-b, effort low), commit abc123def, timeout 600000ms',
        'Manual assessments needed: 2 (one tevu assess per case whose task has manual checks)',
        'Limits: concurrency 2, timeout 600000ms, stop grace 5000ms',
        'Artifact destination: /tmp/artifacts',
        'Agent "fake-agent" capabilities (opencode, detected version: 1.18.32):',
        '  run command: available',
        '  export command: available',
        '  run --format json: available',
        '  run --model: available',
        '  run --variant: available',
        '  isolation deny-outside-worktree (optional): available',
      ]);
      expect(err).toEqual([]);
    });

    it('passes the effort checks of the validation to planBenchmark', async () => {
      const efforts: EffortChecks = {
        models: {
          c1: { status: 'verified' },
          c2: { status: 'unverified', reason: 'synthetic reason' },
        },
        roles: { grader: { status: 'unsupported', reason: 'synthetic grader reason' } },
      };
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({ efforts }),
        })),
      });

      await runCli(['run', '--dry-run'], { operations });

      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildCliConfig(),
        'tevu.yaml',
        efforts,
        undefined,
      );
    });

    it.each([
      { name: 'a verified check', check: { status: 'verified' } as const, label: 'low' },
      {
        name: 'an unverified check',
        check: { status: 'unverified', reason: 'synthetic reason' } as const,
        label: 'low, unverified',
      },
      {
        name: 'an unsupported check',
        check: { status: 'unsupported', reason: 'synthetic reason' } as const,
        label: 'low, unsupported',
      },
      { name: 'no check', check: undefined, label: 'low, not checked' },
    ])('labels the effort of a planned case with $name', async ({ check, label }) => {
      const config = buildCliConfig();
      const verified: EffortCheck = { status: 'verified' };
      const operations = createOperations({
        planBenchmark: vi.fn(() =>
          buildBenchmarkPlan(config, {
            efforts: {
              models: check === undefined ? { c1: verified } : { c1: verified, c2: check },
              grader: null,
            },
          }),
        ),
      });

      const { out } = await runCli(['run', '--dry-run'], { operations });

      expect(out).toContain(
        `  case-c1-task-1: task task-1, model entry c1 (provider/model-a, effort high), commit abc123def, timeout 600000ms`,
      );
      expect(out).toContain(
        `  case-c2-task-1: task task-1, model entry c2 (provider/model-b, effort ${label}), commit abc123def, timeout 600000ms`,
      );
    });

    it('calls exactly loadConfig, validateConfig, and planBenchmark and nothing else', async () => {
      const operations = createOperations();

      const { code } = await runCli(['run', '--dry-run'], { operations });

      expect(code).toBe(0);
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith('tevu.yaml');
      expect(vi.mocked(operations.validateConfig)).toHaveBeenCalledExactlyOnceWith(
        buildCliConfig(),
      );
      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildCliConfig(),
        'tevu.yaml',
        buildEffortChecks(),
        undefined,
      );
      expect(operations.configExists).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expectNoWrites(operations);
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
    });

    it('prints the not-probed fallback when capabilities are absent', async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({ capabilities: {} }),
        })),
      });

      const { out } = await runCli(['run', '--dry-run'], { operations });

      expect(out).toContain('Agent "fake-agent" capabilities: not probed');
    });

    it('prints findings and stops before planning when validation fails', async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({
            valid: false,
            findings: [
              buildFinding({ severity: 'error', identifier: 'fake-agent', message: 'unavailable' }),
            ],
          }),
        })),
      });

      const { code, out } = await runCli(['run'], { operations });

      expect(code).toBe(1);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'error fake-agent: unavailable',
        'Configuration is invalid.',
      ]);
      expect(operations.planBenchmark).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it('maps a not-found configuration load failure to exit 1 without validating or planning', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('not-found', '/work/tevu.yaml', 'tevu.yaml'),
        })),
      });

      const { code, out, err } = await runCli(['run', '--dry-run'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found: /work/tevu.yaml',
        '  create one interactively: tevu task add --config tevu.yaml',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.validateConfig).not.toHaveBeenCalled();
      expect(operations.planBenchmark).not.toHaveBeenCalled();
    });

    it('maps a search-exhausted configuration failure to exit 1 with both searched paths and calls nothing else (V7)', async () => {
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({
          ok: false as const,
          error: configNotFoundError(['/work/tevu.yaml', '/home/u/.config/tevu/tevu.yaml']),
        })),
      });

      const { code, out, err } = await runCli(['run', '--dry-run'], { operations });

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
      expect(operations.validateConfig).not.toHaveBeenCalled();
      expect(operations.planBenchmark).not.toHaveBeenCalled();
    });
  });

  describe('repository preparation (AC-9, AC-10)', () => {
    it.each([{ argv: ['run', '--dry-run'] }, { argv: ['run'] }])(
      'prints preparation progress and warning lines before validation output for tevu $argv',
      async ({ argv }) => {
        const operations = createOperations({
          prepareRepositories: vi.fn(async (_config, onProgress: (line: string) => void) => {
            onProgress(
              'Cloning github.com/octo/app for repository "repo-1" into /cache/github.com/octo/app.git',
            );
            return {
              ok: true as const,
              value: [
                {
                  severity: 'warning' as const,
                  identifier: 'tasks.task-1.reference',
                  message:
                    'reference commits cannot be fetched from github.com/octo/app: git fetch timed out',
                },
              ],
            };
          }),
        });

        const { code, out } = await runCli(argv, { operations });

        expect(code).toBe(0);
        expect(out.slice(0, 3)).toEqual([
          'Configuration: tevu.yaml',
          'Cloning github.com/octo/app for repository "repo-1" into /cache/github.com/octo/app.git',
          'warning tasks.task-1.reference: reference commits cannot be fetched from github.com/octo/app: git fetch timed out',
        ]);
        expect(vi.mocked(operations.prepareRepositories)).toHaveBeenCalledExactlyOnceWith(
          buildCliConfig(),
          expect.any(Function),
        );
        expect(vi.mocked(operations.validateConfig)).toHaveBeenCalledOnce();
      },
    );

    it('maps a ManagedCloneError from prepareRepositories to exit 1 and never validates', async () => {
      const operations = createOperations({
        prepareRepositories: vi.fn(async () => ({
          ok: false as const,
          error: {
            kind: 'ManagedCloneError' as const,
            operation: 'clone' as const,
            repository: 'github.com/octo/app',
            reason: 'git clone exited with code 128',
          },
        })),
      });

      const { code, out, err } = await runCli(['run', '--dry-run'], { operations });

      expect(code).toBe(1);
      expect(out).toEqual(['Configuration: tevu.yaml']);
      expect(err).toEqual([
        'error: cloning github.com/octo/app failed: git clone exited with code 128',
      ]);
      expect(operations.validateConfig).not.toHaveBeenCalled();
      expect(operations.planBenchmark).not.toHaveBeenCalled();
    });

    it('renders a Git LFS fetch failure from prepareRepositories as the failure it is, exits 1, and never validates', async () => {
      const operations = createOperations({
        prepareRepositories: vi.fn(async () => ({
          ok: false as const,
          error: {
            kind: 'ManagedCloneError' as const,
            operation: 'lfs-fetch' as const,
            repository: 'github.com/octo/app',
            reason: 'Git LFS is not installed or not on PATH; install it from https://git-lfs.com',
          },
        })),
      });

      const { code, err } = await runCli(['run', '--dry-run'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: fetching Git LFS objects from github.com/octo/app failed: Git LFS is not installed or not on PATH; install it from https://git-lfs.com',
      ]);
      expect(operations.validateConfig).not.toHaveBeenCalled();
    });

    it('maps a CancellationError from prepareRepositories to exit 130', async () => {
      const operations = createOperations({
        prepareRepositories: vi.fn(async () => ({
          ok: false as const,
          error: { kind: 'CancellationError' as const, activeCaseIds: [] },
        })),
      });

      const { code, err } = await runCli(['run'], { operations });

      expect(code).toBe(130);
      expect(err).toEqual(['Cancelled.']);
      expect(operations.validateConfig).not.toHaveBeenCalled();
    });
  });

  describe('run --repeat', () => {
    it.each(['0', '00', 'abc', '1.5', '-1', '+3', ' 3', '1e3', '101', '100000000', ''])(
      'rejects %j with exit code 1 before any ProgramOperations call (AC-4, verification properties 8, 9)',
      async (value) => {
        const operations = createOperations();

        const { code, out, err } = await runCli(['run', '--repeat', value], { operations });

        expect(code).toBe(1);
        expect(err[0]).toBe(
          `error: option '--repeat <n>' argument '${value}' is invalid. Expected a whole number from 1 to 100.`,
        );
        expect(err[1]).toBe('Usage: tevu run [options]');
        expect(out).toEqual([]);
        expect(operations.loadConfig).not.toHaveBeenCalled();
        expect(operations.validateConfig).not.toHaveBeenCalled();
        expect(operations.planBenchmark).not.toHaveBeenCalled();
      },
    );

    it.each([
      { literal: '3', value: 3 },
      { literal: '03', value: 3 },
      { literal: '100', value: 100 },
    ])(
      'accepts --repeat $literal and passes $value to planBenchmark',
      async ({ literal, value }) => {
        const operations = createOperations();

        const { code } = await runCli(['run', '--dry-run', '--repeat', literal], { operations });

        expect(code).toBe(0);
        expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
          buildCliConfig(),
          'tevu.yaml',
          buildEffortChecks(),
          value,
        );
      },
    );

    it('passes 100 to planBenchmark for tevu run --dry-run --repeat 100 (AC-14)', async () => {
      const operations = createOperations();

      const { code } = await runCli(['run', '--dry-run', '--repeat', '100'], { operations });

      expect(code).toBe(0);
      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildCliConfig(),
        'tevu.yaml',
        buildEffortChecks(),
        100,
      );
    });

    it.each(['101', '100000000'])(
      'ends tevu run --repeat %s with exit code 1 before any ProgramOperations call (AC-14)',
      async (value) => {
        const operations = createOperations();

        const { code } = await runCli(['run', '--repeat', value], { operations });

        expect(code).toBe(1);
        expect(operations.planBenchmark).not.toHaveBeenCalled();
      },
    );

    it('accepts the --repeat=<n> form', async () => {
      const operations = createOperations();

      const { code } = await runCli(['run', '--dry-run', '--repeat=5'], { operations });

      expect(code).toBe(0);
      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildCliConfig(),
        'tevu.yaml',
        buildEffortChecks(),
        5,
      );
    });

    it('keeps the last value when --repeat is repeated', async () => {
      const operations = createOperations();

      const { code } = await runCli(['run', '--dry-run', '--repeat', '2', '--repeat', '7'], {
        operations,
      });

      expect(code).toBe(0);
      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildCliConfig(),
        'tevu.yaml',
        buildEffortChecks(),
        7,
      );
    });

    it('prints the manual-assessments line after the planned-case list and before Limits, for 2 tasks, 2 model entries, and repeat 3 with one manual-checked task (AC-8)', async () => {
      const manualTask = buildCliTaskInput({ id: 'task-1' });
      const commandOnlyTask = buildCliTaskInput({
        id: 'task-2',
        checks: {
          acceptance: [
            {
              id: 'acc-2',
              description: 'acceptance command exits zero',
              run: ['/synthetic/acceptance-probe'],
              timeout: '5s',
              exit_codes: [0],
            },
          ],
          done: [
            {
              id: 'dod-2',
              description: 'done command exits zero',
              run: ['/synthetic/done-probe'],
              timeout: '5s',
              exit_codes: [0],
            },
          ],
        },
      });
      const config = buildCliConfig({ tasks: [manualTask, commandOnlyTask] });
      const cases = Array.from({ length: 3 }, (_, index) => index + 1).flatMap((attempt) =>
        config.tasks.flatMap((task) =>
          config.models.map((model) => ({
            caseId: `${task.id}--${model.id}--${attempt}`,
            taskId: task.id,
            modelId: model.id,
            attempt,
            sourceCommit: 'abc123def',
            model: model.model,
            effort: model.effort,
            agent: model.agent,
            timeoutMs: 600_000,
          })),
        ),
      );
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({ ok: true as const, value: config })),
        planBenchmark: vi.fn(() =>
          buildBenchmarkPlan(config, { cases, repeat: { value: 3, source: 'cli' } }),
        ),
      });

      const { out } = await runCli(['run', '--dry-run', '--repeat', '3'], { operations });

      const plannedIndex = out.findIndex((line) => line.startsWith('Planned cases'));
      const manualIndex = out.indexOf(
        'Manual assessments needed: 6 (one tevu assess per case whose task has manual checks)',
      );
      const limitsIndex = out.findIndex((line) => line.startsWith('Limits:'));
      expect(plannedIndex).toBeGreaterThan(-1);
      expect(manualIndex).toBeGreaterThan(plannedIndex);
      expect(limitsIndex).toBeGreaterThan(manualIndex);
    });
  });

  describe('run execution', () => {
    it('prints the run header, the redacted summary of the rebuilt report, then the artifact and report paths, and returns the run exit code', async () => {
      let loadedConfig: TevuConfig | undefined;
      const operations = createOperations({
        loadConfig: vi.fn(async () => {
          const config = buildCliConfig();
          loadedConfig = config;
          return { ok: true as const, value: config };
        }),
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          hooks.onRunId?.('run-1');
          return { ok: true as const, value: buildRunResult() };
        }),
        rebuildRunReport: vi.fn(async () => ({
          ok: true as const,
          value: {
            retainedDirectories: [],
            report: buildReportResult({
              summary: {
                attempts: [
                  {
                    caseId: 'case-c1-task-1',
                    lines: [
                      'vendor/model-a, high on "Fix the export": pending; required checks 1/2 passed, 1 pending.',
                      "  1 required manual check waits for a person's verdict. Technical detail: case case-c1-task-1: TOKEN-VALUE",
                    ],
                  },
                  {
                    caseId: 'case-c2-task-1',
                    lines: [
                      'vendor/model-b, high on "Fix the export": passed; required checks 2/2 passed.',
                    ],
                  },
                ],
                findings: [
                  'Warning for vendor/model-a, high on "Fix the export": diagnostics truncated',
                  'Error: cleanup failed for TOKEN-VALUE',
                ],
              },
            }),
          },
        })),
      });

      const { code, out, err } = await runCli(['run'], {
        operations,
        redact: (text) => text.replaceAll('TOKEN-VALUE', '[redacted]'),
      });

      expect(code).toBe(0);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Run run-1 started.',
        'vendor/model-a, high on "Fix the export": pending; required checks 1/2 passed, 1 pending.',
        "  1 required manual check waits for a person's verdict. Technical detail: case case-c1-task-1: [redacted]",
        'vendor/model-b, high on "Fix the export": passed; required checks 2/2 passed.',
        'Warning for vendor/model-a, high on "Fix the export": diagnostics truncated',
        'Error: cleanup failed for [redacted]',
        'Artifacts: /tmp/artifacts/run-1',
        'Summary: /tmp/artifacts/run-1/summary.md',
        'Report: /tmp/artifacts/run-1/report.md',
      ]);
      expect(err).toEqual([]);
      expect(vi.mocked(operations.rebuildRunReport)).toHaveBeenCalledExactlyOnceWith(
        loadedConfig,
        'run-1',
        'write',
      );
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
    });

    describe('summary-call directories that could not be deleted', () => {
      function retainedWarning(directory: string): string {
        return `Warning: tevu could not delete the temporary directory of a summary call. The results are not affected. Delete ${directory} when no tevu command uses it.`;
      }

      function operationsRetaining(directories: string[], exitCode: RunResult['exitCode'] = 0) {
        return createOperations({
          executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
            hooks.onRunId?.('run-1');
            return { ok: true as const, value: buildRunResult({ exitCode }) };
          }),
          rebuildRunReport: vi.fn(async () => ({
            ok: true as const,
            value: {
              retainedDirectories: directories,
              report: buildReportResult({
                summary: { attempts: [], findings: ['Warning: diagnostics truncated'] },
              }),
            },
          })),
        });
      }

      it('prints one warning line per directory after the run findings and before the artifact paths', async () => {
        const operations = operationsRetaining(['/tmp/tevu-call-aaa', '/tmp/tevu-call-bbb']);

        const { code, out, err } = await runCli(['run'], { operations });

        expect(code).toBe(0);
        expect(out).toEqual([
          'Configuration: tevu.yaml',
          'Run run-1 started.',
          'Warning: diagnostics truncated',
          retainedWarning('/tmp/tevu-call-aaa'),
          retainedWarning('/tmp/tevu-call-bbb'),
          'Artifacts: /tmp/artifacts/run-1',
          'Summary: /tmp/artifacts/run-1/summary.md',
          'Report: /tmp/artifacts/run-1/report.md',
        ]);
        expect(err).toEqual([]);
      });

      it('prints no warning when no directory was retained', async () => {
        const operations = operationsRetaining([]);

        const { out } = await runCli(['run'], { operations });

        expect(out.filter((line) => line.includes('summary call'))).toEqual([]);
      });

      it('redacts a secret inside a retained directory path', async () => {
        const operations = operationsRetaining(['/tmp/tevu-call-TOKEN-VALUE']);

        const { out } = await runCli(['run'], {
          operations,
          redact: (text) => text.replaceAll('TOKEN-VALUE', '[redacted]'),
        });

        expect(out).toContain(retainedWarning('/tmp/tevu-call-[redacted]'));
        expect(out.join('\n')).not.toContain('TOKEN-VALUE');
      });

      it('keeps the exit code of the run', async () => {
        const operations = operationsRetaining(['/tmp/tevu-call-aaa'], 2);

        const { code } = await runCli(['run'], { operations });

        expect(code).toBe(2);
      });
    });

    it('passes the same absolute path to planBenchmark that it prints in the Configuration line (AC-3)', async () => {
      const foundPath = '/home/u/.config/tevu/tevu.yaml';
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({ ok: true as const, value: foundPath })),
      });

      const { out } = await runCli(['run'], { operations });

      expect(out[0]).toBe(`Configuration: ${foundPath}`);
      expect(vi.mocked(operations.planBenchmark)).toHaveBeenCalledExactlyOnceWith(
        buildCliConfig(),
        foundPath,
        buildEffortChecks(),
        undefined,
      );
    });

    it('wires the shared cancellation and run-id hook and withholds lifecycle progress on non-TTY output', async () => {
      let captured: BenchmarkExecutionHooks | undefined;
      const cancellation = new AbortController().signal;
      const operations = createOperations({
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          captured = hooks;
          return { ok: true as const, value: buildRunResult() };
        }),
      });

      const { code, out } = await runCli(['run'], { io: createIo(), operations, cancellation });

      expect(code).toBe(0);
      expect(captured?.cancellation).toBe(cancellation);
      expect(captured?.onRunId).toBeTypeOf('function');
      expect(captured?.onLifecycle).toBeUndefined();
      expect(out.join('')).not.toContain('[case-');
    });

    it('emits case-prefixed lifecycle progress on a TTY stdout', async () => {
      const operations = createOperations({
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          hooks.onRunId?.('run-1');
          hooks.onLifecycle?.('case-c1-task-1', 'running');
          hooks.onLifecycle?.('case-c1-task-1', 'completed');
          return { ok: true as const, value: buildRunResult() };
        }),
      });

      const { code, out } = await runCli(['run'], {
        io: createIo({ stdin: true, stdout: true }),
        operations,
      });

      expect(code).toBe(0);
      expect(out).toContain('[case-c1-task-1] running');
      expect(out).toContain('[case-c1-task-1] completed');
      expect(out.join('\n')).not.toContain('lifecycle completed');
    });

    it('preserves exit code 2 for a passed run with a recorded runtime failure', async () => {
      const operations = createOperations({
        executeBenchmark: vi.fn(async () => ({
          ok: true as const,
          value: buildRunResult({
            exitCode: 2,
            cases: [
              buildCliCaseResult({
                lifecycle: 'process-failed',
                outcome: 'passed',
                failure: {
                  error: {
                    kind: 'AgentProcessError',
                    agent: 'fake-agent',
                    caseId: 'case-c1-task-1',
                    exitCode: 1,
                    signal: null,
                  },
                  occurredAt: '2026-09-23T10:02:00.000Z',
                },
              }),
            ],
          }),
        })),
      });

      const { code, out } = await runCli(['run'], { operations });

      expect(code).toBe(2);
      expect(out).toContain('Report: /tmp/artifacts/run-1/report.md');
      expect(operations.rebuildRunReport).toHaveBeenCalledOnce();
    });

    it('skips the report rebuild, prints no summary, and names the recovery command for a cancelled run', async () => {
      const operations = createOperations({
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          hooks.onRunId?.('run-1');
          return {
            ok: true as const,
            value: buildRunResult({
              exitCode: 130,
              findings: [buildRunFinding({ message: 'queued attempt never started' })],
            }),
          };
        }),
      });

      const { code, out } = await runCli(['run'], { operations });

      expect(code).toBe(130);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Run run-1 started.',
        'Artifacts: /tmp/artifacts/run-1',
        'Run cancelled; partial artifacts were finalized. Regenerate the report with: tevu report run-1',
      ]);
      expect(operations.rebuildRunReport).not.toHaveBeenCalled();
    });

    it('prints the retained grading call directories of a cancelled run before its artifacts', async () => {
      const operations = createOperations({
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          hooks.onRunId?.('run-1');
          hooks.onRetainedGradingDirectory?.('/tmp/tevu-call-a');
          hooks.onRetainedGradingDirectory?.('/tmp/tevu-call-b');
          return { ok: true as const, value: buildRunResult({ exitCode: 130 }) };
        }),
      });

      const { code, out } = await runCli(['run'], { operations });

      expect(code).toBe(130);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Run run-1 started.',
        'Warning: tevu could not delete the temporary directory of a grading call. The results are not affected. Delete /tmp/tevu-call-a when no tevu command uses it.',
        'Warning: tevu could not delete the temporary directory of a grading call. The results are not affected. Delete /tmp/tevu-call-b when no tevu command uses it.',
        'Artifacts: /tmp/artifacts/run-1',
        'Run cancelled; partial artifacts were finalized. Regenerate the report with: tevu report run-1',
      ]);
    });

    it('downgrades to exit 1 with the recovery hint when the rebuild fails', async () => {
      const operations = createOperations({
        executeBenchmark: vi.fn(async (_plan: BenchmarkPlan, hooks: BenchmarkExecutionHooks) => {
          hooks.onRunId?.('run-1');
          return { ok: true as const, value: buildRunResult() };
        }),
        rebuildRunReport: vi.fn(async () => ({
          ok: false as const,
          error: artifactError('rebuild-report', 'run directory vanished'),
        })),
      });

      const { code, out, err } = await runCli(['run'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: artifact operation "rebuild-report" failed: run directory vanished',
        'The report could not be generated; recover with: tevu report run-1',
      ]);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Run run-1 started.',
        'Artifacts: /tmp/artifacts/run-1',
      ]);
    });

    it.each(EXECUTE_FAILURE_CASES)(
      'maps the $name failure of executeBenchmark to exit $code without a rebuild',
      async ({ error, code, stderr }) => {
        const operations = createOperations({
          executeBenchmark: vi.fn(async () => ({ ok: false as const, error })),
        });

        const { code: exitCode, err } = await runCli(['run'], { operations });

        expect(exitCode).toBe(code);
        expect(err[0]).toBe(stderr);
        expect(operations.rebuildRunReport).not.toHaveBeenCalled();
      },
    );
  });
});
