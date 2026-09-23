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

### Prerequisites

tevu supports Linux and macOS. The Node.js LTS and Bun versions are configured in [`.tool-versions`](.tool-versions). Bun installs dependencies and launches package scripts; Node.js executes the CLI and Vitest. Git and an OpenCode executable with the required `run`, JSON output, model, variant, and `export` capabilities must be available. The detected OpenCode version is recorded as provenance, not used as a compatibility gate.

`bun install --frozen-lockfile` installs the locked dependencies. From the checkout, `bun run start -- --help` displays CLI help. The package executable is `tevu`; imported TypeScript modules are internal interfaces.

### Commands

| Command | Behavior |
| --- | --- |
| `tevu task add [--config <path>] [--jira <issue-key>]` | Interviews for a task and atomically updates the YAML configuration. A missing configuration starts a bootstrap interview. Jira content is imported once as a snapshot. Requires TTY stdin and stdout. |
| `tevu validate [--config <path>]` | Checks the schema, local prerequisites, source commits, environment-variable presence, and OpenCode capabilities without invoking a model. |
| `tevu run [--config <path>] [--dry-run]` | Executes the task-by-contender matrix with bounded concurrency. Dry-run prints the plan without creating run artifacts or workspaces, contacting Jira, or starting a model session. |
| `tevu assess <run-id> <case-id> [--config <path>]` | Records pending manual verdicts or confirmed replacements and regenerates the report. Requires TTY stdin and stdout. |
| `tevu report <run-id> [--config <path>]` | Regenerates normalized results and Markdown from preserved run artifacts without Git, Jira, OpenCode, or model calls. |

Every command supports `--help`. `--config` defaults to `tevu.yaml`; configuration paths resolve relative to that file. The configuration requires at least one task, two contenders, explicit execution limits, and named environment-variable declarations. Unknown configuration keys are rejected.

Exit codes are `0` for completion, `1` for invalid input or incomplete benchmark evidence, `2` for preserved benchmark evidence with runtime failures or failed/pending required checks, and `130` for cancellation. A process failure remains visible even when the task's required checks pass.

### Artifacts and isolation

The configuration file and artifact directory can contain sensitive private repository, task, Jira, model-output, and evaluator data. Their protection relies on host filesystem access controls. Configured credential-secret values are redacted before persistence and display. Environment declarations retain names and classifications, not values.

Each case receives a sealed repository containing one synthetic root commit of the pinned source tree, isolated OpenCode state, and a separate evaluator environment. Source repositories remain read-only. Submodules and Git LFS sources are unsupported. Context isolation withholds later history, sibling cases, host OpenCode state, and benchmark artifacts from normal discovery; it does not contain hostile code or prevent shell access to arbitrary host paths. The report shows whether an additional outside-worktree restriction is available.

Run artifacts preserve events, diagnostics, root-session exports, the pre-evaluation solution patch, check evidence, manual assessment history, normalized results, and `report.md`. Reports link to source evidence instead of inlining transcripts, patches, or complete evaluator output. Unchanged source artifacts produce identical regenerated results. Artifacts remain until the operator deletes them.

### Development verification

`bun run typecheck` runs strict TypeScript checking. `bun run test` runs the colocated Vitest product tests under Node.js; a focused invocation is `bun run test -- src/evaluation/evaluation.test.ts`. Product tests use fakes, public synthetic fixtures, temporary repositories, and bounded local processes. They do not start live model sessions. Target-task acceptance commands are configured separately and contribute only their declared check verdicts.
