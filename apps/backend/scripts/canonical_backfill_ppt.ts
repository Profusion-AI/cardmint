#!/usr/bin/env tsx
/**
 * Canonical PPT ID Backfill
 *
 * Phase 2: Populate ppt_set_id / ppt_card_id onto scans and products.
 * - Prefers canonical_cards (PPT) for mapping
 * - Falls back to pricecharting-only (leaves PPT IDs null, canonical_source='pricecharting')
 * - Records metrics in canonical_backfill_runs
 *
 * Usage:
 *   npm --prefix apps/backend run canonical:backfill-ppt
 *
 * Notes:
 * - Idempotent: skips rows already populated with ppt_card_id
 * - Matching keys: set_name (case-insensitive) + collector_no (numeric portion of card_number)
 * - Scans fall back to associated product's set/collector when available
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/db/connection";

type CanonicalKey = {
  ppt_set_id: string;
  ppt_card_id: string;
};

type CanonicalMap = Map<string, Map<string, CanonicalKey>>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const nowUnix = () => Math.floor(Date.now() / 1000);

const normalizeSetName = (name: string | null | undefined): string | null => {
  if (!name) return null;
  return name.trim().toLowerCase();
};

const normalizeCollectorNo = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const primary = raw.split("/")[0]; // handle "102/102"
  // Strip leading zeros for numeric IDs only
  if (/^[0-9]+$/.test(primary)) {
    return String(Number.parseInt(primary, 10));
  }
  return primary.toLowerCase();
};

function buildCanonicalMap(db: Database.Database): CanonicalMap {
  const rows = db
    .prepare(
      `SELECT
         cs.name AS set_name,
         cs.ppt_set_id AS ppt_set_id,
         cc.ppt_card_id AS ppt_card_id,
         cc.card_number AS card_number
       FROM canonical_cards cc
       JOIN canonical_sets cs ON cs.tcg_player_id = cc.set_tcg_player_id`
    )
    .all() as { set_name: string; ppt_set_id: string; ppt_card_id: string; card_number: string | null }[];

  const map: CanonicalMap = new Map();
  for (const row of rows) {
    const setKey = normalizeSetName(row.set_name);
    const cardKey = normalizeCollectorNo(row.card_number);
    if (!setKey || !cardKey) continue;

    if (!map.has(setKey)) {
      map.set(setKey, new Map());
    }
    map.get(setKey)!.set(cardKey, {
      ppt_set_id: row.ppt_set_id,
      ppt_card_id: row.ppt_card_id,
    });
  }
  return map;
}

interface BackfillMetrics {
  total_scans: number;
  backfilled_ppt: number;
  backfilled_pc_only: number;
  unmapped: number;
  total_products: number;
  backfilled_products_ppt: number;
  backfilled_products_pc_only: number;
  products_unmapped: number;
}

const initMetrics = (): BackfillMetrics => ({
  total_scans: 0,
  backfilled_ppt: 0,
  backfilled_pc_only: 0,
  unmapped: 0,
  total_products: 0,
  backfilled_products_ppt: 0,
  backfilled_products_pc_only: 0,
  products_unmapped: 0,
});

function backfillProducts(db: Database.Database, canonicalMap: CanonicalMap, metrics: BackfillMetrics): void {
  const products = db
    .prepare(
      `SELECT product_uid, set_name, collector_no
       FROM products
       WHERE ppt_card_id IS NULL`
    )
    .all() as { product_uid: string; set_name: string | null; collector_no: string | null }[];

  const updateProduct = db.prepare(
    `UPDATE products
     SET ppt_set_id = @ppt_set_id,
         ppt_card_id = @ppt_card_id,
         canonical_source = @canonical_source,
         updated_at = @updated_at
     WHERE product_uid = @product_uid`
  );

  const markPcOnly = db.prepare(
    `UPDATE products
     SET canonical_source = 'pricecharting', updated_at = @updated_at
     WHERE product_uid = @product_uid`
  );

  const updatedAt = Date.now();

  metrics.total_products = products.length;

  db.transaction(() => {
    for (const product of products) {
      const setKey = normalizeSetName(product.set_name);
      const cardKey = normalizeCollectorNo(product.collector_no);

      if (setKey && cardKey) {
        const setMap = canonicalMap.get(setKey);
        const hit = setMap?.get(cardKey);
        if (hit) {
          updateProduct.run({
            product_uid: product.product_uid,
            ppt_set_id: hit.ppt_set_id,
            ppt_card_id: hit.ppt_card_id,
            canonical_source: "ppt",
            updated_at: updatedAt,
          });
          metrics.backfilled_products_ppt++;
          continue;
        }
      }

      // PriceCharting-only fallback
      markPcOnly.run({ product_uid: product.product_uid, updated_at: updatedAt });
      metrics.backfilled_products_pc_only++;
      if (!setKey || !cardKey) {
        metrics.products_unmapped++;
      }
    }
  })();
}

function backfillScans(db: Database.Database, canonicalMap: CanonicalMap, metrics: BackfillMetrics): void {
  const scans = db
    .prepare(
      `SELECT id, accepted_set_name, accepted_collector_no, product_uid
       FROM scans
       WHERE ppt_card_id IS NULL`
    )
    .all() as { id: string; accepted_set_name: string | null; accepted_collector_no: string | null; product_uid: string | null }[];

  const productLookup = db
    .prepare(`SELECT product_uid, set_name, collector_no FROM products`)
    .all() as { product_uid: string; set_name: string | null; collector_no: string | null }[];

  const productByUid = new Map<string, { set_name: string | null; collector_no: string | null }>();
  for (const p of productLookup) {
    productByUid.set(p.product_uid, { set_name: p.set_name, collector_no: p.collector_no });
  }

  const updateScan = db.prepare(
    `UPDATE scans
     SET ppt_set_id = @ppt_set_id,
         ppt_card_id = @ppt_card_id,
         canonical_source = @canonical_source,
         updated_at = @updated_at
     WHERE id = @id`
  );

  const markPcOnly = db.prepare(
    `UPDATE scans
     SET canonical_source = 'pricecharting', updated_at = @updated_at
     WHERE id = @id`
  );

  const updatedAt = Date.now();

  metrics.total_scans = scans.length;

  db.transaction(() => {
    for (const scan of scans) {
      let setName = scan.accepted_set_name;
      let collectorNo = scan.accepted_collector_no;

      if ((!setName || !collectorNo) && scan.product_uid) {
        const product = productByUid.get(scan.product_uid);
        if (product) {
          setName = setName ?? product.set_name;
          collectorNo = collectorNo ?? product.collector_no;
        }
      }

      const setKey = normalizeSetName(setName);
      const cardKey = normalizeCollectorNo(collectorNo);

      if (setKey && cardKey) {
        const setMap = canonicalMap.get(setKey);
        const hit = setMap?.get(cardKey);
        if (hit) {
          updateScan.run({
            id: scan.id,
            ppt_set_id: hit.ppt_set_id,
            ppt_card_id: hit.ppt_card_id,
            canonical_source: "ppt",
            updated_at: updatedAt,
          });
          metrics.backfilled_ppt++;
          continue;
        }
      }

      // PriceCharting-only fallback
      markPcOnly.run({ id: scan.id, updated_at: updatedAt });
      metrics.backfilled_pc_only++;
      if (!setKey || !cardKey) {
        metrics.unmapped++;
      }
    }
  })();
}

function recordRun(db: Database.Database, metrics: BackfillMetrics, status: "success" | "failed", notes?: string) {
  const stmt = db.prepare(
    `INSERT INTO canonical_backfill_runs (
      started_at, finished_at,
      total_scans, backfilled_ppt, backfilled_pc_only, unmapped,
      total_products, backfilled_products_ppt, backfilled_products_pc_only, products_unmapped,
      status, run_type, notes
    ) VALUES (
      @started_at, @finished_at,
      @total_scans, @backfilled_ppt, @backfilled_pc_only, @unmapped,
      @total_products, @backfilled_products_ppt, @backfilled_products_pc_only, @products_unmapped,
      @status, @run_type, @notes
    )`
  );

  const nowIso = new Date().toISOString();
  stmt.run({
    started_at: nowIso,
    finished_at: nowIso,
    total_scans: metrics.total_scans,
    backfilled_ppt: metrics.backfilled_ppt,
    backfilled_pc_only: metrics.backfilled_pc_only,
    unmapped: metrics.unmapped,
    total_products: metrics.total_products,
    backfilled_products_ppt: metrics.backfilled_products_ppt,
    backfilled_products_pc_only: metrics.backfilled_products_pc_only,
    products_unmapped: metrics.products_unmapped,
    status,
    run_type: "scans+products",
    notes: notes ?? null,
  });
}

async function main() {
  const db = openDatabase();
  const metrics = initMetrics();

  const canonicalMap = buildCanonicalMap(db);
  if (canonicalMap.size === 0) {
    console.error("canonical_backfill_ppt: canonical catalog is empty. Run build first.");
    process.exit(1);
  }

  try {
    backfillProducts(db, canonicalMap, metrics);
    backfillScans(db, canonicalMap, metrics);
    recordRun(db, metrics, "success");
    console.log(
      JSON.stringify(
        {
          status: "success",
          metrics,
          timestamp: nowUnix(),
        },
        null,
        2
      )
    );
  } catch (error) {
    recordRun(db, metrics, "failed", error instanceof Error ? error.message : String(error));
    console.error("canonical_backfill_ppt failed:", error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
