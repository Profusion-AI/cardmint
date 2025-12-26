/**
 * Stock Display Routes
 *
 * Dec 2025: Lightweight API for ESP32 stock display hardware.
 * Returns inventory summary optimized for low-memory embedded devices.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { requireDisplayToken } from "../middleware/adminAuth";

interface StockCounts {
  in_stock: number;
  reserved: number;
  sold: number;
  total: number;
}

interface StockValue {
  in_stock_cents: number;
  sold_today_cents: number;
}

interface TodayActivity {
  added: number;
  sold: number;
}

interface StockSummaryResponse {
  ok: boolean;
  counts: StockCounts;
  value: StockValue;
  today: TodayActivity;
  top_sets: Array<{ set_name: string; count: number }>;
  last_sale: string | null;
  timestamp: number;
}

export function registerStockDisplayRoutes(app: Express, ctx: AppContext): void {
  const { db, logger } = ctx;

  /**
   * GET /api/stock-summary
   *
   * Lightweight endpoint for ESP32 stock display.
   * Returns inventory counts, values, and today's activity.
   * Auth: X-CardMint-Display-Token header (DISPLAY_TOKEN env var)
   */
  app.get("/api/stock-summary", requireDisplayToken, (_req: Request, res: Response) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartEpoch = Math.floor(todayStart.getTime() / 1000);

      // Count items by status
      const statusCounts = db
        .prepare(
          `SELECT status, COUNT(*) as count
           FROM items
           GROUP BY status`
        )
        .all() as { status: string; count: number }[];

      const counts: StockCounts = {
        in_stock: 0,
        reserved: 0,
        sold: 0,
        total: 0,
      };

      for (const row of statusCounts) {
        if (row.status === "IN_STOCK") counts.in_stock = row.count;
        else if (row.status === "RESERVED") counts.reserved = row.count;
        else if (row.status === "SOLD") counts.sold = row.count;
        counts.total += row.count;
      }

      // Calculate in-stock inventory value (sum of launch_price for IN_STOCK items)
      const inStockValue = db
        .prepare(
          `SELECT COALESCE(SUM(p.launch_price), 0) as total_cents
           FROM items i
           JOIN products p ON i.product_uid = p.product_uid
           WHERE i.status = 'IN_STOCK'`
        )
        .get() as { total_cents: number };

      // Calculate today's sales value
      const soldTodayValue = db
        .prepare(
          `SELECT COALESCE(SUM(i.sold_price), 0) as total_cents
           FROM items i
           WHERE i.status = 'SOLD' AND i.sold_at >= ?`
        )
        .get(todayStartEpoch) as { total_cents: number };

      // Today's activity
      const addedToday = db
        .prepare(
          `SELECT COUNT(*) as count
           FROM items
           WHERE created_at >= ?`
        )
        .get(todayStartEpoch) as { count: number };

      const soldToday = db
        .prepare(
          `SELECT COUNT(*) as count
           FROM items
           WHERE status = 'SOLD' AND sold_at >= ?`
        )
        .get(todayStartEpoch) as { count: number };

      // Top 3 sets by in-stock count
      const topSets = db
        .prepare(
          `SELECT p.set_name, COUNT(*) as count
           FROM items i
           JOIN products p ON i.product_uid = p.product_uid
           WHERE i.status = 'IN_STOCK' AND p.set_name IS NOT NULL
           GROUP BY p.set_name
           ORDER BY count DESC
           LIMIT 3`
        )
        .all() as { set_name: string; count: number }[];

      // Last sale timestamp
      const lastSale = db
        .prepare(
          `SELECT sold_at
           FROM items
           WHERE status = 'SOLD' AND sold_at IS NOT NULL
           ORDER BY sold_at DESC
           LIMIT 1`
        )
        .get() as { sold_at: number } | undefined;

      const response: StockSummaryResponse = {
        ok: true,
        counts,
        value: {
          in_stock_cents: Math.round((inStockValue.total_cents || 0) * 100),
          sold_today_cents: Math.round((soldTodayValue.total_cents || 0) * 100),
        },
        today: {
          added: addedToday.count,
          sold: soldToday.count,
        },
        top_sets: topSets,
        last_sale: lastSale ? new Date(lastSale.sold_at * 1000).toISOString() : null,
        timestamp: now,
      };

      // Set cache headers (ESP32 can cache for 30 seconds)
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json(response);
    } catch (error) {
      logger.error({ err: error }, "Failed to fetch stock summary");
      res.status(500).json({
        ok: false,
        error: "Failed to fetch stock summary",
      });
    }
  });

  /**
   * GET /api/stock-summary/compact
   *
   * Ultra-compact version for memory-constrained displays.
   * Returns minimal data with short keys.
   *
   * Response fields:
   *   s  - in stock count
   *   r  - reserved count
   *   d  - sold (done) count
   *   td - sold today (Central time)
   *   at - added today (Central time)
   *   v  - total inventory value in cents
   *   ls - last sale timestamp (unix epoch, 0 if none)
   *   t  - current server timestamp
   */
  app.get("/api/stock-summary/compact", requireDisplayToken, (_req: Request, res: Response) => {
    try {
      // Calculate Central time "today" start (CST/CDT aware)
      // Uses Intl API to reliably get Central timezone offset
      const now = new Date();

      // Get current date in Central timezone
      const centralParts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now);

      const getPart = (type: string) =>
        centralParts.find((p) => p.type === type)?.value || "0";
      const year = parseInt(getPart("year"), 10);
      const month = parseInt(getPart("month"), 10);
      const day = parseInt(getPart("day"), 10);

      // Create midnight in Central by using a date string the browser/Node will parse
      // as Central time. We construct an ISO string and calculate the offset.
      // Central offset: -6 hours (CST) or -5 hours (CDT)
      const testMidnight = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00`);

      // Get the actual offset for Central at this date by comparing formatted time
      const centralHour = parseInt(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Chicago",
          hour: "2-digit",
          hour12: false,
        }).format(testMidnight),
        10
      );
      const utcHour = testMidnight.getUTCHours();
      // The difference tells us the offset (negative for Central)
      let offsetHours = centralHour - utcHour;
      if (offsetHours > 12) offsetHours -= 24;
      if (offsetHours < -12) offsetHours += 24;

      // Construct midnight Central as UTC timestamp
      // If Central is UTC-6, then midnight Central = 06:00 UTC
      const midnightCentralUTC = Date.UTC(year, month - 1, day, -offsetHours, 0, 0);
      const todayStartEpoch = Math.floor(midnightCentralUTC / 1000);

      // Single query for counts
      const stats = db
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'IN_STOCK' THEN 1 ELSE 0 END) as s,
             SUM(CASE WHEN status = 'RESERVED' THEN 1 ELSE 0 END) as r,
             SUM(CASE WHEN status = 'SOLD' THEN 1 ELSE 0 END) as d,
             SUM(CASE WHEN status = 'SOLD' AND sold_at >= ? THEN 1 ELSE 0 END) as td,
             SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as at
           FROM items`
        )
        .get(todayStartEpoch, todayStartEpoch) as {
        s: number;
        r: number;
        d: number;
        td: number;
        at: number;
      };

      // Get total inventory value (sum of launch_price for IN_STOCK items)
      const valueResult = db
        .prepare(
          `SELECT COALESCE(SUM(p.launch_price), 0) as total
           FROM items i
           JOIN products p ON i.product_uid = p.product_uid
           WHERE i.status = 'IN_STOCK'`
        )
        .get() as { total: number };

      // Get last sale timestamp
      const lastSaleResult = db
        .prepare(
          `SELECT sold_at FROM items
           WHERE status = 'SOLD' AND sold_at IS NOT NULL
           ORDER BY sold_at DESC LIMIT 1`
        )
        .get() as { sold_at: number } | undefined;

      // Compact response with all fields for enhanced display
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json({
        s: stats.s || 0,
        r: stats.r || 0,
        d: stats.d || 0,
        td: stats.td || 0,
        at: stats.at || 0,
        v: Math.round((valueResult.total || 0) * 100), // Convert to cents
        ls: lastSaleResult?.sold_at || 0,
        t: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to fetch compact stock summary");
      res.status(500).json({ e: 1 });
    }
  });
}
