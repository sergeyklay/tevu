import { unavailableBenchmarkMetrics, unavailableMetric } from '@/domain/types';

import type {
  AgentMetrics,
  BenchmarkMetrics,
  MetricValue,
  TevuError,
  TevuResult,
} from '@/domain/types';

/**
 * Reduces one agent's decoded metrics plus process timing into the complete,
 * agent-independent `BenchmarkMetrics` set: `elapsed` comes from process
 * timing, every other field is read from the agent's own normalized value, in
 * `BenchmarkMetrics` declaration order so the case `result.json` stays byte-
 * stable regardless of the order an adapter builds its own object in. A
 * normalization failure marks every field but a measured `elapsed`
 * unavailable with the failure's reason, and preserves the failure for the
 * caller to fold into the case's runtime failure.
 */
export function combineCaseMetrics(input: {
  durationMs: number | null;
  elapsedUnavailableReason: string;
  normalized: TevuResult<AgentMetrics, 'AgentProtocolError'>;
}): {
  metrics: BenchmarkMetrics;
  protocolFailure: Extract<TevuError, { kind: 'AgentProtocolError' }> | null;
} {
  const elapsed = measuredElapsed(input.durationMs, input.elapsedUnavailableReason);
  if (input.normalized.ok) {
    const value = input.normalized.value;
    return {
      metrics: {
        elapsed,
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        reasoningTokens: value.reasoningTokens,
        cacheReadTokens: value.cacheReadTokens,
        cacheWriteTokens: value.cacheWriteTokens,
        turns: value.turns,
        apiCalls: value.apiCalls,
        apiErrors: value.apiErrors,
        toolCalls: value.toolCalls,
        skillCalls: value.skillCalls,
        cost: value.cost,
      },
      protocolFailure: null,
    };
  }
  const metrics = unavailableBenchmarkMetrics(input.normalized.error.reason);
  if (input.durationMs !== null) {
    metrics.elapsed = elapsed;
  }
  return { metrics, protocolFailure: input.normalized.error };
}

function measuredElapsed(durationMs: number | null, reason: string): MetricValue {
  return durationMs !== null && Number.isFinite(durationMs)
    ? {
        value: durationMs,
        unit: 'millisecond',
        availability: { status: 'available', source: 'process' },
        scope: 'case',
      }
    : unavailableMetric('millisecond', reason, 'case');
}
