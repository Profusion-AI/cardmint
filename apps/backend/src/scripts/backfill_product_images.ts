/**
 * Backfill product_images for existing products
 *
 * Usage:
 *   tsx apps/backend/src/scripts/backfill_product_images.ts [--db path/to/db] [--dry-run]
 *
 * This script populates the product_images table from existing products and scans.
 * For each product with cdn_image_url, it creates a product_images row with orientation='front'.
 *
 * Strategy:
 * 1. Find all products with cdn_image_url (front images from existing scans)
 * 2. For each product, find the corresponding scan to get raw_path and processed_path
 * 3. Insert into product_images with orientation='front'
 * 4. Update products.cdn_back_image_url to NULL (no back images exist pre-migration)
 * 5. Report on products missing images
 *
 * Options:
 *   --db         Path to SQLite database (default: apps/backend/cardmint_dev.db)
 *   --dry-run    Preview changes without committing to database
 */

import Database from "better-sqlite3";

interface Product {
  product_uid: string;
  cdn_image_url: string | null;
  listing_image_path: string | null;
}

interface Scan {
  id: string;
  raw_image_path: string | null;
  processed_image_path: string | null;
}

function parseArgs(): { dbPath: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let dbPath = "apps/backend/cardmint_dev.db";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && i + 1 < args.length) {
      dbPath = args[i + 1];
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  return { dbPath, dryRun };
}

function main() {
  const { dbPath, dryRun } = parseArgs();

  console.log("=== Product Images Backfill ===");
  console.log(`Database: ${dbPath}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "COMMIT"}`);
  console.log();

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  try {
    // Fetch all products (both with and without images for reporting)
    const allProducts = db
      .prepare(
        `SELECT product_uid, cdn_image_url, listing_image_path
         FROM products`
      )
      .all() as Product[];

    const productsWithImages = allProducts.filter((p) => p.cdn_image_url);
    const productsWithoutImages = allProducts.filter((p) => !p.cdn_image_url);

    console.log(`Found ${allProducts.length} total products`);
    console.log(`  ${productsWithImages.length} with front images`);
    console.log(`  ${productsWithoutImages.length} without images (will be skipped)`);
    console.log();

    if (productsWithImages.length === 0) {
      console.log("✓ No products with images to backfill");
      return;
    }

    // Check if product_images table exists (migration ran)
    const tableExists = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name='product_images'`
      )
      .get();

    if (!tableExists) {
      console.error("❌ product_images table does not exist");
      console.error("   Run migration first: 20251117_production_inventory_readiness.sql");
      process.exit(1);
    }

    console.log("Generating product_images records...");
    console.log();

    const inserts: {
      product_uid: string;
      cdn_url: string;
      raw_path: string | null;
      processed_path: string | null;
      source_scan_id: string | null;
    }[] = [];
    const errors: { product_uid: string; error: string }[] = [];

    for (const product of productsWithImages) {
      try {
        // Find the most recent scan for this product that has an image
        const scan = db
          .prepare(
            `SELECT id, raw_image_path, processed_image_path
             FROM scans
             WHERE product_sku IN (
               SELECT product_sku FROM products WHERE product_uid = ?
             )
               AND processed_image_path IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 1`
          )
          .get(product.product_uid) as Scan | undefined;

        inserts.push({
          product_uid: product.product_uid,
          cdn_url: product.cdn_image_url!,
          raw_path: scan?.raw_image_path || null,
          processed_path: scan?.processed_image_path || product.listing_image_path,
          source_scan_id: scan?.id || null,
        });
      } catch (error) {
        errors.push({
          product_uid: product.product_uid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Display sample of generated records
    console.log("Sample product_images records (first 10):");
    inserts.slice(0, 10).forEach((insert, idx) => {
      console.log(
        `  ${idx + 1}. ${insert.product_uid} → ${insert.cdn_url} (scan: ${insert.source_scan_id || "unknown"})`
      );
    });

    if (errors.length > 0) {
      console.log();
      console.log(`⚠ ${errors.length} errors encountered:`);
      errors.forEach((err) => {
        console.log(`  - ${err.product_uid}: ${err.error}`);
      });
    }

    console.log();
    console.log(`Summary:`);
    console.log(`  Total products with images: ${productsWithImages.length}`);
    console.log(`  Records to insert: ${inserts.length}`);
    console.log(`  Errors: ${errors.length}`);

    if (dryRun) {
      console.log();
      console.log("✓ Dry run complete - no changes written to database");
      console.log("  Run without --dry-run to commit changes");
      return;
    }

    // Apply inserts
    console.log();
    console.log("Writing product_images to database...");

    const insertStmt = db.prepare(
      `INSERT INTO product_images (
        product_uid, orientation, raw_path, processed_path, cdn_url,
        published_at, source_scan_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const now = Math.floor(Date.now() / 1000);
    let insertCount = 0;

    db.transaction(() => {
      for (const insert of inserts) {
        insertStmt.run(
          insert.product_uid,
          "front", // orientation
          insert.raw_path,
          insert.processed_path,
          insert.cdn_url,
          now, // published_at (assume already published)
          insert.source_scan_id,
          now,
          now
        );
        insertCount++;
      }
    })();

    console.log(`✓ Inserted ${insertCount} product_images records`);

    // Verify results
    const frontImageCount = db
      .prepare(
        `SELECT COUNT(*) as count
         FROM product_images
         WHERE orientation = 'front'`
      )
      .get() as { count: number };

    const backImageCount = db
      .prepare(
        `SELECT COUNT(*) as count
         FROM product_images
         WHERE orientation = 'back'`
      )
      .get() as { count: number };

    console.log();
    console.log("Verification:");
    console.log(`  Front images: ${frontImageCount.count}`);
    console.log(`  Back images: ${backImageCount.count}`);
    console.log(`  Expected front: ${inserts.length}`);
    console.log(`  Expected back: 0 (no back images exist pre-migration)`);

    if (frontImageCount.count === inserts.length && backImageCount.count === 0) {
      console.log();
      console.log("✓ Backfill complete - all front images populated!");
      console.log();
      console.log("⚠ Next steps:");
      console.log("  1. Capture back images for all products before staging_ready promotion");
      console.log("  2. Update acceptance.sql gates will enforce front+back requirement");
      console.log("  3. UI will prompt for back image capture after Accept");
    } else {
      console.log();
      console.log("⚠ Warning: Verification mismatch");
      console.log("  Re-run this script or investigate database state");
    }
  } catch (error) {
    console.error("❌ Backfill failed:");
    console.error(error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
