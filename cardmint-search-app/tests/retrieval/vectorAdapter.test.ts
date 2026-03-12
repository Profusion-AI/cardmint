import { describe, expect, it } from "vitest";
import { TfIdfVectorAdapter } from "../../src/retrieval/vectorAdapter.js";
import type { RetrievalCandidate } from "../../src/retrieval/types.js";

function makeCandidate(overrides: Partial<RetrievalCandidate> & { cardName: string; setName: string }): RetrievalCandidate {
  return {
    id: "test-id",
    collectorNo: null,
    rarity: null,
    conditionBucket: null,
    marketPrice: null,
    imageUrl: null,
    sourceLabel: "internal_truth",
    freshness: null,
    ...overrides,
  };
}

describe("TfIdfVectorAdapter", () => {
  const adapter = new TfIdfVectorAdapter();

  it("returns empty array for empty candidates", () => {
    expect(adapter.rerank("charizard", [])).toEqual([]);
  });

  it("returns candidates unchanged for empty query", () => {
    const candidates = [makeCandidate({ cardName: "Charizard", setName: "Base Set" })];
    expect(adapter.rerank("", candidates)).toEqual(candidates);
  });

  it("ranks exact name match higher than partial match", () => {
    const candidates = [
      makeCandidate({ id: "partial", cardName: "Dark Charizard", setName: "Team Rocket" }),
      makeCandidate({ id: "exact", cardName: "Charizard", setName: "Base Set" }),
    ];

    const reranked = adapter.rerank("charizard base set", candidates);
    expect(reranked[0].id).toBe("exact");
  });

  it("prefers candidate with more matching terms", () => {
    const candidates = [
      makeCandidate({ id: "name-only", cardName: "Pikachu", setName: "Promo" }),
      makeCandidate({ id: "name-set", cardName: "Pikachu", setName: "Base Set", collectorNo: "58" }),
    ];

    const reranked = adapter.rerank("pikachu base set 58", candidates);
    expect(reranked[0].id).toBe("name-set");
  });

  it("handles special characters in query and candidates", () => {
    const candidates = [
      makeCandidate({ cardName: "Ting-Lu ex", setName: "Paldea Evolved" }),
    ];

    expect(() => adapter.rerank("ting-lu ex paldea", candidates)).not.toThrow();
    expect(adapter.rerank("ting-lu ex paldea", candidates).length).toBe(1);
  });

  it("preserves all candidates (no filtering, only reordering)", () => {
    const candidates = [
      makeCandidate({ id: "a", cardName: "Charizard", setName: "Base Set" }),
      makeCandidate({ id: "b", cardName: "Pikachu", setName: "Base Set" }),
      makeCandidate({ id: "c", cardName: "Venusaur", setName: "Base Set" }),
    ];

    const reranked = adapter.rerank("venusaur base set", candidates);
    expect(reranked.length).toBe(3);
    expect(reranked[0].id).toBe("c");
  });
});
