# Results reference

How a run's cases are identified and named, the outcome values, how the report words every failure and gap, and the metrics tevu records. The files that hold them are described in [Artifacts](artifacts.md).

## Cases

A run holds n cases for each task and model entry pair, where n is the effective repeat: `run.repeat`, or `--repeat` for that run. A case ID is `<task-id>--<model-id>--<attempt>`. Attempts are numbered from 1 even when n is 1. The report compares cases per task, opening with a [comparison table](#comparison-table) for each task, and summarizes each pair's attempts. It selects no winner and calculates no combined score.

A case's effort is the configured string, whether or not the model has a variant of that name. When the effort is `unverified` or `unsupported`, the case may have run the model with its default options, and `report.md` marks the effort of every model entry, the grader, and each case with its status. See [Effort check](agents-and-models.md#effort-check).

### Names

`report.md`, the `tevu run` summary, and `tevu assess` name tasks, model settings, attempts, and checks in plain words. A reader needs no configuration file to follow them.

| Name | Rule | Example |
| --- | --- | --- |
| Task name | The task `title`, each run of whitespace collapsed to one space | `Fix the login redirect` |
| Setting name | `<model>, <effort>` of the model entry, both as configured | `openai/model-a, high` |
| Attempt name | The setting name. When the effective repeat is above 1, `, attempt <n>` follows | `openai/model-a, high, attempt 2` |
| Case name | `<attempt name> on "<task name>"` | `openai/model-a, high on "Fix the login redirect"` |
| Check name | The check `description`, collapsed like a title. When nothing is left, `Acceptance check <n>` or `Definition of Done check <n>`, n being its position in that list | `Definition of Done check 2` |

Names that would be identical are told apart:

- Tasks that share a task name, and checks of one task that share a check name, each get ` (<k>)` appended, k being the position among them in configuration order.
- Model entries that share both a model and an effort each get `, <agent>` after the effort, for example `openai/model-a, high, opencode`. Entries that still share a setting name, because they also share an agent, each get ` (<k>)` appended after that, k being the position among them in configuration order.
- The Model column of the comparison table carries the same addition after the model: `openai/model-a, opencode`.
- An attempt name and a case name carry the setting name with its addition.

A configuration ID or case ID appears in the report only in an inline code span, after `Technical detail:`, in a link destination or an HTML anchor, or inside text you wrote or a model wrote, such as a task title or description, a check description, a model or effort string, a grade rationale, an assessor, or a note. tevu never strips IDs from that text.

### Case sections

Each case that has a saved result has a section in `report.md`, preceded by an HTML anchor line that the Model and Attempt links point to and headed by its attempt name. The section holds, in order:

- the outcome with its required checks, the model with its effort, and how the agent process ended;
- one paragraph per statement that explains the attempt, as described in [Messages](#messages), and, when the attempt completed, has manual or graded checks, and none of them waits for a verdict, the `tevu assess <run-id> <case-id>` command to record or replace verdicts;
- a table of every check with its verdict, name, category (`acceptance` or `Definition of Done`), whether it is `required` or `optional`, its evaluator (`command`, `manual`, or `grader`), duration, and a link to the check evidence;
- the metrics tevu measured, then one `Not measured` line per reason for the metrics it could not measure;
- for a graded case, the grades by the grading model, one line per check, and the grading model's own metrics, apart from the attempt's. The grading's heading reads `Grades by <model> (effort <effort>, agent <agent>)`, followed by `, after <n> calls` when the grading took more than one call. The metrics appear also when the grading returned no reply, summed over its calls;
- links to the case's artifacts, including the setup logs when a setup command ran, and the current assessments.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `passed` | Every required check passed |
| `failed` | A required check failed |
| `pending` | Required checks still need a manual verdict, or a required graded check is awaiting the grader, was left pending by a failed or unparseable grader call, or was graded `undetermined` |
| `not-evaluated` | A timeout, cancellation, preparation failure, repository setup failure, or another failure prevented eligible evaluation |

- Optional failed or pending checks stay visible without changing an otherwise passed outcome.
- A command check passes only when it finishes before its timeout with a declared success exit code.
- Process status and task outcome are separate. Checks can run after a nonzero agent exit while the workspace is still readable. The solution may pass, but the runtime failure stays in the report and makes `run` return `2`. An agent that exits `0` after reporting an error for its root session also has a runtime failure, recorded as `AgentSessionError`. Checks still run while the workspace is readable, the outcome comes from them, and `run` returns `2`. See [CLI exit codes](cli.md#exit-codes).
- A timeout or cancellation terminates the managed process group, escalating to a forced kill after `run.stop_grace`. A timed-out case skips acceptance checks and `setup.before_checks`.
- Successful finalization removes the case workspace. A cleanup failure records a warning with the retained path.

## Pair summary

The report attaches one summary to every task and model entry pair. The fields below are those of `result.json`; the task section of `report.md` names each row by its setting name.

| Field | Contents |
| --- | --- |
| `taskId`, `modelId` | The pair |
| `planned` | n, the effective repeat |
| `outcomes` | Count of attempts by outcome: `passed`, `failed`, `pending`, `not-evaluated` |
| `passedOfPlanned` | `<passed>/<planned>`, for example `1/3` |
| `allPassed` | Whether every attempt passed |

An attempt with no case result, such as one still queued when the run was cancelled, counts as `not-evaluated`, so the four counts always sum to `planned`. No percentage is computed. Each task section of `report.md` renders its pairs' summaries as a table, one row per model setting, headed `Model setting`.

## Comparison table

`report.md` opens with one comparison block per task, directly under the title and ahead of the run parameters and every task section. The blocks follow the task ID order of the task sections. Each block has a `## Comparison: <task name>` heading, with the task's plain name from [Names](#names), a table, an optional [note about outcomes that do not separate the settings](#outcomes-that-do-not-separate-the-settings), an optional grader line, and an optional list of numbered footnotes. The task sections, pair summaries, case tables, and case sections follow unchanged, as the detail to open when a row raises a question.

The table has one row per model entry, in the order of the `models` list in the configuration. The order is not a ranking: no row is sorted by an outcome, check, or metric, and tevu computes no composite score and names no winner.

| Column | Contents |
| --- | --- |
| Model | The model of the entry, with the addition of [Names](#names) when entries share a model and an effort, linked to the case section of its first attempt that has a case result |
| Effort | The configured effort with its status, as in the case table, for example `high, unverified` |
| Outcome | The pair's outcome, or the count of attempts per outcome when n is above 1, followed by footnote markers for an attempt that did not finish its checks or whose checks wait for a verdict |
| Required checks | Passed required checks over required checks, counted across all attempts, with failed, pending, and not-run checks counted apart, for example `1/6 passed, 5 pending` |
| Elapsed | Agent-process execution time of the case |
| Cost | Agent-reported cost in USD |
| Turns, Tool calls | Activity counts |
| Input, Cache read, Cache write, Output, Reasoning | Token counts |
| API errors | Errors the model API returned |
| Runtime failure | The [label](#runtime-failure-labels) of the runtime failure, or `none`, followed by footnote markers |

Values use fixed formats, so the same artifacts always render the same text.

| Value | Format | Examples |
| --- | --- | --- |
| Count | Whole number with `,` between groups of three digits. A value that is not a non-negative whole number appears as saved | `0`, `1,234,567`, `1234.5` |
| Cost | `$` and four decimal places. A measured cost below $0.00005, zero included, reads `$0.0000` | `$0.0125`, `$0.0000` |
| Elapsed | Seconds with one decimal place below 60 seconds, minutes with one decimal place from there | `0.9 s`, `1.0 min`, `8.7 min` |

An unavailable value appears as `-` followed by a footnote marker such as `[1]`, and the numbered footnote under the table explains it in the three parts of [Messages](#messages). A measured zero appears as `0`, or `$0.0000` for cost, and is never confused with an unavailable value.

Each footnote names one attempt: it reads `<attempt name>: <statement>`. Footnotes are numbered from 1 in each block in the order the cells use them, row by row and from left to right, then the grader line. Within one cell, statements follow the order of the attempts. Footnotes with the same text share one number. A cell lists its distinct markers in ascending order, one space apart, for example `1/3 passed, 2 pending [1] [2]`.

An attempt with no case result, such as one still queued when the run was cancelled, has no values. Every cell that would hold one carries the no-result footnote, and the pair counts the attempt as `not-evaluated`. A row with no case result at all shows its model as plain text, because no case section exists to link to.

With n above 1, a row aggregates the pair's attempts:

- Outcome lists the count of attempts per outcome, for example `2/3 passed, 1/3 failed`, in the order `passed`, `failed`, `pending`, `not-evaluated`.
- Required checks counts every pair of an attempt and a required check of the task in exactly one class, so the classes always sum to the number of required checks times the number of attempts. Optional checks are not counted.

  | Class | Pair |
  | --- | --- |
  | passed | The attempt's result for the check is `passed` |
  | failed | The result is `failed` |
  | pending | The result is `pending`, so the check waits for a verdict |
  | not run | The attempt has no case result, no result for the check, or the verdict `not-run` |

  The phrase is `<passed>/<total> passed`, then `, <n> failed`, `, <n> pending`, and `, <n> not run`, each only when n is above 0. Examples: `1/6 passed, 5 pending`, `4/6 passed, 1 failed, 1 pending`, `0/6 passed, 6 not run`, and `17/18 passed, 1 failed` for three attempts of a task with six required checks.
- A measurement is the lower median of the values from the attempts that reported it: the value at position (k - 1) / 2, rounded down, of the sorted values. The median is always a value one attempt reported, so nothing is averaged or rounded before formatting. When only k of the n attempts reported the value, the cell adds `(k/n)` and the footnote markers of the attempts that lack it, one footnote per attempt. When none reported it, the cell is `-` with the markers.
- Runtime failure counts attempts per label, for example `1/3 agent process failed`, in alphabetical order of the labels, and reads `none` when no attempt had a failure. The markers of the attempts' failure statements follow, and so does the marker of an attempt with no case result.

When a task has gradings, a line under the table totals the grader's usage and cost for the task: `Grading model total for this task, not added to any row: <c> calls` (`1 call` for one), where c counts every grader call of the task's gradings, then `, <m> without a verdict` when m of those calls ended without a reply, then input, cache read, cache write, output, and reasoning tokens, and cost. Each total sums the grading metrics and follows the same unavailable rules as a cell. A grading with a measurement gap contributes its footnote to every total it lacks. A task whose only grading made no call reads `0 calls`. Grader usage never enters a row; rows read only the case's own metrics.

### Outcomes that do not separate the settings

When the outcomes of a task cannot tell its model settings apart, the block says so in one paragraph, so a difference in time or cost is not read as a difference in quality. The note appears when all of these hold:

- The block has two or more rows. A block with one row has nothing to separate.
- Every planned attempt of every row passed, or every planned attempt of every row failed. An attempt with no case result counts as `not-evaluated`, so it prevents the note, and so does any other mix of outcomes, between rows or between the attempts of one row. A block whose attempts all wait (`pending`) or all hold no evaluation (`not-evaluated`) gets no note: the first waits for verdicts, and the footnotes of the second already say to run again.
- No attempt of the task has a pending verdict, whether the check is required or optional. Tevu withholds the note until `tevu assess` records the verdict, even when the verdict can no longer change the outcome.

Optional checks, runtime failures, measurements, and the number of passed required checks take no other part in the decision.

The note sits directly under the table, before the grader line and the footnotes, and is followed by one empty line. It carries no footnote marker and takes no footnote number, so the numbering of the footnotes does not change.

The note follows the three parts of [Messages](#messages) and has no technical detail. The first part has one of two patterns, with the task name and the setting names from [Names](#names). The setting names follow the row order of the table and are joined by `; `. ` in every attempt` appears after the task name only when the effective repeat is above 1.

| Outcome | What happened |
| --- | --- |
| Every attempt passed | `Every model setting passed every required check of "<task name>": <setting names>.` |
| Every attempt failed | `Every model setting failed at least one required check of "<task name>": <setting names>.` |

With the repeat above 1, both patterns continue as `... of "<task name>" in every attempt: <setting names>.`

The second part says that the outcomes cannot tell the settings apart on this task and that a difference in time or cost does not show which setting produces the better solution. When every attempt failed, it adds that the Required checks column still shows how many required checks each setting passed, because those counts can differ between rows that all failed.

The third part names what would tell the settings apart. When every attempt passed, it suggests more attempts with `run.repeat` or `--repeat`, a harder task, or checks that capture more of what a good solution does. When every attempt failed, it suggests more attempts, an easier task, or confirming in the attempt sections that a correct solution can pass the failed checks.

The note is informational. Tevu still computes no composite score and names no winner, and the note ranks no setting. `tevu assess` and `tevu report` rebuild the note from the saved case results and the current assessments, so recording a verdict adds, keeps, or removes it, and unchanged artifacts give the same text.

## Messages

Every failure, footnote, and pending state in `report.md`, in the `tevu run` summary, and in `tevu assess` is stated in three parts: what happened, what it means for the result, and what to do next. Internal text follows as `Technical detail:`: an error kind, a raw reason, a lifecycle, or a case ID. Everything before that marker is plain language.

One module words each state, so the report, the `tevu run` summary, and `tevu assess` describe it identically. A footnote in `report.md` reads `<attempt name>: <statement>`. The `tevu run` summary prints the same statement under the attempt's case name with two leading spaces, and `tevu assess` words the state of a graded check in the same three parts. A statement is one line. Newlines in technical detail become spaces.

### Runtime failure labels

The Runtime failure column and the case table show a label, and the statement explains it.

| Label | Error kind | What to do |
| --- | --- | --- |
| `time limit reached` | `CaseTimeoutError` | Raise the task's `timeout`, or `run.timeout`, and run the comparison again |
| `cancelled` | `CancellationError` | Run the comparison again |
| `agent process failed` | `AgentProcessError` | Read the attempt's diagnostics log |
| `agent reported an error` | `AgentSessionError` | Read the agent's message in the technical detail and the attempt's event log; without a message, read the event log |
| `agent records unreadable` | `AgentProtocolError` | Find the record the technical detail names in the event log or session export |
| `setup command failed` | `SetupError` | Fix the command, using its setup log, and run the comparison again |
| `check files not prepared` | `CheckStateError` | Fix the cause the technical detail names, such as a read-only directory the agent left, and run again |
| `files not saved` | `ArtifactError` | Check free space and permissions of the output directory, then run again |
| `workspace not prepared` | `IsolationError`, `SourceMaterializationError` | Run `tevu validate`, fix what it reports, and run again |
| `tevu error` | Every other kind | Run again; if the error repeats, report it with the technical detail |

What an attempt's failure means for its result depends on how far the attempt got. After a completed lifecycle, the solution was still checked and the outcome comes from its checks. After a failure that stopped the attempt, such as a timeout, a cancellation, or a preparation failure, the attempt did not complete its checks and counts as `not-evaluated`. When tevu could not read the workspace afterwards (`process-failed`), its checks did not run.

### No result

An attempt with no case result, which includes one still queued at a cancellation, has the statement `tevu saved no result for this attempt.` It has no outcome or measurements, counts as `not-evaluated`, and is fixed by running the comparison again.

### Pending checks

An attempt that completed with a check that has no verdict gets a statement that names the cause. When several causes apply, their sentences follow each other in this order:

| Cause | The check |
| --- | --- |
| Manual | Is manual and waits for your verdict |
| No reply | Is graded, and the grading ended without a reply |
| Unusable reply | Is graded, and the reply had no usable verdict for it |
| Undetermined | Is graded, and the grading model could not decide it |
| Not graded | Is graded, and tevu has no grading for the attempt |
| No verdict | Has no definition, or is a command check without a verdict |

The No reply sentence names the cause, and its first words depend on it:

| Cause | The sentence opens with |
| --- | --- |
| The grading model stopped before finishing its reply | `The grading model stopped before finishing its reply` |
| The grading model's session held a tool call | `The grading model asked to use a tool, which grading does not allow` |
| Anything else | `The grading model returned no verdict for this solution` |

When the grading took more than one call, the opening reads `After <n> calls, the grading model ...` instead. The sentence continues `, so <counts> graded <check waits or checks wait> for a person's verdict.`

The statement counts the checks as required and optional, says whether the outcome stays pending, is already failed, or stays passed, and gives the `tevu assess <run-id> <case-id>` command that records the verdicts. When the outcome is already failed, the statement names the failed required checks by their descriptions, for example `Failed: Type checking and the test suite pass.`, and says the verdicts no longer change the outcome but can still be recorded for completeness. The case ID, the grading model's reason, and any unusable-reply reason follow as technical detail.

### Measurement gaps

A metric that tevu has no value for, as an unavailable metric or as a missing value, gets a statement that the value is unknown, not zero, and that the saved files cannot supply it. The reason follows as technical detail. A grading's metric is the sum over its calls and is known only when tevu has the value for every call. A grader-line footnote reads `tevu has no value for this measurement of its grading`, with the reason as technical detail. When the grading returned no reply, the statement in the grading's block names the cause as above, says whether checks still wait for a verdict, and says that the grader total for the task counts a measurement of this grading only when tevu has it for the whole grading.

### Effort statements

An effort with the status `unverified` or `unsupported` gets a statement in the Run section of `report.md`, after the line of the model entry or the grader. `unverified` says that tevu could not confirm the effort, that it was passed as requested, and that the model ran with its default options if the agent does not offer it. `unsupported` says that the agent does not list the effort and that, where no task repository defines it, the model ran with its default options. The check's reason follows as technical detail. See [Effort check](agents-and-models.md#effort-check).

### Run findings

Each line under `## Run findings` reads `<Warning or Error> for <case name>: <message>`, without `for <case name>` when the finding names no planned case. The messages are written in the same three parts. `tevu run` prints the same lines.

## Metrics

| Category | Measurements |
| --- | --- |
| Time | Elapsed agent-process execution time |
| Tokens | Input, output, reasoning, cache-read, and cache-write tokens |
| Activity | Turns, API calls, tool calls, and skill calls |
| Reliability | API errors |
| Cost | Agent-reported cost in USD |

An unavailable measurement is recorded as unavailable with a reason, never as zero. Cost is never estimated from a model name or token count. See [Evidence and reports](../concepts/evidence-and-reports.md).

Derivation:

- Elapsed time comes from process timing for every agent.
- The adapter named by a case's `agent` derives the other metrics from the case's saved records and from `tools.copiedProviders` in `run.json`. For OpenCode, the root session export is the source of every metric except API errors. With the export, API errors is the larger of two counts: the export's assistant records with an `error` field, and the root-session `error` events. The source then reads `root-session export and run events`. When the export is unavailable, events supply only API errors, tool calls, and skill calls, filtered to the root session, and the other metrics are unavailable. API errors is then the root-session `error` events, with the source `run events`.
- tevu reads the output of OpenCode's `export` command, for a case and for every model call that reads an export, through a regular file in tevu's own temporary directory rather than a pipe, so an OpenCode that exits before it flushes its output still delivers the whole export. When tevu cannot prepare that file, the export is unavailable, as when the command cannot start.
- Export records are counted once by identity. An `error` event carries no message identity, so every root-session `error` event counts, identical ones included.
- A turn is an assistant record with a non-empty `finish` field. An API call is an assistant record with a `finish` or `error` field. An API error is an assistant record with an `error` field, or a root-session `error` event. API calls and turns come from the export alone, so API errors can exceed API calls. Tool calls come from tool records, and skill calls from tool records for the `skill` tool.
- Cost is the sum of the `cost` of the root session's assistant records. When the agent block copies at least one provider, a reported zero counts as measured only when the record's provider is not one the agent block copies, when the copied definition defines a price for the record's model (`models.<model>.cost` with numeric `input` and `output`), or when another assistant record of the same provider and model reports a non-zero cost. Otherwise `cost` is unavailable with the reason `the copied definition of provider "<provider>" defines no price for model "<model>"`. A zero-cost record without a usable `providerID`, or without a usable `modelID` for a copied provider, also makes `cost` unavailable, with a reason naming the field. Grader cost follows the same rule. Grader API errors are still counted from the export alone.
- An error recorded in both counts once. When each source records an error the other lacks, the count is the larger of the two rather than their total, so it can be lower than the number of distinct errors.
- A free model of a copied provider reads unavailable until its OpenCode provider definition sets `models.<model>.cost` with `input` `0` and `output` `0`, which makes its zero a measured one. Only the copied definition is evidence: a price set in a task repository's tracked `opencode.json` is not consulted.
- A zero from a provider the agent block does not copy, an OpenCode built-in provider or one defined only in a task repository's tracked `opencode.json`, stays a measured `$0.0000` even when nothing prices the model. A model of a provider defined only in a task repository's tracked `opencode.json` that sets no price still reads as `$0.0000`.
- A malformed export or event file makes every metric except a measured elapsed time unavailable and preserves an `AgentProtocolError`.

Scope:

- Model metrics cover the root session only, not a total across child sessions.
- Elapsed time covers the case's agent process. Acceptance-command results are check verdicts, not model-quality metrics. Repository setup time and output enter no metric.
- The grader's usage and cost are saved per case in `grading.json`, per call and summed over the case's calls, and the sum is rendered as `Grader metrics` in the report. A metric that any call lacks is unavailable for the sum, never a partial total; `grading.json` keeps each call's own values. They are never added to the case's own metrics. Each comparison block totals them for its task on one line, apart from the rows.
