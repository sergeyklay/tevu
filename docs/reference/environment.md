# Environment reference

How environment variables reach the processes tevu starts, and how `tevu validate` probes the executables cases will run.

## Declared variables

| Where | Meaning |
| --- | --- |
| `agents.opencode.secrets` | Variable names passed to the agent. Every value is redacted from saved and displayed evidence |
| `agents.opencode.env` | Variable names passed to the agent as-is |
| `checks.*[].env` | Ordinary variables available to that command check only |
| `repositories[].setup.env` | Ordinary variables passed to that repository's setup commands |

Rules:

- A list holds names, never values, and neither list may repeat a name. A name cannot appear in both `secrets` and `env`.
- A check's `env` and `setup.env` must not name a variable in an agent's `secrets` or `env`, or a variable a Jira credential references.
- Every declared variable must be set in the environment that launches tevu. A missing variable is reported before any case starts.
- `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `CI`, and every `XDG_*` name are supplied by tevu and cannot be configured.
- The Jira credential variables are checked when `tevu task add --jira` needs their values, not by `validate` or `run`.

## Fixed evaluator environment

The evaluator runs command checks and setup commands. No other variable of the parent process is inherited.

| Variables | Value |
| --- | --- |
| `PATH` | Run-level snapshot of the parent's executable search path. An empty or unset parent `PATH` fails the run |
| `HOME` | Per-case evaluator home |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` | Directories under the evaluator home |
| `TMPDIR` | Per-case evaluator temporary directory |
| `LANG`, `LC_ALL` | `C.UTF-8` |
| `CI` | `1` |

A check's environment is this table plus the names in its `env`. A setup command's environment is this table plus `setup.env`. The evaluator's home, state, and temporary directories are separate from the agent's.

## Agent environment

An agent process receives the same fixed variable names with its own per-case home, state, and temporary directories, plus the variables named in `agents.opencode.secrets` and `agents.opencode.env`. Host agent sessions, global configuration, caches, and login stores are not copied, except the provider definitions `agents.opencode.providers` names; see [Agents and models](agents-and-models.md#providers).

A model call's agent process gets the same treatment, with an empty Git repository as its working directory. See [Model calls](agents-and-models.md#model-calls).

## Case executables

A case executable is the first element of a command a case would start:

- an agent's `command`;
- the first element of each `setup.before_agent` and `setup.before_checks` command;
- the first element of each array `run`;
- the leading word of each string `run`. A leading word is the first run of non-blank characters after any spaces and tabs, and counts only when it holds nothing but ASCII letters, digits, `_`, `-`, `.`, `/`, and `+`.

`tevu validate` probes every case executable before any case starts. `tevu run` and `tevu run --dry-run` run the same probe as part of validation.

For each executable, tevu starts `<executable> --version` once in a replica of its case environment. Only when that run does not exit 0 within 10 seconds, it starts it once more in tevu's own environment.

| Replica run | Parent run | Result |
| --- | --- | --- |
| Exits 0 within the limit | Not started | The executable runs. Nothing is reported |
| Reaches the 10-second limit | Not started | Undetermined. Nothing is reported, since the executable may be downloading a toolchain into its empty home |
| Fails to exit 0 | Exits 0 within the limit | The executable runs only in tevu's own environment. An error finding names it |
| Fails to exit 0 | Any other outcome | Undetermined. Nothing is reported |

Both runs share one working directory: a path entry's own directory for its setup commands and its tasks' command checks, and a new empty directory for the agent command and for a GitHub entry's commands.

The parent run omits these names even when tevu's own environment sets them: every configured agent's `secrets` names, the variable `trackers.jira.token` references, and `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN`. It gives the executable every other variable of tevu's own environment, your `HOME` included. A started executable may therefore use the network, write files, or install a toolchain on its own.

An error finding appears at `agents.<name>.command`, `repositories.<repo-id>.setup.<phase>.<index>`, or `tasks.<task-id>.checks.<collection>.<check-id>.run`, and makes the configuration invalid. Its message names the executable, why the replica run failed, and two remedies. Declare the variable it reads, if a case does not already give it one. Or, for a version-manager shim, start tevu with the real executable's directory before the shim directory on `PATH`.

tevu does not judge:

- a string `run` without a leading word, such as `CI=1 npm test`, `(cd app && npm test)`, or `"$NODE" test.js`;
- a relative path containing `/`, since it resolves inside a case worktree that does not exist during validation;
- an executable whose `--version` does not exit 0 in the parent run from its working directory, including a tool with no `--version` option;
- an executable whose replica run reaches the 10-second limit;
- a command the agent or a case executable starts itself.

### Directory change warnings

In a path entry's directory, tevu compares the files Git reports as changed or untracked before and after each probe run, by type, permissions, size, and modification and status-change times. A probe that changed one draws a warning naming the executable, up to 10 changed paths, and a count of the rest. The wording says the change happened while the executable was running, because you or another program may edit the directory at the same time. tevu never reverts or removes such a change. A failed comparison draws a warning that the check could not be made. Neither warning makes the configuration invalid or stops `tevu run`.

The comparison does not see ignored files, the Git directory, or writes outside the working directory, such as a toolchain installed under your home.
