# Task wizard reference

The interactive interview behind `tevu task add`: its questions, defaults, retry rules, and keys. The command needs a terminal for input and output.

## Modes

- **Existing configuration.** The wizard asks the task questions and appends the task, and a repository if one was added, to the target file.
- **Missing target.** When the target file does not exist and its directory does, the wizard first asks the configuration questions, then the task questions, and writes a new file.
- `--jira` requires `trackers.jira` in an existing configuration. `--github` needs `gh`; see [Trackers](trackers.md).

See the [CLI reference](cli.md#configuration-file-search) for how the target file is chosen.

## Configuration questions

Asked in this order for a new configuration. Defaults are shown dim, and an empty Enter accepts them.

| Question | Default | Notes |
| --- | --- | --- |
| Output directory | `runs` | Checked against the repository answers once both are given |
| Concurrent cases | `2` | Integer from 1 through 32 |
| Agent time limit | `10m` | Written as `run.timeout` |
| Stop grace period | `3s` | |
| Check time limit | `5m` | Always written as `run.check_timeout` |
| Agent command | `opencode` | Probed as soon as it is entered |
| Secret variable names | none | Names separated by commas, spaces, or both |
| Non-secret variable names | none | Same format |
| Import issues from Jira? | No | If Yes: Jira site URL, Jira email variable, Jira token variable |
| Repository ID, Repository source, Local path or GitHub repository | none | Repeats while Add another repository? is Yes (default No). Source is Local path or GitHub, cloned by tevu |
| Model entry ID, Model, Reasoning effort | none | At least two entries. Reasoning effort has no default. Add another model? (default No) is asked from the third entry on |
| Grade checks with a model? | Yes | If Yes: Grader model, Grader effort (default `medium`) |
| Draft criteria with a model? | Yes | If Yes: Criteria model, Criteria effort (default `high`) |

### Variable questions

Every question that takes variable names refuses a name that is not set in the terminal and asks again. That covers the agent's variables, the API key variable, the Jira credential variables, and a command check's variables. Enter names, never values.

### Model checks

Each model, including the grader and criteria models, is checked by listing the models the agent resolves in an environment built like a case agent's (see [Model resolution](agents-and-models.md#model-resolution)). A command or model that fails its check is reported, and Enter tries again with the answer filled in.

- When your OpenCode global configuration defines the model's provider, the wizard copies it into `agents.opencode.providers` and declares the variables it references as secrets, without asking when the definition names its key variable.
- It asks `API key variable for <provider>` when the definition names no key variable, holds a literal key, or the provider is a built-in one OpenCode did not list. The question follows `Model` and precedes `Reasoning effort`. An empty answer is accepted.
- A model of a built-in provider that does not list while a declared variable is unset in the terminal is kept as entered, with a warning.

## Task questions

Asked in this order:

| Question | Notes |
| --- | --- |
| Task source | Write it yourself, Jira issue (disabled without Jira), or GitHub issue. An issue source then asks for the key or reference |
| Repository | A choice of configured repositories plus Add a repository. Shown even with one repository |
| Reference PR or commit | Optional. `OWNER/REPO#NUMBER`, a pull request URL, or a commit. Text containing `://` or in the short form is a pull request, anything else names a commit |
| Base commit | Prefilled with the commit proposed from the reference; see [Tasks](tasks.md#proposed-base-commit). Required text when no base is proposed |
| Task ID, Title, Description, Prompt for the models | Title is prefilled for an imported issue |
| Confirmed prerequisite | At least one. Add another prerequisite? (default No) |
| Acceptance and Definition of Done checks | See [Checks](#checks) |
| Review, then `Save to <path>?` | Default Yes |

The wizard inspects the base commit as soon as it is entered, before any criteria draft. A commit it cannot use, such as one whose tree holds submodules or lacks Git LFS objects it needs, is reported, and the question opens again with the answer filled in.

For a GitHub repository entry, the wizard reads the repository with your `gh` login as soon as it is entered, clones it, and fetches each reference and base-commit answer as it is typed, printing progress before each clone or fetch. A base-commit answer also fetches the Git LFS objects its tree lacks.

### Reference solution

A resolved commit proposes its first parent as the base. A resolved pull request proposes a base by its state and mergeability, and prints a warning when the proposal is not the default one. When the pull request's own commits share no single parent, no base is proposed. For `closed` and mergeability-unknown pull requests, the warning names the hash of the parent of the pull request's first commit as the alternative base.

A failed resolution is reported and the question is asked again with the answer filled in. Clearing the answer skips the reference.

### Checks

Without a criteria draft, each check asks:

| Question | Notes |
| --- | --- |
| Check ID, Check type | Graded by a model (default), Command, or Manual |
| Criterion or Description | Criterion for a graded check. Description is optional for command and manual checks |
| Required? | Default Yes |
| Command, Time limit, Passing exit codes, Check variables | Command checks only. `Time limit` is optional and inherits `run.check_timeout`. Exit codes default to `0`. A command is saved as typed and runs through `/bin/sh -c` |

After each check the wizard asks `Add another acceptance check?` or `Add another Definition of Done check?` (default No). After a criteria draft, the acceptance question comes first, and the Definition of Done question is asked only when the accepted Definition of Done list is non-empty. When it is empty the wizard asks for a check directly, since at least one required Definition of Done check is needed.

A graded check with no `roles.grader` declared draws a warning in the review. `tevu validate` and `tevu run` refuse the task until the role is declared.

### Criteria draft

With `roles.criteria` declared and a reference solution resolved, the wizard drafts acceptance criteria and a Definition of Done instead of asking for them. It sends the model the task's prompt and description and the reference solution's changes, and nothing else. The draft appears as `Drafted criteria` and a `What next?` menu:

| Choice | Effect |
| --- | --- |
| Accept | Saves the items as graded checks. Blocked while the acceptance list is empty or an item names the reference commit or pull request |
| Edit an item, Remove an item, Add an item | Prompts `Item to edit`, `Item to remove`, or `Add to`. Edit and Remove are disabled with no items |
| Write my own instead | Falls back to the check questions |

Accepting always needs an explicit choice, even for an unedited draft. The Definition of Done list may be empty. After Accept the wizard asks for more acceptance and Definition of Done checks of any kind, which are stored after the drafted ones.

A failed draft names its cause. For unreadable changes, a timeout, a failed OpenCode call, or an unusable reply, the wizard asks `Draft the criteria again?` with Yes selected, and each retry starts another model session. Any other cause, and a prompt that cannot be redacted, falls back to writing the criteria by hand without the question. The draft call incurs the provider's usual charges and runs until it finishes or reaches `run.timeout`.

## Failures and retries

Every failure of a step the operator can fix is reported with its cause and asks the same question again with the answer filled in. Enter retries and every earlier answer is kept. This covers:

- a failed issue import (clearing the answer writes the task by hand);
- a repository that cannot be read, cloned, or placed;
- a reference that cannot be resolved;
- a base commit that cannot be fetched or used;
- a failed write, after which `Save to <path>?` is asked again.

## Keys and exit

| Situation | Behavior |
| --- | --- |
| At a prompt, the same key pressed twice within 800 ms: Ctrl-C or Escape | Cancels, writes nothing, exits `130`. A different key in between starts a new window |
| Status line under every prompt | `Esc or Ctrl-C twice to exit`. The first press replaces it with `Press Esc again to exit` or `Press Ctrl-C again to exit` and keeps the prompt and its answer |
| `Add to`, `Item to edit`, `Item to remove` prompts | One Escape returns to the review. Ctrl-C twice still cancels. The status line reads `Esc to go back · Ctrl-C twice to exit` |
| `No` at `Save to <path>?` | Opens `Exit without saving?`, which names what is lost: every answer so far, the criteria draft once one exists, and whether the target file stays unchanged or is not created. `No` is the default and asks `Save to <path>?` again. `Yes`, or Ctrl-C twice, exits `130` |
| Ctrl-C while a step is running | The step keeps running and a warning names what a second Ctrl-C loses. A second Ctrl-C exits `130` at once. Otherwise `Exit without saving?` opens when the step ends, and `No` continues |
| Ctrl-C during `Saving task` | A second Ctrl-C stops the save only before the write. A task already written stays saved, the command prints `Task <id> added to <path>`, exits `0`, and opens no exit question |

A save ends with `Task <id> added to <path>`.
