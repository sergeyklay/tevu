<h1 align="center">tevu</h1>

<div align="center">

**Benchmark coding models on your real tasks.**

Task Evaluation & Verification Utility.<br/>
Compare task outcomes, execution time, and cost through OpenCode.

</div>

## The Problem

Public benchmark scores do not establish whether a model can complete your team's work, meet acceptance criteria, or justify its cost. tevu compares models on tasks from your own repositories and backlog.

## Works With

**Task sources:** Private Git repositories and Jira.

**Agent runtime:** OpenCode.

**Configuration:** YAML.

## How It Works

1. **Define a task.** An interview wizard captures the scope, task-specific prompt, acceptance criteria, Definition of Ready, and Definition of Done.
2. **Pin the starting point.** Select a repository commit before the task was solved. Keep later solutions and reference implementations outside the agent's accessible context.
3. **Choose the contenders.** Add two or more named model configurations, each with an explicit reasoning effort. Compare different models or the same model at different effort levels.
4. **Run in parallel.** Execute each task and model configuration in a separate Git worktree, with an isolated OpenCode session and no context shared between runs.
5. **Evaluate the result.** Judge each solution against the task's acceptance criteria and Definition of Done. Different implementations can satisfy the same requirements.

Start with one task. Extend the suite as useful work becomes available, including previously completed tasks replayed from their pinned commits.

## Reported Metrics

Each result identifies the task, starting commit, model, and reasoning effort.

| Category | Measurements |
| --- | --- |
| Outcome | Acceptance criteria and Definition of Done verdicts |
| Time | Elapsed execution time |
| Tokens | Input, output, reasoning, cache read, cache write |
| Activity | Turns, API calls, tool calls, skill invocations |
| Reliability | API errors |
| Cost | Monetary cost per run |

Unavailable measurements are reported as unavailable, not as zero.

## CLI

The CLI provides help, an interactive task wizard, YAML configuration validation, parallel benchmark execution, and a dry-run mode.
