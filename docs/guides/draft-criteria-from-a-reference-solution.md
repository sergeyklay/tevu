# Draft criteria from a reference solution

Record the pull request or commit that solved a task as its reference solution, and let tevu draft acceptance criteria from it.

## Prerequisites

- `roles.criteria` declared in the configuration, or answer Yes at `Draft criteria with a model?` in the setup interview. See [Model roles](../reference/agents-and-models.md#model-roles). Its provider credential must be in `agents.opencode.secrets`.
- `gh` logged in when the reference is a pull request. See [Trackers](../reference/trackers.md#pull-request-and-commit-references).

The draft calls a model and incurs the provider's usual charges.

## Record the reference

At the `Reference PR or commit` question of `tevu task add`, enter a pull request as `OWNER/REPO#NUMBER` or a URL, or a commit hash in the selected repository. Leave the answer empty to add the task without a reference.

The wizard proposes a base commit, which you can accept or override:

- For a commit, the proposal is its first parent. The commit must hold the whole solution. For the last commit of a series, the parent already holds the earlier ones.
- For a pull request, the proposal depends on its state; see [Proposed base commit](../reference/tasks.md#proposed-base-commit). When the wizard warns that the pull request is closed or its mergeability is unknown, the warning names the hash of the parent of its first commit. Enter that hash to start from the commit before the pull request.

If the base commit is missing from the repository, `tevu validate` names the fetch to run. Fetch its branch as well, for example with `git fetch origin`. A commit fetched only by hash sits on no ref, and a later `git gc` can remove it.

## Write the prompt without hints

tevu rejects only the reference's own identifiers in the agent prompt; see [Prompt screening](../reference/tasks.md#prompt-screening). Check your prompt and description for any other hint to the accepted solution, such as a bare `#NUMBER`, the branch name, or the pull request title, and reword it.

## Review the draft

The draft appears as two lists, acceptance criteria and a Definition of Done. Even an unedited draft needs an explicit **Accept**.

- Keep an item that states an outcome any correct solution reaches.
- Edit or remove an item that names how the accepted solution did it, asks for something the task never asked for, or cannot be judged from the patch.
- Add items of your own, or choose **Write my own instead**.

Accepting stays blocked while the acceptance list is empty or an item names the reference commit or pull request. The Definition of Done may be empty; the wizard then asks you for at least one required Definition of Done check. Accepted items are saved as graded checks, and you can add command or manual checks after them. The full menu is in the [wizard reference](../reference/task-wizard.md#criteria-draft).

## When the draft fails

The wizard names the cause. For unreadable changes, a timeout, a failed OpenCode call, or an unusable reply, it asks `Draft the criteria again?`. Each retry starts another model session that the provider charges for. Answer No to write the criteria by hand. Any other cause, such as a model OpenCode cannot find or an unset variable, falls back to writing the criteria by hand.

Cancelling at any point in the review writes nothing.

To understand why drafted criteria can leak the answer, read [Reference solutions](../concepts/reference-solutions.md).
