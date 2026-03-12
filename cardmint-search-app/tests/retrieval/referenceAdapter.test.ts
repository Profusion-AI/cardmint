import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type Database from "better-sqlite3";
import { ReferenceAdapter } from "../../src/retrieval/referenceAdapter.js";
import { seedReferenceDb, seedEmptyReferenceDb } from "../fixtures/seedReference.js";

describe("ReferenceAdapter", () => {
  let db: Database.Database;
  let adapter: ReferenceAdapter;

  beforeAll(() => {
    db = seedReferenceDb();
    adapter = new ReferenceAdapter(db);
  });

  afterAll(() => {
    db.close();
  });

  describe("deterministic search (set + collector_no)", () => {
    it("finds Charizard by set + collector number", () => {
      const results = adapter.search({
        cardName: null,
        setName: "Base Set",
        collectorNo: "4",
        variantHint: null,
        raw: "base set 4",
      });

      expect(results.length).toBe(1);
      expect(results[0].cardName).toBe("Charizard");
      expect(results[0].setName).toBe("Base Set");
    });

    it("uses exact set matching (= not LIKE)", () => {
      // "Base" should NOT match "Base Set"
      const results = adapter.search({
        cardName: null,
        setName: "Base",
        collectorNo: "4",
        variantHint: null,
        raw: "base 4",
      });

      expect(results.length).toBe(0);
    });

    it("normalizes collector_no via UDF (raw preserved in response)", () => {
      // card_number "004/102" normalizes to "4"
      const results = adapter.search({
        cardName: null,
        setName: "Base Set",
        collectorNo: "4",
        variantHint: null,
        raw: "base set 4",
      });

      expect(results.length).toBe(1);
      expect(results[0].collectorNo).toBe("004/102"); // raw preserved in response
    });

    it("only returns rows from latest complete snapshot", () => {
      // Mewtwo exists only in snapshot 1 (older), not snapshot 2 (latest)
      const results = adapter.search({
        cardName: null,
        setName: "Base Set",
        collectorNo: "10",
        variantHint: null,
        raw: "base set 10",
      });

      expect(results.length).toBe(0);
    });
  });

  describe("LIKE search (card name)", () => {
    it("finds Venusaur by name", () => {
      const results = adapter.search({
        cardName: "Venusaur",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "venusaur",
      });

      expect(results.length).toBe(1);
      expect(results[0].cardName).toBe("Venusaur");
    });

    it("finds multiple Charizards across sets when no setName provided", () => {
      const results = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });

      // Base Set + Evolutions + Charizard ex (Scarlet & Violet) = 3 unique cards
      expect(results.length).toBe(3);
    });

    it("finds Pikachu including promo (null card_number)", () => {
      const results = adapter.search({
        cardName: "Pikachu",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "pikachu",
      });

      expect(results.length).toBe(2); // Base Set + Promo
    });
  });

  describe("set-constrained likeSearch", () => {
    it("likeSearch is set-constrained when setName provided", () => {
      const results = adapter.search({
        cardName: "Flareon",
        setName: "Jungle",
        collectorNo: null,
        variantHint: null,
        raw: "flareon jungle",
      });

      // Should only return Jungle Flareon, not Evolutions Flareon
      expect(results.length).toBe(1);
      expect(results[0].setName).toBe("Jungle");
    });

    it("likeSearch returns all sets when no setName provided", () => {
      const results = adapter.search({
        cardName: "Flareon",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "flareon",
      });

      expect(results.length).toBe(2);
      const setNames = results.map(r => r.setName).sort();
      expect(setNames).toContain("Jungle");
      expect(setNames).toContain("Evolutions");
    });
  });

  describe("empty snapshot state", () => {
    it("returns empty when no complete snapshot exists", () => {
      const emptyDb = seedEmptyReferenceDb();
      const emptyAdapter = new ReferenceAdapter(emptyDb);

      const results = emptyAdapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });

      expect(results).toEqual([]);
      emptyDb.close();
    });
  });

  describe("UNK conditionBucket contract", () => {
    it("all reference candidates have conditionBucket 'UNK'", () => {
      const results = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.conditionBucket === "UNK")).toBe(true);
    });

    it("always returns reference_aggregate sourceLabel", () => {
      const results = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });

      expect(results.every(r => r.sourceLabel === "reference_aggregate")).toBe(true);
    });
  });

  describe("LP-preferred pricing", () => {
    it("uses LP price when available, NM price as fallback", () => {
      // Charizard Base Set has NM=400.00, LP=320.00, MP=220.00
      const results = adapter.search({
        cardName: null,
        setName: "Base Set",
        collectorNo: "4",
        variantHint: null,
        raw: "base set 4",
      });

      expect(results.length).toBe(1);
      // Should use LP price ($320.00), not NM ($400.00)
      expect(results[0].marketPrice).toBeCloseTo(320.00, 2);
    });

    it("falls back to NM price when no LP row exists", () => {
      // Venusaur only has NM row
      const results = adapter.search({
        cardName: "Venusaur",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "venusaur",
      });

      expect(results.length).toBe(1);
      expect(results[0].marketPrice).toBeCloseTo(95.00, 2);
    });

    it("uses LP price when NM absent (Vaporeon Jungle)", () => {
      // Vaporeon only has LP row
      const results = adapter.search({
        cardName: "Vaporeon",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "vaporeon",
      });

      expect(results.length).toBe(1);
      expect(results[0].marketPrice).toBeCloseTo(28.00, 2);
    });
  });

  describe("deduplication", () => {
    it("deduplicates to one candidate per card identity", () => {
      // Charizard Base Set has NM + LP + MP rows — expect one result
      const results = adapter.search({
        cardName: null,
        setName: "Base Set",
        collectorNo: "4",
        variantHint: null,
        raw: "base set 4",
      });

      expect(results.length).toBe(1);
    });

    it("returns distinct cards across sets (not inflated by conditions)", () => {
      // Charizard across sets: Base Set (3 conditions) + Evolutions (1) + Charizard ex (1)
      // Should deduplicate to 3 unique card identities, not 5 raw rows
      const results = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });

      expect(results.length).toBe(3);
    });
  });

  describe("freshness contract", () => {
    it("includes freshness_ts from snapshot_date", () => {
      const results = adapter.search({
        cardName: "Venusaur",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "venusaur",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].freshness).toBe("2026-02-06");
    });

    it("freshness is non-null for all price-bearing reference candidates", () => {
      const results = adapter.search({
        cardName: "Venusaur",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "venusaur",
      });

      for (const r of results) {
        if (r.marketPrice !== null) {
          expect(r.freshness).not.toBeNull();
        }
      }
    });
  });

  describe("normalization parity", () => {
    it("002a/131 normalizes to 2a on both adapters (UDF-based)", () => {
      const result = db.prepare("SELECT normalize_cno('002a/131') as norm").get() as { norm: string };
      expect(result.norm).toBe("2a");
    });
  });
});
