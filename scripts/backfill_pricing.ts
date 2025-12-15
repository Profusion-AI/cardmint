#!/usr/bin/env tsx

import * as Database from "better-sqlite3";
import { pino } from "pino";
import { runtimeConfig } from "../apps/backend/src/config";
import { PokePriceTrackerAdapter } from "../apps/backend/src/services/pricing/pptAdapter";
import type { PPTConfig } from "../apps/backend/src/services/pricing/types";
import * as fs from "node:fs";
import * as path from "node:path";

interface Product {
  product_uid: string;
  product_sku: string;
  listing_sku: string;
  card_name: string;
  condition_bucket: string;
  hp_value: number | null;
  pricing_status: string;
}

interface BackfillResult {
  run_timestamp: string;
  total_products: number;
  ppt_hits: number;
  ppt_errors: number;
  cache_hits: number;
  coverage_pct: number;
  fallback_skus: string[];
  quota_consumed: number | null;
  quota_remaining: number | null;
}

const logger = pino({
  level: "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
    },
  },
});

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 37;

  const dryRun = args.includes("--dry-run");

  logger.info(
    {
      limit,
      dryRun,
      tier: runtimeConfig.pokemonPriceTrackerTier,
      dailyLimit: runtimeConfig.pokemonPriceTrackerDailyLimit,
    },
    "Starting pricing backfill",
  );

  // Check for PPT API key
  if (!runtimeConfig.pokemonPriceTrackerApiKey) {
    logger.error("POKEMONPRICETRACKER_API_KEY not set. Cannot proceed.");
    process.exit(1);
  }

  // Connect to database
  const dbPath = path.resolve(process.cwd(), runtimeConfig.sqlitePath);
  logger.info({ dbPath }, "Connecting to database");

  const db = Database(dbPath);

  // Initialize PPT adapter
  const pptConfig: PPTConfig = {
    apiKey: runtimeConfig.pokemonPriceTrackerApiKey,
    baseUrl: "https://api.pokemonpricetracker.com",
    tier: runtimeConfig.pokemonPriceTrackerTier,
    dailyLimit: runtimeConfig.pokemonPriceTrackerDailyLimit,
    timeoutMs: runtimeConfig.pokemonPriceTrackerTimeoutMs,
  };

  const pptAdapter = new PokePriceTrackerAdapter(db, pptConfig, logger);

  // Fetch products needing pricing
  const products = db
    .prepare(
      `SELECT product_uid, product_sku, listing_sku, card_name, condition_bucket, hp_value, pricing_status
       FROM products
       WHERE pricing_status = 'missing' OR pricing_status IS NULL
       LIMIT ?`,
    )
    .all(limit) as Product[];

  logger.info({ count: products.length, limit }, "Found products needing pricing");

  if (products.length === 0) {
    logger.info("No products need pricing. Exiting.");
    db.close();
    return;
  }

  const result: BackfillResult = {
    run_timestamp: new Date().toISOString(),
    total_products: products.length,
    ppt_hits: 0,
    ppt_errors: 0,
    cache_hits: 0,
    coverage_pct: 0,
    fallback_skus: [],
    quota_consumed: null,
    quota_remaining: null,
  };

  // Process each product
  for (const product of products) {
    logger.info(
      {
        product_sku: product.product_sku,
        card_name: product.card_name,
        condition: product.condition_bucket,
      },
      "Enriching product",
    );

    const enrichmentResult = await pptAdapter.getPrice(
      product.listing_sku,
      product.condition_bucket,
      product.card_name,
      product.hp_value ?? undefined,
    );

    if (enrichmentResult.fromCache) {
      result.cache_hits++;
    }

    if (enrichmentResult.success && enrichmentResult.priceData) {
      const priceData = enrichmentResult.priceData;

      result.ppt_hits++;

      if (!dryRun) {
        // Update product with pricing data
        db.prepare(
          `UPDATE products
           SET market_price = ?,
               pricing_source = ?,
               pricing_status = ?,
               pricing_updated_at = ?
           WHERE product_uid = ?`,
        ).run(
          priceData.market_price,
          priceData.pricing_source,
          priceData.pricing_status,
          Math.floor(Date.now() / 1000),
          product.product_uid,
        );

        logger.info(
          {
            product_sku: product.product_sku,
            market_price: priceData.market_price,
            pricing_source: priceData.pricing_source,
            fromCache: enrichmentResult.fromCache,
          },
          "Updated product pricing",
        );
      } else {
        logger.info(
          {
            product_sku: product.product_sku,
            market_price: priceData.market_price,
            fromCache: enrichmentResult.fromCache,
          },
          "[DRY RUN] Would update product pricing",
        );
      }
    } else {
      result.ppt_errors++;
      result.fallback_skus.push(product.listing_sku);

      logger.warn(
        {
          product_sku: product.product_sku,
          error: enrichmentResult.error,
        },
        "Failed to enrich product",
      );

      if (!dryRun) {
        // Mark as missing so it can be retried later
        db.prepare(
          `UPDATE products
           SET pricing_status = 'missing',
               pricing_updated_at = ?
           WHERE product_uid = ?`,
        ).run(Math.floor(Date.now() / 1000), product.product_uid);
      }
    }

    // Update quota metrics from last call
    const quotaStatus = pptAdapter.getQuotaStatus();
    if (quotaStatus) {
      result.quota_consumed = quotaStatus.callsConsumed;
      result.quota_remaining = quotaStatus.dailyRemaining;

      // Halt if quota critical
      if (quotaStatus.shouldHalt) {
        logger.error(
          {
            dailyRemaining: quotaStatus.dailyRemaining,
            dailyLimit: quotaStatus.dailyLimit,
          },
          "Quota critical - halting backfill early",
        );
        break;
      }
    }
  }

  // Calculate coverage
  result.coverage_pct = (result.ppt_hits / result.total_products) * 100;

  // Write results to file
  const resultsDir = path.resolve(process.cwd(), "results");
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const resultsPath = path.join(resultsDir, "pricing_coverage.json");
  fs.writeFileSync(resultsPath, JSON.stringify(result, null, 2));

  logger.info({ resultsPath, result }, "Backfill complete");

  // Summary
  logger.info(
    {
      total: result.total_products,
      ppt_hits: result.ppt_hits,
      cache_hits: result.cache_hits,
      errors: result.ppt_errors,
      coverage: `${result.coverage_pct.toFixed(1)}%`,
      quota_remaining: result.quota_remaining,
      fallback_count: result.fallback_skus.length,
    },
    "Backfill summary",
  );

  db.close();
}

main().catch((error) => {
  logger.error({ error }, "Backfill failed");
  process.exit(1);
});
