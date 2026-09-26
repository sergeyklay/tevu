# Configuration reference

tevu reads UTF-8 YAML with `version: 1`. Unknown fields are rejected at every level. `--config` selects the file explicitly; without it, tevu reads `./tevu.yaml`, or the user configuration file under `$XDG_CONFIG_HOME/tevu` or `$HOME/.config/tevu`. See the [CLI reference](cli.md) for the complete search order.

## Example

`tevu config example` prints this template to stdout:

```sh
tevu config example > tevu.yaml
```

The shell creates the file, or replaces an existing one, before tevu starts; tevu itself writes no file. This template compares two model entries at different reasoning efforts on one task using manual checks. The repository path, commit, model identifier, efforts, and credential-variable name are illustrative values, not a ready-to-run configuration. The [benchmark guide](../guides/run-benchmark.md) covers setup for a real task.

```yaml
# tevu.yaml: compare coding models on tasks from your own backlog.
#
# Conventions used throughout this file:
#   - durations are strings with a unit: 500ms, 30s, 10m, 1h;
#   - relative paths resolve against the directory of this file;
#   - secrets are never written here: a credential is a $VARIABLE reference or a
#     variable name, and its value is read from the environment at run time;
#   - a block keyed by an adapter kind (agents.opencode, trackers.jira) holds the
#     settings of that adapter only, so a new agent or tracker adds a block and
#     changes nothing else.

version: 1

# --- Run --------------------------------------------------------------------
# Settings shared by every case, so every model works under the same rules.
run:
  output_dir: ../tevu-runs        # run evidence; must lie outside every repository
  concurrency: 2                  # cases running at once, 1 to 32
  # repeat: 3                     # attempts per task/model pair, each in its own case; defaults to 1
  timeout: 10m                    # limit for one agent attempt; checks are skipped after it
  stop_grace: 3s                  # time to exit after a graceful stop before a forced kill
  check_timeout: 5m               # default limit for a command check without its own timeout

# --- Agents -----------------------------------------------------------------
# One block per coding agent, keyed by adapter kind. Only opencode exists today.
agents:
  opencode:
    command: opencode             # name on PATH, or a path relative to this file
    secrets:                      # passed to the agent, redacted from every artifact
      - OPENAI_API_KEY
    env: []                       # ordinary variables passed to the agent as-is

# --- Trackers ---------------------------------------------------------------
# Used once, by `tevu task add --jira` or `--github`, to import an issue.
# GitHub import goes through the `gh` CLI and its own login; it needs no block.
trackers:
  jira:
    url: https://your-site.atlassian.net
    email: $JIRA_EMAIL
    token: $JIRA_API_TOKEN

# --- Repositories -----------------------------------------------------------
repositories:
  - id: app
    path: ../your-app
    # setup:                        # prepares every case of this repository, without a shell
    #   before_agent: [[npm, ci]]   # before the agent starts
    #   before_checks: [[npm, ci]]  # after restore and overlay, before the checks
    #   timeout: 5m                 # limit for one setup command; required with setup
    #   env: [NPM_CONFIG_REGISTRY]  # ordinary variables the setup commands receive

# --- Models -----------------------------------------------------------------
# What the benchmark compares: at least two entries.
models:
  - id: gpt-low
    model: openai/your-model      # as the agent names it
    effort: low                   # the agent's reasoning effort or variant
    # agent: opencode             # needed only when more than one agent is configured
  - id: gpt-high
    model: openai/your-model
    effort: high

# --- Tasks ------------------------------------------------------------------
tasks:
  - id: csv-export
    title: Export the current view as CSV
    repo: app                     # may be omitted while there is one repository
    base_commit: "0123456789abcdef0123456789abcdef01234567"   # a commit from before the fix

    # Sent to the agent, together with the check descriptions below.
    prompt: Add a CSV export button to the table view.
    description: Users need to download the visible table as a CSV file.

    # Where the task came from. Omit for a task written by hand.
    # `tevu task add --jira` or `--github` fills this block once;
    # later edits in the tracker never change the task.
    # source:
    #   kind: jira                # jira or github
    #   key: PROJ-123             # owner/repo#123 for GitHub
    #   url: https://your-site.atlassian.net/browse/PROJ-123
    #   imported_at: 2026-09-24T09:00:00Z
    #   title: Export table as CSV
    #   body: The imported issue text, kept for the record.

    # Confirmed by you before the task was added; never sent to the agent.
    readiness:
      - The expected columns and escaping rules are defined.

    checks:
      # restore: ["tests/**", vitest.config.ts]       # reset to base_commit before checks run
      # overlay: ./hidden-checks/csv-export           # copied onto the repository root before checks run
      # Does the change solve the task? At least one check must be required.
      acceptance:
        - id: csv-content
          description: The CSV contains the visible rows and correctly escapes values.
          manual: true            # you record the verdict with `tevu assess`
        - id: tests
          description: The repository's test suite passes.
          run: [npm, test]        # executable and literal arguments, no shell
          # timeout: 2m           # defaults to run.check_timeout
          # exit_codes: [0]       # exit codes that count as a pass; defaults to [0]
          # env: [NODE_OPTIONS]   # ordinary variables this check receives
          # required: false       # checks are required unless stated otherwise
      # Is the work complete beyond the fix itself? At least one check must be required.
      done:
        - id: docs
          description: The export action is documented for users.
          manual: true
```

`tevu task add` appends to this file: the interviewed task, and a new repository when one was chosen, are added after the existing content of the `tasks` and `repositories` lists. Every other byte, comment, and blank line is kept unchanged. Both lists must stay in block style (one `- ` item per line, never `tasks: [...]`) for the append to succeed; a flow-style list is reported as a finding and nothing is written. A task added by editing the file by hand keeps every comment the same way.

## Top-level fields

| Field | Contract |
| --- | --- |
| `version` | Must be `1` |
| `run.output_dir` | Non-empty; run evidence directory, outside and non-overlapping with configured repositories after resolving symlinks |
| `run.concurrency` | Integer from 1 through 32 |
| `run.repeat` | Integer from 1 through 100, optional, default `1`; attempts per task/model pair, each an independent case; `tevu run --repeat <n>` overrides it for one run |
| `run.timeout` | Duration; agent time limit per case; a timed-out case skips its checks and `setup.before_checks` |
| `run.stop_grace` | Duration; delay between graceful and forced process-group termination |
| `run.check_timeout` | Duration, optional; default time limit for a command check that declares none |
| `agents.opencode.command` | Non-empty executable name or path; no agent-version constraint is accepted |
| `agents.opencode.secrets` | Variable names passed to the agent and redacted from every artifact; default `[]` |
| `agents.opencode.env` | Variable names passed to the agent as-is; default `[]` |
| `trackers.jira` | Optional Jira Cloud connection settings |
| `repositories` | At least one `{id, path}` entry, each optionally carrying `setup` |
| `models` | At least two `{id, model, effort, agent}` entries |
| `tasks` | At least one task |

Paths resolve relative to the configuration file. Resolution uses the directory of the path tevu read, without following symbolic links; tevu does not expand `~`. When the configuration lives in the user configuration directory rather than the current directory, use absolute paths for `run.output_dir`, `repositories[].path`, `checks.overlay`, and a path-form `agents.opencode.command`, since a relative value there resolves against the user configuration directory, not the directory tevu ran from. Bare executable names are found through `PATH`. IDs start with a lowercase letter, contain lowercase letters, digits, or hyphens, and have at most 64 characters. IDs are unique within their collection.

A block keyed by an adapter kind (`agents.opencode`, `trackers.jira`) holds that adapter's settings only, so a new agent or tracker adds a block and changes nothing else. `opencode` is the only configured agent today, so `models[].agent` defaults to it; a configuration with more than one agent must set `agent` explicitly to a configured agent key.

A model entry is one model/effort combination. `model` uses `provider/model` syntax and `effort` is non-empty. `effort` reaches OpenCode verbatim as its `--variant` argument, so it must name a reasoning-effort variant that the agent supports, either a built-in one or one defined in an `opencode.json` tracked at the task's `base_commit`. Different model entries may share the same `model`. The provider determines which model identifiers and efforts are supported.

## Value grammars

| Name | Rule |
| --- | --- |
| Duration | A positive integer without leading zeros followed by exactly one unit: `ms`, `s`, `m`, or `h`, for example `500ms`, `30s`, `10m`, `1h`. At most `2147483647` milliseconds |
| Variable name | A letter or underscore followed by letters, digits, or underscores. In `agents.opencode.secrets`, `agents.opencode.env`, a check's `env`, and `setup.env`, it must not be `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `CI`, or begin with `XDG_` |
| `$VARIABLE` reference | A dollar sign followed by a variable name, for example `$JIRA_API_TOKEN`; used only for `trackers.jira.email` and `trackers.jira.token` |

The duration bound keeps a configured value inside what a Node.js timer can schedule; a longer value is rejected rather than silently truncated. Secrets are never written to the configuration file: a credential is a `$VARIABLE` reference or a bare variable name, and its value comes from the environment that launches tevu.

## Tasks

| Field | Contract |
| --- | --- |
| `id` | Unique task ID |
| `title` | Non-whitespace; shown in the report, never sent to the agent |
| `repo` | An ID from `repositories`; defaults to the sole repository when exactly one is configured |
| `base_commit` | A commit resolvable in that repository; `tevu task add` records the resolved commit |
| `prompt` | Non-whitespace instructions sent to every model |
| `description` | Non-whitespace task description, sent to every model |
| `source` | Absent for a task written by hand; otherwise a saved Jira or GitHub import snapshot |
| `readiness` | At least one non-whitespace prerequisite you confirmed; never sent to the agent |
| `checks.restore` | Optional list of git `:(glob)` pathspec patterns reset to `base_commit` before checks run; absent or `[]` restores nothing |
| `checks.overlay` | Optional path to a hidden check-file directory copied onto the worktree root before checks run; resolves relative to the configuration file |
| `checks.acceptance` | Checks for the solution; at least one must be required |
| `checks.done` | Completion checks; at least one must be required |

`tevu validate` and `tevu run` reject a task when the prompt tevu sends to the agent contains the first 7 characters of the resolved `base_commit`, in any letter case. This prompt is built from `prompt`, `description`, and the `checks.acceptance` and `checks.done` descriptions.

A task written by hand has no `source` block. An imported source has `kind` (`jira` or `github`), `key`, `url`, `imported_at`, `title`, and `body`. `tevu task add --jira` or `--github` fills this block once from a one-time import; later changes in the tracker never update the task.

### Source trees

The configured source repository is read-only to tevu. Each case receives a sealed repository with one synthetic root commit containing the tracked tree at `base_commit`. Dirty and untracked source-worktree files are excluded.

The case contains no source remotes, later history, tags, stashes, or shared object database. Sibling cases have separate Git metadata and writable directories. The original repository and commit identity are retained separately from the synthetic commit.

Submodules and Git LFS sources are unsupported. Project instructions tracked at the pinned commit remain task context. The [isolation explanation](../concepts/isolation.md) covers why these boundaries matter to a comparison.

## Checks

Each check has `id`, `description`, and `required` (default `true`), plus either `run` or `manual: true`. Check IDs are unique across both check collections within a task. Every model entry for a task receives the same checks.

`manual: true` requires a verdict through `tevu assess`. A command check (`run`) has the following fields:

| Field | Contract |
| --- | --- |
| `run` | Non-empty array: executable followed by literal arguments, no shell |
| `timeout` | Duration; defaults to `run.check_timeout`. Rejected when both are absent |
| `exit_codes` | Non-empty array of integer exit codes; defaults to `[0]` |
| `env` | Variable names available to the command; defaults to `[]` |

For example, a task whose target repository uses `npm test` can define:

```yaml
id: tests
description: The repository's test suite passes.
run: [npm, test]
# timeout: 2m           # defaults to run.check_timeout
# exit_codes: [0]       # exit codes that count as a pass; defaults to [0]
# env: [NODE_OPTIONS]   # variables this check receives
# required: false       # checks are required unless stated otherwise
```

Commands run sequentially in the case workspace. Arguments are passed directly, without a shell. A target task's test command is independent of tevu's own product-test runner. The solution patch is captured before checks run, relative to the state `before_agent` left when the repository declares one; restore and overlay then run, followed by `setup.before_checks` when declared, so command checks see the restored and overlaid worktree rather than the state the agent left. Ignore rules never hide a change to a tracked path, meaning a path in the [patch base](#repository-setup) when one was recorded and in `base_commit` otherwise.

### Restore and overlay

After the solution patch is captured, tevu resets every path `checks.restore` matches to `base_commit` and then copies `checks.overlay`'s files onto the worktree root; `setup.before_checks` runs after this restore and overlay step, and before the first check. Both keys are optional and independent; a task can declare either, both, or neither. tevu reads a configured overlay directory once per run, before the run starts, so every case that uses it writes the same snapshot; editing the directory during a run changes no case of that run, and takes effect only in the next run.

`checks.restore` patterns are git pathspecs with `:(glob)` magic: `*`, `?`, and `[...]` do not match `/`; `**/` matches zero or more leading directories; `/**` matches everything inside a directory; a pattern without wildcard characters also matches everything beneath a directory of that name. `restore: []` and an absent `restore` both declare nothing to restore.

Restore returns every matched path in the base tree to the state a checkout of `base_commit` produces, and removes every matched path that is untracked relative to the base tree, including files ignored through `.gitignore` or `info/exclude`. A pattern matching no path restores nothing, leaving the evidence of an agent that changed nothing. Because the untracked listing has no exclude option, a pattern such as `**/*.test.ts` also reaches test files ignored under `node_modules`, and a pattern starting with `**/` makes git traverse every directory; name the directories a pattern means rather than relying on a broad wildcard. A file inside an untracked nested repository (a directory holding `.git`) survives restore unless a pattern matches the repository directory itself (`tests/**` does, `**/conftest.py` does not); `solution.patch` shows such a repository as one `Subproject commit` line, while `checkState.restore.removed` lists every file of a deleted one, `.git` contents included. A check command's own configuration, such as the `package.json` scripts behind `npm test`, stays agent-editable unless a restore pattern names it. A test whose expected result the fix legitimately changes belongs in the overlay instead of `restore`, because restoring it brings back the base expectation, which every correct fix fails.

`checks.overlay` names a directory of regular files and directories only: no symbolic link and no entry named `.git`. Its path must resolve outside every configured repository and must not overlap `run.output_dir`. Overlay files overwrite an existing worktree file, a symbolic link at the destination is replaced without ever being written through, and a blocking entry is removed and recorded.

`tevu validate` and `tevu run` reject a missing, non-directory, or otherwise invalid overlay, a restore pattern that is empty or escapes the repository root (a leading `/` or a `..` segment), an overlay inside a configured repository, and an overlay overlapping `run.output_dir`. A restore or overlay step that fails at run time, for example against worktree state the agent left, ends the case as `infrastructure-failed` with failure kind `CheckStateError`; see the [results reference](results.md#check-state) for the recorded evidence and the [isolation explanation](../concepts/isolation.md#context-isolation-is-not-a-sandbox) for why hidden checks are not a sandbox boundary.

## Repository setup

An entry in `repositories` may declare `setup`, which prepares every case that uses it.

| Field | Contract |
| --- | --- |
| `setup.before_agent` | List of commands; run once per case after sealing, before the agent starts. `[]` is equivalent to an absent key |
| `setup.before_checks` | List of commands; run after restore and overlay, before the first check. `[]` is equivalent to an absent key |
| `setup.timeout` | Duration; limit for one setup command; required whenever `setup` is present, with no fallback to `run.check_timeout` |
| `setup.env` | Variable names passed as-is to this repository's setup commands; default `[]` |

At least one of `before_agent` and `before_checks` must hold a command. A setup command is the same shape as a check's `run`: a non-empty executable followed by literal string arguments, no shell.

A case with `setup` declared runs these steps, in order: seal the case and build its environments; run `before_agent` and, on success, record the worktree as the patch base, when the repository declares `before_agent`; run the agent; capture the solution patch, relative to the patch base when one was recorded, otherwise relative to the case's synthetic root commit; restore and overlay; run `before_checks`, when the repository declares it; run the checks. Each setup command's environment is the fixed evaluator environment plus `setup.env`, built the same way a check's environment is, and its working directory is the case worktree. Commands of one phase run sequentially in declared order; no agent secret or `agents.opencode.env`/`agents.opencode.secrets` value is ever present.

`before_agent` is the only setup phase that runs before the agent, so whatever it leaves in the worktree, the evaluator home, or the evaluator temporary directory is visible to the agent, which can read and change it before `before_checks` and the checks reuse those directories; restore reaches only the worktree paths `checks.restore` matches. A `setup.env` value is an ordinary variable, not a secret: a setup command that prints it leaves it unredacted in its phase log, and one written to a file the agent reads reaches the agent. There is no `setup.secrets` key; a credential a setup command needs, such as a private registry token, is out of scope.

A setup command's timeout is `setup.timeout`, independent of `run.timeout` and `run.check_timeout`. A `before_agent` or `before_checks` command that fails, times out, or does not start ends the case as `infrastructure-failed` with outcome `not-evaluated`: a `before_agent` failure means the agent never started, and a `before_checks` failure means no check ran. A run cancellation during either phase ends the case as `cancelled`. See the [results reference](results.md#repository-setup) for the recorded evidence.

The patch base records the worktree state `before_agent` left, in a private object directory outside the case repository, so `solution.patch` applies to that state rather than to `base_commit`: a `before_agent` output the agent left unchanged never appears in it. A path an ignore rule keeps out of the base, such as `node_modules`, enters the patch as added only if the agent changes the ignore rules so the rule no longer matches it.

Restore resets every `checks.restore`-matched path to `base_commit` and removes every matched untracked path, so its removed-path evidence can list `before_agent` output. A file `before_checks` reads, such as `package.json`, `package-lock.json`, or `.npmrc`, stays agent-editable unless a restore pattern names it.

`tevu validate` and `tevu run` reject a `setup` block that declares neither phase, a command that is empty or starts with an empty argument, a missing `timeout`, a `setup.env` name shared with an agent's `secrets` or `env`, a Jira credential variable, a duplicate name, or a fixed name.

## Environment variables

`agents.opencode.secrets` and `agents.opencode.env` name variables by value only: every `secrets` entry is redacted from saved and displayed evidence, and every `env` entry is passed through as-is. A name cannot appear in both lists, and neither list may repeat a name.

A check's `env` names ordinary variables available to that command only. A name there must not also appear in `agents.opencode.secrets` or `agents.opencode.env`, and must not be the variable that `trackers.jira.email` or `trackers.jira.token` references. Every declared variable must be present in the launching environment. `setup.env` follows the same rule.

`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `CI`, and all `XDG_*` names are supplied by tevu and cannot be configured in these lists.

### Fixed evaluator environment

| Variables | Value |
| --- | --- |
| `PATH` | Run-level snapshot of the parent's executable search path |
| `HOME` | Per-case evaluator home |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` | Directories under the evaluator home |
| `TMPDIR` | Per-case evaluator temporary directory |
| `LANG`, `LC_ALL` | `C.UTF-8` |
| `CI` | `1` |

No other parent variables are inherited. Sequential checks and setup commands reuse these directories. Evaluator home, state, and temporary directories are separate from the agent's directories.

Agent processes receive the same fixed variable names with their own per-case home, state, and temporary directories, plus the variables declared in `agents.opencode.secrets` and `agents.opencode.env`. Host agent sessions, global configuration, caches, and login stores are not copied.

## Jira Cloud

| Field | Contract |
| --- | --- |
| `trackers.jira.url` | HTTPS site URL |
| `trackers.jira.email` | `$VARIABLE` reference to the account email |
| `trackers.jira.token` | `$VARIABLE` reference to the API token |

`trackers.jira` is optional. `tevu validate` and `tevu run` check only its structure: the URL is HTTPS and `email`/`token` are `$VARIABLE` references. Neither command checks that the referenced variables are set. `tevu task add --jira` checks both at import time, when it needs their values to call Jira.

Neither Jira credential variable may appear in a check's `env`. Jira import is read-only and uses at most three requests per import, sharing that budget across redirects and retries. Jira Server and Data Center are unsupported.

The [Jira import guide](../guides/import-jira-task.md) describes connection setup and task creation.

## GitHub issues

GitHub issues has no configuration fields. `task add --github` needs the GitHub CLI (`gh`) on `PATH`, authenticated for the issue's host: `gh auth login` for `github.com`, or `gh auth login --hostname <host>` for a GitHub Enterprise Server host, because gh never receives `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN`. tevu reads and stores no GitHub token; gh owns authentication entirely.

Each import makes one `gh issue view` call with a 30-second limit and no retries beyond gh's own. `tevu validate`, `tevu run`, and `tevu report` never run gh.
