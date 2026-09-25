# How to run your first comparison

Compare at least two model settings on a task from your backlog using its local Git repository.

## Prepare the tools

Use Linux or macOS with Node.js 24, Bun, Git, and OpenCode installed. The current agent adapter uses OpenCode's `run` and `export` commands, JSON output, model selection, and effort variants. Compatibility is checked by those capabilities, not a fixed OpenCode version.

Choose a model and effort variant supported by your configured provider. Make its credential environment variables available in the terminal that will launch tevu. tevu uses isolated agent state, so credentials stored only in your usual agent login are not copied into benchmark runs.

From the tevu checkout, install dependencies, build, and link the command:

```sh
bun install --frozen-lockfile
bun run build
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/index.js" ~/.local/bin/tevu
tevu --help
```

`tevu` runs with the `node` on `PATH`, which must be Node.js 24 in every directory where `tevu` is used. The link points into the checkout, which must stay in place. After updating the checkout, rerun `bun install --frozen-lockfile` and `bun run build`. If the shell cannot find `tevu`, add `~/.local/bin` to `PATH` or link into another directory on `PATH`. Run the remaining commands in this guide from the directory that holds, or will hold, `tevu.yaml`.

## Define a task

To write the configuration by hand instead of answering the setup interview, start from `tevu config example > tevu.yaml`; see the [configuration reference](../reference/configuration.md#example).

Run the wizard in an interactive terminal:

```sh
tevu task add
```

For a missing configuration, the wizard first asks for the run settings (output directory, concurrency, time limits), the `agents.opencode` command and its secret and ordinary variable names, an optional Jira connection, at least one repository, and at least two model entries with their reasoning efforts. Enter variable names, not their values; tevu reads the values from the environment at run time.

Choose a repository commit from before the task was solved. Describe the task, the instructions for the model, the prerequisites you have checked, the acceptance criteria, and the completion checks. A check can run a command or require your manual verdict. See the [configuration reference](../reference/configuration.md) for the field definitions.

Confirm the final review to write `tevu.yaml`. Cancelling leaves the configuration unchanged.

For a Jira source, use the [Jira import guide](import-jira-task.md) when adding the task, then continue with validation below.

## Validate and preview

```sh
tevu validate
tevu run --dry-run
```

Validation should print `Configuration is valid.` The preview lists every task/model pair, the starting commits, execution limits, and the output directory. Neither command starts a model session.

## Run and review

```sh
tevu run
```

This command starts model sessions and can incur provider charges. Open the `report.md` path printed when the run finishes. Check task outcomes separately from runtime errors, then compare the available time, usage, and cost measurements. See the [results reference](../reference/results.md).

For pending manual checks, use the run and case IDs shown in the output. The following IDs are examples; replace them with yours:

```sh
tevu assess 20260923t120000z-a1b2c3 csv-export--high--1
```

The assessment command records your verdicts and rebuilds the report. To rebuild it again from saved evidence:

```sh
tevu report 20260923t120000z-a1b2c3
```

Confirm that required manual checks now have verdicts. Optional checks remain visible but do not change an otherwise passed task outcome.

## Troubleshooting

- **Missing variable:** export the variable named in the error in the same terminal, then rerun validation.
- **`prerequisites.bun` finding:** `validate` or `run` means `bun --version` fails in the current directory. Make Bun resolvable there; a version manager that pins Bun only inside the tevu checkout does not apply elsewhere.
- **Unsupported source tree:** choose a commit without submodules or Git LFS content. See the [source-tree reference](../reference/configuration.md#source-trees).
- **Missing agent capability:** check that `agents.opencode.command` points to the intended executable and that it supports the required commands and options.
- **Interactive terminal required:** run `task add` or `assess` with both input and output attached to a terminal.
