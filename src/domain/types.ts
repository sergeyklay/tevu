/**
 * Shared domain contracts for tevu: results, typed errors, run and case
 * records, OpenCode protocol records, and adapter interfaces.
 *
 * This module must stay free of boundary dependencies: no Commander.js, Clack,
 * Execa, Git commands, Jira transport code, or Node.js process globals.
 */

import type {
  CheckDefinition,
  ContenderDefinition,
  JiraCloudConfig,
  ReadyItem,
  RepositoryDefinition,
  TaskDefinition,
  TevuConfig,
} from "../config/schema.ts";

/** Result of a fallible module contract; errors never cross boundaries as thrown exceptions. */
export type TevuResult<T, K extends TevuError["kind"]> =
  | { ok: true; value: T }
  | { ok: false; error: Extract<TevuError, { kind: K }> };

/** One aggregated parse or validation finding with a stable field, task, or check identifier. */
export type ValidationFinding = {
  severity: "error" | "warning";
  identifier: string;
  message: string;
};

/** Tracker behind an imported task source; each value equals the stored `source.kind`. */
export type IssueTrackerKind = "jira-cloud" | "github-issue";

/** Exhaustive typed error union for every tevu failure crossing a module boundary. */
export type TevuError =
  | { kind: "ConfigParseError"; findings: ValidationFinding[] }
  | { kind: "ConfigValidationError"; findings: ValidationFinding[] }
  | { kind: "PrerequisiteError"; tool: string; expected: string; actual?: string }
  | { kind: "SourceMaterializationError"; taskId: string; reason: string }
  | { kind: "IsolationError"; caseId: string; reason: string }
  | {
      kind: "IssueImportError";
      tracker: IssueTrackerKind;
      reference: string;
      /** HTTP status; only the Jira Cloud adapter sets it. */
      status?: number;
      reason: string;
    }
  | {
      kind: "OpenCodeProcessError";
      caseId: string;
      exitCode: number | null;
      signal: string | null;
    }
  | {
      kind: "OpenCodeProtocolError";
      context: { phase: "probe" } | { phase: "case"; caseId: string };
      line?: number;
      reason: string;
    }
  | { kind: "CaseTimeoutError"; caseId: string; timeoutMs: number }
  | { kind: "EvaluationError"; caseId: string; checkId: string; reason: string }
  | {
      kind: "AssessmentConflictError";
      runId: string;
      caseId: string;
      reason: string;
    }
  | { kind: "ArtifactError"; operation: string; reason: string }
  | { kind: "CancellationError"; activeCaseIds: string[] };

/** Identity of one benchmark case: one task executed once by one contender. */
export type CaseIdentity = {
  caseId: string;
  taskId: string;
  contenderId: string;
  sourceCommit: string;
  model: string;
  variant: string;
};

/** Versioned manifest of one benchmark run; `tools.opencodeVersion` is provenance only, never a gate. */
export type RunManifest = {
  schemaVersion: 1;
  runId: string;
  configDigest: string;
  startedAt: string;
  completedAt: string | null;
  host: {
    platform: "linux" | "darwin";
    nodeVersion: string;
    bunVersion: string;
  };
  tools: { gitVersion: string; opencodeVersion: string | null };
  execution: { concurrency: number; caseTimeoutMs: number };
  cases: CaseIdentity[];
  context?: {
    config: TevuConfig;
    capabilities: OpenCodeCapabilityReport;
  };
};

/** Terminal and intermediate case lifecycle states; final results carry only terminal states. */
export type CaseLifecycle =
  | "queued"
  | "preparing"
  | "running"
  | "evaluating"
  | "completed"
  | "process-failed"
  | "timed-out"
  | "cancelled"
  | "infrastructure-failed";

/** Which termination stage ended a supervised process group. */
export type TerminationStage = "none" | "graceful" | "forced";

/** OpenCode process evidence, independent of task acceptance. */
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
export type ArtifactIndex = {
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
};

/** Versioned final record of one benchmark case. */
export type CaseResult = {
  schemaVersion: 1;
  identity: CaseIdentity;
  lifecycle: CaseLifecycle;
  process: ProcessResult | null;
  outcome: "passed" | "failed" | "pending" | "not-evaluated";
  checks: CheckResult[];
  metrics: BenchmarkMetrics;
  artifacts: ArtifactIndex;
  failure: FailureRecord | null;
  context?: {
    sourceRepositoryPath: string;
    syntheticCommit: string;
    environment: EnvironmentVariableRecord[];
  };
};

/** Runtime-probed capability report for the configured OpenCode executable. */
export type OpenCodeCapabilityReport = {
  executable: string;
  detectedVersion: string | null;
  commands: {
    run: "available" | "unavailable";
    export: "available" | "unavailable";
  };
  runOptions: {
    jsonFormat: "available" | "unavailable";
    model: "available" | "unavailable";
    variant: "available" | "unavailable";
  };
  isolation: {
    denyOutsideWorktree: "available" | "unavailable";
  };
};

/** Whether a metric was measured, with its source or the reason it is unavailable. */
export type MetricAvailability =
  | { status: "available"; source: string }
  | { status: "unavailable"; reason: string };

/** One normalized metric; `value: null` means unavailable, zero means a measured zero. */
export type MetricValue = {
  value: number | null;
  unit: "count" | "token" | "millisecond" | "USD";
  availability: MetricAvailability;
  scope: "case" | "root-session" | "session-tree";
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

/** Verdict and redacted, size-reported evidence for one configured check. */
export type CheckResult = {
  checkId: string;
  category: "acceptance" | "definition-of-done";
  verdict: "passed" | "failed" | "pending" | "not-run";
  evidence: string;
  durationMs: number | null;
};

/** One manual assessment verdict. */
export type AssessmentRecord = {
  checkId: string;
  verdict: "passed" | "failed";
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

/** Structural identity shared by every OpenCode message part. */
export type OpenCodePart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
};

/** Tool-call part carried by `tool_use` events. */
export type OpenCodeToolPart = OpenCodePart & {
  type: "tool";
  callID: string;
  tool: string;
  state: { status: "pending" | "running" | "completed" | "error" };
};

/** Consumed OpenCode JSON event records streamed during `run --format json`. */
export type OpenCodeRunEvent =
  | { type: "tool_use"; timestamp: number; sessionID: string; part: OpenCodeToolPart }
  | {
      type: "step_start" | "step_finish" | "text" | "reasoning";
      timestamp: number;
      sessionID: string;
      part: OpenCodePart;
    }
  | { type: "error"; timestamp: number; sessionID: string; error: unknown };

/** Consumed root-session export record; additive unknown fields are tolerated by the decoder. */
export type OpenCodeExport = {
  info: { id: string; parentID?: string };
  messages: Array<{
    info:
      | { id: string; sessionID: string; role: "user" }
      | {
          id: string;
          sessionID: string;
          role: "assistant";
          parentID: string;
          finish?: string;
          error?: unknown;
          cost: number;
          tokens: {
            input: number;
            output: number;
            reasoning: number;
            cache: { read: number; write: number };
          };
        };
    parts: OpenCodePart[];
  }>;
};

/** Injectable time source; wall-clock reads must not come from process globals in pure modules. */
export interface Clock {
  now(): Date;
}

/** Generates a run ID: UTC basic timestamp plus a collision-resistant lowercase suffix. */
export type RunIdGenerator = (startedAt: Date) => string;

/** Host and pinned-tool facts probed at the adapter boundary for the run manifest. */
export type HostProbe = {
  platform: "linux" | "darwin";
  nodeVersion: string;
  bunVersion: string;
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

/** Sealed Git source validation, case materialization, patch capture, and disposal. */
export interface GitWorkspaceAdapter {
  validateSource(
    repository: RepositoryDefinition,
    commit: string,
  ): Promise<TevuResult<SourceValidation, "SourceMaterializationError">>;
  createIsolatedCase(
    identity: CaseIdentity,
  ): Promise<TevuResult<CaseWorkspace, "SourceMaterializationError" | "IsolationError">>;
  capturePatch(
    workspace: CaseWorkspace,
  ): Promise<TevuResult<PatchArtifact, "SourceMaterializationError" | "ArtifactError">>;
  dispose(workspace: CaseWorkspace): Promise<TevuResult<void, "ArtifactError">>;
  isReadable?(workspace: CaseWorkspace): Promise<boolean>;
}

/** Name, classification, and recipient of one passed variable; values are never recorded. */
export type EnvironmentVariableRecord = {
  name: string;
  classification: "fixed" | "provider-credential" | "secret" | "ordinary";
  recipient: "opencode" | "evaluator";
};

/** Complete replacement environment for one case recipient, plus its value-free manifest. */
export type IsolatedEnvironment = {
  caseId: string;
  recipient: "opencode" | "evaluator";
  homeDirectory: string;
  temporaryDirectory: string;
  variables: Record<string, string>;
  variableManifest: EnvironmentVariableRecord[];
};

/** Immutable run-level snapshot of the parent PATH and configured variable values. */
export type ParentEnvironmentSnapshot = {
  path: string;
  opencodeValues: Record<string, string>;
  ordinaryEvaluatorValues: Record<string, string>;
  secretValues: string[];
};

/** Separate OpenCode and evaluator replacement environments for one case. */
export type CaseEnvironments = {
  opencode: IsolatedEnvironment;
  evaluator: IsolatedEnvironment;
};

/** Builds the run-level parent snapshot and per-case isolated replacement environments. */
export interface EnvironmentAdapter {
  snapshotParent(
    config: TevuConfig,
  ): TevuResult<ParentEnvironmentSnapshot, "PrerequisiteError">;
  createCaseEnvironments(
    workspace: CaseWorkspace,
    snapshot: ParentEnvironmentSnapshot,
    config: TevuConfig,
  ): Promise<TevuResult<CaseEnvironments, "IsolationError">>;
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

/** Runs one benchmark-task acceptance command without a shell. */
export interface EvaluatorProcessAdapter {
  run(request: EvaluatorProcessRequest): Promise<EvaluatorProcessResult>;
}

/** Input for exactly one managed `opencode run --format json` case process. */
export type OpenCodeRunInput = {
  identity: CaseIdentity;
  executable: string;
  prompt: string;
  worktreeDirectory: string;
  environment: IsolatedEnvironment;
  timeoutMs: number;
  terminationGraceMs: number;
  cancellation: AbortSignal;
  onEvent: (
    event: OpenCodeRunEvent,
  ) => Promise<TevuResult<void, "ArtifactError" | "OpenCodeProtocolError">>;
  onDiagnostic: (line: string) => Promise<TevuResult<void, "ArtifactError">>;
  onProcess?: (result: OpenCodeRunResult) => void;
};

/** Process evidence, root-session identity, and preserved parse findings for one case run. */
export type OpenCodeRunResult = {
  process: ProcessResult;
  sessionId: string | null;
  parseFindings: string[];
};

/** OpenCode capability probing, one-case execution, and root-session export. */
export interface OpenCodeAdapter {
  probe(
    executable: string,
  ): Promise<TevuResult<OpenCodeCapabilityReport, "PrerequisiteError" | "OpenCodeProtocolError">>;
  run(
    input: OpenCodeRunInput,
  ): Promise<
    TevuResult<
      OpenCodeRunResult,
      "OpenCodeProcessError" | "OpenCodeProtocolError" | "CaseTimeoutError" | "CancellationError"
    >
  >;
  exportSession(
    sessionId: string,
    environment: IsolatedEnvironment,
  ): Promise<TevuResult<OpenCodeExport, "OpenCodeProcessError" | "OpenCodeProtocolError">>;
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
  readIssue(reference: string): Promise<TevuResult<IssueSnapshot, "IssueImportError" | "CancellationError">>;
}

/** Exclusive assessment lock held across replacement and derived regeneration. */
export interface AssessmentLock {
  runId: string;
  caseId: string;
  release(): Promise<TevuResult<void, "ArtifactError">>;
}

/** Regenerated normalized JSON and Markdown report content for one run. */
export type ReportResult = {
  runId: string;
  normalizedJson: string;
  markdown: string;
};

/** Run-level finding for cases without a final result, cleanup warnings, and cancellations. */
export type RunFinding = {
  severity: "error" | "warning";
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
  startRun(manifest: RunManifest): Promise<TevuResult<void, "ArtifactError">>;
  appendEvent(
    caseId: string,
    event: OpenCodeRunEvent,
  ): Promise<TevuResult<void, "ArtifactError" | "OpenCodeProtocolError">>;
  appendDiagnostic(caseId: string, line: string): Promise<TevuResult<void, "ArtifactError">>;
  writeSessionExport(
    caseId: string,
    sessionExport: OpenCodeExport,
  ): Promise<TevuResult<void, "ArtifactError">>;
  writePatch(caseId: string, patch: PatchArtifact): Promise<TevuResult<void, "ArtifactError">>;
  writeChecks(caseId: string, checks: CheckResult[]): Promise<TevuResult<void, "ArtifactError">>;
  finalizeCase(result: CaseResult): Promise<TevuResult<void, "ArtifactError">>;
  /**
   * Atomically replaces one case's derived result record inside an existing
   * run directory. Unlike `finalizeCase`, this is the derived-write contract
   * for closed (already finalized) runs used by assessment and report
   * regeneration; it never requires an active run.
   */
  replaceCaseResult(runId: string, result: CaseResult): Promise<TevuResult<void, "ArtifactError">>;
  finalizeRun(result: RunResult): Promise<TevuResult<void, "ArtifactError">>;
  writeReport(runId: string, report: ReportResult): Promise<TevuResult<void, "ArtifactError">>;
  readRunManifest(runId: string): Promise<TevuResult<RunManifest, "ArtifactError">>;
  readRunResult(runId: string): Promise<TevuResult<RunResult, "ArtifactError">>;
  readCaseResult(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<CaseResult, "ArtifactError">>;
  readEvents(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<OpenCodeRunEvent[], "ArtifactError" | "OpenCodeProtocolError">>;
  readSessionExport(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<OpenCodeExport | null, "ArtifactError" | "OpenCodeProtocolError">>;
  readChecks(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<CheckResult[], "ArtifactError">>;
  readAssessment(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AssessmentArtifact | null, "ArtifactError">>;
  acquireAssessmentLock(
    runId: string,
    caseId: string,
  ): Promise<TevuResult<AssessmentLock, "AssessmentConflictError" | "ArtifactError">>;
  replaceAssessment(artifact: AssessmentArtifact): Promise<TevuResult<void, "ArtifactError">>;
}

/** Reads and atomically replaces the YAML configuration document. */
export interface ConfigStore {
  exists(path: string): Promise<boolean>;
  read(
    path: string,
  ): Promise<TevuResult<TevuConfig, "ConfigParseError" | "ConfigValidationError" | "ArtifactError">>;
  replace(path: string, config: TevuConfig): Promise<TevuResult<void, "ArtifactError">>;
}

/** Wizard-selected task source before snapshot materialization. */
export type TaskSourceRequest =
  | { kind: "manual"; reference?: string; title: string }
  | {
      kind: "jira-cloud";
      issueKey: string;
      /**
       * One-time import already taken and displayed by the wizard; when
       * present, task creation stores it verbatim instead of reading the
       * issue from Jira a second time.
       */
      snapshot?: IssueSnapshot & { importedAt: string };
    }
  | {
      kind: "github-issue";
      /** One-time import already taken and displayed by the wizard. */
      snapshot: IssueSnapshot & { importedAt: string };
    };

/** Complete top-level answers captured by the missing-configuration bootstrap flow. */
export type ConfigBootstrapInput = {
  artifacts: TevuConfig["artifacts"];
  execution: TevuConfig["execution"];
  opencode: TevuConfig["opencode"];
  jira?: JiraCloudConfig;
  repositories: RepositoryDefinition[];
  contenders: ContenderDefinition[];
};

/** Typed wizard answers handed to the task-creation use case, which owns all writes. */
export type TaskWizardInput = {
  configPath: string;
  bootstrap?: ConfigBootstrapInput;
  repositoryId: string;
  newRepository?: RepositoryDefinition;
  taskId: string;
  startCommit: string;
  source: TaskSourceRequest;
  description: string;
  prompt: string;
  definitionOfReady: ReadyItem[];
  acceptanceCriteria: CheckDefinition[];
  definitionOfDone: CheckDefinition[];
};

/** Effects injected into the task-creation use case. */
export type TaskDependencies = {
  configStore: ConfigStore;
  git: GitWorkspaceAdapter;
  jira: IssueTrackerAdapter | null;
  clock: Clock;
  cancellation?: AbortSignal;
};

/** Local prerequisite probes used by validation stages 3, 4, and 6. */
export interface PrerequisiteAdapter {
  probeHost(): Promise<TevuResult<HostProbe, "PrerequisiteError">>;
  hasEnvironmentVariable(name: string): boolean;
  probeWritableDirectory(directory: string): Promise<TevuResult<void, "PrerequisiteError">>;
}

/** Effects injected into the aggregate validation use case. */
export type ValidationDependencies = {
  git: GitWorkspaceAdapter;
  opencode: OpenCodeAdapter;
  environments: EnvironmentAdapter;
  prerequisites: PrerequisiteAdapter;
  buildTaskPrompt: (task: TaskDefinition) => string;
};

/** Aggregate validation outcome; any error-severity finding makes the configuration invalid. */
export type ValidationReport = {
  valid: boolean;
  findings: ValidationFinding[];
  capabilities: OpenCodeCapabilityReport | null;
};

/** Deterministic task-by-contender execution plan derived purely from configuration. */
export type BenchmarkPlan = {
  config: TevuConfig;
  cases: CaseIdentity[];
  concurrency: number;
  caseTimeoutMs: number;
  terminationGraceMs: number;
  artifactsDirectory: string;
};

/** Effects injected into the benchmark orchestration use case. */
export type RunDependencies = {
  git: GitWorkspaceAdapter;
  opencode: OpenCodeAdapter;
  artifacts: ArtifactStore;
  evaluatorProcesses: EvaluatorProcessAdapter;
  environments: EnvironmentAdapter;
  prerequisites: PrerequisiteAdapter;
  clock: Clock;
  generateRunId: RunIdGenerator;
  configDigest: (config: TevuConfig) => string;
  buildTaskPrompt: (task: TaskDefinition) => string;
  redact: (text: string) => string;
  cancellation: AbortSignal;
  onLifecycle?: (caseId: string, lifecycle: CaseLifecycle) => void;
};

/** One manual verdict decision captured for a pending or replaced manual check. */
export type AssessmentDecision = {
  checkId: string;
  verdict: "passed" | "failed";
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
