/** The `AgentAdapter` contract, with the request and result shapes only it uses. */

import type {
  AgentConfigurationFile,
  IsolatedEnvironment,
  ModelCallEnvironment,
} from './environment';
import type { ModelRoleName } from '@/domain/config';
import type { TevuResult, ValidationFinding } from '@/domain/errors';
import type {
  AgentCapabilityReport,
  AgentEventRecord,
  AgentMetrics,
  AgentSessionExport,
  CaseIdentity,
  CopiedProvider,
  ProcessResult,
} from '@/domain/run-records';

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

/** Outcome of one model listing; `reason` never carries process output. */
export type ModelListing =
  | {
      outcome: 'listed';
      models: readonly string[];
      /** Per listed model identifier, its reported variant names in ascending UTF-16 code-unit order; a listed model without a key reported no readable variant data. */
      variants: ReadonlyMap<string, readonly string[]>;
    }
  | { outcome: 'timed-out'; limitMs: number }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'cancelled' };

/**
 * Outcome of one tool denial check: `not-shown` means the output does not show
 * every tool denied, `failed` means the check produced no readable output. Each
 * `reason` is one clause that opens with the quoted command, is already
 * redacted, and carries no process output.
 */
export type ToolDenialProbe =
  | { outcome: 'denied' }
  | { outcome: 'not-shown'; reason: string }
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

/** Redacted records one model call left. */
export type ModelCallEvidence = {
  /** Every redacted run event record the adapter consumed, in arrival order. */
  events: AgentEventRecord[];
  /** The run process's redacted stderr capture text, bounded by the managed-process capture. */
  diagnostics: string;
  /** The redacted root-session export and the metrics derived from it; null when tevu read no export. */
  session: { export: AgentSessionExport; metrics: AgentMetrics } | null;
};

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
  /** Receives the call's evidence once, before `callModel` resolves, when the `run` process started. */
  onEvidence?: ((evidence: ModelCallEvidence) => void) | undefined;
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
  exportUnavailableReason?: string | undefined;
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
  /** Reports, without starting a model session, whether a model call's `run` process in `environment` is offered no tool. */
  probeToolDenial(
    environment: ModelCallEnvironment,
    cancellation?: AbortSignal,
  ): Promise<ToolDenialProbe>;
  /** Names of top-level worktree entries through which the agent reads configuration from the repository it works in; pure, starts no process. */
  repositoryConfigurationEntries(): readonly string[];
  run(
    input: AgentRunInput,
  ): Promise<
    TevuResult<
      AgentRunResult,
      | 'AgentProcessError'
      | 'AgentProtocolError'
      | 'AgentSessionError'
      | 'CaseTimeoutError'
      | 'CancellationError'
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
