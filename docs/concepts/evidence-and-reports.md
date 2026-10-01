# Evidence and reports

Why tevu keeps evidence after a workspace is gone, why a report can be rebuilt byte for byte, and why a missing measurement is never a number.

## Evidence outlives the workspace

A workspace is useful while models and checks run. Evidence has a different purpose: it lets you inspect a solution, assess a manual criterion, or rebuild a report without another model run, which costs money and returns different answers.

tevu keeps the patch, raw agent events, the session export, check results, and grading records after the workspace is cleaned up. The report links to them instead of embedding them, so a long transcript never buries the comparison. Redaction removes credential values and keeps the project text needed to judge the work. A failed redaction aborts the write rather than falling back to raw text, because a leaked secret in an artifact cannot be recalled.

The files are listed in [Artifacts](../reference/artifacts.md).

## Reports are derived

Every number and sentence in a report is computed from saved artifacts. `tevu report` reads them and nothing else: no Git, tracker, agent, or model call, no wall-clock time, and no unordered iteration. Unchanged artifacts therefore produce byte-identical JSON and Markdown.

That property has a use beyond convenience. A report you cannot regenerate is a claim you cannot check. Because regeneration is exact, you can rebuild a report after recording an assessment, after fixing a write failure, or years later, and trust that a difference means the evidence changed.

## Unavailable is not zero

Some metrics cannot be measured: a session export may be missing, or a provider may report no cost. tevu records an unavailable metric as unavailable, with a reason. It never records it as zero and never estimates it from a model name or token count.

Zero is a measurement. A report that shows `0 tokens` for a model whose export failed would rank it as the cheapest and fastest of the set, and the mistake would look like a result. An explicit gap is visible, and it stops the comparison from quietly favoring the model with the worst instrumentation. The same rule keeps a grader's usage apart from the case's own metrics: adding them would distort exactly the cost a comparison exists to show.

The rule has a limit. The agent reports a cost of zero both for a free model and for a model it has no price for. tevu tells them apart only from the copied definition of the provider and from a non-zero cost for the same model; without either, it records a gap, so a free model of a copied provider reads unavailable until the copied definition prices it. What remains is a provider tevu does not copy, an OpenCode built-in provider or one defined only in a task repository's tracked `opencode.json`. tevu stores its zero, because its price comes from the agent's own model catalog, which tevu cannot see, or from that repository's definition, which tevu does not consult, so a provider defined only in a task repository's tracked `opencode.json` that sets no price still reads as `$0.0000`.

## No winner

The report shows outcomes, per-pair counts, and measurements side by side. It computes no composite score and names no winner. Weighting speed against cost against pass rate is a judgment about your team's priorities, and a hidden formula would make that judgment for you, invisibly. The report gives you the evidence and leaves the decision where it belongs.
