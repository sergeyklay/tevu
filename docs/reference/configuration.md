# Configuration reference

The format of `tevu.yaml`: location rules, top-level keys, path resolution, identifiers, and value grammars. Each block has its own page for field details.

## File format

- The file is UTF-8 YAML. YAML aliases are rejected.
- `version` must be `1`.
- Unknown fields are rejected at every level.
- A block keyed by an adapter kind (`agents.opencode`, `trackers.jira`) holds the settings of that adapter only.
- `tevu config example` prints a commented template to stdout and writes no file. Redirect it to create a configuration: `tevu config example > tevu.yaml`.

The [CLI reference](cli.md#configuration-file-search) lists the search order that decides which file tevu reads.

## Top-level keys

| Key | Contract | Details |
| --- | --- | --- |
| `version` | Must be `1` | |
| `run` | Settings shared by every case | [Run settings](#run-settings) |
| `agents.opencode` | The coding agent that runs cases and model calls | [Agents and models](agents-and-models.md#agents) |
| `trackers.jira` | Optional Jira Cloud connection | [Trackers](trackers.md#jira-cloud) |
| `repositories` | At least one entry, `{id, path}` or `{id, github}`, optionally with `setup` | [Repositories](repositories.md) |
| `models` | At least two `{id, model, effort, agent}` entries | [Agents and models](agents-and-models.md#model-entries) |
| `roles` | Optional `criteria` and `grader` model roles | [Agents and models](agents-and-models.md#model-roles) |
| `tasks` | At least one task | [Tasks](tasks.md) |

## Run settings

| Field | Contract |
| --- | --- |
| `run.output_dir` | Non-empty. The directory for run evidence. After symbolic links are resolved it must not overlap any configured repository |
| `run.concurrency` | Integer from 1 through 32 |
| `run.repeat` | Optional integer from 1 through 100, default `1`. Attempts per task and model entry pair, each an independent case. `tevu run --repeat <n>` overrides it for one run |
| `run.timeout` | Duration. The default agent time limit per case. A task's `timeout` replaces it. A timed-out case skips its checks and `setup.before_checks` |
| `run.stop_grace` | Duration. The delay between the graceful stop and the forced kill of a process group |
| `run.check_timeout` | Optional duration. The time limit of a command check that declares no `timeout` |

## Path resolution

- A relative path resolves against the directory of the configuration file tevu read. Symbolic links are not followed, and `~` is not expanded.
- A `github` repository value is not a path. Its clone lives under the managed-clone root (see [Repositories](repositories.md#github-repositories)).
- A bare executable name in `agents.opencode.command` is found through `PATH`. A value containing a path separator resolves against the configuration file.
- A configuration in the user configuration directory resolves relative values against that directory, not the working directory. Use absolute paths there for `run.output_dir`, `repositories[].path`, `checks.overlay`, and a path-form `agents.opencode.command`.

## Identifiers

Identifiers match `^[a-z][a-z0-9-]{0,63}$`. They are unique within their collection: repositories, model entries, tasks, and providers. Check IDs are unique across both check collections of a task.

## Value grammars

| Name | Rule |
| --- | --- |
| Duration | A positive integer without leading zeros followed by one unit: `ms`, `s`, `m`, or `h`. The maximum is `2147483647` milliseconds. A longer value is rejected, not truncated |
| Variable name | A letter or underscore followed by letters, digits, or underscores. In `agents.opencode.secrets`, `agents.opencode.env`, a check's `env`, and `setup.env` it must not be `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `CI`, or begin with `XDG_` |
| `$VARIABLE` reference | A dollar sign followed by a variable name, for example `$JIRA_API_TOKEN`. Used only for `trackers.jira.email` and `trackers.jira.token` |

A configuration never holds a secret value. A credential is a variable name or a `$VARIABLE` reference, and tevu reads the value from the environment that launches it. See [Environment](environment.md) for how variables reach processes.

## Appending tasks

`tevu task add` appends the new task, and a new repository when one was chosen, after the existing content of the `tasks` and `repositories` lists. Every other byte, comment, and blank line stays. Both lists must be in block style (one `- ` item per line); a flow-style list such as `tasks: [...]` is reported as a finding and nothing is written.
