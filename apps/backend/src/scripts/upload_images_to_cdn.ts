/**
 * Upload product images to ImageKit CDN
 *
 * Usage:
 *   tsx apps/backend/src/scripts/upload_images_to_cdn.ts [--db path/to/db] [--dry-run] [--limit N]
 *
 * This script uploads processed images to ImageKit CDN for products that have
 * local images but no CDN URLs. It updates both scans and products tables.
 *
 * Options:
 *   --db         Path to SQLite database (default: apps/backend/cardmint_dev.db)
 *   --dry-run    Preview changes without uploading or updating database
 *   --limit N    Limit to N products (default: all)
 */

import Database from "better-sqlite3";
import ImageKit from "imagekit";
import { promises as fs } from "node:fs";
import * as dotenv from "dotenv";
import * as path from "node:path";

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), "apps/backend/.env") });

interface ScanWithProduct {
  scan_id: string;
  product_uid: string;
  processed_image_path: string;
  raw_image_path: string | null;
  card_name: string;
  set_name: string;
}

function parseArgs(): { dbPath: string; dryRun: boolean; limit: number | null } {
  const args = process.argv.slice(2);
  let dbPath = "apps/backend/cardmint_dev.db";
  let dryRun = false;
  let limit: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && i + 1 < args.length) {
      dbPath = args[i + 1];
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--limit" && i + 1 < args.length) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { dbPath, dryRun, limit };
}

async function main() {
  const { dbPath, dryRun, limit } = parseArgs();

  console.log("=== Upload Images to CDN ===");
  console.log(`Database: ${dbPath}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "UPLOAD"}`);
  if (limit) console.log(`Limit: ${limit}`);
  console.log();

  // Check ImageKit credentials
  const publicKey = process.env.IMAGEKIT_PUBLIC_KEY;
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;

  if (!publicKey || !privateKey || !urlEndpoint) {
    console.error("Missing ImageKit credentials in .env:");
    console.error(`  IMAGEKIT_PUBLIC_KEY: ${publicKey ? "set" : "MISSING"}`);
    console.error(`  IMAGEKIT_PRIVATE_KEY: ${privateKey ? "set" : "MISSING"}`);
    console.error(`  IMAGEKIT_URL_ENDPOINT: ${urlEndpoint ? "set" : "MISSING"}`);
    process.exit(1);
  }

  const imagekit = new ImageKit({
    publicKey,
    privateKey,
    urlEndpoint,
  });

  console.log("ImageKit initialized");
  console.log(`  URL endpoint: ${urlEndpoint}`);
  console.log();

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  try {
    // Find scans with products that have local images but no CDN URL
    let query = `
      SELECT
        s.id as scan_id,
        p.product_uid,
        s.processed_image_path,
        s.raw_image_path,
        p.card_name,
        p.set_name
      FROM scans s
      JOIN items i ON s.item_uid = i.item_uid
      JOIN products p ON i.product_uid = p.product_uid
      WHERE s.item_uid IS NOT NULL
        AND s.processed_image_path IS NOT NULL
        AND (p.cdn_image_url IS NULL OR p.cdn_image_url = '')
    `;
    if (limit) {
      query += ` LIMIT ${limit}`;
    }

    const scansToUpload = db.prepare(query).all() as ScanWithProduct[];

    console.log(`Found ${scansToUpload.length} products needing CDN upload`);
    console.log();

    if (scansToUpload.length === 0) {
      console.log("All products with inventory already have CDN URLs!");
      return;
    }

    // Display what will be uploaded
    console.log("Products to upload:");
    scansToUpload.forEach((scan, idx) => {
      console.log(`  ${idx + 1}. ${scan.card_name} (${scan.set_name}) → ${scan.product_uid}`);
    });
    console.log();

    if (dryRun) {
      console.log("DRY RUN - No uploads performed");
      console.log();
      console.log("Files that would be uploaded:");
      for (const scan of scansToUpload) {
        const exists = await fs.access(scan.processed_image_path).then(() => true).catch(() => false);
        console.log(`  ${exists ? "" : ""} ${scan.processed_image_path}`);
      }
      return;
    }

    // Upload each image
    const results: { product_uid: string; success: boolean; url?: string; error?: string }[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (const scan of scansToUpload) {
      console.log(`Uploading: ${scan.card_name} (${scan.product_uid})...`);

      try {
        // Check if file exists
        const fileExists = await fs.access(scan.processed_image_path).then(() => true).catch(() => false);
        if (!fileExists) {
          throw new Error(`File not found: ${scan.processed_image_path}`);
        }

        const fileBuffer = await fs.readFile(scan.processed_image_path);

        const response = await imagekit.upload({
          file: fileBuffer,
          fileName: `${scan.product_uid}.jpg`,
          folder: "/products",
          useUniqueFileName: false,
          tags: ["cardmint", "product", "front"],
        });

        const cdnUrl = response.url;
        console.log(`  Uploaded: ${cdnUrl}`);

        // Update database
        // 1. Update scan
        db.prepare(`
          UPDATE scans
          SET cdn_image_url = ?, cdn_published_at = ?, listing_image_path = ?, updated_at = ?
          WHERE id = ?
        `).run(cdnUrl, now, scan.processed_image_path, now, scan.scan_id);

        // 2. Update product (cdn_published_at doesn't exist in products, only in scans)
        db.prepare(`
          UPDATE products
          SET cdn_image_url = ?, listing_image_path = ?, primary_scan_id = ?, updated_at = ?
          WHERE product_uid = ?
        `).run(cdnUrl, scan.processed_image_path, scan.scan_id, now, scan.product_uid);

        results.push({ product_uid: scan.product_uid, success: true, url: cdnUrl });

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`  FAILED: ${errorMsg}`);
        results.push({ product_uid: scan.product_uid, success: false, error: errorMsg });
      }
    }

    // Summary
    console.log();
    console.log("=== Upload Summary ===");
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`  Successful: ${succeeded}`);
    console.log(`  Failed: ${failed}`);

    if (failed > 0) {
      console.log();
      console.log("Failed uploads:");
      results.filter(r => !r.success).forEach(r => {
        console.log(`  - ${r.product_uid}: ${r.error}`);
      });
    }

    // Verification
    const withCdn = db.prepare(`
      SELECT COUNT(*) as count FROM products
      WHERE cdn_image_url IS NOT NULL AND cdn_image_url != ''
    `).get() as { count: number };

    const withoutCdn = db.prepare(`
      SELECT COUNT(*) as count FROM products p
      JOIN items i ON p.product_uid = i.product_uid
      WHERE (p.cdn_image_url IS NULL OR p.cdn_image_url = '')
    `).get() as { count: number };

    console.log();
    console.log("Database state:");
    console.log(`  Products with CDN URLs: ${withCdn.count}`);
    console.log(`  Inventory products still needing CDN: ${withoutCdn.count}`);

  } catch (error) {
    console.error("Upload failed:");
    console.error(error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main().catch(console.error);
