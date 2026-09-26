/**
 * OpenCode CLI boundary: capability probing without a model session, one
 * managed `run --format json` process per case or model-call role, and
 * root-session export shared by both. Process supervision is delegated to the
 * injected `ManagedProcessRunner` and record decoding to the protocol
 * decoders; no release string ever gates behavior.
 */

import {
  normalizeFromExport,
  normalizeMetrics as normalizeOpenCodeMetrics,
} from './opencode-metrics';
import { decodeEvent, decodeExport } from './opencode-protocol';

import type { OpenCodeExport, ProtocolContext, ProtocolErrorShape } from './opencode-protocol';
import type {
  AgentAdapter,
  AgentCapability,
  AgentCapabilityReport,
  AgentMetrics,
  AgentMetricsInput,
  AgentRunInput,
  AgentRunResult,
  AgentSessionExport,
  CapabilityAvailability,
  IsolatedEnvironment,
  ManagedProcessCompletion,
  ManagedProcessResult,
  ManagedProcessRunner,
  ModelCallInput,
  ModelCallResult,
  ModelRoleName,
  ProcessResult,
  SecretRedactor,
  TevuError,
  TevuResult,
} from '@/domain/types';

/** Construction inputs identifying this adapter instance within the `AgentRegistry`. */
export type OpenCodeAdapterSettings = {
  /** The key of this adapter's `agents` block; reported in errors and as the prerequisite tool. */
  agent: string;
  /** The block's `command`, as `loadConfig` resolved it. */
  executable: string;
};

/** Effects injected into the OpenCode adapter. */
export type OpenCodeAdapterDependencies = {
  runProcess: ManagedProcessRunner;
  secrets: SecretRedactor;
  /** Replacement environment for capability probes: the parent PATH only. */
  probeEnvironment: Readonly<Record<string, string>>;
  /** Working directory for capability probes. */
  probeDirectory: string;
};

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_TERMINATION_GRACE_MS = 2_000;
const EXPORT_TIMEOUT_MS = 120_000;
const EXPORT_TERMINATION_GRACE_MS = 2_000;
const EXPORT_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

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
    async run(
      input: AgentRunInput,
    ): Promise<
      TevuResult<
        AgentRunResult,
        'AgentProcessError' | 'AgentProtocolError' | 'CaseTimeoutError' | 'CancellationError'
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
      const normalized = normalizeOpenCodeMetrics(input);
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

/** Result of one stdout-consumption pass: the identified root session and the first protocol failure, if any. */
type RunOutputResult = { sessionId: string | null; protocolFailure: ProtocolErrorShape | null };

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
    }
  };

  const splitter = createLineSplitter((line) => enqueue(() => handleLine(line)));

  return {
    pushLine: splitter.push,
    async flush(): Promise<RunOutputResult> {
      splitter.flush();
      await delivery;
      return { sessionId, protocolFailure };
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
    'AgentProcessError' | 'AgentProtocolError' | 'CaseTimeoutError' | 'CancellationError'
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
  const { sessionId, protocolFailure } = await consumer.flush();
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
  return { ok: true, value: runResult };
}

/** Outcome of one `export` process launch: a settled process needing its own mapping, a decode-layer failure, or a decoded and redacted export. */
type ExportProcessOutcome =
  | { settled: 'process'; outcome: ManagedProcessResult }
  | { settled: 'protocol-error'; error: ProtocolErrorShape }
  | { settled: 'ok'; value: OpenCodeExport };

/**
 * Runs one `export <sessionID>` process and, on a clean zero-exit and
 * untruncated capture, decodes, checks its identity, and redacts it. Shared
 * by the case path (`exportRootSession`) and the model-call path
 * (`runModelCall`), parameterized by working directory, replacement
 * variables, protocol context, and an optional cancellation signal in place
 * of an `IsolatedEnvironment`. A launch failure, non-zero exit, or truncated
 * capture is returned as the raw process outcome so each caller maps it to
 * its own error kind.
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
    maxCaptureBytes: EXPORT_MAX_CAPTURE_BYTES,
  });
  if (!outcome.launched || outcome.exitCode !== 0 || outcome.stdout.truncated) {
    return { settled: 'process', outcome };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout.text);
  } catch {
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
    'export output exceeded the capture bound and cannot be decoded',
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
): { ok: false; error: Extract<TevuError, { kind: 'ModelCallError' }> } {
  return { ok: false, error: { kind: 'ModelCallError', role, agent, cause: 'failed', reason } };
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

/**
 * Builds the reply text of one model call from its redacted root-session
 * export: the last assistant message's non-synthetic, non-ignored text parts,
 * joined by a line feed and redacted as whole text. Fails closed on a missing
 * assistant message, an assistant error or non-`stop` finish, a non-string
 * text part, or a whole-text redaction failure, per the reasons this
 * function's caller renders to the terminal.
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
    return modelCallFailed(
      context.role,
      agent,
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

async function runModelCall(
  settings: OpenCodeAdapterSettings,
  dependencies: OpenCodeAdapterDependencies,
  input: ModelCallInput,
): Promise<
  TevuResult<ModelCallResult, 'ModelCallError' | 'AgentProtocolError' | 'CancellationError'>
> {
  const context: Extract<ProtocolContext, { phase: 'call' }> = { phase: 'call', role: input.role };
  let lastError: unknown = null;

  const consumer = createRunOutputConsumer(context, dependencies.secrets, (value) => {
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
    environment: input.environment.variables,
    timeoutMs: input.timeoutMs,
    terminationGraceMs: input.terminationGraceMs,
    cancellation: input.cancellation,
    secretValues: dependencies.secrets.secretValues(),
    stdoutRedaction: 'structured',
    onStdout: consumer.pushLine,
  });
  const { sessionId, protocolFailure } = await consumer.flush();

  const settledRun = settle(runOutcome, 'run', input.timeoutMs);
  if (!settledRun.ok) {
    return {
      ok: false,
      error: toModelCallOrCancellation(input.role, settings.agent, settledRun.error),
    };
  }
  if (protocolFailure !== null) {
    return { ok: false, error: toAgentProtocolError(settings.agent, protocolFailure) };
  }
  const run = settledRun.value;
  if (run.exitCode !== null && run.exitCode !== 0) {
    const detail = summary(lastError);
    return modelCallFailed(
      input.role,
      settings.agent,
      detail === undefined
        ? `run process exited with code ${run.exitCode}`
        : `run process exited with code ${run.exitCode}: ${detail}`,
    );
  }
  if (run.exitCode === null) {
    return modelCallFailed(
      input.role,
      settings.agent,
      `run process was terminated by signal ${run.signal ?? 'unknown'}`,
    );
  }
  if (lastError !== null) {
    const detail = summary(lastError);
    return modelCallFailed(
      input.role,
      settings.agent,
      detail === undefined ? 'run reported an error' : `run reported an error: ${detail}`,
    );
  }
  if (sessionId === null) {
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
    return { ok: false, error: toAgentProtocolError(settings.agent, exportOutcome.error) };
  }
  if (exportOutcome.settled === 'process') {
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
      'export output exceeded the capture bound and cannot be decoded',
    );
  }

  const replied = replyText(exportOutcome.value, context, settings.agent, dependencies.secrets);
  if (!replied.ok) {
    return replied;
  }
  return {
    ok: true,
    value: { text: replied.value, metrics: normalizeFromExport(exportOutcome.value) },
  };
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
