# Results reference

How a run's cases are identified, the outcome values, and the metrics tevu records. The files that hold them are described in [Artifacts](artifacts.md).

## Cases

A run holds n cases for each task and model entry pair, where n is the effective repeat: `run.repeat`, or `--repeat` for that run. A case ID is `<task-id>--<model-id>--<attempt>`. Attempts are numbered from 1 even when n is 1. The report compares cases per task and summarizes each pair's attempts. It selects no winner and calculates no combined score.

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
- The grader's usage and cost are saved per case in `grading.json` and rendered as `Grader metrics` in the report. They are never added to the case's own metrics.
