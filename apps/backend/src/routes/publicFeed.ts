/**
 * Public Feed Routes
 *
 * Phase 3 router extraction (Nov 2025).
 * Exposes /.well-known/cardmint.inventory.json for SEO/LLM discovery.
 */

import type { Express, Request, Response } from "express";
import { createHash } from "node:crypto";
import type { AppContext } from "../app/context";
import { MINIMUM_LISTING_PRICE } from "../services/pricing/types";

// Lightweight in-memory rate limiter for public inventory feed
const feedRateWindowMs = 60_000; // 1 minute
const feedMaxPerWindow = 6; // 6 requests/minute per IP
const feedHits: Map<string, number[]> = new Map();

function allowFeedRequest(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - feedRateWindowMs;
  const arr = feedHits.get(ip) ?? [];
  const recent = arr.filter((t) => t > windowStart);
  if (recent.length >= feedMaxPerWindow) {
    feedHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  feedHits.set(ip, recent);
  return true;
}

/**
 * Register public feed routes on the Express app.
 */
export function registerPublicFeedRoutes(app: Express, ctx: AppContext): void {
  const { db, logger } = ctx;

  // Public, text-only inventory feed for SEO/LLMs
  // Path: /.well-known/cardmint.inventory.json
  app.get("/.well-known/cardmint.inventory.json", (req: Request, res: Response) => {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
    if (!allowFeedRequest(ip)) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({ error: "rate_limited" });
    }

    try {
      // Select products that are currently in stock AND published in EverShop
      // Authority boundary: Only evershop_live products appear in public feeds
      const rows = db
        .prepare(
          `SELECT product_uid, listing_sku, product_sku, card_name, set_name, collector_no,
                  condition_bucket, launch_price, market_price, total_quantity,
                  updated_at,
                  /* pricing fields may not exist in older DBs; guard with COALESCE */
                  COALESCE(pricing_status, 'missing') AS pricing_status
           FROM products
           WHERE total_quantity > 0
             AND evershop_sync_state = 'evershop_live'`
        )
        .all() as Array<{
          product_uid: string;
          listing_sku: string;
          product_sku: string;
          card_name: string;
          set_name: string;
          collector_no: string;
          condition_bucket: string;
          launch_price: number | null;
          market_price: number | null;
          total_quantity: number;
          updated_at: number; // seconds epoch
          pricing_status: "fresh" | "stale" | "missing" | string;
        }>;

      // Compute origin dynamically from request
      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
      const host = req.get("host") ?? "localhost";
      const origin = `${proto}://${host}`;

      const items = rows.map((r) => {
        // Enforce MINIMUM_LISTING_PRICE floor ($0.79) on all public prices
        const rawPrice = (typeof r.launch_price === "number" && r.launch_price > 0)
          ? r.launch_price
          : (typeof r.market_price === "number" && r.market_price > 0)
            ? r.market_price
            : 0;
        const price = rawPrice > 0 ? Math.max(rawPrice, MINIMUM_LISTING_PRICE) : 0;
        const availability = r.total_quantity > 0 ? "in_stock" : "out_of_stock";
        const lastUpdatedIso = new Date((r.updated_at || Math.floor(Date.now() / 1000)) * 1000).toISOString();
        const checksumData = `${r.listing_sku}|${price}|${r.total_quantity}|${lastUpdatedIso}|${r.pricing_status}`;
        const checksum = `sha256:${createHash("sha256").update(checksumData).digest("hex")}`;
        // Provide a stable, SKU-based URL (slug canonicalization lives in the storefront)
        const url = `${origin}/products/sku/${encodeURIComponent(r.listing_sku)}`;

        return {
          sku: r.listing_sku,
          url,
          name: `${r.card_name} — ${r.set_name} (${r.collector_no})`,
          condition: r.condition_bucket,
          price: Number(price.toFixed(2)),
          currency: "USD",
          availability,
          lastUpdated: lastUpdatedIso,
          checksum,
        };
      });

      // Feed envelope
      const feed = {
        issuer: "CardMintShop",
        licenseUrl: `${origin}/data-robots`,
        generatedAt: new Date().toISOString(),
        items,
      };

      // Compute ETag from stable fields only (exclude generatedAt)
      // This makes conditional GETs effective until inventory actually changes.
      const lastModSeconds = rows.reduce((max, r) => Math.max(max, r.updated_at || 0), 0);
      const stableForEtag = JSON.stringify({
        issuer: feed.issuer,
        licenseUrl: feed.licenseUrl,
        lastMod: lastModSeconds,
        items: feed.items,
      });
      const etag = `W/"${createHash("sha256").update(stableForEtag).digest("hex")}"`;
      const lastModified = lastModSeconds > 0 ? new Date(lastModSeconds * 1000) : new Date();

      // Conditional GET handling
      const ifNoneMatch = req.headers["if-none-match"] as string | undefined;
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.status(304);
        res.setHeader("ETag", etag);
        res.setHeader("Last-Modified", lastModified.toUTCString());
        return res.end();
      }

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300"); // 5 minutes
      res.setHeader("ETag", etag);
      res.setHeader("Last-Modified", lastModified.toUTCString());
      return res.send(JSON.stringify(feed, null, 2));
    } catch (err) {
      logger.error({ err }, "Failed to generate inventory feed");
      return res.status(500).json({ error: "feed_generation_failed" });
    }
  });
}
