# Results reference

A run contains one case for each task/contender pair. Each case is identified as `<task-id>--<contender-id>`. The report compares cases per task without selecting a winner or calculating a combined score.

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

The root session export is the primary source for model metrics; events provide a fallback when the export is unavailable. Duplicate records are counted once by identity. A turn is an assistant record with a non-empty finish field; an API call is an assistant record with a finish or error field. Tool and skill calls come from tool records.

Model metrics cover the root session only, not a total across child sessions. Elapsed time covers the case's agent process. Acceptance-command results are check verdicts, not additional model-quality metrics.

## Saved files

Files are stored under the configured artifact directory:

```text
<run-id>/
  run.json
  result.json
  report.md
  cases/<task-id>--<contender-id>/
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
| `run.json` | Run identity, configuration snapshot, tool information, case records, and findings |
| Root `result.json` | Normalized report data |
| `report.md` | Human-readable comparison with links to evidence |
| `events.jsonl` | Ordered agent events |
| `stderr.log` | Process diagnostics, including non-JSON run output |
| `session.json` | Root-session export |
| `solution.patch` | Submitted solution captured before acceptance commands run |
| `checks.json` | Check verdicts, timing, and evidence |
| `assessment.json` | Current manual verdicts, revision, and replacement history |
| Case `result.json` | Case lifecycle, process result, task outcome, metrics, and evidence paths |

Some source files are absent when the corresponding evidence was unavailable; assessments appear after the first assessment. Their absence is recorded rather than treated as a successful measurement.

Reports link to patches, transcripts, and complete evaluator output instead of embedding them. Full task prompts and imported Jira descriptions are omitted from Markdown reports.

### Data handling

Configured credential-secret values are redacted before persistent or terminal output. Environment metadata records variable names and classifications rather than values. Private task text, repository content, model output, and check evidence remain in the designated local configuration and run files. File access is governed by host permissions. A failed redaction aborts the affected write.

## Regeneration

`tevu report <run-id>` recomputes normalized results and Markdown from saved evidence and current assessments. It does not start another model session or contact Git or Jira. Unchanged source artifacts produce identical regenerated JSON and Markdown.

Replacing an assessment retains the old verdict in history. Only current verdicts affect the outcome. Artifacts remain until the operator deletes the run directory; there is no automatic retention or upload.

The [benchmark guide](../guides/run-benchmark.md#run-and-review) covers recording verdicts and regenerating reports.
