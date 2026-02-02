/**
 * Dashboard Routes - Sales analytics for admin dashboard
 *
 * Feb 2026: Production sales dashboard with forecasting support.
 *
 * Endpoints:
 * - GET /api/cm-admin/dashboard/sales-summary    - Aggregate sales metrics
 * - GET /api/cm-admin/dashboard/revenue-by-period - Time series revenue data
 * - GET /api/cm-admin/dashboard/discount-analysis - Discount/promo analytics
 *
 * Security:
 * - All endpoints require Bearer auth (CARDMINT_ADMIN_API_KEY)
 * - No PII returned (aggregate data only)
 *
 * Query Parameters (all endpoints):
 * - start (required): Start date (inclusive), ISO 8601 format
 * - end (required): End date (exclusive), ISO 8601 format
 * - source (optional): Filter by source - "all" | "cardmint" | "tcgplayer" | "ebay"
 *
 * Constraints:
 * - Maximum date range: 90 days
 * - All timestamps in UTC
 * - All monetary values in cents (USD)
 */

import { Router, type Express, type Request, type Response } from "express";
import type { AppContext } from "../app/context.js";
import { requireAdminAuth } from "../middleware/adminAuth.js";
import { SalesAnalyticsService, type SourceFilter } from "../services/salesAnalyticsService.js";

const VALID_SOURCES: SourceFilter[] = ["all", "cardmint", "tcgplayer", "ebay"];
const VALID_GRANULARITIES = ["daily", "weekly", "monthly"] as const;

function isValidSource(value: string | undefined): value is SourceFilter {
  return VALID_SOURCES.includes(value as SourceFilter);
}

function isValidGranularity(value: string | undefined): value is typeof VALID_GRANULARITIES[number] {
  return VALID_GRANULARITIES.includes(value as typeof VALID_GRANULARITIES[number]);
}

/**
 * Register dashboard routes on the Express app.
 * All routes mounted under /api/cm-admin/dashboard (operator-only).
 */
export function registerDashboardRoutes(app: Express, ctx: AppContext): void {
  const router = Router();
  const { db, logger } = ctx;

  const analyticsService = new SalesAnalyticsService(db, logger);

  // Mount at /api/cm-admin/dashboard/*
  app.use("/api/cm-admin/dashboard", router);

  // Auth middleware for all routes
  router.use(requireAdminAuth);

  /**
   * GET /api/cm-admin/dashboard/sales-summary
   *
   * Returns aggregate sales metrics for the specified date range.
   * Combines CardMint orders + marketplace orders (TCGPlayer, eBay).
   *
   * Query params:
   * - start (required): ISO 8601 date
   * - end (required): ISO 8601 date
   * - source (optional): "all" | "cardmint" | "tcgplayer" | "ebay"
   */
  router.get("/sales-summary", (req: Request, res: Response) => {
    const { start, end, source } = req.query;

    // Validate date range
    const validation = analyticsService.validateDateRange(
      start as string | undefined,
      end as string | undefined
    );

    if ("error" in validation) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: validation.error,
      });
    }

    // Validate source filter
    const sourceFilter = (source as string) || "all";
    if (!isValidSource(sourceFilter)) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: `Invalid source filter. Must be one of: ${VALID_SOURCES.join(", ")}`,
      });
    }

    try {
      const summary = analyticsService.getSalesSummary(validation.range, sourceFilter);

      // Cache for 5 minutes (data doesn't change frequently)
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json(summary);
    } catch (error) {
      logger.error({ err: error }, "Failed to get sales summary");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "Failed to get sales summary",
      });
    }
  });

  /**
   * GET /api/cm-admin/dashboard/revenue-by-period
   *
   * Returns revenue broken down by time period (daily/weekly/monthly).
   * Used for charting historical trends.
   *
   * Query params:
   * - start (required): ISO 8601 date
   * - end (required): ISO 8601 date
   * - granularity (optional): "daily" | "weekly" | "monthly" (default: "weekly")
   * - source (optional): "all" | "cardmint" | "tcgplayer" | "ebay"
   */
  router.get("/revenue-by-period", (req: Request, res: Response) => {
    const { start, end, granularity, source } = req.query;

    // Validate date range
    const validation = analyticsService.validateDateRange(
      start as string | undefined,
      end as string | undefined
    );

    if ("error" in validation) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: validation.error,
      });
    }

    // Validate granularity
    const gran = (granularity as string) || "weekly";
    if (!isValidGranularity(gran)) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: `Invalid granularity. Must be one of: ${VALID_GRANULARITIES.join(", ")}`,
      });
    }

    // Validate source filter
    const sourceFilter = (source as string) || "all";
    if (!isValidSource(sourceFilter)) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: `Invalid source filter. Must be one of: ${VALID_SOURCES.join(", ")}`,
      });
    }

    try {
      const revenueData = analyticsService.getRevenueByPeriod(validation.range, gran, sourceFilter);

      // Cache for 5 minutes
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json(revenueData);
    } catch (error) {
      logger.error({ err: error }, "Failed to get revenue by period");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "Failed to get revenue by period",
      });
    }
  });

  /**
   * GET /api/cm-admin/dashboard/discount-analysis
   *
   * Returns discount/coupon usage analytics.
   * Shows breakdown by source (LOT_BUILDER, PROMO, COMBINED) and top promo codes.
   *
   * Query params:
   * - start (required): ISO 8601 date
   * - end (required): ISO 8601 date
   */
  router.get("/discount-analysis", (req: Request, res: Response) => {
    const { start, end } = req.query;

    // Validate date range
    const validation = analyticsService.validateDateRange(
      start as string | undefined,
      end as string | undefined
    );

    if ("error" in validation) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: validation.error,
      });
    }

    try {
      const discountData = analyticsService.getDiscountAnalysis(validation.range);

      // Cache for 5 minutes
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json(discountData);
    } catch (error) {
      logger.error({ err: error }, "Failed to get discount analysis");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "Failed to get discount analysis",
      });
    }
  });
}
