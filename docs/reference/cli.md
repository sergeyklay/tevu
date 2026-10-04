# CLI reference

The `tevu` commands, their options, exit codes, and network use. Every command supports `--help`. `tevu --version` prints the version of the package tevu was built from and exits `0`; it reads no configuration file, needs no credentials, starts no other process, and uses no network. There is no `help` command.

See [Installation](../getting-started/installation.md) for how to build the executable.

## Commands

| Command | Behavior |
| --- | --- |
| `tevu task add [--config <path>] [--jira <issue-key> \| --github <reference>]` | Interviews for a task and appends it to the target file after confirmation. Interactive; see [Task wizard](task-wizard.md) |
| `tevu validate [--config <path>]` | Checks the configuration without invoking a model. See [Validation](#validation) |
| `tevu run [--config <path>] [--dry-run] [--repeat <n>]` | Runs each task and model entry pair `run.repeat` times, each attempt as its own case, up to `run.concurrency` at once. See [Run](#run) |
| `tevu assess <run-id> <case-id> [--config <path>]` | Records manual and grader verdicts for one saved case and regenerates the report, leaving `summary.md` as `tevu run` wrote it. See [Assessment](#assessment) |
| `tevu report <run-id> [--config <path>]` | Rebuilds normalized results, `report.md`, and `summary.md` from saved run artifacts. See [Artifacts](artifacts.md#regeneration) |
| `tevu config example` | Prints a commented configuration template to stdout and writes no file |

`--jira` and `--github` cannot be combined. `--github` takes `OWNER/REPO#NUMBER` or an issue URL; see [Trackers](trackers.md#github-issues).

## Configuration file search

Without `--config`, tevu searches in order:

1. `./tevu.yaml`.
2. `$XDG_CONFIG_HOME/tevu/tevu.yaml`, when `XDG_CONFIG_HOME` is set, non-empty, and absolute. Otherwise `$HOME/.config/tevu/tevu.yaml`, when `HOME` is set, non-empty, and absolute.

`/etc/tevu/` and `$XDG_CONFIG_DIRS` are never searched. The search stops at the first candidate it can read. A candidate that exists but cannot be read ends the search with that error. `--config <path>` disables the search and reads only that path, which must be a regular file or a symbolic link to one. A directory, FIFO, socket, or device is reported as not a file without being opened.

`validate`, `run`, `run --dry-run`, `assess`, and `report` print `Configuration: <absolute path>` as their first line once the file is found, whatever it then parses or validates as.

When the file cannot be read, these commands print its absolute path and the reason and exit `1`. When the cause is that the file does not exist, the error also suggests `tevu task add --config <path>` and `tevu config example > <path>`. When the search finds no candidate, the error lists every searched path and suggests `tevu task add` and `tevu config example > tevu.yaml`.

`task add` starts its setup interview only when its target does not exist and its directory exists. Any other read failure, or a missing directory, ends the command with code `1` before the first question.

## Validation

`tevu validate` checks:

- the configuration, local prerequisites, source commits, and overlay directories;
- that agent, check, and setup variables are set, and that the output directory is accessible;
- the capabilities of every agent a model entry or role names;
- that every case executable starts; see [Environment](environment.md#case-executables);
- that the agent resolves every model entry and role; see [Model resolution](agents-and-models.md#model-resolution);
- that every model entry's and role's effort is a variant the agent reports for its model; see [Effort check](agents-and-models.md#effort-check);
- that OpenCode applies the tool denial of model calls, for every agent a role names; see [Tool denial check](agents-and-models.md#tool-denial-check);
- that a task declaring a graded check has `roles.grader`.

It prints findings, then `Configuration is valid.` or `Configuration is invalid.` (exit `1`). It starts no model session. It never clones or fetches: a missing GitHub clone or commit is a finding that names `tevu run --dry-run`. It checks `trackers.jira` for structure only.

## Run

- `--repeat <n>` replaces `run.repeat` for this run and works with `--dry-run`. An `<n>` that is not a whole number from 1 through 100 ends the command with code `1` before the configuration is read.
- Before validation, `run` clones or fetches every GitHub repository entry a task names and fetches the Git LFS objects each distinct base commit lacks. Progress and warnings print before the validation output.
- After each case's checks run, `run` grades that case's graded checks through `roles.grader`, which it requires declared before any case starts.
- `--dry-run` prints the plan without creating run artifacts or workspaces, contacting Jira, or starting a model session. The plan lists each planned case with its task, model entry, commit, and timeout, marking an effort that is not verified, then the number of planned cases and manual assessments and the output directory. It still clones and fetches, so a missing clone, commit, or Git LFS object is ready for the next `run`.
- A run prints `Run <id> started.` first. When output is a terminal, progress lines start with the case ID.
- After the run, tevu saves the conclusions of the [run summary](results.md#run-summary), builds the report, and prints a summary from it: one block per attempt, then the run findings, `Artifacts: <dir>`, `Summary: <dir>/summary.md`, and `Report: <dir>/report.md`, in that order. A block opens with `<case name>: <outcome>; required checks <phrase>.`, using the [names](results.md#names) and the [Required checks](results.md#comparison-table) phrase of the report. An indented line follows for each state that needs explaining, in the three parts and with the technical detail of [Messages](results.md#messages). When a check waits for a verdict, that line gives the `tevu assess <run-id> <case-id>` command. A finding reads `<Warning or Error> for <case name>: <message>`.
- With `roles.summary` declared, `run` makes one summary call per task after the last case, before it prints anything of the summary. Nothing prints while a call runs. A summary call whose temporary directory tevu could not delete adds one line after the run findings and before `Artifacts:`, whether the call replied, failed, or was cancelled: `Warning: tevu could not delete the temporary directory of a summary call. The results are not affected. Delete <path> when no tevu command uses it.` Apart from that line, a failed or rejected summary call prints nothing and changes no exit code; the `Summary model` footnote of `report.md` explains it.
- A cancelled run prints `Artifacts: <dir>` and the cancellation line, which names `tevu report <run-id>`, and no terminal summary. Before them it prints one line for each grading call whose temporary directory tevu could not delete: `Warning: tevu could not delete the temporary directory of a grading call. The results are not affected. Delete <path> when no tevu command uses it.` It writes no `conclusions.json` or `summary.md`, and `tevu report` then renders the summary from the facts derived from the saved artifacts. When the report cannot be built, `run` prints `Artifacts: <dir>`, then the error and the recovery line that names `tevu report <run-id>`, and no terminal summary.

## Assessment

`tevu assess` needs a terminal for input and output and a case with lifecycle `completed` and at least one manual or graded check.

- It processes pending required and optional manual and graded checks in configured order.
- It opens with `Assessing <case name>.` and names each check by its [check name](results.md#names), with its category, whether it is required or optional, and whether it is manual or graded.
- For a graded check it shows the saved grade or the reason it has none before asking, in the wording of the [report](results.md#messages), with the raw reason as technical detail. A `passed` or `failed` grade is kept unless the operator chooses to replace it. An `undetermined` or pending grade needs a decision.
- The prompts name no check, because the line above them does.
- An assessor name is required. A failed verdict also requires a note.
- Replacing an existing verdict, an operator's or a grader's, requires confirmation. The prior verdict stays in history.
- A per-case lock directory prevents concurrent changes. An existing lock is never removed automatically.
- A verdict committed before a later report-write failure stays saved. The error names `tevu report <run-id>`, which regenerates the derived files.
- After recording, the command prints `Assessment recorded.`, the case's summary block from the rebuilt report, and `Report: <dir>/<run-id>/report.md`. It leaves `summary.md` and `conclusions.json` as `tevu run` wrote them.

The [assessment guide](../guides/assess-results.md) covers the workflow.

## Report

`tevu report <run-id>` rebuilds the derived files of a saved run and prints `Summary regenerated: <dir>/<run-id>/summary.md`, then `Report regenerated: <dir>/<run-id>/report.md`. It reads the saved `conclusions.json` and makes no model call. See [Regeneration](artifacts.md#regeneration).

## Terminal behavior

`task add` and `assess` require terminal input and output; without them the command exits `1` with `prerequisite "terminal" is not satisfied`. `task add` discards keys typed while it waits, so they never answer the next question. Other commands produce plain text when output is redirected.

## Network use

| Command | Network use |
| --- | --- |
| `tevu task add` | Jira or gh, as described in [Trackers](trackers.md). Clone and fetch for a selected GitHub repository entry. `git ls-remote` for each GitHub repository answer. A Git LFS object fetch for each base-commit answer whose tree lacks objects. With `roles.criteria` and a reference solution, a diff read (`gh api` for a pull request), one `<command> models --verbose` listing and one `<command> debug config` before each draft's model session, and that model session. The `debug config` run can install a plugin the configuration names. In a setup interview, the agent capability probe and one `<command> models --verbose` listing per model answer, which may reach the network on its own |
| `tevu run` | Preparation clone and fetch, only for a missing clone or commit. A Git LFS object fetch, only for a base commit whose tree lacks objects. Model listing and one `<command> debug config` for each agent a role names during validation. One `<command> debug config` before each model call. Model sessions, including one summary call per task at the end when `roles.summary` is declared |
| `tevu run --dry-run` | The same as `run`, except no model session and no `<command> debug config` before a model call |
| `tevu validate` | The `<command> models --verbose` listing for each agent a model entry or role names, and one `<command> debug config` for each agent a role names. Either may reach the network on its own. `git lfs version` locally, only when a Git LFS object is missing. Each case executable started with `--version` |
| `tevu assess`, `tevu report`, `tevu config example` | None. `assess` and `report` read saved artifacts only |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed. For `run`, all required checks passed and no case retained a runtime failure |
| `1` | Invalid input, a missing prerequisite, or an infrastructure or artifact failure prevented completion |
| `2` | Benchmark evidence was retained, but a case timed out, had a runtime failure, or had failed or pending required checks |
| `130` | The command was cancelled. Partial run artifacts are finalized when possible. `task add` writes nothing unless the save had already written the task |

A cancellation during the summary calls of `tevu run` is the exception to the precedence below: the run's evidence is final, so `run` skips the remaining calls, saves template sentences for those tasks, finishes its writes and output, and returns the code it would have returned without the cancellation.

When several conditions apply, cancellation takes precedence, then incomplete evidence (`1`), then a degraded result (`2`). A model process can fail while its solution passes the acceptance checks; the run still returns `2`. An agent that reports a session error and exits `0` is a runtime failure as well, so the run returns `2` even when its solution passes the acceptance checks.
