/**
 * Shared domain contracts for tevu: the configuration model, results, typed
 * errors, run and case records, the agent-independent adapter port, and
 * adapter interfaces.
 *
 * This module must stay free of boundary dependencies: no Commander.js, Clack,
 * Execa, Git commands, Jira transport code, or Node.js process globals.
 */

import type { ParsedGitHubRepository } from '@/domain/github-reference';

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
      context:
        | { phase: 'probe' }
        | { phase: 'case'; caseId: string }
        | { phase: 'call'; role: ModelRoleName };
      line?: number;
      reason: string;
    }
  | {
      kind: 'ModelCallError';
      role: ModelRoleName;
      agent: string;
      cause: 'launch-failed' | 'failed' | 'timed-out';
      reason: string;
      /** First line of the agent's own error message, redacted; absent when the agent reported none. */
      agentMessage?: string;
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
  | { kind: 'SetupError'; phase: SetupPhase; argv: string[]; reason: string }
  | { kind: 'ReferenceResolutionError'; reason: string }
  | {
      kind: 'ManagedCloneError';
      operation: ManagedCloneOperation;
      /** Display form of the repository contacted for this operation. */
      repository: string;
      reason: string;
    };

/** The git operation a `ManagedCloneError` reports on. */
export type ManagedCloneOperation = 'clone' | 'fetch' | 'ls-remote' | 'lfs-fetch';

/** Git LFS objects the tree of one commit needs, counted against its repository's own Git LFS storage. */
export type LfsObjectInventory = {
  /** Full hash the requested revision resolved to. */
  commit: string;
  /** Distinct (oid, size) pairs of pointer entries that use no extension and have a nonzero size. */
  objectCount: number;
  /** Pairs whose object file is absent, not a regular file, or of a size other than the pointer's. */
  missingCount: number;
};

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

/** One provider an agent block copies from the operator's configuration of that agent. */
export type AgentProviderSetting = {
  /** Key of the provider in that configuration's `provider` map. */
  id: string;
  /** A name from the same block's `secrets`, written as the provider's API key. */
  api_key?: string;
};

/** Parsed agent block settings; `secrets`, `env`, and `providers` default to `[]`. */
type AgentSettings = {
  command: string;
  secrets: string[];
  env: string[];
  providers: AgentProviderSetting[];
};

/** One file an agent adapter places in an agent home before the agent starts. */
export type AgentConfigurationFile = {
  /** Relative to the home's XDG_CONFIG_HOME; never empty, absolute, or with a `..` segment. */
  relativePath: string;
  /** Complete UTF-8 content. */
  text: string;
};

/** One copied provider and the models its copied definition defines a price for; evidence for cost, never a price. */
export type CopiedProvider = {
  /** The provider's key in the copied `provider` map: an `agents.<agent>.providers[].id`. */
  id: string;
  /** Keys of the copied definition's `models` map that define a price; ascending UTF-16 code-unit order, no repeats. */
  pricedModels: string[];
};

/** The providers one agent block copies, read once and applied to every agent home of one run or call. */
export type ProviderSnapshot = {
  agent: string;
  /** Empty exactly when the block names no provider. */
  configurationFiles: readonly AgentConfigurationFile[];
  /** P-NOKEY warnings, in the order met; empty when none. */
  findings: readonly ValidationFinding[];
  /** One entry per copied provider, in `providers` order; empty exactly when the block names no provider. */
  copiedProviders: readonly CopiedProvider[];
};

/** One file every agent home of one agent received; `sha256` is 64 lowercase hexadecimal characters. */
export type AgentConfigurationFileRecord = { path: string; sha256: string };

/** Outcome of one model listing; `reason` never carries process output. */
export type ModelListing =
  | { outcome: 'listed'; models: readonly string[] }
  | { outcome: 'timed-out'; limitMs: number }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'cancelled' };

/** One provider as the operator's own configuration of an agent defines it; names and states only, never values. */
export type OperatorProvider =
  | { defined: false }
  | {
      defined: true;
      /** Variables in credential positions: a whole `{env:NAME}` value at `apiKey` or at a credential-named key, a reference in a credential-named header, or a name in the root `env` list; first-seen order, no repeats. */
      keyVariables: readonly string[];
      /** Every other variable a `{env:NAME}` reference names; first-seen order, no repeats, none also in `keyVariables`. */
      otherVariables: readonly string[];
      /** `options.apiKey` as written: exactly one whole `{env:NAME}` reference, any other value, or no value. */
      apiKey: 'reference' | 'value' | 'absent';
    };

/** Parsed Jira Cloud connection settings. */
export type JiraTrackerSettings = {
  url: string;
  email: string;
  token: string;
};

/** One repository setup command: executable and literal arguments, no shell; the array form of a check's `run`. */
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
  /** Path entry: the repository. GitHub entry: its managed clone. Relative to its base until `resolveConfig`, then absolute. */
  path: string;
  /** Present exactly for a GitHub entry: the `github` value as written. */
  github?: string;
  setup?: RepositorySetup;
};

/** Offline state of one managed-clone directory. */
export type CloneState = 'missing' | 'repository' | 'not-a-repository';

/**
 * Clones and fetches managed clones through git, with gh as git's credential
 * helper. Implemented over the local git CLI and gh; see `src/adapters/managed-clone.ts`.
 */
export interface ManagedCloneAdapter {
  /** Offline: no network, no gh, no write. */
  inspectClone(directory: string): Promise<CloneState>;
  /** Bare-clones `repository` into `directory`; succeeds without cloning when a clone appeared meanwhile. */
  clone(
    directory: string,
    repository: ParsedGitHubRepository,
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
  /** Fetches full commit hashes from `source`, each into `refs/tevu/fetched/<hash>`. */
  fetchCommits(
    directory: string,
    source: ParsedGitHubRepository,
    commits: readonly string[],
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
  /** Fetches every branch and tag of `repository`, force-updating `refs/heads/*` and `refs/tags/*`. */
  fetchBranchesAndTags(
    directory: string,
    repository: ParsedGitHubRepository,
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
  /** Reads `repository`'s HEAD from the remote without writing anything, proving it exists and is readable. */
  checkRemote(
    repository: ParsedGitHubRepository,
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
  /** Fetches every Git LFS object of `commit` that the clone in `directory` lacks, from the endpoint that `repository`'s clone URL implies. */
  fetchLfsObjects(
    directory: string,
    repository: ParsedGitHubRepository,
    commit: string,
  ): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>>;
}

/** One resolved benchmark model entry: what the benchmark compares. */
export interface ModelDefinition {
  id: string;
  model: `${string}/${string}`;
  effort: string;
  agent: string;
}

/** A model role a configuration may declare under `roles`. */
export type ModelRoleName = 'criteria' | 'grader';

/** One resolved model role: a model entry without `id`, with `agent` materialized. */
export type ModelRole = Omit<ModelDefinition, 'id'>;

/** One-time tracker import snapshot stored on a task. */
type ImportedTaskSource = {
  kind: 'jira' | 'github';
  key: string;
  url: string;
  imported_at: string;
  title: string;
  body: string;
};

/** A task's reference solution, read once by `tevu task add`; field contract in the configuration reference. */
export type TaskReference =
  | { kind: 'pull-request'; identifier: string; commits: string[]; merge_commit?: string }
  | { kind: 'commit'; identifier: string; commits: [string] };

/** A GitHub pull request's state, as `readPullRequest` reports it. */
export type PullRequestState = 'open' | 'closed' | 'merged';

/** Whether a pull request's head merges cleanly into its target, as GitHub last computed it. */
export type PullRequestMergeability = 'mergeable' | 'conflicting' | 'unknown';

/** One pull request commit as GitHub lists it. */
export type PullRequestCommit = { hash: string; parents: string[] };

/** One GitHub pull request read once through gh, with its complete commit list. */
export type PullRequestSnapshot = {
  /** `OWNER/REPO#NUMBER`, taken from gh's `url` field. */
  key: string;
  url: string;
  state: PullRequestState;
  /** GraphQL `baseRefName`. */
  targetBranch: string;
  /** GraphQL `baseRef.target.oid` when read; `null` when the target branch no longer exists. */
  targetTip: string | null;
  headCommit: string;
  /** GraphQL `mergeCommit.oid` when `state` is `merged` and GitHub reports one; otherwise `null`. */
  mergeCommit: string | null;
  mergeability: PullRequestMergeability;
  /** Every commit GitHub lists, in GitHub's order; never a partial list. */
  commits: PullRequestCommit[];
};

/**
 * A command check's resolved shape with every default materialized. `run` is
 * either a command line that `/bin/sh -c` runs, or an executable followed by
 * literal arguments that run without a shell.
 */
export interface CommandCheck {
  id: string;
  description: string;
  run: string | [string, ...string[]];
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

/** A graded check's resolved shape: graded by `roles.grader` against its description. */
interface GradedCheck {
  id: string;
  description: string;
  required: boolean;
}

/** One acceptance or done check: a command check, a manual check, or a graded check. */
export type CheckDefinition = CommandCheck | ManualCheck | GradedCheck;

/** Which evaluator resolves one check's verdict. */
export type CheckEvaluator = 'command' | 'manual' | 'grader';

/** Which check collection a check belongs to. */
export type CheckCategory = 'acceptance' | 'definition-of-done';

/** Resolves a live check definition's evaluator: `manual` when declared, `command` when it has `run`, `grader` otherwise. */
export function checkEvaluator(check: CheckDefinition): CheckEvaluator {
  if ('run' in check) {
    return 'command';
  }
  if ('manual' in check) {
    return 'manual';
  }
  return 'grader';
}

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
  reference?: TaskReference;
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
  /** Present only when the file declares `roles`; each key only when declared. */
  roles?: Partial<Record<ModelRoleName, ModelRole>>;
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
  evaluator: CheckEvaluator;
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

/** Run-relative paths of every artifact one case owns inside its run directory. */
export type CaseArtifactPathIndex = {
  events: string;
  diagnostics: string;
  sessionExport: string;
  solutionPatch: string;
  checks: string;
  assessment: string;
  grading: string;
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

/** Result of looking up one revision in a repository. */
export type CommitLookup =
  { kind: 'found'; commit: string } | { kind: 'not-found' } | { kind: 'no-repository' };

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
  /** Looks up a revision without failing: distinguishes a repository the path does not hold from a revision it does not resolve. */
  resolveCommit(repository: RepositoryDefinition, reference: string): Promise<CommitLookup>;
  /** Counts the Git LFS objects a revision's tree needs against the repository's own storage; reads only and never starts Git LFS. */
  inspectLfsObjects(
    repository: RepositoryDefinition,
    revision: string,
  ): Promise<TevuResult<LfsObjectInventory, 'SourceMaterializationError'>>;
  /** Reports whether `ancestor` precedes or equals `descendant`; `null` when Git cannot decide. */
  isAncestor(
    repository: RepositoryDefinition,
    ancestor: string,
    descendant: string,
  ): Promise<boolean | null>;
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
  /** Runs `git init` in an existing empty directory; creates no commit, remote, or configuration. */
  initializeEmptyRepository(directory: string): Promise<TevuResult<void, 'ArtifactError'>>;
  /** The unified diff `commit` introduces against its first parent: no color, no external diff driver, no binary contents. */
  diffCommit(
    repository: RepositoryDefinition,
    commit: string,
  ): Promise<TevuResult<string, 'ArtifactError'>>;
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

/** Paths and replacement variables of one model call; removed by `dispose`. */
export interface ModelCallEnvironment {
  rootDirectory: string;
  /** `<root>/work`, empty when created; the agent's working directory once `initializeEmptyRepository` makes it a Git top level. */
  workingDirectory: string;
  /** `<root>/agent/home`; the value of HOME and the `export` working directory. */
  homeDirectory: string;
  variables: Record<string, string>;
  /** Removes `rootDirectory` recursively; succeeds when it no longer exists. */
  dispose(): Promise<TevuResult<void, 'ArtifactError'>>;
}

/** Builds the run-level parent snapshot and per-case isolated replacement environments. */
export interface EnvironmentAdapter {
  snapshotParent(
    names: EnvironmentVariableNames,
  ): TevuResult<ParentEnvironmentSnapshot, 'PrerequisiteError'>;
  /** The names in `names` that tevu's own environment leaves unset, in input order. */
  unsetVariables(names: readonly string[]): string[];
  createCaseEnvironments(
    workspace: CaseWorkspace,
    snapshot: ParentEnvironmentSnapshot,
    names: EnvironmentVariableNames,
    agent: string,
    configurationFiles: readonly AgentConfigurationFile[],
  ): Promise<TevuResult<CaseEnvironments, 'IsolationError'>>;
  createModelCallEnvironment(
    snapshot: ParentEnvironmentSnapshot,
    agentVariables: { secrets: readonly string[]; env: readonly string[] },
    configurationFiles: readonly AgentConfigurationFile[],
  ): Promise<TevuResult<ModelCallEnvironment, 'ArtifactError'>>;
}

/** Redacted, bounded process output capture with its true total size. */
export type RedactedCapture = {
  text: string;
  totalBytes: number;
  truncated: boolean;
  /**
   * Whether a tevu signal reached the process group while this stream was
   * still open, so a writer may have been stopped mid-output; `totalBytes`
   * then counts only what arrived.
   */
  incomplete: boolean;
};

/** Evaluator process request: argv started as given, with an explicit replacement environment. */
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

/** Runs one benchmark-task acceptance command, or one repository setup command, as the argv of its request. */
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

/** The grader call's raw outcome: the reply text as returned, or that no reply was usable. */
type GraderCallRecord =
  { status: 'replied'; reply: string } | { status: 'no-reply'; reason: string };

/** One case's grading: the grader identity, its raw call outcome, its own metrics, and every graded check's grade. */
export type CaseGrading = {
  grader: GraderIdentity;
  call: GraderCallRecord;
  metrics: AgentMetrics;
  /** One per graded check: acceptance, then done, configuration order. */
  grades: GradeRecord[];
};

/** Versioned case artifact: `cases/<case-id>/grading.json`. */
export type GradingArtifact = CaseGrading & { schemaVersion: 1; runId: string; caseId: string };

export type ModelCallInput = {
  role: ModelRoleName;
  model: `${string}/${string}`;
  effort: string;
  prompt: string;
  environment: ModelCallEnvironment;
  /** Limit for the `run` process: a whole number from 1 through 2147483647. */
  timeoutMs: number;
  terminationGraceMs: number;
  cancellation: AbortSignal;
  /** Copied providers of the snapshot the call environment was built from. Required, never defaulted. */
  copiedProviders: readonly CopiedProvider[];
};

export type ModelCallResult = {
  /** Reply text, redacted. */
  text: string;
  /** Agent-reported metrics; an unreported metric is unavailable, never zero. */
  metrics: AgentMetrics;
};

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
  /** The case agent's copied providers: its run snapshot's, or the run manifest's on regeneration. Required, never defaulted. */
  copiedProviders: readonly CopiedProvider[];
};

export interface AgentAdapter {
  probe(): Promise<TevuResult<AgentCapabilityReport, 'PrerequisiteError' | 'AgentProtocolError'>>;
  /**
   * Reads the providers its agent block names from the operator's configuration
   * of the agent and prepares the files every agent home receives; writes
   * nothing and starts no process.
   */
  readProviders(): Promise<TevuResult<ProviderSnapshot, 'ConfigValidationError'>>;
  /**
   * Reads what the operator's own configuration of this agent defines for
   * provider `id`; reads files, starts no process.
   */
  inspectOperatorProvider(
    id: string,
  ): Promise<TevuResult<OperatorProvider, 'ConfigValidationError'>>;
  /** Lists every model the agent resolves in `environment`, without starting a model session. */
  listModels(environment: ModelCallEnvironment, cancellation?: AbortSignal): Promise<ModelListing>;
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
  callModel(
    input: ModelCallInput,
  ): Promise<
    TevuResult<ModelCallResult, 'ModelCallError' | 'AgentProtocolError' | 'CancellationError'>
  >;
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
  /** Wall-clock instant the direct child exited, ISO 8601; excludes the post-exit window. */
  endedAt: string;
  /** Milliseconds from launch to the direct child's exit on a monotonic clock; excludes the post-exit window. */
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

/** Reads one GitHub pull request, complete with its commit list, exactly once. */
export interface PullRequestReader {
  readPullRequest(
    reference: string,
  ): Promise<TevuResult<PullRequestSnapshot, 'ReferenceResolutionError' | 'CancellationError'>>;
  /** Reads the pull request's unified diff through GitHub's diff media type. */
  readPullRequestDiff(
    reference: string,
  ): Promise<TevuResult<string, 'ReferenceResolutionError' | 'CancellationError'>>;
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
  writeGrading(caseId: string, grading: CaseGrading): Promise<TevuResult<void, 'ArtifactError'>>;
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
  readGrading(runId: string, caseId: string): Promise<TevuResult<GradingArtifact, 'ArtifactError'>>;
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

/** Why a `parent-only` replica run did not exit 0; never carries process output. */
type ReplicaFailure =
  | { kind: 'exited'; exitCode: number }
  | { kind: 'signaled'; signal: string }
  | { kind: 'not-started'; code: string | null };

/** Verdict of one case-executable probe. */
export type CaseExecutableVerdict =
  | { verdict: 'runs' }
  | { verdict: 'undetermined' }
  | { verdict: 'parent-only'; resolvedPath: string | null; replicaFailure: ReplicaFailure };

/** One case executable to probe and what its case environment adds to the fixed variables. */
export type CaseExecutableProbeRequest = {
  /** A bare name looked up on `path`, or an absolute path; never a relative path containing `/`. */
  executable: string;
  /** `ParentEnvironmentSnapshot.path`: the PATH every case environment receives. */
  path: string;
  /** The additions by name, with their snapshot values. */
  additions: Readonly<Record<string, string>>;
  /** Absolute working directory of both runs; absent means a new empty directory inside the probe directory. */
  workingDirectory?: string;
  /** Names the parent run omits even when `process.env` sets them. */
  withheldNames: readonly string[];
};

/** Paths one run changed in the working directory, relative to it; each list in ascending byte order. */
type RunChanges = {
  run: 'replica' | 'parent';
  added: string[];
  modified: string[];
  removed: string[];
};

/** What a probe's runs changed in `request.workingDirectory`. */
export type WorkingDirectoryChanges = {
  /** One entry per run whose directory snapshots before and after it both succeeded, in run order, even with empty lists. */
  runs: RunChanges[];
  /** Reason text for the first failed directory snapshot; the probe takes none after it. */
  failure?: string;
};

/** Outcome of one case-executable probe. */
export type CaseExecutableProbe = {
  verdict: CaseExecutableVerdict;
  /** Present exactly when the request sets `workingDirectory`. */
  changes?: WorkingDirectoryChanges;
};

/**
 * Probes whether a case executable runs unmodified in its case environment,
 * without changing any case environment; implemented in `src/adapters/process.ts`.
 */
export interface CaseExecutableAdapter {
  probe(
    request: CaseExecutableProbeRequest,
  ): Promise<TevuResult<CaseExecutableProbe, 'PrerequisiteError'>>;
}

/** Effects injected into the aggregate validation use case. */
export type ValidationDependencies = {
  git: GitWorkspaceAdapter;
  agents: AgentRegistry;
  environments: EnvironmentAdapter;
  prerequisites: PrerequisiteAdapter;
  clones: Pick<ManagedCloneAdapter, 'inspectClone'>;
  caseExecutables: CaseExecutableAdapter;
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
  /** The SHA-256 of `text` as UTF-8, in 64 lowercase hexadecimal characters. */
  textDigest: (text: string) => string;
  redact: (text: string) => string;
  cancellation: AbortSignal;
  onLifecycle?: (caseId: string, lifecycle: CaseLifecycle) => void;
};

/** The configuration fields one model-role call reads; a `TevuConfig` satisfies it. */
export type ModelRoleCallConfig = {
  agents: TevuConfig['agents'];
  roles?: TevuConfig['roles'];
  run: Pick<TevuConfig['run'], 'timeout' | 'stop_grace'>;
};

/** Request for one one-shot model call through a configured model role. */
export type ModelRoleCallRequest = {
  config: ModelRoleCallConfig;
  role: ModelRoleName;
  prompt: string;
  timeoutMs: number;
  cancellation: AbortSignal;
  /** The run's snapshot of the role's agent; absent means `callModelRole` reads one. */
  providers?: ProviderSnapshot;
};

/** Result of one model-role call. */
export type ModelRoleCallResult = ModelCallResult & {
  /** The call directory left behind because removing it failed; null when removed. */
  retainedDirectory: string | null;
};

/** Effects injected into the model-call use case. */
export type ModelCallDependencies = {
  agents: AgentRegistry;
  environments: EnvironmentAdapter;
  git: Pick<GitWorkspaceAdapter, 'initializeEmptyRepository'>;
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
