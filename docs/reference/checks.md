# Checks reference

The `checks` block of a task: check kinds, command check fields, graded checks, and the restore and overlay steps that prepare the worktree before checks run.

## Check fields

A task has two check collections, `acceptance` (does the change solve the task) and `done` (is the work complete beyond the fix). Each needs at least one required check.

Every check has `id`, `description`, and `required` (default `true`). Its kind depends on one more key:

| Kind | Marker | Verdict comes from |
| --- | --- | --- |
| Command | `run` | The command's exit status |
| Manual | `manual: true` | The operator, through `tevu assess` |
| Graded | neither | `roles.grader`, then optionally the operator |

Rules:

- A graded check needs a non-whitespace `description`, since the grader judges against it.
- `manual: false` is rejected. A check cannot declare both `run` and `manual`.
- `timeout`, `exit_codes`, and `env` are valid only with `run`.

## Command checks

| Field | Contract |
| --- | --- |
| `run` | A string with at least one non-blank character, run as `/bin/sh -c <run>`. Or a non-empty array of an executable followed by literal arguments, run without a shell |
| `timeout` | Duration. Defaults to `run.check_timeout`. Rejected when both are absent |
| `exit_codes` | Non-empty array of integers that count as a pass. Default `[0]` |
| `env` | Variable names available to the command. Default `[]` |

```yaml
- id: tests
  description: The repository's test suite passes.
  run: npm test          # or [npm, test] to run without a shell
  timeout: 2m
  exit_codes: [0]
  env: [NODE_OPTIONS]
  required: false
```

Execution rules:

- Commands run sequentially in the case worktree.
- The shell is `/bin/sh` by absolute path, never looked up on `PATH`. It receives only the check's evaluator environment (see [Environment](environment.md#fixed-evaluator-environment)), so `$VAR` expands from the fixed variables and the names in `env`. Any other name expands to empty text.
- The check passes when the exit status of the shell, which is the status of the last command it ran, is in `exit_codes`.
- Timeout and cancellation end the whole process group, background commands included. A grace period set by `run.stop_grace` separates the graceful stop from the forced kill.
- When the command exits on its own, background commands that still hold its stdout or stderr get up to `run.stop_grace` to finish. Any still running then are force-killed, and that stream's evidence can end early.
- An array `run` starts its executable directly with literal arguments.
- Checks run after the solution patch is captured, after restore and overlay, and after `setup.before_checks` when declared. They see the restored and overlaid worktree, not the state the agent left.

## Graded checks

`roles.grader` grades every graded check of a case from one reply, after the case's other checks run. `tevu validate` and `tevu run` require `roles.grader` whenever a task declares a graded check.

- **Input.** The task's `prompt` and `description`, the `id` and `description` of every graded check, and the whole solution patch with no size limit. The grader never receives a reference solution, a case ID, a run ID, or the identity of the model entry that produced the solution.
- **Tools.** None. The grader's calls run with every tool denied, so a grading cannot read or change files.
- **Time limit.** `run.timeout` bounds each call's model session, even when the task sets its own `timeout`. The [tool denial check](agents-and-models.md#tool-denial-check) before the session has its own 120 second limit that does not count against `run.timeout`. There is no separate grader setting.
- **Cases graded.** A case is graded only when it reached check evaluation. A timed-out, cancelled, or unreadable case is not.
- **Verdicts.** `passed`, `failed`, or `undetermined`, each with a rationale. The grader is asked to name the patch files and line ranges it relies on; the parser requires only a non-empty rationale.
- **Failures.** A call whose model stopped before finishing its reply is made again, up to three calls in total. A call whose session holds a tool call is not made again, and neither is a call that times out or fails any other way. A failure leaves every graded check of the case pending, and `grading.json` records its cause and every call. The usage and cost of each call enter the grading's totals only when every call has the value; otherwise the total is unavailable. A reply tevu cannot parse also leaves every graded check pending, but keeps the call's real usage and cost.
- **Recovery.** A pending or `undetermined` verdict is never recorded as a pass or a fail. Resolve it with `tevu assess` or by running the task again in a new run.

## Restore and overlay

`checks.restore` and `checks.overlay` decide which files a check sees. Both are optional and independent. After the solution patch is captured, tevu resets every path `restore` matches to the base tree, then copies `overlay` onto the worktree root.

### `checks.restore`

A list of git pathspecs with `:(glob)` magic. Each pattern must be non-empty, must not start with `/`, and must not contain a `..` segment.

- `*`, `?`, and `[...]` do not match `/`.
- `**/` matches zero or more leading directories, and `/**` matches everything inside a directory.
- A pattern without wildcard characters also matches everything beneath a directory of that name.
- `restore: []` and an absent key both restore nothing.

Restore returns every matched path in the base tree to its checkout state. It removes every matched path that is untracked relative to the base tree, ignored files included. Consequences:

- A pattern such as `**/*.test.ts` also reaches test files ignored under `node_modules`. A pattern starting with `**/` makes git traverse every directory. Name the directories a pattern means.
- A file inside an untracked nested repository (a directory holding `.git`) survives unless a pattern matches the repository directory itself. `tests/**` matches `tests/repo`; `**/conftest.py` does not.
- A pattern that matches nothing restores nothing.
- A check command's own configuration, such as the `package.json` scripts behind `npm test`, stays editable by the agent unless a pattern names it.
- A test whose expected result a correct fix changes belongs in the overlay. Restoring it brings back the base expectation, which every correct fix fails.

### `checks.overlay`

A path, relative to the configuration file, to a directory of hidden check files.

- The directory holds regular files and directories only: no symbolic link and no entry named `.git`.
- It must resolve outside every configured repository, must not contain one, and must not overlap `run.output_dir`.
- tevu reads it once per run before the run starts. Edits during a run reach no case of that run.
- Overlay files overwrite existing worktree files. A symbolic link at a destination is replaced, never written through. A blocking entry is removed and recorded.

`tevu validate` and `tevu run` reject a missing or non-directory overlay, an invalid overlay, an empty or escaping restore pattern, an overlay inside a repository, and an overlay overlapping `run.output_dir`. A restore or overlay step that fails at run time ends the case with lifecycle `infrastructure-failed` and failure kind `CheckStateError`. See [Artifacts](artifacts.md#check-state) for the recorded evidence and [Isolation](../concepts/isolation.md#hidden-checks) for why hidden checks are not a sandbox boundary.
