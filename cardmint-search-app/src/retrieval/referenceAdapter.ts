import type Database from "better-sqlite3";
import type { RetrievalCandidate, ParsedQuery } from "./types.js";

interface ReferenceRow {
  product_id: number;
  card_name: string;
  set_name: string;
  collector_no_raw: string | null;
  rarity: string | null;
  sub_type_name: string;
  market_price: number | null;
  image_url: string | null;
  freshness_ts: string | null;
}

export class ReferenceAdapter {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  search(parsed: ParsedQuery): RetrievalCandidate[] {
    // Path 1: Deterministic (set + collector_no both present)
    if (parsed.setName && parsed.collectorNo) {
      const results = this.deterministicSearch(parsed.setName, parsed.collectorNo);
      if (results.length > 0) return results;
    }

    // Path 2: LIKE (card name)
    if (parsed.cardName) {
      return this.likeSearch(parsed.cardName);
    }

    return [];
  }

  private deterministicSearch(setName: string, collectorNo: string): RetrievalCandidate[] {
    const rows = this.db.prepare(`
      SELECT product_id, card_name, set_name, collector_no_raw, rarity,
        sub_type_name, market_price, image_url, freshness_ts
      FROM tcg_search_corpus
      WHERE run_id = (SELECT MAX(run_id) FROM tcg_search_corpus)
        AND normalize_cno(collector_no_raw) = ?
        AND LOWER(set_name) = LOWER(?)
      ORDER BY market_price DESC NULLS LAST
      LIMIT 25
    `).all(collectorNo, setName) as ReferenceRow[];

    return rows.map(toCandidate);
  }

  private likeSearch(cardName: string): RetrievalCandidate[] {
    const rows = this.db.prepare(`
      SELECT product_id, card_name, set_name, collector_no_raw, rarity,
        sub_type_name, market_price, image_url, freshness_ts
      FROM tcg_search_corpus
      WHERE run_id = (SELECT MAX(run_id) FROM tcg_search_corpus)
        AND LOWER(card_name) LIKE '%' || LOWER(?) || '%'
      ORDER BY market_price DESC NULLS LAST
      LIMIT 25
    `).all(cardName) as ReferenceRow[];

    return rows.map(toCandidate);
  }
}

function toCandidate(row: ReferenceRow): RetrievalCandidate {
  return {
    id: String(row.product_id),
    cardName: row.card_name,
    setName: row.set_name,
    collectorNo: row.collector_no_raw,
    rarity: row.rarity,
    conditionBucket: null,
    marketPrice: row.market_price,
    imageUrl: row.image_url,
    sourceLabel: "reference_aggregate",
    freshness: row.freshness_ts ?? null,
  };
}
