/** Inputs, outputs, and injected effects of the application use cases. */

import type { ModelRoleName, TevuConfig } from './config';
import type { TevuResult, ValidationFinding } from './errors';
import type {
  AgentCapabilityReport,
  CaseIdentity,
  CaseLifecycle,
  EffortCheck,
  RepeatSetting,
  RunEffortChecks,
} from './run-records';
import type {
  AgentRegistry,
  ModelCallEvidence,
  ModelCallResult,
  ProviderSnapshot,
} from '@/domain/ports/agent';
import type { RunRecorder } from '@/domain/ports/artifact-store';
import type { CaseExecutableAdapter } from '@/domain/ports/case-executable';
import type { Clock } from '@/domain/ports/clock';
import type { EnvironmentAdapter } from '@/domain/ports/environment';
import type { EvaluatorProcessAdapter } from '@/domain/ports/evaluator-process';
import type { GitWorkspaceAdapter } from '@/domain/ports/git-workspace';
import type { ManagedCloneAdapter } from '@/domain/ports/managed-clone';
import type { PrerequisiteAdapter } from '@/domain/ports/prerequisite';

/** The effort checks of one validation: every configured model entry and every declared role. */
export type EffortChecks = {
  /** Exactly one key per configured model entry ID. */
  models: Record<string, EffortCheck>;
  /** Exactly one key per declared role. */
  roles: Partial<Record<ModelRoleName, EffortCheck>>;
};

/** Generates a run ID: UTC basic timestamp plus a collision-resistant lowercase suffix. */
type RunIdGenerator = (startedAt: Date) => string;

/** Effects injected into the aggregate validation use case. */
export type ValidationDependencies = {
  git: Pick<
    GitWorkspaceAdapter,
    'validateSource' | 'resolveCommit' | 'isAncestor' | 'readOverlay' | 'initializeEmptyRepository'
  >;
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
  efforts: EffortChecks;
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
  efforts: RunEffortChecks;
};

/** Effects injected into the benchmark orchestration use case. */
export type RunDependencies = {
  git: Pick<
    GitWorkspaceAdapter,
    | 'validateSource'
    | 'createIsolatedCase'
    | 'snapshotPatchBase'
    | 'capturePatch'
    | 'readOverlay'
    | 'applyCheckState'
    | 'dispose'
    | 'isReadable'
    | 'initializeEmptyRepository'
  >;
  agents: AgentRegistry;
  artifacts: RunRecorder;
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
  onLifecycle?: ((caseId: string, lifecycle: CaseLifecycle) => void) | undefined;
  onRetainedGradingDirectory?: ((directory: string) => void) | undefined;
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
  /** Forwarded unchanged to `AgentAdapter.callModel`. */
  onEvidence?: (evidence: ModelCallEvidence) => void;
};

/**
 * What one model-role call returns: the call's own result and, on every
 * path, the call directory left behind because removing it failed.
 */
export type ModelRoleCallOutcome = TevuResult<
  ModelCallResult,
  | 'ConfigValidationError'
  | 'PrerequisiteError'
  | 'AgentProtocolError'
  | 'ArtifactError'
  | 'ModelCallError'
  | 'CancellationError'
> & {
  /** The call directory left behind because removing it failed; null when it was removed or never created. */
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
