/**
 * Shared Enrichment Helper
 *
 * Provides unified enrichment logic for both stage3Promotion and pricing.ts routes.
 * Implements the new deterministic lookup hierarchy:
 *   1. tcgPlayerId deterministic → 2. Bridge lookup → 3. Parse-title → 4. CSV fallback
 *
 * Added 2025-12-01 per Codex recommendations.
 */

import type { Database } from "better-sqlite3";
import type { Logger } from "pino";
import type { PokePriceTrackerAdapter } from "./pptAdapter";
import type { PriceChartingRepository } from "../retrieval/pricechartingRepository";
import type { EnrichmentResult, PriceData } from "./types";
import { computeLaunchPrice } from "./types";
import { buildParseTitleFromExtraction } from "../pptTitleBuilder";
import { runtimeConfig } from "../../config";

/**
 * Product data required for enrichment
 */
export interface ProductForEnrichment {
  product_uid: string;
  cm_card_id: string;
  canonical_sku: string | null;
  listing_sku: string;
  condition_bucket: string | null;
  card_name?: string;
  set_name?: string;
  collector_no?: string;
  rarity?: string;
}

/**
 * Scan data for title building
 */
export interface ScanForEnrichment {
  extracted?: Record<string, unknown>;
}

/**
 * Canonical info resolved from the database
 */
interface CanonicalInfo {
  tcg_player_id: string;
  ppt_card_id: string | null;
  card_number: string;
  set_slug: string;
  set_name: string;
}

/**
 * Outlier check threshold (5x variance)
 */
const OUTLIER_THRESHOLD = 5;

/**
 * Check if PPT price is an outlier compared to CSV price.
 * Returns isOutlier=true if variance > 5x or < 0.2x.
 * Skips check if CSV price is null or zero (avoid divide-by-zero).
 */
function checkOutlier(
  pptPrice: number,
  csvPrice: number | null,
): { isOutlier: boolean; variance?: number; csvPrice?: number } {
  if (csvPrice == null || csvPrice === 0) {
    return { isOutlier: false };
  }

  const variance = pptPrice / csvPrice;
  const isOutlier = variance > OUTLIER_THRESHOLD || variance < 1 / OUTLIER_THRESHOLD;
  return { isOutlier, variance, csvPrice };
}

/**
 * Resolve tcgPlayerId and canonical context via cm_card_id → canonical chain.
 * Handles multiple data models in priority order:
 * 1. If cm_card_id looks like a PPT ObjectId (24 hex chars), use it to lookup canonical_cards
 * 2. Try products.ppt_card_id if available
 * 3. Try cm_tcgplayer_bridge to get tcgplayer_id directly
 */
function resolveCanonicalInfo(db: Database, cmCardId: string): CanonicalInfo | null {
  // Path 1: cm_card_id is a PPT ObjectId format (24 hex chars)
  const isPptObjectId = /^[0-9a-f]{24}$/i.test(cmCardId);

  if (isPptObjectId) {
    const canonicalRow = db
      .prepare(
        `SELECT
          cc.tcg_player_id,
          cc.ppt_card_id,
          cc.card_number,
          cs.tcg_player_id as set_slug,
          cs.name as set_name
        FROM canonical_cards cc
        JOIN canonical_sets cs ON cc.set_tcg_player_id = cs.tcg_player_id
        WHERE cc.ppt_card_id = ?`,
      )
      .get(cmCardId) as CanonicalInfo | undefined;

    if (canonicalRow) return canonicalRow;
  }

  // Path 2: Try products.ppt_card_id
  const productRow = db
    .prepare(`SELECT ppt_card_id FROM products WHERE cm_card_id = ? LIMIT 1`)
    .get(cmCardId) as { ppt_card_id: string | null } | undefined;

  if (productRow?.ppt_card_id) {
    const canonicalRow = db
      .prepare(
        `SELECT
          cc.tcg_player_id,
          cc.ppt_card_id,
          cc.card_number,
          cs.tcg_player_id as set_slug,
          cs.name as set_name
        FROM canonical_cards cc
        JOIN canonical_sets cs ON cc.set_tcg_player_id = cs.tcg_player_id
        WHERE cc.ppt_card_id = ?`,
      )
      .get(productRow.ppt_card_id) as CanonicalInfo | undefined;

    if (canonicalRow) return canonicalRow;
  }

  // Path 3: Try cm_tcgplayer_bridge to get tcgplayer_id, then resolve canonical context
  const bridgeRow = db
    .prepare(
      `SELECT tcgplayer_id FROM cm_tcgplayer_bridge
       WHERE cm_card_id = ? AND confidence >= 0.8
       ORDER BY confidence DESC LIMIT 1`,
    )
    .get(cmCardId) as { tcgplayer_id: string } | undefined;

  if (bridgeRow?.tcgplayer_id) {
    const canonicalRow = db
      .prepare(
        `SELECT
          cc.tcg_player_id,
          cc.ppt_card_id,
          cc.card_number,
          cs.tcg_player_id as set_slug,
          cs.name as set_name
        FROM canonical_cards cc
        JOIN canonical_sets cs ON cc.set_tcg_player_id = cs.tcg_player_id
        WHERE cc.tcg_player_id = ?`,
      )
      .get(bridgeRow.tcgplayer_id) as CanonicalInfo | undefined;

    if (canonicalRow) return canonicalRow;
  }

  return null;
}

/**
 * Get CSV price for outlier comparison.
 * Returns null if bridge doesn't exist or CSV lookup fails.
 */
function getCsvPriceForOutlierCheck(
  db: Database,
  priceChartingRepo: PriceChartingRepository,
  cmCardId: string,
  condition: string,
): number | null {
  const bridgeRow = db
    .prepare(
      `SELECT pricecharting_id FROM cm_pricecharting_bridge
       WHERE cm_card_id = ? AND is_valid = 1
       ORDER BY confidence DESC LIMIT 1`,
    )
    .get(cmCardId) as { pricecharting_id: string } | undefined;

  if (!bridgeRow?.pricecharting_id) {
    return null;
  }

  const pricechartingId = bridgeRow.pricecharting_id.replace(/^pricecharting::/i, "").trim();
  const csvResult = priceChartingRepo.getPriceFromCSV(pricechartingId, condition);
  return csvResult?.market_price ?? null;
}

/**
 * Update crosswalk table with deterministic match.
 * Protected: only writes if:
 *   1. No existing entry with match_method='operator'
 *   2. No existing entry with confidence >= 1.0
 */
function updateCrosswalk(
  db: Database,
  logger: Logger,
  cmCardId: string,
  tcgPlayerId: string,
  pptCardId: string | undefined,
): void {
  if (!cmCardId || !tcgPlayerId) return;

  try {
    // Check for existing entry
    const existing = db
      .prepare(
        `SELECT confidence, match_method FROM cm_tcgplayer_bridge
         WHERE cm_card_id = ? AND tcgplayer_id = ?`,
      )
      .get(cmCardId, tcgPlayerId) as { confidence: number; match_method: string } | undefined;

    // Protect operator entries and high-confidence existing entries
    if (existing) {
      if (existing.match_method === "operator") {
        logger.debug({ cmCardId, tcgPlayerId }, "Skipping crosswalk update - operator entry exists");
        return;
      }
      if (existing.confidence >= 1.0) {
        logger.debug({ cmCardId, tcgPlayerId }, "Skipping crosswalk update - high-confidence entry exists");
        return;
      }
    }

    const now = Date.now();
    const notes = pptCardId
      ? `Auto-populated via deterministic lookup ${new Date(now).toISOString()} (ppt_card_id: ${pptCardId})`
      : `Auto-populated via deterministic lookup ${new Date(now).toISOString()}`;
    db.prepare(
      `INSERT INTO cm_tcgplayer_bridge (
        cm_card_id, tcgplayer_id, tcgplayer_sku, confidence,
        match_method, notes, created_at, updated_at
      )
      VALUES (?, ?, NULL, 1.0, 'deterministic', ?, ?, ?)
      ON CONFLICT(cm_card_id, tcgplayer_id) DO UPDATE SET
        confidence = 1.0,
        match_method = 'deterministic',
        updated_at = excluded.updated_at`,
    ).run(
      cmCardId,
      tcgPlayerId,
      notes,
      now,
      now,
    );

    logger.debug({ cmCardId, tcgPlayerId }, "Updated cm_tcgplayer_bridge crosswalk");
  } catch (error) {
    logger.warn({ error, cmCardId, tcgPlayerId }, "Failed to update crosswalk (non-blocking)");
  }
}

/**
 * Unified enrichment function with full lookup hierarchy.
 *
 * Order: tcgPlayerId deterministic → bridge → parse-title → CSV fallback
 *
 * Features:
 * - Mismatch rejection: rejects if PPT set/cardNumber differs from canonical
 * - Outlier rejection: rejects if PPT price > 5x or < 0.2x CSV price
 * - Crosswalk population: incrementally populates cm_tcgplayer_bridge on success
 * - Condition-aware pricing: uses LP price for LP condition, etc.
 */
export async function enrichWithDeterministicLookup(
  pptAdapter: PokePriceTrackerAdapter,
  priceChartingRepo: PriceChartingRepository,
  db: Database,
  product: ProductForEnrichment,
  scan: ScanForEnrichment | null,
  logger: Logger,
): Promise<EnrichmentResult & { persistedToDb?: boolean }> {
  const condition = product.condition_bucket ?? "NM";
  const canonicalSku = product.canonical_sku ?? product.listing_sku;
  const pricingStrategy: "cards_query" | "parse_title" | "shadow" =
    (runtimeConfig.pptPricingStrategy as "cards_query" | "parse_title" | "shadow") ?? "cards_query";

  // Check quota first
  const quotaStatus = pptAdapter.getQuotaStatus();
  if (quotaStatus && quotaStatus.dailyRemaining !== null && quotaStatus.dailyRemaining < 5) {
    logger.warn({ dailyRemaining: quotaStatus.dailyRemaining }, "PPT quota too low for auto-enrichment");
    return {
      success: false,
      priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
      quotaStatus: quotaStatus,
      error: "Quota too low",
      fromCache: false,
    };
  }

  let enrichmentResult: EnrichmentResult | null = null;
  let lookupStrategy: EnrichmentResult["lookupStrategy"] = undefined;

  // ============================================================
  // STEP 1: Deterministic lookup via tcgPlayerId
  // ============================================================
  const canonicalInfo = resolveCanonicalInfo(db, product.cm_card_id);

  if (canonicalInfo?.tcg_player_id) {
    try {
      enrichmentResult = await pptAdapter.getPriceByTcgPlayerId(
        canonicalSku,
        product.listing_sku,
        condition,
        canonicalInfo.tcg_player_id,
        { setSlug: canonicalInfo.set_slug, cardNumber: canonicalInfo.card_number },
      );
      lookupStrategy = "tcgplayer_deterministic";

      // Check for mismatch rejection
      if (enrichmentResult.mismatchRejected) {
        logger.warn(
          {
            product_uid: product.product_uid,
            rejectionReason: enrichmentResult.rejectionReason,
          },
          "Deterministic lookup rejected due to mismatch - falling through",
        );
        enrichmentResult = null; // Force fallback
      }

      // Check for success and apply outlier check
      if (enrichmentResult?.success && enrichmentResult.priceData?.market_price != null) {
        const csvPrice = getCsvPriceForOutlierCheck(db, priceChartingRepo, product.cm_card_id, condition);
        const outlierCheck = checkOutlier(enrichmentResult.priceData.market_price, csvPrice);

        if (outlierCheck.isOutlier) {
          logger.warn(
            {
              product_uid: product.product_uid,
              ppt_price: enrichmentResult.priceData.market_price,
              csv_price: outlierCheck.csvPrice,
              variance: outlierCheck.variance?.toFixed(2),
            },
            "PPT price is outlier (>5x variance) - rejecting PPT, will use CSV",
          );

          // Return CSV fallback result directly
          if (csvPrice != null) {
            return {
              success: true,
              priceData: {
                market_price: csvPrice,
                pricing_source: "csv",
                pricing_status: "stale",
              },
              quotaStatus: enrichmentResult.quotaStatus,
              fromCache: false,
              lookupStrategy: "csv_fallback",
              outlierRejected: true,
              rejectionReason: `PPT price ${enrichmentResult.priceData.market_price} is ${outlierCheck.variance?.toFixed(1)}x CSV price ${csvPrice}`,
            };
          }
          // No CSV available, force fallback to other methods
          enrichmentResult = null;
        } else {
          // Success! Update crosswalk
          updateCrosswalk(
            db,
            logger,
            product.cm_card_id,
            canonicalInfo.tcg_player_id,
            enrichmentResult.priceData.ppt_card_id,
          );
        }
      }
    } catch (error) {
      logger.warn(
        { product_uid: product.product_uid, error },
        "tcgPlayerId deterministic lookup failed, trying bridge fallback",
      );
    }
  }

  // ============================================================
  // STEP 2: Bridge lookup via cm_pricecharting_bridge
  // ============================================================
  if (!enrichmentResult?.success || enrichmentResult.priceData?.market_price == null) {
    const bridgeRow = db
      .prepare(
        `SELECT pricecharting_id FROM cm_pricecharting_bridge
         WHERE cm_card_id = ? AND is_valid = 1
         ORDER BY confidence DESC LIMIT 1`,
      )
      .get(product.cm_card_id) as { pricecharting_id: string } | undefined;

    if (bridgeRow?.pricecharting_id) {
      const pricechartingId = bridgeRow.pricecharting_id.replace(/^pricecharting::/i, "").trim();
      try {
        enrichmentResult = await pptAdapter.getPriceByPricechartingId(
          canonicalSku,
          product.listing_sku,
          condition,
          pricechartingId,
        );
        lookupStrategy = "pricecharting_bridge";
      } catch (error) {
        logger.warn({ product_uid: product.product_uid, error }, "Bridge lookup failed, trying parse-title");
      }
    }
  }

  // ============================================================
  // STEP 3: Cards query (preferred) or parse-title (legacy flag)
  // ============================================================
  if (!enrichmentResult?.success || enrichmentResult.priceData?.market_price == null) {
    if (pricingStrategy === "parse_title") {
      const extracted = scan?.extracted ?? null;

      const title = buildParseTitleFromExtraction(extracted, {
        fallbackName: product.card_name ?? "",
        canonicalSetName: product.set_name,
        canonicalCollectorNo: product.collector_no,
        canonicalRarity: product.rarity,
      });

      enrichmentResult = await pptAdapter.getPriceByParsedTitle(
        canonicalSku,
        product.listing_sku,
        condition,
        title,
        { fuzzyMatching: true, includeConfidence: true, maxSuggestions: 4, strictMode: false, includeMetadata: true },
      );
      lookupStrategy = "parse_title";
    } else {
      enrichmentResult = await pptAdapter.getPriceByCardsQuery(
        canonicalSku,
        product.listing_sku,
        condition,
        {
          setSlug: canonicalInfo?.set_slug ?? undefined,
          setName: canonicalInfo?.set_name ?? product.set_name,
          cardNumber: canonicalInfo?.card_number ?? product.collector_no ?? undefined,
          cardName: product.card_name ?? undefined,
          hp: undefined,
          language: "english",
          pptCardId: canonicalInfo?.ppt_card_id ?? null,
          tcgPlayerId: canonicalInfo?.tcg_player_id ?? null,
        },
      );
      lookupStrategy = "cards_query";
    }

    // Apply validation and outlier guards when canonical context is available
    if (enrichmentResult?.success && enrichmentResult.priceData?.market_price != null && canonicalInfo) {
      const signals = enrichmentResult.priceData.enrichment_signals as {
        setName?: string | null;
        cardNumber?: string | null;
        cardSummary?: { setName?: string | null; cardNumber?: string | null };
        parseTitle?: { parsed?: { setName?: string; cardNumber?: string } };
      } | undefined;

      const pptSetName =
        signals?.setName ?? signals?.cardSummary?.setName ?? signals?.parseTitle?.parsed?.setName;
      const pptCardNumber =
        signals?.cardNumber ?? signals?.cardSummary?.cardNumber ?? signals?.parseTitle?.parsed?.cardNumber;

      // Mismatch validation: check set slug and card number
      if (pptSetName && canonicalInfo.set_name) {
        const normalizedPptSet = pptSetName.toLowerCase().replace(/[^a-z0-9]/g, "");
        const normalizedCanonicalSet = canonicalInfo.set_name.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (normalizedPptSet !== normalizedCanonicalSet) {
          logger.warn(
            {
              product_uid: product.product_uid,
              ppt_set: pptSetName,
              canonical_set: canonicalInfo.set_name,
            },
            "PPT pricing set mismatch - rejecting, will use CSV fallback",
          );
          enrichmentResult = {
            ...enrichmentResult,
            mismatchRejected: true,
            rejectionReason: `PPT set mismatch: PPT returned '${pptSetName}', expected '${canonicalInfo.set_name}'`,
          };
          enrichmentResult.priceData = null;
        }
      }

      // Card number mismatch check (if both available)
      if (enrichmentResult.priceData && pptCardNumber && canonicalInfo.card_number) {
        const normalizedPptNum = pptCardNumber.split("/")[0].replace(/^0+(?=\d)/, "");
        const normalizedCanonicalNum = canonicalInfo.card_number.split("/")[0].replace(/^0+(?=\d)/, "");
        if (normalizedPptNum !== normalizedCanonicalNum) {
          logger.warn(
            {
              product_uid: product.product_uid,
              ppt_card_number: pptCardNumber,
              canonical_card_number: canonicalInfo.card_number,
            },
            "PPT pricing card number mismatch - rejecting, will use CSV fallback",
          );
          enrichmentResult = {
            ...enrichmentResult,
            mismatchRejected: true,
            rejectionReason: `PPT cardNumber mismatch: PPT returned '${pptCardNumber}', expected '${canonicalInfo.card_number}'`,
          };
          enrichmentResult.priceData = null;
        }
      }

      // Outlier check for PPT results
      if (enrichmentResult.priceData?.market_price != null) {
        const csvPrice = getCsvPriceForOutlierCheck(db, priceChartingRepo, product.cm_card_id, condition);
        const outlierCheck = checkOutlier(enrichmentResult.priceData.market_price, csvPrice);

        if (outlierCheck.isOutlier) {
          logger.warn(
            {
              product_uid: product.product_uid,
              ppt_price: enrichmentResult.priceData.market_price,
              csv_price: outlierCheck.csvPrice,
              variance: outlierCheck.variance?.toFixed(2),
            },
            "PPT price is outlier (>5x variance) - rejecting, will use CSV",
          );

          if (csvPrice != null) {
            return {
              success: true,
              priceData: {
                market_price: csvPrice,
                pricing_source: "csv",
                pricing_status: "stale",
              },
              quotaStatus: enrichmentResult.quotaStatus,
              fromCache: false,
              lookupStrategy: "csv_fallback",
              outlierRejected: true,
              rejectionReason: `PPT price ${enrichmentResult.priceData.market_price} is ${outlierCheck.variance?.toFixed(1)}x CSV price ${csvPrice}`,
            };
          }
          // No CSV available, mark as rejected
          enrichmentResult.priceData = null;
        }
      }
    }
  }

  // ============================================================
  // STEP 4: CSV fallback
  // ============================================================
  let finalMarketPrice = enrichmentResult?.priceData?.market_price ?? null;
  let finalPricingSource: "ppt" | "csv" | "manual" = "ppt";
  let finalPricingStatus: "fresh" | "stale" | "missing" = enrichmentResult?.priceData?.pricing_status ?? "missing";

  if (finalMarketPrice == null) {
    const bridgeRow = db
      .prepare(
        `SELECT pricecharting_id FROM cm_pricecharting_bridge
         WHERE cm_card_id = ? AND is_valid = 1
         ORDER BY confidence DESC LIMIT 1`,
      )
      .get(product.cm_card_id) as { pricecharting_id: string } | undefined;

    if (bridgeRow?.pricecharting_id) {
      const pricechartingId = bridgeRow.pricecharting_id.replace(/^pricecharting::/i, "").trim();
      const csvMatch = priceChartingRepo.getPriceFromCSV(pricechartingId, condition);
      if (csvMatch?.market_price != null) {
        finalMarketPrice = csvMatch.market_price;
        finalPricingSource = "csv";
        finalPricingStatus = "stale";
        lookupStrategy = "csv_fallback";
      }
    }
  }

  // Build final result
  const finalPriceData: PriceData = {
    market_price: finalMarketPrice,
    pricing_source: finalPricingSource,
    pricing_status: finalPricingStatus,
    ppt_card_id: enrichmentResult?.priceData?.ppt_card_id,
    hp_value: enrichmentResult?.priceData?.hp_value,
    total_set_number: enrichmentResult?.priceData?.total_set_number,
    enrichment_signals: enrichmentResult?.priceData?.enrichment_signals,
    cached_at: enrichmentResult?.priceData?.cached_at,
  };

  return {
    success: finalMarketPrice != null,
    priceData: finalPriceData,
    quotaStatus: enrichmentResult?.quotaStatus ?? pptAdapter.getQuotaStatus() ?? {
      tier: "free",
      dailyLimit: 0,
      dailyRemaining: null,
      minuteRemaining: null,
      callsConsumed: null,
      warningLevel: "ok",
      shouldHalt: false,
    },
    error: finalMarketPrice == null ? enrichmentResult?.error : undefined,
    fromCache: enrichmentResult?.fromCache ?? false,
    lookupStrategy,
  };
}

/**
 * Persist pricing to products table.
 * Called by stage3Promotion after enrichment.
 */
export function persistPricingToDb(
  db: Database,
  logger: Logger,
  productUid: string,
  marketPrice: number,
  pricingSource: string,
  pptCardId?: string | null,
): void {
  const pricingStatus = pricingSource === "csv" ? "stale" : "fresh";
  const now = Date.now();
  const launchPrice = computeLaunchPrice(marketPrice);

  if (pptCardId) {
    db.prepare(
      `UPDATE products
       SET market_price = ?,
           launch_price = ?,
           pricing_source = ?,
           pricing_status = ?,
           pricing_updated_at = ?,
           ppt_card_id = ?,
           updated_at = ?
       WHERE product_uid = ?`,
    ).run(marketPrice, launchPrice, pricingSource, pricingStatus, now, pptCardId, now, productUid);
  } else {
    db.prepare(
      `UPDATE products
       SET market_price = ?,
           launch_price = ?,
           pricing_source = ?,
           pricing_status = ?,
           pricing_updated_at = ?,
           updated_at = ?
       WHERE product_uid = ?`,
    ).run(marketPrice, launchPrice, pricingSource, pricingStatus, now, now, productUid);
  }

  logger.info({ product_uid: productUid, market_price: marketPrice, launch_price: launchPrice, pricing_source: pricingSource, ppt_card_id: pptCardId }, "Pricing persisted to DB");
}
