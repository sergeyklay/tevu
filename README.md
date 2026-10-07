<h1 align="center">tevu</h1>

<div align="center">

[![CI](https://github.com/sergeyklay/tevu/actions/workflows/ci.yml/badge.svg)](https://github.com/sergeyklay/tevu/actions/workflows/ci.yml)
[![Security](https://github.com/sergeyklay/tevu/actions/workflows/security.yml/badge.svg)](https://github.com/sergeyklay/tevu/actions/workflows/security.yml)

**Benchmark coding models on your real tasks.**

Find which models finish your tasks, how long they take, and what they cost.

[Get started](https://github.com/sergeyklay/tevu/blob/v0.1.0/docs/getting-started/first-comparison.md) · [Documentation](https://github.com/sergeyklay/tevu/blob/v0.1.0/docs/README.md)

</div>

## The problem

Public benchmarks don't tell you which coding model can finish your team's backlog, or whether a cheaper model can do the same work. Finding out means giving models the same starting point, checking their solutions, and tracking time and cost. Doing that by hand becomes a project of its own.

tevu runs that comparison on tasks from your own task tracker.

## What you get

Each run ends with a short summary per task. Here, three model settings tried to fix a login redirect:

| Model | Effort | Outcome | Required checks | Elapsed | Cost |
|---|---|---|---|---|---|
| model-a | high | passed | 6/6 passed | 6.3 min | $1.2400 |
| model-a | low | failed | 4/6 passed, 2 failed | 2.1 min | $0.3100 |
| model-b | high | passed | 6/6 passed | 4.8 min | $0.4100 |

- **Correctness:** 2 of 3 model settings did the task, passing all 6 required checks: model-a, high; model-b, high. The other did not: model-a, low passed 4 of 6 required checks.
- **Cost:** Among the settings that did the task, model-b, high was cheapest: $0.4100 against $1.2400, about 3 times less.
- **Speed:** Among the settings that did the task, model-b, high was fastest: 4.8 min against 6.3 min, 24% less time.

A full report keeps every solution, check verdict, and measurement behind these lines.

## Quick start

You need Linux or macOS, Node.js 24, Git, and [OpenCode](https://opencode.ai) with an API key for your model provider.

```sh
npm install --global @serghei/tevu
tevu task add   # describe the task and the models to compare
tevu run
```

[Run your first comparison](https://github.com/sergeyklay/tevu/blob/v0.1.0/docs/getting-started/first-comparison.md) walks through it on a task your team has already solved.

## How it works

1. **Choose a task.** Import it from GitHub Issues or Jira, or describe it yourself. Then define what a correct solution must do: commands such as your test suite, and criteria a grading model checks.
2. **Compare models.** Each model, or the same model at a different reasoning effort, starts from the same commit in its own copy of the repository. It cannot see the accepted solution or another model's work.
3. **Read the results.** tevu runs your checks on every solution and records time and cost.

## Limits

- Models run through OpenCode, the only supported coding agent so far.
- Runs happen on your machine, and your provider bills every model call.
- tevu computes no score and names no overall winner. It reports what happened and leaves the decision to you.

## Documentation

[Guides and reference](https://github.com/sergeyklay/tevu/blob/v0.1.0/docs/README.md) cover setup, configuration, commands, and results. To work on tevu itself, see [CONTRIBUTING.md](https://github.com/sergeyklay/tevu/blob/v0.1.0/CONTRIBUTING.md).

## License

[Apache License 2.0](https://github.com/sergeyklay/tevu/blob/v0.1.0/LICENSE)
