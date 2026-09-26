# CLI reference

The executable is `tevu`. See the build and link steps in [Prepare the tools](../guides/run-benchmark.md#prepare-the-tools). Every command supports `--help`.

For the execution workflow, see the [benchmark guide](../guides/run-benchmark.md).

## Commands

| Command | Behavior |
| --- | --- |
| `tevu task add [--config <path>] [--jira <issue-key> \| --github <reference>]` | Interviews for a task and appends it to the target file after confirmation. `--config` names the target explicitly; without it, the first file the search finds is the target, or, when the search finds none, `./tevu.yaml` is created. The write adds the new task, and a new repository when one was chosen, after the file's existing content; every other byte, comment, and blank line is kept. A missing target starts a setup interview and writes a new file; see [tevu config example](configuration.md#example). Jira or GitHub is read once for an imported task; the two options cannot be combined |
| `tevu validate [--config <path>]` | Checks the configuration, local prerequisites, source commits, overlay directories, agent, check, and setup variable presence, output-directory access, and the capabilities of every agent a model entry or a declared model role names, without invoking a model. It checks `trackers.jira` for structure only; `task add --jira` checks its variables at import |
| `tevu run [--config <path>] [--dry-run] [--repeat <n>]` | Runs each task/model pair `run.repeat` times, each attempt as its own case, with the configured concurrency limit. `--repeat <n>` replaces `run.repeat` for this run and works with `--dry-run`; an `<n>` that is not a whole number from 1 through 100 ends the command with code `1` before the configuration is read. Dry-run prints the plan without creating run artifacts or workspaces, contacting Jira, or starting a model session, along with the number of planned cases and of manual assessments |
| `tevu assess <run-id> <case-id> [--config <path>]` | Records manual verdicts for a saved case; each attempt is its own case and is assessed separately. Optionally replaces confirmed existing verdicts, and regenerates the report |
| `tevu report <run-id> [--config <path>]` | Rebuilds normalized results and Markdown from saved run artifacts without Git, issue tracker, agent, or model calls |
| `tevu config example` | Prints a commented configuration template to stdout and writes no file; redirect it to create a configuration |

Without `--config`, tevu searches `./tevu.yaml`, then `$XDG_CONFIG_HOME/tevu/tevu.yaml` when `XDG_CONFIG_HOME` is set, non-empty, and absolute, otherwise `$HOME/.config/tevu/tevu.yaml` when `HOME` is set, non-empty, and absolute; `/etc/tevu/` and `$XDG_CONFIG_DIRS` are never searched. The search stops at the first candidate it can read; a candidate that exists but cannot be read ends the search with that error, without falling back to a later candidate. `--config <path>` disables the search and reads only that path. Paths inside the configuration file resolve relative to the configuration file. See the [configuration reference](configuration.md). `--config` must name a regular file or a symbolic link to one; a directory, FIFO, socket, or device is reported as not a file without being opened.

`validate`, `run`, `run --dry-run`, `assess`, and `report` print `Configuration: <absolute path>` as their first line once the configuration file is found, whatever it then parses or validates as. When the configuration file cannot be read, these commands print its absolute path and the reason, and exit with code `1`, and the error suggests `tevu task add --config <path>` and `tevu config example > <path>`. When the search finds no candidate, the error lists every searched path and suggests `tevu task add` and `tevu config example > tevu.yaml` instead. `task add` starts its setup interview only when its target does not exist and its directory exists; any other read failure, or a missing directory, ends the command with code `1` before the first question.

`<reference>` for `--github` is `OWNER/REPO#NUMBER` or an issue URL (`https://HOST/OWNER/REPO/issues/NUMBER`). `--github` needs the GitHub CLI (`gh`) installed and authenticated for the issue's host; see the [configuration reference](configuration.md#github-issues).

`task add` and `assess` require terminal input and output. The other commands produce plain text when output is redirected. Interactive benchmark progress is prefixed with the case ID.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed. For `run`, all required checks passed and no case retained a runtime failure |
| `1` | Invalid input, a missing prerequisite, or an infrastructure/artifact failure prevented completion |
| `2` | Benchmark evidence was retained, but a case timed out, had a runtime failure, or had failed or pending required checks |
| `130` | The command was cancelled; partial run artifacts are finalized when possible |

For a run with multiple conditions, cancellation takes precedence, then incomplete evidence (`1`), then a degraded result (`2`). A model process can fail while its submitted solution passes the acceptance checks; the run still returns `2`.

## Assessment and recovery

`assess` processes pending required and optional manual checks in their configured order. An assessor name is required. A failed verdict also requires a note. Replacing an existing verdict requires confirmation; the prior verdict remains in history.

An assessment lock prevents concurrent changes to the same case. An existing lock is not automatically removed. A verdict committed before a later report-write failure remains saved; `tevu report <run-id>` regenerates the derived files after the write problem is resolved.

See [results and artifacts](results.md) for the files these commands read and write.
