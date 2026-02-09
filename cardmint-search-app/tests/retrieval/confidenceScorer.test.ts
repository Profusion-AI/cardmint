import { describe, expect, it } from "vitest";
import { scoreCandidate, scoreCandidates } from "../../src/retrieval/confidenceScorer.js";
import type { RetrievalCandidate, ParsedQuery } from "../../src/retrieval/types.js";

const makeCandidate = (overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate => ({
  id: "test-1",
  cardName: "Charizard",
  setName: "Base Set",
  collectorNo: "4/102",
  rarity: "Rare Holo",
  conditionBucket: "NM",
  marketPrice: 350.0,
  imageUrl: null,
  sourceLabel: "internal_truth",
  freshness: null,
  ...overrides,
});

describe("scoreCandidate", () => {
  it("gives max score for exact name + set + collector match", () => {
    const parsed: ParsedQuery = {
      cardName: "Charizard",
      setName: "Base Set",
      collectorNo: "4",
      variantHint: null,
      raw: "charizard base set 4",
    };

    const result = scoreCandidate(makeCandidate(), parsed);
    // 0.45 (exact name) + 0.25 (exact set) + 0.30 (exact collector) = 1.0
    expect(result.confidence).toBe(1.0);
  });

  it("gives partial score for name-only match", () => {
    const parsed: ParsedQuery = {
      cardName: "Charizard",
      setName: null,
      collectorNo: null,
      variantHint: null,
      raw: "charizard",
    };

    const result = scoreCandidate(makeCandidate(), parsed);
    expect(result.confidence).toBe(0.45);
  });

  it("gives partial score for partial name match", () => {
    const parsed: ParsedQuery = {
      cardName: "Char",
      setName: null,
      collectorNo: null,
      variantHint: null,
      raw: "char",
    };

    const result = scoreCandidate(makeCandidate(), parsed);
    // "charizard" includes "char" → 0.30
    expect(result.confidence).toBe(0.30);
  });

  it("gives 0 for completely unrelated candidate", () => {
    const parsed: ParsedQuery = {
      cardName: "Venusaur",
      setName: "Jungle",
      collectorNo: "15",
      variantHint: null,
      raw: "venusaur jungle 15",
    };

    const result = scoreCandidate(makeCandidate(), parsed);
    expect(result.confidence).toBe(0);
  });

  it("clamps confidence to [0, 1]", () => {
    const parsed: ParsedQuery = {
      cardName: "Charizard",
      setName: "Base Set",
      collectorNo: "4",
      variantHint: null,
      raw: "charizard base set 4",
    };

    const result = scoreCandidate(makeCandidate(), parsed);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it("penalizes when variant hint is present but unmatched", () => {
    const parsed: ParsedQuery = {
      cardName: "Charizard",
      setName: "Base Set",
      collectorNo: "4",
      variantHint: "shadowless",
      raw: "charizard shadowless base set 4",
    };

    const result = scoreCandidate(makeCandidate(), parsed);
    // 0.45 + 0.25 + 0.30 - 0.20 (variant miss) = 0.80
    expect(result.confidence).toBe(0.80);
  });

  it("does not penalize when variant hint matches candidate text", () => {
    const parsed: ParsedQuery = {
      cardName: "Charizard",
      setName: "Base Set",
      collectorNo: "4",
      variantHint: "shadowless",
      raw: "charizard shadowless base set 4",
    };

    const result = scoreCandidate(
      makeCandidate({ cardName: "Charizard Shadowless" }),
      parsed,
    );
    // 0.30 (partial name) + 0.25 (exact set) + 0.30 (collector) = 0.85 (no variant penalty)
    expect(result.confidence).toBeCloseTo(0.85, 10);
  });
});

describe("scoreCandidates", () => {
  it("sorts candidates by confidence descending", () => {
    const parsed: ParsedQuery = {
      cardName: "Charizard",
      setName: "Base Set",
      collectorNo: "4",
      variantHint: null,
      raw: "charizard base set 4",
    };

    const candidates = [
      makeCandidate({ id: "wrong-set", setName: "Evolutions", collectorNo: "11/108" }),
      makeCandidate({ id: "exact", setName: "Base Set", collectorNo: "4/102" }),
    ];

    const scored = scoreCandidates(candidates, parsed);
    expect(scored[0].id).toBe("exact");
    expect(scored[0].confidence).toBeGreaterThan(scored[1].confidence);
  });
});
