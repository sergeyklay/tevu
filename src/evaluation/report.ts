import { effortLabel } from '@/domain/types';

import {
  buildReaderNames,
  countRequiredChecks,
  describeAttempt,
  effortStatement,
  failureLabel,
  formatCost,
  formatCount,
  formatElapsed,
  formatRequiredChecks,
  gradingGapStatement,
  measurementGapStatement,
  renderStatement,
} from './wording';

import type { AttemptFacts, AttemptStatements, ReaderNames, Statement } from './wording';
import type {
  AgentCapabilityReport,
  AgentMetrics,
  AssessmentArtifact,
  BenchmarkMetrics,
  CaseIdentity,
  CaseResult,
  CheckRecord,
  EffortCheck,
  GraderIdentity,
  GradingArtifact,
  GradingSummary,
  MetricValue,
  ModelRecord,
  ReportResult,
  ReportSummary,
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
  /** In configuration order; that order decides the names of checks and of tasks that share a title. */
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
  gradings: GradingSummary[];
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
        calls: grading.calls.map(({ outcome, metrics }) => ({ outcome, metrics })),
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

/** One planned attempt with the facts and statements every surface of the report shares. */
type Attempt = AttemptFacts & { statements: AttemptStatements };

/** Everything the renderers read, resolved once so every surface describes an attempt identically. */
type ReportContext = {
  model: NormalizedRunModel;
  names: ReaderNames;
  /** The configuration order of the model entries, which the comparison tables use as their row order. */
  configurationModelIds: readonly string[];
  tasksById: ReadonlyMap<string, TaskRecord>;
  /** Every planned attempt, keyed by case ID. */
  attemptsByCaseId: ReadonlyMap<string, Attempt>;
};

/**
 * Builds the normalized JSON, the Markdown report, and the terminal summary
 * for one run. Pure and deterministic: no I/O, no generation timestamps, no
 * composite score, and no winner selection.
 */
export function buildReport(input: ReportInput): ReportResult {
  const model = buildNormalizedRun(input);
  // Names come from the input order: `buildNormalizedRun` sorts tasks and their checks by ID.
  const names = buildReaderNames({
    tasks: input.tasks,
    models: input.models,
    repeat: input.run.manifest.execution.repeat.value,
    cases: input.run.manifest.cases,
  });
  const context = createReportContext(
    model,
    names,
    input.models.map((entry) => entry.id),
  );
  return {
    runId: model.manifest.runId,
    normalizedJson: serializeNormalizedRun(model),
    markdown: renderMarkdownReport(context),
    summary: buildSummary(context),
  };
}

function createReportContext(
  model: NormalizedRunModel,
  names: ReaderNames,
  configurationModelIds: readonly string[],
): ReportContext {
  const tasksById = new Map(model.tasks.map((task) => [task.id, task]));
  const gradingsByCase = new Map(model.gradings.map((grading) => [grading.caseId, grading]));
  const resultsByAttempt = new Map(
    model.cases.map((result) => [attemptKey(result.identity), result]),
  );
  const attempts = model.manifest.cases.map((identity): [string, Attempt] => {
    const facts: AttemptFacts = {
      identity,
      result: resultsByAttempt.get(attemptKey(identity)),
      checks: tasksById.get(identity.taskId)?.checks ?? [],
      grading: gradingsByCase.get(identity.caseId),
      checkName: (checkId) => names.check(identity.taskId, checkId),
    };
    return [
      identity.caseId,
      { ...facts, statements: describeAttempt(facts, model.manifest.runId) },
    ];
  });
  return {
    model,
    names,
    configurationModelIds,
    tasksById,
    attemptsByCaseId: new Map(attempts),
  };
}

function attemptKey(identity: CaseIdentity): string {
  return `${identity.taskId}\u0000${identity.modelId}\u0000${identity.attempt}`;
}

/**
 * Renders the Markdown report from the context. The comparison tables and the
 * task sections both walk tasks in `compareStrings` order of their IDs.
 */
function renderMarkdownReport(context: ReportContext): string {
  const { model, names } = context;
  const lines: string[] = [];
  const manifest = model.manifest;
  const tools = manifest.tools;

  lines.push(
    `# tevu run ${manifest.runId}`,
    '',
    ...renderComparisonBlocks(context),
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
    ...renderTaskCaseTimeoutLine(manifest.cases, manifest.execution.caseTimeoutMs, names),
    `- Repeat: ${manifest.execution.repeat.value} (source: ${manifest.execution.repeat.source})`,
    ...renderModelEffortLines(model.models, manifest.efforts, names),
    ...renderGraderLines(model.graders, manifest.efforts.grader, names),
    `- Run exit code: ${model.exitCode}`,
    '',
  );

  if (model.findings.length > 0) {
    lines.push('## Run findings', '');
    for (const finding of model.findings) {
      lines.push(`- ${renderFinding(finding, context)}`);
    }
    lines.push('');
  }

  const repositoriesById = new Map(
    model.repositories.map((repository) => [repository.id, repository]),
  );
  const assessmentsByCase = new Map(
    model.assessments.map((artifact) => [artifact.caseId, artifact]),
  );

  for (const taskId of sortedTaskIds(model)) {
    const task = context.tasksById.get(taskId);
    const taskCases = model.cases.filter((caseResult) => caseResult.identity.taskId === taskId);
    const taskPairs = model.pairs.filter((pair) => pair.taskId === taskId);

    lines.push(`## Task: ${cell(names.task(taskId))}`, '');
    if (task !== undefined) {
      const repository = repositoriesById.get(task.repositoryId);
      lines.push(
        task.description,
        '',
        `- Repository: \`${repository?.path ?? task.repositoryId}\``,
        `- Source commit: \`${task.startCommit}\``,
        ...describeTaskSource(task.source),
        '',
      );
    }

    lines.push(...renderPairSummary(taskPairs, names));

    if (taskCases.length > 0) {
      lines.push(
        '| Attempt | Outcome | Required checks | Runtime failure | Elapsed |',
        '|---|---|---|---|---|',
      );
      for (const caseResult of taskCases) {
        lines.push(renderCaseRow(caseResult, task, names));
      }
      lines.push('');

      for (const caseResult of taskCases) {
        const attempt = context.attemptsByCaseId.get(caseResult.identity.caseId);
        if (attempt !== undefined) {
          renderCase(
            lines,
            attempt,
            caseResult,
            assessmentsByCase.get(caseResult.identity.caseId),
            context,
          );
        }
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

function sortedTaskIds(model: NormalizedRunModel): string[] {
  return [...new Set(model.pairs.map((pair) => pair.taskId))].sort(compareStrings);
}

/** One line per finding, naming the planned case it belongs to when it names one. */
function renderFinding(finding: RunFinding, context: ReportContext): string {
  const attempt =
    finding.caseId === null ? undefined : context.attemptsByCaseId.get(finding.caseId);
  const severity = finding.severity === 'error' ? 'Error' : 'Warning';
  const subject = attempt === undefined ? '' : ` for ${context.names.caseName(attempt.identity)}`;
  return `${severity}${subject}: ${finding.message.replace(/\r?\n/g, ' ')}`;
}

/**
 * Builds the terminal summary from the statements the footnotes use: one entry
 * per planned attempt in report order, and one line per run finding.
 */
function buildSummary(context: ReportContext): ReportSummary {
  const attempts = sortedTaskIds(context.model).flatMap((taskId) =>
    orderPairsForRows(
      context.model.pairs.filter((pair) => pair.taskId === taskId),
      context.configurationModelIds,
    ).flatMap((pair) => attemptsOfPair(context, pair)),
  );
  return {
    attempts: attempts.map((attempt) => ({
      caseId: attempt.identity.caseId,
      lines: summarizeAttempt(attempt, context),
    })),
    findings: context.model.findings.map((finding) => renderFinding(finding, context)),
  };
}

function summarizeAttempt(attempt: Attempt, context: ReportContext): string[] {
  const outcome = attempt.result?.outcome ?? 'not-evaluated';
  const counts = formatRequiredChecks(countRequiredChecks([attempt], attempt.checks));
  const statementLines = statementsOf(attempt).map(
    (statement) => `  ${renderStatement(statement)}`,
  );
  return [
    `${context.names.caseName(attempt.identity)}: ${outcome}; required checks ${counts}.`,
    ...statementLines.filter((line, index) => statementLines.indexOf(line) === index),
  ];
}

/** The statements an attempt has, in the order stop, failure, pending. */
function statementsOf(attempt: Attempt): Statement[] {
  const { stop, failure, pending } = attempt.statements;
  return [stop, failure, pending].flatMap((statement) => (statement === null ? [] : [statement]));
}

const COMPARISON_HEADER_ROW =
  '| Model | Effort | Outcome | Required checks | Elapsed | Cost | Turns | Tool calls | Input | Cache read | Cache write | Output | Reasoning | API errors | Runtime failure |';
const COMPARISON_SEPARATOR_ROW = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';

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

/** Metric lines of a case section, in line order; a grading's metrics have no `elapsed`. */
const METRIC_LINES: readonly {
  label: string;
  metric: keyof BenchmarkMetrics;
  format: MeasurementColumn['format'];
}[] = [
  { label: 'Elapsed', metric: 'elapsed', format: formatElapsed },
  { label: 'Cost', metric: 'cost', format: formatCost },
  { label: 'Turns', metric: 'turns', format: formatCount },
  { label: 'API calls', metric: 'apiCalls', format: formatCount },
  { label: 'Tool calls', metric: 'toolCalls', format: formatCount },
  { label: 'Skill calls', metric: 'skillCalls', format: formatCount },
  { label: 'Input tokens', metric: 'inputTokens', format: formatCount },
  { label: 'Cache read tokens', metric: 'cacheReadTokens', format: formatCount },
  { label: 'Cache write tokens', metric: 'cacheWriteTokens', format: formatCount },
  { label: 'Output tokens', metric: 'outputTokens', format: formatCount },
  { label: 'Reasoning tokens', metric: 'reasoningTokens', format: formatCount },
  { label: 'API errors', metric: 'apiErrors', format: formatCount },
];

/** A statement a table cell refers to, with the attempt it describes. */
type Footnoted = { attemptName: string; statement: Statement };

/**
 * Renders the lines of every comparison block, in task order. Each block ends
 * with one empty line, so the lines that follow never continue its table.
 */
function renderComparisonBlocks(context: ReportContext): string[] {
  const { model, names } = context;
  const lines: string[] = [];

  for (const taskId of sortedTaskIds(model)) {
    const footnotes = createFootnoteRegistry();
    const pairs = orderPairsForRows(
      model.pairs.filter((pair) => pair.taskId === taskId),
      context.configurationModelIds,
    );

    lines.push(
      `## Comparison: ${cell(names.task(taskId))}`,
      '',
      COMPARISON_HEADER_ROW,
      COMPARISON_SEPARATOR_ROW,
      ...pairs.flatMap((pair) => renderComparisonRow(pair, context, footnotes)),
      '',
    );

    const graded = gradedAttemptsOfTask(context, taskId);
    if (graded.length > 0) {
      lines.push(renderGraderLine(graded, context, footnotes), '');
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
  context: ReportContext,
  footnotes: FootnoteRegistry,
): string[] {
  const attempts = attemptsOfPair(context, pair);
  const [lowest] = attempts;
  if (lowest === undefined) {
    return [];
  }
  const cells = [
    renderModelCell(lowest.identity, attempts, context.names),
    renderEffortCell(lowest.identity, pair, context.model.manifest.efforts),
    renderOutcomeCell(pair, attempts, context.names, footnotes),
    formatRequiredChecks(
      countRequiredChecks(attempts, context.tasksById.get(pair.taskId)?.checks ?? []),
    ),
    ...ROW_MEASUREMENT_COLUMNS.map(({ metric, format }) =>
      renderMeasurementCell(
        attempts.map((attempt) => rowMeasurementItem(attempt, metric, context.names)),
        lowerMedian,
        format,
        footnotes,
      ),
    ),
    renderRuntimeFailureCell(attempts, context.names, footnotes),
  ];
  return [`| ${cells.join(' | ')} |`];
}

/** The planned attempts of `pair` in ascending attempt order. */
function attemptsOfPair(context: ReportContext, pair: PairSummary): Attempt[] {
  return [...context.attemptsByCaseId.values()]
    .filter(({ identity }) => identity.taskId === pair.taskId && identity.modelId === pair.modelId)
    .sort((a, b) => a.identity.attempt - b.identity.attempt);
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

function caseResultsOf(attempts: readonly Attempt[]): CaseResult[] {
  return attempts.flatMap((attempt) => (attempt.result === undefined ? [] : [attempt.result]));
}

function renderModelCell(
  identity: CaseIdentity,
  attempts: readonly Attempt[],
  names: ReaderNames,
): string {
  const text = names.settingModel(identity.modelId);
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

function renderOutcomeCell(
  pair: PairSummary,
  attempts: readonly Attempt[],
  names: ReaderNames,
  footnotes: FootnoteRegistry,
): string {
  const present = OUTCOME_ORDER.filter((outcome) => pair.outcomes[outcome] > 0);
  const text =
    pair.planned === 1
      ? present.join(', ')
      : present
          .map(
            (outcome) =>
              `${formatCount(pair.outcomes[outcome])}/${formatCount(pair.planned)} ${outcome}`,
          )
          .join(', ');
  const markers = footnoteMarkers(
    attempts.flatMap((attempt) =>
      [attempt.statements.stop, attempt.statements.pending].flatMap((statement) =>
        statement === null ? [] : [{ attemptName: names.attempt(attempt.identity), statement }],
      ),
    ),
    footnotes,
  );
  return appendMarkers(text, markers);
}

/**
 * Renders the Runtime failure cell: the label of one attempt's failure, or a
 * `<k>/<n> <label>` count per distinct label, then the markers of the
 * attempts' failure statements.
 */
function renderRuntimeFailureCell(
  attempts: readonly Attempt[],
  names: ReaderNames,
  footnotes: FootnoteRegistry,
): string {
  const markers = footnoteMarkers(
    attempts.flatMap((attempt) =>
      attempt.statements.failure === null
        ? []
        : [{ attemptName: names.attempt(attempt.identity), statement: attempt.statements.failure }],
    ),
    footnotes,
  );
  const results = caseResultsOf(attempts);
  if (results.length === 0) {
    return appendMarkers('-', markers);
  }

  const countsByLabel = new Map<string, number>();
  for (const result of results) {
    if (result.failure !== null) {
      const label = failureLabel(result.failure.error.kind);
      countsByLabel.set(label, (countsByLabel.get(label) ?? 0) + 1);
    }
  }
  const labels = [...countsByLabel].sort(([a], [b]) => compareStrings(a, b));
  const text =
    labels.length === 0
      ? 'none'
      : labels
          .map(([label, count]) =>
            attempts.length === 1
              ? cell(label)
              : `${formatCount(count)}/${formatCount(attempts.length)} ${cell(label)}`,
          )
          .join(', ');
  return appendMarkers(text, markers);
}

type MeasurementItem =
  { kind: 'reported'; value: number } | { kind: 'lacking'; footnote: Footnoted };

type MeasuredValue = { kind: 'reported'; value: number } | { kind: 'unavailable'; reason: string };

/** Classifies a metric as measured or unavailable; `value: null` reads as unavailable. */
function measuredValueOf(metric: MetricValue): MeasuredValue {
  if (metric.availability.status === 'unavailable') {
    return { kind: 'unavailable', reason: metric.availability.reason };
  }
  if (metric.value === null) {
    return { kind: 'unavailable', reason: 'no value recorded' };
  }
  return { kind: 'reported', value: metric.value };
}

/**
 * Classifies one attempt's metric for a comparison row. An attempt with no
 * case result contributes its `stop` statement; any other gap contributes a
 * measurement gap.
 */
function rowMeasurementItem(
  attempt: Attempt,
  metric: keyof BenchmarkMetrics,
  names: ReaderNames,
): MeasurementItem {
  const attemptName = names.attempt(attempt.identity);
  if (attempt.result === undefined) {
    return {
      kind: 'lacking',
      footnote: {
        attemptName,
        statement:
          attempt.statements.stop ??
          measurementGapStatement({ reason: 'no value recorded', count: 1, graderLine: false }),
      },
    };
  }
  const measured = measuredValueOf(attempt.result.metrics[metric]);
  return measured.kind === 'reported'
    ? measured
    : {
        kind: 'lacking',
        footnote: {
          attemptName,
          statement: measurementGapStatement({
            reason: measured.reason,
            count: 1,
            graderLine: false,
          }),
        },
      };
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
 * aggregate with a `(k/n)` count and footnote markers when some do, and a dash
 * with footnote markers when none do. An unavailable value never renders as a number.
 */
function renderMeasurementCell(
  items: readonly MeasurementItem[],
  aggregate: (values: number[]) => number,
  format: (value: number) => string,
  footnotes: FootnoteRegistry,
): string {
  const reported = items.flatMap((item) => (item.kind === 'reported' ? [item.value] : []));
  const lacking = items.flatMap((item) => (item.kind === 'lacking' ? [item.footnote] : []));
  if (lacking.length === 0) {
    return format(aggregate(reported));
  }
  const markers = footnoteMarkers(lacking, footnotes);
  if (reported.length === 0) {
    return `- ${markers}`;
  }
  return `${format(aggregate(reported))} (${formatCount(reported.length)}/${formatCount(items.length)}) ${markers}`;
}

/** The attempts whose grading the case sections of `taskId` render, in `model.gradings` order. */
function gradedAttemptsOfTask(
  context: ReportContext,
  taskId: string,
): { attempt: Attempt; grading: GradingSummary }[] {
  return context.model.gradings.flatMap((grading) => {
    const attempt = context.attemptsByCaseId.get(grading.caseId);
    return attempt?.result !== undefined && attempt.identity.taskId === taskId
      ? [{ attempt, grading }]
      : [];
  });
}

/** The statement that explains a grading without a reply, counting the graded checks still waiting. */
function gradingGapOf(attempt: Attempt, grading: GradingSummary, runId: string): Statement | null {
  const pendingGraded = (attempt.result?.checks ?? []).filter(
    (check) =>
      check.verdict === 'pending' &&
      attempt.checks.find((candidate) => candidate.id === check.checkId)?.evaluator === 'grader',
  );
  const required = pendingGraded.filter(
    (check) =>
      attempt.checks.find((candidate) => candidate.id === check.checkId)?.required === true,
  ).length;
  return gradingGapStatement({
    runId,
    caseId: grading.caseId,
    grading,
    lifecycle: attempt.result?.lifecycle,
    pendingGradedChecks: { required, optional: pendingGraded.length - required },
  });
}

/** Classifies one grading's metric for the grader line or a case section. */
function gradingMeasurementItem(
  attempt: Attempt,
  metric: MetricValue,
  context: ReportContext,
): MeasurementItem {
  const measured = measuredValueOf(metric);
  if (measured.kind === 'reported') {
    return measured;
  }
  return {
    kind: 'lacking',
    footnote: {
      attemptName: context.names.attempt(attempt.identity),
      statement: measurementGapStatement({ reason: measured.reason, count: 1, graderLine: true }),
    },
  };
}

/** Renders the grader's summed usage and cost, read from grading metrics only. */
function renderGraderLine(
  graded: readonly { attempt: Attempt; grading: GradingSummary }[],
  context: ReportContext,
  footnotes: FootnoteRegistry,
): string {
  const totals = GRADER_TOTALS.map(({ label, metric, format }) => {
    const items = graded.map((entry) =>
      gradingMeasurementItem(entry.attempt, entry.grading.metrics[metric], context),
    );
    return `${label} ${renderMeasurementCell(items, sum, format, footnotes)}`;
  });
  const calls = graded.flatMap(({ grading }) => grading.calls);
  const withoutVerdict = calls.filter(({ outcome }) => outcome.status === 'no-reply').length;
  const callCount = `${formatCount(calls.length)} ${calls.length === 1 ? 'call' : 'calls'}`;
  const gap = withoutVerdict > 0 ? `, ${formatCount(withoutVerdict)} without a verdict` : '';
  return `Grading model total for this task, not added to any row: ${callCount}${gap}, ${totals.join(', ')}.`;
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

/**
 * Registers each statement as `<attempt name>: <statement>` in the order given
 * and renders the distinct numbers ascending, one space apart. Brackets are
 * escaped so a link reference definition in a task description cannot turn a
 * marker into a link.
 */
function footnoteMarkers(entries: readonly Footnoted[], footnotes: FootnoteRegistry): string {
  const numbers = entries.map(({ attemptName, statement }) =>
    footnotes.numberFor(`${attemptName}: ${renderStatement(statement)}`),
  );
  return [...new Set(numbers)]
    .sort((a, b) => a - b)
    .map((number) => `\\[${number}\\]`)
    .join(' ');
}

function appendMarkers(text: string, markers: string): string {
  return markers === '' ? text : `${text} ${markers}`;
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

/** Renders `. <statement>` for an effort that needs explaining, otherwise nothing. */
function renderEffortExplanation(effort: string, check: EffortCheck | null | undefined): string {
  const statement = effortStatement(effort, check);
  return statement === null ? '' : `. ${renderStatement(statement)}`;
}

/** Renders one line per model entry with its effort check, in `models` order. */
function renderModelEffortLines(
  models: readonly ModelRecord[],
  efforts: RunManifest['efforts'],
  names: ReaderNames,
): string[] {
  return models.map((entry) => {
    const check = effortCheckOf(efforts, entry.id);
    return `- ${names.setting(entry.id)}: effort ${check?.status ?? 'not checked'}${renderEffortExplanation(entry.effort, check)}`;
  });
}

/** Renders one `- Grader:` line, and a shared-model-entry note when one applies, per distinct grader identity. */
function renderGraderLines(
  graders: readonly GraderSummary[],
  check: EffortCheck | null,
  names: ReaderNames,
): string[] {
  const lines: string[] = [];
  for (const summary of graders) {
    const { grader, sharedModelEntryIds } = summary;
    lines.push(
      `- Grader: ${grader.model} (effort ${effortLabel(grader.effort, check)}, agent ${grader.agent})${renderEffortExplanation(grader.effort, check)}`,
    );
    if (sharedModelEntryIds.length > 0) {
      lines.push(
        `- Grader model ${grader.model} is also benchmarked as ${sharedModelEntryIds.map((id) => names.setting(id)).join('; ')} (informational; tevu does not forbid it)`,
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
  names: ReaderNames,
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
  const rendered = sorted
    .map((entry) => `"${names.task(entry.taskId)}" ${entry.timeoutMs}ms`)
    .join(', ');
  return [`- Tasks with their own case timeout: ${rendered}`];
}

/** Renders the `Pair summary:` block for one task's pairs, in `pairs` order. */
function renderPairSummary(pairs: readonly PairSummary[], names: ReaderNames): string[] {
  const lines: string[] = ['Pair summary:', ''];
  lines.push(
    '| Model setting | Planned | passed | failed | pending | not-evaluated | Passed of planned | All passed |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const pair of pairs) {
    const outcomes = pair.outcomes;
    lines.push(
      `| ${cell(names.setting(pair.modelId))} | ${pair.planned} | ${outcomes.passed} | ${outcomes.failed} | ${outcomes.pending} | ${outcomes['not-evaluated']} | ${pair.passedOfPlanned} | ${pair.allPassed ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
  return lines;
}

/** Renders one row of the task section's case table. */
function renderCaseRow(
  caseResult: CaseResult,
  task: TaskRecord | undefined,
  names: ReaderNames,
): string {
  const identity = caseResult.identity;
  const elapsed = measuredValueOf(caseResult.metrics.elapsed);
  const link = `[${cell(escapeLinkText(names.attempt(identity)))}](#case-${identity.caseId})`;
  const runtimeFailure =
    caseResult.failure === null ? 'none' : cell(failureLabel(caseResult.failure.error.kind));
  const requiredChecks = formatRequiredChecks(
    countRequiredChecks([{ result: caseResult }], task?.checks ?? []),
  );
  return `| ${link} | ${caseResult.outcome} | ${requiredChecks} | ${runtimeFailure} | ${elapsed.kind === 'reported' ? formatElapsed(elapsed.value) : '-'} |`;
}

function describeProcess(process: CaseResult['process']): string {
  if (process === null) {
    return 'did not start';
  }
  const ending =
    process.exitCode !== null
      ? `exited with code ${process.exitCode}`
      : `ended by signal ${process.signal ?? 'unknown'}`;
  const stop =
    process.terminationStage === 'graceful'
      ? '; tevu asked it to stop'
      : process.terminationStage === 'forced'
        ? '; tevu forced it to stop'
        : '';
  return `${ending} after ${formatElapsed(process.durationMs)}${stop}`;
}

function describeCategory(category: CheckRecord['category']): string {
  return category === 'acceptance' ? 'acceptance' : 'Definition of Done';
}

function renderCase(
  lines: string[],
  attempt: Attempt,
  caseResult: CaseResult,
  assessment: AssessmentArtifact | undefined,
  context: ReportContext,
): void {
  const { names } = context;
  const { identity } = caseResult;
  const runId = context.model.manifest.runId;
  const definitions = new Map(attempt.checks.map((check) => [check.id, check]));
  const efforts = context.model.manifest.efforts;
  const requiredChecks = formatRequiredChecks(
    countRequiredChecks([{ result: caseResult }], attempt.checks),
  );

  lines.push(
    `<a id="case-${identity.caseId}"></a>`,
    '',
    `### ${cell(names.attempt(identity))}`,
    '',
    `- Outcome: ${caseResult.outcome}; required checks ${requiredChecks}`,
    `- Model: ${cell(identity.model)}, effort ${cell(effortLabel(identity.effort, effortCheckOf(efforts, identity.modelId)))}`,
    `- Agent process: ${describeProcess(caseResult.process)}`,
    '',
  );

  const paragraphs = statementsOf(attempt).map((statement) => cell(renderStatement(statement)));
  for (const paragraph of paragraphs.filter((text, index) => paragraphs.indexOf(text) === index)) {
    lines.push(paragraph, '');
  }

  const hasAssessableCheck = attempt.checks.some((check) => check.evaluator !== 'command');
  if (
    caseResult.lifecycle === 'completed' &&
    hasAssessableCheck &&
    attempt.statements.pending === null
  ) {
    lines.push(`Record or replace verdicts with \`tevu assess ${runId} ${identity.caseId}\`.`, '');
  }

  if (caseResult.checks.length > 0) {
    lines.push(
      '| Verdict | Check | Category | Required | Evaluator | Duration | Evidence |',
      '|---|---|---|---|---|---|---|',
    );
    for (const check of caseResult.checks) {
      const definition = definitions.get(check.checkId);
      const required =
        definition === undefined ? 'unknown' : definition.required ? 'required' : 'optional';
      lines.push(
        `| ${check.verdict} | ${cell(names.check(identity.taskId, check.checkId))} | ${describeCategory(check.category)} | ${required} | ${definition?.evaluator ?? 'unknown'} | ${check.durationMs === null ? '-' : `${check.durationMs}ms`} | ${artifactLink(caseResult.artifacts.checks)} |`,
      );
    }
    lines.push('');
  }

  lines.push('Metrics:', '', ...renderMetricLines(caseResult.metrics), '');

  const grading = attempt.grading;
  if (grading !== undefined) {
    lines.push(...renderGradingBlock(attempt, grading, context));
  }

  lines.push('Artifacts:', '');
  const artifacts = caseResult.artifacts;
  const setupLogs = caseResult.setup?.logs;
  lines.push(
    `- Solution patch: ${artifactLink(artifacts.solutionPatch)}`,
    `- Events: ${artifactLink(artifacts.events)}`,
    `- Diagnostics: ${artifactLink(artifacts.diagnostics)}`,
    `- Session export: ${artifactLink(artifacts.sessionExport)}`,
    `- Check evidence: ${artifactLink(artifacts.checks)}`,
    ...(artifacts.grading === null ? [] : [`- Grading: ${artifactLink(artifacts.grading)}`]),
    ...(setupLogs?.beforeAgent
      ? [`- Setup log before the agent: ${artifactLink(setupLogs.beforeAgent)}`]
      : []),
    ...(setupLogs?.beforeChecks
      ? [`- Setup log before the checks: ${artifactLink(setupLogs.beforeChecks)}`]
      : []),
    `- Result: ${artifactLink(artifacts.result)}`,
    '',
  );

  if (assessment !== undefined && assessment.current.length > 0) {
    lines.push(`Assessments (revision ${assessment.revision}):`, '');
    for (const record of assessment.current) {
      lines.push(
        `- ${cell(names.check(identity.taskId, record.checkId))}: ${record.verdict} by ${cell(record.assessor)} at ${record.assessedAt}${record.note.length > 0 ? `; note: ${cell(record.note)}` : ''}`,
      );
    }
    lines.push('');
  }
}

/**
 * Renders the available metrics in label order, then one `Not measured` line
 * per distinct reason. Metrics the set does not carry are skipped.
 */
function renderMetricLines(metrics: Readonly<Partial<BenchmarkMetrics>>): string[] {
  const measuredLines: string[] = [];
  const labelsByReason = new Map<string, string[]>();
  for (const { label, metric, format } of METRIC_LINES) {
    const value = metrics[metric];
    if (value === undefined) {
      continue;
    }
    const measured = measuredValueOf(value);
    if (measured.kind === 'reported') {
      measuredLines.push(`- ${label}: ${format(measured.value)}`);
    } else {
      labelsByReason.set(measured.reason, [...(labelsByReason.get(measured.reason) ?? []), label]);
    }
  }
  const gapLines = [...labelsByReason].map(([reason, labels]) => {
    const gap = measurementGapStatement({ reason, count: labels.length, graderLine: false });
    return `- Not measured: ${labels.join(', ')}. ${cell(renderStatement(gap))}`;
  });
  return [...measuredLines, ...gapLines];
}

/**
 * Renders one case's grading: the grader identity, a grade or gap per check in
 * `checkId` order, and the grader's own metrics, kept in a block separate from
 * the case's agent metrics above it and never added to them.
 */
function renderGradingBlock(
  attempt: Attempt,
  grading: GradingSummary,
  context: ReportContext,
): string[] {
  const { names } = context;
  const check = context.model.manifest.efforts.grader;
  const gap = gradingGapOf(attempt, grading, context.model.manifest.runId);
  const gradeLines = grading.grades.map((grade) => {
    const name = cell(names.check(attempt.identity.taskId, grade.checkId));
    if (grade.status === 'graded') {
      return `- ${name}: ${grade.verdict}. ${cell(grade.rationale)}`;
    }
    return grading.call.status === 'no-reply'
      ? `- ${name}: no verdict.`
      : `- ${name}: no usable verdict. Technical detail: ${cell(grade.reason)}`;
  });
  const callCount = grading.calls.length > 1 ? `, after ${grading.calls.length} calls` : '';
  return [
    `Grades by ${cell(grading.grader.model)} (effort ${cell(effortLabel(grading.grader.effort, check))}, agent ${cell(grading.grader.agent)})${callCount}:`,
    '',
    ...(gap === null ? [] : [`- ${cell(renderStatement(gap))}`]),
    ...gradeLines,
    '',
    'Grader metrics (separate from the agent metrics above; never added to them):',
    '',
    ...renderMetricLines(grading.metrics),
    '',
  ];
}

/** One line per imported task source; a hand-written task has none. */
function describeTaskSource(source: TaskRecord['source']): string[] {
  switch (source.kind) {
    case 'manual':
      return [];
    case 'jira-cloud':
      return [`- Source: imported from Jira issue [${source.issueKey}](${source.issueUrl})`];
    case 'github-issue':
      return [`- Source: imported from GitHub issue [${source.issueKey}](${source.issueUrl})`];
  }
}

function artifactLink(path: string | null): string {
  return path === null ? 'missing' : `[${cell(path.slice(path.lastIndexOf('/') + 1))}](${path})`;
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
