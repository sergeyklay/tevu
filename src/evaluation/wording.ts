/**
 * Reader-facing wording shared by `report.md`, the `tevu run` terminal summary,
 * and `tevu assess`: plain names, three-part statements, failure labels, and
 * required-check counts. Pure: no I/O, no clock, and no function throws, so
 * every surface describes one state in the same words.
 *
 * Entry points: {@link buildReaderNames} for names and {@link describeAttempt}
 * for the statements of one attempt.
 */

import type {
  CaseIdentity,
  CaseLifecycle,
  CaseResult,
  CheckRecord,
  EffortCheck,
  GradeRecord,
  GradingSummary,
  ModelRecord,
  SummaryCall,
  SummarySetting,
  TaskRecord,
  TevuError,
} from '@/domain/types';

/** A state explained in three parts, with internal text kept apart as technical detail. */
export type Statement = { happened: string; means: string; next: string; detail: string | null };

/** The plain names of one run's tasks, model settings, attempts, cases, and checks. */
export type ReaderNames = {
  task(taskId: string): string;
  setting(modelId: string): string;
  /** The model alone, with the same disambiguator as `setting`. */
  settingModel(modelId: string): string;
  attempt(identity: Pick<CaseIdentity, 'modelId' | 'attempt'>): string;
  caseName(identity: Pick<CaseIdentity, 'taskId' | 'modelId' | 'attempt'>): string;
  check(taskId: string, checkId: string): string;
};

/** What `describeAttempt` reads for one planned attempt. */
export type AttemptFacts = {
  identity: CaseIdentity;
  result: CaseResult | undefined;
  checks: readonly CheckRecord[];
  grading: GradingSummary | undefined;
  /** The check's reader name from the run's `ReaderNames`, so every surface names it alike. */
  checkName(checkId: string): string;
};

/** The statements of one attempt; a statement is `null` when the attempt has nothing to say in that role. */
export type AttemptStatements = {
  stop: Statement | null;
  failure: Statement | null;
  pending: Statement | null;
};

/** Required-check classes over a set of attempts of one task. */
export type RequiredCheckCounts = {
  passed: number;
  failed: number;
  pending: number;
  notRun: number;
  total: number;
};

const NO_CASE_RESULT_REASON = 'no case result was saved';

const TECHNICAL_DETAIL_MARKER = 'Technical detail:';

const GRADE_MEANS = 'This check has no verdict until you record one.';
const GRADE_NEXT = 'Choose a verdict below.';

const NO_RESULT: Omit<Statement, 'detail'> = {
  happened: 'tevu saved no result for this attempt.',
  means: 'It has no outcome or measurements, so it counts as not evaluated.',
  next: 'Run the comparison again to get a result for this attempt.',
};

/** Escapes table-breaking characters in one Markdown table cell or inline value. */
export function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** Escapes brackets and backslashes, which would end or reshape the text of a Markdown link. */
export function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, '\\$&');
}

// Digit grouping is manual because locale-aware formatting would make regenerated reports differ between hosts.
/** Formats a count with comma digit grouping, independent of the host locale. */
export function formatCount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    return String(value);
  }
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Formats a cost in US dollars with four decimals. */
export function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** Formats a duration in seconds, or in minutes from one minute up. */
export function formatElapsed(milliseconds: number): string {
  const seconds = (milliseconds / 1000).toFixed(1);
  return Number(seconds) < 60 ? `${seconds} s` : `${(milliseconds / 60000).toFixed(1)} min`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** ` (<k>)` per ID whose name another entry shares, k being its 1-based position among them. */
function duplicateSuffixes(entries: readonly { id: string; name: string }[]): Map<string, string> {
  const positions = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const { name } of entries) {
    totals.set(name, (totals.get(name) ?? 0) + 1);
  }
  const suffixes = new Map<string, string>();
  for (const { id, name } of entries) {
    if ((totals.get(name) ?? 0) > 1) {
      const position = (positions.get(name) ?? 0) + 1;
      positions.set(name, position);
      suffixes.set(id, ` (${position})`);
    }
  }
  return suffixes;
}

/**
 * Builds the names of one run from its records in configuration order.
 *
 * Tasks and checks that share a name each get ` (<k>)`. A setting is named by
 * its display model, which drops the provider prefix unless that would make two
 * different models read alike, and its effort. Model entries that share model
 * and effort each get `, <agent>` after the effort; entries that still share a
 * name after that get ` (<k>)`. An ID missing from the records
 * names itself. `cases` supplies each model entry's agent, which the model
 * records do not carry.
 */
export function buildReaderNames(input: {
  tasks: readonly TaskRecord[];
  models: readonly ModelRecord[];
  repeat: number;
  cases: readonly Pick<CaseIdentity, 'modelId' | 'agent'>[];
}): ReaderNames {
  const taskNames = nameTasks(input.tasks);
  const settings = nameSettings(input.models, input.cases);
  const checkNames = new Map<string, string>();
  for (const task of input.tasks) {
    for (const [checkId, name] of nameChecks(task.checks)) {
      checkNames.set(`${task.id}\u0000${checkId}`, name);
    }
  }

  const task = (taskId: string): string => taskNames.get(taskId) ?? taskId;
  const setting = (modelId: string): string => settings.get(modelId)?.setting ?? modelId;
  const attempt = (identity: Pick<CaseIdentity, 'modelId' | 'attempt'>): string =>
    input.repeat > 1
      ? `${setting(identity.modelId)}, attempt ${identity.attempt}`
      : setting(identity.modelId);

  return {
    task,
    setting,
    settingModel: (modelId) => settings.get(modelId)?.model ?? modelId,
    attempt,
    caseName: (identity) => `${attempt(identity)} on "${task(identity.taskId)}"`,
    check: (taskId, checkId) => checkNames.get(`${taskId}\u0000${checkId}`) ?? checkId,
  };
}

function nameTasks(tasks: readonly TaskRecord[]): Map<string, string> {
  const named = tasks.map((task) => ({ id: task.id, name: collapseWhitespace(task.title) }));
  const suffixes = duplicateSuffixes(named);
  return new Map(named.map(({ id, name }) => [id, `${name}${suffixes.get(id) ?? ''}`]));
}

/** The text after the last `/` of a model string. */
function shortModelName(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1);
}

/**
 * The display model of every model entry, by ID: the model without its
 * provider prefix, or the full model string when the entry has no short name
 * or when an entry with a different model string shares it.
 */
export function displayModelsOf(models: readonly ModelRecord[]): ReadonlyMap<string, string> {
  const modelsByShortName = new Map<string, Set<string>>();
  for (const { model } of models) {
    const short = shortModelName(model);
    modelsByShortName.set(short, (modelsByShortName.get(short) ?? new Set()).add(model));
  }
  return new Map(
    models.map(({ id, model }) => {
      const short = shortModelName(model);
      const isAmbiguous = (modelsByShortName.get(short)?.size ?? 0) > 1;
      return [id, short === '' || isAmbiguous ? model : short];
    }),
  );
}

function nameSettings(
  models: readonly ModelRecord[],
  cases: readonly Pick<CaseIdentity, 'modelId' | 'agent'>[],
): Map<string, { setting: string; model: string }> {
  const agents = new Map<string, string>();
  for (const { modelId, agent } of cases) {
    if (!agents.has(modelId)) {
      agents.set(modelId, agent);
    }
  }
  const sharedModelAndEffort = new Map<string, number>();
  for (const { model, effort } of models) {
    const key = `${model}\u0000${effort}`;
    sharedModelAndEffort.set(key, (sharedModelAndEffort.get(key) ?? 0) + 1);
  }

  const displayModels = displayModelsOf(models);
  const named = models.map(({ id, model, effort }) => {
    const isShared = (sharedModelAndEffort.get(`${model}\u0000${effort}`) ?? 0) > 1;
    const agent = isShared ? agents.get(id) : undefined;
    const agentPart = agent === undefined ? '' : `, ${agent}`;
    const displayModel = displayModels.get(id) ?? model;
    return {
      id,
      name: `${displayModel}, ${effort}${agentPart}`,
      model: `${displayModel}${agentPart}`,
    };
  });
  const suffixes = duplicateSuffixes(named);
  return new Map(
    named.map(({ id, name, model }) => [
      id,
      { setting: `${name}${suffixes.get(id) ?? ''}`, model: `${model}${suffixes.get(id) ?? ''}` },
    ]),
  );
}

function nameChecks(checks: readonly CheckRecord[]): Map<string, string> {
  const positions: Record<CheckRecord['category'], number> = {
    acceptance: 0,
    'definition-of-done': 0,
  };
  const named = checks.map((check) => {
    positions[check.category] += 1;
    const description = collapseWhitespace(check.description);
    const fallback =
      check.category === 'acceptance' ? 'Acceptance check' : 'Definition of Done check';
    return {
      id: check.id,
      name: description === '' ? `${fallback} ${positions[check.category]}` : description,
    };
  });
  const suffixes = duplicateSuffixes(named);
  return new Map(named.map(({ id, name }) => [id, `${name}${suffixes.get(id) ?? ''}`]));
}

/**
 * Renders a statement as one line: its three parts joined by single spaces,
 * then ` Technical detail: <detail>` when the statement has one. Newlines
 * become spaces.
 */
export function renderStatement(statement: Statement): string {
  const parts = [statement.happened, statement.means, statement.next].join(' ');
  const text =
    statement.detail === null ? parts : `${parts} ${TECHNICAL_DETAIL_MARKER} ${statement.detail}`;
  return text.replace(/\r?\n/g, ' ');
}

function pickCount(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/** `<r> required`, `<o> optional`, or both joined by `and`, by which counts are nonzero. */
function describeCounts(required: number, optional: number): string {
  const parts = [
    ...(required > 0 ? [`${formatCount(required)} required`] : []),
    ...(optional > 0 ? [`${formatCount(optional)} optional`] : []),
  ];
  return parts.join(' and ');
}

type ErrorRow = { happened: string; next: string };

const NOT_COMPLETED_MEANS =
  'The attempt did not complete its checks, so it counts as not evaluated.';

const CANCELLATION_ROW: ErrorRow = {
  happened: 'The run was cancelled before this attempt finished.',
  next: 'Run the comparison again to get a result for this attempt.',
};

const RAW_ERROR_ROW: ErrorRow = {
  happened: 'tevu stopped this attempt because of an error of its own.',
  next: 'Run the comparison again; if the error repeats, report it with the technical detail.',
};

const WORKSPACE_ERROR_ROW: ErrorRow = {
  happened: 'tevu could not prepare the workspace for this attempt.',
  next: 'Run `tevu validate`, fix what it reports, and run the comparison again.',
};

/** The happened sentence and next step of an error kind; `undefined` takes the `tevu error` row. */
function row(error: TevuError | undefined): ErrorRow {
  switch (error?.kind) {
    case 'CaseTimeoutError':
      return {
        happened: `The model did not finish within its time limit of ${formatElapsed(error.timeoutMs)}.`,
        next: "To give it more time, raise the task's time limit (`timeout`, or `run.timeout`) and run the comparison again.",
      };
    case 'CancellationError':
      return CANCELLATION_ROW;
    case 'AgentProcessError':
      return {
        happened: 'The agent process stopped with an error.',
        next: "Read the attempt's diagnostics log to find out why.",
      };
    case 'AgentSessionError':
      return {
        happened: 'The agent reported an error during its session.',
        next:
          error.agentMessage === undefined
            ? "Read the attempt's event log to find out why."
            : "Read the agent's message in the technical detail and the attempt's event log.",
      };
    case 'AgentProtocolError':
      return {
        happened: 'tevu could not read the records the agent wrote.',
        next: "Find the record the technical detail names in the attempt's event log or session export.",
      };
    case 'SetupError':
      return {
        happened: `A repository setup command failed ${error.phase === 'before_agent' ? 'before the agent started' : 'before the checks ran'}.`,
        next: "Fix the command, using its setup log among the attempt's artifacts, and run the comparison again.",
      };
    case 'CheckStateError':
      return {
        happened: `tevu could not ${error.step} the check files after the agent finished.`,
        next: 'Fix the cause the technical detail names, such as a read-only directory the agent left, and run the comparison again.',
      };
    case 'ArtifactError':
      return {
        happened: "tevu could not save this attempt's files.",
        next: 'Check free space and permissions of the output directory, then run the comparison again.',
      };
    case 'IsolationError':
    case 'SourceMaterializationError':
      return WORKSPACE_ERROR_ROW;
    default:
      return RAW_ERROR_ROW;
  }
}

/** Plain label of the Runtime failure column for an error kind; every unknown kind reads `tevu error`. */
export function failureLabel(kind: string): string {
  switch (kind) {
    case 'CaseTimeoutError':
      return 'time limit reached';
    case 'CancellationError':
      return 'cancelled';
    case 'AgentProcessError':
      return 'agent process failed';
    case 'AgentSessionError':
      return 'agent reported an error';
    case 'AgentProtocolError':
      return 'agent records unreadable';
    case 'SetupError':
      return 'setup command failed';
    case 'CheckStateError':
      return 'check files not prepared';
    case 'ArtifactError':
      return 'files not saved';
    case 'IsolationError':
    case 'SourceMaterializationError':
      return 'workspace not prepared';
    default:
      return 'tevu error';
  }
}

/** The internal text of an error, kept after `Technical detail:`. */
function kindDetail(error: TevuError): string {
  switch (error.kind) {
    case 'CaseTimeoutError':
      return `CaseTimeoutError, limit ${error.timeoutMs} ms`;
    case 'CancellationError':
      return 'CancellationError';
    case 'AgentProcessError':
      return `AgentProcessError, exit code ${error.exitCode ?? 'none'}, signal ${error.signal ?? 'none'}`;
    case 'AgentSessionError':
      return error.agentMessage === undefined
        ? 'AgentSessionError'
        : `AgentSessionError: ${error.agentMessage}`;
    case 'AgentProtocolError':
      return `AgentProtocolError: ${error.reason}`;
    case 'SetupError':
      return `SetupError, phase ${error.phase}, command ${JSON.stringify(error.argv)}: ${error.reason}`;
    case 'CheckStateError':
      return `CheckStateError, step ${error.step}: ${error.reason}`;
    case 'ArtifactError':
      return `ArtifactError, operation ${error.operation}: ${error.reason}`;
    default:
      return 'reason' in error ? `${error.kind}: ${error.reason}` : error.kind;
  }
}

/** What the lifecycle means for the result. */
function means(lifecycle: CaseLifecycle): string {
  switch (lifecycle) {
    case 'completed':
      return 'Its solution was still checked, so the outcome comes from its checks.';
    case 'process-failed':
      return 'tevu could not read its workspace afterwards, so its checks did not run and the attempt counts as not evaluated.';
    default:
      return NOT_COMPLETED_MEANS;
  }
}

function errorStatement(
  { happened, next }: ErrorRow,
  lifecycle: CaseLifecycle,
  detail: string,
): Statement {
  return { happened, means: means(lifecycle), next, detail };
}

/**
 * Chooses the `stop`, `failure`, and `pending` statements of one attempt from
 * structured fields only; no reason string is parsed. `stop` and `failure` may
 * be the same object, which lets a footnote registry number them once.
 */
export function describeAttempt(facts: AttemptFacts, runId: string): AttemptStatements {
  const { caseId } = facts.identity;
  const { result } = facts;
  if (result === undefined) {
    const statement = { ...NO_RESULT, detail: `case ${caseId}: ${NO_CASE_RESULT_REASON}` };
    return { stop: statement, failure: statement, pending: null };
  }

  const error = result.failure?.error;
  if (result.lifecycle === 'cancelled') {
    const isCancellation = error?.kind === 'CancellationError';
    const stop = errorStatement(
      CANCELLATION_ROW,
      result.lifecycle,
      `case ${caseId}, lifecycle cancelled${isCancellation ? ': CancellationError' : ''}`,
    );
    const failure =
      error === undefined
        ? null
        : isCancellation
          ? stop
          : errorStatement(
              row(error),
              result.lifecycle,
              `case ${caseId}, lifecycle cancelled: ${kindDetail(error)}`,
            );
    return { stop, failure, pending: null };
  }

  if (result.lifecycle !== 'completed') {
    const stop = errorStatement(
      row(error),
      result.lifecycle,
      `case ${caseId}, lifecycle ${result.lifecycle}${error === undefined ? '' : `: ${kindDetail(error)}`}`,
    );
    return { stop, failure: error === undefined ? null : stop, pending: null };
  }

  return {
    stop: null,
    failure:
      error === undefined
        ? null
        : errorStatement(row(error), 'completed', `case ${caseId}: ${kindDetail(error)}`),
    pending: pendingStatement(facts, result, runId),
  };
}

type PendingCause = 'manual' | 'no-reply' | 'unusable' | 'undetermined' | 'not-graded' | 'none';

const PENDING_CAUSE_ORDER: readonly PendingCause[] = [
  'manual',
  'no-reply',
  'unusable',
  'undetermined',
  'not-graded',
  'none',
];

function pendingCauseOf(
  definition: CheckRecord | undefined,
  grading: GradingSummary | undefined,
  grade: GradeRecord | undefined,
): PendingCause {
  if (definition === undefined || definition.evaluator === 'command') {
    return 'none';
  }
  if (definition.evaluator === 'manual') {
    return 'manual';
  }
  if (grading?.call.status === 'no-reply') {
    return 'no-reply';
  }
  if (grade?.status === 'pending') {
    return 'unusable';
  }
  if (grade?.status === 'graded' && grade.verdict === 'undetermined') {
    return 'undetermined';
  }
  return 'not-graded';
}

type NoReplyCause = Extract<GradingSummary['call'], { status: 'no-reply' }>['cause'];

const NO_REPLY_CLAUSES: Record<NoReplyCause, string> = {
  unfinished: 'the grading model stopped before finishing its reply',
  'tool-call': 'the grading model asked to use a tool, which grading does not allow',
  other: 'the grading model returned no verdict for this solution',
};

/** Names why a grading ended without a reply; past one call it opens with the call count. */
function noReplyClause(cause: NoReplyCause, callCount: number): string {
  const base = NO_REPLY_CLAUSES[cause];
  return callCount > 1
    ? `After ${callCount} calls, ${base}`
    : `${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

function noReplyClauseOf(grading: Pick<GradingSummary, 'call' | 'calls'> | undefined): string {
  return grading?.call.status === 'no-reply'
    ? noReplyClause(grading.call.cause, grading.calls.length)
    : noReplyClause('other', 1);
}

function pendingSentence(
  cause: PendingCause,
  required: number,
  optional: number,
  grading: GradingSummary | undefined,
): string {
  const total = required + optional;
  const counts = describeCounts(required, optional);
  switch (cause) {
    case 'manual':
      return `${counts} manual ${pickCount(total, 'check waits', 'checks wait')} for a person's verdict.`;
    case 'no-reply':
      return `${noReplyClauseOf(grading)}, so ${counts} graded ${pickCount(total, 'check waits', 'checks wait')} for a person's verdict.`;
    case 'unusable':
      return `The grading model's reply had no usable verdict for ${counts} graded ${pickCount(total, 'check', 'checks')}, so ${pickCount(total, 'it waits', 'they wait')} for a person's verdict.`;
    case 'undetermined':
      return `The grading model could not decide ${counts} graded ${pickCount(total, 'check', 'checks')} from the task text and the solution's changes, so ${pickCount(total, 'it waits', 'they wait')} for a person's verdict.`;
    case 'not-graded':
      return `tevu has no grading for this solution, so ${counts} graded ${pickCount(total, 'check waits', 'checks wait')} for a person's verdict.`;
    case 'none':
      return `${counts} ${pickCount(total, 'check has', 'checks have')} no verdict.`;
  }
}

function outcomeMeans(outcome: CaseResult['outcome']): string {
  switch (outcome) {
    case 'pending':
      return 'The outcome stays pending until every required check has a verdict.';
    case 'failed':
      return 'The outcome is already failed, whatever these verdicts are.';
    case 'passed':
      return 'Optional checks do not change the outcome, which stays passed.';
    case 'not-evaluated':
      return NOT_COMPLETED_MEANS;
  }
}

function assessCommand(runId: string, caseId: string, count: number): string {
  return `Record the ${pickCount(count, 'verdict', 'verdicts')} with \`tevu assess ${runId} ${caseId}\`.`;
}

function optionalAssessCommand(runId: string, caseId: string, count: number): string {
  return `${pickCount(count, 'This verdict no longer changes', 'These verdicts no longer change')} the outcome; you can still record ${pickCount(count, 'it', 'them')} for completeness with \`tevu assess ${runId} ${caseId}\`.`;
}

/** Names the attempt's failed required checks, e.g. `Failed: Type checking and the test suite pass.` */
function failedRequiredChecks(facts: AttemptFacts, result: CaseResult): string | null {
  const failed = facts.checks
    .filter((check) => check.required)
    .filter((check) => result.checks.some((r) => r.checkId === check.id && r.verdict === 'failed'))
    .map((check) => facts.checkName(check.id).replace(/\.$/, ''));
  return failed.length === 0 ? null : `Failed: ${failed.join('; ')}.`;
}

function pendingStatement(
  facts: AttemptFacts,
  result: CaseResult,
  runId: string,
): Statement | null {
  const { caseId } = facts.identity;
  const pending = result.checks.filter((check) => check.verdict === 'pending');
  if (pending.length === 0) {
    return null;
  }

  const tallies = new Map<PendingCause, { required: number; optional: number }>();
  const unusableReasons: string[] = [];
  for (const check of pending) {
    const definition = facts.checks.find((candidate) => candidate.id === check.checkId);
    const grade = facts.grading?.grades.find((candidate) => candidate.checkId === check.checkId);
    const cause = pendingCauseOf(definition, facts.grading, grade);
    const tally = tallies.get(cause) ?? { required: 0, optional: 0 };
    tally[definition?.required === true ? 'required' : 'optional'] += 1;
    tallies.set(cause, tally);
    if (
      cause === 'unusable' &&
      grade?.status === 'pending' &&
      !unusableReasons.includes(grade.reason)
    ) {
      unusableReasons.push(grade.reason);
    }
  }

  const sentences = PENDING_CAUSE_ORDER.flatMap((cause) => {
    const tally = tallies.get(cause);
    return tally === undefined
      ? []
      : [pendingSentence(cause, tally.required, tally.optional, facts.grading)];
  });
  const noReply =
    tallies.has('no-reply') && facts.grading?.call.status === 'no-reply'
      ? [facts.grading.call.reason]
      : [];
  const parts = [...noReply, ...unusableReasons];
  return {
    happened: sentences.join(' '),
    means:
      result.outcome === 'failed'
        ? [outcomeMeans('failed'), failedRequiredChecks(facts, result)]
            .filter((sentence) => sentence !== null)
            .join(' ')
        : outcomeMeans(result.outcome),
    next:
      result.outcome === 'failed'
        ? optionalAssessCommand(runId, caseId, pending.length)
        : assessCommand(runId, caseId, pending.length),
    detail: parts.length === 0 ? `case ${caseId}` : `case ${caseId}: ${parts.join('; ')}`,
  };
}

/**
 * Explains a grading that ended without a reply, or `null` for a grading that has one.
 * `pendingGradedChecks` counts the attempt's graded checks still waiting for a verdict.
 */
export function gradingGapStatement(facts: {
  runId: string;
  caseId: string;
  grading: GradingSummary;
  lifecycle: CaseLifecycle | undefined;
  pendingGradedChecks: { required: number; optional: number };
}): Statement | null {
  const { call } = facts.grading;
  if (call.status !== 'no-reply') {
    return null;
  }
  const { required, optional } = facts.pendingGradedChecks;
  const waiting = required + optional;
  const isWaiting = facts.lifecycle === 'completed' && waiting > 0;
  return {
    happened: `${noReplyClause(call.cause, facts.grading.calls.length)}${
      isWaiting
        ? `, so ${describeCounts(required, optional)} graded ${pickCount(waiting, 'check still waits', 'checks still wait')} for a person's verdict`
        : ''
    }.`,
    means:
      'The grader total for the task counts a measurement of this grading only when tevu has it for the whole grading.',
    next: isWaiting
      ? assessCommand(facts.runId, facts.caseId, waiting)
      : 'Nothing more is needed for this grading.',
    detail: `case ${facts.caseId}: ${call.reason}`,
  };
}

/**
 * Explains `count` metrics that tevu has no value for. A footnote always uses
 * a count of 1; `graderLine` names the grading as their source.
 */
export function measurementGapStatement(input: {
  reason: string;
  count: number;
  graderLine: boolean;
}): Statement {
  const { count } = input;
  return {
    happened: `tevu has no value for ${pickCount(count, 'this measurement', 'these measurements')}${input.graderLine ? ' of its grading' : ''}.`,
    means: `${pickCount(count, 'It is', 'They are')} unknown, not zero.`,
    next: `This run's saved files cannot supply ${pickCount(count, 'it', 'them')}; to measure ${pickCount(count, 'it', 'them')}, fix the cause in the technical detail and run the comparison again.`,
    detail: input.reason,
  };
}

/** Explains an effort that was not verified or is unsupported; `null` for a verified or missing check. */
export function effortStatement(
  effort: string,
  check: EffortCheck | null | undefined,
): Statement | null {
  switch (check?.status) {
    case 'unverified':
      return {
        happened: `tevu could not confirm that the agent offers effort "${effort}" for this model.`,
        means:
          'The effort was passed as requested; if the agent does not offer it, the model ran with its default options.',
        next: 'Before the next run, check the effort against the variants the agent lists for the model.',
        detail: check.reason,
      };
    case 'unsupported':
      return {
        happened: `The agent does not list effort "${effort}" for this model.`,
        means: 'Where no task repository defines it, the model ran with its default options.',
        next: 'Choose an effort the agent lists for the model and run the comparison again.',
        detail: check.reason,
      };
    default:
      return null;
  }
}

/**
 * Explains that the outcomes of one task do not separate its model settings:
 * every planned attempt of every setting passed, or every one failed.
 */
export function nonSeparatingOutcomesStatement(facts: {
  outcome: 'passed' | 'failed';
  /** The task name. */
  taskName: string;
  /** The setting name of every row, in comparison-table row order. */
  settingNames: readonly string[];
  /** The effective repeat, `manifest.execution.repeat.value`. */
  repeat: number;
}): Statement {
  const attempts = facts.repeat > 1 ? ' in every attempt' : '';
  const where = `of "${facts.taskName}"${attempts}: ${facts.settingNames.join('; ')}.`;
  const cannotSeparate =
    'The outcomes cannot tell the settings apart on this task, and a difference in time or cost does not show which setting produces the better solution';
  const repeatMore =
    'To tell the settings apart, run more attempts with `run.repeat` or `--repeat`,';
  if (facts.outcome === 'passed') {
    return {
      happened: `Every model setting passed every required check ${where}`,
      means: `${cannotSeparate}.`,
      next: `${repeatMore} compare them on a harder task, or add checks that capture more of what a good solution does.`,
      detail: null,
    };
  }
  return {
    happened: `Every model setting failed at least one required check ${where}`,
    means: `${cannotSeparate}; the Required checks column still shows how many required checks each setting passed.`,
    next: `${repeatMore} compare them on an easier task, or confirm in the attempt sections below that a correct solution can pass the failed checks.`,
    detail: null,
  };
}

/** Explains a summary call whose sentences are not in `summary.md`. */
export function summaryCallStatement(
  outcome: Exclude<SummaryCall['outcome'], { status: 'accepted' }>,
): Statement {
  const means =
    'The summary states each conclusion in a template sentence built from the facts of the run.';
  return outcome.status === 'rejected'
    ? {
        happened:
          "tevu rejected the summary model's sentences because they did not match the facts.",
        means,
        next: 'Nothing more is needed for this summary.',
        detail: outcome.reason,
      }
    : {
        happened: 'The summary model returned no sentences.',
        means,
        next: 'Before the next run, fix the cause in the technical detail.',
        detail: outcome.reason,
      };
}

/**
 * Counts every pair of attempt and required check of one task into exactly one
 * class. An attempt without a case result, a check without a result, and the
 * verdict `not-run` all count as not run.
 */
export function countRequiredChecks(
  attempts: readonly { result: CaseResult | undefined }[],
  checks: readonly CheckRecord[],
): RequiredCheckCounts {
  const required = checks.filter((check) => check.required);
  const counts: RequiredCheckCounts = {
    passed: 0,
    failed: 0,
    pending: 0,
    notRun: 0,
    total: required.length * attempts.length,
  };
  for (const { result } of attempts) {
    for (const check of required) {
      const verdict = result?.checks.find((candidate) => candidate.checkId === check.id)?.verdict;
      if (verdict === 'passed') {
        counts.passed += 1;
      } else if (verdict === 'failed') {
        counts.failed += 1;
      } else if (verdict === 'pending') {
        counts.pending += 1;
      } else {
        counts.notRun += 1;
      }
    }
  }
  return counts;
}

/** Formats counts as `<passed>/<total> passed`, then each nonzero other class. */
export function formatRequiredChecks(counts: RequiredCheckCounts): string {
  return [
    `${formatCount(counts.passed)}/${formatCount(counts.total)} passed`,
    ...(counts.failed > 0 ? [`${formatCount(counts.failed)} failed`] : []),
    ...(counts.pending > 0 ? [`${formatCount(counts.pending)} pending`] : []),
    ...(counts.notRun > 0 ? [`${formatCount(counts.notRun)} not run`] : []),
  ].join(', ');
}

const OUTCOME_ORDER: readonly CaseResult['outcome'][] = [
  'passed',
  'failed',
  'pending',
  'not-evaluated',
];

/**
 * Formats the outcomes of one setting's planned attempts: the outcome words
 * alone for one attempt, else `<k>/<planned> <outcome>` per outcome that
 * occurs, in the order passed, failed, pending, not-evaluated.
 */
export function formatOutcomeWords(
  outcomes: SummarySetting['outcomes'] | Record<CaseResult['outcome'], number>,
  planned: number,
): string {
  const counts: Record<CaseResult['outcome'], number> =
    'notEvaluated' in outcomes
      ? {
          passed: outcomes.passed,
          failed: outcomes.failed,
          pending: outcomes.pending,
          'not-evaluated': outcomes.notEvaluated,
        }
      : outcomes;
  const present = OUTCOME_ORDER.filter((outcome) => counts[outcome] > 0);
  return planned === 1
    ? present.join(', ')
    : present
        .map((outcome) => `${formatCount(counts[outcome])}/${formatCount(planned)} ${outcome}`)
        .join(', ');
}

function gradeStatement(happened: string, detail: string | null): string {
  return renderStatement({ happened, means: GRADE_MEANS, next: GRADE_NEXT, detail });
}

/**
 * Renders the wizard lines for one graded check from its grade and its
 * grading, in the same words as the report.
 */
export function gradeLines(
  grade: GradeRecord | null,
  grading: Pick<GradingSummary, 'grader' | 'call' | 'calls'> | null,
): string[] {
  if (grade === null) {
    return [
      gradeStatement(
        'tevu has no grading for this solution.',
        grading === null
          ? 'no grading artifact was saved for this case'
          : 'the grading has no grade for this check',
      ),
    ];
  }
  if (grade.status === 'pending') {
    return grading?.call.status === 'no-reply'
      ? [
          gradeStatement(
            `${noReplyClause(grading.call.cause, grading.calls.length)}.`,
            grading.call.reason,
          ),
        ]
      : [
          gradeStatement(
            "The grading model's reply had no usable verdict for this check.",
            grade.reason,
          ),
        ];
  }
  const grader =
    grading === null ? '' : ` (${grading.grader.model}, effort ${grading.grader.effort})`;
  const verdictLine = `Grader verdict: ${grade.verdict}${grader}: ${grade.rationale}`;
  return grade.verdict === 'undetermined'
    ? [
        verdictLine,
        gradeStatement(
          "The grading model could not decide this check from the task text and the solution's changes.",
          null,
        ),
      ]
    : [verdictLine];
}
