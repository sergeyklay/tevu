import type {
  BenchmarkMetrics,
  MetricValue,
  OpenCodeExport,
  OpenCodePart,
  OpenCodeRunEvent,
  OpenCodeToolPart,
  TevuResult,
} from "../domain/types.ts";

/** Source records consumed by metric normalization for one case. */
export type MetricsInput = {
  caseId: string;
  rootSessionId: string | null;
  sessionExport: OpenCodeExport | null;
  events: readonly OpenCodeRunEvent[];
  elapsedMs: number | null;
  elapsedUnavailableReason?: string;
  exportUnavailableReason?: string;
};

const EXPORT_SOURCE = "root-session export";
const EVENT_SOURCE = "run events";

/** Constructs an explicitly unavailable metric; never a zero and never an estimate. */
export function unavailableMetric(
  unit: MetricValue["unit"],
  reason: string,
  scope: MetricValue["scope"] = "root-session",
): MetricValue {
  return { value: null, unit, availability: { status: "unavailable", reason }, scope };
}

/** Constructs a complete metric set where every value is unavailable for one reason. */
export function unavailableBenchmarkMetrics(reason: string): BenchmarkMetrics {
  return {
    elapsed: unavailableMetric("millisecond", reason, "case"),
    inputTokens: unavailableMetric("token", reason),
    outputTokens: unavailableMetric("token", reason),
    reasoningTokens: unavailableMetric("token", reason),
    cacheReadTokens: unavailableMetric("token", reason),
    cacheWriteTokens: unavailableMetric("token", reason),
    turns: unavailableMetric("count", reason),
    apiCalls: unavailableMetric("count", reason),
    apiErrors: unavailableMetric("count", reason),
    toolCalls: unavailableMetric("count", reason),
    skillCalls: unavailableMetric("count", reason),
    cost: unavailableMetric("USD", reason),
  };
}

/** Deduplication identity of one export message: `(info.sessionID, info.id)`. */
export function exportMessageIdentity(info: { id: string; sessionID: string }): string {
  return `${info.sessionID}\u0000${info.id}`;
}

/** Deduplication identity of one export or event part: `(sessionID, messageID, id)`. */
export function exportPartIdentity(part: OpenCodePart): string {
  return `${part.sessionID}\u0000${part.messageID}\u0000${part.id}`;
}

/** Deduplication identity of one part-carrying event: `(sessionID, part.id)`. */
export function partEventIdentity(sessionID: string, part: OpenCodePart): string {
  return `${sessionID}\u0000${part.id}`;
}

/**
 * Normalizes every `BenchmarkMetrics` field from the root-session export,
 * falling back to run events only when the export is unavailable. Absent or
 * malformed optional metric fields become unavailable with a reason; missing
 * or malformed identities produce `OpenCodeProtocolError`.
 */
export function normalizeMetrics(
  input: MetricsInput,
): TevuResult<BenchmarkMetrics, "OpenCodeProtocolError"> {
  const elapsed =
    input.elapsedMs !== null && Number.isFinite(input.elapsedMs)
      ? measured(input.elapsedMs, "millisecond", "process", "case")
      : unavailableMetric(
          "millisecond",
          input.elapsedUnavailableReason ?? "case elapsed time was not measured",
          "case",
        );

  if (input.sessionExport !== null) {
    return normalizeFromExport(input.caseId, input.sessionExport, elapsed);
  }
  return normalizeFromEvents(input, elapsed);
}

function measured(
  value: number,
  unit: MetricValue["unit"],
  source: string,
  scope: MetricValue["scope"] = "root-session",
): MetricValue {
  return { value, unit, availability: { status: "available", source }, scope };
}

function protocolError(
  caseId: string,
  reason: string,
): TevuResult<BenchmarkMetrics, "OpenCodeProtocolError"> {
  return {
    ok: false,
    error: { kind: "OpenCodeProtocolError", context: { phase: "case", caseId }, reason },
  };
}

/** Accumulates one metric component, remembering the first malformed occurrence. */
type ComponentSum = { total: number; malformed: string | null };

function addComponent(sum: ComponentSum, value: unknown, messageId: string, field: string): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    sum.total += value;
    return;
  }
  if (sum.malformed === null) {
    sum.malformed =
      value === undefined
        ? `field "${field}" is absent in export message "${messageId}"`
        : `field "${field}" is malformed in export message "${messageId}"`;
  }
}

function sumMetric(sum: ComponentSum, unit: MetricValue["unit"]): MetricValue {
  return sum.malformed === null
    ? measured(sum.total, unit, EXPORT_SOURCE)
    : unavailableMetric(unit, sum.malformed);
}

function normalizeFromExport(
  caseId: string,
  sessionExport: OpenCodeExport,
  elapsed: MetricValue,
): TevuResult<BenchmarkMetrics, "OpenCodeProtocolError"> {
  if (!isNonEmptyString(sessionExport.info.id)) {
    return protocolError(caseId, "export session identity (info.id) is missing or malformed");
  }

  const sums = {
    inputTokens: emptySum(),
    outputTokens: emptySum(),
    reasoningTokens: emptySum(),
    cacheReadTokens: emptySum(),
    cacheWriteTokens: emptySum(),
    cost: emptySum(),
  };
  let turns = 0;
  let apiCalls = 0;
  let apiErrors = 0;
  let toolCalls = 0;
  let skillCalls = 0;
  let skillMalformed: string | null = null;

  const seenMessages = new Set<string>();
  const seenParts = new Set<string>();

  for (const message of sessionExport.messages) {
    const info = message.info;
    if (!isNonEmptyString(info.id) || !isNonEmptyString(info.sessionID)) {
      return protocolError(caseId, "export message identity (sessionID, id) is missing or malformed");
    }
    const identity = exportMessageIdentity(info);
    const firstOccurrence = !seenMessages.has(identity);
    seenMessages.add(identity);

    if (firstOccurrence && info.role === "assistant") {
      const hasFinish = isNonEmptyString(info.finish);
      const hasError = info.error !== undefined;
      if (hasFinish) {
        turns += 1;
      }
      if (info.finish !== undefined || hasError) {
        apiCalls += 1;
      }
      if (hasError) {
        apiErrors += 1;
      }
      addComponent(sums.inputTokens, info.tokens?.input, info.id, "tokens.input");
      addComponent(sums.outputTokens, info.tokens?.output, info.id, "tokens.output");
      addComponent(sums.reasoningTokens, info.tokens?.reasoning, info.id, "tokens.reasoning");
      addComponent(sums.cacheReadTokens, info.tokens?.cache?.read, info.id, "tokens.cache.read");
      addComponent(sums.cacheWriteTokens, info.tokens?.cache?.write, info.id, "tokens.cache.write");
      addComponent(sums.cost, info.cost, info.id, "cost");
    }

    for (const part of message.parts) {
      if (
        !isNonEmptyString(part.id) ||
        !isNonEmptyString(part.sessionID) ||
        !isNonEmptyString(part.messageID)
      ) {
        return protocolError(
          caseId,
          "export part identity (sessionID, messageID, id) is missing or malformed",
        );
      }
      const partIdentity = exportPartIdentity(part);
      if (seenParts.has(partIdentity)) {
        continue;
      }
      seenParts.add(partIdentity);
      if (part.type !== "tool") {
        continue;
      }
      toolCalls += 1;
      const tool = (part as Partial<OpenCodeToolPart>).tool;
      if (typeof tool !== "string") {
        skillMalformed = `tool name is absent or malformed on tool part "${part.id}"`;
      } else if (tool === "skill") {
        skillCalls += 1;
      }
    }
  }

  return {
    ok: true,
    value: {
      elapsed,
      inputTokens: sumMetric(sums.inputTokens, "token"),
      outputTokens: sumMetric(sums.outputTokens, "token"),
      reasoningTokens: sumMetric(sums.reasoningTokens, "token"),
      cacheReadTokens: sumMetric(sums.cacheReadTokens, "token"),
      cacheWriteTokens: sumMetric(sums.cacheWriteTokens, "token"),
      turns: measured(turns, "count", EXPORT_SOURCE),
      apiCalls: measured(apiCalls, "count", EXPORT_SOURCE),
      apiErrors: measured(apiErrors, "count", EXPORT_SOURCE),
      toolCalls: measured(toolCalls, "count", EXPORT_SOURCE),
      skillCalls:
        skillMalformed === null
          ? measured(skillCalls, "count", EXPORT_SOURCE)
          : unavailableMetric("count", skillMalformed),
      cost: sumMetric(sums.cost, "USD"),
    },
  };
}

function normalizeFromEvents(
  input: MetricsInput,
  elapsed: MetricValue,
): TevuResult<BenchmarkMetrics, "OpenCodeProtocolError"> {
  const exportReason = input.exportUnavailableReason ?? "root session export unavailable";

  if (input.rootSessionId === null) {
    const reason = `${exportReason}; root session could not be identified`;
    return { ok: true, value: { ...unavailableBenchmarkMetrics(reason), elapsed } };
  }

  let apiErrors = 0;
  let toolCalls = 0;
  let skillCalls = 0;
  let skillMalformed: string | null = null;
  const seenParts = new Set<string>();

  for (const event of input.events) {
    if (!isNonEmptyString(event.sessionID)) {
      return protocolError(input.caseId, "event session identity (sessionID) is missing or malformed");
    }
    if (event.sessionID !== input.rootSessionId) {
      continue;
    }
    if (event.type === "error") {
      apiErrors += 1;
      continue;
    }
    if (!isNonEmptyString(event.part.id)) {
      return protocolError(input.caseId, "event part identity (part.id) is missing or malformed");
    }
    const identity = partEventIdentity(event.sessionID, event.part);
    if (seenParts.has(identity)) {
      continue;
    }
    seenParts.add(identity);
    if (event.type !== "tool_use") {
      continue;
    }
    toolCalls += 1;
    if (typeof event.part.tool !== "string") {
      skillMalformed = `tool name is absent or malformed on tool part "${event.part.id}"`;
    } else if (event.part.tool === "skill") {
      skillCalls += 1;
    }
  }

  return {
    ok: true,
    value: {
      elapsed,
      inputTokens: unavailableMetric("token", exportReason),
      outputTokens: unavailableMetric("token", exportReason),
      reasoningTokens: unavailableMetric("token", exportReason),
      cacheReadTokens: unavailableMetric("token", exportReason),
      cacheWriteTokens: unavailableMetric("token", exportReason),
      turns: unavailableMetric("count", exportReason),
      apiCalls: unavailableMetric("count", exportReason),
      apiErrors: measured(apiErrors, "count", EVENT_SOURCE),
      toolCalls: measured(toolCalls, "count", EVENT_SOURCE),
      skillCalls:
        skillMalformed === null
          ? measured(skillCalls, "count", EVENT_SOURCE)
          : unavailableMetric("count", skillMalformed),
      cost: unavailableMetric("USD", exportReason),
    },
  };
}

function emptySum(): ComponentSum {
  return { total: 0, malformed: null };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
