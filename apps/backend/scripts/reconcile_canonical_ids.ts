#!/usr/bin/env tsx

import Database from "better-sqlite3";
import { pino } from "pino";
import { runtimeConfig } from "../src/config";
import { randomUUID } from "crypto";
import path from "node:path";
import fs from "node:fs";

const CONFIDENCE_THRESHOLD = 0.6;

interface Product {
  product_uid: string;
  card_name: string;
  set_name: string;
  collector_no: string | null;
  cm_card_id: string | null;
  ppt_card_id: string | null;
}

interface Scan {
  id: string;
  accepted_name: string | null;
  accepted_set_name: string | null;
  accepted_collector_no: string | null;
  cm_card_id: string | null;
  ppt_card_id: string | null;
  extracted_json: string | null;
}

interface CanonicalCard {
  ppt_card_id: string;
  name: string;
  card_number: string | null;
  set_name: string;
  set_tcg_player_id: string;
}

interface ReconcileResult {
  runId: string;
  processed: number;
  mapped: number;
  unmapped: number;
  skipped: number;
  duration: number;
}

interface ReconcileOptions {
  dryRun: boolean;
  limit: number;
  entity: "scans" | "products" | "all";
}

const logger = pino({
  level: "info",
});

function is24CharHex(value: string | null): boolean {
  if (!value) return false;
  return /^[0-9a-f]{24}$/i.test(value);
}

function normalizeForMatch(value: string | null): string {
  if (!value) return "";
  return value.trim().toLowerCase();
}

function normalizeCardNumber(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const primary = trimmed.split("/")[0];
  if (/^[0-9]+$/.test(primary)) {
    return String(Number.parseInt(primary, 10));
  }
  return primary.toLowerCase();
}

function scoreMatch(
  entity: { card_name: string; set_name: string; card_number: string | null },
  candidate: CanonicalCard
): number {
  let score = 0;

  const entityName = normalizeForMatch(entity.card_name);
  const candidateName = normalizeForMatch(candidate.name);
  if (entityName && candidateName && candidateName.includes(entityName)) {
    score += 0.4;
  }

  const entitySet = normalizeForMatch(entity.set_name);
  const candidateSet = normalizeForMatch(candidate.set_name);
  if (entitySet && candidateSet && candidateSet === entitySet) {
    score += 0.4;
  }

  const entityNum = normalizeCardNumber(entity.card_number);
  const candidateNum = normalizeCardNumber(candidate.card_number);
  if (entityNum && candidateNum && entityNum === candidateNum) {
    score += 0.2;
  }

  return score;
}

function createRun(
  db: Database.Database,
  runId: string,
  dryRun: boolean
): void {
  if (dryRun) return;

  db.prepare(
    `INSERT INTO canonical_backfill_runs (id, started_at, status, items_processed, items_mapped, items_unmapped, details)
     VALUES (?, ?, 'running', 0, 0, 0, ?)`
  ).run(runId, Date.now(), JSON.stringify({ entity: "products_first" }));
}

function updateRun(
  db: Database.Database,
  runId: string,
  result: ReconcileResult,
  dryRun: boolean
): void {
  if (dryRun) return;

  db.prepare(
    `UPDATE canonical_backfill_runs
     SET completed_at = ?, status = 'completed', items_processed = ?, items_mapped = ?, items_unmapped = ?
     WHERE id = ?`
  ).run(Date.now(), result.processed, result.mapped, result.unmapped, runId);
}

function logEvent(
  db: Database.Database,
  runId: string,
  entityType: "product" | "scan",
  entityId: string,
  eventType: "mapped" | "unmapped" | "skipped",
  details: Record<string, unknown>,
  dryRun: boolean
): void {
  if (dryRun) {
    logger.info({ entityType, entityId, eventType, details }, "DRY-RUN event");
    return;
  }

  db.prepare(
    `INSERT INTO canonical_reconciliation_events (id, run_id, entity_type, entity_id, event_type, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    runId,
    entityType,
    entityId,
    eventType,
    JSON.stringify(details),
    Date.now()
  );
}

function reconcileProducts(
  db: Database.Database,
  runId: string,
  limit: number,
  dryRun: boolean
): { mapped: number; unmapped: number; skipped: number; processed: number } {
  const products = db
    .prepare(
      `SELECT product_uid, card_name, set_name, collector_no, cm_card_id, ppt_card_id
       FROM products
       WHERE ppt_card_id IS NULL
       LIMIT ?`
    )
    .all(limit) as Product[];

  logger.info({ count: products.length }, "Products needing mapping");

  let mapped = 0;
  let unmapped = 0;
  let skipped = 0;

  const updateProduct = db.prepare(
    `UPDATE products SET ppt_card_id = ?, ppt_set_id = ?, canonical_source = 'pricecharting' WHERE product_uid = ?`
  );

  const lookupByPptId = db.prepare(
    `SELECT cc.ppt_card_id, cc.name, cc.card_number, cs.name as set_name, cc.set_tcg_player_id
     FROM canonical_cards cc
     JOIN canonical_sets cs ON cs.tcg_player_id = cc.set_tcg_player_id
     WHERE cc.ppt_card_id = ?`
  );

  const searchByFields = db.prepare(
    `SELECT cc.ppt_card_id, cc.name, cc.card_number, cs.name as set_name, cc.set_tcg_player_id
     FROM canonical_cards cc
     JOIN canonical_sets cs ON cs.tcg_player_id = cc.set_tcg_player_id
     WHERE LOWER(cs.name) = LOWER(?)
     AND LOWER(cc.name) LIKE ?
     LIMIT 10`
  );

  for (const product of products) {
    if (!product.card_name || !product.set_name) {
      logEvent(db, runId, "product", product.product_uid, "skipped", {
        reason: "missing_required_fields",
        card_name: product.card_name,
        set_name: product.set_name,
      }, dryRun);
      skipped++;
      continue;
    }

    let candidate: CanonicalCard | null = null;
    let matchMethod = "";

    if (is24CharHex(product.cm_card_id)) {
      const directMatch = lookupByPptId.get(product.cm_card_id) as CanonicalCard | undefined;
      if (directMatch) {
        candidate = directMatch;
        matchMethod = "direct_cm_card_id";
      }
    }

    if (!candidate) {
      const candidates = searchByFields.all(
        product.set_name,
        `%${product.card_name}%`
      ) as CanonicalCard[];

      if (candidates.length > 0) {
        let bestCandidate: CanonicalCard | null = null;
        let bestScore = 0;

        for (const c of candidates) {
          const score = scoreMatch(
            {
              card_name: product.card_name,
              set_name: product.set_name,
              card_number: product.collector_no,
            },
            c
          );
          if (score > bestScore) {
            bestScore = score;
            bestCandidate = c;
          }
        }

        if (bestCandidate && bestScore >= CONFIDENCE_THRESHOLD) {
          candidate = bestCandidate;
          matchMethod = `fts_search_score_${bestScore.toFixed(2)}`;
        }
      }
    }

    if (candidate) {
      if (!dryRun) {
        updateProduct.run(
          candidate.ppt_card_id,
          candidate.set_tcg_player_id,
          product.product_uid
        );
      }
      logEvent(db, runId, "product", product.product_uid, "mapped", {
        ppt_card_id: candidate.ppt_card_id,
        ppt_set_id: candidate.set_tcg_player_id,
        match_method: matchMethod,
        matched_name: candidate.name,
        matched_set: candidate.set_name,
      }, dryRun);
      mapped++;
    } else {
      logEvent(db, runId, "product", product.product_uid, "unmapped", {
        reason: "no_confident_match",
        card_name: product.card_name,
        set_name: product.set_name,
        collector_no: product.collector_no,
        cm_card_id: product.cm_card_id,
      }, dryRun);
      unmapped++;
    }
  }

  return { mapped, unmapped, skipped, processed: products.length };
}

function reconcileScans(
  db: Database.Database,
  runId: string,
  limit: number,
  dryRun: boolean
): { mapped: number; unmapped: number; skipped: number; processed: number } {
  const scans = db
    .prepare(
      `SELECT id, accepted_name, accepted_set_name, accepted_collector_no, cm_card_id, ppt_card_id, extracted_json
       FROM scans
       WHERE ppt_card_id IS NULL
       LIMIT ?`
    )
    .all(limit) as Scan[];

  logger.info({ count: scans.length }, "Scans needing mapping");

  let mapped = 0;
  let unmapped = 0;
  let skipped = 0;

  const updateScan = db.prepare(
    `UPDATE scans SET ppt_card_id = ?, ppt_set_id = ?, canonical_source = 'pricecharting' WHERE id = ?`
  );

  const lookupByPptId = db.prepare(
    `SELECT cc.ppt_card_id, cc.name, cc.card_number, cs.name as set_name, cc.set_tcg_player_id
     FROM canonical_cards cc
     JOIN canonical_sets cs ON cs.tcg_player_id = cc.set_tcg_player_id
     WHERE cc.ppt_card_id = ?`
  );

  const searchByFields = db.prepare(
    `SELECT cc.ppt_card_id, cc.name, cc.card_number, cs.name as set_name, cc.set_tcg_player_id
     FROM canonical_cards cc
     JOIN canonical_sets cs ON cs.tcg_player_id = cc.set_tcg_player_id
     WHERE LOWER(cs.name) = LOWER(?)
     AND LOWER(cc.name) LIKE ?
     LIMIT 10`
  );

  for (const scan of scans) {
    let cardName = scan.accepted_name;
    let setName = scan.accepted_set_name;
    let cardNumber = scan.accepted_collector_no;

    if (scan.extracted_json && (!cardName || !setName)) {
      try {
        const parsed = JSON.parse(scan.extracted_json);
        cardName = cardName || parsed.card_name;
        setName = setName || parsed.set_name;
        cardNumber = cardNumber || parsed.set_number;
      } catch {
        // Ignore parse errors
      }
    }

    if (!cardName || !setName) {
      logEvent(db, runId, "scan", scan.id, "skipped", {
        reason: "missing_required_fields",
        card_name: cardName,
        set_name: setName,
      }, dryRun);
      skipped++;
      continue;
    }

    let candidate: CanonicalCard | null = null;
    let matchMethod = "";

    if (is24CharHex(scan.cm_card_id)) {
      const directMatch = lookupByPptId.get(scan.cm_card_id) as CanonicalCard | undefined;
      if (directMatch) {
        candidate = directMatch;
        matchMethod = "direct_cm_card_id";
      }
    }

    if (!candidate) {
      const candidates = searchByFields.all(
        setName,
        `%${cardName}%`
      ) as CanonicalCard[];

      if (candidates.length > 0) {
        let bestCandidate: CanonicalCard | null = null;
        let bestScore = 0;

        for (const c of candidates) {
          const score = scoreMatch(
            { card_name: cardName, set_name: setName, card_number: cardNumber },
            c
          );
          if (score > bestScore) {
            bestScore = score;
            bestCandidate = c;
          }
        }

        if (bestCandidate && bestScore >= CONFIDENCE_THRESHOLD) {
          candidate = bestCandidate;
          matchMethod = `fts_search_score_${bestScore.toFixed(2)}`;
        }
      }
    }

    if (candidate) {
      if (!dryRun) {
        updateScan.run(
          candidate.ppt_card_id,
          candidate.set_tcg_player_id,
          scan.id
        );
      }
      logEvent(db, runId, "scan", scan.id, "mapped", {
        ppt_card_id: candidate.ppt_card_id,
        ppt_set_id: candidate.set_tcg_player_id,
        match_method: matchMethod,
        matched_name: candidate.name,
        matched_set: candidate.set_name,
      }, dryRun);
      mapped++;
    } else {
      logEvent(db, runId, "scan", scan.id, "unmapped", {
        reason: "no_confident_match",
        card_name: cardName,
        set_name: setName,
        card_number: cardNumber,
        cm_card_id: scan.cm_card_id,
      }, dryRun);
      unmapped++;
    }
  }

  return { mapped, unmapped, skipped, processed: scans.length };
}

async function main() {
  const args = process.argv.slice(2);

  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 100;

  const entityArg = args.find((arg) => arg.startsWith("--entity="));
  const entity = (entityArg?.split("=")[1] || "products") as "scans" | "products" | "all";

  const dryRun = !args.includes("--confirm");

  const options: ReconcileOptions = { dryRun, limit, entity };

  logger.info(options, "Starting canonical ID reconciliation");

  if (dryRun) {
    logger.warn("DRY-RUN mode: no database changes will be made. Use --confirm to execute.");
  }

  const dbPath = path.resolve(process.cwd(), runtimeConfig.sqlitePath);
  logger.info({ dbPath }, "Connecting to database");

  const db = Database(dbPath);

  const runId = randomUUID();
  const startTime = Date.now();

  createRun(db, runId, dryRun);

  const result: ReconcileResult = {
    runId,
    processed: 0,
    mapped: 0,
    unmapped: 0,
    skipped: 0,
    duration: 0,
  };

  if (entity === "products" || entity === "all") {
    const productResult = reconcileProducts(db, runId, limit, dryRun);
    result.processed += productResult.processed;
    result.mapped += productResult.mapped;
    result.unmapped += productResult.unmapped;
    result.skipped += productResult.skipped;
  }

  if (entity === "scans" || entity === "all") {
    const remainingLimit = entity === "all" ? Math.max(0, limit - result.processed) : limit;
    if (remainingLimit > 0) {
      const scanResult = reconcileScans(db, runId, remainingLimit, dryRun);
      result.processed += scanResult.processed;
      result.mapped += scanResult.mapped;
      result.unmapped += scanResult.unmapped;
      result.skipped += scanResult.skipped;
    }
  }

  result.duration = Date.now() - startTime;

  updateRun(db, runId, result, dryRun);

  logger.info(
    {
      runId: result.runId,
      processed: result.processed,
      mapped: result.mapped,
      unmapped: result.unmapped,
      skipped: result.skipped,
      duration_ms: result.duration,
      dryRun,
    },
    "Reconciliation complete"
  );

  const resultsDir = path.resolve(process.cwd(), "results");
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  const reportPath = path.join(
    resultsDir,
    `reconcile_${dryRun ? "dryrun" : "run"}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
  logger.info({ reportPath }, "Results written to file");

  db.close();
}

main().catch((err) => {
  logger.error(err, "Reconciliation failed");
  process.exit(1);
});
