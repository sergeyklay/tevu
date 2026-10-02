# Run your first comparison

Compare two model settings on a task your team already solved. You write no code: tevu drafts acceptance criteria from the accepted pull request, you review them, and a grader model checks each solution against them. You finish with a report.

## Before you start

You need:

- tevu installed; see [Install tevu](installation.md).
- OpenCode installed, with an API key for the provider that serves the models you compare.
- The GitHub CLI (`gh`) installed and logged in with `gh auth login`. tevu uses it to clone the repository and read the pull request.
- A merged pull request you trust as the accepted solution.

Prefer a small, self-contained change, a few files and a few hundred lines. A large feature makes every attempt slower and more expensive, and its criteria harder to review.

The pull request does not need a linked issue. Without one, you describe the task in your own words in the wizard.

## 1. Make the models reachable

Work in one terminal from here on. The variables you export exist only in that terminal, and tevu reads them when it starts.

Create an empty directory for the comparison and change into it. The wizard writes `tevu.yaml` there, as long as no `~/.config/tevu/tevu.yaml` exists. If it does, the wizard uses that file instead.

```sh
mkdir -p ~/tevu-trial && cd ~/tevu-trial
```

Export the API key of your provider under a variable name of your choice. Later you give the wizard the name, never the value.

```sh
export MY_PROVIDER_API_KEY=...
echo ${MY_PROVIDER_API_KEY:+set}
```

The step is done when `echo` prints `set`.

## 2. Describe the comparison and the task

Start the wizard in the same terminal and directory:

```sh
tevu task add
```

The wizard runs in two parts, the configuration first and the task second. Press Enter to keep a default shown in gray.

### The configuration

| Question | What to enter |
| --- | --- |
| Output directory, Concurrent cases | Enter, to keep the defaults |
| Agent time limit | How long one model may work on the task, for example `30m` |
| Stop grace period, Check time limit, Agent command | Enter |
| Secret variable names | Enter for none. The wizard asks for the key when it reaches a model that needs one |
| Non-secret variable names, Import issues from Jira? | Enter |
| Repository ID | A short name, for example `app` |
| Repository source | **GitHub, cloned by tevu** |
| GitHub repository | `OWNER/REPO` |
| Add another repository? | Enter, for No |
| Model entry ID, Model | One setting to compare, for example `low` and `openai/your-model` |
| API key variable for *provider* | The variable name you exported in step 1. Asked only when the model needs a key |
| Reasoning effort | A variant the model offers, for example `low`. `opencode models <provider> --verbose` lists them under `variants` |

The wizard clones the repository as soon as you enter it, which can take a while for a large one. Then it asks for a second model entry, because a comparison needs two. Enter another entry, for example the same model at `high`.

| Question | What to enter |
| --- | --- |
| Grade checks with a model? | Yes, then the model that grades the solutions, and its effort |
| Draft criteria with a model? | Yes, then the model that drafts the criteria, and its effort |

Choose the grading and drafting models from a different model family than the models you compare. tevu does not enforce it, but a model can favor solutions shaped like its own family's.

### The task

| Question | What to enter |
| --- | --- |
| Task source | **Write it yourself**, when the pull request has no linked issue |
| Repository | The repository you added |
| Reference PR or commit | The accepted pull request, as `OWNER/REPO#NUMBER` or its URL |
| Base commit | Enter, to start from the commit the wizard proposes |
| Task ID, Title | A short ID and a title |
| Description, Prompt for the models | The problem, in your own words. Describe what is wrong and what must be true afterward, not how the accepted solution fixed it |
| Confirmed prerequisite | A fact you checked before adding the task, for example that the problem reproduces on the base commit. Answer No at `Add another prerequisite?` |

Keep every hint to the accepted solution out of the description and the prompt: its number, title, branch name, or the technique it used. tevu rejects only the pull request's own identifiers.

The step is done when the wizard shows **Drafted criteria** and asks **What next?**.

## 3. Review the drafted criteria

Every model you compare reads these items as part of its task, so review them before you accept. Keep an item when it states an outcome any correct solution reaches. Remove or edit an item when it:

- names how the accepted solution did it: a technique, a file, a function, or a channel;
- asks for something the task never asked for, such as a side change the accepted pull request also made;
- cannot be judged by reading the solution's changes, such as "the test suite passes" or "verified by hand". The grading model judges from the patch text.

Choose **Accept** when the list holds only outcomes. The Definition of Done may be empty at this point.

## 4. Add the Definition of Done

After **Accept**, the wizard asks `Add another acceptance check?`. Answer No. Then it moves to the Definition of Done. When the draft held no Definition of Done items, it asks for one directly. Otherwise answer Yes at `Add another Definition of Done check?`. Add two kinds of check:

| Check type | Use it for | Example |
| --- | --- | --- |
| **Graded by a model** | Completeness a reader can see in the changes | "The change adds automated tests showing that the fixed behavior holds." |
| **Command** | Something that must run and succeed | The project's own test command, with a time limit such as `10m` |

A command check runs in the case worktree after the agent finishes. The worktree starts from the tracked files only, so the project's dependencies are not installed unless the agent installed them. Start the command with the project's install step, for example `npm ci && npm test`.

## 5. Save and check the configuration

Review the summary and answer Yes at `Save to <path>?`. Then check the configuration without starting any model:

```sh
tevu validate
tevu run --dry-run
```

You should see `Configuration: <path>` first and `Configuration is valid.` after any findings. The dry run lists one planned case per model setting, each with the same commit.

The step is done when both commands finish without errors.

## 6. Run the comparison

This step starts the models and can incur provider charges.

```sh
tevu run
```

In a terminal, each line of progress starts with the case it belongs to. Keep the terminal open until tevu prints `Report: <directory>/report.md`. Before the `Artifacts:`, `Summary:`, and `Report:` lines, tevu prints a summary of every attempt: its name, outcome, and required checks, and an indented explanation of anything that needs your attention.

Exit code `2` means a case timed out, had a runtime failure, or has a failed or pending required check. It is not a crash. See the [exit codes](../reference/cli.md#exit-codes).

## 7. Read the summary and the report

Open the `summary.md` path tevu printed first. It is a short comparison of every task for a reader who has not seen your configuration: a table, one conclusion each for correctness, cost, and speed, and one sentence for every setting that dropped out. It links once, to `report.md`, which holds the detail. Then open `report.md`. The conclusions in `summary.md` are sentences built from the facts of the run. To have a model reword them, add `roles.summary` to the configuration by hand: the interview does not ask for it, and `tevu config example` shows its fields. tevu keeps the model's sentences only when they match the facts, and uses its own otherwise. `report.md` opens with one comparison table per task, headed by the task's title, with one row per model setting in the order of your configuration. Read across a row for the task outcome, the required checks, time, cost, tokens, tool calls, and any runtime failure. Model cells are plain names without the provider prefix, except where two settings would read alike ([Names](../reference/results.md#names)). See [Comparison table](../reference/results.md#comparison-table) for every column.

Required checks reads as `<passed>/<total> passed`, followed by the checks that failed, still wait for a verdict, or did not run, each counted apart. `1/6 passed, 5 pending` means one required check passed and five wait for a verdict, so nothing failed. A pending check is not a failed one.

A `[n]` after a value marks a footnote under the table. Each footnote names the attempt it describes and says what happened, what it means for the result, and what to do next, for example the `tevu assess` command that records a verdict. The raw reason follows after `Technical detail:`. A `-` means tevu could not take the value. Its footnote says the value is unknown, not zero, and the attempt's section lists it under `Not measured`.

A note under a task's table appears when every attempt of every setting passed every required check of that task, or every attempt of every setting failed, and no attempt of that task has a pending verdict. It says the outcomes do not separate the settings: a difference in time or cost does not show which setting produces the better solution. It also names what would tell the settings apart, such as more attempts or a different task. A small, already solved task like this tutorial's can end this way. See [Outcomes that do not separate the settings](../reference/results.md#outcomes-that-do-not-separate-the-settings).

Below the tables, each case has its own section. For each model setting it shows:

- the task outcome and its required checks, and every check with its verdict;
- for each graded check, the grading model's verdict and its rationale;
- time, tool calls, tokens, and cost, with the ones tevu could not measure listed on a `Not measured` line with the reason;
- a runtime failure, if any, kept separate from the task outcome.

tevu computes no score and names no overall winner. Compare the outcomes first, then the time and cost of the settings that passed.

## Next

- Record your own verdict on a check the grader could not decide: [Assess results](../guides/assess-results.md).
- Add tasks from your tracker: [Import a Jira task](../guides/import-jira-task.md) or [Import a GitHub issue](../guides/import-github-issue.md).
- Understand what the comparison guarantees: [How tevu works](../concepts/how-tevu-works.md).
