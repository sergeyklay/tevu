# tevu run 20260923t000000z-synthetic

## Comparison: Synthetic welcome-route task (1)

| Model | Effort | Outcome | Required checks | Elapsed | Cost | Turns | Tool calls | Input | Cache read | Cache write | Output | Reasoning | API errors | Runtime failure |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [vendor/model-alpha-synth](#case-task-1--alpha--1) | effort-high | passed \[1\] | 2/2 passed | 1.5 s | $0.0125 | 1 | 2 | 130 | 30 | 10 | 45 | 16 | 2 | none |
| [vendor/model-alpha-synth](#case-task-1--beta--1) | effort-low, unverified | failed | 0/2 passed, 1 failed, 1 not run | 0.9 s | - \[2\] | - \[2\] | 1 | - \[2\] | - \[2\] | - \[2\] | - \[2\] | - \[2\] | 1 | agent process failed \[3\] |

1. vendor/model-alpha-synth, effort-high: 1 optional manual check waits for a person's verdict. Optional checks do not change the outcome, which stays passed. Record the verdict with `tevu assess 20260923t000000z-synthetic task-1--alpha--1`. Technical detail: case task-1--alpha--1
2. vendor/model-alpha-synth, effort-low: tevu has no value for this measurement. It is unknown, not zero. This run's saved files cannot supply it; to measure it, fix the cause in the technical detail and run the comparison again. Technical detail: the preserved case artifacts contain no session export
3. vendor/model-alpha-synth, effort-low: The agent process stopped with an error. Its solution was still checked, so the outcome comes from its checks. Read the attempt's diagnostics log to find out why. Technical detail: case task-1--beta--1: AgentProcessError, exit code 1, signal none

## Comparison: Synthetic welcome-route task (2)

| Model | Effort | Outcome | Required checks | Elapsed | Cost | Turns | Tool calls | Input | Cache read | Cache write | Output | Reasoning | API errors | Runtime failure |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| vendor/model-alpha-synth | effort-high | not-evaluated \[1\] | 0/2 passed, 2 not run | - \[1\] | - \[1\] | - \[1\] | - \[1\] | - \[1\] | - \[1\] | - \[1\] | - \[1\] | - \[1\] | - \[1\] | - \[1\] |

1. vendor/model-alpha-synth, effort-high: tevu saved no result for this attempt. It has no outcome or measurements, so it counts as not evaluated. Run the comparison again to get a result for this attempt. Technical detail: case task-2--alpha--1: no case result was saved

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
- vendor/model-alpha-synth, effort-high: effort verified
- vendor/model-alpha-synth, effort-low: effort unverified. tevu could not confirm that the agent offers effort "effort-low" for this model. The effort was passed as requested; if the agent does not offer it, the model ran with its default options. Before the next run, check the effort against the variants the agent lists for the model. Technical detail: "effort-low" is not among the variants "opencode models --verbose" reports for "vendor/model-alpha-synth" (effort-high), and the repository of each task may define it: task-1 (opencode.json)
- vendor/model-gamma-synth, effort-high: effort unsupported. The agent does not list effort "effort-high" for this model. Where no task repository defines it, the model ran with its default options. Choose an effort the agent lists for the model and run the comparison again. Technical detail: "effort-high" is not among the variants "opencode models --verbose" reports for "vendor/model-gamma-synth" (max), and these tasks have no agent configuration at the root of their base commit: task-2; their cases would run "vendor/model-gamma-synth" with its default options
- Run exit code: 2

## Run findings

- Warning: cleanup warning: retained synthetic path

## Task: Synthetic welcome-route task (1)

synthetic task description for the welcome route

- Repository: `/tevu-synthetic/repo-1`
- Source commit: `0123456789abcdef0123456789abcdef01234567`

Pair summary:

| Model setting | Planned | passed | failed | pending | not-evaluated | Passed of planned | All passed |
|---|---|---|---|---|---|---|---|
| vendor/model-alpha-synth, effort-high | 1 | 1 | 0 | 0 | 0 | 1/1 | yes |
| vendor/model-alpha-synth, effort-low | 1 | 0 | 1 | 0 | 0 | 0/1 | no |

| Attempt | Outcome | Required checks | Runtime failure | Elapsed |
|---|---|---|---|---|
| [vendor/model-alpha-synth, effort-high](#case-task-1--alpha--1) | passed | 2/2 passed | none | 1.5 s |
| [vendor/model-alpha-synth, effort-low](#case-task-1--beta--1) | failed | 0/2 passed, 1 failed, 1 not run | agent process failed | 0.9 s |

<a id="case-task-1--alpha--1"></a>

### vendor/model-alpha-synth, effort-high

- Outcome: passed; required checks 2/2 passed
- Model: vendor/model-alpha-synth, effort effort-high
- Agent process: exited with code 0 after 1.5 s

1 optional manual check waits for a person's verdict. Optional checks do not change the outcome, which stays passed. Record the verdict with `tevu assess 20260923t000000z-synthetic task-1--alpha--1`. Technical detail: case task-1--alpha--1

| Verdict | Check | Category | Required | Evaluator | Duration | Evidence |
|---|---|---|---|---|---|---|
| passed | acceptance command exits zero | acceptance | required | command | 12ms | [checks.json](cases/task-1--alpha--1/checks.json) |
| passed | manual Definition of Done review | Definition of Done | required | manual | - | [checks.json](cases/task-1--alpha--1/checks.json) |
| pending | optional manual polish review | Definition of Done | optional | manual | - | [checks.json](cases/task-1--alpha--1/checks.json) |

Metrics:

- Elapsed: 1.5 s
- Cost: $0.0125
- Turns: 1
- API calls: 2
- Tool calls: 2
- Skill calls: 1
- Input tokens: 130
- Cache read tokens: 30
- Cache write tokens: 10
- Output tokens: 45
- Reasoning tokens: 16
- API errors: 2

Artifacts:

- Solution patch: [solution.patch](cases/task-1--alpha--1/solution.patch)
- Events: [events.jsonl](cases/task-1--alpha--1/events.jsonl)
- Diagnostics: [stderr.log](cases/task-1--alpha--1/stderr.log)
- Session export: [session.json](cases/task-1--alpha--1/session.json)
- Check evidence: [checks.json](cases/task-1--alpha--1/checks.json)
- Result: [result.json](cases/task-1--alpha--1/result.json)

Assessments (revision 2):

- manual Definition of Done review: passed by curator at 2026-09-23T01:00:00.000Z; note: confirmed by reviewer

<a id="case-task-1--beta--1"></a>

### vendor/model-alpha-synth, effort-low

- Outcome: failed; required checks 0/2 passed, 1 failed, 1 not run
- Model: vendor/model-alpha-synth, effort effort-low, unverified
- Agent process: exited with code 1 after 0.9 s

The agent process stopped with an error. Its solution was still checked, so the outcome comes from its checks. Read the attempt's diagnostics log to find out why. Technical detail: case task-1--beta--1: AgentProcessError, exit code 1, signal none

Record or replace verdicts with `tevu assess 20260923t000000z-synthetic task-1--beta--1`.

| Verdict | Check | Category | Required | Evaluator | Duration | Evidence |
|---|---|---|---|---|---|---|
| failed | acceptance command exits zero | acceptance | required | command | 12ms | [checks.json](cases/task-1--beta--1/checks.json) |

Metrics:

- Elapsed: 0.9 s
- Tool calls: 1
- Skill calls: 0
- API errors: 1
- Not measured: Cost, Turns, API calls, Input tokens, Cache read tokens, Cache write tokens, Output tokens, Reasoning tokens. tevu has no value for these measurements. They are unknown, not zero. This run's saved files cannot supply them; to measure them, fix the cause in the technical detail and run the comparison again. Technical detail: the preserved case artifacts contain no session export

Artifacts:

- Solution patch: missing
- Events: [events.jsonl](cases/task-1--beta--1/events.jsonl)
- Diagnostics: [stderr.log](cases/task-1--beta--1/stderr.log)
- Session export: missing
- Check evidence: [checks.json](cases/task-1--beta--1/checks.json)
- Result: [result.json](cases/task-1--beta--1/result.json)

## Task: Synthetic welcome-route task (2)

synthetic task description for the welcome route

- Repository: `/tevu-synthetic/repo-1`
- Source commit: `fedcba9876543210fedcba9876543210fedcba98`
- Source: imported from Jira issue [TEVU-999](https://jira.example.com/browse/TEVU-999)

Pair summary:

| Model setting | Planned | passed | failed | pending | not-evaluated | Passed of planned | All passed |
|---|---|---|---|---|---|---|---|
| vendor/model-alpha-synth, effort-high | 1 | 0 | 0 | 0 | 1 | 0/1 | no |

| Attempt | Outcome | Required checks | Runtime failure | Elapsed |
|---|---|---|---|---|
| [vendor/model-gamma-synth, effort-high](#case-task-2--alpha--1) | not-evaluated | 0/2 passed, 2 not run | time limit reached | 42.0 s |

<a id="case-task-2--alpha--1"></a>

### vendor/model-gamma-synth, effort-high

- Outcome: not-evaluated; required checks 0/2 passed, 2 not run
- Model: vendor/model-gamma-synth, effort effort-high, unsupported
- Agent process: ended by signal SIGKILL after 42.0 s; tevu forced it to stop

tevu saved no result for this attempt. It has no outcome or measurements, so it counts as not evaluated. Run the comparison again to get a result for this attempt. Technical detail: case task-2--alpha--1: no case result was saved

Metrics:

- Elapsed: 42.0 s
- Not measured: Cost, Turns, API calls, Tool calls, Skill calls, Input tokens, Cache read tokens, Cache write tokens, Output tokens, Reasoning tokens, API errors. tevu has no value for these measurements. They are unknown, not zero. This run's saved files cannot supply them; to measure them, fix the cause in the technical detail and run the comparison again. Technical detail: the preserved case artifacts contain no session export; root session could not be identified

Artifacts:

- Solution patch: missing
- Events: missing
- Diagnostics: missing
- Session export: missing
- Check evidence: missing
- Result: [result.json](cases/task-2--alpha--1/result.json)

---

Task outcome, runtime failure, and run exit status are reported independently.
Command check output is configured acceptance evidence, not an additional model-quality metric.
No composite score or winner is computed.
