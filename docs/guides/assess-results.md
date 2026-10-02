# Assess results

Record your verdict on manual and graded checks, override a grader, and rebuild the report.

## Prerequisites

- A finished run. `tevu run` prints the run ID (`Run <id> started.`) and a summary block per attempt.
- A terminal for input and output. The command exits `1` without one.
- A case with lifecycle `completed` and at least one manual or graded check.

## Record verdicts

Assess one case at a time. Copy the command from the run output: an attempt with checks that wait for a verdict ends its summary with `Record the verdicts with` and the `tevu assess` command (or, when a required check already failed, says the verdicts can still be recorded for completeness with that command), with its arguments filled in. The attempt's section in `report.md` gives the same command, and, for an attempt that already has every verdict, the command to record or replace verdicts. The IDs below are examples:

```sh
tevu assess 20260923t120000z-a1b2c3d4e5f6 csv-export--high--1
```

Every attempt is its own case, so assess each one separately. The command walks the case's pending manual and graded checks in configured order and asks for:

- your assessor name, which is required;
- a verdict per check, with a note when the verdict is failed.

The command opens with `Assessing <case name>.` and names each check in plain words, with its category, whether it is required or optional, and whether it is manual or graded. For a graded check, tevu shows the saved grade or the reason it has none first, in the wording of the report. For example, when the grading ended after one call without a reply for a reason other than an early stop or a tool call, it prints `The grading model returned no verdict for this solution. This check has no verdict until you record one. Choose a verdict below.` and the raw reason after `Technical detail:`. Other causes print the matching opening from [Pending checks](../reference/results.md#pending-checks), such as `The grading model stopped before finishing its reply.` or, after several calls, `After 3 calls, the grading model stopped before finishing its reply.` A `passed` or `failed` grade stays unless you choose to replace it, and replacing it, or any earlier verdict, needs a confirmation. A pending or `undetermined` grade needs your decision. The replaced verdict stays in the assessment history.

The command asks for a decision on every pending check, including optional ones. Optional checks stay visible in the report but do not change an otherwise passed outcome.

The command then regenerates the report and prints `Assessment recorded.`, the attempt's summary with its new outcome and required checks, and the path of `report.md`. `summary.md` stays as `tevu run` wrote it, so a verdict recorded now shows in `report.md` and not in the summary. To cancel, press Escape or Ctrl-C twice within 800 ms (the same key both times); nothing is recorded and the command exits `130`.

## Rebuild the report

```sh
tevu report 20260923t120000z-a1b2c3d4e5f6
```

This rebuilds the results, `report.md`, and `summary.md` from saved artifacts without calling a model or contacting Git or a tracker. The summary is rendered from the saved `conclusions.json`. Use it after a report-write failure: a verdict committed before the failure stays saved, and the error names this command.

Confirm that every required manual and graded check now has a verdict.

## Clear a stale lock

An assessment holds a lock directory in the case directory. tevu never removes it automatically. When `assess` reports an existing lock, confirm no other `tevu assess` is running for that case, then remove the directory it names.

See the [CLI reference](../reference/cli.md#assessment) for the exact rules and [Artifacts](../reference/artifacts.md#regeneration) for what regeneration reads.
