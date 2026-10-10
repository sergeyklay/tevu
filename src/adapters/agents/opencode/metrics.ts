/**
 * Decode-first OpenCode metric normalization: every record is validated
 * through the protocol decoders before any metric is summed, so a decode
 * failure is reported once and the normalizer's own identity re-checks are
 * unreachable. Sums every `BenchmarkMetrics` field but `elapsed`, which
 * `combineCaseMetrics` in `src/evaluation/metrics.ts` derives from process
 * timing.
 */

import { unavailableMetric } from '@/domain/types';

import { decodeEvent, decodeExport, isRootSessionErrorEvent } from './protocol';

import type {
  OpenCodeExport,
  OpenCodeMessageInfo,
  OpenCodePart,
  OpenCodeRunEvent,
  ProtocolErrorShape,
} from './protocol';
import type { AgentMetrics, AgentMetricsInput, CopiedProvider, MetricValue } from '@/domain/types';

const EXPORT_SOURCE = 'root-session export';
const EVENT_SOURCE = 'run events';
const EXPORT_AND_EVENT_SOURCE = 'root-session export and run events';

/**
 * Result of metric normalization, kept local rather than expressed through
 * the domain `TevuResult`: a decode failure has no `agent` name to embed, so
 * it carries the adapter-internal `ProtocolErrorShape` until the wrapping
 * `AgentAdapter.normalizeMetrics` translates it into `AgentProtocolError`.
 */
export type NormalizeMetricsResult =
  { ok: true; value: AgentMetrics } | { ok: false; error: ProtocolErrorShape };

/** Deduplication identity of one decoded event: `(sessionID, part.id)`, or the ordinal for errors. */
function partEventIdentity(sessionID: string, part: OpenCodePart): string {
  return `${sessionID}\u0000${part.id}`;
}

/** Deduplication identity of one export message: `(info.sessionID, info.id)`. */
export function exportMessageIdentity(info: { id: string; sessionID: string }): string {
  return `${info.sessionID}\u0000${info.id}`;
}

/** Deduplication identity of one export part: `(sessionID, messageID, id)`. */
export function exportPartIdentity(part: OpenCodePart): string {
  return `${part.sessionID}\u0000${part.messageID}\u0000${part.id}`;
}

/**
 * Normalizes every `AgentMetrics` field from the root-session export,
 * falling back to run events only when the export is unavailable. Every
 * record is decoded first, so a malformed record fails the whole
 * normalization instead of surfacing as a silently degraded metric.
 *
 * Returns the protocol decoder's own `OpenCodeProtocolError`; the adapter
 * that owns this module adds its agent name when it wraps the result as the
 * `AgentAdapter.normalizeMetrics` contract requires.
 */
export function normalizeMetrics(input: AgentMetricsInput): NormalizeMetricsResult {
  const context = { phase: 'case' as const, caseId: input.caseId };

  const exportRecord =
    input.sessionExport === null ? null : decodeExport(input.sessionExport, context);
  if (exportRecord !== null && !exportRecord.ok) {
    return exportRecord;
  }

  const decodedEvents: OpenCodeRunEvent[] = [];
  for (const [index, event] of input.events.entries()) {
    const decoded = decodeEvent(event, context, index + 1);
    if (!decoded.ok) {
      return decoded;
    }
    if (decoded.value !== null) {
      decodedEvents.push(decoded.value);
    }
  }

  const sessionExport = exportRecord !== null && exportRecord.ok ? exportRecord.value.view : null;
  const rootSessionId =
    input.sessionId ?? sessionExport?.info.id ?? decodedEvents[0]?.sessionID ?? null;

  if (sessionExport !== null) {
    const exportMetrics = normalizeFromExport(sessionExport, input.copiedProviders);
    // An export always supplies `info.id`, so the fallback never replaces the resolved root session.
    const exportRootSessionId = rootSessionId ?? sessionExport.info.id;
    const eventErrors = decodedEvents.filter((event) =>
      isRootSessionErrorEvent(event, exportRootSessionId),
    ).length;
    return {
      ok: true,
      value: {
        ...exportMetrics,
        apiErrors: measured(
          Math.max(exportMetrics.apiErrors.value ?? 0, eventErrors),
          'count',
          EXPORT_AND_EVENT_SOURCE,
        ),
      },
    };
  }
  return {
    ok: true,
    value: normalizeFromEvents(
      decodedEvents,
      rootSessionId,
      input.exportUnavailableReason ?? 'root session export unavailable',
    ),
  };
}

/** Accumulates one metric component, remembering the first malformed occurrence. */
type ComponentSum = { total: number; malformed: string | null };

function describeFieldDefect(field: string, value: unknown, messageId: string): string {
  return value === undefined
    ? `field "${field}" is absent in export message "${messageId}"`
    : `field "${field}" is malformed in export message "${messageId}"`;
}

function addComponent(sum: ComponentSum, value: unknown, messageId: string, field: string): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    sum.total += value;
    return;
  }
  if (sum.malformed === null) {
    sum.malformed = describeFieldDefect(field, value, messageId);
  }
}

function measured(value: number, unit: MetricValue['unit'], source: string): MetricValue {
  return { value, unit, availability: { status: 'available', source }, scope: 'root-session' };
}

function sumMetric(sum: ComponentSum, unit: MetricValue['unit']): MetricValue {
  return sum.malformed === null
    ? measured(sum.total, unit, EXPORT_SOURCE)
    : unavailableMetric(unit, sum.malformed);
}

function providerModelKey(providerID: string, modelID: string): string {
  return `${providerID}\u0000${modelID}`;
}

/**
 * Names the first zero-cost message whose zero has no evidence of a price, or
 * `undefined` when every zero is evidenced. A provider the agent block does
 * not copy is evidenced by the agent's own model catalog, which tevu cannot
 * see; a copied provider's model is evidenced by a price in its copied
 * definition or by a non-zero cost for the same model elsewhere in the export.
 */
function describeUnevidencedZero(
  zeroCostMessages: readonly OpenCodeMessageInfo[],
  nonZeroModels: ReadonlySet<string>,
  copiedProviders: readonly CopiedProvider[],
): string | undefined {
  const pricedModels = new Map<string, readonly string[]>(
    copiedProviders.map((provider) => [provider.id, provider.pricedModels]),
  );
  for (const info of zeroCostMessages) {
    const { providerID, modelID } = info;
    if (!isNonEmptyString(providerID)) {
      return describeFieldDefect('providerID', providerID, info.id);
    }
    const copiedModels = pricedModels.get(providerID);
    if (copiedModels === undefined) {
      continue;
    }
    if (!isNonEmptyString(modelID)) {
      return describeFieldDefect('modelID', modelID, info.id);
    }
    if (
      copiedModels.includes(modelID) ||
      nonZeroModels.has(providerModelKey(providerID, modelID))
    ) {
      continue;
    }
    return `the copied definition of provider "${providerID}" defines no price for model "${modelID}"`;
  }
  return undefined;
}

/**
 * Normalizes every `AgentMetrics` field from a decoded root-session export.
 * A reported zero cost counts as measured only with evidence of a price for
 * a provider listed in `copiedProviders`; otherwise `cost` is unavailable.
 */
export function normalizeFromExport(
  sessionExport: OpenCodeExport,
  copiedProviders: readonly CopiedProvider[],
): AgentMetrics {
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
  const zeroCostMessages: OpenCodeMessageInfo[] = [];
  const nonZeroModels = new Set<string>();

  const seenMessages = new Set<string>();
  const seenParts = new Set<string>();

  for (const message of sessionExport.messages) {
    const info = message.info;
    const identity = exportMessageIdentity(info);
    const firstOccurrence = !seenMessages.has(identity);
    seenMessages.add(identity);

    if (firstOccurrence && info.role === 'assistant') {
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
      addComponent(sums.inputTokens, info.tokens?.input, info.id, 'tokens.input');
      addComponent(sums.outputTokens, info.tokens?.output, info.id, 'tokens.output');
      addComponent(sums.reasoningTokens, info.tokens?.reasoning, info.id, 'tokens.reasoning');
      addComponent(sums.cacheReadTokens, info.tokens?.cache?.read, info.id, 'tokens.cache.read');
      addComponent(sums.cacheWriteTokens, info.tokens?.cache?.write, info.id, 'tokens.cache.write');
      addComponent(sums.cost, info.cost, info.id, 'cost');
      if (info.cost === 0) {
        zeroCostMessages.push(info);
      } else if (
        typeof info.cost === 'number' &&
        Number.isFinite(info.cost) &&
        isNonEmptyString(info.providerID) &&
        isNonEmptyString(info.modelID)
      ) {
        nonZeroModels.add(providerModelKey(info.providerID, info.modelID));
      }
    }

    for (const part of message.parts) {
      const partIdentity = exportPartIdentity(part);
      if (seenParts.has(partIdentity)) {
        continue;
      }
      seenParts.add(partIdentity);
      if (part.type !== 'tool') {
        continue;
      }
      toolCalls += 1;
      if (typeof part.tool !== 'string') {
        skillMalformed = `tool name is absent or malformed on tool part "${part.id}"`;
      } else if (part.tool === 'skill') {
        skillCalls += 1;
      }
    }
  }

  const unevidencedZero =
    sums.cost.malformed === null && copiedProviders.length > 0
      ? describeUnevidencedZero(zeroCostMessages, nonZeroModels, copiedProviders)
      : undefined;

  return {
    inputTokens: sumMetric(sums.inputTokens, 'token'),
    outputTokens: sumMetric(sums.outputTokens, 'token'),
    reasoningTokens: sumMetric(sums.reasoningTokens, 'token'),
    cacheReadTokens: sumMetric(sums.cacheReadTokens, 'token'),
    cacheWriteTokens: sumMetric(sums.cacheWriteTokens, 'token'),
    turns: measured(turns, 'count', EXPORT_SOURCE),
    apiCalls: measured(apiCalls, 'count', EXPORT_SOURCE),
    apiErrors: measured(apiErrors, 'count', EXPORT_SOURCE),
    toolCalls: measured(toolCalls, 'count', EXPORT_SOURCE),
    skillCalls:
      skillMalformed === null
        ? measured(skillCalls, 'count', EXPORT_SOURCE)
        : unavailableMetric('count', skillMalformed),
    cost:
      unevidencedZero === undefined
        ? sumMetric(sums.cost, 'USD')
        : unavailableMetric('USD', unevidencedZero),
  };
}

function normalizeFromEvents(
  events: readonly OpenCodeRunEvent[],
  rootSessionId: string | null,
  exportReason: string,
): AgentMetrics {
  if (rootSessionId === null) {
    return unavailableAgentMetrics(`${exportReason}; root session could not be identified`);
  }

  let apiErrors = 0;
  let toolCalls = 0;
  let skillCalls = 0;
  let skillMalformed: string | null = null;
  const seenParts = new Set<string>();

  for (const event of events) {
    if (isRootSessionErrorEvent(event, rootSessionId)) {
      apiErrors += 1;
      continue;
    }
    // Error events of other sessions are skipped here too; the type test narrows `event` to part events.
    if (event.sessionID !== rootSessionId || event.type === 'error') {
      continue;
    }
    const identity = partEventIdentity(event.sessionID, event.part);
    if (seenParts.has(identity)) {
      continue;
    }
    seenParts.add(identity);
    if (event.type !== 'tool_use') {
      continue;
    }
    toolCalls += 1;
    if (typeof event.part.tool !== 'string') {
      skillMalformed = `tool name is absent or malformed on tool part "${event.part.id}"`;
    } else if (event.part.tool === 'skill') {
      skillCalls += 1;
    }
  }

  return {
    inputTokens: unavailableMetric('token', exportReason),
    outputTokens: unavailableMetric('token', exportReason),
    reasoningTokens: unavailableMetric('token', exportReason),
    cacheReadTokens: unavailableMetric('token', exportReason),
    cacheWriteTokens: unavailableMetric('token', exportReason),
    turns: unavailableMetric('count', exportReason),
    apiCalls: unavailableMetric('count', exportReason),
    apiErrors: measured(apiErrors, 'count', EVENT_SOURCE),
    toolCalls: measured(toolCalls, 'count', EVENT_SOURCE),
    skillCalls:
      skillMalformed === null
        ? measured(skillCalls, 'count', EVENT_SOURCE)
        : unavailableMetric('count', skillMalformed),
    cost: unavailableMetric('USD', exportReason),
  };
}

function emptySum(): ComponentSum {
  return { total: 0, malformed: null };
}

/** Marks every `AgentMetrics` field unavailable for one reason; never a zero or an estimate. */
function unavailableAgentMetrics(reason: string): AgentMetrics {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
