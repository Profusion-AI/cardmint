/**
 * Live scorecard report generator from query telemetry.
 *
 * Computes real-time metrics matching the PRD scorecard format:
 * - API latency p95
 * - Resolution rate
 * - Confidence distribution
 * - Source mix
 * - Correction rate (when correction events are available)
 */

import type { QueryTelemetry, QueryTelemetryEntry } from "./queryTelemetry.js";

export interface ScorecardReport {
  generatedAt: string;
  window: string;
  queryCount: number;
  latency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  resolution: {
    resolvedCount: number;
    disambiguationCount: number;
    resolutionRate: string;
  };
  confidence: {
    high: number;
    medium: number;
    low: number;
    none: number;
  };
  source: {
    internalTruth: number;
    referenceAggregate: number;
  };
  corrections: {
    totalQueries: number;
    correctionCount: number;
    correctionRate: string;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Generate a scorecard report from recent telemetry.
 * @param telemetry - The telemetry instance
 * @param windowMs - Time window in milliseconds (default: 1 hour)
 */
export function generateScorecard(
  telemetry: QueryTelemetry,
  windowMs = 3_600_000,
): ScorecardReport {
  const entries = telemetry.getRecent(windowMs);
  const corrections = telemetry.getRecentCorrections(windowMs);

  const durations = entries.map((e) => e.durationMs).sort((a, b) => a - b);

  const resolved = entries.filter((e) => e.status === "resolved").length;
  const disambiguation = entries.filter((e) => e.status === "needs_disambiguation").length;

  const confBuckets = { high: 0, medium: 0, low: 0, none: 0 };
  const sourceCounts = { internalTruth: 0, referenceAggregate: 0 };

  for (const e of entries) {
    confBuckets[e.confidenceBucket]++;
    if (e.sourceLabel === "internal_truth") sourceCounts.internalTruth++;
    else sourceCounts.referenceAggregate++;
  }

  const total = entries.length || 1;
  const correctionRate = (corrections.length / total) * 100;

  const windowDesc = windowMs >= 86_400_000
    ? `${(windowMs / 86_400_000).toFixed(0)}d`
    : windowMs >= 3_600_000
      ? `${(windowMs / 3_600_000).toFixed(0)}h`
      : `${(windowMs / 60_000).toFixed(0)}m`;

  return {
    generatedAt: new Date().toISOString(),
    window: windowDesc,
    queryCount: entries.length,
    latency: {
      p50Ms: Math.round(percentile(durations, 50) * 100) / 100,
      p95Ms: Math.round(percentile(durations, 95) * 100) / 100,
      p99Ms: Math.round(percentile(durations, 99) * 100) / 100,
    },
    resolution: {
      resolvedCount: resolved,
      disambiguationCount: disambiguation,
      resolutionRate: `${((resolved / total) * 100).toFixed(1)}%`,
    },
    confidence: confBuckets,
    source: sourceCounts,
    corrections: {
      totalQueries: entries.length,
      correctionCount: corrections.length,
      correctionRate: `${correctionRate.toFixed(2)}%`,
    },
  };
}
