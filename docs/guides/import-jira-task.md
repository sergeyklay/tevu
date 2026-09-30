# Import a task from Jira Cloud

Add a Jira issue's title and description to a benchmark task. Run the wizard in an interactive terminal with access to the issue and to the task's Git repository.

## Configure the connection

For an existing configuration, add `trackers.jira` with the HTTPS site URL and `$VARIABLE` references for the account email and API token; see [Trackers](../reference/trackers.md#jira-cloud) for the fields:

```yaml
trackers:
  jira:
    url: https://your-site.atlassian.net
    email: $JIRA_EMAIL
    token: $JIRA_API_TOKEN
```

Export both variables in the terminal that launches tevu. The configuration stores only the references. Without a `trackers.jira` block, `tevu task add --jira` exits with an error.

If the configuration does not exist yet, the setup interview asks for the Jira settings when you answer Yes at `Import issues from Jira?`.

## Import the issue

From the directory that holds `tevu.yaml`:

```sh
tevu task add --jira YOUR-123
```

Replace `YOUR-123` with an issue key you can access. The description arrives as plain text and keeps each link's URL: a smart link as its URL, linked text as `text (URL)`; see [Trackers](../reference/trackers.md#jira-cloud) for the full rules. Review the imported title and description, then choose the repository and starting commit, and add the model instructions, prerequisites, and checks. Confirm the final review to save the task.

Cancelling leaves the configuration unchanged. If the import fails, the wizard names the cause and asks for the key again with your answer filled in. Clear the answer to write the task by hand.

## Verify the task

```sh
tevu validate
```

Confirm that it prints `Configuration is valid.` The task's `source` block records the issue key, URL, title, and imported text as a snapshot. Later Jira edits do not change it.

Continue with `tevu run --dry-run`; the [first comparison tutorial](../getting-started/first-comparison.md#5-save-and-check-the-configuration) shows the check and the run.
