# Configuration reference

tevu reads UTF-8 YAML with `version: 1`. Unknown fields are rejected at every level. `--config` selects the file explicitly; without it, tevu reads `./tevu.yaml`, or the user configuration file under `$XDG_CONFIG_HOME/tevu` or `$HOME/.config/tevu`. See the [CLI reference](cli.md) for the complete search order.

## Example

`tevu config example` prints this template to stdout:

```sh
tevu config example > tevu.yaml
```

The shell creates the file, or replaces an existing one, before tevu starts; tevu itself writes no file. This template compares two model entries at different reasoning efforts on one task using a graded check, a command check, and a manual check. The repository path, commit, model identifiers, efforts, criteria and grader models, and credential-variable name are illustrative values, not a ready-to-run configuration. The [benchmark guide](../guides/run-benchmark.md) covers setup for a real task.

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
  # - id: app-upstream              # a GitHub repository tevu clones itself, instead of a path
  #   github: your-org/your-app     # OWNER/REPO, or https://HOST/OWNER/REPO on GitHub Enterprise Server

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

# --- Roles ------------------------------------------------------------------
# Models tevu uses for its own work rather than comparing them. A role's
# provider credential goes in its agent's secrets (agents.opencode.secrets),
# which every case agent of that agent also receives.
roles:
  criteria:                       # drafts criteria from a reference solution in tevu task add
    model: openai/your-criteria-model
    effort: high                  # a variant the agent provides without a repository
    # agent: opencode             # needed only when more than one agent is configured
  grader:                         # grades each graded check after a case's checks run
    model: openai/your-grader-model
    effort: medium                # a variant the agent provides without a repository
    # agent: opencode             # needed only when more than one agent is configured

# --- Tasks ------------------------------------------------------------------
tasks:
  - id: csv-export
    title: Export the current view as CSV
    repo: app                     # may be omitted while there is one repository
    base_commit: "0123456789abcdef0123456789abcdef01234567"   # a commit from before the fix
    # timeout: 20m                # overrides run.timeout for this task

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
        - id: csv-content         # graded by roles.grader against its description
          description: The CSV contains the visible rows and correctly escapes values.
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
          manual: true            # you record the verdict with `tevu assess`
```

`tevu task add` appends to this file: the interviewed task, and a new repository when one was chosen, are added after the existing content of the `tasks` and `repositories` lists. Every other byte, comment, and blank line is kept unchanged. Both lists must stay in block style (one `- ` item per line, never `tasks: [...]`) for the append to succeed; a flow-style list is reported as a finding and nothing is written. A task added by editing the file by hand keeps every comment the same way.

## Top-level fields

| Field | Contract |
| --- | --- |
| `version` | Must be `1` |
| `run.output_dir` | Non-empty; run evidence directory, outside and non-overlapping with configured repositories after resolving symlinks |
| `run.concurrency` | Integer from 1 through 32 |
| `run.repeat` | Integer from 1 through 100, optional, default `1`; attempts per task/model pair, each an independent case; `tevu run --repeat <n>` overrides it for one run |
| `run.timeout` | Duration; default agent time limit per case; a task's `timeout` replaces it for every case of that task; a timed-out case skips its checks and `setup.before_checks` |
| `run.stop_grace` | Duration; delay between graceful and forced process-group termination |
| `run.check_timeout` | Duration, optional; default time limit for a command check that declares none |
| `agents.opencode.command` | Non-empty executable name or path; no agent-version constraint is accepted |
| `agents.opencode.secrets` | Variable names passed to the agent and redacted from every artifact; default `[]` |
| `agents.opencode.env` | Variable names passed to the agent as-is; default `[]` |
| `trackers.jira` | Optional Jira Cloud connection settings |
| `repositories` | At least one entry, each `{id, path}` (a local repository) or `{id, github}` (a GitHub repository tevu clones itself), optionally carrying `setup`; see [GitHub repositories](#github-repositories) |
| `models` | At least two `{id, model, effort, agent}` entries |
| `roles` | Optional; the `criteria` and `grader` model roles, covered under [Model roles](#model-roles); `grader` is read by `tevu run`, `criteria` by `tevu task add` |
| `tasks` | At least one task |

Paths resolve relative to the configuration file. Resolution uses the directory of the path tevu read, without following symbolic links; tevu does not expand `~`. A GitHub repository entry's `github` value does not resolve against the file at all: its directory is the managed-clone location under the managed-clone root, covered under [GitHub repositories](#github-repositories). When the configuration lives in the user configuration directory rather than the current directory, use absolute paths for `run.output_dir`, `repositories[].path`, `checks.overlay`, and a path-form `agents.opencode.command`, since a relative value there resolves against the user configuration directory, not the directory tevu ran from. Bare executable names are found through `PATH`. IDs start with a lowercase letter, contain lowercase letters, digits, or hyphens, and have at most 64 characters. IDs are unique within their collection.

A block keyed by an adapter kind (`agents.opencode`, `trackers.jira`) holds that adapter's settings only, so a new agent or tracker adds a block and changes nothing else. `opencode` is the only configured agent today, so `models[].agent` and `roles.<role>.agent` both default to it; a configuration with more than one agent must set `agent` explicitly to a configured agent key.

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
| `base_commit` | A commit resolvable in that repository; `tevu task add` records the resolved commit. For a pull-request reference, `tevu task add` can save a commit the repository does not hold yet; `tevu validate` requires it locally for a path entry, and names it as a `tevu run --dry-run clones it`/`fetches it` finding for a GitHub entry, which `tevu run` then clones or fetches |
| `timeout` | Duration, optional; agent time limit of every case of this task, for every model entry and attempt; replaces `run.timeout`, which applies when the key is absent |
| `prompt` | Non-whitespace instructions sent to every model |
| `description` | Non-whitespace task description, sent to every model |
| `source` | Absent for a task written by hand; otherwise a saved Jira or GitHub import snapshot |
| `reference` | Optional; absent means no reference solution. `tevu task add` records it once; covered under [Reference solution](#reference-solution) |
| `readiness` | At least one non-whitespace prerequisite you confirmed; never sent to the agent |
| `checks.restore` | Optional list of git `:(glob)` pathspec patterns reset to `base_commit` before checks run; absent or `[]` restores nothing |
| `checks.overlay` | Optional path to a hidden check-file directory copied onto the worktree root before checks run; resolves relative to the configuration file |
| `checks.acceptance` | Checks for the solution; at least one must be required |
| `checks.done` | Completion checks; at least one must be required |

`tevu validate` and `tevu run` reject a task when the prompt tevu sends to the agent contains the first 7 characters of the resolved `base_commit`, in any letter case. This prompt is built from `prompt`, `description`, and the `checks.acceptance` and `checks.done` descriptions.

A task written by hand has no `source` block. An imported source has `kind` (`jira` or `github`), `key`, `url`, `imported_at`, `title`, and `body`. `tevu task add --jira` or `--github` fills this block once from a one-time import; later changes in the tracker never update the task.

### Reference solution

A task may record `reference`: a GitHub pull request or a commit `tevu task add` resolved from the operator's answer to the reference-solution question, and the proposed base commit it derived from that resolution. It is provenance for later use, read once when the task is added; the operator can override the proposed base, and nothing later refreshes the block.

```yaml
reference:
  kind: pull-request            # pull-request or commit
  identifier: octo/app#128      # the operator's answer, trimmed
  commits:                      # every pull request commit, in GitHub's order
    - "<hash>"
    - "<hash>"
  merge_commit: "<hash>"        # merged pull request only, when it is not in commits
```

| Field | Contract |
| --- | --- |
| `reference.kind` | `pull-request` or `commit` |
| `reference.identifier` | The answer as given, trimmed: non-whitespace text for `commit`; for `pull-request`, `OWNER/REPO#NUMBER` or a pull request URL, without user info or a port |
| `reference.commits` | Distinct full lowercase commit hashes. `commit`: exactly one, the commit. `pull-request`: at least one, every commit GitHub lists for the pull request, in GitHub's order |
| `reference.merge_commit` | `pull-request` only, optional: the merge commit of a merged pull request when it is not already in `commits` |

For a commit reference, `tevu task add` proposes the commit's first parent as the base commit; for a merge commit, that is its mainline-side parent.

For a pull request, the proposed base depends on which commits GitHub lists as having no parent inside the pull request itself (its "first commits") and on the pull request's state and mergeability:

| Pull request | Proposed base | Note |
| --- | --- | --- |
| Merged | The first commits' shared parent | The target branch already holds the solution |
| Open or closed, target branch deleted | The first commits' shared parent | Warned: "Target deleted" |
| Open or closed, conflicting | The first commits' shared parent | Warned: "Conflict" |
| Open or closed, mergeability unknown | The tip of the target branch | Warned: "Mergeability unknown" |
| Open, mergeable | The tip of the target branch | |
| Closed, mergeable | The tip of the target branch | Warned: "Closed", since GitHub does not recheck a closed pull request against a moving target |

When the first commits do not share exactly one parent, for example because the pull request merged another branch or force-pushed over an unrelated history, no base is proposed; the reference is still recorded, and the operator enters a base as without one. A target tip the operator accepts is saved as `base_commit` even when the local repository does not hold it yet; `tevu validate` and `tevu run` require it before they run.

`tevu validate` rejects a base commit that equals a recorded reference commit, descends from a recorded pull-request commit, or does not precede a recorded merge commit or a commit reference's commit, counting only commits available locally; an unmerged pull request's target tip passes unless it equals or descends from a recorded pull-request commit available locally. Comparison uses hashes and ancestry only, never content, so a base holding the solution under another hash still passes: a rebase merge's other copies, a cherry-pick, or an equivalent squash on another branch. Because comparison is by hash, a commit reference must hold the whole solution in the one commit it names.

When a reference commit is not available in the local repository, `tevu validate` warns once per task, `reference commits not available in repository "<repo id>": <n> of <total>; the base commit was not compared with them`. For a GitHub entry, this warning ends `; tevu run --dry-run fetches them`. An unavailable merge commit also draws a warning of its own, `merge commit <hash> is not available in repository "<repo id>"; the base commit was not checked to precede it`, ending `; tevu run --dry-run fetches it` for a GitHub entry, since a clone holding only the target branch never has the original commits a squash or rebase merge folded together; expect this pair of warnings after such a merge. A commit reference's single unavailable commit draws only the first warning. Neither warning changes `tevu validate`'s exit code.

When a pull-request task's `base_commit` is a full hash a path-entry repository does not hold, `tevu validate` names the fetch to run, from the pull request's own repository:

```
error tasks.<id>.base_commit: base commit <hash> is not in repository "<id>" ("<path>"); fetch it there first, for example: git fetch https://<host>/<owner>/<repo>.git <hash>
```

For a GitHub entry, any task whose `base_commit` its clone does not hold, whatever its reference, instead names `tevu run --dry-run` as the fix:

```
error tasks.<id>.base_commit: base commit "<base_commit>" is not in the clone of repository "<id>"; tevu run --dry-run fetches it from <host>/<owner>/<repo>
```

`tevu validate` and `tevu run` also reject a task whose agent prompt contains, in any letter case, the first 7 characters of a recorded reference commit (the same rule already applied to `base_commit`) or, for a pull-request reference, its `OWNER/REPO#NUMBER` key or its URL form `HOST/OWNER/REPO/pull/NUMBER`, matched as plain substrings built from the recorded identifier. Neither command checks a prompt for any other hint to the accepted solution, such as a bare issue-style `#NUMBER`, a branch name, or a title.

The `## GitHub issues` section below covers the gh setup a pull-request reference shares with issue import.

### Source trees

Every configured source repository, a local path or a managed GitHub clone, is read-only to every case. Each case receives a sealed repository with one synthetic root commit containing the tracked tree at `base_commit`. Dirty and untracked source-worktree files are excluded. tevu itself writes only to a managed clone, and only before cases start: cloning or fetching for `tevu task add` or `tevu run` finishes before the first case is sealed, never while a case runs. `tevu validate` also starts a path entry's case executables inside that entry's directory; tevu warns about a file that changes there and never reverts it, and never writes there itself; see [Case executables](#case-executables).

The case contains no source remotes, later history, tags, stashes, or shared object database. Sibling cases have separate Git metadata and writable directories. The original repository and commit identity are retained separately from the synthetic commit.

Submodules and Git LFS sources are unsupported. Project instructions tracked at the pinned commit remain task context. The [isolation explanation](../concepts/isolation.md) covers why these boundaries matter to a comparison.

## Checks

Each check has `id`, `description`, and `required` (default `true`), plus `run` (a command check), `manual: true` (a manual check), or neither (a graded check, the default kind `tevu task add` proposes). Check IDs are unique across both check collections within a task. Every model entry for a task receives the same checks.

A graded check needs a description with non-whitespace text, since `roles.grader` grades against it; see [Graded checks](#graded-checks). `manual: true` requires a verdict through `tevu assess`. A command check (`run`) has the following fields:

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

### Graded checks

A graded check states a criterion in plain language and is graded by `roles.grader` after a case's other checks run: exactly one model call per case whose task declares at least one graded check, whatever the number of graded checks that task has. The grader receives the task's `prompt` and `description`, every graded check's `id` and `description`, and the captured solution patch, whole and with no size limit; it never receives a reference solution, even when the task records one, a case ID, a run ID, or the identity of the model entry that produced the solution. The call's time limit is `run.timeout`, the same limit an agent attempt runs under; there is no separate grader time-limit setting.

Each graded check's verdict is `passed`, `failed`, or `undetermined`, with a rationale that names the patch files and line ranges it relies on. A grader call that fails, times out, or returns a reply tevu cannot parse leaves every graded check of that case pending with the failure's reason recorded; a pending or `undetermined` graded check is never recorded as a pass or a fail, and the call's usage and cost are recorded as unavailable, never zero or estimated. Recover a pending or `undetermined` verdict with `tevu assess`, or by running the task again in a new run.

`tevu validate` and `tevu run` require `roles.grader` to be declared whenever a configured task declares a graded check; see [Model roles](#model-roles) for the role's configuration and credential.

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

## GitHub repositories

A `github` entry names a repository on `github.com` or a GitHub Enterprise Server host, in place of `path`: `OWNER/REPO`, or `https://HOST/OWNER/REPO` for a host other than `github.com`. `OWNER` is a letter or digit followed by up to 99 letters, digits, hyphens, or underscores; `REPO` is 1 to 100 letters, digits, dots, hyphens, or underscores, never `.` or `..`, with one trailing `.git` stripped before that grammar applies. The URL form takes no user info, port, query, or fragment, and its host holds only letters, digits, hyphens, and dots. A repository entry declares exactly one of `path` or `github`.

tevu keeps one bare clone per lowercased `<host>/<owner>/<repo>`, shared by every entry and configuration that names it, at `<root>/<host>/<owner>/<repo>.git` under the managed-clone root: `$XDG_CACHE_HOME/tevu/repositories` when `XDG_CACHE_HOME` is set, non-empty, and absolute, otherwise `$HOME/.cache/tevu/repositories` under the same test, otherwise there is no root and every command that would need one reports a finding naming the unset variable. The clone holds full history, no `--depth` and no `--filter`, because sealing borrows objects through a temporary alternates link and the reference-solution ancestry checks walk history; its local configuration sets `gc.auto=0` and `maintenance.auto=false` so a concurrent fetch never drops an object or pack a reader needs, and it carries no `credential` configuration key. Deleting the managed-clone root is always safe: the next command that needs a clone creates it again.

`tevu task add` clones a newly selected GitHub entry immediately and fetches its base-commit and reference-solution answers as they are typed. `tevu run` and `tevu run --dry-run` clone or fetch, once per GitHub entry a task names, before validation: first each entry's tasks' base commits, then each task's reference-solution commits, only for whatever `tevu validate`'s own commit resolution would not already find locally. `tevu validate`, `tevu assess`, `tevu report`, and `tevu config example` never themselves clone, fetch, or otherwise reach the network; a missing clone or a commit absent from it is reported as a validation finding naming the command that fixes it, covered in [Tasks](#tasks) and [Reference solution](#reference-solution). A case executable `tevu validate` starts may still reach the network on its own; see [Case executables](#case-executables).

A clone or fetch holds a `mkdir` lock directory (the clone's own path with `.lock` appended) for its duration, across processes; the lock never waits and is never removed automatically, so a command that finds one already present fails, naming the lock path, whether another tevu command is updating the clone or the lock is stale and needs the operator to remove it.

Access goes through the GitHub CLI (`gh`), set up the same way as GitHub issue import: `gh auth login` for `github.com`, or `gh auth login --hostname <host>` for a GitHub Enterprise Server host. tevu runs git itself, with a top-level `git -c credential.https://<host>.helper=` reset followed by `-c credential.https://<host>.helper=!gh auth git-credential`, scoped to the one command that needs it; git never stores the helper, and gh, not tevu, ever holds or sees a token. Every network git command ignores the operator's gitconfig (`GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` point at `/dev/null`), so settings such as `http.sslCAInfo`, `http.proxy`, and `url.<base>.insteadOf` have no effect; TLS and proxy behavior come only from `GIT_SSL_*`, `GIT_HTTP_*`, `GIT_PROXY_SSL_*`, and proxy variables such as `HTTPS_PROXY`, which pass through unlike every other `GIT_*` variable.

A branch or tag name in `base_commit` or a reference solution is fetched only when it does not already resolve; when it is fetched, every branch and tag of the remote is force-updated, so a shared name can resolve to a different commit across runs. Pin a full commit hash, which `tevu task add` always writes for `base_commit`, to keep a task's pinned commit fixed regardless of what the remote does later.

A GitHub entry's clone directory, and the managed-clone root itself, must not equal, lie inside, or contain `run.output_dir`, an overlay directory, or a path-entry repository's directory, after resolving symbolic links; `tevu validate` and `tevu run` report an overlap the same way they report any other repository or output-directory overlap.

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

A model call's agent process receives the same treatment: the case agent variables of its agent block's `secrets` and `env`, with its own home, state, and temporary directories, and an empty Git repository as its working directory, all removed after the call. See [Model roles](#model-roles).

### Case executables

A case executable is the first element of a command a case would start: an agent's `command`, the first element of each `setup.before_agent` and `setup.before_checks` command, and the first element of each command check's `run`. `tevu validate` probes every case executable before any case starts; `tevu run` and `tevu run --dry-run` run the same check as part of validation, also before any case starts.

For each case executable, tevu starts `<executable> --version` once in a replica of its case environment, and, only when that run does not exit 0 before a 10-second limit, once more in tevu's own environment with the withheld names removed.

| Replica run | Parent run | Result |
| --- | --- | --- |
| Exits 0 before the limit | Not started | The executable runs; nothing is reported |
| Reaches the 10-second limit | Not started | Undetermined; nothing is reported, since the executable may be downloading a toolchain into its empty home and a case with a longer limit could still finish |
| Fails to exit 0 | Exits 0 before the limit | The executable runs only in tevu's own environment; an error finding names it |
| Fails to exit 0 | Any other outcome | Undetermined; nothing is reported |

Both runs share one working directory: a path entry's own directory for its setup commands and its tasks' command checks, and a new empty directory for the agent command and for a GitHub entry's commands.

The parent run omits these names even when tevu's own environment sets them: every configured agent's `secrets` names, the variable `trackers.jira.token` references, and `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN`. It still gives the executable every other variable of tevu's own environment, the operator's HOME included, so a started executable may use the network, write files, or install the toolchain a version file names, on its own, in a path entry's directory or elsewhere.

tevu does not judge a case executable that is a relative path containing a `/`, since it resolves inside a case worktree that does not exist during validation; one whose `--version` does not exit 0 in the parent run from its working directory, including a tool with no `--version` option, a version selected only by a version file inside a GitHub entry's repository or, for the agent command, inside a repository; a replica run that reaches the 10-second limit; or a command the agent or a case executable starts itself.

An error finding appears at `agents.<name>.command`, `repositories.<repo-id>.setup.<phase>.<index>`, or `tasks.<task-id>.checks.<collection>.<check-id>.run`, and makes the configuration invalid. Its message names the executable, why the replica run failed, and two remedies: declare the variable it reads, if a case does not already give it one; or, for a version-manager shim, start tevu with the real executable's directory before the shim directory on PATH.

In a path entry's directory, tevu compares the files Git reports as changed or untracked before and after each run, by type, permissions, size, and modification and status-change times. A run that changed one draws a warning naming the executable and up to 10 changed paths plus a count of the rest, worded as a change made while the executable was running, because the operator or another program may edit the directory at the same time; tevu never reverts, restores, or removes such a change. A failed comparison draws a warning saying the check could not be made. Neither warning makes the configuration invalid or stops `tevu run`. The comparison does not see an ignored file, the Git directory, or a write outside the working directory, such as a toolchain installed under the operator's home.

## Model roles

`roles` declares the models used by commands outside the benchmark itself: `criteria` drafts acceptance criteria and a Definition of Done, and `grader` grades a case's solution against its criteria. Each names an agent, a model, and an effort the same way a `models` entry does.

```yaml
roles:
  criteria:                                # drafts acceptance criteria and a Definition of Done
    model: anthropic/your-drafting-model
    effort: high                           # a variant the agent provides without a repository
    agent: opencode                        # optional; defaults to the configured agent
  grader:                                  # grades a case's solution against its criteria
    model: openai/your-grader-model
    effort: medium
```

| Field | Required | Default | Allowed values |
| --- | --- | --- | --- |
| `roles` | No | Absent: no model role declared | A mapping whose keys are `criteria`, `grader`, or both; `{}` declares neither; any other key, or `null`, is rejected |
| `roles.criteria` | No | Absent | A model role mapping (the three fields below) |
| `roles.grader` | No | Absent | A model role mapping |
| `roles.<role>.model` | Yes | None | `provider/model`, the same grammar as `models[].model` |
| `roles.<role>.effort` | Yes | None | Non-empty string, passed verbatim as OpenCode's `--variant`, naming a variant the agent provides without a repository: built-in or provider-defined, never one defined only in a repository's `opencode.json` |
| `roles.<role>.agent` | No | `opencode` | A key of `agents` |

The two roles are configured and used independently: each is required only by the command that reads it, and a configuration declaring neither is valid. `tevu run` is the reader of `roles.grader`, calling it once per case whose task declares a graded check; see [Graded checks](#graded-checks). `tevu task add` is the reader of `roles.criteria`, calling it at most once per task and only for a task with a reference solution; no command requires it, and without it the setup interview asks for acceptance criteria and a Definition of Done by hand. They stay separate settings rather than one shared model because a model grading or drafting for its own family tends to favor it. The same model may serve a model role and a model entry; tevu does not forbid using one model for both.

A model role's provider credential belongs in its agent block's `secrets`, not in the role itself; every case agent of that block receives the same credential, so a role on a provider no model entry uses exposes its credential to every benchmarked case agent of that agent. Neither the loader nor `tevu validate` checks a role's credential or effort against its provider: a missing credential fails the call at run time, and an unknown effort runs at the model's default effort.

`tevu validate` probes each distinct agent a model entry or a model role names, once per agent, the same way it probes a model entry's agent: variable presence and the agent capabilities the call needs, without starting a model session. See the [isolation explanation](../concepts/isolation.md#model-calls-get-no-task-repository) for how a model call's environment differs from a case agent's.

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

Each import makes one `gh issue view` call with a 30-second limit and no retries beyond gh's own.

| Command | Network use |
| --- | --- |
| `tevu task add` | Jira and gh as described above; clone and fetch for a selected GitHub repository entry; with `roles.criteria` declared and a reference solution, one more `gh api` call for a pull-request reference's diff, and one model session to draft criteria |
| `tevu run`, `tevu run --dry-run` | Preparation clone and fetch, only for a missing clone or commit; model sessions in `run` only |
| `tevu validate`, `tevu assess`, `tevu report`, `tevu config example` | None from these commands themselves; `tevu validate` starts `gh` locally with `--version` only, when `gh` is a case executable (see [Case executables](#case-executables)) |

A pull-request reference answer uses this same gh setup and makes one `gh api graphql` call, also with a 30-second limit. GitHub lists at most 250 commits of a pull request; tevu records a pull request only when it can read its complete commit list.

Drafting criteria from a pull-request reference makes one more `gh api` call, reading the pull request's unified diff through GitHub's diff media type, under the same 30-second limit. Drafting from a commit reference reads its diff from the repository directly, through no gh call at all.
