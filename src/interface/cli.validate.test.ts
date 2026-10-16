// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  buildCliConfig,
  buildFinding,
  buildValidationReport,
  configNotFoundError,
  configReadError,
  createOperations,
  registerCliTestHooks,
  runCli,
} from './__fixtures__/program.fixtures';

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

function prerequisiteError(
  tool: string,
  expected: string,
): Extract<TevuError, { kind: 'PrerequisiteError' }> {
  return { kind: 'PrerequisiteError', tool, expected };
}

const CONFIG_HONORING_CASES: Array<{ command: string[] }> = [
  { command: ['validate'] },
  { command: ['run', '--dry-run'] },
  { command: ['report', 'run-1'] },
];

describe('tevu CLI', () => {
  registerCliTestHooks();

  describe('validate', () => {
    it('prints every finding and the valid verdict with exit 0', async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({ findings: [buildFinding()] }),
        })),
      });

      const { code, out, err } = await runCli(['validate'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'warning task-1: description is thin',
        'Configuration is valid.',
      ]);
      expect(err).toEqual([]);
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith('tevu.yaml');
      expect(vi.mocked(operations.validateConfig)).toHaveBeenCalledExactlyOnceWith(
        buildCliConfig(),
      );
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
    });

    it('never calls prepareRepositories and prints no progress line (AC-10)', async () => {
      const operations = createOperations();

      const { out } = await runCli(['validate'], { operations });

      expect(out).toEqual(['Configuration: tevu.yaml', 'Configuration is valid.']);
      expect(operations.prepareRepositories).not.toHaveBeenCalled();
    });

    it('prints the invalid verdict with exit 1 and plans nothing', async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildValidationReport({
            valid: false,
            findings: [
              buildFinding({ severity: 'error', identifier: 'fake-agent', message: 'missing' }),
            ],
            capabilities: {},
          }),
        })),
      });

      const { code, out } = await runCli(['validate'], { operations });

      expect(code).toBe(1);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'error fake-agent: missing',
        'Configuration is invalid.',
      ]);
      expect(operations.planBenchmark).not.toHaveBeenCalled();
    });

    it('maps a not-found configuration load failure to exit 1 with both creation hints and skips validation', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('not-found', '/work/tevu.yaml', 'tevu.yaml'),
        })),
      });

      const { code, out, err } = await runCli(['validate'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found: /work/tevu.yaml',
        '  create one interactively: tevu task add --config tevu.yaml',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.validateConfig).not.toHaveBeenCalled();
    });

    it('maps a search-exhausted configuration failure to exit 1 with both searched paths and calls nothing else (V7)', async () => {
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({
          ok: false as const,
          error: configNotFoundError(['/work/tevu.yaml', '/home/u/.config/tevu/tevu.yaml']),
        })),
      });

      const { code, out, err } = await runCli(['validate'], { operations });

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
    });

    it.each([
      {
        cause: 'permission-denied' as const,
        line: 'error: cannot read configuration file /work/tevu.yaml: permission denied',
      },
      {
        cause: 'not-a-file' as const,
        line: 'error: configuration path is not a file: /work/tevu.yaml',
      },
      {
        cause: 'unreadable' as const,
        line: 'error: cannot read configuration file /work/tevu.yaml',
      },
    ])(
      'maps a $cause configuration load failure to exit 1 with only the cause line',
      async ({ cause, line }) => {
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({
            ok: false as const,
            error: configReadError(cause, '/work/tevu.yaml', 'tevu.yaml'),
          })),
        });

        const { code, out, err } = await runCli(['validate'], { operations });

        expect(code).toBe(1);
        expect(err).toEqual([line]);
        expect(out).toEqual([]);
        expect(operations.validateConfig).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        description: 'the explicit path tevu.yaml',
        requestedPath: 'tevu.yaml',
        taskAddHint: '  create one interactively: tevu task add --config tevu.yaml',
        templateHint: '  or start from the template: tevu config example > tevu.yaml',
      },
      {
        description: 'an absolute path outside the current directory',
        requestedPath: '/nonexistent/tevu.yaml',
        taskAddHint: '  create one interactively: tevu task add --config /nonexistent/tevu.yaml',
        templateHint: '  or start from the template: tevu config example > /nonexistent/tevu.yaml',
      },
      {
        description: 'a path containing a space',
        requestedPath: 'my bench/tevu.yaml',
        taskAddHint: "  create one interactively: tevu task add --config 'my bench/tevu.yaml'",
        templateHint: "  or start from the template: tevu config example > 'my bench/tevu.yaml'",
      },
      {
        description: 'a path containing a single quote',
        requestedPath: "it's.yaml",
        taskAddHint: "  create one interactively: tevu task add --config 'it'\\''s.yaml'",
        templateHint: "  or start from the template: tevu config example > 'it'\\''s.yaml'",
      },
    ])(
      'renders the not-found creation hints for $description',
      async ({ requestedPath, taskAddHint, templateHint }) => {
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({
            ok: false as const,
            error: configReadError('not-found', `/home/u/${requestedPath}`, requestedPath),
          })),
        });

        const { err } = await runCli(['validate', '--config', requestedPath], { operations });

        expect(err[1]).toBe(taskAddHint);
        expect(err[2]).toBe(templateHint);
      },
    );

    it('maps a validation prerequisite failure to exit 1', async () => {
      const operations = createOperations({
        validateConfig: vi.fn(async () => ({
          ok: false as const,
          error: prerequisiteError('git', 'a git executable'),
        })),
      });

      const { code, err } = await runCli(['validate'], { operations });

      expect(code).toBe(1);
      expect(err[0]).toBe('error: prerequisite "git" is not satisfied; expected a git executable');
    });

    it.each([
      {
        description: 'an empty restore pattern (R1)',
        identifier: 'tasks.0.checks.restore.0',
        message: 'restore pattern must not be empty',
      },
      {
        description: 'an overlay inside a configured repository (V2)',
        identifier: 'tasks.write-report.checks.overlay',
        message: 'overlay must be outside repository "sample-repo" after real-path resolution',
      },
    ])(
      'exits 1 for both validate and run when loadConfig reports $description',
      async ({ identifier, message }) => {
        for (const command of [['validate'], ['run']]) {
          const operations = createOperations({
            loadConfig: vi.fn(async () => ({
              ok: false as const,
              error: {
                kind: 'ConfigValidationError' as const,
                findings: [{ severity: 'error' as const, identifier, message }],
              },
            })),
          });

          const { code, err } = await runCli(command, { operations });

          expect(code).toBe(1);
          expect(err).toEqual([
            'error: the configuration is invalid',
            `  error ${identifier}: ${message}`,
          ]);
        }
      },
    );

    it.each([
      {
        description: 'a missing overlay directory (V1)',
        identifier: 'tasks.write-report.checks.overlay',
        message: 'overlay directory "/hidden/checks" does not exist',
      },
      {
        description: 'an overlay directory holding a symbolic link (V3)',
        identifier: 'tasks.write-report.checks.overlay',
        message:
          'overlay directory "/hidden/checks" must contain only regular files and directories; "link" is a symbolic link',
      },
    ])(
      'exits 1 for both validate and run when validateConfig reports $description',
      async ({ identifier, message }) => {
        for (const command of [['validate'], ['run']]) {
          const operations = createOperations({
            validateConfig: vi.fn(async () => ({
              ok: true as const,
              value: buildValidationReport({
                valid: false,
                findings: [{ severity: 'error' as const, identifier, message }],
                capabilities: {},
              }),
            })),
          });

          const { code, out } = await runCli(command, { operations });

          expect(code).toBe(1);
          expect(out).toEqual([
            'Configuration: tevu.yaml',
            `error ${identifier}: ${message}`,
            'Configuration is invalid.',
          ]);
          expect(operations.planBenchmark).not.toHaveBeenCalled();
        }
      },
    );

    it.each(CONFIG_HONORING_CASES)('reads $command with the --config path', async ({ command }) => {
      const operations = createOperations();

      const { code } = await runCli([...command, '--config', 'custom.yaml'], { operations });

      expect(code).toBe(0);
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith('custom.yaml');
    });

    it.each([
      {
        description: 'a duration outside its grammar',
        identifier: 'run.timeout',
        message:
          'must be a positive whole number followed by ms, s, m, or h, for example 30s or 10m',
      },
      {
        description: 'a duration above its millisecond bound',
        identifier: 'run.timeout',
        message: 'must be at most 2147483647ms',
      },
      {
        description: 'a variable name outside its grammar',
        identifier: 'agents.opencode.secrets.0',
        message: 'must be a letter or underscore followed by letters, digits, or underscores',
      },
      {
        description: 'a Jira credential that is not a $VARIABLE reference',
        identifier: 'trackers.jira.token',
        message:
          'must be a $VARIABLE reference, for example $JIRA_API_TOKEN; secret values are never written here',
      },
    ])(
      'renders the $description finding message from a failed configuration load',
      async ({ identifier, message }) => {
        const operations = createOperations({
          loadConfig: vi.fn(async () => ({
            ok: false as const,
            error: {
              kind: 'ConfigValidationError' as const,
              findings: [{ severity: 'error' as const, identifier, message }],
            },
          })),
        });

        const { code, err } = await runCli(['validate'], { operations });

        expect(code).toBe(1);
        expect(err).toEqual([
          'error: the configuration is invalid',
          `  error ${identifier}: ${message}`,
        ]);
      },
    );
  });
});
