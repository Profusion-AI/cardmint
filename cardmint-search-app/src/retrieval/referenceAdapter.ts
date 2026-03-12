import type Database from "better-sqlite3";
import type { RetrievalCandidate, ParsedQuery } from "./types.js";

interface TcgRow {
  tcgplayer_id: number | null;
  product_name: string;
  set_name: string;
  card_number: string | null;
  rarity: string | null;
  condition_bucket: string;
  market_price_cents: number | null;
  photo_url: string | null;
  freshness_ts: string | null;
}

const COND_RANK: Record<string, number> = {
  NM: 1, LP: 2, MP: 3, HP: 4, DMG: 5, OTHER: 6,
};

function pickRepresentative(group: TcgRow[]): RetrievalCandidate {
  const sorted = [...group].sort((a, b) =>
    (COND_RANK[a.condition_bucket] ?? 7) - (COND_RANK[b.condition_bucket] ?? 7)
  );
  const meta = sorted[0]; // NM-preferred for photo/id
  const lpRow = group.find(r => r.condition_bucket === "LP");
  const nmRow = group.find(r => r.condition_bucket === "NM");
  const priceCents = lpRow?.market_price_cents ?? nmRow?.market_price_cents ?? null;

  return {
    id: String(meta.tcgplayer_id ?? meta.product_name),
    cardName: meta.product_name,
    setName: meta.set_name,
    collectorNo: meta.card_number ?? null,
    rarity: meta.rarity ?? null,
    conditionBucket: "UNK",
    marketPrice: priceCents != null ? priceCents / 100.0 : null,
    imageUrl: meta.photo_url ?? null,
    sourceLabel: "reference_aggregate",
    freshness: meta.freshness_ts ?? null,
  };
}

function groupAndDedup(rows: TcgRow[]): RetrievalCandidate[] {
  const groups = new Map<string, TcgRow[]>();
  for (const row of rows) {
    const key = `${row.product_name}||${row.set_name}||${row.card_number ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return Array.from(groups.values()).map(pickRepresentative);
}

export class ReferenceAdapter {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private resolveSnapshotId(): number | null {
    try {
      const row = this.db.prepare(
        `SELECT MAX(id) AS id FROM tcg_snapshots WHERE status = 'complete'`
      ).get() as { id: number | null } | undefined;
      return row?.id ?? null;
    } catch {
      return null;
    }
  }

  search(parsed: ParsedQuery): RetrievalCandidate[] {
    const snapshotId = this.resolveSnapshotId();
    if (snapshotId === null) return [];

    // Path 1: Deterministic (set + collector_no both present)
    if (parsed.setName && parsed.collectorNo) {
      const results = this.deterministicSearch(snapshotId, parsed.setName, parsed.collectorNo);
      if (results.length > 0) return results;
    }

    // Path 2: LIKE (card name), with optional set constraint
    if (parsed.cardName) {
      return this.likeSearch(snapshotId, parsed.cardName, parsed.setName ?? null);
    }

    return [];
  }

  private deterministicSearch(snapshotId: number, setName: string, collectorNo: string): RetrievalCandidate[] {
    const rows = this.db.prepare(`
      SELECT tcgplayer_id, product_name, set_name, card_number, rarity,
             condition_bucket, market_price_cents, photo_url,
             (SELECT snapshot_date FROM tcg_snapshots WHERE id = ?) AS freshness_ts
      FROM tcg_rows
      WHERE snapshot_id = ?
        AND normalize_cno(card_number) = ?
        AND LOWER(set_name) = LOWER(?)
      ORDER BY CASE condition_bucket
        WHEN 'NM' THEN 1 WHEN 'LP' THEN 2 WHEN 'MP' THEN 3
        WHEN 'HP' THEN 4 WHEN 'DMG' THEN 5 ELSE 6 END,
        market_price_cents DESC NULLS LAST
    `).all(snapshotId, snapshotId, collectorNo, setName) as TcgRow[];

    return groupAndDedup(rows);
  }

  private likeSearch(snapshotId: number, cardName: string, setName: string | null): RetrievalCandidate[] {
    let sql = `
      SELECT tcgplayer_id, product_name, set_name, card_number, rarity,
             condition_bucket, market_price_cents, photo_url,
             (SELECT snapshot_date FROM tcg_snapshots WHERE id = ?) AS freshness_ts
      FROM tcg_rows
      WHERE snapshot_id = ?
        AND LOWER(product_name) LIKE '%' || LOWER(?) || '%'
    `;
    const params: unknown[] = [snapshotId, snapshotId, cardName];

    if (setName) {
      sql += `  AND LOWER(set_name) = LOWER(?)\n`;
      params.push(setName);
    }

    sql += `
      ORDER BY CASE condition_bucket
        WHEN 'NM' THEN 1 WHEN 'LP' THEN 2 WHEN 'MP' THEN 3
        WHEN 'HP' THEN 4 WHEN 'DMG' THEN 5 ELSE 6 END,
        market_price_cents DESC NULLS LAST
      LIMIT 200
    `;

    const rows = this.db.prepare(sql).all(...params) as TcgRow[];
    const candidates = groupAndDedup(rows);
    return candidates.slice(0, 25);
  }
}
