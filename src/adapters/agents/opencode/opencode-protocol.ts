/** Error context for protocol failures: capability probing or one planned case. */
export type ProtocolContext = { phase: "probe" } | { phase: "case"; caseId: string };

/**
 * Result of one decode step, kept local rather than expressed through the
 * domain `TevuResult`: the decoder has no `agent` name to embed, so its
 * failures carry the adapter-internal `ProtocolErrorShape` until the wrapping
 * `AgentAdapter` methods translate them into a genuine `AgentProtocolError`.
 */
type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: ProtocolErrorShape };

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

/** Event types whose records the version 1 decoder consumes. */
const CONSUMED_EVENT_TYPES = new Set([
  "tool_use",
  "step_start",
  "step_finish",
  "text",
  "reasoning",
  "error",
]);

/**
 * Decodes one already-parsed JSON value as an OpenCode run event.
 *
 * Validates only consumed identity and framing: `type`, `timestamp`,
 * `sessionID`, and the part identity `(sessionID, messageID, id)` for
 * part-carrying events. Returns `null` for records of unconsumed additive
 * event types. The returned event is the raw input object cast after
 * validation, so additive fields and optional metric fields (such as a tool
 * name) are preserved as evidence rather than projected away; optional metric
 * defects are handled by metric normalization, never here.
 */
export function decodeEvent(
  input: unknown,
  context: ProtocolContext,
  line?: number,
): DecodeResult<OpenCodeRunEvent | null> {
  if (!isRecord(input)) {
    return protocolError(context, "event record is not a JSON object", line);
  }
  if (!isNonEmptyString(input["type"])) {
    return protocolError(context, "event framing is malformed: missing type", line);
  }
  if (!CONSUMED_EVENT_TYPES.has(input["type"])) {
    return { ok: true, value: null };
  }
  if (typeof input["timestamp"] !== "number" || !Number.isFinite(input["timestamp"])) {
    return protocolError(context, "event framing is malformed: missing or malformed timestamp", line);
  }
  if (!isNonEmptyString(input["sessionID"])) {
    return protocolError(context, "event session identity (sessionID) is missing or malformed", line);
  }
  if (input["type"] !== "error") {
    const partError = validatePartIdentity(input["part"], context, line);
    if (partError !== null) {
      return partError;
    }
  }
  // Contract: identity and framing were validated above; the raw record is
  // preserved (including additive and optional fields) under the domain type.
  return { ok: true, value: input as unknown as OpenCodeRunEvent };
}

/**
 * Decodes one already-parsed JSON value as the root-session export.
 *
 * Validates the export identity (`info.id`), rejects child-session exports
 * (`info.parentID`), and validates every message identity
 * `(info.sessionID, info.id)` and part identity
 * `(sessionID, messageID, id)`. Roles, token, cost, finish, error, and tool
 * fields are preserved raw and left to metric normalization; additive unknown
 * fields are retained.
 */
export function decodeExport(
  input: unknown,
  context: ProtocolContext,
): DecodeResult<OpenCodeExport> {
  if (!isRecord(input) || !isRecord(input["info"])) {
    return protocolError(context, "export record is not a JSON object with an info record");
  }
  const info = input["info"];
  if (!isNonEmptyString(info["id"])) {
    return protocolError(context, "export session identity (info.id) is missing or malformed");
  }
  const parentID = info["parentID"];
  if (parentID !== undefined) {
    if (!isNonEmptyString(parentID)) {
      return protocolError(context, "export session identity (info.parentID) is malformed");
    }
    return protocolError(
      context,
      `child session export "${info["id"]}" rejected: schema version 1 consumes only the root session`,
    );
  }
  if (!Array.isArray(input["messages"])) {
    return protocolError(context, "export is malformed: messages is not an array");
  }
  for (const message of input["messages"]) {
    if (!isRecord(message) || !isRecord(message["info"])) {
      return protocolError(context, "export message is not a JSON object with an info record");
    }
    const messageInfo = message["info"];
    if (!isNonEmptyString(messageInfo["id"]) || !isNonEmptyString(messageInfo["sessionID"])) {
      return protocolError(context, "export message identity (sessionID, id) is missing or malformed");
    }
    if (!Array.isArray(message["parts"])) {
      return protocolError(context, `export message "${messageInfo["id"]}" is malformed: parts is not an array`);
    }
    for (const part of message["parts"]) {
      const partError = validatePartIdentity(part, context);
      if (partError !== null) {
        return partError;
      }
    }
  }
  // Contract: identities were validated above; the raw export is preserved
  // (roles, tokens, cost, tool names, and additive fields untouched) under the
  // domain type. Metric normalization owns optional-field unavailability.
  return { ok: true, value: input as unknown as OpenCodeExport };
}

/** Deduplication identity of one decoded event: `(sessionID, part.id)`, or the ordinal for errors. */
export function eventIdentity(event: OpenCodeRunEvent, ordinal: number): string {
  if (event.type === "error") {
    return `${event.sessionID}\u0000error\u0000${ordinal}`;
  }
  return `${event.sessionID}\u0000${event.part.id}`;
}

/**
 * Reports absent or malformed optional metric fields in a decoded export.
 * Informative only: metric normalization independently marks the affected
 * metrics unavailable; a finding here is never a protocol failure.
 */
export function listMalformedOptionalMetricFields(sessionExport: OpenCodeExport): string[] {
  const findings: string[] = [];
  for (const message of sessionExport.messages) {
    const info: Record<string, unknown> = message.info;
    if (info["role"] === "assistant") {
      const tokens = isRecord(info["tokens"]) ? info["tokens"] : {};
      const cache = isRecord(tokens["cache"]) ? tokens["cache"] : {};
      const fields: Array<[string, unknown]> = [
        ["cost", info["cost"]],
        ["tokens.input", tokens["input"]],
        ["tokens.output", tokens["output"]],
        ["tokens.reasoning", tokens["reasoning"]],
        ["tokens.cache.read", cache["read"]],
        ["tokens.cache.write", cache["write"]],
      ];
      for (const [field, value] of fields) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          findings.push(`field "${field}" is absent or malformed in export message "${message.info.id}"`);
        }
      }
    }
    for (const part of message.parts) {
      if (part.type === "tool" && typeof (part as Record<string, unknown>)["tool"] !== "string") {
        findings.push(`tool name is absent or malformed on tool part "${part.id}"`);
      }
    }
  }
  return findings;
}

function validatePartIdentity(
  part: unknown,
  context: ProtocolContext,
  line?: number,
): { ok: false; error: ProtocolErrorShape } | null {
  if (!isRecord(part)) {
    return protocolError(context, "part record is missing or not a JSON object", line);
  }
  if (
    !isNonEmptyString(part["id"]) ||
    !isNonEmptyString(part["sessionID"]) ||
    !isNonEmptyString(part["messageID"])
  ) {
    return protocolError(context, "part identity (sessionID, messageID, id) is missing or malformed", line);
  }
  if (!isNonEmptyString(part["type"])) {
    return protocolError(context, "part record is malformed: missing type", line);
  }
  return null;
}

/** A decode-layer protocol failure, translated into `AgentProtocolError` by the wrapping `AgentAdapter`. */
export type ProtocolErrorShape = {
  kind: "OpenCodeProtocolError";
  context: ProtocolContext;
  line?: number;
  reason: string;
};

function protocolError(
  context: ProtocolContext,
  reason: string,
  line?: number,
): { ok: false; error: ProtocolErrorShape } {
  return {
    ok: false,
    error: line === undefined
      ? { kind: "OpenCodeProtocolError", context, reason }
      : { kind: "OpenCodeProtocolError", context, line, reason },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
