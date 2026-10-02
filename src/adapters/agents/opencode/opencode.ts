/**
 * OpenCode CLI boundary: capability probing without a model session, one
 * managed `run --format json` process per case or model-call role, and
 * root-session export shared by both. Process supervision is delegated to the
 * injected `ManagedProcessRunner` and record decoding to the protocol
 * decoders; no release string ever gates behavior.
 */

import { normalizeFromExport, normalizeMetrics as normalizeOpenCodeMetrics } from './metrics';
import {
  decodeEvent,
  decodeExport,
  decodeModelListing,
  decodeToolDenial,
  isRootSessionErrorEvent,
} from './protocol';
import { inspectOpenCodeProvider, readOpenCodeProviders } from './providers';

import type { OpenCodeExport, ProtocolContext, ProtocolErrorShape } from './protocol';
import type {
  AgentAdapter,
  AgentCapability,
  AgentCapabilityReport,
  AgentMetrics,
  AgentMetricsInput,
  AgentProviderSetting,
  AgentRunInput,
  AgentRunResult,
  AgentSessionExport,
  CapabilityAvailability,
  CopiedProvider,
  IsolatedEnvironment,
  ManagedProcessCompletion,
  ManagedProcessResult,
  ManagedProcessRunner,
  ModelCallEnvironment,
  ModelCallEvidence,
  ModelCallInput,
  ModelCallResult,
  ModelListing,
  ModelRoleName,
  OperatorProvider,
  ProcessResult,
  ProviderSnapshot,
  RedactedCapture,
  SecretRedactor,
  TevuError,
  TevuResult,
  ToolDenialProbe,
} from '@/domain/types';

/** Construction inputs identifying this adapter instance within the `AgentRegistry`. */
export type OpenCodeAdapterSettings = {
  /** The key of this adapter's `agents` block; reported in errors and as the prerequisite tool. */
  agent: string;
  /** The block's `command`, as `loadConfig` resolved it. */
  executable: string;
  /** The block's `providers`, copied from the operator's OpenCode global configuration. */
  providers: readonly AgentProviderSetting[];
  /** The block's `secrets` and `env`: the only names a copied definition may reference. */
  declaredVariables: { secrets: readonly string[]; env: readonly string[] };
};

/** Effects injected into the OpenCode adapter. */
export type OpenCodeAdapterDependencies = {
  runProcess: ManagedProcessRunner;
  secrets: SecretRedactor;
  /** Replacement environment for capability probes: the parent PATH only. */
  probeEnvironment: Readonly<Record<string, string>>;
  /** Working directory for capability probes. */
  probeDirectory: string;
  /** tevu's own HOME and XDG_CONFIG_HOME; only the composition root reads them from process.env. */
  operatorDirectories: { home: string | undefined; xdgConfigHome: string | undefined };
};

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_TERMINATION_GRACE_MS = 2_000;
const EXPORT_TIMEOUT_MS = 120_000;
const EXPORT_TERMINATION_GRACE_MS = 2_000;
const EXPORT_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const COPIED_PROVIDERS_REDACTION_REASON = 'copied providers redaction failed';
const MODEL_LISTING_TIMEOUT_MS = 120_000;
const MODEL_LISTING_TERMINATION_GRACE_MS = 2_000;
const MODEL_LISTING_MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const TOOL_DENIAL_PROBE_TIMEOUT_MS = 120_000;
const TOOL_DENIAL_PROBE_TERMINATION_GRACE_MS = 2_000;
const TOOL_DENIAL_PROBE_MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

/**
 * Creates the OpenCode `AgentAdapter` over the managed process boundary and
 * the consumed protocol decoders.
 */
export function createOpenCodeAdapter(
  settings: OpenCodeAdapterSettings,
  dependencies: OpenCodeAdapterDependencies,
): AgentAdapter {
  return {
    async probe(): Promise<
      TevuResult<AgentCapabilityReport, 'PrerequisiteError' | 'AgentProtocolError'>
    > {
      return probeCapabilities(settings, dependencies);
    },
    readProviders(): Promise<TevuResult<ProviderSnapshot, 'ConfigValidationError'>> {
      return readOpenCodeProviders(settings, dependencies.operatorDirectories);
    },
    inspectOperatorProvider(
      id: string,
    ): Promise<TevuResult<OperatorProvider, 'ConfigValidationError'>> {
      return inspectOpenCodeProvider(settings.agent, id, dependencies.operatorDirectories);
    },
    listModels(
      environment: ModelCallEnvironment,
      cancellation?: AbortSignal,
    ): Promise<ModelListing> {
      return runListModels(settings, dependencies, environment, cancellation);
    },
    probeToolDenial(
      environment: ModelCallEnvironment,
      cancellation?: AbortSignal,
    ): Promise<ToolDenialProbe> {
      return runToolDenialProbe(settings, dependencies, environment, cancellation);
    },
    repositoryConfigurationEntries(): readonly string[] {
      return ['.opencode', 'opencode.json', 'opencode.jsonc'];
    },
    async run(
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
    > {
      return runCase(settings, dependencies, input);
    },
    async exportSession(
      sessionId: string,
      environment: IsolatedEnvironment,
    ): Promise<TevuResult<AgentSessionExport, 'AgentProcessError' | 'AgentProtocolError'>> {
      return exportRootSession(settings, dependencies, sessionId, environment);
    },
    normalizeMetrics(input: AgentMetricsInput): TevuResult<AgentMetrics, 'AgentProtocolError'> {
      const copiedProviders = redactCopiedProviders(dependencies.secrets, input.copiedProviders);
      if (copiedProviders === undefined) {
        return {
          ok: false,
          error: toAgentProtocolError(
            settings.agent,
            protocolFailureShape(
              { phase: 'case', caseId: input.caseId },
              COPIED_PROVIDERS_REDACTION_REASON,
            ),
          ),
        };
      }
      const normalized = normalizeOpenCodeMetrics({ ...input, copiedProviders });
      if (normalized.ok) {
        return normalized;
      }
      return { ok: false, error: toAgentProtocolError(settings.agent, normalized.error) };
    },
    async callModel(
      input: ModelCallInput,
    ): Promise<
      TevuResult<ModelCallResult, 'ModelCallError' | 'AgentProtocolError' | 'CancellationError'>
    > {
      return runModelCall(settings, dependencies, input);
    },
  };
}

/** Result of one stdout-consumption pass: the identified root session, the first protocol failure, and the last root-session error event, if any. */
type RunOutputResult = {
  sessionId: string | null;
  protocolFailure: ProtocolErrorShape | null;
  /** Redacted record of the last delivered root-session `error` event; `null` when none was delivered. */
  rootSessionError: { record: unknown } | null;
};

/**
 * Consumes one `run --format json` process's stdout: splits lines, decodes
 * each as an OpenCode event, captures the root session identity before
 * redaction, and delivers the redacted record through `onRedactedEvent`.
 * Shared by the case path (`runCase`) and the model-call path
 * (`runModelCall`), which differ only in what they do with a delivered
 * record and whether they track parse findings or route a malformed line
 * elsewhere.
 *
 * `onRedactedEvent` reports whether delivery succeeded; once it, or a
 * redaction failure, reports `false`, no further record is delivered.
 */
function createRunOutputConsumer(
  context: ProtocolContext,
  secrets: SecretRedactor,
  onRedactedEvent: (value: unknown) => Promise<boolean> | boolean,
  onParseFinding?: (finding: string) => void,
  onMalformedLine?: (rawLine: string) => void | Promise<void>,
): { pushLine: (line: string) => void; flush: () => Promise<RunOutputResult> } {
  let sessionId: string | null = null;
  let protocolFailure: ProtocolErrorShape | null = null;
  let rootSessionError: { record: unknown } | null = null;
  let deliveryStopped = false;
  let delivery: Promise<void> = Promise.resolve();
  let lineNumber = 0;

  const enqueue = (task: () => Promise<void>): void => {
    delivery = delivery.then(task);
  };

  const handleLine = async (line: string): Promise<void> => {
    lineNumber += 1;
    if (line.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      onParseFinding?.(`stdout line ${lineNumber} is not valid JSON; routed to diagnostics`);
      protocolFailure ??= protocolFailureShape(
        context,
        'run output contains malformed JSON event framing',
        lineNumber,
      );
      await onMalformedLine?.(line);
      return;
    }
    const decoded = decodeEvent(parsed, context, lineNumber);
    if (!decoded.ok) {
      onParseFinding?.(`stdout line ${lineNumber}: ${decoded.error.reason}`);
      protocolFailure ??= decoded.error;
      return;
    }
    if (decoded.value === null) {
      return;
    }
    // The root session identity must stay usable for export, so it is taken
    // from the decoded record before redaction can touch it.
    sessionId ??= decoded.value.sessionID;
    if (deliveryStopped) {
      return;
    }
    const redacted = secrets.redactValue(decoded.value);
    if (!redacted.ok) {
      deliveryStopped = true;
      protocolFailure ??= protocolFailureShape(context, 'record redaction failed; record withheld');
      return;
    }
    const delivered = await onRedactedEvent(redacted.value);
    if (!delivered) {
      deliveryStopped = true;
      return;
    }
    if (isRootSessionErrorEvent(decoded.value, sessionId)) {
      rootSessionError = { record: redacted.value };
    }
  };

  const splitter = createLineSplitter((line) => enqueue(() => handleLine(line)));

  return {
    pushLine: splitter.push,
    async flush(): Promise<RunOutputResult> {
      splitter.flush();
      await delivery;
      return { sessionId, protocolFailure, rootSessionError };
    },
  };
}

async function runCase(
  settings: OpenCodeAdapterSettings,
  dependencies: OpenCodeAdapterDependencies,
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
> {
  const caseId = input.identity.caseId;
  const context: ProtocolContext = { phase: 'case', caseId };
  const secretValues = dependencies.secrets.secretValues();
  const parseFindings: string[] = [];
  let deliveryStopped = false;
  let delivery: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): void => {
    delivery = delivery.then(task);
  };

  const deliverDiagnostic = async (line: string): Promise<void> => {
    if (deliveryStopped) {
      return;
    }
    const result = await input.onDiagnostic(line);
    if (!result.ok) {
      deliveryStopped = true;
    }
  };

  const consumer = createRunOutputConsumer(
    context,
    dependencies.secrets,
    async (value) => {
      const delivered = await input.onEvent(value);
      return delivered.ok;
    },
    (finding) => parseFindings.push(finding),
    (rawLine) => deliverDiagnostic(dependencies.secrets.redactText(rawLine)),
  );
  const stderrLines = createLineSplitter((line) => enqueue(() => deliverDiagnostic(line)));

  const outcome = await dependencies.runProcess({
    argv: [
      settings.executable,
      'run',
      '--format',
      'json',
      '--model',
      input.identity.model,
      '--variant',
      input.identity.effort,
    ],
    stdinText: input.prompt,
    cwd: input.worktreeDirectory,
    environment: input.environment.variables,
    timeoutMs: input.timeoutMs,
    terminationGraceMs: input.terminationGraceMs,
    cancellation: input.cancellation,
    secretValues,
    stdoutRedaction: 'structured',
    onStdout: consumer.pushLine,
    onStderr: stderrLines.push,
  });
  stderrLines.flush();
  const { sessionId, protocolFailure, rootSessionError } = await consumer.flush();
  await delivery;

  if (!outcome.launched) {
    await deliverDiagnostic(`opencode process could not be started: ${outcome.reason}`);
    return {
      ok: false,
      error: {
        kind: 'AgentProcessError',
        agent: settings.agent,
        caseId,
        exitCode: null,
        signal: null,
      },
    };
  }

  const processResult: ProcessResult = {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    startedAt: outcome.startedAt,
    endedAt: outcome.endedAt,
    durationMs: outcome.durationMs,
    terminationStage: outcome.terminationStage,
  };
  const runResult: AgentRunResult = { process: processResult, sessionId, parseFindings };
  input.onProcess?.(runResult);

  if (outcome.cancelled) {
    return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [caseId] } };
  }
  if (outcome.timedOut) {
    return { ok: false, error: { kind: 'CaseTimeoutError', caseId, timeoutMs: input.timeoutMs } };
  }
  if (protocolFailure !== null) {
    return { ok: false, error: toAgentProtocolError(settings.agent, protocolFailure) };
  }
  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      error: {
        kind: 'AgentProcessError',
        agent: settings.agent,
        caseId,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      },
    };
  }
  if (sessionId === null) {
    return agentProtocolError(
      settings.agent,
      context,
      'run output did not identify a root session',
    );
  }
  if (rootSessionError !== null) {
    const agentMessage = summary(rootSessionError.record);
    return {
      ok: false,
      error: {
        kind: 'AgentSessionError',
        agent: settings.agent,
        caseId,
        ...(agentMessage === undefined ? {} : { agentMessage }),
      },
    };
  }
  return { ok: true, value: runResult };
}

/** Outcome of one `export` process launch: a settled process needing its own mapping, a decode-layer failure, or a decoded and redacted export. */
type ExportProcessOutcome =
  | { settled: 'process'; outcome: ManagedProcessResult }
  | { settled: 'protocol-error'; error: ProtocolErrorShape }
  | { settled: 'ok'; value: OpenCodeExport };

/**
 * Runs one `export <sessionID>` process and, on a clean zero-exit and
 * untruncated capture, decodes, checks its identity, and redacts it. An
 * incomplete capture is parsed like a complete one: a strict prefix of one JSON
 * object never parses, so text that parses is the whole document. Shared
 * by the case path (`exportRootSession`) and the model-call path
 * (`runModelCall`), parameterized by working directory, replacement
 * variables, protocol context, and an optional cancellation signal in place
 * of an `IsolatedEnvironment`. A launch failure, non-zero exit, truncated
 * capture, or incomplete capture that does not parse is returned as the raw
 * process outcome so each caller maps it to its own error kind.
 *
 * The process writes to a regular file rather than a pipe: OpenCode calls
 * `process.exit()` right after writing the export, a pending write to a
 * socket-backed stdout is lost at exit, and a regular file receives every byte
 * before the write returns.
 */
async function runExportProcess(
  settings: OpenCodeAdapterSettings,
  dependencies: OpenCodeAdapterDependencies,
  sessionId: string,
  cwd: string,
  variables: Record<string, string>,
  context: ProtocolContext,
  cancellation?: AbortSignal,
): Promise<ExportProcessOutcome> {
  const outcome = await dependencies.runProcess({
    argv: [settings.executable, 'export', sessionId],
    cwd,
    environment: variables,
    timeoutMs: EXPORT_TIMEOUT_MS,
    terminationGraceMs: EXPORT_TERMINATION_GRACE_MS,
    cancellation,
    secretValues: dependencies.secrets.secretValues(),
    // The export is one structured JSON document: it is captured raw within
    // this boundary, decoded, and redacted as a value so numeric metrics
    // survive; the raw capture never reaches a sink.
    stdoutRedaction: 'structured',
    stdoutTarget: 'file',
    maxCaptureBytes: EXPORT_MAX_CAPTURE_BYTES,
  });
  if (!outcome.launched || outcome.exitCode !== 0 || outcome.stdout.truncated) {
    return { settled: 'process', outcome };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout.text);
  } catch {
    if (outcome.stdout.incomplete) {
      return { settled: 'process', outcome };
    }
    return {
      settled: 'protocol-error',
      error: protocolFailureShape(context, 'export output is not valid JSON'),
    };
  }
  const decoded = decodeExport(parsed, context);
  if (!decoded.ok) {
    return { settled: 'protocol-error', error: decoded.error };
  }
  if (decoded.value.info.id !== sessionId) {
    return {
      settled: 'protocol-error',
      error: protocolFailureShape(
        context,
        'export identity does not match the requested root session',
      ),
    };
  }
  const redacted = dependencies.secrets.redactValue(decoded.value);
  if (!redacted.ok) {
    return {
      settled: 'protocol-error',
      error: protocolFailureShape(context, 'record redaction failed; record withheld'),
    };
  }
  // `redactValue` redacts every string of the decoded export in place, so the
  // result still satisfies the decoded export's shape.
  return { settled: 'ok', value: redacted.value as OpenCodeExport };
}

function undecodableExportReason(stdout: RedactedCapture): string {
  return stdout.truncated
    ? 'export output exceeded the capture bound and cannot be decoded'
    : 'export output is incomplete: tevu stopped its process group before the output ended';
}

async function exportRootSession(
  settings: OpenCodeAdapterSettings,
  dependencies: OpenCodeAdapterDependencies,
  sessionId: string,
  environment: IsolatedEnvironment,
): Promise<TevuResult<AgentSessionExport, 'AgentProcessError' | 'AgentProtocolError'>> {
  const caseId = environment.caseId;
  const context: ProtocolContext = { phase: 'case', caseId };
  const outcome = await runExportProcess(
    settings,
    dependencies,
    sessionId,
    environment.homeDirectory,
    environment.variables,
    context,
  );
  if (outcome.settled === 'ok') {
    return { ok: true, value: outcome.value };
  }
  if (outcome.settled === 'protocol-error') {
    return { ok: false, error: toAgentProtocolError(settings.agent, outcome.error) };
  }
  const processOutcome = outcome.outcome;
  if (!processOutcome.launched || processOutcome.exitCode !== 0) {
    return {
      ok: false,
      error: {
        kind: 'AgentProcessError',
        agent: settings.agent,
        caseId,
        exitCode: processOutcome.launched ? processOutcome.exitCode : null,
        signal: processOutcome.launched ? processOutcome.signal : null,
      },
    };
  }
  return agentProtocolError(
    settings.agent,
    context,
    undecodableExportReason(processOutcome.stdout),
  );
}

/** A `settle` failure before its calling model call's role and agent identity are attached. */
type SettleFailure =
  | { kind: 'CancellationError' }
  | { kind: 'ModelCallError'; cause: 'launch-failed' | 'timed-out'; reason: string };

type SettleResult =
  { ok: true; value: ManagedProcessCompletion } | { ok: false; error: SettleFailure };

/**
 * Classifies a settled managed-process outcome for a model call: a launch
 * failure, a cancellation, or a timeout, before its exit status is inspected.
 * `step` names the process for its reason text ("run" or "export").
 */
function settle(
  outcome: ManagedProcessResult,
  step: 'run' | 'export',
  limitMs: number,
): SettleResult {
  if (!outcome.launched) {
    return {
      ok: false,
      error:
        outcome.reason === 'cancelled before launch'
          ? { kind: 'CancellationError' }
          : {
              kind: 'ModelCallError',
              cause: 'launch-failed',
              reason: `${step} process could not be started: ${outcome.reason}`,
            },
    };
  }
  if (outcome.cancelled) {
    return { ok: false, error: { kind: 'CancellationError' } };
  }
  if (outcome.timedOut) {
    return {
      ok: false,
      error: {
        kind: 'ModelCallError',
        cause: 'timed-out',
        reason: `${step} process did not finish within ${limitMs}ms`,
      },
    };
  }
  return { ok: true, value: outcome };
}

/** Attaches the calling model call's role and agent identity to a `settle` failure. */
function toModelCallOrCancellation(
  role: ModelRoleName,
  agent: string,
  failure: SettleFailure,
): Extract<TevuError, { kind: 'CancellationError' | 'ModelCallError' }> {
  return failure.kind === 'CancellationError'
    ? { kind: 'CancellationError', activeCaseIds: [] }
    : { kind: 'ModelCallError', role, agent, cause: failure.cause, reason: failure.reason };
}

function modelCallFailed(
  role: ModelRoleName,
  agent: string,
  reason: string,
  agentMessage?: string,
): { ok: false; error: Extract<TevuError, { kind: 'ModelCallError' }> } {
  return {
    ok: false,
    error: {
      kind: 'ModelCallError',
      role,
      agent,
      cause: 'failed',
      reason,
      ...(agentMessage === undefined ? {} : { agentMessage }),
    },
  };
}

function modelCallStopped(
  role: ModelRoleName,
  agent: string,
  cause: 'unfinished' | 'tool-call',
  reason: string,
): { ok: false; error: Extract<TevuError, { kind: 'ModelCallError' }> } {
  return { ok: false, error: { kind: 'ModelCallError', role, agent, cause, reason } };
}

/**
 * Extracts a one-line failure summary from a decoded, redacted `error` event
 * or an assistant message's info: the error's `data.message` when it is a
 * non-empty string, else its `name` when that is non-empty, else none. Only
 * the candidate's first line is kept; an empty first line counts as none.
 */
function summary(record: unknown): string | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  const error = record['error'];
  if (!isRecord(error)) {
    return undefined;
  }
  const data = error['data'];
  const message = isRecord(data) ? data['message'] : undefined;
  const name = error['name'];
  const candidate = isNonEmptyString(message) ? message : isNonEmptyString(name) ? name : undefined;
  if (candidate === undefined) {
    return undefined;
  }
  const firstLine = candidate.split('\n', 1)[0] ?? '';
  return firstLine.length > 0 ? firstLine : undefined;
}

/** One root-session export message narrowed to its assistant-role info. */
type AssistantMessage = OpenCodeExport['messages'][number] & {
  info: Extract<OpenCodeExport['messages'][number]['info'], { role: 'assistant' }>;
};

function isAssistantMessage(
  message: OpenCodeExport['messages'][number],
): message is AssistantMessage {
  return message.info.role === 'assistant';
}

/** Names the distinct tools the export's assistant messages called, in export order. */
function toolCallReason(sessionExport: OpenCodeExport): string {
  const names: string[] = [];
  for (const message of sessionExport.messages.filter(isAssistantMessage)) {
    for (const part of message.parts) {
      const { tool } = part as Partial<{ tool: unknown }>;
      if (part.type === 'tool' && isNonEmptyString(tool) && !names.includes(tool)) {
        names.push(tool);
      }
    }
  }
  const denied = 'although every tool is denied to a model call';
  if (names.length === 0) {
    return `the session holds a tool call ${denied}`;
  }
  const quoted = names.map((name) => `"${name}"`).join(', ');
  return `the session called the ${names.length === 1 ? 'tool' : 'tools'} ${quoted} ${denied}`;
}

function hasToolPart(sessionExport: OpenCodeExport): boolean {
  return sessionExport.messages
    .filter(isAssistantMessage)
    .some((message) => message.parts.some((part) => part.type === 'tool'));
}

/**
 * Builds the reply text of one model call from its redacted root-session
 * export: the last assistant message's non-synthetic, non-ignored text parts,
 * joined by a line feed and redacted as whole text. Fails closed on a missing
 * assistant message, an assistant error, a non-`stop` finish (cause
 * `unfinished`), a non-string text part, or a whole-text redaction failure,
 * per the reasons this function's caller renders to the terminal.
 */
function replyText(
  sessionExport: OpenCodeExport,
  context: Extract<ProtocolContext, { phase: 'call' }>,
  agent: string,
  secrets: SecretRedactor,
): TevuResult<string, 'ModelCallError' | 'AgentProtocolError'> {
  const message = sessionExport.messages.filter(isAssistantMessage).at(-1);
  if (message === undefined) {
    return agentProtocolError(agent, context, 'root session export contains no assistant message');
  }
  const info = message.info;
  if (info.error !== undefined && info.error !== null) {
    const detail = summary(info);
    return modelCallFailed(
      context.role,
      agent,
      detail === undefined
        ? 'final assistant message carries an error'
        : `final assistant message carries an error: ${detail}`,
    );
  }
  if (info.finish !== 'stop') {
    return modelCallStopped(
      context.role,
      agent,
      'unfinished',
      isNonEmptyString(info.finish)
        ? `final assistant message finished with "${info.finish}"`
        : 'final assistant message has no finish reason',
    );
  }

  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.type !== 'text') {
      continue;
    }
    const additive = part as Partial<{ synthetic: boolean; ignored: boolean; text: unknown }>;
    if (additive.synthetic === true || additive.ignored === true) {
      continue;
    }
    if (typeof additive.text !== 'string') {
      return agentProtocolError(
        agent,
        context,
        `text part "${part.id}" of the final assistant message carries no text string`,
      );
    }
    texts.push(additive.text);
  }
  const joined = texts.join('\n');
  try {
    return { ok: true, value: secrets.redactText(joined) };
  } catch {
    return agentProtocolError(agent, context, 'reply redaction failed; reply withheld');
  }
}

/**
 * Redacts the copied providers with the same redactor that redacts the
 * export, so a secret value inside a provider or model key is masked on both
 * sides of the cost lookup. Returns `undefined` when redaction fails.
 */
function redactCopiedProviders(
  secrets: SecretRedactor,
  copiedProviders: readonly CopiedProvider[],
): readonly CopiedProvider[] | undefined {
  const redacted = secrets.redactValue(copiedProviders);
  // `redactValue` rebuilds every string of the list, keys included, so the
  // result keeps the `CopiedProvider` shape the input had.
  return redacted.ok ? (redacted.value as readonly CopiedProvider[]) : undefined;
}

/**
 * Permission JSON every model call's `run` process receives. A tool the
 * model may call but the process cannot approve ends the session with finish
 * `tool-calls` and no reply, so no tool is offered to a model call at all.
 */
const MODEL_CALL_PERMISSION = '{"*":"deny"}';

async function runModelCall(
  settings: OpenCodeAdapterSettings,
  dependencies: OpenCodeAdapterDependencies,
  input: ModelCallInput,
): Promise<
  TevuResult<ModelCallResult, 'ModelCallError' | 'AgentProtocolError' | 'CancellationError'>
> {
  const context: Extract<ProtocolContext, { phase: 'call' }> = { phase: 'call', role: input.role };
  const copiedProviders = redactCopiedProviders(dependencies.secrets, input.copiedProviders);
  if (copiedProviders === undefined) {
    return agentProtocolError(settings.agent, context, COPIED_PROVIDERS_REDACTION_REASON);
  }
  let lastError: unknown = null;
  const events: ModelCallEvidence['events'] = [];

  const consumer = createRunOutputConsumer(context, dependencies.secrets, (value) => {
    events.push(value);
    if (isRecord(value) && value['type'] === 'error') {
      lastError = value;
    }
    return true;
  });

  const runOutcome = await dependencies.runProcess({
    argv: [
      settings.executable,
      'run',
      '--format',
      'json',
      '--model',
      input.model,
      '--variant',
      input.effort,
    ],
    stdinText: input.prompt,
    cwd: input.environment.workingDirectory,
    environment: { ...input.environment.variables, OPENCODE_PERMISSION: MODEL_CALL_PERMISSION },
    timeoutMs: input.timeoutMs,
    terminationGraceMs: input.terminationGraceMs,
    cancellation: input.cancellation,
    secretValues: dependencies.secrets.secretValues(),
    stdoutRedaction: 'structured',
    onStdout: consumer.pushLine,
  });
  const { sessionId, protocolFailure } = await consumer.flush();

  const evidence: ModelCallEvidence = {
    events,
    diagnostics: runOutcome.launched ? runOutcome.stderr.text : '',
    session: null,
  };
  const reportEvidence = (): void => {
    if (runOutcome.launched) {
      input.onEvidence?.(evidence);
    }
  };

  const settledRun = settle(runOutcome, 'run', input.timeoutMs);
  if (!settledRun.ok) {
    reportEvidence();
    return {
      ok: false,
      error: toModelCallOrCancellation(input.role, settings.agent, settledRun.error),
    };
  }
  if (protocolFailure !== null) {
    reportEvidence();
    return { ok: false, error: toAgentProtocolError(settings.agent, protocolFailure) };
  }
  const run = settledRun.value;
  if (run.exitCode !== null && run.exitCode !== 0) {
    reportEvidence();
    const detail = summary(lastError);
    return modelCallFailed(
      input.role,
      settings.agent,
      detail === undefined
        ? `run process exited with code ${run.exitCode}`
        : `run process exited with code ${run.exitCode}: ${detail}`,
      detail,
    );
  }
  if (run.exitCode === null) {
    reportEvidence();
    return modelCallFailed(
      input.role,
      settings.agent,
      `run process was terminated by signal ${run.signal ?? 'unknown'}`,
    );
  }
  if (lastError !== null) {
    reportEvidence();
    const detail = summary(lastError);
    return modelCallFailed(
      input.role,
      settings.agent,
      detail === undefined ? 'run reported an error' : `run reported an error: ${detail}`,
      detail,
    );
  }
  if (sessionId === null) {
    reportEvidence();
    return agentProtocolError(
      settings.agent,
      context,
      'run output did not identify a root session',
    );
  }

  const exportOutcome = await runExportProcess(
    settings,
    dependencies,
    sessionId,
    input.environment.homeDirectory,
    input.environment.variables,
    context,
    input.cancellation,
  );
  if (exportOutcome.settled === 'protocol-error') {
    reportEvidence();
    return { ok: false, error: toAgentProtocolError(settings.agent, exportOutcome.error) };
  }
  if (exportOutcome.settled === 'process') {
    reportEvidence();
    const settledExport = settle(exportOutcome.outcome, 'export', EXPORT_TIMEOUT_MS);
    if (!settledExport.ok) {
      return {
        ok: false,
        error: toModelCallOrCancellation(input.role, settings.agent, settledExport.error),
      };
    }
    const exportProcess = settledExport.value;
    if (exportProcess.exitCode !== null && exportProcess.exitCode !== 0) {
      return modelCallFailed(
        input.role,
        settings.agent,
        `export process exited with code ${exportProcess.exitCode}`,
      );
    }
    if (exportProcess.exitCode === null) {
      return modelCallFailed(
        input.role,
        settings.agent,
        `export process was terminated by signal ${exportProcess.signal ?? 'unknown'}`,
      );
    }
    return agentProtocolError(
      settings.agent,
      context,
      undecodableExportReason(exportProcess.stdout),
    );
  }

  const metrics = normalizeFromExport(exportOutcome.value, copiedProviders);
  evidence.session = { export: exportOutcome.value, metrics };
  reportEvidence();
  if (hasToolPart(exportOutcome.value)) {
    return modelCallStopped(
      input.role,
      settings.agent,
      'tool-call',
      toolCallReason(exportOutcome.value),
    );
  }
  const replied = replyText(exportOutcome.value, context, settings.agent, dependencies.secrets);
  if (!replied.ok) {
    return replied;
  }
  return { ok: true, value: { text: replied.value, metrics } };
}

/**
 * Lists every model the agent resolves in `environment`, with the variants it
 * reports for each, by running `<executable> models --verbose` without
 * starting a model session. A cancellation terminates the listing's process
 * group.
 */
async function runListModels(
  settings: OpenCodeAdapterSettings,
  dependencies: OpenCodeAdapterDependencies,
  environment: ModelCallEnvironment,
  cancellation: AbortSignal | undefined,
): Promise<ModelListing> {
  const outcome = await dependencies.runProcess({
    argv: [settings.executable, 'models', '--verbose'],
    cwd: environment.workingDirectory,
    environment: environment.variables,
    timeoutMs: MODEL_LISTING_TIMEOUT_MS,
    terminationGraceMs: MODEL_LISTING_TERMINATION_GRACE_MS,
    cancellation,
    secretValues: dependencies.secrets.secretValues(),
    // OpenCode exits right after printing, which can drop a pending pipe write
    // of a listing this large.
    stdoutTarget: 'file',
    maxCaptureBytes: MODEL_LISTING_MAX_CAPTURE_BYTES,
  });
  if (!outcome.launched) {
    return outcome.reason === 'cancelled before launch'
      ? { outcome: 'cancelled' }
      : { outcome: 'failed', reason: `cannot be started: ${outcome.reason}` };
  }
  if (outcome.cancelled) {
    return { outcome: 'cancelled' };
  }
  if (outcome.timedOut) {
    return { outcome: 'timed-out', limitMs: MODEL_LISTING_TIMEOUT_MS };
  }
  if (outcome.exitCode === null) {
    return { outcome: 'failed', reason: `is terminated by signal ${outcome.signal ?? 'unknown'}` };
  }
  if (outcome.exitCode !== 0) {
    return { outcome: 'failed', reason: `exits with code ${outcome.exitCode}` };
  }
  if (outcome.stdout.truncated) {
    return {
      outcome: 'failed',
      reason: `prints more than ${MODEL_LISTING_MAX_CAPTURE_BYTES} bytes`,
    };
  }
  if (outcome.stdout.incomplete) {
    return { outcome: 'failed', reason: 'prints output tevu could not read to its end' };
  }
  const { models, variants } = decodeModelListing(outcome.stdout.text);
  return { outcome: 'listed', models, variants };
}

/**
 * Checks, by running `<executable> debug config` without starting a model
 * session, that the configuration OpenCode resolves in `environment` denies
 * every tool. The process gets the model call's variables and working
 * directory, never the capability probe's, so it reads no operator
 * configuration. Its output stays in this function: only a redacted clause
 * leaves it.
 */
async function runToolDenialProbe(
  settings: OpenCodeAdapterSettings,
  dependencies: OpenCodeAdapterDependencies,
  environment: ModelCallEnvironment,
  cancellation: AbortSignal | undefined,
): Promise<ToolDenialProbe> {
  const outcome = await dependencies.runProcess({
    argv: [settings.executable, 'debug', 'config'],
    cwd: environment.workingDirectory,
    environment: { ...environment.variables, OPENCODE_PERMISSION: MODEL_CALL_PERMISSION },
    timeoutMs: TOOL_DENIAL_PROBE_TIMEOUT_MS,
    terminationGraceMs: TOOL_DENIAL_PROBE_TERMINATION_GRACE_MS,
    cancellation,
    secretValues: dependencies.secrets.secretValues(),
    stdoutRedaction: 'structured',
    // OpenCode exits right after printing, which can drop a pending pipe write
    // of output this large.
    stdoutTarget: 'file',
    maxCaptureBytes: TOOL_DENIAL_PROBE_MAX_CAPTURE_BYTES,
  });
  const quoted = (kind: 'failed' | 'not-shown', clause: string): ToolDenialProbe => {
    const command = `"${settings.executable} debug config"`;
    try {
      return {
        outcome: kind,
        reason: dependencies.secrets.redactText(`${command} ${clause}`),
      };
    } catch {
      return {
        outcome: kind,
        reason: 'the debug config result could not be redacted',
      };
    }
  };
  if (!outcome.launched) {
    return outcome.reason === 'cancelled before launch'
      ? { outcome: 'cancelled' }
      : quoted('failed', `cannot be started: ${outcome.reason}`);
  }
  if (outcome.cancelled) {
    return { outcome: 'cancelled' };
  }
  if (outcome.timedOut) {
    return quoted('failed', `did not finish within ${TOOL_DENIAL_PROBE_TIMEOUT_MS / 1000}s`);
  }
  if (outcome.exitCode === null) {
    return quoted('failed', `is terminated by signal ${outcome.signal ?? 'unknown'}`);
  }
  if (outcome.exitCode !== 0) {
    return quoted('failed', `exits with code ${outcome.exitCode}`);
  }
  if (outcome.stdout.truncated) {
    return quoted('failed', `prints more than ${TOOL_DENIAL_PROBE_MAX_CAPTURE_BYTES} bytes`);
  }
  if (outcome.stdout.incomplete) {
    return quoted('failed', 'prints output tevu could not read to its end');
  }
  const decision = decodeToolDenial(outcome.stdout.text);
  return decision.denied ? { outcome: 'denied' } : quoted('not-shown', decision.reason);
}

async function probeCapabilities(
  settings: OpenCodeAdapterSettings,
  dependencies: OpenCodeAdapterDependencies,
): Promise<TevuResult<AgentCapabilityReport, 'PrerequisiteError' | 'AgentProtocolError'>> {
  const executable = settings.executable;
  const environment = { ...dependencies.probeEnvironment };
  const rootHelp = await probeInvocation(dependencies, [executable, '--help'], environment);
  if (!rootHelp.launched) {
    return {
      ok: false,
      error: {
        kind: 'PrerequisiteError',
        tool: settings.agent,
        expected: `configured executable "${executable}" starts`,
        actual: rootHelp.reason,
      },
    };
  }
  if (rootHelp.exitCode !== 0) {
    return {
      ok: false,
      error: {
        kind: 'PrerequisiteError',
        tool: settings.agent,
        expected: `"${executable} --help" exits 0`,
        actual: describeSettledProcess(rootHelp),
      },
    };
  }

  const detectedVersion = await probeVersion(dependencies, executable, environment);
  const runHelp = await probeInvocation(dependencies, [executable, 'run', '--help'], environment);
  const exportHelp = await probeInvocation(
    dependencies,
    [executable, 'export', '--help'],
    environment,
  );
  const modelsHelp = await probeInvocation(
    dependencies,
    [executable, 'models', '--help'],
    environment,
  );
  const runHelpText = combinedOutput(runHelp);
  const availableWhen = (available: boolean): CapabilityAvailability =>
    available ? 'available' : 'unavailable';

  const capabilities: AgentCapability[] = [
    { name: 'run command', required: true, availability: availableWhen(helpSucceeded(runHelp)) },
    {
      name: 'export command',
      required: true,
      availability: availableWhen(helpSucceeded(exportHelp)),
    },
    {
      // Root help lists "opencode models" among the commands when the
      // executable supports it; `--help` on an unknown subcommand exits 0
      // and prints root help, so exit status alone cannot decide this.
      name: 'models command',
      required: true,
      availability: availableWhen(
        helpSucceeded(modelsHelp) && combinedOutput(modelsHelp).includes('opencode models'),
      ),
    },
    {
      // Root help has no `--verbose`, so a root-help answer for an unknown
      // subcommand cannot satisfy this.
      name: 'models --verbose',
      required: true,
      availability: availableWhen(
        helpSucceeded(modelsHelp) &&
          combinedOutput(modelsHelp).includes('opencode models') &&
          combinedOutput(modelsHelp).includes('--verbose'),
      ),
    },
    {
      name: 'run --format json',
      required: true,
      availability: availableWhen(
        runHelpText.includes('--format') && /\bjson\b/i.test(runHelpText),
      ),
    },
    {
      name: 'run --model',
      required: true,
      availability: availableWhen(runHelpText.includes('--model')),
    },
    {
      name: 'run --variant',
      required: true,
      availability: availableWhen(runHelpText.includes('--variant')),
    },
  ];

  const report: AgentCapabilityReport = {
    executable,
    detectedVersion,
    capabilities,
    isolation: {
      // A generic permission flag does not establish an enforceable external-directory policy.
      denyOutsideWorktree: 'unavailable',
    },
  };

  const missing = capabilities
    .filter((capability) => capability.required && capability.availability === 'unavailable')
    .map((capability) => capability.name);
  if (missing.length > 0) {
    return agentProtocolError(
      settings.agent,
      { phase: 'probe' },
      `configured OpenCode executable is missing required capabilities: ${missing.join(', ')}`,
    );
  }
  return { ok: true, value: report };
}

async function probeVersion(
  dependencies: OpenCodeAdapterDependencies,
  executable: string,
  environment: Record<string, string>,
): Promise<string | null> {
  const outcome = await probeInvocation(dependencies, [executable, '--version'], environment);
  if (!outcome.launched || outcome.exitCode !== 0) {
    return null;
  }
  const firstLine = outcome.stdout.text.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.length > 0 ? firstLine : null;
}

async function probeInvocation(
  dependencies: OpenCodeAdapterDependencies,
  argv: [string, ...string[]],
  environment: Record<string, string>,
): Promise<ManagedProcessResult> {
  return dependencies.runProcess({
    argv,
    cwd: dependencies.probeDirectory,
    environment,
    timeoutMs: PROBE_TIMEOUT_MS,
    terminationGraceMs: PROBE_TERMINATION_GRACE_MS,
  });
}

function helpSucceeded(outcome: ManagedProcessResult): boolean {
  return outcome.launched && outcome.exitCode === 0;
}

function combinedOutput(outcome: ManagedProcessResult): string {
  if (!outcome.launched) {
    return '';
  }
  return `${outcome.stdout.text}\n${outcome.stderr.text}`;
}

function describeSettledProcess(outcome: ManagedProcessCompletion): string {
  return outcome.exitCode !== null
    ? `exit code ${outcome.exitCode}`
    : `terminated by signal ${outcome.signal ?? 'unknown'}`;
}

type LineSplitter = {
  push: (text: string) => void;
  flush: () => void;
};

function createLineSplitter(deliver: (line: string) => void): LineSplitter {
  let buffer = '';
  const emit = (line: string): void => {
    deliver(line.endsWith('\r') ? line.slice(0, -1) : line);
  };
  return {
    push(text: string): void {
      buffer += text;
      for (;;) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          return;
        }
        emit(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        emit(buffer);
        buffer = '';
      }
    },
  };
}

function agentProtocolError(
  agent: string,
  context: ProtocolContext,
  reason: string,
  line?: number,
): { ok: false; error: Extract<TevuError, { kind: 'AgentProtocolError' }> } {
  return {
    ok: false,
    error:
      line === undefined
        ? { kind: 'AgentProtocolError', agent, context, reason }
        : { kind: 'AgentProtocolError', agent, context, line, reason },
  };
}

/** Adds this adapter instance's agent name to a decoded protocol failure. */
function toAgentProtocolError(
  agent: string,
  error: ProtocolErrorShape,
): Extract<TevuError, { kind: 'AgentProtocolError' }> {
  return error.line === undefined
    ? { kind: 'AgentProtocolError', agent, context: error.context, reason: error.reason }
    : {
        kind: 'AgentProtocolError',
        agent,
        context: error.context,
        line: error.line,
        reason: error.reason,
      };
}

function protocolFailureShape(
  context: ProtocolContext,
  reason: string,
  line?: number,
): ProtocolErrorShape {
  return line === undefined
    ? { kind: 'OpenCodeProtocolError', context, reason }
    : { kind: 'OpenCodeProtocolError', context, line, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
