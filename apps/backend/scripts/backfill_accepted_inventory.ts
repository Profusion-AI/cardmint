/**
 * Backfill Accepted Inventory Script
 *
 * Backfills inventory (items/products rows) for accepted scans that are missing item_uid.
 * This script addresses the 174 scans that were accepted before the Nov 18 hard rule.
 *
 * Usage:
 *   npm run backfill:accepted              # Dry-run mode (default)
 *   npm run backfill:accepted --confirm    # Execute mode (actually creates inventory)
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { InventoryService } from "../src/services/inventory/inventoryService.js";
import { SKUCanonicalizer } from "../src/services/inventory/skuHelpers.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(currentDir, "../cardmint_dev.db");

const logger = pino({
  level: "info",
});

interface OrphanedScan {
  id: string;
  accepted_name: string | null;
  accepted_hp: number | null;
  accepted_collector_no: string | null;
  accepted_set_name: string | null;
  accepted_set_size: number | null;
  processed_image_path: string | null;
  raw_image_path: string | null;
  capture_uid: string | null;
  session_id: string | null;
}

async function backfillAcceptedInventory(dryRun: boolean = true) {
  logger.info({ dryRun, dbPath }, "Starting backfill of accepted inventory");

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // Initialize services
  const skuCanonicalizer = new SKUCanonicalizer(db, logger);
  const inventoryService = new InventoryService(db, skuCanonicalizer, logger);

  // Query orphaned scans (ACCEPTED but no item_uid)
  const orphanedScans = db
    .prepare(
      `SELECT
        id,
        accepted_name,
        accepted_hp,
        accepted_collector_no,
        accepted_set_name,
        accepted_set_size,
        processed_image_path,
        raw_image_path,
        capture_uid,
        session_id
      FROM scans
      WHERE status = 'ACCEPTED'
        AND item_uid IS NULL
      ORDER BY created_at ASC`
    )
    .all() as OrphanedScan[];

  logger.info({ count: orphanedScans.length }, "Found orphaned accepted scans");

  if (orphanedScans.length === 0) {
    logger.info("No orphaned scans found - all accepted scans have inventory");
    db.close();
    return;
  }

  let successCount = 0;
  let failureCount = 0;
  const failures: Array<{ scan_id: string; error: string }> = [];

  for (const scan of orphanedScans) {
    // Validate required fields
    if (!scan.accepted_name || !scan.accepted_collector_no || !scan.accepted_set_name) {
      const error = "Missing required truth core fields (name, collector_no, set_name)";
      logger.warn({ scan_id: scan.id, error }, "Skipping scan with incomplete truth core");
      failureCount++;
      failures.push({ scan_id: scan.id, error });
      continue;
    }

    if (!scan.processed_image_path) {
      const error = "Missing processed_image_path - cannot create inventory";
      logger.warn({ scan_id: scan.id, error }, "Skipping scan without processed image");
      failureCount++;
      failures.push({ scan_id: scan.id, error });
      continue;
    }

    // Build extracted fields from truth core
    const truthExtracted: Record<string, unknown> = {
      card_name: scan.accepted_name,
      hp_value: scan.accepted_hp,
      set_number: scan.accepted_collector_no,
      set_name: scan.accepted_set_name,
      // set_size stored separately in products table
    };

    const scanMetadata = {
      scan_id: scan.id,
      capture_session_id: scan.session_id || null,
      processed_image_path: scan.processed_image_path,
      raw_image_path: scan.raw_image_path || null,
      capture_uid: scan.capture_uid || null,
    };

    // Default condition to UNKNOWN for historical scans
    const condition = "UNKNOWN";

    if (dryRun) {
      logger.info(
        {
          scan_id: scan.id,
          truth_core: truthExtracted,
          condition,
          scanMetadata,
        },
        "[DRY-RUN] Would create inventory for scan"
      );
      successCount++;
    } else {
      try {
        const result = await inventoryService.dedupAttachOrMint(
          truthExtracted,
          scanMetadata,
          condition
        );

        // Update scan's item_uid to link inventory (Stage 2 guarantee)
        db.prepare(`UPDATE scans SET item_uid = ? WHERE id = ?`).run(result.item_uid, scan.id);

        logger.info(
          {
            scan_id: scan.id,
            item_uid: result.item_uid,
            product_uid: result.product_uid,
            action: result.action,
          },
          "Successfully created inventory and linked to scan"
        );
        successCount++;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error({ scan_id: scan.id, error: errorMessage }, "Failed to create inventory for scan");
        failureCount++;
        failures.push({ scan_id: scan.id, error: errorMessage });
      }
    }
  }

  // Summary
  logger.info(
    {
      dryRun,
      total: orphanedScans.length,
      success: successCount,
      failure: failureCount,
    },
    "Backfill complete"
  );

  if (failures.length > 0) {
    logger.warn({ failures }, "Failures encountered during backfill");
  }

  if (dryRun) {
    logger.info("Re-run with --confirm flag to execute (create inventory for real)");
  }

  db.close();
}

// Parse CLI args
const args = process.argv.slice(2);
const confirmFlag = args.includes("--confirm");
const dryRun = !confirmFlag;

if (dryRun) {
  console.log("⚠️  DRY-RUN MODE - No inventory will be created");
  console.log("⚠️  Use --confirm flag to execute\n");
}

backfillAcceptedInventory(dryRun)
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, "Backfill script failed");
    process.exit(1);
  });
