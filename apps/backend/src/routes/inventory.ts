/**
 * Inventory Routes (Overrides & Image Publishing)
 *
 * Phase 3 extraction (Nov 2025).
 * Handles inventory override operations (attach/merge/split) and CDN image publishing.
 * See apps/backend/docs/routes-inventory.md for rationale.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { runtimeConfig, masterCropScriptPath } from "../app/context";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export function registerInventoryRoutes(app: Express, ctx: AppContext): void {
  const { db, logger, inventoryOverrideService, jobRepo, listingImageService, imageHostingService } = ctx;

  // ==========================================================================
  // Inventory Override Endpoints (Phase 3)
  // ==========================================================================

  /**
   * POST /api/items/:id/attach
   * Attach a scan to an existing inventory item
   */
  app.post("/api/items/:id/attach", (req: Request, res: Response) => {
    const { id: item_uid } = req.params;
    const { scan_id } = req.body;

    if (!scan_id) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "scan_id is required",
      });
    }

    try {
      const result = inventoryOverrideService.attachScanToItem(item_uid, scan_id);

      if (!result.success) {
        return res.status(400).json({
          error: "ATTACH_FAILED",
          message: result.message,
        });
      }

      res.json({
        ok: true,
        result,
      });
    } catch (error) {
      logger.error({ err: error, item_uid, scan_id }, "Failed to attach scan to item");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/items/merge
   * Merge multiple inventory items into one
   */
  app.post("/api/items/merge", (req: Request, res: Response) => {
    const { target_item_uid, source_item_uids } = req.body;

    if (!target_item_uid || !source_item_uids || !Array.isArray(source_item_uids)) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "target_item_uid and source_item_uids (array) are required",
      });
    }

    try {
      const result = inventoryOverrideService.mergeItems(target_item_uid, source_item_uids);

      if (!result.success) {
        return res.status(400).json({
          error: "MERGE_FAILED",
          message: result.message,
        });
      }

      res.json({
        ok: true,
        result,
      });
    } catch (error) {
      logger.error({ err: error, target_item_uid, source_item_uids }, "Failed to merge items");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/items/:id/split
   * Split scans from an inventory item into a new item
   */
  app.post("/api/items/:id/split", (req: Request, res: Response) => {
    const { id: source_item_uid } = req.params;
    const { scan_ids } = req.body;

    if (!scan_ids || !Array.isArray(scan_ids)) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "scan_ids (array) is required",
      });
    }

    try {
      const result = inventoryOverrideService.splitItem(source_item_uid, scan_ids);

      if (!result.success) {
        return res.status(400).json({
          error: "SPLIT_FAILED",
          message: result.message,
        });
      }

      res.json({
        ok: true,
        result,
      });
    } catch (error) {
      logger.error({ err: error, source_item_uid, scan_ids }, "Failed to split item");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==========================================================================
  // Image Publishing Endpoints
  // ==========================================================================

  /**
   * POST /api/images/publish
   * Publish listing image (front) to CDN
   */
  app.post("/api/images/publish", async (req: Request, res: Response) => {
    const { product_uid } = req.body;

    if (!product_uid) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "product_uid is required"
      });
    }

    try {
      // Step 1: Find latest accepted scan for this product (front orientation only)
      const scan = db
        .prepare<[string]>(
          `SELECT s.id, s.processed_image_path, s.raw_image_path, s.listing_image_path, s.cdn_image_url, s.cdn_published_at
           FROM scans s
           JOIN items i ON s.item_uid = i.item_uid
           WHERE i.product_uid = ?
             AND s.status = 'completed'
             AND (s.scan_orientation IS NULL OR s.scan_orientation = 'front')
           ORDER BY s.updated_at DESC
           LIMIT 1`
        )
        .get(product_uid) as {
          id: string;
          processed_image_path: string | null;
          raw_image_path: string | null;
          listing_image_path: string | null;
          cdn_image_url: string | null;
          cdn_published_at: number | null;
        } | undefined;

      if (!scan) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: `No completed scans found for product ${product_uid}`
        });
      }

      // Step 2: Check if already published (idempotent)
      if (scan.cdn_image_url) {
        logger.info({ product_uid, cdn_image_url: scan.cdn_image_url }, "Image already published, returning existing URL");
        return res.json({
          ok: true,
          product_uid,
          cdn_image_url: scan.cdn_image_url,
          listing_image_path: scan.listing_image_path || "",
          cdn_published_at: scan.cdn_published_at || Date.now(),
          already_published: true
        });
      }

      // Step 3: Generate listing asset if missing
      let listingPath = scan.listing_image_path;
      if (!listingPath) {
        const result = await listingImageService.generateListingAsset(product_uid);
        if (!result.success || !result.listingPath) {
          return res.status(500).json({
            error: "LISTING_GENERATION_FAILED",
            message: result.error || "Failed to generate listing asset"
          });
        }
        listingPath = result.listingPath;
      }

      // Step 4: Upload to CDN
      if (!runtimeConfig.cdnImagesEnabled) {
        return res.status(503).json({
          error: "CDN_DISABLED",
          message: "CDN uploads are disabled (CDN_IMAGES_ENABLED=false)"
        });
      }
      logger.info({ product_uid, listing_path: listingPath }, "Uploading to CDN");
      const uploadResult = await imageHostingService.uploadImage(listingPath, product_uid);

      if (!uploadResult.success) {
        return res.status(500).json({
          error: "CDN_UPLOAD_FAILED",
          message: uploadResult.error || "Failed to upload to CDN"
        });
      }
      const cdnUrl = uploadResult.secureUrl!;
      const cdn_published_at = Date.now();

      // Step 5: Persist URLs to database (3 locations)
      // 5a. Update scan with CDN URL
      jobRepo.updateScanCdnImageUrl(scan.id, cdnUrl, listingPath);

      // 5b. Update product denormalized field
      jobRepo.updateProductCdnUrl(product_uid, cdnUrl, listingPath, scan.id, cdn_published_at);

      // 5c. Insert into product_images table (Phase 2J: normalized tracking)
      jobRepo.insertProductImage(
        product_uid,
        'front',
        scan.raw_image_path,
        scan.processed_image_path,
        cdnUrl,
        cdn_published_at,
        scan.id
      );

      logger.info({ product_uid, scan_id: scan.id, cdn_url: cdnUrl }, "Image published to CDN");

      res.json({
        ok: true,
        product_uid,
        cdn_image_url: cdnUrl,
        listing_image_path: listingPath,
        cdn_published_at
      });
    } catch (error) {
      logger.error({ err: error, product_uid }, "Failed to publish image");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  /**
   * POST /api/images/publish-back
   * Publish back image to CDN (Phase 2J)
   */
  app.post("/api/images/publish-back", async (req: Request, res: Response) => {
    const { product_uid } = req.body;

    if (!product_uid) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "product_uid is required"
      });
    }

    try {
      // Step 1: Find latest scan with scan_orientation='back' for this product
      let scan = db
        .prepare<[string]>(
          `SELECT s.id, s.processed_image_path, s.raw_image_path, s.listing_image_path, s.cdn_image_url, s.cdn_published_at, s.scan_orientation, s.back_image_path
           FROM scans s
           WHERE s.product_uid = ?
             AND s.scan_orientation = 'back'
             AND s.status = 'completed'
           ORDER BY s.updated_at DESC
           LIMIT 1`
        )
        .get(product_uid) as {
          id: string;
          processed_image_path: string | null;
          raw_image_path: string | null;
          listing_image_path: string | null;
          cdn_image_url: string | null;
          cdn_published_at: number | null;
          scan_orientation: string | null;
          back_image_path: string | null;
        } | undefined;

      // Fallback: use front scan with attached back_image_path (no back-oriented scan row)
      let fallbackFrontScan = false;
      if (!scan) {
        scan = db
          .prepare<[string]>(
            `SELECT s.id, s.processed_image_path, s.raw_image_path, s.listing_image_path, s.cdn_image_url, s.cdn_published_at, s.scan_orientation, s.back_image_path
             FROM scans s
             WHERE s.product_uid = ?
               AND s.back_image_path IS NOT NULL
             ORDER BY s.updated_at DESC
             LIMIT 1`
          )
          .get(product_uid) as {
            id: string;
            processed_image_path: string | null;
            raw_image_path: string | null;
            listing_image_path: string | null;
            cdn_image_url: string | null;
            cdn_published_at: number | null;
            scan_orientation: string | null;
            back_image_path: string | null;
          } | undefined;
        fallbackFrontScan = !!scan;
      }

      if (!scan) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: `No back image found for product ${product_uid} (none with scan_orientation='back' or attached back_image_path)`
        });
      }

      const isBackScanRow = scan.scan_orientation === "back";

      // Step 2: Check if already published (idempotent)
      if (scan.cdn_image_url && isBackScanRow) {
        logger.info({ product_uid, cdn_image_url: scan.cdn_image_url }, "Back image already published, returning existing URL");
        return res.json({
          ok: true,
          product_uid,
          cdn_back_image_url: scan.cdn_image_url,
          listing_image_path: scan.listing_image_path || "",
          cdn_published_at: scan.cdn_published_at || Date.now(),
          already_published: true
        });
      }

      // Step 3: Generate listing asset if missing
      let listingPath = scan.listing_image_path;
      if (!listingPath) {
        logger.info({ product_uid, scan_id: scan.id }, "Selecting back listing asset path");
        // Prefer processed path, then explicit back image, then raw
        listingPath =
          scan.processed_image_path ||
          scan.back_image_path ||
          scan.raw_image_path;
      }

      if (!listingPath) {
        return res.status(500).json({
          error: "NO_IMAGE_PATH",
          message: "Back image is missing paths (processed/back/raw)"
        });
      }

      // Optional: generate master back crop (no inference; leverages same cropper as front)
      let uploadPath = listingPath;
      if (fs.existsSync(masterCropScriptPath)) {
        try {
          const masterBackOutput = path.join(path.dirname(listingPath), `master-back-${path.basename(listingPath)}`);
          const cmd = `python3 ${masterCropScriptPath} --input "${listingPath}" --output "${masterBackOutput}"`;
          logger.debug({ product_uid, cmd }, "Generating back master crop for upload");
          await execAsync(cmd);
          if (fs.existsSync(masterBackOutput)) {
            uploadPath = masterBackOutput;
            logger.info({ product_uid, uploadPath }, "Back master crop generated for CDN upload");
          } else {
            logger.warn({ product_uid, masterBackOutput }, "Back master crop script did not produce output; using original path");
          }
        } catch (cropError) {
          logger.warn({ err: cropError, product_uid, listingPath }, "Back master crop generation failed; using original path");
        }
      } else {
        logger.debug({ masterCropScriptPath }, "Back master crop script not found; uploading original path");
      }

      // Step 4: Upload to CDN
      if (!runtimeConfig.cdnImagesEnabled) {
        return res.status(503).json({
          error: "CDN_DISABLED",
          message: "CDN uploads are disabled (CDN_IMAGES_ENABLED=false)"
        });
      }

      logger.info({ product_uid, listing_path: uploadPath }, "Uploading back image to CDN");
      const uploadResult = await imageHostingService.uploadImage(uploadPath, `${product_uid}-back`);

      if (!uploadResult.success) {
        return res.status(500).json({
          error: "CDN_UPLOAD_FAILED",
          message: uploadResult.error || "Failed to upload back image to CDN"
        });
      }

      const cdnUrl = uploadResult.secureUrl!;
      const cdn_published_at = Date.now();

      // Step 5: Persist URLs to database (3 locations)
      // 5a. Update scan with CDN URL (only if this row represents a back scan)
      if (isBackScanRow) {
        jobRepo.updateScanCdnImageUrl(scan.id, cdnUrl, listingPath);
      }

      // 5b. Update product denormalized field
      jobRepo.updateProductCdnBackUrl(product_uid, cdnUrl, scan.id);

      // 5c. Insert into product_images table (normalized source of truth)
      jobRepo.insertProductImage(
        product_uid,
        'back',
        // raw_path: prefer explicit back image path if present
        scan.back_image_path || scan.raw_image_path,
        scan.processed_image_path || scan.back_image_path,
        cdnUrl,
        cdn_published_at,
        scan.id
      );

      logger.info({ product_uid, scan_id: scan.id, cdn_url: cdnUrl }, "Back image published to CDN");

      res.json({
        ok: true,
        product_uid,
        cdn_back_image_url: cdnUrl,
        listing_image_path: listingPath,
        cdn_published_at
      });
    } catch (error) {
      logger.error({ err: error, product_uid }, "Failed to publish back image");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
