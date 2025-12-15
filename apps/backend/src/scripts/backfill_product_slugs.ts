/**
 * Backfill product_slug for existing products
 *
 * Usage:
 *   tsx apps/backend/src/scripts/backfill_product_slugs.ts [--db path/to/db] [--dry-run]
 *
 * This script generates deterministic slugs for all products where product_slug IS NULL.
 * Format: {slugified-card-name}-{slugified-set-name}-{card-number}-{last-8-chars-of-uid}
 *
 * Options:
 *   --db         Path to SQLite database (default: apps/backend/cardmint_dev.db)
 *   --dry-run    Preview changes without committing to database
 */

import Database from "better-sqlite3";
import { generateProductSlug } from "../services/slugGenerator";

interface Product {
  product_uid: string;
  card_name: string;
  set_name: string;
  collector_no: string;
  product_slug: string | null;
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

  console.log("=== Product Slug Backfill ===");
  console.log(`Database: ${dbPath}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "COMMIT"}`);
  console.log();

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  try {
    // Fetch products with missing slugs
    const productsWithoutSlugs = db
      .prepare(
        `SELECT product_uid, card_name, set_name, collector_no, product_slug
         FROM products
         WHERE product_slug IS NULL`
      )
      .all() as Product[];

    console.log(`Found ${productsWithoutSlugs.length} products without slugs`);

    if (productsWithoutSlugs.length === 0) {
      console.log("✓ All products already have slugs!");
      return;
    }

    console.log();
    console.log("Generating slugs...");

    const updates: { product_uid: string; old_slug: string | null; new_slug: string }[] = [];
    const errors: { product_uid: string; error: string }[] = [];

    for (const product of productsWithoutSlugs) {
      try {
        const slug = generateProductSlug(
          product.card_name,
          product.set_name,
          product.collector_no,
          product.product_uid
        );

        updates.push({
          product_uid: product.product_uid,
          old_slug: product.product_slug,
          new_slug: slug,
        });
      } catch (error) {
        errors.push({
          product_uid: product.product_uid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Display sample of generated slugs
    console.log();
    console.log("Sample slugs (first 10):");
    updates.slice(0, 10).forEach((update, idx) => {
      console.log(`  ${idx + 1}. ${update.new_slug} (${update.product_uid})`);
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
    console.log(`  Total products: ${productsWithoutSlugs.length}`);
    console.log(`  Slugs generated: ${updates.length}`);
    console.log(`  Errors: ${errors.length}`);

    if (dryRun) {
      console.log();
      console.log("✓ Dry run complete - no changes written to database");
      console.log("  Run without --dry-run to commit changes");
      return;
    }

    // Apply updates
    console.log();
    console.log("Writing slugs to database...");

    const updateStmt = db.prepare(
      `UPDATE products
       SET product_slug = ?, updated_at = ?
       WHERE product_uid = ?`
    );

    const now = Math.floor(Date.now() / 1000);
    let updateCount = 0;

    db.transaction(() => {
      for (const update of updates) {
        updateStmt.run(update.new_slug, now, update.product_uid);
        updateCount++;
      }
    })();

    console.log(`✓ Updated ${updateCount} products`);

    // Verify results
    const remainingNull = db
      .prepare(`SELECT COUNT(*) as count FROM products WHERE product_slug IS NULL`)
      .get() as { count: number };

    console.log();
    console.log("Verification:");
    console.log(`  Products with NULL slug: ${remainingNull.count}`);
    console.log(`  Expected: 0`);

    if (remainingNull.count === 0) {
      console.log();
      console.log("✓ Backfill complete - all products have slugs!");
    } else {
      console.log();
      console.log(`⚠ Warning: ${remainingNull.count} products still have NULL slugs`);
      console.log("  Re-run this script to attempt backfill again");
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
