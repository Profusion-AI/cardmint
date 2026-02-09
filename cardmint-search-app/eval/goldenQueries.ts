/**
 * Golden query set for CardMint Search pipeline evaluation.
 *
 * Each query has ground-truth labels used by runEval.ts to compute:
 *   - Wrong-set rate (Top-1)
 *   - High-confidence precision (confidence >= 0.85)
 *   - API latency p95
 *
 * Confidence scoring reference (from confidenceScorer.ts):
 *   Exact card name: +0.45  |  Partial name: +0.30
 *   Exact set:       +0.25  |  Exact collector#: +0.30
 *   Variant mismatch: -0.20 |  Clamped [0, 1]
 */

export interface GoldenQuery {
  query: string;
  expected: {
    cardName: string;
    setName: string;
    collectorNo: string | null;
    source: "internal_truth" | "reference_aggregate";
    /** false = expected to need disambiguation (status !== "resolved") */
    shouldResolve: boolean;
  };
}

export const goldenQueries: GoldenQuery[] = [
  // ────────────────────────────────────────────
  // Deterministic inventory (name + set + collector#) → should resolve
  // Confidence: 0.45 + 0.25 + 0.30 = 1.0
  // ────────────────────────────────────────────
  {
    query: "Charizard Base Set 4/102",
    expected: { cardName: "Charizard", setName: "Base Set", collectorNo: "4", source: "internal_truth", shouldResolve: true },
  },
  {
    query: "Pikachu Base Set 58/102",
    expected: { cardName: "Pikachu", setName: "Base Set", collectorNo: "58", source: "internal_truth", shouldResolve: true },
  },
  {
    query: "Flareon Jungle 3/064",
    expected: { cardName: "Flareon", setName: "Jungle", collectorNo: "3", source: "internal_truth", shouldResolve: true },
  },
  {
    query: "Charizard Evolutions 011/108",
    expected: { cardName: "Charizard", setName: "Evolutions", collectorNo: "11", source: "internal_truth", shouldResolve: true },
  },
  {
    query: "Dark Gyarados Team Rocket 8/082",
    expected: { cardName: "Dark Gyarados", setName: "Team Rocket", collectorNo: "8", source: "internal_truth", shouldResolve: true },
  },
  {
    query: "Charizard ex Scarlet & Violet TG05",
    expected: { cardName: "Charizard ex", setName: "Scarlet & Violet", collectorNo: "TG05", source: "internal_truth", shouldResolve: true },
  },
  {
    query: "Pikachu Base Set 58",
    expected: { cardName: "Pikachu", setName: "Base Set", collectorNo: "58", source: "internal_truth", shouldResolve: true },
  },
  {
    query: "Flareon Jungle 003",
    expected: { cardName: "Flareon", setName: "Jungle", collectorNo: "3", source: "internal_truth", shouldResolve: true },
  },
  {
    query: "Charizard Evolutions 11",
    expected: { cardName: "Charizard", setName: "Evolutions", collectorNo: "11", source: "internal_truth", shouldResolve: true },
  },
  {
    query: "Dark Gyarados Team Rocket 008",
    expected: { cardName: "Dark Gyarados", setName: "Team Rocket", collectorNo: "8", source: "internal_truth", shouldResolve: true },
  },

  // ────────────────────────────────────────────
  // Deterministic reference fallback (not in inventory)
  // Confidence: 0.45 + 0.25 + 0.30 = 1.0
  // ────────────────────────────────────────────
  {
    query: "Venusaur Base Set 15/102",
    expected: { cardName: "Venusaur", setName: "Base Set", collectorNo: "15", source: "reference_aggregate", shouldResolve: true },
  },
  {
    query: "Alakazam Base Set 1/102",
    expected: { cardName: "Alakazam", setName: "Base Set", collectorNo: "1", source: "reference_aggregate", shouldResolve: true },
  },
  {
    query: "Gengar Fossil 5/062",
    expected: { cardName: "Gengar", setName: "Fossil", collectorNo: "5", source: "reference_aggregate", shouldResolve: true },
  },
  {
    query: "Dragonite Fossil 4/062",
    expected: { cardName: "Dragonite", setName: "Fossil", collectorNo: "4", source: "reference_aggregate", shouldResolve: true },
  },
  {
    query: "Vaporeon Jungle 12/064",
    expected: { cardName: "Vaporeon", setName: "Jungle", collectorNo: "12", source: "reference_aggregate", shouldResolve: true },
  },
  {
    query: "Giratina V Crown Zenith GG69",
    expected: { cardName: "Giratina V", setName: "Crown Zenith", collectorNo: "GG69", source: "reference_aggregate", shouldResolve: true },
  },
  {
    query: "Ting-Lu ex Paldea Evolved 105/193",
    expected: { cardName: "Ting-Lu ex", setName: "Paldea Evolved", collectorNo: "105", source: "reference_aggregate", shouldResolve: true },
  },
  {
    query: "Venusaur Base Set 015",
    expected: { cardName: "Venusaur", setName: "Base Set", collectorNo: "15", source: "reference_aggregate", shouldResolve: true },
  },

  // ────────────────────────────────────────────
  // FTS/LIKE inventory (name only, no set/collector#)
  // Confidence: 0.45 (exact name) → below 0.85 → needs_disambiguation
  // ────────────────────────────────────────────
  {
    query: "Flareon",
    expected: { cardName: "Flareon", setName: "Jungle", collectorNo: "3", source: "internal_truth", shouldResolve: false },
  },
  {
    query: "Blastoise",
    // Blastoise has qty=0 in inventory, so falls through to reference (where it doesn't exist).
    // No candidates at all → needs_disambiguation
    expected: { cardName: "Blastoise", setName: "Base Set", collectorNo: "2", source: "reference_aggregate", shouldResolve: false },
  },
  {
    query: "Dark Gyarados",
    expected: { cardName: "Dark Gyarados", setName: "Team Rocket", collectorNo: "8", source: "internal_truth", shouldResolve: false },
  },

  // ────────────────────────────────────────────
  // FTS/LIKE reference fallback (not in inventory, name only)
  // Confidence: 0.45 → below 0.85 → needs_disambiguation
  // ────────────────────────────────────────────
  {
    query: "Gengar",
    expected: { cardName: "Gengar", setName: "Fossil", collectorNo: "5", source: "reference_aggregate", shouldResolve: false },
  },
  {
    query: "Dragonite",
    expected: { cardName: "Dragonite", setName: "Fossil", collectorNo: "4", source: "reference_aggregate", shouldResolve: false },
  },
  {
    query: "Vaporeon",
    expected: { cardName: "Vaporeon", setName: "Jungle", collectorNo: "12", source: "reference_aggregate", shouldResolve: false },
  },
  {
    query: "Giratina V",
    expected: { cardName: "Giratina V", setName: "Crown Zenith", collectorNo: "GG69", source: "reference_aggregate", shouldResolve: false },
  },

  // ────────────────────────────────────────────
  // Variant queries — variant penalty triggers disambiguation
  // Confidence: 0.45 + 0.25 + 0.30 - 0.20 = 0.80 → below 0.85
  // ────────────────────────────────────────────
  {
    query: "Charizard shadowless Base Set 4/102",
    expected: { cardName: "Charizard", setName: "Base Set", collectorNo: "4", source: "internal_truth", shouldResolve: false },
  },
  {
    query: "Pikachu 1st edition Base Set 58",
    expected: { cardName: "Pikachu", setName: "Base Set", collectorNo: "58", source: "internal_truth", shouldResolve: false },
  },
  {
    query: "Flareon reverse holo Jungle 3",
    expected: { cardName: "Flareon", setName: "Jungle", collectorNo: "3", source: "internal_truth", shouldResolve: false },
  },
  {
    query: "Venusaur shadowless Base Set 15",
    expected: { cardName: "Venusaur", setName: "Base Set", collectorNo: "15", source: "reference_aggregate", shouldResolve: false },
  },
  {
    query: "Gengar first edition Fossil 5",
    expected: { cardName: "Gengar", setName: "Fossil", collectorNo: "5", source: "reference_aggregate", shouldResolve: false },
  },

  // ────────────────────────────────────────────
  // Prefixed collector# queries
  // Confidence: 0.45 + 0.25 + 0.30 = 1.0
  // ────────────────────────────────────────────
  {
    query: "Charizard ex TG05 Scarlet & Violet",
    expected: { cardName: "Charizard ex", setName: "Scarlet & Violet", collectorNo: "TG05", source: "internal_truth", shouldResolve: true },
  },
  {
    query: "Giratina V GG69 Crown Zenith",
    expected: { cardName: "Giratina V", setName: "Crown Zenith", collectorNo: "GG69", source: "reference_aggregate", shouldResolve: true },
  },
  {
    query: "Ting-Lu ex 105 Paldea Evolved",
    expected: { cardName: "Ting-Lu ex", setName: "Paldea Evolved", collectorNo: "105", source: "reference_aggregate", shouldResolve: true },
  },
  {
    query: "Giratina V GG69/GG70 Crown Zenith",
    expected: { cardName: "Giratina V", setName: "Crown Zenith", collectorNo: "GG69", source: "reference_aggregate", shouldResolve: true },
  },

  // ────────────────────────────────────────────
  // Ambiguous / multi-match — name matches multiple sets → disambiguation
  // Confidence: 0.45 → below 0.85
  // ────────────────────────────────────────────
  {
    query: "Charizard",
    expected: { cardName: "Charizard", setName: "Base Set", collectorNo: "4", source: "internal_truth", shouldResolve: false },
  },
  {
    query: "Pikachu",
    expected: { cardName: "Pikachu", setName: "Base Set", collectorNo: "58", source: "internal_truth", shouldResolve: false },
  },

  // ────────────────────────────────────────────
  // Set-specific, name + set but no collector# → name(0.45) + set(0.25) = 0.70
  // Below 0.85 → needs_disambiguation
  // ────────────────────────────────────────────
  {
    query: "Charizard Evolutions",
    expected: { cardName: "Charizard", setName: "Evolutions", collectorNo: "11", source: "internal_truth", shouldResolve: false },
  },
  {
    query: "Dark Gyarados Team Rocket",
    expected: { cardName: "Dark Gyarados", setName: "Team Rocket", collectorNo: "8", source: "internal_truth", shouldResolve: false },
  },
  {
    query: "Charizard Base Set",
    expected: { cardName: "Charizard", setName: "Base Set", collectorNo: "4", source: "internal_truth", shouldResolve: false },
  },
  {
    query: "Venusaur Base Set",
    expected: { cardName: "Venusaur", setName: "Base Set", collectorNo: "15", source: "reference_aggregate", shouldResolve: false },
  },
  {
    query: "Gengar Fossil",
    expected: { cardName: "Gengar", setName: "Fossil", collectorNo: "5", source: "reference_aggregate", shouldResolve: false },
  },

  // ────────────────────────────────────────────
  // Set + collector# (no card name) → collector#(0.30) + set... but no name match
  // Parser yields: cardName=null, setName present, collectorNo present
  // Deterministic path runs, gets candidates with 0.30+0.25=0.55 at best
  // → needs_disambiguation
  // Wait — let me rethink. If the parser extracts set + collector# but the remaining text
  // is empty, cardName will be null. The scorer gives +0 for name, +0.25 for set, +0.30
  // for collector# = 0.55 → needs_disambiguation
  // ────────────────────────────────────────────
  {
    query: "Base Set 4",
    expected: { cardName: "Charizard", setName: "Base Set", collectorNo: "4", source: "internal_truth", shouldResolve: false },
  },
  {
    query: "Fossil 5",
    expected: { cardName: "Gengar", setName: "Fossil", collectorNo: "5", source: "reference_aggregate", shouldResolve: false },
  },

  // ────────────────────────────────────────────
  // Collector# + name (no set) → name(0.45) + collector#(0.30) = 0.75
  // Below 0.85 → needs_disambiguation (but top result should be correct)
  // ────────────────────────────────────────────
  {
    query: "Charizard 4",
    expected: { cardName: "Charizard", setName: "Base Set", collectorNo: "4", source: "internal_truth", shouldResolve: false },
  },
  {
    query: "Pikachu 58",
    expected: { cardName: "Pikachu", setName: "Base Set", collectorNo: "58", source: "internal_truth", shouldResolve: false },
  },
  {
    query: "Venusaur 15",
    expected: { cardName: "Venusaur", setName: "Base Set", collectorNo: "15", source: "reference_aggregate", shouldResolve: false },
  },

  // ────────────────────────────────────────────
  // Edge cases
  // ────────────────────────────────────────────
  {
    // Number-only query: parser extracts collectorNo but no cardName or set
    // Falls through to empty result → needs_disambiguation
    query: "4",
    expected: { cardName: "Charizard", setName: "Base Set", collectorNo: "4", source: "internal_truth", shouldResolve: false },
  },
  {
    // Mew promo (null collector#) — reference only, name-only LIKE match
    // Confidence: 0.45 → needs_disambiguation
    query: "Mew",
    expected: { cardName: "Mew", setName: "Promo", collectorNo: null, source: "reference_aggregate", shouldResolve: false },
  },
];
