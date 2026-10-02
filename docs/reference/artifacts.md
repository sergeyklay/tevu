# Artifacts reference

The files a run writes under `run.output_dir`, the fields they record, and how `tevu report` regenerates derived files.

## Layout

```text
<run-id>/
  run.json
  conclusions.json
  result.json
  report.md
  summary.md
  cases/<task-id>--<model-id>--<attempt>/
    events.jsonl
    stderr.log
    session.json
    solution.patch
    checks.json
    grading.json
    assessment.json
    result.json
    setup-before-agent.log
    setup-before-checks.log
```

Some files are absent when the evidence was unavailable. Their absence is recorded, not treated as a successful measurement. `assessment.json` appears after the first assessment. A transient `assessment.lock` directory exists in a case directory while an assessment is in progress.

## Files

| File | Contents |
| --- | --- |
| `run.json` | Run identity, configuration snapshot, `configPath` (the absolute path of the file the run read), tool information, per-agent capability reports, `execution.repeat` (`value`, and `source`: `config` or `cli`), `execution.caseTimeoutMs`, case records, and findings. See [Run manifest](#run-manifest) |
| `conclusions.json` | A source artifact written once, by `tevu run`: per task, the facts of the [run summary](results.md#run-summary), the rows of its comparison table, its three conclusions, and `call`. `call` is `null` when no summary call was made, and otherwise records the model role, the outcome (`accepted` with the reply, `rejected` with the reply and the reason, or `no-reply` with the reason), and the call's usage and cost. Absent for a run cancelled during its cases |
| Root `result.json` | Normalized report data: a `models` array of `{id, model, effort}` per configured model entry, and `pairs`, one [pair summary](results.md#pair-summary) per task and model entry pair. A repository record carries `github`, as written, for a GitHub entry |
| `report.md` | Human-readable comparison with links to evidence |
| `summary.md` | The [run summary](results.md#run-summary): a short comparison per task for a reader who has not seen the configuration, derived from the saved `conclusions.json`, with one link, to `report.md` |
| `events.jsonl` | Raw agent event records, one JSON value per line. Only the case's agent adapter interprets them |
| `stderr.log` | Process diagnostics, including non-JSON run output |
| `session.json` | Raw root-session export. Only the case's agent adapter interprets it |
| `solution.patch` | The submitted solution, captured before restore, overlay, and acceptance commands run. It is relative to the [patch base](repositories.md#setup) (the state `before_agent` left) when the repository declares `before_agent`, otherwise to the synthetic root commit. A path present in that base or commit enters the patch when the agent changed or removed it, even if an ignore rule matches it. A new path enters it when no ignore rule matches it, or when the case repository's Git index tracks it, for example after `git add --force`, whether or not the agent committed it. A new path an ignore rule matches and the index does not track, such as build output, stays out of the patch. |
| `checks.json` | Check verdicts, timing, and evidence |
| `grading.json` | Present only when the case reached grading. The grader's identity, its raw call outcome with the cause of a missing reply (`unfinished`, `tool-call`, or `other`), every grader call with how it ended, its metrics, and its redacted run events, stderr, and session export, the grading's own metrics summed over its calls, and a grade or a pending reason per graded check. Root `result.json` keeps only each call's outcome and metrics |
| `assessment.json` | Current manual and grader verdicts, revision, and replacement history |
| Case `result.json` | Case lifecycle, process result, task outcome, metrics, check-state evidence, repository setup evidence, `failure`, and evidence paths. `artifacts.grading` is the path of `grading.json`, or `null` when the case was not graded |
| `setup-before-agent.log`, `setup-before-checks.log` | One section per command. Present only when the repository declares that phase and at least one command started |

Reports link to patches, transcripts, and complete evaluator output instead of embedding them. A report omits the task `prompt` but includes the task `description`, which for an imported task is the issue text.

### Run manifest

- `tools.agentVersions`: one detected version per agent in use.
- `tools.agentConfigurationFiles`: one entry per agent whose providers the run read, each holding the relative path and SHA-256 of every configuration file tevu wrote into that agent's homes, never the file's text.
- `tools.copiedProviders`: one entry per agent whose providers the run read, each listing the copied providers and the models whose copied definition defines a price, never a price or any other part of the definition. Regeneration uses it to recompute cost.
- `efforts`: the [effort check](agents-and-models.md#effort-check) of the validation the run followed. `efforts.models` holds one check per configured model entry ID, and `efforts.grader` holds the check of `roles.grader`, or `null` when the configuration declares no grader. A check is `{status: "verified"}`, or a `status` of `unverified` or `unsupported` with a `reason` text. The root `result.json` carries it inside its embedded manifest.

### Case identity

Every saved case identity, in `run.json` and at both levels of `result.json`, carries `model`, `modelId`, `effort`, `attempt` (1 through the effective repeat), and `agent` (the adapter that ran the case). It also carries `timeoutMs`: the agent time limit the case ran under in milliseconds, which is the task's `timeout` when declared and `run.timeout` otherwise. `execution.caseTimeoutMs` holds `run.timeout` in milliseconds.

An environment record's recipient is `agent` or `evaluator`. A process or protocol failure from a case's adapter is recorded with kind `AgentProcessError`, `AgentProtocolError`, or `AgentSessionError`, each carrying that case's `agent` name. `AgentSessionError` also carries `agentMessage`, the redacted first line of the agent's own message, when the agent reported one.

## Check state

A case whose task declares `checks.restore` or `checks.overlay` records what the check-state setup did in the case `result.json` field `checkState`. The field is absent when neither key is declared, when `restore` is empty and no overlay is declared, and when the case never reached the setup.

| Field | Contents |
| --- | --- |
| `checkState.restore.restored` | Matched paths whose worktree entry differed from the base tree and was reset |
| `checkState.restore.removed` | Matched untracked entries, and blockers displaced while restoring |
| `checkState.overlay.files[].path` | One overlay file's path, relative to the overlay directory |
| `checkState.overlay.files[].sha256` | The SHA-256 of that file's bytes as read at run start |
| `checkState.overlay.removed` | Every blocking entry the overlay step removed |

A restore or overlay failure ends the case with lifecycle `infrastructure-failed` and a `failure` of kind `CheckStateError` carrying `step` (`restore` or `overlay`) and `reason`. The cause can be worktree state the agent left, such as a read-only directory under a matched path. `checkState.restore.removed` can list `before_agent` output when a restore pattern matches it.

## Repository setup

A case whose repository declares `setup` records every started setup command in the case `result.json` field `setup`, present only when at least one command started.

| Field | Contents |
| --- | --- |
| `setup.logs.beforeAgent`, `setup.logs.beforeChecks` | Run-relative path of that phase's log, or `null` when the phase started no command or its log write failed |
| `setup.commands[].phase` | `before_agent` or `before_checks` |
| `setup.commands[].argv` | The command's literal executable and arguments |
| `setup.commands[].exitCode` | The exit code, or `null` when the command did not start or ended without one |
| `setup.commands[].durationMs` | The duration, or `null` when it did not start |
| `setup.commands[].outcome` | `passed`, `failed`, `timed-out`, `launch-failed`, or `cancelled` |

A command that fails, times out, or does not start ends the case with lifecycle `infrastructure-failed` and a `failure` of kind `SetupError` carrying `phase`, `argv`, and `reason`. A `before_checks` failure replaces a preserved agent failure, as `CheckStateError` does. A run cancellation during either phase ends the case with lifecycle `cancelled`.

## Data handling

Configured credential values are redacted before persistent or terminal output. Environment metadata records variable names and classifications (fixed, secret, or ordinary) rather than values. Private task text, repository content, model output, and check evidence stay in the configuration and run files. Host permissions govern access. A failed redaction aborts the affected write, including the write of `conclusions.json` and `summary.md`, which pass through the same redaction as `report.md`.

Artifacts remain until the operator deletes the run directory. There is no automatic retention and no upload.

## Regeneration

`tevu report <run-id>` recomputes normalized results and Markdown from saved evidence, saved grades, and current assessments, and renders `summary.md` from the saved `conclusions.json`. It resolves each case's metrics through the adapter registered under that case's `agent`, from that agent's `tools.copiedProviders`. It reads a case's `grading.json` only when the case's `artifacts.grading` is set. It never calls the grader, starts a model session, or contacts Git or an issue tracker. Unchanged source artifacts produce identical regenerated JSON and Markdown, `summary.md` included.

`tevu assess` rebuilds `result.json` and `report.md` but changes neither `conclusions.json` nor `summary.md`: the summary is written once, at the end of `tevu run`. A run without `conclusions.json` renders its summary from the facts derived from the saved artifacts, with template sentences. A malformed `conclusions.json`, including one with a malformed `call`, is refused with an error that names the file; delete it to make `tevu report` use template sentences.

`tevu report` and `tevu assess` read the configuration snapshot each run stored under its current layout. They refuse a run that lacks any of:

- the current configuration snapshot layout;
- `tools.agentVersions`, `tools.copiedProviders` (with an entry for every case's `agent`), `execution.repeat`, a non-empty string `configPath`, or `efforts` (with a valid check for every case's model entry, and a `grader` that is a valid check when the configuration snapshot declares a grader and `null` when it does not) in the manifest;
- `agent`, `attempt`, `timeoutMs`, or `artifacts.grading` in a case result;
- the `source` discriminator (`operator` or `grader`) in an assessment history entry.

Manifest and snapshot defects are refused before anything is written. A defective case result is refused when its case is read, so `report` can rewrite the cases before it and then stop. In `assess`, a defect in another case surfaces after the assessment is already saved, during the rebuild, and the error points to `tevu report`.

Replacing an assessment keeps the old verdict in history, whether it replaces an operator's verdict or a grader's. Each history entry's `source` records which. Only current verdicts affect the outcome.
