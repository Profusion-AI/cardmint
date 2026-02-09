import { describe, expect, it, beforeEach } from "vitest";
import { QueryTelemetry, confidenceBucket, type QueryTelemetryEntry } from "../../src/telemetry/queryTelemetry.js";

function makeEntry(overrides: Partial<QueryTelemetryEntry> = {}): QueryTelemetryEntry {
  return {
    timestamp: Date.now(),
    query: "test query",
    durationMs: 5,
    status: "resolved",
    confidenceBucket: "high",
    sourceLabel: "internal_truth",
    retrievalPath: "deterministic",
    candidateCount: 3,
    ...overrides,
  };
}

describe("QueryTelemetry", () => {
  let telemetry: QueryTelemetry;

  beforeEach(() => {
    telemetry = new QueryTelemetry(5); // small buffer for testing
  });

  it("records and retrieves entries", () => {
    telemetry.record(makeEntry());
    expect(telemetry.size).toBe(1);
    expect(telemetry.getEntries().length).toBe(1);
  });

  it("respects ring buffer max size", () => {
    for (let i = 0; i < 10; i++) {
      telemetry.record(makeEntry({ query: `q${i}` }));
    }
    expect(telemetry.size).toBe(5);
    // Oldest entries should be evicted
    expect(telemetry.getEntries()[0].query).toBe("q5");
  });

  it("getRecent filters by time window", () => {
    telemetry.record(makeEntry({ timestamp: Date.now() - 120_000 })); // 2 min ago
    telemetry.record(makeEntry({ timestamp: Date.now() - 30_000 }));  // 30s ago
    telemetry.record(makeEntry({ timestamp: Date.now() }));            // now

    const recent = telemetry.getRecent(60_000); // last 1 minute
    expect(recent.length).toBe(2);
  });

  it("records corrections", () => {
    telemetry.recordCorrection({
      timestamp: Date.now(),
      query: "charizard",
      originalChosenId: "a",
      correctedId: "b",
    });
    expect(telemetry.correctionCount).toBe(1);
  });

  it("getRecentCorrections filters by time window", () => {
    telemetry.recordCorrection({
      timestamp: Date.now() - 120_000, // 2 min ago
      query: "old",
      originalChosenId: "a",
      correctedId: "b",
    });
    telemetry.recordCorrection({
      timestamp: Date.now(), // now
      query: "recent",
      originalChosenId: "c",
      correctedId: "d",
    });

    const recent = telemetry.getRecentCorrections(60_000); // last 1 minute
    expect(recent.length).toBe(1);
    expect(recent[0].query).toBe("recent");
  });

  it("clears all data", () => {
    telemetry.record(makeEntry());
    telemetry.recordCorrection({ timestamp: Date.now(), query: "q", originalChosenId: null, correctedId: "x" });
    telemetry.clear();
    expect(telemetry.size).toBe(0);
    expect(telemetry.correctionCount).toBe(0);
  });
});

describe("confidenceBucket", () => {
  it("classifies high confidence", () => {
    expect(confidenceBucket(0.95)).toBe("high");
    expect(confidenceBucket(0.85)).toBe("high");
  });

  it("classifies medium confidence", () => {
    expect(confidenceBucket(0.70)).toBe("medium");
    expect(confidenceBucket(0.50)).toBe("medium");
  });

  it("classifies low confidence", () => {
    expect(confidenceBucket(0.30)).toBe("low");
    expect(confidenceBucket(0.01)).toBe("low");
  });

  it("classifies none for null or zero", () => {
    expect(confidenceBucket(null)).toBe("none");
    expect(confidenceBucket(0)).toBe("none");
  });
});
