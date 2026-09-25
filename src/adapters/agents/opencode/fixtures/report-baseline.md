# tevu run 20260923t000000z-synthetic

> **Sensitive data:** the tevu configuration file and this artifact directory can contain
> sensitive private repository, task, Jira, model-output, and evaluator data. They rely on
> host filesystem access controls.
>
> **Isolation boundary:** context isolation is non-adversarial. It withholds sibling runs,
> later Git history, host agent state, and benchmark artifacts from normal discovery.
> It does not claim that a model with shell access cannot probe arbitrary host paths.

## Run

- Configuration digest: `sha256-synthetic-digest`
- Started: 2026-09-23T00:00:00.000Z
- Completed: not completed
- Host: linux, Node.js v24.21.0, Git git version 2.45.0
- Agent "opencode" version (detected provenance only): 9.9.9-synthetic
- Agent "opencode" isolation control (deny outside worktree): unavailable
- Concurrency: 2
- Case timeout: 60000ms
- Repeat: 1 (source: config)
- Run exit code: 2

## Run findings

- warning: cleanup warning: retained synthetic path

## Task task-1

synthetic task description for the welcome route

- Repository: repo-1 (`/tevu-synthetic/repo-1`)
- Source commit: `0123456789abcdef0123456789abcdef01234567`
- Source: manual — Synthetic welcome-route task

Pair summary:

| Model entry | Planned | passed | failed | pending | not-evaluated | Passed of planned | All passed |
|---|---|---|---|---|---|---|---|
| alpha | 1 | 1 | 0 | 0 | 0 | 1/1 | yes |
| beta | 1 | 0 | 1 | 0 | 0 | 0/1 | no |

| Outcome | Model entry | Attempt | Model | Effort | Lifecycle | Runtime failure | Elapsed |
|---|---|---|---|---|---|---|---|
| passed | alpha | 1 | vendor/model-alpha-synth | effort-high | completed | none | 1500 millisecond (case, source: process) |
| failed | beta | 1 | vendor/model-alpha-synth | effort-low | completed | AgentProcessError | 900 millisecond (case, source: process) |

### Case task-1--alpha--1

- Model entry: alpha (vendor/model-alpha-synth, effort effort-high)
- Lifecycle: completed
- Task outcome: passed
- Process: exit code 0, 1500ms, termination stage none

| Verdict | Check | Category | Required | Evaluator | Duration | Evidence |
|---|---|---|---|---|---|---|
| passed | acc-acceptance-command | acceptance | true | command | 12ms | [cases/task-1--alpha--1/checks.json](cases/task-1--alpha--1/checks.json) |
| passed | dod-manual-review | definition-of-done | true | manual | - | [cases/task-1--alpha--1/checks.json](cases/task-1--alpha--1/checks.json) |
| pending | man-optional-polish | definition-of-done | false | manual | - | [cases/task-1--alpha--1/checks.json](cases/task-1--alpha--1/checks.json) |

Pending manual checks: man-optional-polish.

Metrics:

- apiCalls: 2 count (root-session, source: root-session export)
- apiErrors: 1 count (root-session, source: root-session export)
- cacheReadTokens: 30 token (root-session, source: root-session export)
- cacheWriteTokens: 10 token (root-session, source: root-session export)
- cost: 0.0125 USD (root-session, source: root-session export)
- elapsed: 1500 millisecond (case, source: process)
- inputTokens: 130 token (root-session, source: root-session export)
- outputTokens: 45 token (root-session, source: root-session export)
- reasoningTokens: 16 token (root-session, source: root-session export)
- skillCalls: 1 count (root-session, source: root-session export)
- toolCalls: 2 count (root-session, source: root-session export)
- turns: 1 count (root-session, source: root-session export)

Artifacts:

- Solution patch: [cases/task-1--alpha--1/solution.patch](cases/task-1--alpha--1/solution.patch)
- Events: [cases/task-1--alpha--1/events.jsonl](cases/task-1--alpha--1/events.jsonl)
- Diagnostics: [cases/task-1--alpha--1/stderr.log](cases/task-1--alpha--1/stderr.log)
- Session export: [cases/task-1--alpha--1/session.json](cases/task-1--alpha--1/session.json)
- Check evidence: [cases/task-1--alpha--1/checks.json](cases/task-1--alpha--1/checks.json)
- Result: [cases/task-1--alpha--1/result.json](cases/task-1--alpha--1/result.json)

Assessments (revision 2):

- dod-manual-review: passed by curator at 2026-09-23T01:00:00.000Z — confirmed by reviewer

### Case task-1--beta--1

- Model entry: beta (vendor/model-alpha-synth, effort effort-low)
- Lifecycle: completed
- Task outcome: failed
- Process: exit code 1, 900ms, termination stage none
- Runtime failure (preserved independently of the task outcome): AgentProcessError at 2026-09-23T00:00:00.950Z

| Verdict | Check | Category | Required | Evaluator | Duration | Evidence |
|---|---|---|---|---|---|---|
| failed | acc-acceptance-command | acceptance | true | command | 12ms | [cases/task-1--beta--1/checks.json](cases/task-1--beta--1/checks.json) |

Metrics:

- apiCalls: unavailable: the preserved case artifacts contain no session export
- apiErrors: 1 count (root-session, source: run events)
- cacheReadTokens: unavailable: the preserved case artifacts contain no session export
- cacheWriteTokens: unavailable: the preserved case artifacts contain no session export
- cost: unavailable: the preserved case artifacts contain no session export
- elapsed: 900 millisecond (case, source: process)
- inputTokens: unavailable: the preserved case artifacts contain no session export
- outputTokens: unavailable: the preserved case artifacts contain no session export
- reasoningTokens: unavailable: the preserved case artifacts contain no session export
- skillCalls: 0 count (root-session, source: run events)
- toolCalls: 1 count (root-session, source: run events)
- turns: unavailable: the preserved case artifacts contain no session export

Artifacts:

- Solution patch: missing
- Events: [cases/task-1--beta--1/events.jsonl](cases/task-1--beta--1/events.jsonl)
- Diagnostics: [cases/task-1--beta--1/stderr.log](cases/task-1--beta--1/stderr.log)
- Session export: missing
- Check evidence: [cases/task-1--beta--1/checks.json](cases/task-1--beta--1/checks.json)
- Result: [cases/task-1--beta--1/result.json](cases/task-1--beta--1/result.json)

## Task task-2

synthetic task description for the welcome route

- Repository: repo-1 (`/tevu-synthetic/repo-1`)
- Source commit: `fedcba9876543210fedcba9876543210fedcba98`
- Source: Jira snapshot — [TEVU-999](https://jira.example.com/browse/TEVU-999)

Pair summary:

| Model entry | Planned | passed | failed | pending | not-evaluated | Passed of planned | All passed |
|---|---|---|---|---|---|---|---|
| alpha | 1 | 0 | 0 | 0 | 1 | 0/1 | no |

| Outcome | Model entry | Attempt | Model | Effort | Lifecycle | Runtime failure | Elapsed |
|---|---|---|---|---|---|---|---|
| not-evaluated | gamma | 1 | vendor/model-gamma-synth | effort-high | timed-out | CaseTimeoutError | 42000 millisecond (case, source: process) |

### Case task-2--alpha--1

- Model entry: gamma (vendor/model-gamma-synth, effort effort-high)
- Lifecycle: timed-out
- Task outcome: not-evaluated
- Process: signal SIGKILL, 42000ms, termination stage forced
- Runtime failure (preserved independently of the task outcome): CaseTimeoutError at 2026-09-23T00:00:42.100Z

Metrics:

- apiCalls: unavailable: the preserved case artifacts contain no session export; root session could not be identified
- apiErrors: unavailable: the preserved case artifacts contain no session export; root session could not be identified
- cacheReadTokens: unavailable: the preserved case artifacts contain no session export; root session could not be identified
- cacheWriteTokens: unavailable: the preserved case artifacts contain no session export; root session could not be identified
- cost: unavailable: the preserved case artifacts contain no session export; root session could not be identified
- elapsed: 42000 millisecond (case, source: process)
- inputTokens: unavailable: the preserved case artifacts contain no session export; root session could not be identified
- outputTokens: unavailable: the preserved case artifacts contain no session export; root session could not be identified
- reasoningTokens: unavailable: the preserved case artifacts contain no session export; root session could not be identified
- skillCalls: unavailable: the preserved case artifacts contain no session export; root session could not be identified
- toolCalls: unavailable: the preserved case artifacts contain no session export; root session could not be identified
- turns: unavailable: the preserved case artifacts contain no session export; root session could not be identified

Artifacts:

- Solution patch: missing
- Events: missing
- Diagnostics: missing
- Session export: missing
- Check evidence: missing
- Result: [cases/task-2--alpha--1/result.json](cases/task-2--alpha--1/result.json)

---

Task outcome, runtime failure, and run exit status are reported independently.
Command check output is configured acceptance evidence, not an additional model-quality metric.
No composite score or winner is computed.
