/**
 * In-memory query telemetry ring buffer.
 *
 * Records per-query metrics for live scorecard generation:
 * - Latency
 * - Confidence bucket
 * - Retrieval path (deterministic / fuzzy / fallback / degraded)
 * - Source (internal_truth / reference_aggregate)
 * - Resolution status
 *
 * Ring buffer keeps only the last N entries to bound memory.
 */

export interface QueryTelemetryEntry {
  timestamp: number;
  query: string;
  durationMs: number;
  status: "resolved" | "needs_disambiguation";
  confidenceBucket: "high" | "medium" | "low" | "none";
  sourceLabel: "internal_truth" | "reference_aggregate";
  retrievalPath: "deterministic" | "fts" | "like" | "fallback" | "degraded";
  candidateCount: number;
}

export interface CorrectionEvent {
  timestamp: number;
  query: string;
  originalChosenId: string | null;
  correctedId: string;
}

const DEFAULT_BUFFER_SIZE = 1000;

export class QueryTelemetry {
  private entries: QueryTelemetryEntry[] = [];
  private corrections: CorrectionEvent[] = [];
  private maxEntries: number;

  constructor(maxEntries = DEFAULT_BUFFER_SIZE) {
    this.maxEntries = maxEntries;
  }

  record(entry: QueryTelemetryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  recordCorrection(event: CorrectionEvent): void {
    this.corrections.push(event);
    if (this.corrections.length > this.maxEntries) {
      this.corrections.shift();
    }
  }

  getEntries(): ReadonlyArray<QueryTelemetryEntry> {
    return this.entries;
  }

  getCorrections(): ReadonlyArray<CorrectionEvent> {
    return this.corrections;
  }

  /** Get entries within a time window (ms from now). */
  getRecent(windowMs: number): QueryTelemetryEntry[] {
    const cutoff = Date.now() - windowMs;
    return this.entries.filter((e) => e.timestamp >= cutoff);
  }

  /** Get corrections within a time window (ms from now). */
  getRecentCorrections(windowMs: number): CorrectionEvent[] {
    const cutoff = Date.now() - windowMs;
    return this.corrections.filter((e) => e.timestamp >= cutoff);
  }

  clear(): void {
    this.entries = [];
    this.corrections = [];
  }

  get size(): number {
    return this.entries.length;
  }

  get correctionCount(): number {
    return this.corrections.length;
  }
}

/** Classify a confidence value into a bucket. */
export function confidenceBucket(confidence: number | null): QueryTelemetryEntry["confidenceBucket"] {
  if (confidence == null || confidence <= 0) return "none";
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.50) return "medium";
  return "low";
}
