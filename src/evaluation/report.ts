import type {
  AgentCapabilityReport,
  AssessmentArtifact,
  CaseResult,
  CheckRecord,
  CheckResult,
  MetricValue,
  ModelRecord,
  ReportResult,
  RepositoryRecord,
  RunFinding,
  RunManifest,
  RunResult,
  TaskRecord,
} from "../domain/types.ts";

/**
 * Everything report generation consumes: the versioned run record plus the
 * preserved task, model, repository, capability, and assessment records
 * needed to distinguish required from optional and manual from command checks.
 * The builder performs no I/O.
 */
export type ReportInput = {
  run: RunResult;
  capabilities: Readonly<Record<string, AgentCapabilityReport>>;
  tasks: readonly TaskRecord[];
  models: readonly ModelRecord[];
  repositories: readonly RepositoryRecord[];
  assessments: readonly AssessmentArtifact[];
};

/** Deterministic report model; identical source artifacts produce an identical model. */
export type NormalizedRunModel = {
  schemaVersion: 1;
  manifest: RunManifest;
  exitCode: RunResult["exitCode"];
  findings: RunFinding[];
  capabilities: Readonly<Record<string, AgentCapabilityReport>>;
  repositories: RepositoryRecord[];
  models: ModelRecord[];
  tasks: TaskRecord[];
  cases: CaseResult[];
  assessments: AssessmentArtifact[];
};

/** Builds the sorted, sensitive-content-free report model from preserved records. */
export function buildNormalizedRun(input: ReportInput): NormalizedRunModel {
  return {
    schemaVersion: 1,
    manifest: input.run.manifest,
    exitCode: input.run.exitCode,
    findings: [...input.run.findings].sort(
      (a, b) => compareStrings(a.caseId ?? "", b.caseId ?? "") || compareStrings(a.message, b.message),
    ),
    capabilities: input.capabilities,
    repositories: sortById(input.repositories),
    models: sortById(input.models),
    tasks: sortById(input.tasks).map((task) => ({
      ...task,
      checks: [...task.checks].sort((a, b) => compareStrings(a.id, b.id)),
    })),
    cases: [...input.run.cases]
      .sort((a, b) => compareStrings(a.identity.caseId, b.identity.caseId))
      .map((caseResult) => ({
        ...caseResult,
        checks: [...caseResult.checks].sort((a, b) => compareStrings(a.checkId, b.checkId)),
      })),
    assessments: [...input.assessments]
      .sort((a, b) => compareStrings(a.caseId, b.caseId))
      .map((artifact) => ({
        ...artifact,
        current: [...artifact.current].sort((a, b) => compareStrings(a.checkId, b.checkId)),
        history: [...artifact.history].sort(
          (a, b) => compareStrings(a.checkId, b.checkId) || compareStrings(a.replacedAt, b.replacedAt),
        ),
      })),
  };
}

/** Serializes the report model as deterministic JSON with recursively sorted object keys. */
export function serializeNormalizedRun(model: NormalizedRunModel): string {
  return `${JSON.stringify(sortKeysDeep(model), null, 2)}\n`;
}

/** Renders the fixed sensitive-data and non-adversarial isolation notice. */
export function renderSensitiveDataNotice(): string {
  return [
    "> **Sensitive data:** the tevu configuration file and this artifact directory can contain",
    "> sensitive private repository, task, Jira, model-output, and evaluator data. They rely on",
    "> host filesystem access controls.",
    ">",
    "> **Isolation boundary:** context isolation is non-adversarial. It withholds sibling runs,",
    "> later Git history, host agent state, and benchmark artifacts from normal discovery.",
    "> It does not claim that a model with shell access cannot probe arbitrary host paths.",
  ].join("\n");
}

/**
 * Builds the normalized JSON and Markdown report for one run. Pure and
 * deterministic: no I/O, no generation timestamps, no composite score, and no
 * winner selection.
 */
export function buildReport(input: ReportInput): ReportResult {
  const model = buildNormalizedRun(input);
  return {
    runId: model.manifest.runId,
    normalizedJson: serializeNormalizedRun(model),
    markdown: renderMarkdownReport(model),
  };
}

/** Renders the Markdown report from an already-sorted report model. */
export function renderMarkdownReport(model: NormalizedRunModel): string {
  const lines: string[] = [];
  const manifest = model.manifest;
  const tools = manifest.tools;

  lines.push(`# tevu run ${manifest.runId}`, "", renderSensitiveDataNotice(), "");

  lines.push(
    "## Run",
    "",
    `- Configuration digest: \`${manifest.configDigest}\``,
    `- Started: ${manifest.startedAt}`,
    `- Completed: ${manifest.completedAt ?? "not completed"}`,
    `- Host: ${manifest.host.platform}, Node.js ${manifest.host.nodeVersion}, Bun ${manifest.host.bunVersion}, Git ${tools.gitVersion}`,
    ...renderAgentCapabilityLines(tools.agentVersions, model.capabilities),
    `- Concurrency: ${manifest.execution.concurrency}`,
    `- Case timeout: ${manifest.execution.caseTimeoutMs}ms`,
    `- Run exit code: ${model.exitCode}`,
    "",
  );

  if (model.findings.length > 0) {
    lines.push("## Run findings", "");
    for (const finding of model.findings) {
      lines.push(`- ${finding.severity}${finding.caseId ? ` (case ${finding.caseId})` : ""}: ${finding.message}`);
    }
    lines.push("");
  }

  const tasksById = new Map(model.tasks.map((task) => [task.id, task]));
  const repositoriesById = new Map(model.repositories.map((repository) => [repository.id, repository]));
  const assessmentsByCase = new Map(model.assessments.map((artifact) => [artifact.caseId, artifact]));

  const taskIds = [...new Set(model.cases.map((caseResult) => caseResult.identity.taskId))].sort(
    compareStrings,
  );

  for (const taskId of taskIds) {
    const task = tasksById.get(taskId);
    const taskCases = model.cases.filter((caseResult) => caseResult.identity.taskId === taskId);

    lines.push(`## Task ${taskId}`, "");
    if (task !== undefined) {
      const repository = repositoriesById.get(task.repositoryId);
      lines.push(
        task.description,
        "",
        `- Repository: ${task.repositoryId}${repository ? ` (\`${repository.path}\`)` : ""}`,
        `- Source commit: \`${task.startCommit}\``,
        `- Source: ${describeTaskSource(task.source)}`,
        "",
      );
    }

    lines.push(
      "| Outcome | Model entry | Model | Effort | Lifecycle | Runtime failure | Elapsed |",
      "|---|---|---|---|---|---|---|",
    );
    for (const caseResult of taskCases) {
      const identity = caseResult.identity;
      lines.push(
        `| ${caseResult.outcome} | ${cell(identity.modelId)} | ${cell(identity.model)} | ${cell(identity.effort)} | ${caseResult.lifecycle} | ${caseResult.failure ? cell(caseResult.failure.error.kind) : "none"} | ${cell(formatMetricValue(caseResult.metrics.elapsed))} |`,
      );
    }
    lines.push("");

    for (const caseResult of taskCases) {
      renderCase(lines, caseResult, task, assessmentsByCase.get(caseResult.identity.caseId));
    }
  }

  lines.push(
    "---",
    "",
    "Task outcome, runtime failure, and run exit status are reported independently.",
    "Command check output is configured acceptance evidence, not an additional model-quality metric.",
    "No composite score or winner is computed.",
    "",
  );

  return lines.join("\n");
}

/** Renders one version and isolation line per agent in use, in `compareStrings` order. */
function renderAgentCapabilityLines(
  agentVersions: Readonly<Record<string, string | null>>,
  capabilities: NormalizedRunModel["capabilities"],
): string[] {
  const lines: string[] = [];
  for (const name of Object.keys(agentVersions).sort(compareStrings)) {
    lines.push(`- Agent "${name}" version (detected provenance only): ${agentVersions[name] ?? "not detected"}`);
    lines.push(
      `- Agent "${name}" isolation control (deny outside worktree): ${capabilities[name]?.isolation.denyOutsideWorktree ?? "not probed"}`,
    );
  }
  return lines;
}

function renderCase(
  lines: string[],
  caseResult: CaseResult,
  task: TaskRecord | undefined,
  assessment: AssessmentArtifact | undefined,
): void {
  const identity = caseResult.identity;
  const definitions = new Map((task?.checks ?? []).map((check) => [check.id, check]));

  lines.push(
    `### Case ${identity.caseId}`,
    "",
    `- Model entry: ${identity.modelId} (${identity.model}, effort ${identity.effort})`,
    `- Lifecycle: ${caseResult.lifecycle}`,
    `- Task outcome: ${caseResult.outcome}`,
  );

  if (caseResult.process !== null) {
    const process = caseResult.process;
    const ending =
      process.exitCode !== null
        ? `exit code ${process.exitCode}`
        : `signal ${process.signal ?? "unknown"}`;
    lines.push(`- Process: ${ending}, ${process.durationMs}ms, termination stage ${process.terminationStage}`);
  } else {
    lines.push("- Process: not started");
  }

  if (caseResult.failure !== null) {
    lines.push(
      `- Runtime failure (preserved independently of the task outcome): ${caseResult.failure.error.kind} at ${caseResult.failure.occurredAt}`,
    );
  }
  lines.push("");

  if (caseResult.checks.length > 0) {
    lines.push(
      "| Verdict | Check | Category | Required | Evaluator | Duration | Evidence |",
      "|---|---|---|---|---|---|---|",
    );
    for (const check of caseResult.checks) {
      const definition = definitions.get(check.checkId);
      lines.push(
        `| ${check.verdict} | ${cell(check.checkId)} | ${check.category} | ${definition ? String(definition.required) : "unknown"} | ${definition?.evaluator ?? "unknown"} | ${check.durationMs === null ? "-" : `${check.durationMs}ms`} | ${evidenceLink(caseResult)} |`,
      );
    }
    lines.push("");
    const pendingChecks = caseResult.checks.filter((check) => check.verdict === "pending");
    if (pendingChecks.length > 0) {
      lines.push(
        `Pending manual checks: ${pendingChecks.map((check) => check.checkId).join(", ")}.`,
        "",
      );
    }
  }

  lines.push("Metrics:", "");
  for (const [name, metric] of sortedMetricEntries(caseResult)) {
    lines.push(`- ${name}: ${formatMetricValue(metric)}`);
  }
  lines.push("");

  lines.push("Artifacts:", "");
  const artifacts = caseResult.artifacts;
  lines.push(
    `- Solution patch: ${artifactLink(artifacts.solutionPatch)}`,
    `- Events: ${artifactLink(artifacts.events)}`,
    `- Diagnostics: ${artifactLink(artifacts.diagnostics)}`,
    `- Session export: ${artifactLink(artifacts.sessionExport)}`,
    `- Check evidence: ${artifactLink(artifacts.checks)}`,
    `- Result: ${artifactLink(artifacts.result)}`,
    "",
  );

  if (assessment !== undefined && assessment.current.length > 0) {
    lines.push(`Assessments (revision ${assessment.revision}):`, "");
    for (const record of assessment.current) {
      lines.push(
        `- ${record.checkId}: ${record.verdict} by ${cell(record.assessor)} at ${record.assessedAt}${record.note.length > 0 ? ` — ${cell(record.note)}` : ""}`,
      );
    }
    lines.push("");
  }
}

function sortedMetricEntries(caseResult: CaseResult): Array<[string, MetricValue]> {
  return (Object.entries(caseResult.metrics) as Array<[string, MetricValue]>).sort((a, b) =>
    compareStrings(a[0], b[0]),
  );
}

function formatMetricValue(metric: MetricValue): string {
  if (metric.availability.status === "unavailable") {
    return `unavailable: ${metric.availability.reason}`;
  }
  if (metric.value === null) {
    return "unavailable: no value recorded";
  }
  return `${metric.value} ${metric.unit} (${metric.scope}, source: ${metric.availability.source})`;
}

function describeTaskSource(source: TaskRecord["source"]): string {
  switch (source.kind) {
    case "manual":
      return `manual — ${source.title}${source.reference ? ` (${source.reference})` : ""}`;
    case "jira-cloud":
      return `Jira snapshot — [${source.issueKey}](${source.issueUrl})`;
    case "github-issue":
      return `GitHub issue snapshot — [${source.issueKey}](${source.issueUrl})`;
  }
}

function evidenceLink(caseResult: CaseResult): string {
  return artifactLink(caseResult.artifacts.checks);
}

function artifactLink(path: string | null): string {
  return path === null ? "missing" : `[${cell(path)}](${path})`;
}

/** Escapes table-breaking characters in one Markdown table cell or inline value. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function sortById<T extends { id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => compareStrings(a.id, b.id));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeysDeep(record[key])]),
    );
  }
  return value;
}
