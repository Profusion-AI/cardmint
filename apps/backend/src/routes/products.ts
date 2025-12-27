/**
 * Products Router
 *
 * Phase 2 extraction (Nov 2025).
 * Serves product data for CardMint storefront PDP.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { applyImageKitTransform } from "../utils/imageKit";

type ProductRow = {
  cdn_image_url: string | null;
  evershop_sync_state?: string | null;
  [key: string]: unknown;
};

/**
 * Generate a short reference code for support escalation.
 * Format: PDP-XXXXXX (6 alphanumeric chars)
 */
function generateRefCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Exclude ambiguous: 0,O,1,I
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `PDP-${code}`;
}

export function registerProductRoutes(app: Express, ctx: AppContext): void {
  const { db, logger } = ctx;
  const log = logger.child({ module: "products-routes" });

  /**
   * GET /api/products/:slug
   *
   * Fetches product data for CardMint storefront PDP.
   * Supports both slug format (name-set-number-uid8) and product_uid for backward compatibility.
   */
  app.get("/api/products/:slug", (req: Request, res: Response) => {
    const { slug } = req.params;

    try {
      // Try to find product by product_uid first (for backward compatibility with pre-slug records)
      // Note: available_quantity counts only IN_STOCK items (excludes RESERVED/SOLD)
      // Query includes evershop_sync_state for authority boundary logging
      let product = db.prepare(`
        SELECT
          p.product_uid,
          p.product_sku,
          p.listing_sku,
          p.product_slug,
          p.card_name,
          p.set_name,
          p.collector_no,
          p.condition_bucket,
          p.market_price,
          p.launch_price,
          p.total_quantity,
          (SELECT COALESCE(SUM(i.quantity), 0) FROM items i WHERE i.product_uid = p.product_uid AND i.status = 'IN_STOCK') as available_quantity,
          p.staging_ready,
          p.cdn_image_url,
          p.cdn_back_image_url,
          p.evershop_sync_state,
          p.created_at,
          p.updated_at
        FROM products p
        WHERE p.product_uid = ?
      `).get(slug) as ProductRow | undefined;

      // If not found by UID, try to find by product_slug (production default)
      if (!product) {
        product = db.prepare(`
          SELECT
            p.product_uid,
            p.product_sku,
            p.listing_sku,
            p.product_slug,
            p.card_name,
            p.set_name,
            p.collector_no,
            p.condition_bucket,
            p.market_price,
            p.launch_price,
            p.total_quantity,
            (SELECT COALESCE(SUM(i.quantity), 0) FROM items i WHERE i.product_uid = p.product_uid AND i.status = 'IN_STOCK') as available_quantity,
            p.staging_ready,
            p.cdn_image_url,
            p.cdn_back_image_url,
            p.evershop_sync_state,
            p.created_at,
            p.updated_at
          FROM products p
          WHERE p.product_slug = ?
        `).get(slug) as ProductRow | undefined;
      }

      // Authority boundary: Only evershop_live products are returned
      // Log with reference code if product exists but isn't live (for support escalation)
      if (!product) {
        return res.status(404).json({
          error: "PRODUCT_NOT_FOUND",
          message: "No product found with the given slug or ID"
        });
      }

      if (product.evershop_sync_state !== "evershop_live") {
        const ref = generateRefCode();
        log.warn(
          {
            slug,
            productUid: product.product_uid,
            ref,
            internalReason: "NOT_LIVE",
            syncState: product.evershop_sync_state,
          },
          "PDP blocked: product not available for viewing"
        );
        // Return 404 to not leak existence; include ref for support escalation
        return res.status(404).json({
          error: "PRODUCT_NOT_FOUND",
          message: "No product found with the given slug or ID",
          ref,
        });
      }

      // Remove internal field before returning
      delete product.evershop_sync_state;

      // Apply standard ImageKit sharpen/retouch transform for front image
      if (product.cdn_image_url) {
        product.cdn_image_url = applyImageKitTransform(product.cdn_image_url);
      }

      // Return product data
      res.json(product);
    } catch (error) {
      logger.error({ err: error, slug }, "Failed to fetch product");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
