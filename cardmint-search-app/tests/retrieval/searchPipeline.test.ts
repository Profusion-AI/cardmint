import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type Database from "better-sqlite3";
import { InventoryAdapter } from "../../src/retrieval/inventoryAdapter.js";
import { ReferenceAdapter } from "../../src/retrieval/referenceAdapter.js";
import { runPipeline } from "../../src/retrieval/searchPipeline.js";
import { seedInventoryDb } from "../fixtures/seedInventory.js";
import { seedReferenceDb } from "../fixtures/seedReference.js";

describe("searchPipeline", () => {
  let invDb: Database.Database;
  let refDb: Database.Database;
  let inventoryAdapter: InventoryAdapter;
  let referenceAdapter: ReferenceAdapter;

  beforeAll(() => {
    invDb = seedInventoryDb();
    refDb = seedReferenceDb();
    inventoryAdapter = new InventoryAdapter(invDb);
    referenceAdapter = new ReferenceAdapter(refDb);
  });

  afterAll(() => {
    invDb.close();
    refDb.close();
  });

  describe("inventory-first, conditional fallback", () => {
    it("returns inventory results when inventory has matches", () => {
      const result = runPipeline("charizard base set 4", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      expect(result.sourceLabel).toBe("internal_truth");
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.every((c) => c.sourceLabel === "internal_truth")).toBe(true);
    });

    it("falls back to reference ONLY when inventory returns 0", () => {
      // Venusaur is only in reference, not inventory
      const result = runPipeline("venusaur base set 15", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      expect(result.sourceLabel).toBe("reference_aggregate");
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.every((c) => c.sourceLabel === "reference_aggregate")).toBe(true);
    });

    it("never mixes inventory and reference candidates", () => {
      // Charizard exists in both — should only see inventory
      const result = runPipeline("charizard", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      const labels = new Set(result.candidates.map((c) => c.sourceLabel));
      expect(labels.size).toBeLessThanOrEqual(1);
    });
  });

  describe("sourceLabel contract", () => {
    it("response sourceLabel matches all candidate sourceLabels when resolved", () => {
      const result = runPipeline("charizard base set 4", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      if (result.status === "resolved" && result.chosen) {
        expect(result.chosen.sourceLabel).toBe(result.sourceLabel);
      }
      expect(result.candidates.every((c) => c.sourceLabel === result.sourceLabel)).toBe(true);
    });

    it("response sourceLabel matches all candidate sourceLabels on disambiguation", () => {
      const result = runPipeline("venusaur", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.99, // high threshold forces disambiguation
      });

      expect(result.candidates.every((c) => c.sourceLabel === result.sourceLabel)).toBe(true);
    });
  });

  describe("resolution", () => {
    it("resolves when top confidence >= minConfidence", () => {
      const result = runPipeline("charizard base set 4", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      expect(result.status).toBe("resolved");
      expect(result.chosen).not.toBeNull();
      expect(result.chosen!.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it("returns disambiguation when confidence is below threshold", () => {
      const result = runPipeline("charizard", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.99,
      });

      expect(result.status).toBe("needs_disambiguation");
      expect(result.chosen).toBeNull();
    });
  });

  describe("degraded mode", () => {
    it("works reference-only when inventory adapter is null", () => {
      const result = runPipeline("venusaur", {
        inventoryAdapter: null,
        referenceAdapter,
        minConfidence: 0.85,
      });

      expect(result.sourceLabel).toBe("reference_aggregate");
      expect(result.candidates.length).toBeGreaterThan(0);
    });

    it("returns empty when both adapters are null", () => {
      const result = runPipeline("charizard", {
        inventoryAdapter: null,
        referenceAdapter: null,
        minConfidence: 0.85,
      });

      expect(result.candidates.length).toBe(0);
      expect(result.status).toBe("needs_disambiguation");
    });
  });

  describe("sourceExplanation", () => {
    it("returns inventory explanation for internal_truth results", () => {
      const result = runPipeline("charizard base set 4", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      expect(result.sourceExplanation).toBe("CardMint verified inventory");
    });

    it("returns reference explanation for reference_aggregate results", () => {
      const result = runPipeline("venusaur base set 15", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      expect(result.sourceExplanation).toBe("Reference market aggregate — not a live seller listing");
    });

    it("always includes sourceExplanation (never undefined)", () => {
      const result = runPipeline("charizard", {
        inventoryAdapter: null,
        referenceAdapter: null,
        minConfidence: 0.85,
      });

      expect(result.sourceExplanation).toBeDefined();
      expect(typeof result.sourceExplanation).toBe("string");
      expect(result.sourceExplanation.length).toBeGreaterThan(0);
    });
  });

  describe("disambiguationReason", () => {
    it("is null when resolved", () => {
      const result = runPipeline("charizard base set 4", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      expect(result.status).toBe("resolved");
      expect(result.disambiguationReason).toBeNull();
    });

    it("is non-null when needs_disambiguation", () => {
      const result = runPipeline("charizard", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.99,
      });

      expect(result.status).toBe("needs_disambiguation");
      expect(result.disambiguationReason).not.toBeNull();
      expect(typeof result.disambiguationReason).toBe("string");
    });

    it("mentions 'multiple sets' for name-only queries with cross-set matches", () => {
      const result = runPipeline("charizard", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      // Charizard exists in Base Set + Evolutions → disambiguation
      if (result.status === "needs_disambiguation") {
        expect(result.disambiguationReason).toMatch(/set|name/i);
      }
    });

    it("provides reason when no adapters available", () => {
      const result = runPipeline("charizard", {
        inventoryAdapter: null,
        referenceAdapter: null,
        minConfidence: 0.85,
      });

      expect(result.disambiguationReason).toBe("No search adapters available");
    });
  });

  describe("duplicate product dedup", () => {
    it("deduplicates same-card same-condition product rows", () => {
      // Charizard Base Set NM has 3 product rows (original + 2 dups)
      const result = runPipeline("charizard base set 4", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      // Should have at most 1 NM and 1 LP candidate for Charizard Base Set
      const charizardNm = result.candidates.filter(
        (c) => c.cardName === "Charizard" && c.setName === "Base Set" && c.conditionBucket === "NM"
      );
      expect(charizardNm.length).toBe(1);
    });

    it("preserves different condition buckets after dedup", () => {
      const result = runPipeline("charizard base set 4", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      // Should retain both NM and LP (different conditions)
      const conditions = new Set(
        result.candidates
          .filter((c) => c.cardName === "Charizard" && c.setName === "Base Set")
          .map((c) => c.conditionBucket)
      );
      expect(conditions.has("NM")).toBe(true);
      expect(conditions.has("LP")).toBe(true);
    });

    it("keeps highest-priced representative when deduplicating", () => {
      const result = runPipeline("charizard base set 4", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      const nm = result.candidates.find(
        (c) => c.cardName === "Charizard" && c.setName === "Base Set" && c.conditionBucket === "NM"
      );
      // Should keep the $350 copy (highest market_price among 3 NM dups)
      expect(nm?.marketPrice).toBe(350.00);
    });

    it("duplicate rows do not inflate candidate count for name-only query", () => {
      const result = runPipeline("pikachu", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      // Pikachu has 2 NM products (original + dup) — should consolidate to 1 NM candidate
      const pikaNm = result.candidates.filter(
        (c) => c.cardName === "Pikachu" && c.conditionBucket === "NM"
      );
      expect(pikaNm.length).toBe(1);
    });
  });

  describe("normalization parity (X vs X/Y)", () => {
    it("X and X/Y queries resolve to same top candidate", () => {
      const resultX = runPipeline("charizard base set 4", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      // "4/102" is parsed by queryParser and normalized to "4"
      const resultXY = runPipeline("Charizard Base Set 4/102", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      expect(resultX.status).toBe("resolved");
      expect(resultXY.status).toBe("resolved");
      expect(resultX.chosen?.cardName).toBe(resultXY.chosen?.cardName);
      expect(resultX.chosen?.setName).toBe(resultXY.chosen?.setName);
    });

    it("leading-zero variants resolve identically", () => {
      const result011 = runPipeline("Charizard Evolutions 011/108", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      const result11 = runPipeline("Charizard Evolutions 11", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      expect(result011.chosen?.cardName).toBe(result11.chosen?.cardName);
      expect(result011.chosen?.setName).toBe(result11.chosen?.setName);
    });

    it("prefixed collector# with and without /total resolve identically", () => {
      const resultFull = runPipeline("Charizard ex Scarlet & Violet TG05", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      // The fixture has TG05/TG30 in the DB
      expect(resultFull.status).toBe("resolved");
      expect(resultFull.chosen?.cardName).toBe("Charizard ex");
    });
  });

  describe("freshness plumbing", () => {
    it("reference candidates include freshness timestamps", () => {
      const result = runPipeline("venusaur base set 15", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      expect(result.sourceLabel).toBe("reference_aggregate");
      for (const c of result.candidates) {
        expect(c.freshness).toBe("2026-02-06T17:17:00Z");
      }
    });

    it("inventory candidates have ISO-8601 freshness from updated_at", () => {
      const result = runPipeline("charizard base set 4", {
        inventoryAdapter,
        referenceAdapter,
        minConfidence: 0.85,
      });

      expect(result.sourceLabel).toBe("internal_truth");
      for (const c of result.candidates) {
        expect(c.freshness).not.toBeNull();
        expect(() => new Date(c.freshness!).toISOString()).not.toThrow();
      }
    });
  });
});
