/**
 * Stable `tevu` command surface over Commander: command and option
 * registration, concise usage errors, command examples, and the exit-code
 * mapping. Each command's handler lives in `./commands` and receives the
 * operations its injected factory builds, so this module owns no evaluation,
 * orchestration, transport, process supervision, or storage logic and imports
 * no concrete adapter.
 */

import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';

import { MAX_REPEAT, RepeatSchema } from '@/config/schema';
import { CONFIG_TEMPLATE } from '@/config/template';

import { runAssess } from './commands/assess';
import { runReport } from './commands/report';
import { runBenchmarkCommand } from './commands/run';
import { EXIT_COMPLETED, EXIT_FAILURE } from './commands/shared';
import { runTaskAdd } from './commands/task-add';
import { runValidate } from './commands/validate';

import type { AssessOperations } from './commands/assess';
import type { ReportOperations } from './commands/report';
import type { RunOperations, RunOptionValues } from './commands/run';
import type { CommandContext, ConfigOptionValues } from './commands/shared';
import type { TaskAddOperations, TaskAddOptionValues } from './commands/task-add';
import type { ValidateOperations } from './commands/validate';
import type { Help } from 'commander';

/** One operations factory per command; the command's action calls it once, when it starts. */
type ProgramCommands = {
  taskAdd(): TaskAddOperations;
  validate(): ValidateOperations;
  run(): RunOperations;
  assess(): AssessOperations;
  report(): ReportOperations;
};

/** Everything the program factory needs; injected by the composition root. */
export type ProgramDependencies = CommandContext & {
  commands: ProgramCommands;
  /** Version of the package this executable was built from; `--version` prints it. */
  version: string;
};

type ExitBox = { code: number };

const CONFIG_OPTION_DESCRIPTION =
  'Configuration file path; without it, tevu searches ./tevu.yaml, then ' +
  '$XDG_CONFIG_HOME/tevu/tevu.yaml (or $HOME/.config/tevu/tevu.yaml when ' +
  'XDG_CONFIG_HOME is not an absolute path)';

const HELP_EXAMPLES: Record<string, [string, string][]> = {
  tevu: [
    ['Define a benchmark task', 'tevu task add'],
    ['Preview a benchmark', 'tevu run --dry-run'],
    ['Run a benchmark', 'tevu run'],
  ],
  config: [['Start a configuration file from the template', 'tevu config example > tevu.yaml']],
  example: [
    ['Print the configuration template', 'tevu config example'],
    ['Start a configuration file from the template', 'tevu config example > tevu.yaml'],
  ],
  task: [['Define a benchmark task', 'tevu task add']],
  add: [
    ['Define a task interactively', 'tevu task add'],
    ['Import a task from Jira', 'tevu task add --jira PROJ-123'],
    ['Import a task from GitHub', 'tevu task add --github OWNER/REPO#123'],
  ],
  validate: [
    ['Check the configuration tevu finds', 'tevu validate'],
    ['Check a specific configuration', 'tevu validate --config benchmarks.yaml'],
  ],
  run: [
    ['Preview the execution plan', 'tevu run --dry-run'],
    ['Run the configured benchmark', 'tevu run'],
  ],
  assess: [
    ['Assess a case from a saved run', 'tevu assess 20260923t120000z-a1b2c3 task--model--1'],
  ],
  report: [["Regenerate a saved run's report", 'tevu report 20260923t120000z-a1b2c3']],
};

const REPEAT_ARGUMENT_PATTERN = /^[0-9]+$/;

/**
 * Parses `--repeat`'s argument: a whole number `RepeatSchema` accepts.
 *
 * @throws {InvalidArgumentError} When `value` does not match `^[0-9]+$` or
 * `RepeatSchema` rejects its numeric value.
 */
function parseRepeatOption(value: string): number {
  const parsed = REPEAT_ARGUMENT_PATTERN.test(value) ? RepeatSchema.safeParse(Number(value)) : null;
  if (parsed === null || !parsed.success) {
    throw new InvalidArgumentError(`Expected a whole number from 1 to ${MAX_REPEAT}.`);
  }
  return parsed.data;
}

/**
 * Creates the complete `tevu` command tree for help inspection and parsing.
 * Exit codes produced by parsing this instance directly are not captured;
 * use `runProgram` to execute a command line and receive the mapped code.
 */
export function createProgram(dependencies: ProgramDependencies): Command {
  return buildProgram(dependencies, { code: EXIT_COMPLETED });
}

/**
 * Parses and executes one user-supplied argument vector and returns the
 * process exit code: 0 for completion, 1 for invalid usage or a failure that
 * prevented a complete benchmark record, 2 for preserved degraded benchmark
 * evidence, and 130 for user cancellation. Never calls `process.exit`.
 */
export async function runProgram(
  argv: readonly string[],
  dependencies: ProgramDependencies,
): Promise<number> {
  const exit: ExitBox = { code: EXIT_COMPLETED };
  const program = buildProgram(dependencies, exit);
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT_COMPLETED : EXIT_FAILURE;
    }
    throw error;
  }
  return exit.code;
}

function buildProgram(dependencies: ProgramDependencies, exit: ExitBox): Command {
  const program = new Command('tevu');
  program.description('Compare coding models on your tasks');
  program.version(dependencies.version, '--version', 'Show the version');

  const task = program.command('task').description('Manage benchmark tasks');
  task
    .command('add')
    .description('Add a benchmark task')
    .option('--config <path>', CONFIG_OPTION_DESCRIPTION)
    .option('--jira <issue-key>', 'Import a task from a Jira issue')
    .addOption(
      new Option('--github <reference>', 'Import a task from a GitHub issue').conflicts('jira'),
    )
    .action(async (options: TaskAddOptionValues) => {
      exit.code = await runTaskAdd(dependencies.commands.taskAdd(), dependencies, options);
    });

  program
    .command('validate')
    .description('Check configuration and prerequisites')
    .option('--config <path>', CONFIG_OPTION_DESCRIPTION)
    .action(async (options: ConfigOptionValues) => {
      exit.code = await runValidate(dependencies.commands.validate(), dependencies, options);
    });

  program
    .command('run')
    .description('Run the benchmark')
    .option('--config <path>', CONFIG_OPTION_DESCRIPTION)
    .option('--dry-run', 'Show the execution plan without running tasks')
    .addOption(
      new Option(
        '--repeat <n>',
        'Attempts per task/model pair for this run; overrides run.repeat',
      ).argParser(parseRepeatOption),
    )
    .action(async (options: RunOptionValues) => {
      exit.code = await runBenchmarkCommand(dependencies.commands.run(), dependencies, options);
    });

  program
    .command('assess')
    .description('Record manual and graded check verdicts')
    .argument('<run-id>', 'Run to assess')
    .argument('<case-id>', 'Case to assess')
    .option('--config <path>', CONFIG_OPTION_DESCRIPTION)
    .action(async (runId: string, caseId: string, options: ConfigOptionValues) => {
      exit.code = await runAssess(
        dependencies.commands.assess(),
        dependencies,
        runId,
        caseId,
        options,
      );
    });

  program
    .command('report')
    .description('Regenerate a report from a saved run')
    .argument('<run-id>', 'Run to report on')
    .option('--config <path>', CONFIG_OPTION_DESCRIPTION)
    .action(async (runId: string, options: ConfigOptionValues) => {
      exit.code = await runReport(dependencies.commands.report(), dependencies, runId, options);
    });

  const config = program.command('config').description('Work with the configuration file');
  config
    .command('example')
    .description('Print a commented configuration template')
    .action(() => {
      exit.code = runConfigExample(dependencies);
    });

  for (const command of walkCommands(program)) {
    configureCommandBoundary(command, dependencies);
  }
  return program;
}

/**
 * Applies the shared stream, error, and help boundary to one command: output
 * through the injected redacting streams, exceptions instead of process
 * exits, a concise error plus the relevant usage line on invalid usage, and
 * command examples appended to its help.
 */
function configureCommandBoundary(command: Command, dependencies: ProgramDependencies): void {
  command.exitOverride();
  command.helpCommand(false);
  command.helpOption('-h, --help', 'Show help');
  command.configureHelp({
    subcommandTerm: (subcommand) => subcommand.name(),
    formatHelp: formatCommandHelp,
  });
  command.showHelpAfterError(false);
  command.showSuggestionAfterError(false);
  const examples = HELP_EXAMPLES[command.name()]
    .map(([description, invocation]) => `  # ${description}\n  ${invocation}`)
    .join('\n\n');
  command.addHelpText('after', `\nExamples:\n${examples}`);
  command.configureOutput({
    writeOut: (text) => {
      dependencies.io.stdout.write(dependencies.redact(text));
    },
    writeErr: (text) => {
      dependencies.io.stderr.write(dependencies.redact(text));
    },
    outputError: (text, write) => {
      write(text);
      write(`Usage: ${usageLine(command)}\n`);
    },
  });
}

function* walkCommands(root: Command): Generator<Command> {
  yield root;
  for (const child of root.commands) {
    yield* walkCommands(child);
  }
}

function usageLine(command: Command): string {
  return `${commandPath(command)} ${command.usage()}`;
}

function commandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current !== null) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(' ');
}

function formatCommandHelp(command: Command, helper: Help): string {
  const name = commandPath(command);
  const commands = helper.visibleCommands(command);
  const argumentsUsage = command.registeredArguments.map((argument) =>
    argument.required ? `<${argument.name()}>` : `[${argument.name()}]`,
  );
  const usage =
    commands.length > 0
      ? [`${name} [options]`, `${name} <command> [options]`]
      : [[name, ...argumentsUsage, '[options]'].join(' ')];
  const width = helper.padWidth(command, helper);
  const formatItem = (term: string, description: string): string =>
    helper.formatItem(term, width, description, helper);

  return [
    helper.commandDescription(command),
    '',
    'Usage:',
    ...usage.map((line) => `  ${line}`),
    '',
    ...helper.formatItemList(
      'Arguments:',
      helper
        .visibleArguments(command)
        .map((argument) =>
          formatItem(helper.argumentTerm(argument), helper.argumentDescription(argument)),
        ),
      helper,
    ),
    ...helper.formatItemList(
      'Options:',
      helper
        .visibleOptions(command)
        .map((option) => formatItem(helper.optionTerm(option), helper.optionDescription(option))),
      helper,
    ),
    ...helper.formatItemList(
      'Commands:',
      commands.map((subcommand) =>
        formatItem(helper.subcommandTerm(subcommand), helper.subcommandDescription(subcommand)),
      ),
      helper,
    ),
  ].join('\n');
}

function runConfigExample(dependencies: ProgramDependencies): number {
  dependencies.io.stdout.write(dependencies.redact(CONFIG_TEMPLATE));
  return EXIT_COMPLETED;
}
