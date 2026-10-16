/** What a run saves and what reports derive from it. */

import type { CheckCategory, CheckEvaluator, ModelRole, SetupPhase } from './config';
import type { TevuError } from './errors';

/** Where a run's effective repeat came from: the configuration (set or defaulted) or `tevu run --repeat`. */
type RepeatSource = 'config' | 'cli';

/** Effective attempts per task/model pair for one run. */
export type RepeatSetting = { value: number; source: RepeatSource };

/** Identity of one benchmark case: one attempt of one task/model pair. */
export type CaseIdentity = {
  caseId: string;
  taskId: string;
  modelId: string;
  /** 1 through the run's `RepeatSetting.value`. */
  attempt: number;
  sourceCommit: string;
  model: string;
  effort: string;
  agent: string;
  /** Case timeout in milliseconds: the task's `timeout` when declared, otherwise `run.timeout`; one value for every case of a task. */
  timeoutMs: number;
};

/** One copied provider and the models its copied definition defines a price for; evidence for cost, never a price. */
export type CopiedProvider = {
  /** The provider's key in the copied `provider` map: an `agents.<agent>.providers[].id`. */
  id: string;
  /** Keys of the copied definition's `models` map that define a price; ascending UTF-16 code-unit order, no repeats. */
  pricedModels: string[];
};

/** One file every agent home of one agent received; `sha256` is 64 lowercase hexadecimal characters. */
export type AgentConfigurationFileRecord = { path: string; sha256: string };

/** Outcome of checking one requested effort against the variants its agent reports for the model. */
export type EffortCheck =
  | { status: 'verified' }
  | { status: 'unverified'; reason: string }
  | { status: 'unsupported'; reason: string };

/** The effort checks one run records. */
export type RunEffortChecks = {
  /** Exactly one key per configured model entry ID. */
  models: Record<string, EffortCheck>;
  /** The check of `roles.grader`; `null` when the configuration declares no grader. */
  grader: EffortCheck | null;
};

/** Renders an effort for run and report output together with its check. */
export function effortLabel(effort: string, check: EffortCheck | null | undefined): string {
  if (check === null || check === undefined) {
    return `${effort}, not checked`;
  }
  return check.status === 'verified' ? effort : `${effort}, ${check.status}`;
}

/**
 * Run-scoped projection of a task's stored configuration, read back through
 * {@link decodeRunConfig} rather than the live schema; see `src/config/run-snapshot.ts`.
 */
export type TaskRecord = {
  id: string;
  /** The task's `title` from the run's configuration snapshot; the reader-facing name of the task. */
  title: string;
  repositoryId: string;
  startCommit: string;
  description: string;
  source:
    | { kind: 'manual' }
    | { kind: 'jira-cloud'; issueKey: string; issueUrl: string }
    | { kind: 'github-issue'; issueKey: string; issueUrl: string };
  checks: CheckRecord[];
};

/** One task check as preserved for `report` and `assess`, without its command or manual detail. */
export type CheckRecord = {
  id: string;
  category: 'acceptance' | 'definition-of-done';
  description: string;
  required: boolean;
  evaluator: CheckEvaluator;
};

/** One preserved model entry: id, provider model string, and reasoning effort. */
export type ModelRecord = { id: string; model: string; effort: string };

/** One preserved repository: id and its resolved path; `github` is present exactly for a GitHub entry, as written. */
export type RepositoryRecord = { id: string; path: string; github?: string };

/** Decoded projection of a run's stored configuration, in snapshot order. */
export type RunConfigRecord = {
  tasks: TaskRecord[];
  models: ModelRecord[];
  repositories: RepositoryRecord[];
};

/** Versioned manifest of one benchmark run; `tools.agentVersions` is provenance only, never a gate. */
export type RunManifest = {
  schemaVersion: 1;
  runId: string;
  configDigest: string;
  /** Absolute path of the configuration file the run read; provenance only, never opened by `report` or `assess`. */
  configPath: string;
  startedAt: string;
  completedAt: string | null;
  host: {
    platform: 'linux' | 'darwin';
    nodeVersion: string;
  };
  tools: {
    gitVersion: string;
    agentVersions: Record<string, string | null>;
    /** One key per agent whose providers the run read; `[]` when its block names none. */
    agentConfigurationFiles: Record<string, AgentConfigurationFileRecord[]>;
    /** Same keys as `agentConfigurationFiles`: each read agent's `ProviderSnapshot.copiedProviders`. */
    copiedProviders: Record<string, CopiedProvider[]>;
  };
  execution: {
    concurrency: number;
    /** Default case timeout: `run.timeout` in milliseconds; each case's own value is `CaseIdentity.timeoutMs`. */
    caseTimeoutMs: number;
    repeat: RepeatSetting;
  };
  cases: CaseIdentity[];
  /** The effort checks of the validation the run followed; `report` and `assess` refuse a manifest without them. */
  efforts: RunEffortChecks;
  context?: {
    /** Decode through `decodeRunConfig`; never read directly as a `TevuConfig`. */
    config: unknown;
    capabilities: Record<string, AgentCapabilityReport>;
  };
};

/** Terminal and intermediate case lifecycle states; final results carry only terminal states. */
export type CaseLifecycle =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'evaluating'
  | 'completed'
  | 'process-failed'
  | 'timed-out'
  | 'cancelled'
  | 'infrastructure-failed';

/** Which termination stage ended a supervised process group. */
export type TerminationStage = 'none' | 'graceful' | 'forced';

/** Agent process evidence, independent of task acceptance. */
export type ProcessResult = {
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  terminationStage: TerminationStage;
};

/** Preserved runtime failure attached to a case independently of its check-derived outcome. */
export type FailureRecord = {
  error: TevuError;
  occurredAt: string;
};

/** Relative artifact paths for one case; `null` marks an explicitly missing artifact. */
type ArtifactIndex = {
  events: string | null;
  diagnostics: string | null;
  sessionExport: string | null;
  solutionPatch: string | null;
  checks: string | null;
  assessment: string | null;
  grading: string | null;
  result: string | null;
};

/** Versioned final record of one benchmark case. */
export type CaseResult = {
  schemaVersion: 1;
  identity: CaseIdentity;
  lifecycle: CaseLifecycle;
  process: ProcessResult | null;
  outcome: 'passed' | 'failed' | 'pending' | 'not-evaluated';
  checks: CheckResult[];
  metrics: BenchmarkMetrics;
  artifacts: ArtifactIndex;
  failure: FailureRecord | null;
  /** Present only when the case completed `applyCheckState`; absent for a task that declares neither key. */
  checkState?: CheckStateRecord;
  /** Present only when at least one setup command started for the case. */
  setup?: SetupRecord;
  context?: {
    sourceRepositoryPath: string;
    syntheticCommit: string;
    environment: EnvironmentVariableRecord[];
  };
};

/** Whether a metric was measured, with its source or the reason it is unavailable. */
type MetricAvailability =
  { status: 'available'; source: string } | { status: 'unavailable'; reason: string };

/** One normalized metric; `value: null` means unavailable, zero means a measured zero. */
export type MetricValue = {
  value: number | null;
  unit: 'count' | 'token' | 'millisecond' | 'USD';
  availability: MetricAvailability;
  scope: 'case' | 'root-session' | 'session-tree';
};

/** Complete normalized metric set for one case; schema version 1 uses root-session scope only. */
export type BenchmarkMetrics = {
  elapsed: MetricValue;
  inputTokens: MetricValue;
  outputTokens: MetricValue;
  reasoningTokens: MetricValue;
  cacheReadTokens: MetricValue;
  cacheWriteTokens: MetricValue;
  turns: MetricValue;
  apiCalls: MetricValue;
  apiErrors: MetricValue;
  toolCalls: MetricValue;
  skillCalls: MetricValue;
  cost: MetricValue;
};

/** Constructs an explicitly unavailable metric; never a zero and never an estimate. */
export function unavailableMetric(
  unit: MetricValue['unit'],
  reason: string,
  scope: MetricValue['scope'] = 'root-session',
): MetricValue {
  return { value: null, unit, availability: { status: 'unavailable', reason }, scope };
}

/** Constructs a complete metric set where every value is unavailable for one reason. */
export function unavailableBenchmarkMetrics(reason: string): BenchmarkMetrics {
  return {
    elapsed: unavailableMetric('millisecond', reason, 'case'),
    inputTokens: unavailableMetric('token', reason),
    outputTokens: unavailableMetric('token', reason),
    reasoningTokens: unavailableMetric('token', reason),
    cacheReadTokens: unavailableMetric('token', reason),
    cacheWriteTokens: unavailableMetric('token', reason),
    turns: unavailableMetric('count', reason),
    apiCalls: unavailableMetric('count', reason),
    apiErrors: unavailableMetric('count', reason),
    toolCalls: unavailableMetric('count', reason),
    skillCalls: unavailableMetric('count', reason),
    cost: unavailableMetric('USD', reason),
  };
}

/** Verdict and redacted, size-reported evidence for one configured check. */
export type CheckResult = {
  checkId: string;
  category: 'acceptance' | 'definition-of-done';
  verdict: 'passed' | 'failed' | 'pending' | 'not-run';
  evidence: string;
  durationMs: number | null;
};

/** One manual assessment verdict. */
export type AssessmentRecord = {
  checkId: string;
  verdict: 'passed' | 'failed';
  assessor: string;
  note: string;
  assessedAt: string;
};

/** A replaced operator verdict, retained in assessment history. */
export type ReplacedOperatorVerdict = AssessmentRecord & { source: 'operator'; replacedAt: string };

/** A replaced grader verdict, retained in assessment history. */
export type ReplacedGraderVerdict = {
  source: 'grader';
  checkId: string;
  verdict: GradeVerdict;
  rationale: string;
  grader: GraderIdentity;
  replacedAt: string;
};

/** Versioned assessment artifact; replacement moves prior records to history. */
export type AssessmentArtifact = {
  schemaVersion: 1;
  runId: string;
  caseId: string;
  revision: number;
  current: AssessmentRecord[];
  history: Array<ReplacedOperatorVerdict | ReplacedGraderVerdict>;
};

/** Pre-evaluation Git patch capturing the submitted solution. */
export type PatchArtifact = {
  caseId: string;
  content: string;
  isEmpty: boolean;
};

/** How one started setup command ended. */
type SetupCommandOutcome = 'passed' | 'failed' | 'timed-out' | 'launch-failed' | 'cancelled';

/** One started setup command. */
export type SetupCommandRecord = {
  phase: SetupPhase;
  argv: string[];
  /** `null` when the process did not start or ended without an exit code. */
  exitCode: number | null;
  /** The process adapter's duration; `null` when the process did not start. */
  durationMs: number | null;
  outcome: SetupCommandOutcome;
};

/** Setup evidence of one case. */
type SetupRecord = {
  /** Run-relative path of each phase's log; `null` when the phase started no command or its log write failed. */
  logs: { beforeAgent: string | null; beforeChecks: string | null };
  /** Every started setup command of the case, in execution order. */
  commands: SetupCommandRecord[];
};

/** Check-state evidence; every path list is sorted ascending by `<` comparison and holds no duplicates. */
export type CheckStateRecord = {
  /** null when the request's `restore` is empty. */
  restore: RestoreRecord | null;
  /** null when the request's `overlay` is null. */
  overlay: OverlayRecord | null;
};

/** Restore-step evidence: matched paths returned to the base tree and everything removed. */
export type RestoreRecord = {
  /** Matched base-tree paths whose worktree entry differed from the base tree and was rewritten. */
  restored: string[];
  /** Every non-directory entry the restore step deleted: matched untracked entries, blockers, and everything beneath deleted directories. */
  removed: string[];
};

/** Overlay-step evidence: every file the snapshot wrote and everything removed to make room for it. */
export type OverlayRecord = {
  /** Every file entry of the snapshot, with the SHA-256 of the bytes written. */
  files: OverlayFileRecord[];
  /** Every non-directory entry the overlay step deleted as a blocker, including everything beneath deleted directories. */
  removed: string[];
};

/** One overlay file; `sha256` is 64 lowercase hexadecimal characters. */
export type OverlayFileRecord = { path: string; sha256: string };

/** Name, classification, and recipient of one passed variable; values are never recorded. */
export type EnvironmentVariableRecord = {
  name: string;
  classification: 'fixed' | 'secret' | 'ordinary';
  recipient: 'agent' | 'evaluator';
};

/** One raw agent event record: opaque outside its adapter, already redacted, serializable as one JSON value. */
export type AgentEventRecord = unknown;

/** One raw root-session export: opaque outside its adapter, already redacted, one JSON object. */
export type AgentSessionExport = { readonly [field: string]: unknown };

export type CapabilityAvailability = 'available' | 'unavailable';

/** One probed capability; `name` is a display label, unique within its report. */
export type AgentCapability = {
  name: string;
  required: boolean;
  availability: CapabilityAvailability;
};

/** Probe result; `detectedVersion` is provenance only and never gates behavior. */
export type AgentCapabilityReport = {
  executable: string;
  detectedVersion: string | null;
  capabilities: AgentCapability[];
  isolation: { denyOutsideWorktree: CapabilityAvailability };
};

/** Model metrics an agent derives from its records; evaluation adds `elapsed`. */
export type AgentMetrics = Omit<BenchmarkMetrics, 'elapsed'>;

/** Constructs a complete agent metric set where every value is unavailable for one reason. */
export function unavailableAgentMetrics(reason: string): AgentMetrics {
  return {
    inputTokens: unavailableMetric('token', reason),
    outputTokens: unavailableMetric('token', reason),
    reasoningTokens: unavailableMetric('token', reason),
    cacheReadTokens: unavailableMetric('token', reason),
    cacheWriteTokens: unavailableMetric('token', reason),
    turns: unavailableMetric('count', reason),
    apiCalls: unavailableMetric('count', reason),
    apiErrors: unavailableMetric('count', reason),
    toolCalls: unavailableMetric('count', reason),
    skillCalls: unavailableMetric('count', reason),
    cost: unavailableMetric('USD', reason),
  };
}

/** One grader's verdict for a graded check: whether the patch satisfies it, or that the evidence does not decide. */
export type GradeVerdict = 'passed' | 'failed' | 'undetermined';

/** The run's resolved `roles.grader`. */
export type GraderIdentity = ModelRole;

/** One graded check's derived grade: a verdict with its rationale, or pending with the reason it has none. */
export type GradeRecord =
  | {
      checkId: string;
      category: CheckCategory;
      status: 'graded';
      verdict: GradeVerdict;
      rationale: string;
    }
  | { checkId: string; category: CheckCategory; status: 'pending'; reason: string };

/** Why a grader call returned no reply: the model stopped early, its session held a tool call, or anything else. */
type GraderNoReplyCause = 'unfinished' | 'tool-call' | 'other';

type GraderNoReply = { status: 'no-reply'; cause: GraderNoReplyCause; reason: string };

/** The reply a grading's grades come from, or why it has none. */
type GraderCallRecord = { status: 'replied'; reply: string } | GraderNoReply;

/** One grader call: how it ended, its own metrics, and the redacted records it left. */
type GraderCall = {
  outcome: { status: 'replied' } | GraderNoReply;
  metrics: AgentMetrics;
  events: AgentEventRecord[];
  diagnostics: string;
  session: AgentSessionExport | null;
};

/** One case's grading: the grader identity, its raw call outcome, its calls, its metrics, and every graded check's grade. */
export type CaseGrading = {
  grader: GraderIdentity;
  /** Describes the last element of `calls`; with no call, why the grader was not called. */
  call: GraderCallRecord;
  /** Every grader call tevu made for the case, in call order; empty when it made none. */
  calls: GraderCall[];
  /** `sumGraderCallMetrics` over `calls[].metrics`; every metric unavailable with `call.reason` when `calls` is empty. */
  metrics: AgentMetrics;
  /** One per graded check: acceptance, then done, configuration order. */
  grades: GradeRecord[];
};

/** Versioned case artifact: `cases/<case-id>/grading.json`. */
export type GradingArtifact = CaseGrading & { schemaVersion: 1; runId: string; caseId: string };

/** A grading as the normalized run model holds it: its calls without their records. */
export type GradingSummary = Omit<GradingArtifact, 'calls'> & {
  calls: Array<Pick<GraderCall, 'outcome' | 'metrics'>>;
};

/** One measurement of a setting: the lower median of the attempts that reported it. */
export type SummaryMeasure =
  | { status: 'unknown' }
  | { status: 'known'; value: number; text: string; reportedAttempts: number };

/** Attempts of one setting that left the comparison, by class. */
export type SummaryDropout = {
  timedOut: number;
  failedToRun: number;
  /** Distinct labels of the failed-to-run attempts, ascending by UTF-16 code unit. */
  failedToRunLabels: string[];
  waiting: number;
};

/** One model setting of one task, in comparison-table row order. */
export type SummarySetting = {
  name: string;
  model: string;
  effort: string;
  planned: number;
  outcomes: { passed: number; failed: number; pending: number; notEvaluated: number };
  requiredChecks: {
    passed: number;
    failed: number;
    pending: number;
    notRun: number;
    total: number;
  };
  /** Whether every planned attempt of the setting passed. */
  didTask: boolean;
  cost: SummaryMeasure;
  elapsed: SummaryMeasure;
  /** `null` when no attempt dropped out. */
  dropout: SummaryDropout | null;
};

/** How much lower the leader's value is than the next setting's. */
export type SummaryMargin = { kind: 'times' | 'percent'; value: string };

/** The cost or speed comparison among the settings that did the task. */
export type SummaryComparison =
  | { kind: 'none-did-the-task' }
  | { kind: 'only-setting'; leader: string }
  | { kind: 'not-enough-data'; unknown: string[] }
  | {
      kind: 'leader' | 'tie';
      leaders: string[];
      value: string;
      next: { value: string; margin: SummaryMargin | null } | null;
      unknown: string[];
      partial: Array<{ name: string; reportedAttempts: number }>;
    };

/** Every fact the summary states about one task. */
export type SummaryFacts = {
  task: string;
  repository: string;
  when: string;
  repeat: number;
  requiredChecksPerAttempt: number;
  settings: SummarySetting[];
  separation: 'passed' | 'failed' | null;
  cost: SummaryComparison;
  speed: SummaryComparison;
};

/** The aspects a summary concludes on. */
export type SummaryAspect = 'correctness' | 'cost' | 'speed';

/** The three conclusions of one task's summary. */
export type ConclusionTexts = Record<SummaryAspect, string>;

/** One summary call; its metrics never enter a setting. */
export type SummaryCall = {
  model: ModelRole;
  outcome:
    | { status: 'accepted'; reply: string }
    | { status: 'rejected'; reply: string; reason: string }
    | { status: 'no-reply'; reason: string };
  metrics: AgentMetrics;
};

/** One task's saved conclusions: the model's when `call.outcome.status` is `accepted`, else the template's. */
export type TaskConclusions = {
  taskId: string;
  facts: SummaryFacts;
  /** The comparison table of `summary.md`, saved so a later `tevu report` renders the same rows. */
  table: string[];
  conclusions: ConclusionTexts;
  /** `null` when no summary call was made: no `roles.summary` was declared, or a cancellation skipped the call. */
  call: SummaryCall | null;
};

/** `conclusions.json` at the run root. */
export type ConclusionsArtifact = { schemaVersion: 1; runId: string; tasks: TaskConclusions[] };

/** Terminal lines rendered from the same report model as the Markdown, so both describe a state in the same words. */
export type ReportSummary = {
  /** One entry per planned attempt, in comparison order. */
  attempts: Array<{ caseId: string; lines: string[] }>;
  /** One line per run finding, in report order. */
  findings: string[];
};

/** Regenerated normalized JSON and Markdown report content for one run, with the terminal summary of the same model. */
export type ReportResult = {
  runId: string;
  normalizedJson: string;
  markdown: string;
  /** Not persisted: `ArtifactStore.writeReport` writes `normalizedJson` and `markdown` only. */
  summary: ReportSummary;
  /** The text of `summary.md`, written by `ArtifactStore.writeSummary`; never part of `normalizedJson`. */
  summaryMarkdown: string;
};

/** Run-level finding for cases without a final result, cleanup warnings, and cancellations. */
export type RunFinding = {
  severity: 'error' | 'warning';
  caseId: string | null;
  message: string;
};

/** Versioned final record of one benchmark run, including its aggregated exit status. */
export type RunResult = {
  schemaVersion: 1;
  manifest: RunManifest;
  cases: CaseResult[];
  findings: RunFinding[];
  exitCode: 0 | 1 | 2 | 130;
};
