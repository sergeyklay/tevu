/**
 * OpenCode CLI boundary: capability probing without a model session, exactly
 * one managed `run --format json` process per case, and root-session export.
 * Process supervision is delegated to the injected `ManagedProcessRunner` and
 * record decoding to the protocol decoders; no release string ever gates
 * behavior.
 */

import { decodeEvent, decodeExport } from "./opencode-protocol.ts";
import { normalizeMetrics as normalizeOpenCodeMetrics } from "./opencode-metrics.ts";

import type { ProtocolContext, ProtocolErrorShape } from "./opencode-protocol.ts";
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
  ProcessResult,
  SecretRedactor,
  TevuError,
  TevuResult,
} from "../../../domain/types.ts";

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
    async probe(): Promise<TevuResult<AgentCapabilityReport, "PrerequisiteError" | "AgentProtocolError">> {
      return probeCapabilities(settings, dependencies);
    },
    async run(
      input: AgentRunInput,
    ): Promise<
      TevuResult<
        AgentRunResult,
        "AgentProcessError" | "AgentProtocolError" | "CaseTimeoutError" | "CancellationError"
      >
    > {
      return runCase(settings, dependencies, input);
    },
    async exportSession(
      sessionId: string,
      environment: IsolatedEnvironment,
    ): Promise<TevuResult<AgentSessionExport, "AgentProcessError" | "AgentProtocolError">> {
      return exportRootSession(settings, dependencies, sessionId, environment);
    },
    normalizeMetrics(input: AgentMetricsInput): TevuResult<AgentMetrics, "AgentProtocolError"> {
      const normalized = normalizeOpenCodeMetrics(input);
      if (normalized.ok) {
        return normalized;
      }
      return { ok: false, error: toAgentProtocolError(settings.agent, normalized.error) };
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
    "AgentProcessError" | "AgentProtocolError" | "CaseTimeoutError" | "CancellationError"
  >
> {
  const caseId = input.identity.caseId;
  const context: ProtocolContext = { phase: "case", caseId };
  const secretValues = dependencies.secrets.secretValues();
  const parseFindings: string[] = [];
  let sessionId: string | null = null;
  let protocolFailure: Extract<TevuError, { kind: "AgentProtocolError" }> | null = null;
  let deliveryStopped = false;
  let delivery: Promise<void> = Promise.resolve();
  let stdoutLineNumber = 0;

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

  const handleStdoutLine = async (line: string): Promise<void> => {
    stdoutLineNumber += 1;
    if (line.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parseFindings.push(`stdout line ${stdoutLineNumber} is not valid JSON; routed to diagnostics`);
      protocolFailure ??= agentProtocolError(
        settings.agent,
        context,
        "run output contains malformed JSON event framing",
        stdoutLineNumber,
      ).error;
      await deliverDiagnostic(dependencies.secrets.redactText(line));
      return;
    }
    const decoded = decodeEvent(parsed, context, stdoutLineNumber);
    if (!decoded.ok) {
      parseFindings.push(`stdout line ${stdoutLineNumber}: ${decoded.error.reason}`);
      protocolFailure ??= toAgentProtocolError(settings.agent, decoded.error);
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
    const redacted = dependencies.secrets.redactValue(decoded.value);
    if (!redacted.ok) {
      deliveryStopped = true;
      protocolFailure ??= agentProtocolError(
        settings.agent,
        context,
        "record redaction failed; record withheld",
      ).error;
      return;
    }
    const delivered = await input.onEvent(redacted.value);
    if (!delivered.ok) {
      deliveryStopped = true;
    }
  };

  const stdoutLines = createLineSplitter((line) => enqueue(() => handleStdoutLine(line)));
  const stderrLines = createLineSplitter((line) => enqueue(() => deliverDiagnostic(line)));

  const outcome = await dependencies.runProcess({
    argv: [
      settings.executable,
      "run",
      "--format",
      "json",
      "--model",
      input.identity.model,
      "--variant",
      input.identity.effort,
      input.prompt,
    ],
    cwd: input.worktreeDirectory,
    environment: input.environment.variables,
    timeoutMs: input.timeoutMs,
    terminationGraceMs: input.terminationGraceMs,
    cancellation: input.cancellation,
    secretValues,
    stdoutRedaction: "structured",
    onStdout: stdoutLines.push,
    onStderr: stderrLines.push,
  });
  stdoutLines.flush();
  stderrLines.flush();
  await delivery;

  if (!outcome.launched) {
    await deliverDiagnostic(`opencode process could not be started: ${outcome.reason}`);
    return {
      ok: false,
      error: { kind: "AgentProcessError", agent: settings.agent, caseId, exitCode: null, signal: null },
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
    return { ok: false, error: { kind: "CancellationError", activeCaseIds: [caseId] } };
  }
  if (outcome.timedOut) {
    return { ok: false, error: { kind: "CaseTimeoutError", caseId, timeoutMs: input.timeoutMs } };
  }
  if (protocolFailure !== null) {
    return { ok: false, error: protocolFailure };
  }
  if (sessionId === null) {
    return agentProtocolError(settings.agent, context, "run output did not identify a root session");
  }
  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      error: {
        kind: "AgentProcessError",
        agent: settings.agent,
        caseId,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      },
    };
  }
  return { ok: true, value: runResult };
}

async function exportRootSession(
  settings: OpenCodeAdapterSettings,
  dependencies: OpenCodeAdapterDependencies,
  sessionId: string,
  environment: IsolatedEnvironment,
): Promise<TevuResult<AgentSessionExport, "AgentProcessError" | "AgentProtocolError">> {
  const caseId = environment.caseId;
  const context: ProtocolContext = { phase: "case", caseId };
  const outcome = await dependencies.runProcess({
    argv: [settings.executable, "export", sessionId],
    cwd: environment.homeDirectory,
    environment: environment.variables,
    timeoutMs: EXPORT_TIMEOUT_MS,
    terminationGraceMs: EXPORT_TERMINATION_GRACE_MS,
    secretValues: dependencies.secrets.secretValues(),
    // The export is one structured JSON document: it is captured raw within
    // this boundary, decoded, and redacted as a value so numeric metrics
    // survive; the raw capture never reaches a sink.
    stdoutRedaction: "structured",
    maxCaptureBytes: EXPORT_MAX_CAPTURE_BYTES,
  });
  if (!outcome.launched) {
    return {
      ok: false,
      error: { kind: "AgentProcessError", agent: settings.agent, caseId, exitCode: null, signal: null },
    };
  }
  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      error: {
        kind: "AgentProcessError",
        agent: settings.agent,
        caseId,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      },
    };
  }
  if (outcome.stdout.truncated) {
    return agentProtocolError(settings.agent, context, "export output exceeded the capture bound and cannot be decoded");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout.text);
  } catch {
    return agentProtocolError(settings.agent, context, "export output is not valid JSON");
  }
  const decoded = decodeExport(parsed, context);
  if (!decoded.ok) {
    return { ok: false, error: toAgentProtocolError(settings.agent, decoded.error) };
  }
  if (decoded.value.info.id !== sessionId) {
    return agentProtocolError(settings.agent, context, "export identity does not match the requested root session");
  }
  const redacted = dependencies.secrets.redactValue(decoded.value);
  if (!redacted.ok) {
    return agentProtocolError(settings.agent, context, "record redaction failed; record withheld");
  }
  // `redactValue` redacts every string of the decoded export in place, so the
  // result still satisfies the export's opaque, JSON-object shape.
  return { ok: true, value: redacted.value as AgentSessionExport };
}

async function probeCapabilities(
  settings: OpenCodeAdapterSettings,
  dependencies: OpenCodeAdapterDependencies,
): Promise<TevuResult<AgentCapabilityReport, "PrerequisiteError" | "AgentProtocolError">> {
  const executable = settings.executable;
  const environment = { ...dependencies.probeEnvironment };
  const rootHelp = await probeInvocation(dependencies, [executable, "--help"], environment);
  if (!rootHelp.launched) {
    return {
      ok: false,
      error: {
        kind: "PrerequisiteError",
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
        kind: "PrerequisiteError",
        tool: settings.agent,
        expected: `"${executable} --help" exits 0`,
        actual: describeSettledProcess(rootHelp),
      },
    };
  }

  const detectedVersion = await probeVersion(dependencies, executable, environment);
  const runHelp = await probeInvocation(dependencies, [executable, "run", "--help"], environment);
  const exportHelp = await probeInvocation(dependencies, [executable, "export", "--help"], environment);
  const runHelpText = combinedOutput(runHelp);
  const availableWhen = (available: boolean): CapabilityAvailability =>
    available ? "available" : "unavailable";

  const capabilities: AgentCapability[] = [
    { name: "run command", required: true, availability: availableWhen(helpSucceeded(runHelp)) },
    { name: "export command", required: true, availability: availableWhen(helpSucceeded(exportHelp)) },
    {
      name: "run --format json",
      required: true,
      availability: availableWhen(runHelpText.includes("--format") && /\bjson\b/i.test(runHelpText)),
    },
    { name: "run --model", required: true, availability: availableWhen(runHelpText.includes("--model")) },
    { name: "run --variant", required: true, availability: availableWhen(runHelpText.includes("--variant")) },
  ];

  const report: AgentCapabilityReport = {
    executable,
    detectedVersion,
    capabilities,
    isolation: {
      // A generic permission flag does not establish an enforceable external-directory policy.
      denyOutsideWorktree: "unavailable",
    },
  };

  const missing = capabilities
    .filter((capability) => capability.required && capability.availability === "unavailable")
    .map((capability) => capability.name);
  if (missing.length > 0) {
    return agentProtocolError(
      settings.agent,
      { phase: "probe" },
      `configured OpenCode executable is missing required capabilities: ${missing.join(", ")}`,
    );
  }
  return { ok: true, value: report };
}

async function probeVersion(
  dependencies: OpenCodeAdapterDependencies,
  executable: string,
  environment: Record<string, string>,
): Promise<string | null> {
  const outcome = await probeInvocation(dependencies, [executable, "--version"], environment);
  if (!outcome.launched || outcome.exitCode !== 0) {
    return null;
  }
  const firstLine = outcome.stdout.text.split("\n", 1)[0]?.trim() ?? "";
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
    return "";
  }
  return `${outcome.stdout.text}\n${outcome.stderr.text}`;
}

function describeSettledProcess(outcome: ManagedProcessCompletion): string {
  return outcome.exitCode !== null
    ? `exit code ${outcome.exitCode}`
    : `terminated by signal ${outcome.signal ?? "unknown"}`;
}

type LineSplitter = {
  push: (text: string) => void;
  flush: () => void;
};

function createLineSplitter(deliver: (line: string) => void): LineSplitter {
  let buffer = "";
  const emit = (line: string): void => {
    deliver(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  return {
    push(text: string): void {
      buffer += text;
      for (;;) {
        const newlineIndex = buffer.indexOf("\n");
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
        buffer = "";
      }
    },
  };
}

function agentProtocolError(
  agent: string,
  context: ProtocolContext,
  reason: string,
  line?: number,
): { ok: false; error: Extract<TevuError, { kind: "AgentProtocolError" }> } {
  return {
    ok: false,
    error:
      line === undefined
        ? { kind: "AgentProtocolError", agent, context, reason }
        : { kind: "AgentProtocolError", agent, context, line, reason },
  };
}

/** Adds this adapter instance's agent name to a decoded protocol failure. */
function toAgentProtocolError(
  agent: string,
  error: ProtocolErrorShape,
): Extract<TevuError, { kind: "AgentProtocolError" }> {
  return error.line === undefined
    ? { kind: "AgentProtocolError", agent, context: error.context, reason: error.reason }
    : { kind: "AgentProtocolError", agent, context: error.context, line: error.line, reason: error.reason };
}
