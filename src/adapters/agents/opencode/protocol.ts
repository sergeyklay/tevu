import { z } from 'zod';

import { describePath } from '@/domain/describe-path';

import type { AgentSessionExport, ModelRoleName } from '@/domain/types';

/** Error context for protocol failures: capability probing, one planned case, or one model call. */
export type ProtocolContext =
  { phase: 'probe' } | { phase: 'case'; caseId: string } | { phase: 'call'; role: ModelRoleName };

/**
 * Result of one decode step, kept local rather than expressed through the
 * domain `TevuResult`: the decoder has no `agent` name to embed, so its
 * failures carry the adapter-internal `ProtocolErrorShape` until the wrapping
 * `AgentAdapter` methods translate them into a genuine `AgentProtocolError`.
 */
type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: ProtocolErrorShape };

const nonEmptyStringSchema = z.string().min(1);

// A lenient field accepts any value or none; a lenient container reads as
// absent when it is not an object, so a malformed metric never fails a decode.
const partSchema = z.looseObject({
  id: nonEmptyStringSchema,
  sessionID: nonEmptyStringSchema,
  messageID: nonEmptyStringSchema,
  type: nonEmptyStringSchema,
  tool: z.unknown().optional(),
  text: z.unknown().optional(),
  synthetic: z.unknown().optional(),
  ignored: z.unknown().optional(),
});

const partEventSchema = z.looseObject({
  type: z.enum(['tool_use', 'step_start', 'step_finish', 'text', 'reasoning']),
  timestamp: z.number(),
  sessionID: nonEmptyStringSchema,
  part: partSchema,
});

const errorEventSchema = z.looseObject({
  type: z.literal('error'),
  timestamp: z.number(),
  sessionID: nonEmptyStringSchema,
  error: z.unknown().optional(),
});

const consumedEventSchema = z.discriminatedUnion('type', [partEventSchema, errorEventSchema]);

const eventFramingSchema = z.looseObject({ type: nonEmptyStringSchema });

const cacheSchema = z
  .looseObject({ read: z.unknown().optional(), write: z.unknown().optional() })
  .optional()
  .catch(undefined);

const tokensSchema = z
  .looseObject({
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    reasoning: z.unknown().optional(),
    cache: cacheSchema,
  })
  .optional()
  .catch(undefined);

const messageInfoSchema = z.looseObject({
  id: nonEmptyStringSchema,
  sessionID: nonEmptyStringSchema,
  role: z.unknown().optional(),
  providerID: z.unknown().optional(),
  modelID: z.unknown().optional(),
  finish: z.unknown().optional(),
  error: z.unknown().optional(),
  cost: z.unknown().optional(),
  tokens: tokensSchema,
});

const exportInfoSchema = z.looseObject({
  id: nonEmptyStringSchema,
  parentID: nonEmptyStringSchema.optional(),
});

const exportHeaderSchema = z.looseObject({ info: exportInfoSchema });

const exportSchema = z.looseObject({
  info: exportInfoSchema,
  messages: z.array(z.looseObject({ info: messageInfoSchema, parts: z.array(partSchema) })),
});

/** Structural identity of one OpenCode message part, with the optional fields tevu reads left unchecked. */
export type OpenCodePart = z.output<typeof partSchema>;

/** Consumed OpenCode JSON event records streamed during `run --format json`. */
export type OpenCodeRunEvent = z.output<typeof consumedEventSchema>;

/** The info record of one message of a root-session export; metric fields are lenient. */
export type OpenCodeMessageInfo = z.output<typeof messageInfoSchema>;

/** Consumed root-session export view; additive unknown fields stay in it. */
export type OpenCodeExport = z.output<typeof exportSchema>;

/** A decoded root-session export: the raw record kept as evidence and the checked view tevu reads. */
export type DecodedExport = { record: AgentSessionExport; view: OpenCodeExport };

/** Event types whose records the version 1 decoder consumes. */
const CONSUMED_EVENT_TYPES = new Set([
  'tool_use',
  'step_start',
  'step_finish',
  'text',
  'reasoning',
  'error',
]);

/**
 * Decodes one already-parsed JSON value as an OpenCode run event.
 *
 * Validates only consumed identity and framing: `type`, `timestamp`,
 * `sessionID`, and the part identity `(sessionID, messageID, id)` for
 * part-carrying events. Returns `null` for records of unconsumed additive
 * event types. The returned event is a view of the input: it keeps additive
 * fields, and a lenient field such as a tool name is not checked, so optional
 * metric defects are handled by metric normalization, never here. Evidence
 * comes from the input, never from the view.
 */
export function decodeEvent(
  input: unknown,
  context: ProtocolContext,
  line?: number,
): DecodeResult<OpenCodeRunEvent | null> {
  const framing = eventFramingSchema.safeParse(input);
  if (!framing.success) {
    return protocolError(context, eventReason(framing.error), line);
  }
  if (!CONSUMED_EVENT_TYPES.has(framing.data.type)) {
    return { ok: true, value: null };
  }
  const event = consumedEventSchema.safeParse(input);
  if (!event.success) {
    return protocolError(context, eventReason(event.error), line);
  }
  return { ok: true, value: event.data };
}

/**
 * Decodes one already-parsed JSON value as the root-session export.
 *
 * Validates the export identity (`info.id`), rejects child-session exports
 * (`info.parentID`), and validates every message identity
 * `(info.sessionID, info.id)` and part identity
 * `(sessionID, messageID, id)`. Roles, token, cost, finish, error, and tool
 * fields stay unchecked for metric normalization. The result keeps the input
 * as `record` and the checked, additive-tolerant projection as `view`.
 */
export function decodeExport(
  input: unknown,
  context: ProtocolContext,
): DecodeResult<DecodedExport> {
  if (!isRecord(input)) {
    return protocolError(context, exportReason('(root)'));
  }
  // A child session is rejected for what it is, even when its messages are also malformed.
  const header = exportHeaderSchema.safeParse(input);
  if (header.success && header.data.info.parentID !== undefined) {
    return protocolError(
      context,
      `child session export "${header.data.info.id}" rejected: schema version 1 consumes only the root session`,
    );
  }
  const parsed = exportSchema.safeParse(input);
  if (!parsed.success) {
    return protocolError(context, exportReason(firstIssuePath(parsed.error)));
  }
  return { ok: true, value: { record: input, view: parsed.data } };
}

function firstIssuePath(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  return firstIssue === undefined ? '(root)' : describePath(firstIssue.path);
}

function eventReason(error: z.ZodError): string {
  return `event record does not match the consumed event layout at ${firstIssuePath(error)}`;
}

function exportReason(path: string): string {
  return `export record does not match the consumed export layout at ${path}`;
}

/**
 * Decodes `models --verbose` output into listed identifiers and their reported
 * variant names; never throws.
 *
 * Identifier extraction does not depend on record parsing: a record that does
 * not parse costs only that model's variant data. Only identifiers and variant
 * names leave the function, because records can hold resolved header values.
 * The first record seen for an identifier wins.
 */
export function decodeModelListing(text: string): {
  models: string[];
  variants: Map<string, string[]>;
} {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const models: string[] = [];
  const variants = new Map<string, string[]>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    index += 1;
    if (line === '' || /^[ \t{}]/.test(line)) {
      continue;
    }
    const id = line.replace(/[ \t]+$/, '');
    if (!models.includes(id)) {
      models.push(id);
    }
    const first = lines[index];
    if (first === undefined || !first.startsWith('{')) {
      continue;
    }
    let block = first;
    if (first === '{') {
      let end = index + 1;
      while (end < lines.length && isRecordBodyLine(lines[end] ?? '')) {
        end += 1;
      }
      if (lines[end] !== '}') {
        index = end;
        continue;
      }
      block = lines.slice(index, end + 1).join('\n');
      index = end + 1;
    } else {
      index += 1;
    }
    const names = readVariantNames(block);
    if (names !== undefined && !variants.has(id)) {
      variants.set(id, names);
    }
  }
  return { models, variants };
}

/** Verdict of {@link decodeToolDenial}; `reason` is one clause without the command, before redaction. */
export type ToolDenialDecision = { denied: true } | { denied: false; reason: string };

/**
 * Decides from `debug config` stdout whether every tool is denied; pure,
 * never throws.
 *
 * A tool stays offered unless the last rule matching its name is `*` with
 * `deny`, so the top-level `*` rule must be `deny` and so must every key after
 * it, as must every key in the permission of the agent `run` selects. Only a
 * permission key or an agent name leaves the function, inside `reason`, as
 * written and unescaped so that a redactor finds a secret there verbatim.
 */
export function decodeToolDenial(text: string): ToolDenialDecision {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return notDenied('prints no JSON object');
  }
  if (!isRecord(document)) {
    return notDenied('prints no JSON object');
  }

  if (!Object.hasOwn(document, 'permission')) {
    return notDenied('shows no "permission", so OPENCODE_PERMISSION is not in force');
  }
  const permission = document['permission'];
  if (!isRecord(permission)) {
    return unreadShape('"permission"');
  }
  if (!Object.hasOwn(permission, '*')) {
    return notDenied('shows no "*" rule in "permission", so OPENCODE_PERMISSION is not in force');
  }
  if (permission['*'] !== 'deny') {
    return notDenied('shows "*" in "permission" as something other than "deny"');
  }
  const keys = Object.keys(permission);
  for (const key of keys.slice(keys.indexOf('*') + 1)) {
    if (permission[key] !== 'deny') {
      return notDenied(`lists "${key}" after "*" in "permission" with a value other than "deny"`);
    }
  }

  const defaultAgent = document['default_agent'];
  if (Object.hasOwn(document, 'default_agent') && typeof defaultAgent !== 'string') {
    return unreadShape('"default_agent"');
  }
  const agents = document['agent'];
  if (Object.hasOwn(document, 'agent') && !isRecord(agents)) {
    return unreadShape('"agent"');
  }
  const agentRecords = isRecord(agents) ? agents : {};

  let selected = 'build';
  if (typeof defaultAgent === 'string' && defaultAgent !== '') {
    selected = defaultAgent;
  } else {
    const build = Object.hasOwn(agentRecords, 'build') ? agentRecords['build'] : undefined;
    if (
      isRecord(build) &&
      (build['disable'] === true || build['hidden'] === true || build['mode'] === 'subagent')
    ) {
      return notDenied(
        'shows the "build" agent disabled, hidden, or as a subagent and no "default_agent", so the agent of a model call is unknown',
      );
    }
  }

  if (!Object.hasOwn(agentRecords, selected)) {
    return { denied: true };
  }
  const agent = agentRecords[selected];
  if (!isRecord(agent)) {
    return unreadShape(`the agent "${selected}"`);
  }
  if (!Object.hasOwn(agent, 'permission')) {
    return { denied: true };
  }
  const agentPermission = agent['permission'];
  if (!isRecord(agentPermission)) {
    return unreadShape(`the permission of agent "${selected}"`);
  }
  for (const key of Object.keys(agentPermission)) {
    if (agentPermission[key] !== 'deny') {
      return notDenied(
        `lists "${key}" in the permission of agent "${selected}" with a value other than "deny"`,
      );
    }
  }
  return { denied: true };
}

function notDenied(reason: string): ToolDenialDecision {
  return { denied: false, reason };
}

function unreadShape(field: string): ToolDenialDecision {
  return notDenied(`shows ${field} in a shape tevu does not read`);
}

function isRecordBodyLine(line: string): boolean {
  return line !== '}' && (line === '' || line.startsWith(' ') || line.startsWith('\t'));
}

function readVariantNames(block: string): string[] | undefined {
  let record: unknown;
  try {
    record = JSON.parse(block);
  } catch {
    return undefined;
  }
  if (!isRecord(record) || !isRecord(record['variants'])) {
    return undefined;
  }
  return Object.keys(record['variants']).sort();
}

/** Deduplication identity of one decoded event: `(sessionID, part.id)`, or the ordinal for errors. */
export function eventIdentity(event: OpenCodeRunEvent, ordinal: number): string {
  if (event.type === 'error') {
    return `${event.sessionID}\u0000error\u0000${ordinal}`;
  }
  return `${event.sessionID}\u0000${event.part.id}`;
}

/** Reports whether a decoded run event is an `error` event of the root session `rootSessionId`. */
export function isRootSessionErrorEvent(event: OpenCodeRunEvent, rootSessionId: string): boolean {
  return event.type === 'error' && event.sessionID === rootSessionId;
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
    if (info['role'] === 'assistant') {
      const tokens = isRecord(info['tokens']) ? info['tokens'] : {};
      const cache = isRecord(tokens['cache']) ? tokens['cache'] : {};
      const fields: Array<[string, unknown]> = [
        ['cost', info['cost']],
        ['tokens.input', tokens['input']],
        ['tokens.output', tokens['output']],
        ['tokens.reasoning', tokens['reasoning']],
        ['tokens.cache.read', cache['read']],
        ['tokens.cache.write', cache['write']],
      ];
      for (const [field, value] of fields) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          findings.push(
            `field "${field}" is absent or malformed in export message "${message.info.id}"`,
          );
        }
      }
    }
    for (const part of message.parts) {
      if (part.type === 'tool' && typeof part.tool !== 'string') {
        findings.push(`tool name is absent or malformed on tool part "${part.id}"`);
      }
    }
  }
  return findings;
}

/** A decode-layer protocol failure, translated into `AgentProtocolError` by the wrapping `AgentAdapter`. */
export type ProtocolErrorShape = {
  kind: 'OpenCodeProtocolError';
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
    error:
      line === undefined
        ? { kind: 'OpenCodeProtocolError', context, reason }
        : { kind: 'OpenCodeProtocolError', context, line, reason },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
