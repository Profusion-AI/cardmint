#!/usr/bin/env tsx

import Database from "better-sqlite3";
import { pino } from "pino";
import { runtimeConfig } from "../src/config";
import { PokePriceTrackerAdapter } from "../src/services/pricing/pptAdapter";
import { PriceChartingRepository } from "../src/services/retrieval/pricechartingRepository";
import { computeLaunchPrice } from "../src/services/pricing/types";
import type { PPTConfig } from "../src/services/pricing/types";
import fs from "node:fs";
import path from "node:path";

interface Product {
  product_uid: string;
  product_sku: string;
  canonical_sku: string | null;
  listing_sku: string;
  card_name: string;
  condition_bucket: string;
  hp_value: number | null;
  pricing_status: string;
  cm_card_id: string | null;
}

interface BackfillResult {
  run_timestamp: string;
  total_products: number;
  ppt_hits: number;
  ppt_errors: number;
  csv_fallback_hits: number;
  cache_hits: number;
  coverage_pct: number;
  fallback_skus: string[];
  quota_consumed: number | null;
  quota_remaining: number | null;
  promoted_to_staging: number;
}

const logger = pino({
  level: "info",
});

/**
 * Determines if a product meets staging_ready criteria.
 *
 * Predicate for staging_ready = 1:
 * - market_price IS NOT NULL (has pricing)
 * - pricing_status = 'fresh' (pricing is current, not stale or missing)
 * - cm_card_id IS NOT NULL (has canonical match - enforced by schema)
 * - cm_card_id DOES NOT start with 'UNKNOWN_' (unmatched guard)
 *
 * **UNMATCHED GUARD**: Products with fallback cm_card_id (UNKNOWN_*)
 * must be manually canonicalized before staging. This prevents
 * unverified SKUs from flowing to EverShop until an operator
 * resolves the canonical match via the manual canonicalization queue.
 *
 * @param market_price - The product's market price
 * @param pricing_status - The product's pricing status
 * @param cm_card_id - The product's canonical card ID
 * @returns true if product should be marked staging_ready
 */
function shouldPromoteToStaging(
  market_price: number | null,
  pricing_status: string,
  cm_card_id: string | null
): boolean {
  return (
    market_price !== null &&
    market_price > 0 &&
    pricing_status === "fresh" &&
    cm_card_id !== null &&
    !cm_card_id.startsWith("UNKNOWN_")
  );
}

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
    baseUrl: "https://www.pokemonpricetracker.com",
    tier: runtimeConfig.pokemonPriceTrackerTier,
    dailyLimit: runtimeConfig.pokemonPriceTrackerDailyLimit,
    timeoutMs: runtimeConfig.pokemonPriceTrackerTimeoutMs,
  };

  const pptAdapter = new PokePriceTrackerAdapter(db, pptConfig, logger);

  // Initialize PriceCharting repository for CSV fallback
  const pcRepo = new PriceChartingRepository(
    db,
    runtimeConfig.priceChartingCsvPath,
    logger,
  );
  await pcRepo.ensureIngested();

  // Fetch products needing pricing
  const products = db
    .prepare(
      `SELECT product_uid, product_sku, canonical_sku, listing_sku, card_name, condition_bucket, hp_value, pricing_status, cm_card_id
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
    csv_fallback_hits: 0,
    cache_hits: 0,
    coverage_pct: 0,
    fallback_skus: [],
    quota_consumed: null,
    quota_remaining: null,
    promoted_to_staging: 0,
  };

  // Prepare canonical lookup for deterministic pricing
  // Note: canonical_sets.tcg_player_id is the set slug (e.g., "team-rocket")
  const lookupCanonical = db.prepare(
    `SELECT cc.tcg_player_id, cs.tcg_player_id as set_slug, cc.card_number
     FROM canonical_cards cc
     JOIN canonical_sets cs ON cs.tcg_player_id = cc.set_tcg_player_id
     WHERE cc.ppt_card_id = ?`
  );

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

    // Try deterministic lookup first if we have a canonical match
    let enrichmentResult;
    const canonical = product.cm_card_id
      ? lookupCanonical.get(product.cm_card_id) as { tcg_player_id: string; set_slug: string; card_number: string } | undefined
      : undefined;

    if (canonical?.tcg_player_id) {
      logger.info(
        { product_sku: product.product_sku, tcg_player_id: canonical.tcg_player_id },
        "Using deterministic tcgPlayerId lookup"
      );
      enrichmentResult = await pptAdapter.getPriceByTcgPlayerId(
        product.canonical_sku ?? product.listing_sku,
        product.listing_sku,
        product.condition_bucket,
        canonical.tcg_player_id,
        { setSlug: canonical.set_slug, cardNumber: canonical.card_number },
      );
    } else {
      // Fallback to fuzzy lookup
      enrichmentResult = await pptAdapter.getPrice(
        product.canonical_sku ?? product.listing_sku,
        product.listing_sku,
        product.condition_bucket,
        product.card_name,
        product.hp_value ?? undefined,
      );
    }

    if (enrichmentResult.fromCache) {
      result.cache_hits++;
    }

    if (enrichmentResult.success && enrichmentResult.priceData) {
      const priceData = enrichmentResult.priceData;

      result.ppt_hits++;

      if (!dryRun) {
        // Determine if product should be promoted to staging (with unmatched guard)
        const readyForStaging = shouldPromoteToStaging(
          priceData.market_price,
          priceData.pricing_status,
          product.cm_card_id
        );

        if (readyForStaging) {
          result.promoted_to_staging++;
        }

        // Update product with pricing data, ppt_card_id, ppt_enriched_at, and staging_ready flag
        const now = Math.floor(Date.now() / 1000);
        const launchPrice = priceData.market_price ? computeLaunchPrice(priceData.market_price) : null;
        db.prepare(
          `UPDATE products
           SET market_price = ?,
               launch_price = ?,
               pricing_source = ?,
               pricing_status = ?,
               pricing_updated_at = ?,
               staging_ready = ?,
               ppt_card_id = COALESCE(?, ppt_card_id),
               ppt_enriched_at = ?
           WHERE product_uid = ?`,
        ).run(
          priceData.market_price,
          launchPrice,
          priceData.pricing_source,
          priceData.pricing_status,
          now,
          readyForStaging ? 1 : 0,
          priceData.ppt_card_id ?? null,
          now,
          product.product_uid,
        );

        logger.info(
          {
            product_sku: product.product_sku,
            market_price: priceData.market_price,
            pricing_source: priceData.pricing_source,
            fromCache: enrichmentResult.fromCache,
            staging_ready: readyForStaging,
            promoted: readyForStaging,
          },
          readyForStaging
            ? "✅ Product priced and promoted to staging-ready"
            : "Updated product pricing (not staging-ready)",
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

      logger.warn(
        {
          product_sku: product.product_sku,
          error: enrichmentResult.error,
        },
        "PPT enrichment failed, attempting CSV fallback",
      );

      // Attempt CSV fallback (per docs/PPT-USAGE-GUIDE.md operational playbook)
      // Query bridge table to get pricecharting_id for this cm_card_id
      const bridge = product.cm_card_id
        ? (db
            .prepare(
              `SELECT pricecharting_id
               FROM cm_pricecharting_bridge
               WHERE cm_card_id = ?
               ORDER BY confidence DESC
               LIMIT 1`,
            )
            .get(product.cm_card_id) as { pricecharting_id: string } | undefined)
        : undefined;

      if (bridge) {
        // Strip pricecharting:: prefix if present (mirrors repository helper)
        const pricechartingId = bridge.pricecharting_id.replace(
          /^pricecharting::/,
          "",
        );
        const csvPrice = pcRepo.getPriceFromCSV(
          pricechartingId,
          product.condition_bucket,
        );

        if (csvPrice) {
          result.csv_fallback_hits++;

          if (!dryRun) {
            // Determine if product should be promoted to staging (with unmatched guard)
            const readyForStaging = shouldPromoteToStaging(
              csvPrice.market_price,
              csvPrice.pricing_status,
              product.cm_card_id
            );

            if (readyForStaging) {
              result.promoted_to_staging++;
            }

            const csvLaunchPrice = csvPrice.market_price ? computeLaunchPrice(csvPrice.market_price) : null;
            db.prepare(
              `UPDATE products
               SET market_price = ?,
                   launch_price = ?,
                   pricing_source = ?,
                   pricing_status = ?,
                   pricing_updated_at = ?,
                   staging_ready = ?
               WHERE product_uid = ?`,
            ).run(
              csvPrice.market_price,
              csvLaunchPrice,
              csvPrice.pricing_source,
              csvPrice.pricing_status,
              Math.floor(Date.now() / 1000),
              readyForStaging ? 1 : 0,
              product.product_uid,
            );

            logger.info(
              {
                product_sku: product.product_sku,
                market_price: csvPrice.market_price,
                pricing_source: "csv",
                condition: product.condition_bucket,
                staging_ready: readyForStaging,
                promoted: readyForStaging,
              },
              readyForStaging
                ? "✅ Product priced via CSV fallback and promoted to staging-ready"
                : "Updated product pricing via CSV fallback (not staging-ready)",
            );
          } else {
            logger.info(
              {
                product_sku: product.product_sku,
                market_price: csvPrice.market_price,
              },
              "[DRY RUN] Would update product pricing via CSV fallback",
            );
          }
        } else {
          result.fallback_skus.push(product.listing_sku);

          logger.warn(
            {
              product_sku: product.product_sku,
              pricecharting_id: pricechartingId,
              condition: product.condition_bucket,
            },
            "CSV fallback also failed - no pricing available",
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
      } else {
        result.fallback_skus.push(product.listing_sku);

        logger.warn(
          {
            product_sku: product.product_sku,
            cm_card_id: product.cm_card_id,
          },
          "No bridge entry found for cm_card_id - CSV fallback unavailable",
        );

        if (!dryRun) {
          db.prepare(
            `UPDATE products
             SET pricing_status = 'missing',
                 pricing_updated_at = ?
             WHERE product_uid = ?`,
          ).run(Math.floor(Date.now() / 1000), product.product_uid);
        }
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

  // Calculate coverage (PPT + CSV fallback)
  const totalPriced = result.ppt_hits + result.csv_fallback_hits;
  result.coverage_pct = (totalPriced / result.total_products) * 100;

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
      csv_fallback_hits: result.csv_fallback_hits,
      cache_hits: result.cache_hits,
      errors: result.ppt_errors,
      coverage: `${result.coverage_pct.toFixed(1)}%`,
      promoted_to_staging: result.promoted_to_staging,
      quota_remaining: result.quota_remaining,
      fallback_count: result.fallback_skus.length,
    },
    "Backfill summary",
  );

  db.close();
}

main().catch((error) => {
  logger.error({ error: error.message, stack: error.stack }, "Backfill failed");
  console.error("Full error:", error);
  process.exit(1);
});
