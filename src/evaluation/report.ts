import { effortLabel } from '@/domain/types';

import type {
  AgentCapabilityReport,
  AgentMetrics,
  AssessmentArtifact,
  BenchmarkMetrics,
  CaseIdentity,
  CaseResult,
  EffortCheck,
  GraderIdentity,
  GradingArtifact,
  MetricValue,
  ModelRecord,
  ReportResult,
  RepositoryRecord,
  RunFinding,
  RunManifest,
  RunResult,
  TaskRecord,
} from '@/domain/types';

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
  /** In configuration order; that order decides the comparison-table row order. */
  models: readonly ModelRecord[];
  repositories: readonly RepositoryRecord[];
  assessments: readonly AssessmentArtifact[];
  gradings: readonly GradingArtifact[];
};

/** One distinct grader identity across a run's gradings, with its shared model entries. */
type GraderSummary = { grader: GraderIdentity; sharedModelEntryIds: string[] };

/** Attempt counts of one task/model pair, derived while building the report. */
type PairSummary = {
  taskId: string;
  modelId: string;
  /** Every planned attempt of this pair, `manifest.execution.repeat.value`. */
  planned: number;
  outcomes: Record<CaseResult['outcome'], number>;
  passedOfPlanned: string;
  /** Holds exactly when `outcomes.passed === planned`. */
  allPassed: boolean;
};

/** Deterministic report model; identical source artifacts produce an identical model. */
export type NormalizedRunModel = {
  schemaVersion: 1;
  manifest: RunManifest;
  exitCode: RunResult['exitCode'];
  findings: RunFinding[];
  capabilities: Readonly<Record<string, AgentCapabilityReport>>;
  repositories: RepositoryRecord[];
  models: ModelRecord[];
  tasks: TaskRecord[];
  cases: CaseResult[];
  assessments: AssessmentArtifact[];
  gradings: GradingArtifact[];
  graders: GraderSummary[];
  pairs: PairSummary[];
};

/**
 * Compares two case IDs in case order, reading the identity each ID names from `identities`.
 *
 * Both IDs name an identity: the case order (task, then model, then numeric
 * attempt) of the two identities decides. Only one names an identity: the
 * other sorts first. Neither names one (`null`, or absent from `identities`):
 * `compareStrings(a ?? "", b ?? "")` decides, which keeps run-level findings
 * (`null` case ID) first.
 */
export function compareCaseIds(
  identities: ReadonlyMap<string, CaseIdentity>,
  a: string | null,
  b: string | null,
): number {
  const identityA = a === null ? undefined : identities.get(a);
  const identityB = b === null ? undefined : identities.get(b);
  if (identityA !== undefined && identityB !== undefined) {
    return compareCaseIdentities(identityA, identityB);
  }
  if (identityA !== undefined) {
    return 1;
  }
  if (identityB !== undefined) {
    return -1;
  }
  return compareStrings(a ?? '', b ?? '');
}

/** Case order: task ID, then model ID (both `compareStrings`), then attempt numerically. */
function compareCaseIdentities(a: CaseIdentity, b: CaseIdentity): number {
  return (
    compareStrings(a.taskId, b.taskId) ||
    compareStrings(a.modelId, b.modelId) ||
    a.attempt - b.attempt
  );
}

/** Builds the sorted, sensitive-content-free report model from preserved records. */
export function buildNormalizedRun(input: ReportInput): NormalizedRunModel {
  const identities = new Map(
    input.run.manifest.cases.map((identity) => [identity.caseId, identity]),
  );
  return {
    schemaVersion: 1,
    manifest: input.run.manifest,
    exitCode: input.run.exitCode,
    findings: [...input.run.findings].sort(
      (a, b) =>
        compareCaseIds(identities, a.caseId, b.caseId) || compareStrings(a.message, b.message),
    ),
    capabilities: input.capabilities,
    repositories: sortById(input.repositories),
    models: sortById(input.models),
    tasks: sortById(input.tasks).map((task) => ({
      ...task,
      checks: [...task.checks].sort((a, b) => compareStrings(a.id, b.id)),
    })),
    cases: [...input.run.cases]
      .sort((a, b) => compareCaseIdentities(a.identity, b.identity))
      .map((caseResult) => ({
        ...caseResult,
        checks: [...caseResult.checks].sort((a, b) => compareStrings(a.checkId, b.checkId)),
      })),
    assessments: [...input.assessments]
      .sort((a, b) => compareCaseIds(identities, a.caseId, b.caseId))
      .map((artifact) => ({
        ...artifact,
        current: [...artifact.current].sort((a, b) => compareStrings(a.checkId, b.checkId)),
        history: [...artifact.history].sort(
          (a, b) =>
            compareStrings(a.checkId, b.checkId) ||
            compareStrings(a.replacedAt, b.replacedAt) ||
            compareStrings(a.source, b.source),
        ),
      })),
    gradings: [...input.gradings]
      .sort((a, b) => compareCaseIds(identities, a.caseId, b.caseId))
      .map((grading) => ({
        ...grading,
        grades: [...grading.grades].sort((a, b) => compareStrings(a.checkId, b.checkId)),
      })),
    graders: buildGraderSummaries(input.gradings, input.models),
    pairs: buildPairSummaries(input.run.manifest.cases, input.run.cases),
  };
}

/**
 * Distinct `grader` identities across `gradings`, sorted by model, effort,
 * then agent, each paired with the sorted IDs of `models` entries whose
 * `model` equals the grader's `model` exactly (informational only).
 */
function buildGraderSummaries(
  gradings: readonly GradingArtifact[],
  models: readonly ModelRecord[],
): GraderSummary[] {
  const seen = new Map<string, GraderIdentity>();
  for (const grading of gradings) {
    const key = `${grading.grader.model}\u0000${grading.grader.effort}\u0000${grading.grader.agent}`;
    if (!seen.has(key)) {
      seen.set(key, grading.grader);
    }
  }
  return [...seen.values()]
    .sort(
      (a, b) =>
        compareStrings(a.model, b.model) ||
        compareStrings(a.effort, b.effort) ||
        compareStrings(a.agent, b.agent),
    )
    .map((grader) => ({
      grader,
      sharedModelEntryIds: models
        .filter((model) => model.model === grader.model)
        .map((model) => model.id)
        .sort(compareStrings),
    }));
}

/**
 * Computes one {@link PairSummary} per distinct `(taskId, modelId)` of
 * `manifestCases`, sorted by task ID then model ID with `compareStrings`. A
 * planned attempt without a matching case result counts as `not-evaluated`,
 * so the four outcome counts always sum to `planned`.
 */
function buildPairSummaries(
  manifestCases: readonly CaseIdentity[],
  caseResults: readonly CaseResult[],
): PairSummary[] {
  const pairKey = (taskId: string, modelId: string): string => `${taskId}\u0000${modelId}`;

  const planned = new Map<string, { taskId: string; modelId: string; count: number }>();
  for (const identity of manifestCases) {
    const key = pairKey(identity.taskId, identity.modelId);
    const entry = planned.get(key);
    if (entry === undefined) {
      planned.set(key, { taskId: identity.taskId, modelId: identity.modelId, count: 1 });
    } else {
      entry.count += 1;
    }
  }

  const results = new Map<string, CaseResult[]>();
  for (const caseResult of caseResults) {
    const key = pairKey(caseResult.identity.taskId, caseResult.identity.modelId);
    const entries = results.get(key);
    if (entries === undefined) {
      results.set(key, [caseResult]);
    } else {
      entries.push(caseResult);
    }
  }

  return [...planned.values()]
    .sort((a, b) => compareStrings(a.taskId, b.taskId) || compareStrings(a.modelId, b.modelId))
    .map(({ taskId, modelId, count }) => {
      const outcomes: PairSummary['outcomes'] = {
        passed: 0,
        failed: 0,
        pending: 0,
        'not-evaluated': 0,
      };
      const pairResults = results.get(pairKey(taskId, modelId)) ?? [];
      for (const caseResult of pairResults) {
        outcomes[caseResult.outcome] += 1;
      }
      outcomes['not-evaluated'] += count - pairResults.length;
      return {
        taskId,
        modelId,
        planned: count,
        outcomes,
        passedOfPlanned: `${outcomes.passed}/${count}`,
        allPassed: outcomes.passed === count,
      };
    });
}

/** Serializes the report model as deterministic JSON with recursively sorted object keys. */
export function serializeNormalizedRun(model: NormalizedRunModel): string {
  return `${JSON.stringify(sortKeysDeep(model), null, 2)}\n`;
}

/** Renders the fixed sensitive-data and non-adversarial isolation notice. */
function renderSensitiveDataNotice(): string {
  return [
    '> **Sensitive data:** the tevu configuration file and this artifact directory can contain',
    '> sensitive private repository, task, Jira, model-output, and evaluator data. They rely on',
    '> host filesystem access controls.',
    '>',
    '> **Isolation boundary:** context isolation is non-adversarial. It withholds sibling runs,',
    '> later Git history, host agent state, and benchmark artifacts from normal discovery.',
    '> It does not claim that a model with shell access cannot probe arbitrary host paths.',
  ].join('\n');
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
    markdown: renderMarkdownReport(
      model,
      input.models.map((entry) => entry.id),
    ),
  };
}

/**
 * Renders the Markdown report from an already-sorted report model.
 * `configurationModelIds` is the configuration order of the model entries,
 * which the comparison tables use as their row order.
 */
function renderMarkdownReport(
  model: NormalizedRunModel,
  configurationModelIds: readonly string[],
): string {
  const lines: string[] = [];
  const manifest = model.manifest;
  const tools = manifest.tools;

  lines.push(
    `# tevu run ${manifest.runId}`,
    '',
    ...renderComparisonBlocks(model, configurationModelIds),
    renderSensitiveDataNotice(),
    '',
  );

  lines.push(
    '## Run',
    '',
    `- Configuration digest: \`${manifest.configDigest}\``,
    `- Started: ${manifest.startedAt}`,
    `- Completed: ${manifest.completedAt ?? 'not completed'}`,
    `- Host: ${manifest.host.platform}, Node.js ${manifest.host.nodeVersion}, Git ${tools.gitVersion}`,
    ...renderAgentCapabilityLines(tools.agentVersions, model.capabilities),
    `- Concurrency: ${manifest.execution.concurrency}`,
    `- Case timeout: ${manifest.execution.caseTimeoutMs}ms`,
    ...renderTaskCaseTimeoutLine(manifest.cases, manifest.execution.caseTimeoutMs),
    `- Repeat: ${manifest.execution.repeat.value} (source: ${manifest.execution.repeat.source})`,
    ...renderModelEffortLines(model.models, manifest.efforts),
    ...renderGraderLines(model.graders, manifest.efforts.grader),
    `- Run exit code: ${model.exitCode}`,
    '',
  );

  if (model.findings.length > 0) {
    lines.push('## Run findings', '');
    for (const finding of model.findings) {
      lines.push(
        `- ${finding.severity}${finding.caseId ? ` (case ${finding.caseId})` : ''}: ${finding.message}`,
      );
    }
    lines.push('');
  }

  const tasksById = new Map(model.tasks.map((task) => [task.id, task]));
  const repositoriesById = new Map(
    model.repositories.map((repository) => [repository.id, repository]),
  );
  const assessmentsByCase = new Map(
    model.assessments.map((artifact) => [artifact.caseId, artifact]),
  );
  const gradingsByCase = new Map(model.gradings.map((grading) => [grading.caseId, grading]));

  const taskIds = [...new Set(model.pairs.map((pair) => pair.taskId))].sort(compareStrings);

  for (const taskId of taskIds) {
    const task = tasksById.get(taskId);
    const taskCases = model.cases.filter((caseResult) => caseResult.identity.taskId === taskId);
    const taskPairs = model.pairs.filter((pair) => pair.taskId === taskId);

    lines.push(`## Task ${taskId}`, '');
    if (task !== undefined) {
      const repository = repositoriesById.get(task.repositoryId);
      lines.push(
        task.description,
        '',
        `- Repository: ${task.repositoryId}${repository ? ` (\`${repository.path}\`)` : ''}`,
        `- Source commit: \`${task.startCommit}\``,
        `- Source: ${describeTaskSource(task.source)}`,
        '',
      );
    }

    lines.push(...renderPairSummary(taskPairs));

    if (taskCases.length > 0) {
      lines.push(
        '| Outcome | Model entry | Attempt | Model | Effort | Lifecycle | Runtime failure | Elapsed |',
        '|---|---|---|---|---|---|---|---|',
      );
      for (const caseResult of taskCases) {
        const identity = caseResult.identity;
        lines.push(
          `| ${caseResult.outcome} | ${cell(identity.modelId)} | ${identity.attempt} | ${cell(identity.model)} | ${cell(effortLabel(identity.effort, effortCheckOf(manifest.efforts, identity.modelId)))} | ${caseResult.lifecycle} | ${caseResult.failure ? cell(caseResult.failure.error.kind) : 'none'} | ${cell(formatMetricValue(caseResult.metrics.elapsed))} |`,
        );
      }
      lines.push('');

      for (const caseResult of taskCases) {
        renderCase(
          lines,
          caseResult,
          task,
          assessmentsByCase.get(caseResult.identity.caseId),
          gradingsByCase.get(caseResult.identity.caseId),
          manifest.efforts,
        );
      }
    }
  }

  lines.push(
    '---',
    '',
    'Task outcome, runtime failure, and run exit status are reported independently.',
    'Command check output is configured acceptance evidence, not an additional model-quality metric.',
    'No composite score or winner is computed.',
    '',
  );

  return lines.join('\n');
}

const COMPARISON_HEADER_ROW =
  '| Model | Effort | Outcome | Checks | Elapsed | Cost | Turns | Tool calls | Input | Cache read | Cache write | Output | Reasoning | API errors | Runtime failure |';
const COMPARISON_SEPARATOR_ROW = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';

const NO_CASE_RESULT_REASON = 'no case result was saved';

const OUTCOME_ORDER: readonly CaseResult['outcome'][] = [
  'passed',
  'failed',
  'pending',
  'not-evaluated',
];

type MeasurementColumn = {
  metric: keyof BenchmarkMetrics;
  format: (value: number) => string;
};

/** Measurement columns of a comparison row, in column order. */
const ROW_MEASUREMENT_COLUMNS: readonly MeasurementColumn[] = [
  { metric: 'elapsed', format: formatElapsed },
  { metric: 'cost', format: formatCost },
  { metric: 'turns', format: formatCount },
  { metric: 'toolCalls', format: formatCount },
  { metric: 'inputTokens', format: formatCount },
  { metric: 'cacheReadTokens', format: formatCount },
  { metric: 'cacheWriteTokens', format: formatCount },
  { metric: 'outputTokens', format: formatCount },
  { metric: 'reasoningTokens', format: formatCount },
  { metric: 'apiErrors', format: formatCount },
];

/** Values of the grader line, in line order. */
const GRADER_TOTALS: readonly {
  label: string;
  metric: keyof AgentMetrics;
  format: MeasurementColumn['format'];
}[] = [
  { label: 'input', metric: 'inputTokens', format: formatCount },
  { label: 'cache read', metric: 'cacheReadTokens', format: formatCount },
  { label: 'cache write', metric: 'cacheWriteTokens', format: formatCount },
  { label: 'output', metric: 'outputTokens', format: formatCount },
  { label: 'reasoning', metric: 'reasoningTokens', format: formatCount },
  { label: 'cost', metric: 'cost', format: formatCost },
];

/** One attempt of a pair with its case result, absent when none was saved. */
type Attempt = { identity: CaseIdentity; result: CaseResult | undefined };

/**
 * Renders the lines of every comparison block, in task order. Each block ends
 * with one empty line, so the lines that follow never continue its table.
 */
function renderComparisonBlocks(
  model: NormalizedRunModel,
  configurationModelIds: readonly string[],
): string[] {
  const lines: string[] = [];
  const taskIds = [...new Set(model.pairs.map((pair) => pair.taskId))].sort(compareStrings);

  for (const taskId of taskIds) {
    const footnotes = createFootnoteRegistry();
    const pairs = orderPairsForRows(
      model.pairs.filter((pair) => pair.taskId === taskId),
      configurationModelIds,
    );
    const collidingModelIds = findCollidingModelIds(model, pairs);

    lines.push(
      `## Comparison: ${taskId}`,
      '',
      COMPARISON_HEADER_ROW,
      COMPARISON_SEPARATOR_ROW,
      ...pairs.flatMap((pair) => renderComparisonRow(pair, model, footnotes, collidingModelIds)),
      '',
    );

    const gradings = gradingsOfTask(model, taskId);
    if (gradings.length > 0) {
      lines.push(renderGraderLine(gradings, footnotes), '');
    }

    const footnoteLines = footnotes.lines();
    if (footnoteLines.length > 0) {
      lines.push(...footnoteLines, '');
    }
  }
  return lines;
}

/**
 * Renders the row of one pair, building cells left to right so footnote
 * numbers follow use order. A pair without a planned attempt renders no row.
 */
function renderComparisonRow(
  pair: PairSummary,
  model: NormalizedRunModel,
  footnotes: FootnoteRegistry,
  collidingModelIds: ReadonlySet<string>,
): string[] {
  const attempts = attemptsOfPair(model, pair);
  const [lowest] = attempts;
  if (lowest === undefined) {
    return [];
  }
  const task = model.tasks.find((candidate) => candidate.id === pair.taskId);
  const cells = [
    renderModelCell(lowest.identity, pair, attempts, collidingModelIds.has(pair.modelId)),
    renderEffortCell(lowest.identity, pair, model.manifest.efforts),
    renderOutcomeCell(pair),
    renderChecksCell(attempts, task),
    ...ROW_MEASUREMENT_COLUMNS.map(({ metric, format }) =>
      renderMeasurementCell(
        attempts.map((attempt) =>
          measurementItemOf(String(attempt.identity.attempt), attempt.result?.metrics[metric]),
        ),
        lowerMedian,
        format,
        'attempt',
        footnotes,
      ),
    ),
    renderRuntimeFailureCell(attempts, footnotes),
  ];
  return [`| ${cells.join(' | ')} |`];
}

/**
 * Resolves the attempts of `pair` in ascending attempt order, each with the
 * case result that has the same task, model entry, and attempt.
 */
function attemptsOfPair(model: NormalizedRunModel, pair: PairSummary): Attempt[] {
  return model.manifest.cases
    .filter((identity) => identity.taskId === pair.taskId && identity.modelId === pair.modelId)
    .sort((a, b) => a.attempt - b.attempt)
    .map((identity) => ({
      identity,
      result: model.cases.find(
        (candidate) =>
          candidate.identity.taskId === identity.taskId &&
          candidate.identity.modelId === identity.modelId &&
          candidate.identity.attempt === identity.attempt,
      ),
    }));
}

/**
 * Orders pairs by the position of their model entry in the configuration.
 * Pairs whose model entry is not configured follow, in input order. No
 * outcome, check, or metric takes part, so the order is never a ranking.
 */
function orderPairsForRows(
  pairs: readonly PairSummary[],
  configurationModelIds: readonly string[],
): PairSummary[] {
  const rankOf = (pair: PairSummary): number => {
    const index = configurationModelIds.indexOf(pair.modelId);
    return index === -1 ? configurationModelIds.length : index;
  };
  return [...pairs].sort((a, b) => rankOf(a) - rankOf(b));
}

/** Model entry IDs whose lowest attempt shares model and raw effort with another pair's. */
function findCollidingModelIds(
  model: NormalizedRunModel,
  pairs: readonly PairSummary[],
): Set<string> {
  const keyed = pairs.flatMap((pair) => {
    const identity = attemptsOfPair(model, pair)[0]?.identity;
    return identity === undefined
      ? []
      : [{ modelId: pair.modelId, key: `${identity.model}\u0000${identity.effort}` }];
  });
  const counts = new Map<string, number>();
  for (const { key } of keyed) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(
    keyed.filter(({ key }) => (counts.get(key) ?? 0) > 1).map((entry) => entry.modelId),
  );
}

function caseResultsOf(attempts: readonly Attempt[]): CaseResult[] {
  return attempts.flatMap((attempt) => (attempt.result === undefined ? [] : [attempt.result]));
}

function renderModelCell(
  identity: CaseIdentity,
  pair: PairSummary,
  attempts: readonly Attempt[],
  showsEntryId: boolean,
): string {
  const text = showsEntryId ? `${identity.model} (${pair.modelId})` : identity.model;
  const linked = caseResultsOf(attempts)[0];
  return linked === undefined
    ? cell(text)
    : `[${cell(escapeLinkText(text))}](#case-${linked.identity.caseId})`;
}

/** A model identifier may hold unbalanced brackets, which would end or reshape the link text. */
function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, '\\$&');
}

function renderEffortCell(
  identity: CaseIdentity,
  pair: PairSummary,
  efforts: RunManifest['efforts'],
): string {
  return cell(effortLabel(identity.effort, effortCheckOf(efforts, pair.modelId)));
}

function renderOutcomeCell(pair: PairSummary): string {
  const present = OUTCOME_ORDER.filter((outcome) => pair.outcomes[outcome] > 0);
  if (pair.planned === 1) {
    return present.join(', ');
  }
  return present
    .map(
      (outcome) => `${formatCount(pair.outcomes[outcome])}/${formatCount(pair.planned)} ${outcome}`,
    )
    .join(', ');
}

/** Counts passed required checks across attempts against the required checks of all attempts. */
function renderChecksCell(attempts: readonly Attempt[], task: TaskRecord | undefined): string {
  const requiredIds = (task?.checks ?? [])
    .filter((check) => check.required)
    .map((check) => check.id);
  const passed = caseResultsOf(attempts).reduce(
    (total, result) =>
      total +
      requiredIds.filter((id) =>
        result.checks.some((check) => check.checkId === id && check.verdict === 'passed'),
      ).length,
    0,
  );
  return `${formatCount(passed)}/${formatCount(requiredIds.length * attempts.length)}`;
}

function renderRuntimeFailureCell(
  attempts: readonly Attempt[],
  footnotes: FootnoteRegistry,
): string {
  const lacking = attempts
    .filter((attempt) => attempt.result === undefined)
    .map((attempt) => ({ label: String(attempt.identity.attempt), reason: NO_CASE_RESULT_REASON }));
  const marker =
    lacking.length === 0
      ? ''
      : renderFootnoteMarker(
          footnotes.numberFor(describeLackingItems(lacking, attempts.length, 'attempt')),
        );
  const results = caseResultsOf(attempts);
  if (results.length === 0) {
    return `- ${marker}`;
  }

  const countsByKind = new Map<string, number>();
  for (const result of results) {
    if (result.failure !== null) {
      const kind = result.failure.error.kind;
      countsByKind.set(kind, (countsByKind.get(kind) ?? 0) + 1);
    }
  }
  const kinds = [...countsByKind].sort(([a], [b]) => compareStrings(a, b));
  let text = 'none';
  if (kinds.length > 0) {
    text = kinds
      .map(([kind, count]) =>
        attempts.length === 1
          ? cell(kind)
          : `${formatCount(count)}/${formatCount(attempts.length)} ${cell(kind)}`,
      )
      .join(', ');
  }
  return lacking.length === 0 ? text : `${text} ${marker}`;
}

type MeasurementItem =
  | { kind: 'reported'; label: string; value: number }
  | { kind: 'lacking'; label: string; reason: string };

/** Classifies one item's metric as reported or lacking; `undefined` means no case result. */
function measurementItemOf(label: string, metric: MetricValue | undefined): MeasurementItem {
  if (metric === undefined) {
    return { kind: 'lacking', label, reason: NO_CASE_RESULT_REASON };
  }
  if (metric.availability.status === 'unavailable') {
    return { kind: 'lacking', label, reason: metric.availability.reason };
  }
  if (metric.value === null) {
    return { kind: 'lacking', label, reason: 'no value recorded' };
  }
  return { kind: 'reported', label, value: metric.value };
}

/** The value at zero-based index floor((k - 1) / 2) of the ascending sort. */
function lowerMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Renders one measurement cell: the aggregate when every item reports, the
 * aggregate with a `(k/n)` count and footnote marker when some do, and a dash
 * with a footnote marker when none do. An unavailable value never renders as a number.
 */
function renderMeasurementCell(
  items: readonly MeasurementItem[],
  aggregate: (values: number[]) => number,
  format: (value: number) => string,
  noun: 'attempt' | 'case',
  footnotes: FootnoteRegistry,
): string {
  const reported: number[] = [];
  const lacking: { label: string; reason: string }[] = [];
  for (const item of items) {
    if (item.kind === 'reported') {
      reported.push(item.value);
    } else {
      lacking.push({ label: item.label, reason: item.reason });
    }
  }
  if (lacking.length === 0) {
    return format(aggregate(reported));
  }
  const marker = renderFootnoteMarker(
    footnotes.numberFor(describeLackingItems(lacking, items.length, noun)),
  );
  if (reported.length === 0) {
    return `- ${marker}`;
  }
  return `${format(aggregate(reported))} (${formatCount(reported.length)}/${formatCount(items.length)}) ${marker}`;
}

/**
 * Describes why items lack a value: the bare reason for a single item, and
 * otherwise the items grouped by identical reason in order of first appearance.
 */
function describeLackingItems(
  lacking: readonly { label: string; reason: string }[],
  total: number,
  noun: 'attempt' | 'case',
): string {
  const labelsByReason = new Map<string, string[]>();
  for (const { label, reason } of lacking) {
    const labels = labelsByReason.get(reason);
    if (labels === undefined) {
      labelsByReason.set(reason, [label]);
    } else {
      labels.push(label);
    }
  }
  return [...labelsByReason]
    .map(([reason, labels]) =>
      total === 1
        ? reason
        : `${noun}${labels.length === 1 ? '' : 's'} ${labels.join(', ')}: ${reason}`,
    )
    .join('; ');
}

/** The gradings that the case sections of `taskId` render, in `model.gradings` order. */
function gradingsOfTask(model: NormalizedRunModel, taskId: string): GradingArtifact[] {
  const caseIds = new Set(
    model.cases
      .filter((caseResult) => caseResult.identity.taskId === taskId)
      .map((caseResult) => caseResult.identity.caseId),
  );
  return model.gradings.filter((grading) => caseIds.has(grading.caseId));
}

/** Renders the grader's summed usage and cost, read from grading metrics only. */
function renderGraderLine(
  gradings: readonly GradingArtifact[],
  footnotes: FootnoteRegistry,
): string {
  const totals = GRADER_TOTALS.map(({ label, metric, format }) => {
    const items = gradings.map((grading) =>
      measurementItemOf(grading.caseId, grading.metrics[metric]),
    );
    return `${label} ${renderMeasurementCell(items, sum, format, 'case', footnotes)}`;
  });
  const count =
    gradings.length === 1 ? '1 graded case' : `${formatCount(gradings.length)} graded cases`;
  return `Grader total for this task, not added to any row: ${count}, ${totals.join(', ')}.`;
}

/** Numbers footnote texts by first use; an identical text reuses its number. */
type FootnoteRegistry = {
  numberFor(text: string): number;
  /** One `<n>. <text>` line per footnote in ascending number. */
  lines(): string[];
};

function createFootnoteRegistry(): FootnoteRegistry {
  const numbers = new Map<string, number>();
  return {
    numberFor(text) {
      const existing = numbers.get(text);
      if (existing !== undefined) {
        return existing;
      }
      const next = numbers.size + 1;
      numbers.set(text, next);
      return next;
    },
    lines() {
      return [...numbers].map(([text, number]) => `${number}. ${cell(text)}`);
    },
  };
}

/** Brackets are escaped so a link reference definition in a task description cannot turn a marker into a link. */
function renderFootnoteMarker(number: number): string {
  return `\\[${number}\\]`;
}

// Digit grouping is manual because locale-aware formatting would make regenerated reports differ between hosts.
function formatCount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    return String(value);
  }
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatElapsed(milliseconds: number): string {
  const seconds = (milliseconds / 1000).toFixed(1);
  return Number(seconds) < 60 ? `${seconds} s` : `${(milliseconds / 60000).toFixed(1)} min`;
}

/** Renders one version and isolation line per agent in use, in `compareStrings` order. */
function renderAgentCapabilityLines(
  agentVersions: Readonly<Record<string, string | null>>,
  capabilities: NormalizedRunModel['capabilities'],
): string[] {
  const lines: string[] = [];
  for (const name of Object.keys(agentVersions).sort(compareStrings)) {
    lines.push(
      `- Agent "${name}" version (detected provenance only): ${agentVersions[name] ?? 'not detected'}`,
    );
    lines.push(
      `- Agent "${name}" isolation control (deny outside worktree): ${capabilities[name]?.isolation.denyOutsideWorktree ?? 'not probed'}`,
    );
  }
  return lines;
}

/** The check recorded for model entry `modelId`; `undefined` when the run recorded none. */
function effortCheckOf(efforts: RunManifest['efforts'], modelId: string): EffortCheck | undefined {
  return Object.hasOwn(efforts.models, modelId) ? efforts.models[modelId] : undefined;
}

/** Renders `: <reason>` for a check that carries one, otherwise nothing. */
function renderEffortReason(check: EffortCheck | null | undefined): string {
  return check === null || check === undefined || check.status === 'verified'
    ? ''
    : `: ${check.reason}`;
}

/** Renders one `- Model entry:` line per model entry with its effort check, in `models` order. */
function renderModelEffortLines(
  models: readonly ModelRecord[],
  efforts: RunManifest['efforts'],
): string[] {
  return models.map((entry) => {
    const check = effortCheckOf(efforts, entry.id);
    return `- Model entry ${entry.id}: ${entry.model}, effort ${entry.effort}, ${check?.status ?? 'not checked'}${renderEffortReason(check)}`;
  });
}

/** Renders one `- Grader:` line, and a shared-model-entry note when one applies, per distinct grader identity. */
function renderGraderLines(graders: readonly GraderSummary[], check: EffortCheck | null): string[] {
  const lines: string[] = [];
  for (const summary of graders) {
    const { grader, sharedModelEntryIds } = summary;
    lines.push(
      `- Grader: ${grader.model} (effort ${effortLabel(grader.effort, check)}, agent ${grader.agent})${renderEffortReason(check)}`,
    );
    if (sharedModelEntryIds.length > 0) {
      lines.push(
        `- Grader model ${grader.model} is also benchmarked as model entry ${sharedModelEntryIds.join(', ')} (informational; tevu does not forbid it)`,
      );
    }
  }
  return lines;
}

/**
 * Renders the "Tasks with their own case timeout" line, listing every
 * distinct `(taskId, timeoutMs)` pair whose `timeoutMs` differs from the
 * default, sorted by task ID then by `timeoutMs` ascending. Returns no line
 * when every case ran under the default, so regenerating from unchanged
 * artifacts stays independent of `manifest.cases`'s iteration order.
 */
function renderTaskCaseTimeoutLine(
  cases: readonly CaseIdentity[],
  defaultCaseTimeoutMs: number,
): string[] {
  const entries = new Map<string, { taskId: string; timeoutMs: number }>();
  for (const identity of cases) {
    if (identity.timeoutMs !== defaultCaseTimeoutMs) {
      entries.set(`${identity.taskId}\u0000${identity.timeoutMs}`, {
        taskId: identity.taskId,
        timeoutMs: identity.timeoutMs,
      });
    }
  }
  if (entries.size === 0) {
    return [];
  }
  const sorted = [...entries.values()].sort(
    (a, b) => compareStrings(a.taskId, b.taskId) || a.timeoutMs - b.timeoutMs,
  );
  const rendered = sorted.map((entry) => `${entry.taskId} ${entry.timeoutMs}ms`).join(', ');
  return [`- Tasks with their own case timeout: ${rendered}`];
}

/** Renders the `Pair summary:` block for one task's pairs, in `pairs` order. */
function renderPairSummary(pairs: readonly PairSummary[]): string[] {
  const lines: string[] = ['Pair summary:', ''];
  lines.push(
    '| Model entry | Planned | passed | failed | pending | not-evaluated | Passed of planned | All passed |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const pair of pairs) {
    const outcomes = pair.outcomes;
    lines.push(
      `| ${cell(pair.modelId)} | ${pair.planned} | ${outcomes.passed} | ${outcomes.failed} | ${outcomes.pending} | ${outcomes['not-evaluated']} | ${pair.passedOfPlanned} | ${pair.allPassed ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
  return lines;
}

function renderCase(
  lines: string[],
  caseResult: CaseResult,
  task: TaskRecord | undefined,
  assessment: AssessmentArtifact | undefined,
  grading: GradingArtifact | undefined,
  efforts: RunManifest['efforts'],
): void {
  const identity = caseResult.identity;
  const definitions = new Map((task?.checks ?? []).map((check) => [check.id, check]));

  lines.push(
    `### Case ${identity.caseId}`,
    '',
    `- Model entry: ${identity.modelId} (${identity.model}, effort ${effortLabel(identity.effort, effortCheckOf(efforts, identity.modelId))})`,
    `- Lifecycle: ${caseResult.lifecycle}`,
    `- Task outcome: ${caseResult.outcome}`,
  );

  if (caseResult.process !== null) {
    const process = caseResult.process;
    const ending =
      process.exitCode !== null
        ? `exit code ${process.exitCode}`
        : `signal ${process.signal ?? 'unknown'}`;
    lines.push(
      `- Process: ${ending}, ${process.durationMs}ms, termination stage ${process.terminationStage}`,
    );
  } else {
    lines.push('- Process: not started');
  }

  if (caseResult.failure !== null) {
    lines.push(
      `- Runtime failure (preserved independently of the task outcome): ${caseResult.failure.error.kind} at ${caseResult.failure.occurredAt}`,
    );
  }
  lines.push('');

  if (caseResult.checks.length > 0) {
    lines.push(
      '| Verdict | Check | Category | Required | Evaluator | Duration | Evidence |',
      '|---|---|---|---|---|---|---|',
    );
    for (const check of caseResult.checks) {
      const definition = definitions.get(check.checkId);
      lines.push(
        `| ${check.verdict} | ${cell(check.checkId)} | ${check.category} | ${definition ? String(definition.required) : 'unknown'} | ${definition?.evaluator ?? 'unknown'} | ${check.durationMs === null ? '-' : `${check.durationMs}ms`} | ${evidenceLink(caseResult)} |`,
      );
    }
    lines.push('');
    const pendingChecks = caseResult.checks.filter((check) => check.verdict === 'pending');
    const pendingManualIds = pendingChecks
      .filter((check) => definitions.get(check.checkId)?.evaluator === 'manual')
      .map((check) => check.checkId);
    const pendingGradedIds = pendingChecks
      .filter((check) => definitions.get(check.checkId)?.evaluator === 'grader')
      .map((check) => check.checkId);
    if (pendingManualIds.length > 0) {
      lines.push(`Pending manual checks: ${pendingManualIds.join(', ')}.`);
    }
    if (pendingGradedIds.length > 0) {
      lines.push(`Pending graded checks: ${pendingGradedIds.join(', ')}.`);
    }
    if (pendingManualIds.length > 0 || pendingGradedIds.length > 0) {
      lines.push('');
    }
  }

  lines.push('Metrics:', '');
  for (const [name, metric] of sortedMetricEntries(caseResult)) {
    lines.push(`- ${name}: ${formatMetricValue(metric)}`);
  }
  lines.push('');

  if (grading !== undefined) {
    lines.push(...renderGradingBlock(grading, efforts.grader));
  }

  lines.push('Artifacts:', '');
  const artifacts = caseResult.artifacts;
  lines.push(
    `- Solution patch: ${artifactLink(artifacts.solutionPatch)}`,
    `- Events: ${artifactLink(artifacts.events)}`,
    `- Diagnostics: ${artifactLink(artifacts.diagnostics)}`,
    `- Session export: ${artifactLink(artifacts.sessionExport)}`,
    `- Check evidence: ${artifactLink(artifacts.checks)}`,
    ...(artifacts.grading === null ? [] : [`- Grading: ${artifactLink(artifacts.grading)}`]),
    `- Result: ${artifactLink(artifacts.result)}`,
    '',
  );

  if (assessment !== undefined && assessment.current.length > 0) {
    lines.push(`Assessments (revision ${assessment.revision}):`, '');
    for (const record of assessment.current) {
      lines.push(
        `- ${record.checkId}: ${record.verdict} by ${cell(record.assessor)} at ${record.assessedAt}${record.note.length > 0 ? ` — ${cell(record.note)}` : ''}`,
      );
    }
    lines.push('');
  }
}

function sortedMetricEntries(caseResult: CaseResult): Array<[string, MetricValue]> {
  return (Object.entries(caseResult.metrics) as Array<[string, MetricValue]>).sort((a, b) =>
    compareStrings(a[0], b[0]),
  );
}

/**
 * Renders one case's grading: the grader identity, a grade or reason per
 * check in `checkId` order, and the grader's own metrics, kept in a block
 * separate from the case's agent metrics above it and never added to them.
 */
function renderGradingBlock(grading: GradingArtifact, check: EffortCheck | null): string[] {
  const lines: string[] = [
    `Grades by ${grading.grader.model} (effort ${effortLabel(grading.grader.effort, check)}, agent ${grading.grader.agent}):`,
    '',
  ];
  if (grading.call.status === 'no-reply') {
    lines.push(`- Grader call: no reply. ${cell(grading.call.reason)}`);
  }
  for (const grade of grading.grades) {
    lines.push(
      grade.status === 'graded'
        ? `- ${cell(grade.checkId)}: ${grade.verdict}. ${cell(grade.rationale)}`
        : `- ${cell(grade.checkId)}: not graded. ${cell(grade.reason)}`,
    );
  }
  lines.push(
    '',
    'Grader metrics (separate from the agent metrics above; never added to them):',
    '',
  );
  for (const [name, metric] of sortedAgentMetricEntries(grading.metrics)) {
    lines.push(`- ${name}: ${formatMetricValue(metric)}`);
  }
  lines.push('');
  return lines;
}

function sortedAgentMetricEntries(metrics: AgentMetrics): Array<[string, MetricValue]> {
  return (Object.entries(metrics) as Array<[string, MetricValue]>).sort((a, b) =>
    compareStrings(a[0], b[0]),
  );
}

function formatMetricValue(metric: MetricValue): string {
  if (metric.availability.status === 'unavailable') {
    return `unavailable: ${metric.availability.reason}`;
  }
  if (metric.value === null) {
    return 'unavailable: no value recorded';
  }
  return `${metric.value} ${metric.unit} (${metric.scope}, source: ${metric.availability.source})`;
}

function describeTaskSource(source: TaskRecord['source']): string {
  switch (source.kind) {
    case 'manual':
      return `manual — ${source.title}${source.reference ? ` (${source.reference})` : ''}`;
    case 'jira-cloud':
      return `Jira snapshot — [${source.issueKey}](${source.issueUrl})`;
    case 'github-issue':
      return `GitHub issue snapshot — [${source.issueKey}](${source.issueUrl})`;
  }
}

function evidenceLink(caseResult: CaseResult): string {
  return artifactLink(caseResult.artifacts.checks);
}

function artifactLink(path: string | null): string {
  return path === null ? 'missing' : `[${cell(path)}](${path})`;
}

/** Escapes table-breaking characters in one Markdown table cell or inline value. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
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
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeysDeep(record[key])]),
    );
  }
  return value;
}
