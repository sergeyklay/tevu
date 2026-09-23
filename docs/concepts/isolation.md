# Why benchmark cases need separate context

A comparison is useful only when the models face the same task. If one can discover an earlier solution or another model's output, the result measures access to that information as well as the model's ability. tevu separates the context supplied to each case to make that difference explicit.

## The same files are not the same context

Checking out an old commit gives a model the old files, but a repository can still contain later commits with the finished solution. It is like setting the same exercise while leaving the answer sheet available to one participant.

Each tevu case therefore gets a sealed repository whose history begins with the selected tree. The model sees the task's starting point rather than the source repository's later work. The original commit identity remains in the results so the comparison can still be traced to its source.

Tracked project instructions remain part of the task. Host sessions, global prompts, caches, and login stores do not: they are state from the operator's previous work, not a shared starting condition. The precise source-tree rules and unsupported features are in the [configuration reference](../reference/configuration.md#source-trees).

## The evaluator has a different job

The agent needs enough context and credentials to produce a solution. An acceptance command needs the submitted files and its declared test inputs. Sharing the agent's home or authentication state would give the evaluator dependencies that its check definition does not describe.

tevu gives evaluators separate state directories and a fixed environment with explicitly allowed additions. It also captures the solution patch before checks run, so files created by a test command do not become part of the model's submitted solution. The [environment reference](../reference/configuration.md#fixed-evaluator-environment) lists the exact variables.

## Context isolation is not a sandbox

Separate directories keep sibling outputs and benchmark artifacts out of the context tevu supplies. They do not create an operating-system security boundary: an agent with shell access can still probe other host paths. The current adapter reports its optional outside-worktree restriction as `unavailable`.

The distinction matters when interpreting a result. tevu controls the starting context and records evidence; it does not establish that untrusted code was contained. The report keeps that limitation visible alongside the comparison.

## Evidence outlives the workspace

Temporary workspaces are useful while models and checks are running. Saved evidence has a different purpose: it lets an operator inspect a solution, assess a manual criterion, or rebuild a report without starting another model run.

The patch and source records are retained after successful workspace cleanup. Credential redaction removes authentication values while preserving the project text needed to judge the work. The [results reference](../reference/results.md#saved-files) describes these files and their retention.
