# How tevu works

The model behind a benchmark run: what a task, a case, and a run are, and why tevu treats every case as an independent, comparable experiment.

## The unit of comparison

A benchmark compares models on the same work. tevu therefore separates three things that are easy to blur:

- A **task** is the work: a prompt, a starting commit, and the checks that define success.
- A **model entry** is one model and reasoning effort to compare. Two entries can share a model and differ only in effort.
- A **case** is one attempt by one model entry at one task. Each pair of task and model entry produces `run.repeat` cases, each in its own workspace.

Nothing is shared between cases. A model cannot see a sibling's output, and one case's leftover files cannot help the next. That independence is the property that lets a difference in results be attributed to the model rather than to an accident of ordering or contamination. [Isolation](isolation.md) explains the boundaries that enforce it.

Repeats exist because one attempt is a sample. A model that passes once and fails twice tells you something a single pass hides. tevu reports the attempts of a pair together. Outcomes and check verdicts are counted, measurements are summarized by the median of the attempts that reported them, and nothing is combined into a score or a winner. Whether one pass in three is acceptable is a decision about your team's work that tevu cannot make for you.

## The life of a case

A case moves through fixed stages, in this order:

1. tevu seals a repository holding the task's starting tree and builds separate environments for the agent and the evaluator.
2. Optional `before_agent` setup commands prepare the worktree.
3. The agent works on the prompt until it finishes or hits the time limit.
4. tevu captures the agent's changes as a patch, before any check can create files.
5. The evaluator restores and overlays check files, runs optional `before_checks` setup, then runs the checks.
6. When the task declares graded checks, a separate grader model judges them against the patch.
7. Manual and undetermined verdicts wait for an operator.

The order carries the design. The patch is captured first so a test run cannot turn its own output into part of the model's solution. Checks run after restore and overlay so the agent's edits to test files do not decide the verdict. Grading is a separate model call so the agent is judged by something other than itself.

## Process status and task outcome

A case has two independent results. The process result says whether the agent ran cleanly: it can time out, crash, report an error of its own while exiting cleanly, or produce an export tevu cannot read. The task outcome says whether the solution passed its required checks. A model can crash after writing a correct solution, and tevu records both facts instead of collapsing them. The run's exit code reflects both. See [Results](../reference/results.md#outcomes) for the outcome values.

## Three kinds of checks

The kinds exist because "did it work" has three different answers:

- A **command check** is objective and repeatable: an exit code.
- A **graded check** states a criterion in plain language for cases where no command can decide, such as "the change adds tests for the fixed behavior". A model grades it from the patch, so its verdict is judgment, not proof.
- A **manual check** puts the decision with you.

A grader's verdict can be overridden, and the override keeps the original in history. tevu treats a grade as evidence you can overrule, not as a ruling.

See [Checks](../reference/checks.md) for the field definitions.
