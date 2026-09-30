# Documentation

New to tevu? Install it, then run your first comparison; the two Getting started pages take you from nothing to a finished report. Come back to the guides when you have a specific task, to the reference when you need an exact command, field, or file, and to the concepts when you want to know why tevu works the way it does.

- **Getting started**
  - [Install tevu](getting-started/installation.md) - build the executable and put it on your `PATH`
  - [Run your first comparison](getting-started/first-comparison.md) - compare two model settings on a solved task and read the report
- **Guides**
  - [Import a task from Jira Cloud](guides/import-jira-task.md) - add a Jira issue's text to a task
  - [Import a task from a GitHub issue](guides/import-github-issue.md) - add a GitHub issue's text to a task
  - [Benchmark a repository you have not cloned](guides/benchmark-a-github-repository.md) - let tevu clone a GitHub repository
  - [Draft criteria from a reference solution](guides/draft-criteria-from-a-reference-solution.md) - record the accepted pull request and review the drafted criteria
  - [Make a model reachable](guides/configure-model-access.md) - declare provider credentials for the benchmarked agent
  - [Assess results](guides/assess-results.md) - record verdicts, override a grader, and rebuild the report
  - [Troubleshoot common failures](guides/troubleshoot.md) - fix errors from `task add`, `validate`, and `run`
  - [Verify a change](guides/verify-change.md) - run the gates CI runs
- **Reference**
  - [CLI](reference/cli.md) - commands, options, configuration search, network use, and exit codes
  - [Task wizard](reference/task-wizard.md) - questions, defaults, retries, and keys of `tevu task add`
  - [Configuration](reference/configuration.md) - file format, top-level keys, paths, and value grammars
  - [Tasks](reference/tasks.md) - task fields, sources, reference solutions, and prompt screening
  - [Checks](reference/checks.md) - check kinds, graded checks, restore, and overlay
  - [Repositories](reference/repositories.md) - source trees, Git LFS, setup commands, and managed clones
  - [Agents and models](reference/agents-and-models.md) - agents, model entries, roles, providers, and model resolution
  - [Environment](reference/environment.md) - variable rules, fixed environments, and case executable probes
  - [Trackers](reference/trackers.md) - Jira Cloud and GitHub issue imports
  - [Results](reference/results.md) - cases, outcomes, and metrics
  - [Artifacts](reference/artifacts.md) - saved files, recorded fields, and report regeneration
  - [Source layout](reference/source-layout.md) - source directories and the build
- **Concepts**
  - [How tevu works](concepts/how-tevu-works.md) - tasks, cases, and the life of a comparison
  - [Isolation](concepts/isolation.md) - why cases get separate context and where isolation stops
  - [Model access](concepts/model-access.md) - why providers cross into a case and model calls get no repository
  - [Reference solutions](concepts/reference-solutions.md) - why the answer stays out of the prompt and how it can still leak
  - [Evidence and reports](concepts/evidence-and-reports.md) - why evidence is kept, reports are reproducible, and gaps are not zeros
