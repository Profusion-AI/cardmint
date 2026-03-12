import { describe, expect, it } from "vitest";
import { runSearch } from "../src/search/searchService.js";

describe("runSearch (legacy client-candidate mode)", () => {
  it("resolves when top candidate passes threshold", () => {
    const result = runSearch(
      "charizard base set",
      [
        {
          id: "a",
          title: "Charizard 4/102 Base Set",
          confidence: 0.93,
          source: "canonical_index"
        },
        {
          id: "b",
          title: "Charizard 11/108 Evolutions",
          confidence: 0.67,
          source: "reference_market"
        }
      ],
      0.85
    );

    expect(result.status).toBe("resolved");
    expect(result.chosen?.id).toBe("a");
    expect(result.chosen?.cardName).toBe("Charizard 4/102 Base Set");
    // canonical_index maps to reference_aggregate, so sourceLabel follows the candidate
    expect(result.sourceLabel).toBe("reference_aggregate");
  });

  it("requests disambiguation when confidence is low", () => {
    const result = runSearch(
      "pikachu",
      [
        {
          id: "p1",
          title: "Pikachu 58/102 Base Set",
          confidence: 0.62,
          source: "canonical_index"
        },
        {
          id: "p2",
          title: "Pikachu 001/SV-P Promo",
          confidence: 0.6,
          source: "reference_market"
        }
      ],
      0.85
    );

    expect(result.status).toBe("needs_disambiguation");
    expect(result.chosen).toBeNull();
    expect(result.sourceLabel).toBe("reference_aggregate");
    expect(result.candidates.length).toBe(2);
  });

  it("delegates to pipeline when pipelineOptions provided", () => {
    // With null adapters, should fall back to legacy
    const result = runSearch(
      "charizard",
      [
        {
          id: "a",
          title: "Charizard",
          confidence: 0.9,
          source: "internal_inventory"
        }
      ],
      0.85,
      null // no pipeline
    );

    expect(result.status).toBe("resolved");
    expect(result.chosen?.id).toBe("a");
  });

  it("sourceLabel contract: response label matches candidate labels", () => {
    const result = runSearch(
      "charizard",
      [
        {
          id: "a",
          title: "Charizard",
          confidence: 0.9,
          source: "internal_inventory"
        }
      ],
      0.85
    );

    // internal_inventory → internal_truth label
    expect(result.sourceLabel).toBe("internal_truth");
    expect(result.chosen?.sourceLabel).toBe(result.sourceLabel);
    expect(result.candidates.every((c) => c.sourceLabel === result.sourceLabel)).toBe(true);
  });

  it("sourceLabel contract: reference candidate resolved uses reference label", () => {
    const result = runSearch(
      "charizard",
      [
        {
          id: "a",
          title: "Charizard",
          confidence: 0.95,
          source: "reference_market"
        }
      ],
      0.85
    );

    expect(result.status).toBe("resolved");
    expect(result.sourceLabel).toBe("reference_aggregate");
    expect(result.chosen?.sourceLabel).toBe("reference_aggregate");
  });

  it("sourceExplanation matches sourceLabel for resolved results", () => {
    const result = runSearch(
      "charizard",
      [
        {
          id: "a",
          title: "Charizard",
          confidence: 0.9,
          source: "internal_inventory"
        }
      ],
      0.85
    );

    expect(result.sourceExplanation).toBe("CardMint verified inventory");
    expect(result.disambiguationReason).toBeNull();
  });

  it("sourceExplanation matches sourceLabel for reference results", () => {
    const result = runSearch(
      "charizard",
      [
        {
          id: "a",
          title: "Charizard",
          confidence: 0.9,
          source: "reference_market"
        }
      ],
      0.85
    );

    expect(result.sourceExplanation).toBe("Reference market aggregate — not a live seller listing");
  });

  it("disambiguationReason is non-null on disambiguation", () => {
    const result = runSearch(
      "pikachu",
      [
        {
          id: "p1",
          title: "Pikachu Base",
          confidence: 0.5,
          source: "canonical_index"
        }
      ],
      0.85
    );

    expect(result.status).toBe("needs_disambiguation");
    expect(result.disambiguationReason).not.toBeNull();
    expect(typeof result.disambiguationReason).toBe("string");
  });

  it("mixed-source candidates are filtered to single source", () => {
    const result = runSearch(
      "charizard",
      [
        {
          id: "a",
          title: "Charizard Base Set",
          confidence: 0.95,
          source: "internal_inventory"
        },
        {
          id: "b",
          title: "Charizard Evolutions",
          confidence: 0.88,
          source: "reference_market"
        }
      ],
      0.85
    );

    // All returned candidates should share one sourceLabel
    const labels = new Set(result.candidates.map((c) => c.sourceLabel));
    expect(labels.size).toBe(1);
    // Response-level sourceLabel must match candidate labels
    expect(result.sourceLabel).toBe([...labels][0]);
  });

  it("mixed-source filter preserves top candidate", () => {
    const result = runSearch(
      "charizard",
      [
        {
          id: "a",
          title: "Charizard Base Set",
          confidence: 0.95,
          source: "internal_inventory"
        },
        {
          id: "b",
          title: "Charizard Evolutions",
          confidence: 0.88,
          source: "reference_market"
        },
        {
          id: "c",
          title: "Charizard VMAX",
          confidence: 0.70,
          source: "canonical_index"
        }
      ],
      0.85
    );

    // Top candidate (highest confidence) is retained
    expect(result.chosen?.id).toBe("a");
    expect(result.chosen?.sourceLabel).toBe("internal_truth");
    // reference_market and canonical_index candidates (both map to reference_aggregate) should be filtered out
    expect(result.candidates.every((c) => c.sourceLabel === "internal_truth")).toBe(true);
  });

  it("legacy candidates have null freshness", () => {
    const result = runSearch(
      "charizard",
      [
        {
          id: "a",
          title: "Charizard",
          confidence: 0.9,
          source: "internal_inventory"
        }
      ],
      0.85
    );

    expect(result.chosen?.freshness).toBeNull();
    expect(result.candidates.every((c) => c.freshness === null)).toBe(true);
  });
});
