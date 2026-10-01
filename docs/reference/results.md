# Results reference

How a run's cases are identified, the outcome values, and the metrics tevu records. The files that hold them are described in [Artifacts](artifacts.md).

## Cases

A run holds n cases for each task and model entry pair, where n is the effective repeat: `run.repeat`, or `--repeat` for that run. A case ID is `<task-id>--<model-id>--<attempt>`. Attempts are numbered from 1 even when n is 1. The report compares cases per task, opening with a [comparison table](#comparison-table) for each task, and summarizes each pair's attempts. It selects no winner and calculates no combined score.

A case's effort is the configured string, whether or not the model has a variant of that name. When the effort is `unverified` or `unsupported`, the case may have run the model with its default options, and `report.md` marks the effort of every model entry, the grader, and each case with its status. See [Effort check](agents-and-models.md#effort-check).

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

The report attaches one summary to every task and model entry pair.

| Field | Contents |
| --- | --- |
| `taskId`, `modelId` | The pair |
| `planned` | n, the effective repeat |
| `outcomes` | Count of attempts by outcome: `passed`, `failed`, `pending`, `not-evaluated` |
| `passedOfPlanned` | `<passed>/<planned>`, for example `1/3` |
| `allPassed` | Whether every attempt passed |

An attempt with no case result, such as one still queued when the run was cancelled, counts as `not-evaluated`, so the four counts always sum to `planned`. No percentage is computed. Each task section of `report.md` renders its pairs' summaries as a table, one row per model entry.

## Comparison table

`report.md` opens with one comparison block per task, directly under the title and ahead of the run parameters and every task section. The blocks follow the task ID order of the task sections. Each block has a `## Comparison: <task-id>` heading, a table, an optional grader line, and an optional list of numbered footnotes. The task sections, pair summaries, case tables, and case sections follow unchanged, as the detail to open when a row raises a question.

The table has one row per model entry, in the order of the `models` list in the configuration. The order is not a ranking: no row is sorted by an outcome, check, or metric, and tevu computes no composite score and names no winner.

| Column | Contents |
| --- | --- |
| Model | The model of the entry's first attempt, linked to its first case section when a case result exists |
| Effort | The configured effort with its status, as in the case table, for example `high, unverified` |
| Outcome | The pair's outcome, or the count of attempts per outcome when n is above 1 |
| Checks | Passed required checks over required checks, counted across all attempts |
| Elapsed | Agent-process execution time of the case |
| Cost | Agent-reported cost in USD |
| Turns, Tool calls | Activity counts |
| Input, Cache read, Cache write, Output, Reasoning | Token counts |
| API errors | Errors the model API returned |
| Runtime failure | The error kind of the runtime failure, or `none` |

Values use fixed formats, so the same artifacts always render the same text.

| Value | Format | Examples |
| --- | --- | --- |
| Count | Whole number with `,` between groups of three digits. A value that is not a non-negative whole number appears as saved | `0`, `1,234,567`, `1234.5` |
| Cost | `$` and four decimal places. A measured cost below $0.00005, zero included, reads `$0.0000` | `$0.0125`, `$0.0000` |
| Elapsed | Seconds with one decimal place below 60 seconds, minutes with one decimal place from there | `0.9 s`, `1.0 min`, `8.7 min` |

An unavailable value appears as `-` followed by a footnote marker such as `[1]`, and the numbered footnote under the table gives the reason. A measured zero appears as `0`, or `$0.0000` for cost, and is never confused with an unavailable value. Footnotes are numbered from 1 in each block in the order the cells use them, and cells with the same reason share one footnote.

An attempt with no case result, such as one still queued when the run was cancelled, has no values. Its metrics and runtime failure are unavailable with the reason `no case result was saved`, and the pair counts it as `not-evaluated`. A row with no case result at all shows its model as plain text, because no case section exists to link to.

With n above 1, a row aggregates the pair's attempts:

- Outcome lists the count of attempts per outcome, for example `2/3 passed, 1/3 failed`, in the order `passed`, `failed`, `pending`, `not-evaluated`.
- Checks counts required check verdicts across attempts, for example `17/18` for three attempts of a task with six required checks. Optional checks are not counted.
- A measurement is the lower median of the values from the attempts that reported it: the value at position (k - 1) / 2, rounded down, of the sorted values. The median is always a value one attempt reported, so nothing is averaged or rounded before formatting. When only k of the n attempts reported the value, the cell adds `(k/n)` and a footnote marker, and the footnote names the attempts that lack it and why. When none reported it, the cell is `-` with a marker.
- Runtime failure counts attempts per error kind, for example `1/3 AgentProcessError`, and reads `none` when no attempt had a failure. When some attempts have no case result, the cell ends with a footnote marker for them.

When two rows of one table share a model and an effort, each of those rows shows its model entry ID in parentheses after the model, for example `vendor/model (alpha)`. Without such a twin, a row shows the model alone.

When a task has gradings, a line under the table totals the grader's usage and cost for the task: the number of graded cases, then input, cache read, cache write, output, and reasoning tokens, and cost. Each total sums the grading metrics and follows the same unavailable rules as a cell. Grader usage never enters a row; rows read only the case's own metrics.

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
- A zero from a provider the agent block does not copy, an OpenCode built-in provider or one defined only in a task repository's tracked `opencode.json`, stays a measured `0 USD` even when nothing prices the model. A model of a provider defined only in a task repository's tracked `opencode.json` that sets no price still reads as `0 USD`.
- A malformed export or event file makes every metric except a measured elapsed time unavailable and preserves an `AgentProtocolError`.

Scope:

- Model metrics cover the root session only, not a total across child sessions.
- Elapsed time covers the case's agent process. Acceptance-command results are check verdicts, not model-quality metrics. Repository setup time and output enter no metric.
- The grader's usage and cost are saved per case in `grading.json` and rendered as `Grader metrics` in the report. They are never added to the case's own metrics. Each comparison block totals them for its task on one line, apart from the rows.
