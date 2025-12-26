/**
 * Vault Routes (Public Storefront API)
 *
 * Phase 2J extraction (Dec 2025).
 * Serves product data for CardMint storefront Vault page with filtering support.
 * See apps/backend/docs/routes-vault.md for rationale.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { applyImageKitTransform } from "../utils/imageKit";

// Product response shape for storefront
interface VaultProduct {
  id: string;
  name: string;
  set: string;
  number: string;
  condition: string;
  rarity: string | null;
  price: number;
  marketPrice: number;
  stock: number;
  /** Count of items actually available for checkout (status = 'IN_STOCK') */
  availableStock: number;
  frontImage: string;
  backImage: string | null;
  slug: string;
  /** Variant tags (e.g., "First Edition", "Holo", "Reverse Holo") */
  variantTags: string[] | null;
}

interface VaultQueryParams {
  sets?: string;        // Comma-separated set names
  conditions?: string;  // Comma-separated condition buckets (NM, LP, MP, HP)
  rarities?: string;    // Comma-separated rarities
  minPrice?: string;    // Minimum price filter
  maxPrice?: string;    // Maximum price filter
  sort?: string;        // Sort field: price-low, price-high, name-az, newest
  limit?: string;       // Results limit (default 50, max 200)
  offset?: string;      // Pagination offset
  search?: string;      // Search by card name
}

export function registerVaultRoutes(app: Express, ctx: AppContext): void {
  const { db, logger } = ctx;

  /**
   * GET /api/vault/products
   *
   * Public endpoint for Vault storefront. Returns staging-ready products
   * with filtering, sorting, and pagination support.
   *
   * Query params:
   *   - sets: Comma-separated set names to filter by
   *   - conditions: Comma-separated conditions (NM, LP, MP, HP)
   *   - rarities: Comma-separated rarities
   *   - minPrice: Minimum launch price
   *   - maxPrice: Maximum launch price
   *   - sort: price-low, price-high, name-az, newest (default)
   *   - limit: Max results (default 50, max 200)
   *   - offset: Pagination offset (default 0)
   *   - search: Search card name (partial match)
   */
  app.get("/api/vault/products", (req: Request, res: Response) => {
    const params = req.query as VaultQueryParams;

    try {
      // Parse filters
      const sets = params.sets?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
      const conditions = params.conditions?.split(",").map(c => c.trim().toUpperCase()).filter(Boolean) ?? [];
      const rarities = params.rarities?.split(",").map(r => r.trim()).filter(Boolean) ?? [];
      const minPrice = params.minPrice ? parseFloat(params.minPrice) : null;
      const maxPrice = params.maxPrice ? parseFloat(params.maxPrice) : null;
      const search = params.search?.trim() ?? "";
      const sort = params.sort ?? "newest";
      const limit = Math.min(Math.max(parseInt(params.limit ?? "50", 10) || 50, 1), 200);
      const offset = Math.max(parseInt(params.offset ?? "0", 10) || 0, 0);

      // Build dynamic WHERE clauses
      // Note: launch_price IS NOT NULL is enforced because staging-ready items
      // are guaranteed to have launch_price populated (see pricing pipeline)
      // Filter on actual IN_STOCK items, not total_quantity (which includes RESERVED)
      // EverShop Admin is the final authority for customer-facing visibility.
      // Products must be published in EverShop (evershop_sync_state='evershop_live')
      // to appear in the public vault. See docs/KNOWN_ISSUE_EVERSHOP_ADMIN_PRICE_VISIBILITY.md
      //
      // Fail-safe: Also count expired reservations as available. If the expiry job
      // is delayed, customers can still see and attempt to buy these items. The
      // reserve/checkout flow will handle the race condition atomically.
      const whereClauses: string[] = [
        "staging_ready = 1",
        "pricing_status = 'fresh'",
        "market_price IS NOT NULL",
        "launch_price IS NOT NULL",
        "cdn_image_url IS NOT NULL",
        `EXISTS (
          SELECT 1 FROM items i
          WHERE i.product_uid = p.product_uid
          AND (
            i.status = 'IN_STOCK'
            OR (i.status = 'RESERVED' AND i.reserved_until IS NOT NULL AND i.reserved_until < strftime('%s', 'now'))
          )
        )`,
        "(accepted_without_canonical IS NULL OR accepted_without_canonical = 0)",
        "evershop_sync_state = 'evershop_live'",
      ];
      const queryParams: (string | number)[] = [];

      // Set filter (match against set_name)
      if (sets.length > 0) {
        const placeholders = sets.map(() => "?").join(", ");
        whereClauses.push(`set_name IN (${placeholders})`);
        queryParams.push(...sets);
      }

      // Condition filter
      if (conditions.length > 0) {
        const placeholders = conditions.map(() => "?").join(", ");
        whereClauses.push(`condition_bucket IN (${placeholders})`);
        queryParams.push(...conditions);
      }

      // Rarity filter
      if (rarities.length > 0) {
        const placeholders = rarities.map(() => "?").join(", ");
        whereClauses.push(`rarity IN (${placeholders})`);
        queryParams.push(...rarities);
      }

      // Price range
      if (minPrice !== null && !isNaN(minPrice)) {
        whereClauses.push("launch_price >= ?");
        queryParams.push(minPrice);
      }
      if (maxPrice !== null && !isNaN(maxPrice)) {
        whereClauses.push("launch_price <= ?");
        queryParams.push(maxPrice);
      }

      // Search (case-insensitive) - searches card name, set name, and collector number
      // Uses LIKE with COLLATE NOCASE to allow index usage (avoids LOWER() which forces full scan)
      if (search) {
        whereClauses.push("(card_name LIKE ? COLLATE NOCASE OR set_name LIKE ? COLLATE NOCASE OR COALESCE(collector_no, '') LIKE ? COLLATE NOCASE)");
        queryParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      // Build ORDER BY
      let orderBy: string;
      switch (sort) {
        case "price-low":
          orderBy = "launch_price ASC";
          break;
        case "price-high":
          orderBy = "launch_price DESC";
          break;
        case "name-az":
          orderBy = "card_name ASC";
          break;
        case "newest":
        default:
          orderBy = "updated_at DESC";
      }

      // Count query for pagination metadata
      const countSql = `
        SELECT COUNT(*) as total
        FROM products p
        WHERE ${whereClauses.join(" AND ")}
      `;
      const countResult = db.prepare(countSql).get(...queryParams) as { total: number };
      const total = countResult?.total ?? 0;

      // Main query
      // Note: available_quantity subquery counts IN_STOCK items plus expired reservations
      // (fail-safe for delayed expiry job)
      const sql = `
        SELECT
          p.product_uid,
          p.card_name,
          p.set_name,
          p.collector_no,
          p.condition_bucket,
          p.rarity,
          p.market_price,
          p.launch_price,
          p.total_quantity,
          p.cdn_image_url,
          p.cdn_back_image_url,
          p.product_slug,
          p.variant_tags,
          (SELECT COALESCE(SUM(i.quantity), 0) FROM items i WHERE i.product_uid = p.product_uid AND (i.status = 'IN_STOCK' OR (i.status = 'RESERVED' AND i.reserved_until IS NOT NULL AND i.reserved_until < strftime('%s', 'now')))) as available_quantity
        FROM products p
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `;

      const rows = db.prepare(sql).all(...queryParams, limit, offset) as Array<{
        product_uid: string;
        card_name: string;
        set_name: string;
        collector_no: string | null;
        condition_bucket: string;
        rarity: string | null;
        market_price: number;
        launch_price: number;
        total_quantity: number;
        available_quantity: number;
        cdn_image_url: string;
        cdn_back_image_url: string | null;
        product_slug: string | null;
        variant_tags: string | null;
      }>;

      // Transform to storefront shape
      // Note: launch_price is guaranteed non-null by WHERE clause
      const products: VaultProduct[] = rows.map((row) => ({
        id: row.product_uid,
        name: row.card_name,
        set: row.set_name,
        number: row.collector_no ?? "",
        condition: row.condition_bucket,
        rarity: row.rarity,
        price: row.launch_price,
        marketPrice: row.market_price,
        stock: row.total_quantity,
        availableStock: row.available_quantity,
        frontImage: applyImageKitTransform(row.cdn_image_url),
        backImage: row.cdn_back_image_url,
        slug: row.product_slug ?? row.product_uid,
        variantTags: row.variant_tags ? (() => {
          try {
            return JSON.parse(row.variant_tags);
          } catch {
            return null;
          }
        })() : null,
      }));

      res.json({
        ok: true,
        products,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + products.length < total,
        },
      });
    } catch (error) {
      logger.error({ error }, "vault.products.failed");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/vault/filters
   *
   * Returns available filter options based on current inventory.
   * This helps the frontend display only relevant filter choices.
   */
  app.get("/api/vault/filters", (_req: Request, res: Response) => {
    try {
      // Get distinct sets with counts (only products with IN_STOCK items and published in EverShop)
      const sets = db.prepare(`
        SELECT set_name as name, COUNT(*) as count
        FROM products p
        WHERE staging_ready = 1
          AND pricing_status = 'fresh'
          AND market_price IS NOT NULL
          AND launch_price IS NOT NULL
          AND cdn_image_url IS NOT NULL
          AND EXISTS (SELECT 1 FROM items i WHERE i.product_uid = p.product_uid AND i.status = 'IN_STOCK')
          AND (accepted_without_canonical IS NULL OR accepted_without_canonical = 0)
          AND evershop_sync_state = 'evershop_live'
        GROUP BY set_name
        ORDER BY set_name
      `).all() as Array<{ name: string; count: number }>;

      // Get distinct conditions with counts (only products with IN_STOCK items and published in EverShop)
      const conditions = db.prepare(`
        SELECT condition_bucket as name, COUNT(*) as count
        FROM products p
        WHERE staging_ready = 1
          AND pricing_status = 'fresh'
          AND market_price IS NOT NULL
          AND launch_price IS NOT NULL
          AND cdn_image_url IS NOT NULL
          AND EXISTS (SELECT 1 FROM items i WHERE i.product_uid = p.product_uid AND i.status = 'IN_STOCK')
          AND (accepted_without_canonical IS NULL OR accepted_without_canonical = 0)
          AND evershop_sync_state = 'evershop_live'
        GROUP BY condition_bucket
        ORDER BY
          CASE condition_bucket
            WHEN 'NM' THEN 1
            WHEN 'LP' THEN 2
            WHEN 'MP' THEN 3
            WHEN 'HP' THEN 4
            ELSE 5
          END
      `).all() as Array<{ name: string; count: number }>;

      // Get distinct rarities with counts (only products with IN_STOCK items and published in EverShop)
      const rarities = db.prepare(`
        SELECT rarity as name, COUNT(*) as count
        FROM products p
        WHERE staging_ready = 1
          AND pricing_status = 'fresh'
          AND market_price IS NOT NULL
          AND launch_price IS NOT NULL
          AND cdn_image_url IS NOT NULL
          AND EXISTS (SELECT 1 FROM items i WHERE i.product_uid = p.product_uid AND i.status = 'IN_STOCK')
          AND rarity IS NOT NULL
          AND (accepted_without_canonical IS NULL OR accepted_without_canonical = 0)
          AND evershop_sync_state = 'evershop_live'
        GROUP BY rarity
        ORDER BY rarity
      `).all() as Array<{ name: string; count: number }>;

      // Get price range (only products with IN_STOCK items and published in EverShop)
      const priceRange = db.prepare(`
        SELECT
          MIN(launch_price) as min,
          MAX(launch_price) as max
        FROM products p
        WHERE staging_ready = 1
          AND pricing_status = 'fresh'
          AND market_price IS NOT NULL
          AND launch_price IS NOT NULL
          AND cdn_image_url IS NOT NULL
          AND EXISTS (SELECT 1 FROM items i WHERE i.product_uid = p.product_uid AND i.status = 'IN_STOCK')
          AND (accepted_without_canonical IS NULL OR accepted_without_canonical = 0)
          AND evershop_sync_state = 'evershop_live'
      `).get() as { min: number | null; max: number | null };

      res.json({
        ok: true,
        filters: {
          sets,
          conditions,
          rarities,
          priceRange: {
            min: priceRange?.min ?? 0,
            max: priceRange?.max ?? 0,
          },
        },
      });
    } catch (error) {
      logger.error({ error }, "vault.filters.failed");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
