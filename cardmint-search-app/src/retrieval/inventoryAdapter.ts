import type Database from "better-sqlite3";
import type { RetrievalCandidate, ParsedQuery, AdapterSearchResult } from "./types.js";

/**
 * Sanitize a query string for FTS5 MATCH.
 *
 * Strips characters that break FTS5 syntax: / ( ) * " ' : + - ^
 * Discards pure-numeric tokens (those go to collectorNo).
 * Wraps remaining tokens in double quotes for phrase search.
 * Returns null if nothing is left after sanitization.
 */
export function sanitizeFts5Query(raw: string): string | null {
  // Strip FTS5-breaking characters
  const cleaned = raw.replace(/[/()*"':+\-^]/g, " ");

  // Split, discard empty and pure-numeric tokens
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0 && !/^\d+$/.test(t));

  if (tokens.length === 0) return null;

  // Wrap in double quotes for phrase search
  return `"${tokens.join(" ")}"`;
}

interface InventoryRow {
  product_uid: string;
  card_name: string;
  set_name: string;
  collector_no: string;
  condition_bucket: string;
  market_price: number | null;
  cdn_image_url: string | null;
  total_quantity: number;
  evershop_sync_state: string | null;
  rarity: string | null;
  updated_at: number;
}

export class InventoryAdapter {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  search(parsed: ParsedQuery): AdapterSearchResult {
    // Path 1: Deterministic (set + collector_no both present)
    if (parsed.setName && parsed.collectorNo) {
      const results = this.deterministicSearch(parsed.setName, parsed.collectorNo);
      if (results.length > 0) return { candidates: results, retrievalPath: "deterministic" };
    }

    // Path 2: FTS5 (card name available)
    if (parsed.cardName) {
      const ftsResults = this.fts5Search(parsed.cardName);
      if (ftsResults.length > 0) return { candidates: ftsResults, retrievalPath: "fts" };

      // Path 3: LIKE fallback (FTS5 fails or returns empty)
      return { candidates: this.likeSearch(parsed.cardName), retrievalPath: "like" };
    }

    return { candidates: [], retrievalPath: "like" };
  }

  private deterministicSearch(setName: string, collectorNo: string): RetrievalCandidate[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT p.product_uid, p.card_name, p.set_name, p.collector_no,
        p.condition_bucket, p.market_price, p.cdn_image_url, p.total_quantity,
        p.evershop_sync_state, c.rarity, p.updated_at
      FROM products p
      LEFT JOIN cm_cards c ON p.cm_card_id = c.cm_card_id
      WHERE LOWER(p.set_name) = LOWER(?)
        AND normalize_cno(p.collector_no) = ?
        AND p.total_quantity > 0
      ORDER BY p.total_quantity DESC
      LIMIT 25
    `).all(setName, collectorNo) as InventoryRow[];

    return rows.map(toCandidate);
  }

  private fts5Search(cardName: string): RetrievalCandidate[] {
    const ftsQuery = sanitizeFts5Query(cardName);
    if (!ftsQuery) return [];

    try {
      const rows = this.db.prepare(`
        SELECT DISTINCT p.product_uid, p.card_name, p.set_name, p.collector_no,
          p.condition_bucket, p.market_price, p.cdn_image_url, p.total_quantity,
          p.evershop_sync_state, c.rarity, p.updated_at
        FROM cm_cards_fts f
        JOIN cm_cards c ON c.rowid = f.rowid
        JOIN products p ON p.cm_card_id = c.cm_card_id
        WHERE cm_cards_fts MATCH ?
          AND p.total_quantity > 0
        ORDER BY rank, p.total_quantity DESC
        LIMIT 25
      `).all(ftsQuery) as InventoryRow[];

      return rows.map(toCandidate);
    } catch {
      // FTS5 syntax error — fall through to LIKE
      return [];
    }
  }

  private likeSearch(cardName: string): RetrievalCandidate[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT p.product_uid, p.card_name, p.set_name, p.collector_no,
        p.condition_bucket, p.market_price, p.cdn_image_url, p.total_quantity,
        p.evershop_sync_state, c.rarity, p.updated_at
      FROM products p
      LEFT JOIN cm_cards c ON p.cm_card_id = c.cm_card_id
      WHERE LOWER(p.card_name) LIKE '%' || LOWER(?) || '%'
        AND p.total_quantity > 0
      ORDER BY p.total_quantity DESC
      LIMIT 25
    `).all(cardName) as InventoryRow[];

    return rows.map(toCandidate);
  }
}

function toCandidate(row: InventoryRow): RetrievalCandidate {
  return {
    id: row.product_uid,
    cardName: row.card_name,
    setName: row.set_name,
    collectorNo: row.collector_no,
    rarity: row.rarity,
    conditionBucket: row.condition_bucket,
    marketPrice: row.market_price,
    imageUrl: row.cdn_image_url,
    sourceLabel: "internal_truth",
    freshness: new Date(row.updated_at).toISOString(),
  };
}
