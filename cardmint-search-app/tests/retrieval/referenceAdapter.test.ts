import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type Database from "better-sqlite3";
import { ReferenceAdapter } from "../../src/retrieval/referenceAdapter.js";
import { seedReferenceDb } from "../fixtures/seedReference.js";

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

    it("normalizes collector_no via UDF (not pre-computed column)", () => {
      // collector_no_raw "004/102" normalizes to "4"
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

    it("only returns rows from latest run_id", () => {
      // Mewtwo exists only in older run "20260205-000000"
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

    it("finds multiple Charizards across sets", () => {
      const results = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });

      expect(results.length).toBe(3); // Base Set + Evolutions + Scarlet & Violet (Charizard ex)
    });

    it("finds Pikachu including promo (null collector_no)", () => {
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

  describe("sourceLabel contract", () => {
    it("always returns reference_aggregate for all candidates", () => {
      const results = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });

      expect(results.every((r) => r.sourceLabel === "reference_aggregate")).toBe(true);
    });
  });

  describe("freshness contract", () => {
    it("includes freshness_ts from DB on reference candidates", () => {
      const results = adapter.search({
        cardName: "Charizard",
        setName: null,
        collectorNo: null,
        variantHint: null,
        raw: "charizard",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.freshness === "2026-02-06T17:17:00Z")).toBe(true);
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
      // We can test the UDF directly on the reference DB
      const result = db.prepare("SELECT normalize_cno('002a/131') as norm").get() as { norm: string };
      expect(result.norm).toBe("2a");
    });
  });
});
