# Import a task from a GitHub issue

Add a GitHub issue's title and body to a benchmark task with the GitHub CLI.

## Prerequisites

- `gh` on `PATH`, logged in for the issue's host: `gh auth login` for `github.com`, or `gh auth login --hostname <host>` for GitHub Enterprise Server. tevu never passes Enterprise tokens from the environment to gh, so gh's own login must cover the host.
- An existing configuration, or an interactive terminal to create one.

## Import the issue

```sh
tevu task add --github OWNER/REPO#NUMBER
```

You can pass an issue URL instead: `https://HOST/OWNER/REPO/issues/NUMBER`. You cannot combine `--github` with `--jira`.

Review the imported title and description, then choose the repository and starting commit, and add the model instructions, prerequisites, and checks. Confirm the final review to save the task.

The task's `source` block records the issue as a snapshot with `kind: github`. Later edits to the issue do not change it.

If the import fails, the wizard names the cause and asks again with your answer filled in. Clear the answer to write the task by hand.

## Verify the task

```sh
tevu validate
```

The command should print `Configuration is valid.` See [Trackers](../reference/trackers.md#github-issues) for the calls an import makes.
