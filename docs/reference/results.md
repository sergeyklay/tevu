# Results reference

How a run's cases are identified and named, the outcome values, how the report words every failure and gap, and the metrics tevu records. The files that hold them are described in [Artifacts](artifacts.md).

## Cases

A run holds n cases for each task and model entry pair, where n is the effective repeat: `run.repeat`, or `--repeat` for that run. A case ID is `<task-id>--<model-id>--<attempt>`. Attempts are numbered from 1 even when n is 1. The report compares cases per task, opening with a [comparison table](#comparison-table) for each task, and summarizes each pair's attempts. It names no overall winner and calculates no combined score.

A case's effort is the configured string, whether or not the model has a variant of that name. When the effort is `unverified` or `unsupported`, the case may have run the model with its default options, and `report.md` marks the effort of every model entry, the grader, and each case with its status. See [Effort check](agents-and-models.md#effort-check).

### Names

`report.md`, the `tevu run` summary, and `tevu assess` name tasks, model settings, attempts, and checks in plain words. A reader needs no configuration file to follow them.

| Name | Rule | Example |
| --- | --- | --- |
| Task name | The task `title`, each run of whitespace collapsed to one space | `Fix the login redirect` |
| Setting name | `<display model>, <effort>` of the model entry, with the effort as configured | `model-a, high` |
| Attempt name | The setting name. When the effective repeat is above 1, `, attempt <n>` follows | `model-a, high, attempt 2` |
| Case name | `<attempt name> on "<task name>"` | `model-a, high on "Fix the login redirect"` |
| Check name | The check `description`, collapsed like a title. When nothing is left, `Acceptance check <n>` or `Definition of Done check <n>`, n being its position in that list | `Definition of Done check 2` |

The display model is the `model` of the entry without its provider prefix: the text after the last `/`. An entry keeps its full `model` when that text is empty, or when another entry of the run has a different `model` with the same text, so two settings never read as one model.

| `model` of the run's entries | Display models |
| --- | --- |
| `litellm/openai/model-a`, `anthropic/model-b` | `model-a`, `model-b` |
| `openai/model-a` at effort `low`, `openai/model-a` at effort `high` | `model-a`, `model-a` |
| `openai/model-a`, `azure/model-a` | `openai/model-a`, `azure/model-a` |
| `litellm/openai/model-a`, `openai/model-a` | `litellm/openai/model-a`, `openai/model-a` |

The full `model` stays in the `Model:` line of a case section, in the grader lines, in `tevu run --dry-run`, and in `run.json` and `result.json`.

Names that would be identical are told apart:

- Tasks that share a task name, and checks of one task that share a check name, each get ` (<k>)` appended, k being the position among them in configuration order.
- Model entries that share both a model and an effort each get `, <agent>` after the effort, for example `model-a, high, opencode`. Entries that still share a setting name, because they also share an agent, each get ` (<k>)` appended after that, k being the position among them in configuration order.
- The Model column of the comparison table carries the same addition after the display model: `model-a, opencode`.
- An attempt name and a case name carry the setting name with its addition.

A configuration ID or case ID appears in the report only in an inline code span, after `Technical detail:`, in a link destination or an HTML anchor, or inside text you wrote or a model wrote, such as a task title or description, a check description, a model or effort string, a grade rationale, an assessor, or a note. tevu never strips IDs from that text.

### Case sections

Each case that has a saved result has a section in `report.md`, preceded by an HTML anchor line that the Attempt links of the task section's case table point to and headed by its attempt name. The section holds, in order:

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

`report.md` opens with one comparison block per task, directly under the title and ahead of the run parameters and every task section. The blocks follow the task ID order of the task sections. Each block has a `## Comparison: <task name>` heading, with the task's plain name from [Names](#names), a table, an optional [note about outcomes that do not separate the settings](#outcomes-that-do-not-separate-the-settings), an optional grader line, an optional summary-model line, and an optional list of numbered footnotes. The task sections, pair summaries, case tables, and case sections follow unchanged, as the detail to open when a row raises a question.

The table has one row per model entry, in the order of the `models` list in the configuration. The order is not a ranking: no row is sorted by an outcome, check, or metric, and tevu computes no composite score and names no overall winner.

| Column | Contents |
| --- | --- |
| Model | The display model of the entry, with the addition of [Names](#names) when entries share a model and an effort, as plain text |
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

An attempt with no case result, such as one still queued when the run was cancelled, has no values. Every cell that would hold one carries the no-result footnote, and the pair counts the attempt as `not-evaluated`.

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

When the task's saved conclusions record a [summary call](#the-summary-model), one more line follows the table, the note, and the grader line, and precedes the footnotes: `Summary model for this task, not added to any row: <model> (effort <effort>, agent <agent>), <status>, input <v>, cache read <v>, cache write <v>, output <v>, reasoning <v>, cost <v>.` The effort is printed as configured, without a check status. The status reads `its sentences are in the summary` when tevu accepted the model's sentences, and otherwise `its sentences are not in the summary` followed by a footnote marker. That footnote reads `Summary model: <statement>`, and the statement follows the three parts of [Messages](#messages): the summary states each conclusion in a template sentence built from the facts of the run; either tevu rejected the model's sentences because they did not match the facts, with the reason of the first rule they broke as technical detail, or the model returned no sentences, with the cause as technical detail and a next step to fix it before the next run. Each value uses the formats of the grader line, and an unavailable value is `-` with a footnote marker, as there. The markers of this line number after those of the grader line, the status first, then the values from left to right. These values never enter a row, a grader total, the terminal summary, or `summary.md`.

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

The note is informational. Tevu still computes no composite score and names no overall winner, and the note ranks no setting. `tevu assess` and `tevu report` rebuild the note from the saved case results and the current assessments, so recording a verdict adds, keeps, or removes it, and unchanged artifacts give the same text.

## Run summary

`tevu run` ends by writing `summary.md` next to `report.md`: a file short enough to read on one screen, for a reader who has never seen the configuration. `report.md` stays the detailed evidence, and `summary.md` holds one link, to `report.md`.

The file has one block per task, in task ID order, and the details line once after the last block:

```markdown
# Model comparison summary

## <task name>

<context line>

| Model | Effort | Outcome | Required checks | Elapsed | Cost |
|---|---|---|---|---|---|
| <model> | <effort> | <outcome> | <required checks> | <elapsed> | <cost> |

- **Correctness:** <conclusion>
- **Cost:** <conclusion>
- **Speed:** <conclusion>
- <one sentence per setting that dropped out>

Details of every attempt, check, and measurement: [report.md](report.md)
```

- The context line reads `Compared <n> model settings on this task in <repository>, with <r> attempts each, on <date> at <hh:mm> UTC.` The repository is `<owner>/<repo>` for a GitHub entry, or the last segment of the path of a local one, and is left out when the run's saved configuration has no record of it. The time is the run's start time. With more than one attempt, `Times and costs are medians of the attempts that measured them.` follows.
- The table has every column of the [comparison table](#comparison-table), with the same row order, [names](#names), cells, and outcome words, but without footnote markers. A value that no attempt reported reads `unknown`, and a value that only k of the n attempts reported keeps its `(k/n)` count.
- Every name and sentence is escaped, so the details line holds the file's only link. The file has no anchor, footnote marker, case ID, file path, or error kind.

### Facts

The conclusions state facts that tevu derives from the saved outcomes and measurements by fixed rules. Each aspect is judged on its own, and no rule weighs one aspect against another.

- A setting did the task when every planned attempt of it passed.
- An attempt dropped out when it timed out (lifecycle `timed-out`), failed to run (no case result, or lifecycle `process-failed`, `infrastructure-failed`, or `cancelled`), or is waiting (outcome `pending`). The sentence for a failed-to-run attempt names its [runtime failure label](#runtime-failure-labels), `no result was saved` when the attempt has none, `cancelled` for a cancellation without a failure, and `tevu error` otherwise.
- The cost and time of a setting are the lower median of the attempts that reported them, as in the [comparison table](#comparison-table). A value is unknown when no attempt reported it.
- Cheapest and fastest are chosen only among the settings that did the task, and a leader needs a known value for at least two of them. Values are compared as displayed, so two settings that show the same text tie. Without two known values, the summary says which settings have an unknown value and names no leader. When no setting did the task, it says so.
- The margin states how much lower the leader's value is than the next one. A ratio of 2 or more reads `about <r> times less` for cost and `about <r> times faster` for time. A smaller one reads as a percentage, `<p>% less` or `<p>% less time`, and is left out when it rounds below 1%. A margin against a leader whose value is exactly zero is left out.
- A leader or tie whose comparison has a setting with an unknown value, or a value that only some attempts reported, adds a sentence that says the comparison is incomplete and names those settings.

A cost of `$0.0000` can be a free model or a model the agent has no price for, so when a setting that did the task shows it, the Cost line adds `A cost of $0.0000 can also mean the agent had no price for the model.`

### Template sentences

Each conclusion is a sentence built from the facts. These are the sentences `summary.md` holds when no model reworded them.

| Aspect | Sentence |
| --- | --- |
| Correctness, every setting did the task | `Every model setting did the task: each passed all <n> required checks.` With [outcomes that do not separate the settings](#outcomes-that-do-not-separate-the-settings), the second sentence of that note follows |
| Correctness, some did | `<d> of <s> model settings did the task, passing all <n> required checks: <settings>.` Then `The other did not: <entries>.` or `The others did not: <entries>.`, with one entry per setting as `<setting> passed <p> of <t> required checks` (or `<setting> passed <a> of <k> attempts and <p> of <t> required checks` for more than one attempt) |
| Correctness, none did | `No model setting did the task: <entries>.` With every attempt failed and no pending verdict, the second sentence of the separation note follows |
| Cost, one leader | `<setting> was cheapest: <value> against <next value><margin>.` |
| Speed, one leader | `<setting> was fastest: <value> against <next value><margin>.` |
| Cost or speed, tie | `The lowest cost was a tie at <value> each, against <next value> for the next setting<margin>: <settings>.` For speed, `The shortest time was a tie ...` |
| Cost or speed, one setting did the task | `<setting> was the only model setting that did the task; its cost was <value>.` For speed, `it took <value>` |
| Cost or speed, no leader | `No model setting did the task, so no cheapest setting is named.`, or `The cheapest model setting cannot be named: the cost is unknown for <settings>.` The speed sentences say `fastest` and `time` |

When some settings did not do the task, a cost or speed sentence opens with `Among the settings that did the task,`. A dropout sentence reads `<setting> dropped out: <phrase>.` for one attempt, with the phrase `it did not finish within its time limit`, `it failed to run (<label>)`, or `it had required checks still waiting for a verdict when the run ended`. With more attempts it reads `<setting> dropped out of <d> of <n> attempts: <parts>.`, one part per class in that order, such as `1 did not finish within the time limit; 1 failed to run (agent process failed)`.

### The summary model

When the configuration declares [`roles.summary`](agents-and-models.md#model-roles), `tevu run` asks that model once per task, after every case is final, to reword the three conclusions. Nothing is printed while a call runs, and `run.timeout` bounds each call's model session. The [tool denial check](agents-and-models.md#tool-denial-check) before the session has its own 120 second limit that does not count against `run.timeout`. A call is never retried, and no later command makes one.

The prompt carries these parts, in this order: instructions, the exact setting names, the facts of the task as JSON without the repository and the date and without each setting's model and effort, the template sentences, the grader's saved rationales for the task as data, and the reply shape. It never carries the task prompt or description, a check ID, a case ID, a run ID, a repository, a path, a date, or the configuration. The model replies with one JSON object: for each aspect, the settings it treats as leaders and its text.

tevu accepts the reply only when it is valid and every aspect passes these rules, checked per aspect in the order correctness, cost, speed:

1. The reply is a JSON object with exactly the three aspects, each with a list of distinct leaders and a text.
2. The text is one paragraph that ends in `.`, `!`, or `?`.
3. The text has one or two sentences.
4. The text holds no Markdown, link, address, code, slash, or `@`. Names of settings and of the task, which the check sets aside first, may hold any of them.
5. The text holds no case ID, and no configuration ID as a whole word, except an ID that is itself a whole word of a task, setting, or check name.
6. The text holds no internal error name such as `ModelCallError`.
7. Every number in the text is one the facts or the template sentences write, and no number is spelled out, as `two`, `half`, or `percent`.
8. The text names no model except inside an exact setting name.
9. The leaders it declares are exactly the leaders the facts name: for correctness, the settings that did the task; for cost and speed, the leaders of the comparison.
10. The text names its leaders as the facts do: with no leader, it holds the first template sentence of the aspect; when every setting leads, it names none or all of them; otherwise it names every leader and a leader first.

A reply that breaks one rule is rejected as a whole. The saved conclusions are then the template sentences of all three aspects, and `conclusions.json` keeps the reply and the reason. The same happens without `roles.summary`, when the call fails, and when the prompt cannot be redacted, in which case tevu makes no call. A cancellation during the calls skips every remaining call: those tasks save template sentences with no call, and the command finishes its writes and keeps the exit code it would have returned without the cancellation. Apart from the warning `tevu run` prints for a call whose temporary directory it could not delete (see [Run](cli.md#run)), a failed or rejected call prints nothing and changes no exit code; the `Summary model` footnote of `report.md` says what happened.

The call's usage and cost are saved in `conclusions.json` and shown only in the summary-model line of `report.md`. They never enter a row, a grader total, or `summary.md`.

### Saving and regenerating

`tevu run` saves the facts and the three conclusions of every task, with the summary call when there was one, in `conclusions.json` once, before it writes `report.md` and `summary.md`, and writes `summary.md` from them. The summary is final: `tevu assess` neither writes `conclusions.json` nor changes `summary.md`, so a verdict recorded later shows in `report.md` and not in the summary. `tevu report` renders `summary.md` from the saved entries, offline and without a model call, and unchanged artifacts give the same bytes. A task with no saved entry, such as one of a run cancelled during its cases, renders the facts derived from the saved artifacts with the template sentences. A malformed `conclusions.json` is refused; deleting it makes `tevu report` use template sentences.

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
- A summary call's usage and cost are saved per task in `conclusions.json` and shown in the [summary-model line](#comparison-table) of `report.md`. They never enter a row, a grader total, the terminal summary, or `summary.md`.
