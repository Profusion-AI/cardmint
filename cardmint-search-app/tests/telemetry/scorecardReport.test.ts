import { describe, expect, it } from "vitest";
import { QueryTelemetry, type QueryTelemetryEntry } from "../../src/telemetry/queryTelemetry.js";
import { generateScorecard } from "../../src/telemetry/scorecardReport.js";

function makeEntry(overrides: Partial<QueryTelemetryEntry> = {}): QueryTelemetryEntry {
  return {
    timestamp: Date.now(),
    query: "test",
    durationMs: 5,
    status: "resolved",
    confidenceBucket: "high",
    sourceLabel: "internal_truth",
    retrievalPath: "deterministic",
    candidateCount: 2,
    ...overrides,
  };
}

describe("generateScorecard", () => {
  it("returns zeros for empty telemetry", () => {
    const tel = new QueryTelemetry();
    const report = generateScorecard(tel);

    expect(report.queryCount).toBe(0);
    expect(report.latency.p95Ms).toBe(0);
    expect(report.resolution.resolvedCount).toBe(0);
  });

  it("computes correct latency percentiles", () => {
    const tel = new QueryTelemetry();
    // Add 20 entries with durations 1-20ms
    for (let i = 1; i <= 20; i++) {
      tel.record(makeEntry({ durationMs: i }));
    }

    const report = generateScorecard(tel);
    expect(report.queryCount).toBe(20);
    expect(report.latency.p50Ms).toBeGreaterThanOrEqual(9);
    expect(report.latency.p95Ms).toBeGreaterThanOrEqual(18);
  });

  it("tracks resolution rate", () => {
    const tel = new QueryTelemetry();
    tel.record(makeEntry({ status: "resolved" }));
    tel.record(makeEntry({ status: "resolved" }));
    tel.record(makeEntry({ status: "needs_disambiguation" }));

    const report = generateScorecard(tel);
    expect(report.resolution.resolvedCount).toBe(2);
    expect(report.resolution.disambiguationCount).toBe(1);
    expect(report.resolution.resolutionRate).toBe("66.7%");
  });

  it("tracks confidence distribution", () => {
    const tel = new QueryTelemetry();
    tel.record(makeEntry({ confidenceBucket: "high" }));
    tel.record(makeEntry({ confidenceBucket: "medium" }));
    tel.record(makeEntry({ confidenceBucket: "low" }));
    tel.record(makeEntry({ confidenceBucket: "none" }));

    const report = generateScorecard(tel);
    expect(report.confidence.high).toBe(1);
    expect(report.confidence.medium).toBe(1);
    expect(report.confidence.low).toBe(1);
    expect(report.confidence.none).toBe(1);
  });

  it("tracks source mix", () => {
    const tel = new QueryTelemetry();
    tel.record(makeEntry({ sourceLabel: "internal_truth" }));
    tel.record(makeEntry({ sourceLabel: "internal_truth" }));
    tel.record(makeEntry({ sourceLabel: "reference_aggregate" }));

    const report = generateScorecard(tel);
    expect(report.source.internalTruth).toBe(2);
    expect(report.source.referenceAggregate).toBe(1);
  });

  it("computes correction rate", () => {
    const tel = new QueryTelemetry();
    tel.record(makeEntry());
    tel.record(makeEntry());
    tel.record(makeEntry());
    tel.recordCorrection({
      timestamp: Date.now(),
      query: "test",
      originalChosenId: "a",
      correctedId: "b",
    });

    const report = generateScorecard(tel);
    expect(report.corrections.totalQueries).toBe(3);
    expect(report.corrections.correctionCount).toBe(1);
  });

  it("correction rate is window-scoped (old corrections excluded)", () => {
    const tel = new QueryTelemetry();
    // Recent query + correction (within 1h window)
    tel.record(makeEntry({ timestamp: Date.now() }));
    tel.recordCorrection({
      timestamp: Date.now(),
      query: "recent",
      originalChosenId: "a",
      correctedId: "b",
    });
    // Old correction (outside 1h window)
    tel.recordCorrection({
      timestamp: Date.now() - 7_200_000, // 2 hours ago
      query: "old",
      originalChosenId: "c",
      correctedId: "d",
    });

    const report = generateScorecard(tel, 3_600_000); // 1h window
    expect(report.corrections.correctionCount).toBe(1); // only the recent one
    expect(report.corrections.totalQueries).toBe(1);
  });

  it("includes window description", () => {
    const tel = new QueryTelemetry();
    const report = generateScorecard(tel, 3_600_000);
    expect(report.window).toBe("1h");
  });
});
