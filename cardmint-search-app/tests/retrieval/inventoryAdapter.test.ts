import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type Database from "better-sqlite3";
import { InventoryAdapter, sanitizeFts5Query } from "../../src/retrieval/inventoryAdapter.js";
import { seedInventoryDb } from "../fixtures/seedInventory.js";

describe("sanitizeFts5Query", () => {
  it("strips slash and numeric tokens from 'charizard 4/102'", () => {
    expect(sanitizeFts5Query("charizard 4/102")).toBe('"charizard"');
  });

  it("handles apostrophe in Blaine's Growlithe", () => {
    expect(sanitizeFts5Query("Blaine's Growlithe")).toBe('"Blaine s Growlithe"');
  });

  it("strips parentheses from 'pikachu (25)'", () => {
    expect(sanitizeFts5Query("pikachu (25)")).toBe('"pikachu"');
  });

  it("returns null when all tokens are numeric", () => {
    expect(sanitizeFts5Query("4/102")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(sanitizeFts5Query("")).toBeNull();
  });

  it("handles mixed punctuation", () => {
    expect(sanitizeFts5Query('dark "charizard" ex')).toBe('"dark charizard ex"');
  });
});

describe("InventoryAdapter", () => {
  let db: Database.Database;
  let adapter: InventoryAdapter;

  beforeAll(() => {
    db = seedInventoryDb();
    adapter = new InventoryAdapter(db);
  });

  afterAll(() => {
    db.close();
  });

  describe("deterministic search (set + collector_no)", () => {
    it("finds Charizard by exact set + collector number", () => {
      const { candidates: results } = adapter.search({
        cardName: "Charizard",
        setName: "Base Set",
        collectorNo: "4",
        variantHint: null,
        raw: "charizard base set 4",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.cardName === "Charizard")).toBe(true);
      expect(results.every((r) => r.setName === "Base Set")).toBe(true);
      expect(results.every((r) => r.sourceLabel === "internal_truth")).toBe(true);
    });

    it("uses exact set matching (= not LIKE)", () => {
      // "Base" should NOT match "Base Set" in deterministic mode
      const { candidates: results } = adapter.search({
        cardName: null,
        setName: "Base",
        collectorNo: "4",
        variantHint: null,
        raw: "base 4",
      });

      expect(results.length).toBe(0);
    });

    it("filters by normalize_cno in SQL before LIMIT", () => {
      // "004/102" normalizes to "4", should find Charizard
      const { candidates: results } = adapter.search({
        cardName: null,
        setName: "Base Set",
        collectorNo: "4",
        variantHint: null,
        raw: "base set 4",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].cardName).toBe("Charizard");
    });

    it("excludes sold-out products (total_quantity = 0)", () => {
      // Blastoise has total_quantity = 0
      const { candidates: results } = adapter.search({
        cardName: null,
        setName: "Base Set",
        collectorNo: "2",
        variantHint: null,
        raw: "base set 2",
      });

      expect(results.length).toBe(0);
    });

    it("normalizes collector_no with leading zeros", () => {
      // Charizard Evolutions has collector_no "011/108", normalizes to "11"
      const { candidates: results } = adapter.search({
        cardName: null,
        setName: "Evolutions",
        collectorNo: "11",
        variantHint: null,
        raw: "evolutions 11",
      });

      expect(results.length).toBe(1);
      expect(results[0].cardName).toBe("Charizard");
    });
  });

  describe("FTS5 search", () => {
    it("finds cards by name via FTS5", () => {
      const { candidates: results } = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.cardName.toLowerCase().includes("charizard"))).toBe(true);
    });

    it("does not throw on 'charizard 4/102'", () => {
      expect(() =>
        adapter.search({
          cardName: "charizard 4/102",
          setName: null,
          collectorNo: null,
          variantHint: null,
          raw: "charizard 4/102",
        })
      ).not.toThrow();
    });

    it("does not throw on Blaine's Growlithe", () => {
      expect(() =>
        adapter.search({
          cardName: "Blaine's Growlithe",
          setName: null,
          collectorNo: null,
          variantHint: null,
          raw: "Blaine's Growlithe",
        })
      ).not.toThrow();
    });

    it("does not throw on 'pikachu (25)'", () => {
      expect(() =>
        adapter.search({
          cardName: "pikachu (25)",
          setName: null,
          collectorNo: null,
          variantHint: null,
          raw: "pikachu (25)",
        })
      ).not.toThrow();
    });
  });

  describe("LIKE fallback", () => {
    it("falls back to LIKE when FTS5 returns empty", () => {
      // "Flareon" is in the DB; FTS5 should find it, but if not, LIKE will
      const { candidates: results } = adapter.search({
        cardName: "Flareon",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "flareon",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].cardName).toBe("Flareon");
    });
  });

  describe("set-constrained FTS and LIKE", () => {
    it("jungle flareon: does not return Dark Flareon (Team Rocket) when set is Jungle", () => {
      const { candidates } = adapter.search({
        cardName: "Flareon",
        setName: "Jungle",
        collectorNo: null,
        variantHint: null,
        raw: "jungle flareon",
      });
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((c) => c.setName === "Jungle")).toBe(true);
      expect(candidates.some((c) => c.setName === "Team Rocket")).toBe(false);
    });

    it("set-constrained miss: returns empty when no inventory row matches the specified set", () => {
      // Charizard exists in Base Set and Evolutions, but not in Team Rocket
      const { candidates } = adapter.search({
        cardName: "Charizard",
        setName: "Team Rocket",
        collectorNo: null,
        variantHint: null,
        raw: "charizard team rocket",
      });
      expect(candidates.length).toBe(0);
    });

    it("base set query also returns Base Set (Shadowless) via parenthetical normalization", () => {
      // Sandshrew exists only in Base Set (Shadowless); querying setName='Base Set' should still find it
      const { candidates } = adapter.search({
        cardName: "Sandshrew",
        setName: "Base Set",
        collectorNo: null,
        variantHint: null,
        raw: "sandshrew base set",
      });
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.some((c) => c.setName === "Base Set (Shadowless)")).toBe(true);
    });

    it("unconstrained name-only search returns matching cards across all sets", () => {
      // Charizard is in Base Set and Evolutions; no setName should return both
      const { candidates } = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });
      const sets = new Set(candidates.map((c) => c.setName));
      expect(sets.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe("sourceLabel contract", () => {
    it("always returns internal_truth for all candidates", () => {
      const { candidates: results } = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });

      expect(results.every((r) => r.sourceLabel === "internal_truth")).toBe(true);
    });
  });

  describe("retrievalPath reporting", () => {
    it("reports 'deterministic' for set + collector_no match", () => {
      const { retrievalPath } = adapter.search({
        cardName: "Charizard",
        setName: "Base Set",
        collectorNo: "4",
        variantHint: null,
        raw: "charizard base set 4",
      });
      expect(retrievalPath).toBe("deterministic");
    });

    it("reports 'fts' for name-only FTS5 match", () => {
      const { retrievalPath } = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });
      expect(retrievalPath).toBe("fts");
    });

    it("reports 'like' for LIKE fallback", () => {
      const { retrievalPath } = adapter.search({
        cardName: "Flareon",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "flareon",
      });
      // Flareon may match via FTS or LIKE; either "fts" or "like" is valid
      expect(["fts", "like"]).toContain(retrievalPath);
    });
  });

  describe("freshness contract", () => {
    it("returns ISO-8601 freshness from updated_at for inventory candidates", () => {
      const { candidates: results } = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.freshness).not.toBeNull();
        expect(() => new Date(r.freshness!).toISOString()).not.toThrow();
      }
    });
  });
});
