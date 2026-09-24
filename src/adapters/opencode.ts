/**
 * OpenCode CLI boundary: capability probing without a model session, exactly
 * one managed `run --format json` process per case, root-session export, and
 * the contender-independent task prompt builder. Process supervision is
 * delegated to the managed process adapter and record decoding to the
 * protocol decoders; no release string ever gates behavior.
 */

import process from "node:process";

import { createRedactor, redactDecodedValue, runManagedProcess } from "./process.ts";
import { decodeEvent, decodeExport } from "./opencode-protocol.ts";

import type { ManagedProcessCompletion, ManagedProcessResult } from "./process.ts";
import type { ProtocolContext } from "./opencode-protocol.ts";
import type { TaskDefinition } from "../config/schema.ts";
import type {
  IsolatedEnvironment,
  OpenCodeAdapter,
  OpenCodeCapabilityReport,
  OpenCodeExport,
  OpenCodeRunEvent,
  OpenCodeRunInput,
  OpenCodeRunResult,
  ProcessResult,
  TevuError,
  TevuResult,
} from "../domain/types.ts";

/** Construction inputs for the OpenCode adapter. */
export type OpenCodeAdapterOptions = {
  /** Configured OpenCode executable used by `run` argv defaults and `exportSession`. */
  executable: string;
  /** Reads the current run-level secret values for streaming redaction. */
  readSecretValues: () => readonly string[];
};

type ProtocolFailure = Extract<TevuError, { kind: "OpenCodeProtocolError" }>;

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_TERMINATION_GRACE_MS = 2_000;
const EXPORT_TIMEOUT_MS = 120_000;
const EXPORT_TERMINATION_GRACE_MS = 2_000;
const EXPORT_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

/**
 * Builds the contender-independent task prompt from only the task's own
 * fields: configured prompt, task description, acceptance-criterion
 * descriptions, Definition of Done descriptions, and the stay-inside-the-
 * repository instruction, in that order. The same input always yields the
 * same bytes, so every contender receives an identical prompt.
 *
 * The prompt excludes the source commit: the sealed repository the agent
 * runs in does not contain that commit, and naming it would let a
 * network-capable agent find a public repository's later history.
 */
export function buildTaskPrompt(task: TaskDefinition): string {
  const acceptance = task.checks.acceptance.map((check) => `- ${check.description}`);
  const definitionOfDone = task.checks.done.map((check) => `- ${check.description}`);
  return [
    task.prompt,
    task.description,
    ["Acceptance criteria:", ...acceptance].join("\n"),
    ["Definition of Done:", ...definitionOfDone].join("\n"),
    "Work only inside the current repository. Do not read or modify any path outside this repository's working tree.",
  ].join("\n\n");
}

/**
 * Creates the OpenCode adapter over the managed process boundary and the
 * consumed protocol decoders.
 */
export function createOpenCodeAdapter(options: OpenCodeAdapterOptions): OpenCodeAdapter {
  return {
    async probe(
      executable: string,
    ): Promise<TevuResult<OpenCodeCapabilityReport, "PrerequisiteError" | "OpenCodeProtocolError">> {
      return probeCapabilities(executable);
    },
    async run(
      input: OpenCodeRunInput,
    ): Promise<
      TevuResult<
        OpenCodeRunResult,
        "OpenCodeProcessError" | "OpenCodeProtocolError" | "CaseTimeoutError" | "CancellationError"
      >
    > {
      return runCase(input, options.readSecretValues());
    },
    async exportSession(
      sessionId: string,
      environment: IsolatedEnvironment,
    ): Promise<TevuResult<OpenCodeExport, "OpenCodeProcessError" | "OpenCodeProtocolError">> {
      return exportRootSession(options.executable, sessionId, environment, options.readSecretValues());
    },
  };
}

async function runCase(
  input: OpenCodeRunInput,
  secretValues: readonly string[],
): Promise<
  TevuResult<
    OpenCodeRunResult,
    "OpenCodeProcessError" | "OpenCodeProtocolError" | "CaseTimeoutError" | "CancellationError"
  >
> {
  const caseId = input.identity.caseId;
  const context: ProtocolContext = { phase: "case", caseId };
  // Run stdout carries structured JSON records, so the managed process streams
  // it raw and every decoded record is redacted here before any sink; only
  // non-JSON lines fall back to plain-text redaction as diagnostics.
  const redact = createRedactor(secretValues);
  const parseFindings: string[] = [];
  let sessionId: string | null = null;
  let protocolFailure: ProtocolFailure | null = null;
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
      protocolFailure ??= {
        kind: "OpenCodeProtocolError", context, line: stdoutLineNumber,
        reason: "run output contains malformed JSON event framing",
      };
      await deliverDiagnostic(redact(line));
      return;
    }
    const decoded = decodeEvent(parsed, context, stdoutLineNumber);
    if (!decoded.ok) {
      parseFindings.push(`stdout line ${stdoutLineNumber}: ${decoded.error.reason}`);
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
    const delivered = await input.onEvent(redactDecodedValue(redact, decoded.value) as OpenCodeRunEvent);
    if (!delivered.ok) {
      deliveryStopped = true;
      if (delivered.error.kind === "OpenCodeProtocolError") {
        protocolFailure ??= delivered.error;
      }
    }
  };

  const stdoutLines = createLineSplitter((line) => enqueue(() => handleStdoutLine(line)));
  const stderrLines = createLineSplitter((line) => enqueue(() => deliverDiagnostic(line)));

  const outcome = await runManagedProcess({
    argv: [
      input.executable,
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
      error: { kind: "OpenCodeProcessError", caseId, exitCode: null, signal: null },
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
  const runResult: OpenCodeRunResult = { process: processResult, sessionId, parseFindings };
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
    return protocolError(context, "run output did not identify a root session");
  }
  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      error: {
        kind: "OpenCodeProcessError",
        caseId,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      },
    };
  }
  return { ok: true, value: runResult };
}

async function exportRootSession(
  executable: string,
  sessionId: string,
  environment: IsolatedEnvironment,
  secretValues: readonly string[],
): Promise<TevuResult<OpenCodeExport, "OpenCodeProcessError" | "OpenCodeProtocolError">> {
  const caseId = environment.caseId;
  const context: ProtocolContext = { phase: "case", caseId };
  const outcome = await runManagedProcess({
    argv: [executable, "export", sessionId],
    cwd: environment.homeDirectory,
    environment: environment.variables,
    timeoutMs: EXPORT_TIMEOUT_MS,
    terminationGraceMs: EXPORT_TERMINATION_GRACE_MS,
    secretValues,
    // The export is one structured JSON document: it is captured raw within
    // this boundary, decoded, and redacted as a value so numeric metrics
    // survive; the raw capture never reaches a sink.
    stdoutRedaction: "structured",
    maxCaptureBytes: EXPORT_MAX_CAPTURE_BYTES,
  });
  if (!outcome.launched) {
    return {
      ok: false,
      error: { kind: "OpenCodeProcessError", caseId, exitCode: null, signal: null },
    };
  }
  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      error: {
        kind: "OpenCodeProcessError",
        caseId,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      },
    };
  }
  if (outcome.stdout.truncated) {
    return protocolError(context, "export output exceeded the capture bound and cannot be decoded");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout.text);
  } catch {
    return protocolError(context, "export output is not valid JSON");
  }
  const decoded = decodeExport(parsed, context);
  if (!decoded.ok) {
    return decoded;
  }
  if (decoded.value.info.id !== sessionId) {
    return protocolError(context, "export identity does not match the requested root session");
  }
  return {
    ok: true,
    value: redactDecodedValue(createRedactor(secretValues), decoded.value) as OpenCodeExport,
  };
}

async function probeCapabilities(
  executable: string,
): Promise<TevuResult<OpenCodeCapabilityReport, "PrerequisiteError" | "OpenCodeProtocolError">> {
  const environment = { PATH: process.env.PATH ?? "" };
  const rootHelp = await probeInvocation([executable, "--help"], environment);
  if (!rootHelp.launched) {
    return {
      ok: false,
      error: {
        kind: "PrerequisiteError",
        tool: "opencode",
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
        tool: "opencode",
        expected: `"${executable} --help" exits 0`,
        actual: describeSettledProcess(rootHelp),
      },
    };
  }

  const detectedVersion = await probeVersion(executable, environment);
  const runHelp = await probeInvocation([executable, "run", "--help"], environment);
  const exportHelp = await probeInvocation([executable, "export", "--help"], environment);
  const runHelpText = combinedOutput(runHelp);
  const availableWhen = (available: boolean): "available" | "unavailable" =>
    available ? "available" : "unavailable";

  const report: OpenCodeCapabilityReport = {
    executable,
    detectedVersion,
    commands: {
      run: availableWhen(helpSucceeded(runHelp)),
      export: availableWhen(helpSucceeded(exportHelp)),
    },
    runOptions: {
      jsonFormat: availableWhen(runHelpText.includes("--format") && /\bjson\b/i.test(runHelpText)),
      model: availableWhen(runHelpText.includes("--model")),
      variant: availableWhen(runHelpText.includes("--variant")),
    },
    isolation: {
      // A generic permission flag does not establish an enforceable external-directory policy.
      denyOutsideWorktree: "unavailable",
    },
  };

  const missing = listMissingRequiredCapabilities(report);
  if (missing.length > 0) {
    return protocolError(
      { phase: "probe" },
      `configured OpenCode executable is missing required capabilities: ${missing.join(", ")}`,
    );
  }
  return { ok: true, value: report };
}

async function probeVersion(
  executable: string,
  environment: Record<string, string>,
): Promise<string | null> {
  const outcome = await probeInvocation([executable, "--version"], environment);
  if (!outcome.launched || outcome.exitCode !== 0) {
    return null;
  }
  const firstLine = outcome.stdout.text.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 0 ? firstLine : null;
}

async function probeInvocation(
  argv: [string, ...string[]],
  environment: Record<string, string>,
): Promise<ManagedProcessResult> {
  return runManagedProcess({
    argv,
    cwd: process.cwd(),
    environment,
    timeoutMs: PROBE_TIMEOUT_MS,
    terminationGraceMs: PROBE_TERMINATION_GRACE_MS,
  });
}

function listMissingRequiredCapabilities(report: OpenCodeCapabilityReport): string[] {
  const required: Array<[string, "available" | "unavailable"]> = [
    ["run command", report.commands.run],
    ["export command", report.commands.export],
    ["run --format json", report.runOptions.jsonFormat],
    ["run --model", report.runOptions.model],
    ["run --variant", report.runOptions.variant],
  ];
  return required.filter(([, status]) => status === "unavailable").map(([name]) => name);
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

function protocolError(
  context: ProtocolContext,
  reason: string,
): { ok: false; error: ProtocolFailure } {
  return { ok: false, error: { kind: "OpenCodeProtocolError", context, reason } };
}
