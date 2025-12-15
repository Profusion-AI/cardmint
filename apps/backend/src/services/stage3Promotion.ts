/**
 * Stage 3 Promotion Service
 *
 * Automates the Stage 3 (staging-ready) workflow after Accept:
 * 1. Generate and publish front image to CDN
 * 2. Publish back image to CDN
 * 3. Trigger PPT pricing enrichment
 * 4. Set staging_ready = 1 if all conditions met
 *
 * Nov 2025: Kyle approved automatic promotion on Accept.
 */

import type { Database } from "better-sqlite3";
import type { Logger } from "pino";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import type { ImageHostingService } from "./imageHosting";
import type { ListingImageService } from "./listingImageService";
import type { PokePriceTrackerAdapter } from "./pricing/pptAdapter";
import type { PriceChartingRepository } from "./retrieval/pricechartingRepository";
import type { JobRepository } from "../repositories/jobRepository";
import { runtimeConfig } from "../config";
import { enrichWithDeterministicLookup, persistPricingToDb } from "./pricing/enrichmentHelper";

const execAsync = promisify(exec);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const masterCropScriptPath = path.resolve(currentDir, "../../../../scripts/create_master_crop.py");

export interface Stage3Result {
  success: boolean;
  product_uid: string;
  front_cdn_url: string | null;
  back_cdn_url: string | null;
  market_price: number | null;
  pricing_source: string | null;
  staging_ready: boolean;
  errors: string[];
}

export class Stage3PromotionService {
  constructor(
    private db: Database,
    private jobRepo: JobRepository,
    private imageHostingService: ImageHostingService,
    private listingImageService: ListingImageService,
    private pptAdapter: PokePriceTrackerAdapter,
    private priceChartingRepo: PriceChartingRepository,
    private logger: Logger
  ) {}

  /**
   * Run Stage 3 promotion for a scan after Accept.
   * Non-blocking: logs errors but doesn't fail the Accept.
   */
  async promoteAfterAccept(scanId: string): Promise<Stage3Result> {
    const errors: string[] = [];
    let front_cdn_url: string | null = null;
    let back_cdn_url: string | null = null;
    let market_price: number | null = null;
    let pricing_source: string | null = null;
    let staging_ready = false;

    // Get scan and product info
    const scan = this.jobRepo.getById(scanId);
    if (!scan) {
      return {
        success: false,
        product_uid: "",
        front_cdn_url: null,
        back_cdn_url: null,
        market_price: null,
        pricing_source: null,
        staging_ready: false,
        errors: ["Scan not found"],
      };
    }

    // Get product_uid via item
    const itemRow = this.db
      .prepare(`SELECT product_uid FROM items WHERE item_uid = ?`)
      .get(scan.item_uid) as { product_uid: string } | undefined;

    if (!itemRow?.product_uid) {
      this.logger.warn({ scanId, item_uid: scan.item_uid }, "Stage 3 exit: no product found for scan (item_uid missing or invalid)");
      return {
        success: false,
        product_uid: "",
        front_cdn_url: null,
        back_cdn_url: null,
        market_price: null,
        pricing_source: null,
        staging_ready: false,
        errors: ["No product found for scan"],
      };
    }

    const product_uid = itemRow.product_uid;

    // Get product details
    const product = this.db
      .prepare(
        `SELECT product_uid, cm_card_id, canonical_sku, listing_sku, card_name, set_name, collector_no, condition_bucket, product_sku, rarity, product_slug
         FROM products WHERE product_uid = ?`
      )
      .get(product_uid) as any;

    if (!product) {
      this.logger.warn({ scanId, product_uid }, "Stage 3 exit: product row not found in products table");
      return {
        success: false,
        product_uid,
        front_cdn_url: null,
        back_cdn_url: null,
        market_price: null,
        pricing_source: null,
        staging_ready: false,
        errors: ["Product not found in database"],
      };
    }

    this.logger.info(
      { scanId, product_uid, card_name: product.card_name },
      "Stage 3 promotion started"
    );

    // Step 1: Publish front image to CDN
    if (runtimeConfig.cdnImagesEnabled) {
      try {
        front_cdn_url = await this.publishFrontImage(scanId, product_uid);
      } catch (error) {
        const msg = `Front CDN publish failed: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(msg);
        this.logger.warn({ scanId, product_uid, error }, msg);
      }
    } else {
      errors.push("CDN disabled (CDN_IMAGES_ENABLED=false)");
    }

    // Step 2: Publish back image to CDN
    // Query back_image_path directly from DB (not in ScanJob type)
    // Note: corrected_image_path is for the FRONT image, not back. Only use back_image_path.
    let backImagePath: string | null = null;

    const backImageRow = this.db
      .prepare(`SELECT back_image_path FROM scans WHERE id = ?`)
      .get(scanId) as { back_image_path: string | null } | undefined;
    backImagePath = backImageRow?.back_image_path ?? null;

    // Fallback: if back_image_path is null, check for a separate back-oriented scan row
    // for the same product (two-capture sessions may have created separate scan rows)
    // Prefer same session_id, then nearest created_at to reduce risk of grabbing wrong card's back
    let backImageFromFallback = false;
    if (!backImagePath) {
      const backScanRow = this.db
        .prepare(
          `SELECT s.raw_image_path, s.processed_image_path
           FROM scans s
           JOIN items i ON s.item_uid = i.item_uid
           WHERE i.product_uid = ? AND s.scan_orientation = 'back'
           ORDER BY
             CASE WHEN s.session_id = ? THEN 0 ELSE 1 END,
             ABS(s.created_at - ?) ASC
           LIMIT 1`
        )
        .get(product_uid, scan.session_id, scan.created_at) as { raw_image_path: string | null; processed_image_path: string | null } | undefined;

      if (backScanRow) {
        backImagePath = backScanRow.processed_image_path ?? backScanRow.raw_image_path;
        if (backImagePath) {
          backImageFromFallback = true;
          this.logger.info({ scanId, product_uid, backImagePath }, "Using back image from separate back-oriented scan row (fallback)");
        }
      }
    }

    if (runtimeConfig.cdnImagesEnabled && backImagePath) {
      try {
        back_cdn_url = await this.publishBackImage(
          scanId,
          product_uid,
          {
            backImagePath: backImagePath,
            correctedImagePath: null, // Back images don't have a separate corrected path
          }
        );

        // If we used the fallback and publish succeeded, persist the path back to the front scan
        // so future Stage 3 reruns skip the fallback query
        if (back_cdn_url && backImageFromFallback) {
          try {
            this.db
              .prepare(`UPDATE scans SET back_image_path = ?, updated_at = ? WHERE id = ?`)
              .run(backImagePath, Date.now(), scanId);
            this.logger.info({ scanId, backImagePath }, "Persisted fallback back_image_path to front scan");
          } catch (persistErr) {
            this.logger.warn({ scanId, persistErr }, "Failed to persist fallback back_image_path (non-blocking)");
          }
        }
      } catch (error) {
        const msg = `Back CDN publish failed: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(msg);
        this.logger.warn({ scanId, product_uid, error }, msg);
      }
    } else if (runtimeConfig.cdnImagesEnabled && !backImagePath) {
      // Log warning and push to errors for telemetry when back image is missing
      this.logger.warn({ scanId, product_uid }, "Back image path missing - skipping back CDN publish");
      errors.push("Back image path missing (back_image_path is NULL and no back-oriented scan found)");
    }

    // Step 3: PPT pricing enrichment (only if cm_card_id is valid)
    const hasValidCmCardId =
      product.cm_card_id &&
      !product.cm_card_id.toUpperCase().startsWith("UNKNOWN_");

    if (hasValidCmCardId) {
      try {
        const pricingResult = await this.enrichPricing(product, scan);
        market_price = pricingResult.market_price;
        pricing_source = pricingResult.pricing_source;
      } catch (error) {
        const msg = `PPT enrichment failed: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(msg);
        this.logger.warn({ scanId, product_uid, error }, msg);
      }
    } else {
      errors.push("Skipped PPT enrichment: cm_card_id is UNKNOWN_*");
    }

    // Step 4: Check staging_ready conditions and update
    const refreshedProduct = this.db
      .prepare(`SELECT cdn_image_url, product_slug FROM products WHERE product_uid = ?`)
      .get(product_uid) as { cdn_image_url: string | null; product_slug: string | null } | undefined;

    const backCdnRow = this.db
      .prepare(`SELECT cdn_url FROM product_images WHERE product_uid = ? AND orientation = 'back'`)
      .get(product_uid) as { cdn_url: string | null } | undefined;

    const shouldPromote =
      market_price != null &&
      hasValidCmCardId &&
      refreshedProduct?.cdn_image_url != null &&
      backCdnRow?.cdn_url != null &&
      refreshedProduct?.product_slug != null;

    if (shouldPromote) {
      this.db
        .prepare(`UPDATE products SET staging_ready = 1, updated_at = ? WHERE product_uid = ?`)
        .run(Date.now(), product_uid);
      staging_ready = true;
      this.logger.info(
        { scanId, product_uid, card_name: product.card_name },
        "Stage 3 promotion complete: staging_ready = 1"
      );
    } else {
      // Log specific blockers for debugging and retrigger scripts
      const blockers: string[] = [];
      if (!refreshedProduct?.cdn_image_url) blockers.push("front_cdn_missing");
      if (!backCdnRow?.cdn_url) blockers.push("back_cdn_missing");
      if (!market_price) blockers.push("price_missing");
      if (!hasValidCmCardId) blockers.push("cm_card_id_invalid");
      if (!refreshedProduct?.product_slug) blockers.push("slug_missing");

      this.logger.warn(
        {
          scanId,
          product_uid,
          blockers,
          market_price,
          hasValidCmCardId,
          front_cdn: refreshedProduct?.cdn_image_url != null,
          back_cdn: backCdnRow?.cdn_url != null,
          product_slug: refreshedProduct?.product_slug != null,
        },
        "Stage 3 promotion blocked - staging_ready=0"
      );
    }

    // CDN asset summary log for cost monitoring and deduplication verification
    // Goal: 2 assets per product (front + back), both named with scanId (job ID)
    const finalFrontUrl = refreshedProduct?.cdn_image_url ?? front_cdn_url;
    const finalBackUrl = backCdnRow?.cdn_url ?? back_cdn_url;
    const frontSource = finalFrontUrl
      ? (finalFrontUrl.includes(scanId) ? "master_reused" : "listing_generated")
      : "none";

    this.logger.info({
      product_uid,
      scanId,
      cdn_assets: {
        front: frontSource,
        front_url: finalFrontUrl,
        back: finalBackUrl ? "uploaded" : "skipped",
        back_url: finalBackUrl,
      },
      total_cdn_assets: (finalFrontUrl ? 1 : 0) + (finalBackUrl ? 1 : 0),
      staging_ready,
    }, "Stage 3 promotion complete - CDN asset summary");

    return {
      success: errors.length === 0,
      product_uid,
      front_cdn_url: finalFrontUrl,
      back_cdn_url: finalBackUrl,
      market_price,
      pricing_source,
      staging_ready,
      errors,
    };
  }

  private async publishFrontImage(scanId: string, product_uid: string): Promise<string | null> {
    // Check if already published
    const existing = this.db
      .prepare(`SELECT cdn_image_url FROM products WHERE product_uid = ?`)
      .get(product_uid) as { cdn_image_url: string | null } | undefined;

    // Check if master_cdn_url already exists from Stage 1.5 upload
    // This is the preferred path - master crop is already on CDN with scanId naming
    const masterScan = this.jobRepo.getById(scanId);

    // Guard: If cdn_image_url exists but master_cdn_url is available and different,
    // overwrite with master to ensure we use the job-ID-named asset (not product-UID)
    if (existing?.cdn_image_url && masterScan?.master_cdn_url) {
      if (existing.cdn_image_url === masterScan.master_cdn_url) {
        // Already using master - no action needed
        this.logger.debug({ product_uid, cdn_url: existing.cdn_image_url }, "Front image already published (using master)");
        return existing.cdn_image_url;
      } else {
        // Mismatch: existing URL is stale (likely product-UID listing asset)
        // Overwrite with master_cdn_url to consolidate to 2 assets
        this.logger.warn({
          product_uid,
          scanId,
          stale_url: existing.cdn_image_url,
          master_url: masterScan.master_cdn_url,
        }, "Front CDN URL mismatch detected: overwriting with master_cdn_url (fixing 3-asset case)");

        const cdnUrl = masterScan.master_cdn_url;
        const now = Date.now();
        const masterPath = masterScan.master_image_path ?? "";

        // Overwrite database with master URL
        this.jobRepo.updateScanCdnImageUrl(scanId, cdnUrl, masterPath);
        this.jobRepo.updateProductCdnUrl(product_uid, cdnUrl, masterPath, scanId, now);
        this.jobRepo.insertProductImage(
          product_uid,
          "front",
          masterScan.raw_image_path ?? null,
          masterScan.processed_image_path ?? null,
          cdnUrl,
          now,
          scanId
        );

        this.logger.info({ product_uid, cdn_url: cdnUrl }, "Front image URL corrected to master_cdn_url");
        return cdnUrl;
      }
    }

    // No master available - use existing if present
    if (existing?.cdn_image_url) {
      this.logger.debug({ product_uid, cdn_url: existing.cdn_image_url }, "Front image already published (no master available)");
      return existing.cdn_image_url;
    }

    // Diagnostic logging: trace Path A vs Path B decision
    this.logger.info({
      scanId,
      product_uid,
      has_master_cdn_url: !!masterScan?.master_cdn_url,
      master_cdn_url: masterScan?.master_cdn_url ?? null,
      path: masterScan?.master_cdn_url ? "A_reuse_master" : "B_generate_listing",
    }, "Stage 3 front image: checking master_cdn_url availability");
    if (masterScan?.master_cdn_url) {
      this.logger.info(
        { product_uid, scanId, master_cdn_url: masterScan.master_cdn_url },
        "Using existing master_cdn_url from Stage 1.5 (skipping regeneration)"
      );
      const cdnUrl = masterScan.master_cdn_url;
      const now = Date.now();
      const masterPath = masterScan.master_image_path ?? "";

      // Persist to database (same as below, but using existing CDN URL)
      this.jobRepo.updateScanCdnImageUrl(scanId, cdnUrl, masterPath);
      this.jobRepo.updateProductCdnUrl(product_uid, cdnUrl, masterPath, scanId, now);
      this.jobRepo.insertProductImage(
        product_uid,
        "front",
        masterScan.raw_image_path ?? null,
        masterScan.processed_image_path ?? null,
        cdnUrl,
        now,
        scanId
      );

      this.logger.info({ product_uid, cdn_url: cdnUrl }, "Front image published to CDN (via master_cdn_url)");
      return cdnUrl;
    }

    // Fallback: Generate listing asset (for cases where Stage 1.5 didn't run or failed)
    this.logger.debug({ product_uid, scanId }, "No master_cdn_url found, falling back to listing asset generation");
    const listingResult = await this.listingImageService.generateListingAsset(product_uid);
    if (!listingResult.success || !listingResult.listingPath) {
      throw new Error(listingResult.error || "Failed to generate listing asset");
    }

    // Upload to CDN
    const uploadResult = await this.imageHostingService.uploadImage(listingResult.listingPath, product_uid);
    if (!uploadResult.success || !uploadResult.secureUrl) {
      throw new Error(uploadResult.error || "Failed to upload to CDN");
    }

    const cdnUrl = uploadResult.secureUrl;
    const now = Date.now();

    // Persist to database
    this.jobRepo.updateScanCdnImageUrl(scanId, cdnUrl, listingResult.listingPath);
    this.jobRepo.updateProductCdnUrl(product_uid, cdnUrl, listingResult.listingPath, scanId, now);

    // Get scan paths for product_images insert
    const scan = this.jobRepo.getById(scanId);
    this.jobRepo.insertProductImage(
      product_uid,
      "front",
      scan?.raw_image_path ?? null,
      scan?.processed_image_path ?? null,
      cdnUrl,
      now,
      scanId
    );

    this.logger.info({ product_uid, cdn_url: cdnUrl }, "Front image published to CDN");
    return cdnUrl;
  }

  private async publishBackImage(
    scanId: string,
    product_uid: string,
    paths: { backImagePath: string | null; correctedImagePath: string | null }
  ): Promise<string | null> {
    // Check if already published
    const existing = this.db
      .prepare(`SELECT cdn_url FROM product_images WHERE product_uid = ? AND orientation = 'back'`)
      .get(product_uid) as { cdn_url: string | null } | undefined;

    if (existing?.cdn_url) {
      this.logger.debug({ product_uid, cdn_url: existing.cdn_url }, "Back image already published");
      return existing.cdn_url;
    }

    const sourcePath = this.pickBackSource(paths.correctedImagePath, paths.backImagePath);
    if (!sourcePath) {
      throw new Error("No back image source available for cropping");
    }

    const cropResult = await this.generateBackMasterCrop(sourcePath, scanId);
    if (!cropResult) {
      throw new Error("Back master crop failed (see logs)");
    }

    // Upload to CDN
    // Use scanId (job ID) as SKU base for symmetric naming with front master crop
    // Front: {scanId}.jpg, Back: {scanId}-back.jpg
    const backSku = `${scanId}-back`;
    const uploadResult = await this.imageHostingService.uploadImage(cropResult.outputPath, backSku);
    if (!uploadResult.success || !uploadResult.secureUrl) {
      throw new Error(uploadResult.error || "Failed to upload back image to CDN");
    }

    const cdnUrl = uploadResult.secureUrl;
    const now = Date.now();

    // Insert into product_images
    this.jobRepo.insertProductImage(product_uid, "back", sourcePath, cropResult.outputPath, cdnUrl, now, scanId);

    // Update products.cdn_back_image_url
    this.db
      .prepare(`UPDATE products SET cdn_back_image_url = ?, updated_at = ? WHERE product_uid = ?`)
      .run(cdnUrl, now, product_uid);

    try {
      this.jobRepo.updateProductMasterBackUrl(product_uid, cdnUrl);
    } catch (err) {
      // Column exists via migration; if not present, log and continue
      this.logger.warn({ product_uid, err }, "Failed to update master_back_cdn_url");
    }

    this.logger.info(
      {
        product_uid,
        scanId,
        sku: backSku,
        cdn_url: cdnUrl,
        rotation: cropResult.rotation,
        confidence: cropResult.confidence,
        strategy: cropResult.strategy,
      },
      "Back image cropped and published to CDN"
    );
    return cdnUrl;
  }

  private pickBackSource(correctedPath: string | null, rawPath: string | null): string | null {
    if (correctedPath && fs.existsSync(correctedPath)) {
      return correctedPath;
    }
    if (rawPath && fs.existsSync(rawPath)) {
      return rawPath;
    }
    return null;
  }

  private async generateBackMasterCrop(
    sourcePath: string,
    scanId: string
  ): Promise<{ outputPath: string; rotation?: number; confidence?: number; strategy?: string } | null> {
    if (!fs.existsSync(sourcePath)) {
      this.logger.warn({ scanId, sourcePath }, "Back crop source path does not exist");
      return null;
    }

    if (!fs.existsSync(masterCropScriptPath)) {
      this.logger.warn({ masterCropScriptPath }, "Master crop script not found for back image");
      return null;
    }

    const outputPath = path.join(path.dirname(sourcePath), `back-master-${path.basename(sourcePath)}`);
    const cmd = `python3 "${masterCropScriptPath}" --input "${sourcePath}" --output "${outputPath}" --side back`;

    try {
      const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 15 * 1024 * 1024 });
      let parsed: any = null;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        // Keep parsed null; file existence check handles success/failure
      }

      if (!fs.existsSync(outputPath)) {
        this.logger.warn({ scanId, sourcePath, stdout, stderr }, "Back master crop did not produce output file");
        return null;
      }

      this.logger.info(
        {
          scanId,
          outputPath,
          rotation: parsed?.rotation,
          confidence: parsed?.confidence,
          strategy: parsed?.strategy,
        },
        "Back master crop generated"
      );

      return {
        outputPath,
        rotation: parsed?.rotation,
        confidence: parsed?.confidence,
        strategy: parsed?.strategy,
      };
    } catch (err: any) {
      this.logger.warn({ scanId, sourcePath, err }, "Back master crop execution failed");
      return null;
    }
  }

  private async enrichPricing(
    product: any,
    scan: any
  ): Promise<{ market_price: number | null; pricing_source: string | null }> {
    // Use shared enrichment helper with deterministic lookup hierarchy
    const result = await enrichWithDeterministicLookup(
      this.pptAdapter,
      this.priceChartingRepo,
      this.db,
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
      { extracted: scan?.extracted },
      this.logger,
    );

    const marketPrice = result.priceData?.market_price ?? null;
    const pricingSource = result.priceData?.pricing_source ?? null;
    const pptCardId = result.priceData?.ppt_card_id ?? null;

    // Log strategy and any rejections
    if (result.mismatchRejected || result.outlierRejected) {
      this.logger.warn(
        {
          product_uid: product.product_uid,
          lookupStrategy: result.lookupStrategy,
          mismatchRejected: result.mismatchRejected,
          outlierRejected: result.outlierRejected,
          rejectionReason: result.rejectionReason,
        },
        "Enrichment had rejection, used fallback",
      );
    }

    // Persist pricing to products table if we got a price
    if (marketPrice != null && pricingSource != null) {
      persistPricingToDb(this.db, this.logger, product.product_uid, marketPrice, pricingSource, pptCardId);
    }

    return { market_price: marketPrice, pricing_source: pricingSource };
  }
}
