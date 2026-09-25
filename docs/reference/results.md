# Results reference

A run contains one case for each task/model entry pair. Each case is identified as `<task-id>--<model-id>`. The report compares cases per task without selecting a winner or calculating a combined score.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `passed` | Every required check passed |
| `failed` | A required check failed |
| `pending` | Required checks still need a manual verdict |
| `not-evaluated` | Timeout, cancellation, preparation failure, or another failure prevented eligible evaluation |

Optional failed or pending checks remain visible without changing an otherwise passed outcome. Command checks pass only when they finish before their timeout with a declared success exit code.

Process status and task outcome are separate. Checks can run after a nonzero agent exit if the workspace is still readable. The solution may pass, but the runtime failure remains in the report and makes `run` return `2`. See [CLI exit codes](cli.md#exit-codes).

Timeout and cancellation terminate the managed process group, escalating to forced termination after the configured grace period. A timed-out case skips acceptance checks. Successful finalization removes its workspace; a cleanup failure records a warning with the retained path.

## Metrics

| Category | Measurements |
| --- | --- |
| Time | Elapsed agent-process execution time |
| Tokens | Input, output, reasoning, cache-read, and cache-write tokens |
| Activity | Turns, API calls, tool calls, and skill calls |
| Reliability | API errors |
| Cost | Agent-reported cost in USD |

Unavailable measurements are shown as unavailable with a reason, never as zero. Cost is not estimated from a model name or token count.

The adapter named by a case's `agent` derives token, activity, reliability, and cost metrics from that case's saved records; elapsed time comes from process timing for every agent. For the OpenCode adapter, the root session export is the primary source; events provide a fallback when the export is unavailable. Duplicate records are counted once by identity. A turn is an assistant record with a non-empty finish field; an API call is an assistant record with a finish or error field. Tool and skill calls come from tool records.

Model metrics cover the root session only, not a total across child sessions. Elapsed time covers the case's agent process. Acceptance-command results are check verdicts, not additional model-quality metrics.

## Saved files

Files are stored under the configured artifact directory:

```text
<run-id>/
  run.json
  result.json
  report.md
  cases/<task-id>--<model-id>/
    events.jsonl
    stderr.log
    session.json
    solution.patch
    checks.json
    assessment.json
    result.json
```

| File | Contents |
| --- | --- |
| `run.json` | Run identity, configuration snapshot, tool information (`tools.agentVersions`, one detected version per agent in use), per-agent capability reports, case records, and findings |
| Root `result.json` | Normalized report data |
| `report.md` | Human-readable comparison with links to evidence |
| `events.jsonl` | Raw agent event records, one JSON value per line; only that case's agent adapter interprets them |
| `stderr.log` | Process diagnostics, including non-JSON run output |
| `session.json` | Raw root-session export; only that case's agent adapter interprets it |
| `solution.patch` | Submitted solution captured before acceptance commands run |
| `checks.json` | Check verdicts, timing, and evidence |
| `assessment.json` | Current manual verdicts, revision, and replacement history |
| Case `result.json` | Case lifecycle, process result, task outcome, metrics, and evidence paths |

The root `result.json`'s top-level `models` array holds one `{id, model, effort}` entry per configured model entry. Every saved case identity, in `run.json` and both levels of `result.json`, carries `modelId` and `effort` alongside the unchanged `model` string, plus `agent`: the name of the adapter that ran the case.

Isolated replacement environments carry the recipient `agent` or `evaluator`. A process or protocol failure from a case's adapter is recorded with kind `AgentProcessError` or `AgentProtocolError`, each carrying that case's `agent` name.

Some source files are absent when the corresponding evidence was unavailable; assessments appear after the first assessment. Their absence is recorded rather than treated as a successful measurement.

Reports link to patches, transcripts, and complete evaluator output instead of embedding them. Full task prompts and imported issue descriptions are omitted from Markdown reports.

### Data handling

Configured credential-secret values are redacted before persistent or terminal output. Environment metadata records variable names and classifications rather than values. Private task text, repository content, model output, and check evidence remain in the designated local configuration and run files. File access is governed by host permissions. A failed redaction aborts the affected write.

## Regeneration

`tevu report <run-id>` recomputes normalized results and Markdown from saved evidence and current assessments, resolving each case's metrics through the adapter registered under that case's `agent`. It does not start another model session or contact Git or an issue tracker. Unchanged source artifacts produce identical regenerated JSON and Markdown.

`tevu report` and `tevu assess` read the configuration snapshot each run stored under its current layout. A run whose snapshot predates that layout, or whose case results or manifest predate the current agent fields (missing `identity.agent` or `tools.agentVersions`), is refused before either command writes anything.

Replacing an assessment retains the old verdict in history. Only current verdicts affect the outcome. Artifacts remain until the operator deletes the run directory; there is no automatic retention or upload.

The [benchmark guide](../guides/run-benchmark.md#run-and-review) covers recording verdicts and regenerating reports.
