# How to import a task from Jira Cloud

Use this guide to add an issue's title and description to a benchmark task. Run the wizard in an interactive terminal, with access to the issue and its local Git repository.

## Configure the connection

For an existing configuration, add the `jira` settings from the [configuration reference](../reference/configuration.md#jira-cloud): the HTTPS site URL and the names of the account-email and API-token environment variables.

Make those variables available in the terminal that will launch tevu. Store their names, not their values, in the configuration. If the configuration does not exist yet, supply the Jira settings during the wizard's setup interview.

## Import the issue

From the directory that holds your `tevu.yaml`, run:

```sh
tevu task add --jira YOUR-123
```

Replace `YOUR-123` with an issue key you can access. Review the imported title and description, then choose the repository and starting commit. Add the model instructions, prerequisites, acceptance criteria, and completion checks.

Confirm the final review to save the task. Cancelling or an import failure leaves the configuration unchanged.

## Verify the task

```sh
tevu validate
```

Confirm that validation prints `Configuration is valid.` The task's `source` records the issue identity and imported text as a snapshot; later Jira edits do not change it.

Continue with [previewing and running the benchmark](run-benchmark.md#validate-and-preview).
