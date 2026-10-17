// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { CONFIG_TEMPLATE } from '@/config/template';

import {
  buildAssessmentContext,
  buildCliConfig,
  buildManualCheckSummary,
  configReadError,
  createDependencies,
  createIo,
  createOperations,
  expectNoWrites,
  MemoryStream,
  registerCliTestHooks,
  runCli,
  TEST_VERSION,
} from './__fixtures__/program.fixtures';
import { clack, scriptAnswers } from './__fixtures__/scripted-prompts.fixtures';
import {
  buildCriteriaConfig,
  buildResolvedCommitReference,
  READY_ANSWERS,
} from './__fixtures__/task-wizard.fixtures';
import { createProgram } from './program';

import type { ProgramOperations } from './__fixtures__/program.fixtures';
import type { ProgramDependencies } from './program';
import type { Mock } from 'vitest';

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

const HELP_CASES: Array<{ argv: string[]; description: string; usage: string }> = [
  {
    argv: [],
    description: 'Compare coding models on your tasks',
    usage: 'Usage:\n  tevu [options]\n  tevu <command> [options]',
  },
  {
    argv: ['config'],
    description: 'Work with the configuration file',
    usage: 'Usage:\n  tevu config [options]\n  tevu config <command> [options]',
  },
  {
    argv: ['config', 'example'],
    description: 'Print a commented configuration template',
    usage: 'Usage:\n  tevu config example [options]',
  },
  {
    argv: ['task'],
    description: 'Manage benchmark tasks',
    usage: 'Usage:\n  tevu task [options]\n  tevu task <command> [options]',
  },
  {
    argv: ['task', 'add'],
    description: 'Add a benchmark task',
    usage: 'Usage:\n  tevu task add [options]',
  },
  {
    argv: ['validate'],
    description: 'Check configuration and prerequisites',
    usage: 'Usage:\n  tevu validate [options]',
  },
  {
    argv: ['run'],
    description: 'Run the benchmark',
    usage: 'Usage:\n  tevu run [options]',
  },
  {
    argv: ['assess'],
    description: 'Record manual and graded check verdicts',
    usage: 'Usage:\n  tevu assess <run-id> <case-id> [options]',
  },
  {
    argv: ['report'],
    description: 'Regenerate a report from a saved run',
    usage: 'Usage:\n  tevu report <run-id> [options]',
  },
];

const USAGE_ERROR_CASES: Array<{ argv: string[]; error: string; usage: string }> = [
  {
    argv: ['frobnicate'],
    error: "error: unknown command 'frobnicate'",
    usage: 'Usage: tevu [options] [command]',
  },
  {
    argv: ['assess'],
    error: "error: missing required argument 'run-id'",
    usage: 'Usage: tevu assess [options] <run-id> <case-id>',
  },
  {
    argv: ['assess', 'run-1'],
    error: "error: missing required argument 'case-id'",
    usage: 'Usage: tevu assess [options] <run-id> <case-id>',
  },
  {
    argv: ['run', '--bogus'],
    error: "error: unknown option '--bogus'",
    usage: 'Usage: tevu run [options]',
  },
  {
    argv: ['-V'],
    error: "error: unknown option '-V'",
    usage: 'Usage: tevu [options] [command]',
  },
  {
    argv: ['config', 'example', 'extra'],
    error: "error: too many arguments for 'example'. Expected 0 arguments but got 1: extra.",
    usage: 'Usage: tevu config example [options]',
  },
  {
    argv: ['config', 'example', '--config', 'x'],
    error: "error: unknown option '--config'",
    usage: 'Usage: tevu config example [options]',
  },
];

const TTY_REJECTION_CASES: Array<{ stdin: boolean; stdout: boolean; actual: string }> = [
  { stdin: false, stdout: false, actual: 'stdin and stdout are not a TTY' },
  { stdin: false, stdout: true, actual: 'stdin is not a TTY' },
  { stdin: true, stdout: false, actual: 'stdout is not a TTY' },
];

describe('tevu CLI', () => {
  registerCliTestHooks();

  describe('command surface', () => {
    it('registers exactly the six top-level commands with add as the only task subcommand', () => {
      const program = createProgram(createDependencies());

      expect(program.commands.map((command) => command.name())).toEqual([
        'task',
        'validate',
        'run',
        'assess',
        'report',
        'config',
      ]);
      expect(program.commands[0]?.commands.map((command) => command.name())).toEqual(['add']);
    });

    it('registers --config with no default and the per-command options', () => {
      const program = createProgram(createDependencies());
      const run = program.commands.find((command) => command.name() === 'run');
      const add = program.commands[0]?.commands[0];

      expect(run?.options.map((option) => option.long)).toEqual([
        '--config',
        '--dry-run',
        '--repeat',
      ]);
      expect(run?.options[0]?.defaultValue).toBeUndefined();
      expect(add?.options.map((option) => option.long)).toEqual(['--config', '--jira', '--github']);
    });

    it.each(['task add', 'validate', 'run', 'assess', 'report'])(
      'gives every --config option the search description with no default text (V12, AC-10)',
      (commandName) => {
        const program = createProgram(createDependencies());
        const [group, sub] = commandName.split(' ');
        const command =
          sub === undefined
            ? program.commands.find((entry) => entry.name() === group)
            : program.commands
                .find((entry) => entry.name() === group)
                ?.commands.find((entry) => entry.name() === sub);
        const option = command?.options.find((entry) => entry.long === '--config');

        expect(option?.description).toBe(
          'Configuration file path; without it, tevu searches ./tevu.yaml, then ' +
            '$XDG_CONFIG_HOME/tevu/tevu.yaml (or $HOME/.config/tevu/tevu.yaml when ' +
            'XDG_CONFIG_HOME is not an absolute path)',
        );
        expect(option?.description).not.toContain('(default:');
      },
    );

    it('requires both run-id and case-id arguments on assess', () => {
      const program = createProgram(createDependencies());
      const assess = program.commands.find((command) => command.name() === 'assess');

      expect(assess?.registeredArguments.map((argument) => argument.name())).toEqual([
        'run-id',
        'case-id',
      ]);
      expect(assess?.registeredArguments.every((argument) => argument.required)).toBe(true);
    });
  });

  describe('version', () => {
    const VERSION_CASES: Array<{ argv: string[] }> = [
      { argv: ['--version'] },
      { argv: ['task', '--version'] },
      { argv: ['task', 'add', '--version'] },
      { argv: ['task', 'add', '--jira', 'ABC-1', '--version'] },
      { argv: ['validate', '--version'] },
      { argv: ['validate', '--config', 'tevu.yaml', '--version'] },
      { argv: ['run', '--version'] },
      { argv: ['run', '--dry-run', '--repeat', '2', '--version'] },
      { argv: ['assess', '--version'] },
      { argv: ['assess', 'run-1', 'case-1', '--version'] },
      { argv: ['report', '--version'] },
      { argv: ['report', 'run-1', '--version'] },
      { argv: ['config', '--version'] },
      { argv: ['config', 'example', '--version'] },
      { argv: ['--help', '--version'] },
      { argv: ['--version', '--help'] },
    ];

    function expectNoOperationCalledAtAll(operations: ProgramOperations): void {
      for (const [name, operation] of Object.entries(operations)) {
        expect(operation, name).not.toHaveBeenCalled();
      }
    }

    it.each(VERSION_CASES)(
      'prints only the version with exit 0 and no stderr for $argv',
      async ({ argv }) => {
        const { code, dependencies } = await runCli(argv);

        expect(code).toBe(0);
        expect((dependencies.io.stdout as MemoryStream).text).toBe(`${TEST_VERSION}\n`);
        expect((dependencies.io.stderr as MemoryStream).text).toBe('');
      },
    );

    it.each(VERSION_CASES)('calls no operation for $argv', async ({ argv }) => {
      const operations = createOperations();

      const { code } = await runCli(argv, { operations });

      expect(code).toBe(0);
      expectNoOperationCalledAtAll(operations);
    });

    it('passes the version line through the injected redactor', async () => {
      const { code, dependencies } = await runCli(['--version'], {
        redact: (text) => text.replaceAll(TEST_VERSION, '[redacted]'),
      });

      expect(code).toBe(0);
      expect((dependencies.io.stdout as MemoryStream).text).toBe('[redacted]\n');
    });

    it('registers --version on the root without a short flag', () => {
      const program = createProgram(createDependencies());

      const option = program.options.find((entry) => entry.long === '--version');

      expect(option?.flags).toBe('--version');
    });
  });

  describe('config example', () => {
    function expectNoOperationCalled(operations: ProgramOperations): void {
      expect(operations.locateConfig).not.toHaveBeenCalled();
      expect(operations.configExists).not.toHaveBeenCalled();
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expect(operations.validateConfig).not.toHaveBeenCalled();
      expect(operations.planBenchmark).not.toHaveBeenCalled();
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
      expectNoWrites(operations);
    }

    it.each([
      { label: 'TTY stdout', stdout: true },
      { label: 'non-TTY stdout', stdout: false },
    ])('prints the template verbatim with exit 0 and no stderr ($label)', async ({ stdout }) => {
      const operations = createOperations();

      const { code, dependencies, err } = await runCli(['config', 'example'], {
        io: createIo({ stdin: true, stdout }),
        operations,
      });

      expect(code).toBe(0);
      expect((dependencies.io.stdout as MemoryStream).text).toBe(CONFIG_TEMPLATE);
      expect(err).toEqual([]);
      expectNoOperationCalled(operations);
    });

    it('passes the template through the injected redactor', async () => {
      const { dependencies } = await runCli(['config', 'example'], {
        redact: (text) => text.replaceAll('OPENAI_API_KEY', '[redacted]'),
      });

      const stdout = (dependencies.io.stdout as MemoryStream).text;
      expect(stdout).toContain('[redacted]');
      expect(stdout).not.toContain('OPENAI_API_KEY');
    });

    it('prints roles.criteria before roles.grader (AC-13)', async () => {
      const { dependencies } = await runCli(['config', 'example']);

      const printed = (dependencies.io.stdout as MemoryStream).text;
      expect(printed.indexOf('  criteria:')).toBeLessThan(printed.indexOf('  grader:'));
    });
  });

  describe('help', () => {
    it.each(HELP_CASES)(
      'prints description-first help for $description',
      async ({ argv, description, usage }) => {
        const { code, dependencies, err } = await runCli([...argv, '--help']);
        const help = (dependencies.io.stdout as MemoryStream).text;

        expect(code).toBe(0);
        expect(help.startsWith(`${description}\n\n${usage}\n\n`)).toBe(true);
        expect(help).not.toMatch(/opencode|Sensitive data:|Isolation boundary:/i);
        expect(help).toMatch(/-h, --help\s+Show help\n/);
        expect(help).not.toMatch(/\.\s*$/m);
        expect(help).not.toContain('(default:');
        expect(err).toEqual([]);
      },
    );

    it.each(HELP_CASES)(
      'formats examples as comment and command pairs for $description',
      async ({ argv }) => {
        const { dependencies } = await runCli([...argv, '--help']);
        const help = (dependencies.io.stdout as MemoryStream).text;
        const examples = help.split('\nExamples:\n')[1]?.trimEnd();

        expect(examples).toMatch(
          /^ {2}# [^\n]+\n {2}tevu [^\n]+(?:\n\n {2}# [^\n]+\n {2}tevu [^\n]+)*$/,
        );
      },
    );

    it.each([
      { argv: [], names: ['task', 'validate', 'run', 'assess', 'report', 'config'] },
      { argv: ['config'], names: ['example'] },
      { argv: ['task'], names: ['add'] },
    ])('lists only command names in Commands for $argv', async ({ argv, names }) => {
      const { dependencies } = await runCli([...argv, '--help']);
      const help = (dependencies.io.stdout as MemoryStream).text;
      const commands = help.split('\nCommands:\n')[1]?.split('\n\n')[0];

      expect(commands?.split('\n').map((line) => line.trimStart().split(/\s{2,}/)[0])).toEqual(
        names,
      );
    });

    describe('version option', () => {
      function optionRows(help: string): string[][] {
        const section = help.split('\nOptions:\n')[1]?.split('\n\n')[0] ?? '';
        return section.split('\n').map((line) => line.trimStart().split(/\s{2,}/));
      }

      it('lists --version before -h, --help in the root help', async () => {
        const { dependencies } = await runCli(['--help']);

        expect(optionRows((dependencies.io.stdout as MemoryStream).text)).toEqual([
          ['--version', 'Show the version'],
          ['-h, --help', 'Show help'],
        ]);
      });

      it('lists --version before -h, --help in the help a bare invocation prints', async () => {
        const { dependencies } = await runCli([]);

        expect(optionRows((dependencies.io.stderr as MemoryStream).text)).toEqual([
          ['--version', 'Show the version'],
          ['-h, --help', 'Show help'],
        ]);
      });

      it.each(HELP_CASES.filter(({ argv }) => argv.length > 0))(
        'leaves --version out of the help for $description',
        async ({ argv }) => {
          const { dependencies } = await runCli([...argv, '--help']);

          expect((dependencies.io.stdout as MemoryStream).text).not.toContain('--version');
        },
      );
    });

    it('documents --dry-run in the run help', async () => {
      const { out } = await runCli(['run', '--help']);

      const help = out.join('').replace(/\s+/g, ' ');
      expect(help).toContain('--dry-run');
      expect(help).toContain('Show the execution plan without running tasks');
    });

    it('documents --jira in the task add help', async () => {
      const { out } = await runCli(['task', 'add', '--help']);

      expect(out.join('')).toContain('--jira');
    });

    it('documents --repeat in the run help', async () => {
      const { out } = await runCli(['run', '--help']);

      const help = out.join('').replace(/\s+/g, ' ');
      expect(help).toContain('--repeat <n>');
      expect(help).toContain('Attempts per task/model pair for this run; overrides run.repeat');
    });

    it('shows the assess example with a three-segment case ID ending in the attempt', async () => {
      const { out } = await runCli(['assess', '--help']);

      expect(out.join('\n')).toContain('tevu assess 20260923t120000z-a1b2c3 task--model--1');
    });

    it('labels the first validate example "Check the configuration tevu finds" (V12)', async () => {
      const { out } = await runCli(['validate', '--help']);

      expect(out.join('\n')).toContain('# Check the configuration tevu finds');
    });

    it('prints help on stderr with exit 1 for a bare invocation', async () => {
      const { code, out, err } = await runCli([]);

      expect(code).toBe(1);
      expect(err[0]).toBe('Compare coding models on your tasks');
      expect(err.slice(1, 4)).toEqual(['Usage:', '  tevu [options]', '  tevu <command> [options]']);
      expect(err.join('')).toContain('Examples:');
      expect(err.join('')).not.toMatch(/opencode|Sensitive data:|Isolation boundary:/i);
      expect(out).toEqual([]);
    });

    it('prints task help on stderr with exit 1 for a bare task command', async () => {
      const { code, out, err } = await runCli(['task']);

      expect(code).toBe(1);
      expect(err[0]).toBe('Manage benchmark tasks');
      expect(err.slice(1, 4)).toEqual([
        'Usage:',
        '  tevu task [options]',
        '  tevu task <command> [options]',
      ]);
      expect(out).toEqual([]);
    });

    it('prints config help on stderr with exit 1 for a bare config command', async () => {
      const { code, out, err } = await runCli(['config']);

      expect(code).toBe(1);
      expect(err[0]).toBe('Work with the configuration file');
      expect(err.slice(1, 4)).toEqual([
        'Usage:',
        '  tevu config [options]',
        '  tevu config <command> [options]',
      ]);
      expect(out).toEqual([]);
    });
  });

  describe('usage errors', () => {
    it.each(USAGE_ERROR_CASES)(
      '$error maps to exit 1 with the usage line on stderr',
      async ({ argv, error, usage }) => {
        const { code, out, err } = await runCli(argv);

        expect(code).toBe(1);
        expect(err[0]).toBe(error);
        expect(err[1]).toBe(usage);
        expect(out).toEqual([]);
      },
    );
  });

  describe('operations factories', () => {
    type FactoryName = keyof ProgramDependencies['commands'];

    function createFactorySpies(): Record<FactoryName, Mock<() => ProgramOperations>> {
      const operations = createOperations();
      return {
        taskAdd: vi.fn(() => operations),
        validate: vi.fn(() => operations),
        run: vi.fn(() => operations),
        assess: vi.fn(() => operations),
        report: vi.fn(() => operations),
      };
    }

    function callCounts(
      commands: Record<FactoryName, Mock<() => ProgramOperations>>,
    ): Record<FactoryName, number> {
      return {
        taskAdd: commands.taskAdd.mock.calls.length,
        validate: commands.validate.mock.calls.length,
        run: commands.run.mock.calls.length,
        assess: commands.assess.mock.calls.length,
        report: commands.report.mock.calls.length,
      };
    }

    const NO_CALLS: Record<FactoryName, number> = {
      taskAdd: 0,
      validate: 0,
      run: 0,
      assess: 0,
      report: 0,
    };

    it.each([
      { label: '--help', argv: ['--help'] },
      { label: '--version', argv: ['--version'] },
      { label: 'a usage error', argv: ['frobnicate'] },
      { label: 'config example', argv: ['config', 'example'] },
    ])('calls no factory for $label', async ({ argv }) => {
      const commands = createFactorySpies();

      await runCli(argv, { commands });

      expect(callCounts(commands)).toEqual(NO_CALLS);
    });

    it.each([
      { factory: 'taskAdd', argv: ['task', 'add'] },
      { factory: 'validate', argv: ['validate'] },
      { factory: 'run', argv: ['run', '--dry-run'] },
      { factory: 'assess', argv: ['assess', 'run-1', 'case-1'] },
      { factory: 'report', argv: ['report', 'run-1'] },
    ] satisfies Array<{ factory: FactoryName; argv: string[] }>)(
      'calls only the $factory factory, once, for $argv',
      async ({ factory, argv }) => {
        const commands = createFactorySpies();

        await runCli(argv, { commands, io: createIo({ stdin: false, stdout: false }) });

        expect(callCounts(commands)).toEqual({ ...NO_CALLS, [factory]: 1 });
      },
    );
  });

  describe('non-interactive rejection', () => {
    it('rejects task add before any configuration read when the streams are not TTYs', async () => {
      const operations = createOperations();
      const { code, err } = await runCli(['task', 'add'], {
        io: createIo(),
        operations,
      });

      expect(code).toBe(1);
      expect(err[0]).toBe(
        'error: prerequisite "terminal" is not satisfied; expected an interactive TTY on stdin and stdout, actual stdin and stdout are not a TTY',
      );
      expect(operations.configExists).not.toHaveBeenCalled();
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });

    it.each(TTY_REJECTION_CASES)(
      'names the failing streams ($actual) when prompting is not possible',
      async ({ stdin, stdout, actual }) => {
        const { code, err } = await runCli(['task', 'add'], { io: createIo({ stdin, stdout }) });

        expect(code).toBe(1);
        expect(err[0]).toBe(
          `error: prerequisite "terminal" is not satisfied; expected an interactive TTY on stdin and stdout, actual ${actual}`,
        );
      },
    );

    it('rejects assess after the configuration read but before any context read or write', async () => {
      const operations = createOperations();
      const { code, err } = await runCli(['assess', 'run-1', 'case-1'], {
        io: createIo(),
        operations,
      });

      expect(code).toBe(1);
      expect(err[0]).toContain('prerequisite "terminal" is not satisfied');
      expect(vi.mocked(operations.loadConfig)).toHaveBeenCalledExactlyOnceWith('tevu.yaml');
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
      expectNoWrites(operations);
    });
  });

  describe('redaction', () => {
    it('scrubs secrets from stderr failure output', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('not-found', '/work/hunter2/tevu.yaml', 'hunter2/tevu.yaml'),
        })),
      });

      const { code, err } = await runCli(['validate'], {
        operations,
        redact: (text) => text.replaceAll('hunter2', '[redacted]'),
      });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found: /work/[redacted]/tevu.yaml',
        "  create one interactively: tevu task add --config '[redacted]/tevu.yaml'",
        "  or start from the template: tevu config example > '[redacted]/tevu.yaml'",
      ]);
      expect(err.join('')).not.toContain('hunter2');
    });

    it('keeps a secret containing a single quote out of stderr in both raw and shell-quoted form', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('not-found', "/work/it's-secret.yaml", "it's-secret.yaml"),
        })),
      });

      const { code, err } = await runCli(['validate'], {
        operations,
        redact: (text) => text.replaceAll("it's-secret", '[redacted]'),
      });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found: /work/[redacted].yaml',
        "  create one interactively: tevu task add --config '[redacted].yaml'",
        "  or start from the template: tevu config example > '[redacted].yaml'",
      ]);
      const combined = err.join('');
      expect(combined).not.toContain("it's-secret");
      expect(combined).not.toContain("it'\\''s-secret");
    });

    it('scrubs secrets from stdout success output', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: true as const,
          value: buildCliConfig({
            run: { output_dir: '/tmp/hunter2', concurrency: 2, timeout: '10m', stop_grace: '5s' },
          }),
        })),
      });

      const { out } = await runCli(['report', 'run-1'], {
        operations,
        redact: (text) => text.replaceAll('hunter2', '[redacted]'),
      });

      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Summary regenerated: /tmp/[redacted]/run-1/summary.md',
        'Report regenerated: /tmp/[redacted]/run-1/report.md',
      ]);
      expect(out.join('')).not.toContain('hunter2');
    });
  });

  describe('status line per wizard run', () => {
    function takeStatusLines(): { messages: string[]; distinct: unknown[] } {
      const entries = clack.state.statusLines;
      clack.state.statusLines = [];
      return {
        messages: entries.map((entry) => entry.message),
        distinct: [...new Set(entries.map((entry) => entry.statusLine))],
      };
    }

    it('gives every prompt of one task add run the same status line and a new one to the next run', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({ ok: true as const, value: buildCriteriaConfig() })),
        resolveReference: vi.fn(async () => ({
          ok: true as const,
          value: buildResolvedCommitReference(),
        })),
        draftCriteria: vi.fn(async () => ({
          status: 'drafted' as const,
          effort: { status: 'verified' as const },
          draft: { acceptance: ['The export is documented.'], done: ['The change is reviewed.'] },
          retainedDirectories: [],
        })),
      });

      scriptAnswers(...READY_ANSWERS, 'add', clack.CANCEL);
      await runCli(['task', 'add'], { operations });
      const first = takeStatusLines();
      scriptAnswers(...READY_ANSWERS, 'add', clack.CANCEL);
      await runCli(['task', 'add'], { operations });
      const second = takeStatusLines();

      expect(first.messages).toContain('Add to');
      expect(first.messages.length).toBeGreaterThan(READY_ANSWERS.length);
      expect(first.distinct).toHaveLength(1);
      expect(first.distinct[0]).toEqual(expect.objectContaining({ show: expect.any(Function) }));
      expect(second.messages).toEqual(first.messages);
      expect(second.distinct).toHaveLength(1);
      expect(second.distinct[0]).not.toBe(first.distinct[0]);
    });

    it('gives every prompt of one assess run the same status line and a new one to the next run', async () => {
      const operations = createOperations({
        readAssessmentContext: vi.fn(async () => ({
          ok: true as const,
          value: buildAssessmentContext({
            checks: [
              buildManualCheckSummary({ checkId: 'acc-1', category: 'acceptance', required: true }),
              buildManualCheckSummary({
                checkId: 'dod-1',
                category: 'definition-of-done',
                required: false,
              }),
            ],
          }),
        })),
      });

      scriptAnswers('alice', 'passed', '', 'failed', 'loader missing');
      await runCli(['assess', 'run-1', 'case-1'], { operations });
      const first = takeStatusLines();
      scriptAnswers('alice', 'passed', '', 'failed', 'loader missing');
      await runCli(['assess', 'run-1', 'case-1'], { operations });
      const second = takeStatusLines();

      expect(first.messages).toContain('Assessor name');
      expect(first.messages.length).toBeGreaterThan(2);
      expect(first.distinct).toHaveLength(1);
      expect(first.distinct[0]).toEqual(expect.objectContaining({ show: expect.any(Function) }));
      expect(second.distinct).toHaveLength(1);
      expect(second.distinct[0]).not.toBe(first.distinct[0]);
    });
  });
});
