/**
 * Pricing Routes (PPT Enrichment)
 *
 * Phase 3 extraction (Nov 2025).
 * Operator-triggered pricing enrichment via PokemonPriceTracker API.
 * See apps/backend/docs/routes-pricing.md for rationale.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { runtimeConfig } from "../config";
import { buildParseTitleFromExtraction } from "../services/pptTitleBuilder";
import { enrichWithDeterministicLookup } from "../services/pricing/enrichmentHelper";

export function registerPricingRoutes(app: Express, ctx: AppContext): void {
  const { db, jobRepo, sessionRepo, sessionService, pptAdapter, priceChartingRepo, logger } = ctx;

  /**
   * POST /api/operator/enrich/ppt/preview
   * Run parse-title against the latest extracted fields without persisting to DB.
   * Accepts either { scan_id } or { product_uid }. Returns pricing + quota.
   */
  app.post("/api/operator/enrich/ppt/preview", async (req: Request, res: Response) => {
    const { scan_id, product_uid } = req.body ?? {};

    try {
      let canonical_sku: string | undefined;
      let listing_sku: string | undefined;
      let condition_bucket = "NM";
      let fallbackName = "";
      let extractedForTitle: any = null;

      if (typeof scan_id === "string" && scan_id.length > 0) {
        const scan = jobRepo.getById(scan_id);
        if (!scan) return res.status(404).json({ error: "SCAN_NOT_FOUND" });
        listing_sku = scan.listing_sku ?? undefined;
        fallbackName = scan.extracted?.card_name ?? "";
        extractedForTitle = scan.extracted ?? null;
      } else if (typeof product_uid === "string" && product_uid.length > 0) {
        const product = db
          .prepare(
            `SELECT product_uid, canonical_sku, listing_sku, card_name, hp_value, condition_bucket, product_sku
             FROM products WHERE product_uid = ?`
          )
          .get(product_uid) as any;
        if (!product) return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
        canonical_sku = product.canonical_sku ?? undefined;
        listing_sku = product.listing_sku ?? undefined;
        fallbackName = product.card_name ?? "";
        condition_bucket = product.condition_bucket ?? "NM";
        const latestScan = db
          .prepare(
            `SELECT extracted_json FROM scans WHERE product_sku = ? ORDER BY updated_at DESC LIMIT 1`
          )
          .get(product.product_sku) as { extracted_json: string | null } | undefined;
        if (latestScan?.extracted_json) {
          try { extractedForTitle = JSON.parse(latestScan.extracted_json); } catch { }
        }
      } else {
        return res.status(400).json({ error: "BAD_REQUEST", message: "scan_id or product_uid required" });
      }

      const title = buildParseTitleFromExtraction(extractedForTitle, { fallbackName });
      const cacheKeySku = canonical_sku || listing_sku || (scan_id ? `preview:${scan_id}` : `preview:${product_uid}`);
      const listingSkuForAudit = listing_sku || (scan_id ? `preview:${scan_id}` : `preview:${product_uid}`);

      const result = await pptAdapter.getPriceByParsedTitle(
        cacheKeySku,
        listingSkuForAudit,
        condition_bucket,
        title,
        { fuzzyMatching: true, includeConfidence: true, maxSuggestions: 4, includeMetadata: true, ignoreQuota: true, skipCacheWrite: true },
      );

      return res.json({
        ok: true,
        preview: true,
        title,
        parse_title_request: title,
        result,
      });
    } catch (error) {
      logger.error({ error }, "PPT preview failed");
      return res.status(500).json({ error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * GET /api/operator/enrich/ppt/quote
   * Dry-run estimate of PPT enrichment cost and quota status
   */
  app.get("/api/operator/enrich/ppt/quote", async (req: Request, res: Response) => {
    const { product_uid } = req.query;

    if (typeof product_uid !== "string") {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "product_uid query parameter required",
      });
    }

    try {
      const product = db
        .prepare(
          `SELECT product_uid, cm_card_id, card_name, hp_value, market_price, pricing_status, pricing_updated_at
           FROM products
           WHERE product_uid = ?`
        )
        .get(product_uid) as any;

      if (!product) {
        return res.status(404).json({
          error: "PRODUCT_NOT_FOUND",
          message: "Product not found",
        });
      }

      if (product.cm_card_id.startsWith("UNKNOWN_")) {
        return res.status(400).json({
          error: "PRODUCT_NOT_CANONICALIZED",
          message: "Product must be canonicalized before enrichment (cm_card_id starts with UNKNOWN_)",
          product_uid,
          cm_card_id: product.cm_card_id,
        });
      }

      const quotaStatus = pptAdapter.getQuotaStatus();

      const now = Math.floor(Date.now() / 1000);
      const isFresh =
        product.pricing_status === "fresh" &&
        product.pricing_updated_at &&
        (now - product.pricing_updated_at) < 86400;

      const estimatedCredits = 3;

      let quotaAllows = true;
      if (quotaStatus) {
        const dailyLow = quotaStatus.dailyRemaining !== null && quotaStatus.dailyRemaining < 10;
        const minuteLow = quotaStatus.minuteRemaining !== null && quotaStatus.minuteRemaining < 10;
        quotaAllows = !(dailyLow || minuteLow);
      }

      res.json({
        product_uid,
        cm_card_id: product.cm_card_id,
        card_name: product.card_name,
        market_price: typeof product.market_price === "number" ? product.market_price : null,
        estimated_credits: estimatedCredits,
        pricing_status: product.pricing_status ?? "missing",
        pricing_fresh: isFresh,
        quota: quotaStatus ?? {
          tier: runtimeConfig.pokemonPriceTrackerTier,
          dailyLimit: runtimeConfig.pokemonPriceTrackerDailyLimit,
          dailyRemaining: null,
          minuteRemaining: null,
          callsConsumed: null,
          warningLevel: "ok",
          shouldHalt: false,
        },
        ready_for_enrichment: !isFresh && quotaAllows,
      });
    } catch (error) {
      logger.error({ error, product_uid }, "Failed to generate PPT quote");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/operator/enrich/ppt
   * Operator-triggered PPT enrichment for a single product
   * Default strategy: limit=1 (1 credit per call)
   */
  app.post("/api/operator/enrich/ppt", async (req: Request, res: Response) => {
    const { product_uid } = req.body;

    if (typeof product_uid !== "string") {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "product_uid is required",
      });
    }

    try {
      const product = db
        .prepare(
          `SELECT product_uid, cm_card_id, canonical_sku, listing_sku, product_sku, card_name, set_name,
                  collector_no, rarity, hp_value, condition_bucket, pricing_status,
                  pricing_updated_at, cdn_image_url
           FROM products
           WHERE product_uid = ?`
        )
        .get(product_uid) as any;

      if (!product) {
        return res.status(404).json({
          error: "PRODUCT_NOT_FOUND",
          message: "Product not found",
        });
      }

      if (product.cm_card_id.startsWith("UNKNOWN_")) {
        return res.status(400).json({
          error: "PRODUCT_NOT_CANONICALIZED",
          message: "Product must be canonicalized before enrichment",
          product_uid,
          cm_card_id: product.cm_card_id,
        });
      }

      const quotaStatus = pptAdapter.getQuotaStatus();
      if (quotaStatus) {
        if (quotaStatus.dailyRemaining !== null && quotaStatus.dailyRemaining < 10) {
          return res.status(429).json({
            error: "QUOTA_LOW",
            message: "Daily quota too low for enrichment (< 10 credits remaining)",
            quota: quotaStatus,
          });
        }

        if (quotaStatus.minuteRemaining !== null && quotaStatus.minuteRemaining < 10) {
          return res.status(429).json({
            error: "RATE_LIMIT",
            message: "Minute rate limit too low for enrichment (< 10 calls remaining)",
            quota: quotaStatus,
          });
        }
      }

      // Get latest scan for extracted fields
      const latestScan = db
        .prepare(
          `SELECT id, extracted_json, updated_at
           FROM scans
           WHERE product_sku = ?
           ORDER BY updated_at DESC
           LIMIT 1`
        )
        .get(product.product_sku) as { id: string; extracted_json: string | null; updated_at: number } | undefined;

      let extractedForTitle: any = null;
      if (latestScan?.extracted_json) {
        try { extractedForTitle = JSON.parse(latestScan.extracted_json); } catch { }
      }

      // Use shared enrichment helper with deterministic lookup hierarchy
      const enrichmentResult = await enrichWithDeterministicLookup(
        pptAdapter,
        priceChartingRepo,
        db,
        {
          product_uid: product.product_uid,
          cm_card_id: product.cm_card_id,
          canonical_sku: product.canonical_sku,
          listing_sku: product.listing_sku,
          condition_bucket: product.condition_bucket,
          card_name: product.card_name,
          set_name: product.set_name,
          collector_no: product.collector_no,
          rarity: product.rarity,
        },
        { extracted: extractedForTitle },
        logger,
      );

      // Update session quota
      const activeSession = await sessionService.getActiveSession();
      if (activeSession && enrichmentResult.quotaStatus) {
        sessionRepo.updateQuota(activeSession.id, {
          tier: enrichmentResult.quotaStatus.tier,
          dailyLimit: enrichmentResult.quotaStatus.dailyLimit,
          dailyRemaining: enrichmentResult.quotaStatus.dailyRemaining,
          callsConsumed: enrichmentResult.quotaStatus.callsConsumed,
          warningLevel: enrichmentResult.quotaStatus.warningLevel,
        });
      }

      const finalPricingSource = enrichmentResult.priceData?.pricing_source ?? "ppt";
      const finalMarketPrice = enrichmentResult.priceData?.market_price ?? null;
      const finalPricingStatus = enrichmentResult.priceData?.pricing_status ?? "missing";
      const lookupStrategy = enrichmentResult.lookupStrategy ?? "cards_query";

      // Log rejections if any
      if (enrichmentResult.mismatchRejected || enrichmentResult.outlierRejected) {
        logger.warn(
          {
            product_uid,
            lookupStrategy,
            mismatchRejected: enrichmentResult.mismatchRejected,
            outlierRejected: enrichmentResult.outlierRejected,
            rejectionReason: enrichmentResult.rejectionReason,
          },
          "Operator enrichment had rejection, used fallback",
        );
      }

      // Track PPT failures for associated scans
      if (!enrichmentResult.success || finalMarketPrice == null) {
        const associatedScans = db
          .prepare(`SELECT id FROM scans WHERE product_sku = ?`)
          .all(product.product_sku) as { id: string }[];

        for (const scan of associatedScans) {
          jobRepo.incrementPptFailureCount(scan.id);
        }

        if (associatedScans.length > 0) {
          logger.warn(
            { product_uid, product_sku: product.product_sku, scan_count: associatedScans.length },
            "PPT failure: incremented ppt_failure_count for associated scans"
          );
        }
      }

      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        `UPDATE products
         SET market_price = ?,
             pricing_source = ?,
             pricing_status = ?,
             pricing_updated_at = ?,
             ppt_enriched_at = ?,
             updated_at = ?
         WHERE product_uid = ?`
      ).run(
        finalMarketPrice,
        finalPricingSource,
        finalPricingStatus,
        now,
        now,
        now,
        product_uid
      );

      const productForPromotion = db
        .prepare(`SELECT product_slug FROM products WHERE product_uid = ?`)
        .get(product_uid) as { product_slug: string | null } | undefined;

      const productBackImage = db.prepare(`SELECT cdn_url FROM product_images WHERE product_uid = ? AND orientation = 'back'`)
        .get(product_uid) as { cdn_url: string | null } | undefined;

      const shouldPromote =
        finalPricingStatus === "fresh" &&
        !product.cm_card_id.startsWith("UNKNOWN_") &&
        product.cdn_image_url != null &&
        productBackImage?.cdn_url != null &&
        productForPromotion?.product_slug != null;

      if (shouldPromote) {
        db.prepare(
          `UPDATE products
           SET staging_ready = 1,
               updated_at = ?
           WHERE product_uid = ?`
        ).run(now, product_uid);
      }

      logger.info(
        {
          product_uid,
          card_name: product.card_name,
          pricing_source: finalPricingSource,
          market_price: finalMarketPrice,
          staging_ready: shouldPromote,
          enrichment_strategy: lookupStrategy,
        },
        "Operator-triggered PPT enrichment complete"
      );

      res.json({
        ok: true,
        product_uid,
        pricing_source: finalPricingSource,
        market_price: finalMarketPrice,
        pricing_status: finalPricingStatus,
        pricing_updated_at: now,
        staging_ready: shouldPromote,
        credits_consumed: finalPricingSource === "csv" ? 0 : (enrichmentResult.quotaStatus.callsConsumed ?? 1),
        quota: enrichmentResult.quotaStatus,
        from_cache: enrichmentResult.fromCache,
        fallback_used: finalPricingSource === "csv",
        enrichment_strategy: lookupStrategy,
        mismatch_rejected: enrichmentResult.mismatchRejected ?? false,
        outlier_rejected: enrichmentResult.outlierRejected ?? false,
        rejection_reason: enrichmentResult.rejectionReason ?? null,
        enrichment_signals: enrichmentResult.priceData?.enrichment_signals ?? null,
      });
    } catch (error) {
      logger.error({ error, product_uid }, "PPT enrichment failed");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
