/**
 * Shared domain contracts for tevu: the configuration model, results, typed
 * errors, run and case records, the agent-independent adapter port, and
 * adapter interfaces.
 *
 * This module must stay free of boundary dependencies: no Commander.js, Clack,
 * Execa, Git commands, Jira transport code, or Node.js process globals.
 */

/** Result of a fallible module contract; errors never cross boundaries as thrown exceptions. */
export type TevuResult<T, K extends TevuError['kind']> =
  { ok: true; value: T } | { ok: false; error: Extract<TevuError, { kind: K }> };

/** One aggregated parse or validation finding with a stable field, task, or check identifier. */
export type ValidationFinding = {
  severity: 'error' | 'warning';
  identifier: string;
  message: string;
};

/** Why the configuration file could not be read. */
export type ConfigReadCause = 'not-found' | 'permission-denied' | 'not-a-file' | 'unreadable';

/** Error kinds a configuration load can produce. */
export type LoadConfigErrorKind = 'ConfigParseError' | 'ConfigValidationError' | 'ConfigReadError';

/** Tracker behind an imported task source. */
type IssueTrackerKind = 'jira-cloud' | 'github-issue';

/** Exhaustive typed error union for every tevu failure crossing a module boundary. */
export type TevuError =
  | { kind: 'ConfigParseError'; findings: ValidationFinding[] }
  | { kind: 'ConfigValidationError'; findings: ValidationFinding[] }
  | {
      kind: 'ConfigReadError';
      /** Absolute path the loader probed: `path.resolve(requestedPath)`. */
      path: string;
      /** Path handed to the loader: `--config` exactly as given, or an absolute search candidate; the not-found hints embed it. */
      requestedPath: string;
      cause: ConfigReadCause;
    }
  | {
      kind: 'ConfigNotFoundError';
      /** Absolute paths the search read, in search order; the first is the current-directory file, which `task add` creates. */
      searchedPaths:
        [currentDirectoryFile: string] | [currentDirectoryFile: string, userFile: string];
    }
  | { kind: 'PrerequisiteError'; tool: string; expected: string; actual?: string }
  | { kind: 'SourceMaterializationError'; taskId: string; reason: string }
  | { kind: 'IsolationError'; caseId: string; reason: string }
  | {
      kind: 'IssueImportError';
      tracker: IssueTrackerKind;
      reference: string;
      /** HTTP status; only the Jira Cloud adapter sets it. */
      status?: number;
      reason: string;
    }
  | {
      kind: 'AgentProcessError';
      agent: string;
      caseId: string;
      exitCode: number | null;
      signal: string | null;
    }
  | {
      kind: 'AgentProtocolError';
      agent: string;
      context: { phase: 'probe' } | { phase: 'case'; caseId: string };
      line?: number;
      reason: string;
    }
  | { kind: 'CaseTimeoutError'; caseId: string; timeoutMs: number }
  | { kind: 'EvaluationError'; caseId: string; checkId: string; reason: string }
  | {
      kind: 'AssessmentConflictError';
      runId: string;
      caseId: string;
      reason: string;
    }
  | { kind: 'ArtifactError'; operation: string; reason: string }
  | { kind: 'RedactionError'; reason: string }
  | { kind: 'CancellationError'; activeCaseIds: string[] }
  | { kind: 'CheckStateError'; step: 'restore' | 'overlay'; reason: string }
  | { kind: 'SetupError'; phase: SetupPhase; argv: string[]; reason: string };

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

/** Settings shared by every benchmark case. */
type RunSettings = {
  output_dir: string;
  concurrency: number;
  repeat: number;
  timeout: string;
  stop_grace: string;
  check_timeout?: string;
};

/** Parsed agent block settings; `secrets` and `env` default to `[]`. */
type AgentSettings = {
  command: string;
  secrets: string[];
  env: string[];
};

/** Parsed Jira Cloud connection settings. */
export type JiraTrackerSettings = {
  url: string;
  email: string;
  token: string;
};

/** One repository setup command: executable and literal arguments, no shell; the shape of a check's `run`. */
export type SetupCommand = [string, ...string[]];

/** A repository's setup block; a phase key is present only when its list holds at least one command. */
export interface RepositorySetup {
  before_agent?: SetupCommand[];
  before_checks?: SetupCommand[];
  timeout: string;
  env: string[];
}

/** One configured source repository. */
export type RepositoryDefinition = {
  id: string;
  path: string;
  setup?: RepositorySetup;
};

/** One resolved benchmark model entry: what the benchmark compares. */
export interface ModelDefinition {
  id: string;
  model: `${string}/${string}`;
  effort: string;
  agent: string;
}

/** One-time tracker import snapshot stored on a task. */
type ImportedTaskSource = {
  kind: 'jira' | 'github';
  key: string;
  url: string;
  imported_at: string;
  title: string;
  body: string;
};

/** A command check's resolved shape: literal argv, no shell, and every default materialized. */
export interface CommandCheck {
  id: string;
  description: string;
  run: [string, ...string[]];
  timeout: string;
  exit_codes: number[];
  env: string[];
  required: boolean;
}

/** A manual check's resolved shape: assessed by a human through `tevu assess`. */
interface ManualCheck {
  id: string;
  description: string;
  manual: true;
  required: boolean;
}

/** One acceptance or done check: a command check or a manual check. */
export type CheckDefinition = CommandCheck | ManualCheck;

/** One resolved acceptance-driven benchmark task pinned to a repository commit. */
export interface TaskDefinition {
  id: string;
  title: string;
  repo: string;
  base_commit: string;
  /** Present only when the file declares it: the agent time limit of every case of this task, replacing `run.timeout`. */
  timeout?: string;
  prompt: string;
  description: string;
  source?: ImportedTaskSource;
  readiness: string[];
  checks: {
    /** Present only when the file declares it; `[]` declares nothing to restore. */
    restore?: string[];
    /** Present only when the file declares it; absolute after `resolveConfig`. */
    overlay?: string;
    acceptance: CheckDefinition[];
    done: CheckDefinition[];
  };
}

/** One resolved tevu configuration: every default materialized, ready for its consumers. */
export interface TevuConfig {
  version: 1;
  run: RunSettings;
  agents: Record<string, AgentSettings>;
  trackers?: { jira?: JiraTrackerSettings };
  repositories: RepositoryDefinition[];
  models: ModelDefinition[];
  tasks: TaskDefinition[];
}

/**
 * Run-scoped projection of a task's stored configuration, read back through
 * {@link decodeRunConfig} rather than the live schema; see `src/config/run-snapshot.ts`.
 */
export type TaskRecord = {
  id: string;
  repositoryId: string;
  startCommit: string;
  description: string;
  source:
    | { kind: 'manual'; reference: string | null; title: string }
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
  evaluator: 'command' | 'manual';
};

/** One preserved model entry: id, provider model string, and reasoning effort. */
export type ModelRecord = { id: string; model: string; effort: string };

/** One preserved repository: id and its resolved path. */
export type RepositoryRecord = { id: string; path: string };

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
  tools: { gitVersion: string; agentVersions: Record<string, string | null> };
  execution: {
    concurrency: number;
    /** Default case timeout: `run.timeout` in milliseconds; each case's own value is `CaseIdentity.timeoutMs`. */
    caseTimeoutMs: number;
    repeat: RepeatSetting;
  };
  cases: CaseIdentity[];
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
  result: string | null;
};

/** Run-relative paths of every artifact one case owns inside its run directory. */
export type CaseArtifactPathIndex = {
  events: string;
  diagnostics: string;
  sessionExport: string;
  solutionPatch: string;
  checks: string;
  assessment: string;
  result: string;
  setupBeforeAgent: string;
  setupBeforeChecks: string;
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

/** Versioned assessment artifact; replacement moves prior records to history. */
export type AssessmentArtifact = {
  schemaVersion: 1;
  runId: string;
  caseId: string;
  revision: number;
  current: AssessmentRecord[];
  history: Array<AssessmentRecord & { replacedAt: string }>;
};

/** Injectable time source; wall-clock reads must not come from process globals in pure modules. */
export interface Clock {
  now(): Date;
}

/** Generates a run ID: UTC basic timestamp plus a collision-resistant lowercase suffix. */
type RunIdGenerator = (startedAt: Date) => string;

/** Host platform and tool versions probed at the adapter boundary for the run manifest. */
export type HostProbe = {
  platform: 'linux' | 'darwin';
  nodeVersion: string;
  gitVersion: string;
};

/** Successful resolution of a task's pinned commit inside its configured repository. */
export type SourceValidation = {
  repositoryId: string;
  requestedCommit: string;
  resolvedCommit: string;
};

/** One sealed case workspace: private repository, worktree, and runtime directory. */
export type CaseWorkspace = {
  caseId: string;
  sourceRepositoryPath: string;
  sourceCommit: string;
  repositoryDirectory: string;
  worktreeDirectory: string;
  runtimeDirectory: string;
  branch: string;
  syntheticCommit: string;
};

/** Pre-evaluation Git patch capturing the submitted solution. */
export type PatchArtifact = {
  caseId: string;
  content: string;
  isEmpty: boolean;
};

/** A repository setup phase, named by its configuration key. */
export type SetupPhase = 'before_agent' | 'before_checks';

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

/** The worktree state `before_agent` left, as a tree in a private object directory outside the case repository. */
export type PatchBase = { readonly tree: string; readonly objectDirectory: string };

/** What `applyCheckState` does to one worktree; built by the orchestrator from the task and the run's overlay snapshot. */
export type CheckStateRequest = {
  /** Patterns from `checks.restore`; empty means no restore step. */
  restore: readonly string[];
  /** The run's snapshot of `checks.overlay`, or null when the task declares none. */
  overlay: OverlaySnapshot | null;
};

/** One overlay directory as `readOverlay` read it, sorted ascending by `path` with `<` comparison. */
export type OverlaySnapshot = readonly OverlayEntry[];

/** `path` follows the recorded-path rules below; `executable` is the owner-executable bit (`mode & 0o100`). */
export type OverlayEntry =
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; executable: boolean; bytes: Uint8Array };

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

/**
 * Sealed Git source validation, case materialization, patch capture, disposal,
 * and the check-state setup (restore and overlay) that runs between patch
 * capture and acceptance checks.
 *
 * Also records the worktree state before `before_agent` runs, through
 * {@link GitWorkspaceAdapter.snapshotPatchBase}, so a later patch capture can
 * diff against it instead of the case's synthetic root commit.
 */
export interface GitWorkspaceAdapter {
  validateSource(
    repository: RepositoryDefinition,
    commit: string,
  ): Promise<TevuResult<SourceValidation, 'SourceMaterializationError'>>;
  createIsolatedCase(
    identity: CaseIdentity,
    repository: RepositoryDefinition,
  ): Promise<TevuResult<CaseWorkspace, 'SourceMaterializationError' | 'IsolationError'>>;
  /** Records the worktree state as the patch base; no commit, ref, index change, or object in the case repository. */
  snapshotPatchBase(workspace: CaseWorkspace): Promise<TevuResult<PatchBase, 'ArtifactError'>>;
  /** Diffs against `base.tree` when given; otherwise against `workspace.syntheticCommit`, exactly as without a base. */
  capturePatch(
    workspace: CaseWorkspace,
    base?: PatchBase,
  ): Promise<TevuResult<PatchArtifact, 'SourceMaterializationError' | 'ArtifactError'>>;
  /** Reads an overlay directory into a snapshot without writing; fails with the first defect of the overlay validation rules. */
  readOverlay(directory: string): Promise<TevuResult<OverlaySnapshot, 'CheckStateError'>>;
  /** Restores the request's matched paths to the base tree, then copies the overlay onto the worktree root. */
  applyCheckState(
    workspace: CaseWorkspace,
    request: CheckStateRequest,
  ): Promise<TevuResult<CheckStateRecord, 'CheckStateError'>>;
  dispose(workspace: CaseWorkspace): Promise<TevuResult<void, 'ArtifactError'>>;
  isReadable?(workspace: CaseWorkspace): Promise<boolean>;
}

/** Name, classification, and recipient of one passed variable; values are never recorded. */
export type EnvironmentVariableRecord = {
  name: string;
  classification: 'fixed' | 'secret' | 'ordinary';
  recipient: 'agent' | 'evaluator';
};

/** Complete replacement environment for one case recipient, plus its value-free manifest. */
export type IsolatedEnvironment = {
  caseId: string;
  recipient: 'agent' | 'evaluator';
  homeDirectory: string;
  temporaryDirectory: string;
  variables: Record<string, string>;
  variableManifest: EnvironmentVariableRecord[];
};

/** Immutable run-level snapshot of the parent PATH and configured variable values. */
export type ParentEnvironmentSnapshot = {
  path: string;
  agentValues: Record<string, string>;
  ordinaryEvaluatorValues: Record<string, string>;
  secretValues: string[];
};

/** Which environment variable names reach each recipient; never carries values. */
export type EnvironmentVariableNames = {
  /** One entry per `agents.<name>` block in configuration key order; each list in configuration order. */
  agents: Readonly<Record<string, { secrets: readonly string[]; env: readonly string[] }>>;
  /** Exactly `evaluatorEnvironmentNames(config)`, in its order. */
  ordinaryEvaluator: readonly string[];
  /** The variable `trackers.jira.token` references; the key is absent without a Jira tracker. */
  jiraTokenVariable?: string;
};

/** Agent and evaluator replacement environments for one case. */
export type CaseEnvironments = {
  agent: IsolatedEnvironment;
  evaluator: IsolatedEnvironment;
};

/** Builds the run-level parent snapshot and per-case isolated replacement environments. */
export interface EnvironmentAdapter {
  snapshotParent(
    names: EnvironmentVariableNames,
  ): TevuResult<ParentEnvironmentSnapshot, 'PrerequisiteError'>;
  createCaseEnvironments(
    workspace: CaseWorkspace,
    snapshot: ParentEnvironmentSnapshot,
    names: EnvironmentVariableNames,
    agent: string,
  ): Promise<TevuResult<CaseEnvironments, 'IsolationError'>>;
}

/** Redacted, bounded process output capture with its true total size. */
export type RedactedCapture = {
  text: string;
  totalBytes: number;
  truncated: boolean;
};

/** Literal-argv evaluator process request with an explicit replacement environment. */
export type EvaluatorProcessRequest = {
  argv: [string, ...string[]];
  cwd: string;
  environment: Record<string, string>;
  timeoutMs: number;
  terminationGraceMs: number;
  cancellation?: AbortSignal;
};

/** Evaluator process evidence; launch failure is evidence for a failed check, not an error. */
export type EvaluatorProcessResult =
  | {
      launched: true;
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
      timedOut: boolean;
      terminationStage: TerminationStage;
      stdout: RedactedCapture;
      stderr: RedactedCapture;
    }
  | { launched: false; reason: string };

/** Runs one benchmark-task acceptance command, or one repository setup command, without a shell. */
export interface EvaluatorProcessAdapter {
  run(request: EvaluatorProcessRequest): Promise<EvaluatorProcessResult>;
}

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

export type AgentRunInput = {
  identity: CaseIdentity;
  prompt: string;
  worktreeDirectory: string;
  environment: IsolatedEnvironment;
  timeoutMs: number;
  terminationGraceMs: number;
  cancellation: AbortSignal;
  onEvent: (event: AgentEventRecord) => Promise<TevuResult<void, 'ArtifactError'>>;
  onDiagnostic: (line: string) => Promise<TevuResult<void, 'ArtifactError'>>;
  onProcess?: (result: AgentRunResult) => void;
};

export type AgentRunResult = {
  process: ProcessResult;
  sessionId: string | null;
  parseFindings: string[];
};

export type AgentMetricsInput = {
  caseId: string;
  /** The run's `AgentRunResult.sessionId`; `null` makes the adapter identify the root session from the records. */
  sessionId: string | null;
  events: readonly AgentEventRecord[];
  sessionExport: AgentSessionExport | null;
  exportUnavailableReason?: string;
};

export interface AgentAdapter {
  probe(): Promise<TevuResult<AgentCapabilityReport, 'PrerequisiteError' | 'AgentProtocolError'>>;
  run(
    input: AgentRunInput,
  ): Promise<
    TevuResult<
      AgentRunResult,
      'AgentProcessError' | 'AgentProtocolError' | 'CaseTimeoutError' | 'CancellationError'
    >
  >;
  exportSession(
    sessionId: string,
    environment: IsolatedEnvironment,
  ): Promise<TevuResult<AgentSessionExport, 'AgentProcessError' | 'AgentProtocolError'>>;
  normalizeMetrics(input: AgentMetricsInput): TevuResult<AgentMetrics, 'AgentProtocolError'>;
}

/** Adapters keyed by agent name; built only in `src/index.ts`. */
export type AgentRegistry = ReadonlyMap<string, AgentAdapter>;

/** Input for one supervised literal-argv process with a replacement environment. */
export type ManagedProcessRequest = {
  argv: [string, ...string[]];
  cwd: string;
  environment: Record<string, string>;
  timeoutMs: number;
  terminationGraceMs: number;
  cancellation?: AbortSignal;
  secretValues?: readonly string[];
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  maxCaptureBytes?: number;
  /**
   * With "structured", stdout bypasses the generic chunk-level text redaction
   * so structured records can be parsed from unmangled bytes; the caller then
   * owns redacting every decoded record before any persistent, terminal, or
   * callback sink. The bounded capture and byte totals stay truthful to the
   * raw stream. Defaults to "text".
   */
  stdoutRedaction?: 'text' | 'structured';
  /**
   * Text the process reads on stdin, UTF-8 encoded and followed by
   * end-of-file; delivered unredacted and never copied into the result.
   * Text the process leaves unread is discarded without an error. When
   * absent, stdin is `/dev/null`.
   */
  stdinText?: string;
};

/**
 * Evidence that a process could not be started; the reason is already
 * redacted. `code` carries the Node.js-specific error code (e.g. `ENOENT`)
 * when one is available; the `cancelled before launch` result never sets it.
 */
export type ManagedProcessLaunchFailure = { launched: false; reason: string; code?: string };

/** Complete evidence for one launched and settled process. */
export type ManagedProcessCompletion = {
  launched: true;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  terminationStage: TerminationStage;
  stdout: RedactedCapture;
  stderr: RedactedCapture;
};

/** Outcome of one managed process; launch failure is evidence, not an exception. */
export type ManagedProcessResult = ManagedProcessCompletion | ManagedProcessLaunchFailure;

/** Supervises one literal-argv process; launch failure is evidence, never an exception. */
export type ManagedProcessRunner = (
  request: ManagedProcessRequest,
) => Promise<ManagedProcessResult>;

/** Replaces every configured credential-secret value before a sink; injected by composition. */
export type Redactor = (text: string) => string;

/**
 * Credential-secret redaction over the current secret values; injected into
 * agent adapters. `redactText` passes through any exception the injected
 * redactor throws; `redactValue` never throws. Implementations of
 * `secretValues` must not throw.
 */
export interface SecretRedactor {
  secretValues(): readonly string[];
  redactText(text: string): string;
  /** Redacts every string, keys included, of a decoded JSON value; a cycle or a failed redactor yields `ArtifactError` whose reason carries no value. */
  redactValue(value: unknown): TevuResult<unknown, 'ArtifactError'>;
}

/** One tracker issue read once during task creation. */
export type IssueSnapshot = {
  /** Jira: issue key. GitHub: `OWNER/REPO#NUMBER` from gh's `url` field. */
  issueKey: string;
  issueUrl: string;
  /** Jira: summary. GitHub: title. */
  summary: string;
  /** Jira: plain-text projection. GitHub: Markdown body, unmodified. */
  description: string;
};

/** Read-only, one-time issue import shared by every tracker adapter. */
export interface IssueTrackerAdapter {
  readIssue(
    reference: string,
  ): Promise<TevuResult<IssueSnapshot, 'IssueImportError' | 'CancellationError'>>;
}

/** Exclusive assessment lock held across replacement and derived regeneration. */
export interface AssessmentLock {
  runId: string;
  caseId: string;
  release(): Promise<TevuResult<void, 'ArtifactError'>>;
}

/** Regenerated normalized JSON and Markdown report content for one run. */
export type ReportResult = {
  runId: string;
  normalizedJson: string;
  markdown: string;
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

/**
 * Versioned atomic artifact storage: run start, per-case appends and writes,
 * finalization, assessment revision under lock, and regeneration reads.
 */
export interface ArtifactStore {
  caseArtifactPaths(caseId: string): CaseArtifactPathIndex;
  startRun(manifest: RunManifest): Promise<TevuResult<void, 'ArtifactError'>>;
  appendEvent(caseId: string, event: AgentEventRecord): Promise<TevuResult<void, 'ArtifactError'>>;
  appendDiagnostic(caseId: string, line: string): Promise<TevuResult<void, 'ArtifactError'>>;
  writeSessionExport(
    caseId: string,
    sessionExport: AgentSessionExport,
  ): Promise<TevuResult<void, 'ArtifactError'>>;
  writePatch(caseId: string, patch: PatchArtifact): Promise<TevuResult<void, 'ArtifactError'>>;
  writeChecks(caseId: string, checks: CheckResult[]): Promise<TevuResult<void, 'ArtifactError'>>;
  /** Redacts the whole text, failing closed, then atomically writes the phase log in the case directory. */
  writeSetupLog(
    caseId: string,
    phase: SetupPhase,
    text: string,
  ): Promise<TevuResult<void, 'ArtifactError'>>;
  finalizeCase(result: CaseResult): Promise<TevuResult<void, 'ArtifactError'>>;
  /**
   * Atomically replaces one case's derived result record inside an existing
   * run directory. Unlike `finalizeCase`, this is the derived-write contract
   * for closed (already finalized) runs used by assessment and report
   * regeneration; it never requires an active run.
   */
  replaceCaseResult(runId: string, result: CaseResult): Promise<TevuResult<void, 'ArtifactError'>>;
  finalizeRun(result: RunResult): Promise<TevuResult<void, 'ArtifactError'>>;
  writeReport(runId: string, report: ReportResult): Promise<TevuResult<void, 'ArtifactError'>>;
  readRunManifest(runId: string): Promise<TevuResult<RunManifest, 'ArtifactError'>>;
  readRunResult(runId: string): Promise<TevuResult<RunResult, 'ArtifactError'>>;
  readCaseResult(runId: string, caseId: string): Promise<TevuResult<CaseResult, 'ArtifactError'>>;
  readEvents(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AgentEventRecord[], 'ArtifactError'>>;
  readSessionExport(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AgentSessionExport | null, 'ArtifactError'>>;
  readChecks(runId: string, caseId: string): Promise<TevuResult<CheckResult[], 'ArtifactError'>>;
  readAssessment(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AssessmentArtifact | null, 'ArtifactError'>>;
  acquireAssessmentLock(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AssessmentLock, 'AssessmentConflictError' | 'ArtifactError'>>;
  replaceAssessment(artifact: AssessmentArtifact): Promise<TevuResult<void, 'ArtifactError'>>;
}

/** Reads and atomically replaces the raw configuration document text. */
export interface ConfigStore {
  /**
   * Resolves `false` only when probing the resolved absolute path fails with
   * `ENOENT`. Every other failure resolves `true`, so `readText` reports the
   * precise `ConfigReadError`.
   */
  exists(path: string): Promise<boolean>;
  /**
   * Fails with `PrerequisiteError` only when probing the directory of the
   * resolved absolute path fails with `ENOENT`; every other outcome succeeds.
   */
  requireDirectory(path: string): Promise<TevuResult<void, 'PrerequisiteError'>>;
  readText(path: string): Promise<TevuResult<string, 'ConfigReadError'>>;
  replaceText(path: string, text: string): Promise<TevuResult<void, 'ArtifactError'>>;
}

/** Local prerequisite probes used by validation stages 3, 4, and 6. */
export interface PrerequisiteAdapter {
  probeHost(): Promise<TevuResult<HostProbe, 'PrerequisiteError'>>;
  hasEnvironmentVariable(name: string): boolean;
  probeWritableDirectory(directory: string): Promise<TevuResult<void, 'PrerequisiteError'>>;
}

/** Effects injected into the aggregate validation use case. */
export type ValidationDependencies = {
  git: GitWorkspaceAdapter;
  agents: AgentRegistry;
  environments: EnvironmentAdapter;
  prerequisites: PrerequisiteAdapter;
};

/** Aggregate validation outcome; any error-severity finding makes the configuration invalid. */
export type ValidationReport = {
  valid: boolean;
  findings: ValidationFinding[];
  capabilities: Record<string, AgentCapabilityReport>;
};

/** Deterministic attempt-major execution plan derived purely from configuration. */
export type BenchmarkPlan = {
  config: TevuConfig;
  /** Absolute path of the file `config` was loaded from; `runBenchmark` copies it into `RunManifest.configPath`. */
  configPath: string;
  cases: CaseIdentity[];
  repeat: RepeatSetting;
  concurrency: number;
  /** `config.run.timeout` in milliseconds; `runBenchmark` records it as `RunManifest.execution.caseTimeoutMs`. */
  defaultCaseTimeoutMs: number;
  terminationGraceMs: number;
  artifactsDirectory: string;
};

/** Effects injected into the benchmark orchestration use case. */
export type RunDependencies = {
  git: GitWorkspaceAdapter;
  agents: AgentRegistry;
  artifacts: ArtifactStore;
  evaluatorProcesses: EvaluatorProcessAdapter;
  environments: EnvironmentAdapter;
  prerequisites: PrerequisiteAdapter;
  clock: Clock;
  generateRunId: RunIdGenerator;
  configDigest: (config: TevuConfig) => string;
  redact: (text: string) => string;
  cancellation: AbortSignal;
  onLifecycle?: (caseId: string, lifecycle: CaseLifecycle) => void;
};

/** One manual verdict decision captured for a pending or replaced manual check. */
export type AssessmentDecision = {
  checkId: string;
  verdict: 'passed' | 'failed';
  assessor: string;
  note: string;
  replaceExisting: boolean;
};

/** Typed assessment answers handed to the assessment use case. */
export type AssessmentInput = {
  runId: string;
  caseId: string;
  decisions: AssessmentDecision[];
  /**
   * Wall-clock timestamp recorded on every assessment record this invocation
   * writes; injected by the caller because the use case reads no system time.
   */
  assessedAt: string;
  cancellation?: AbortSignal;
};
