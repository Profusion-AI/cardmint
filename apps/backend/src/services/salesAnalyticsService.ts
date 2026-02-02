/**
 * Sales Analytics Service
 *
 * Feb 2026: Aggregate queries for sales dashboard.
 * Combines CardMint (Stripe) orders + marketplace (TCGPlayer/eBay) orders.
 *
 * Key semantics:
 * - All timestamps are Unix epoch (seconds or milliseconds depending on table)
 * - All monetary values are in cents (USD only)
 * - Date ranges use start inclusive, end exclusive
 * - Status filtering: excludes 'cancelled' and unresolved 'exception'
 * - Marketplace orders include 'pending' status (per Kyle's decision)
 *
 * Note: Refund tracking is not yet implemented. When implemented, refunds
 * should be added as a separate line item (gross revenue stays intact).
 */

import type { Database } from "better-sqlite3";
import type { Logger } from "pino";

// Valid order statuses to include in aggregations
const INCLUDED_STATUSES = ["confirmed", "processing", "shipped", "delivered"];

// Maximum date range allowed (90 days in milliseconds)
const MAX_DATE_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

// Source filter options
export type SourceFilter = "all" | "cardmint" | "tcgplayer" | "ebay";

// ISO 8601 week calculation helpers
function getISOWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of current week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNum };
}

function formatISOWeek(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function formatYearMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface DateRange {
  start: Date;
  end: Date;
}

export interface SalesSummary {
  period: { start: string; end: string };
  cardmint: {
    orderCount: number;
    itemCount: number;
    grossRevenueCents: number;
    netRevenueCents: number;
    discountCents: number;
    topPromoCode: string | null;
  };
  marketplace: {
    tcgplayer: { orderCount: number; revenueCents: number };
    ebay: { orderCount: number; revenueCents: number };
  };
  combined: {
    totalGrossRevenueCents: number;
    totalNetRevenueCents: number;
    totalOrders: number;
    combinedAvgOrderValueCents: number;
  };
}

export interface RevenueByPeriodEntry {
  period: string;
  orders: number;
  netRevenueCents: number;
  itemCount: number;
}

export interface RevenueByPeriod {
  granularity: "daily" | "weekly" | "monthly";
  weekNumbering: "ISO8601";
  timezone: "UTC";
  data: RevenueByPeriodEntry[];
}

export interface DiscountBySource {
  source: string;
  orderCount: number;
  totalDiscountCents: number;
  avgDiscountCents: number;
}

export interface PromoCodeUsage {
  code: string;
  usageCount: number;
  totalDiscountCents: number;
}

export interface DiscountAnalysis {
  period: { start: string; end: string };
  bySource: DiscountBySource[];
  topPromoCodes: PromoCodeUsage[];
  summary: {
    ordersWithDiscount: number;
    ordersWithoutDiscount: number;
    totalDiscountCents: number;
    discountRate: number;
  };
}

export class SalesAnalyticsService {
  constructor(
    private db: Database,
    private logger: Logger
  ) {}

  /**
   * Validate and parse date range from query params.
   * Returns error message if invalid.
   */
  validateDateRange(start: string | undefined, end: string | undefined): { range: DateRange } | { error: string } {
    if (!start || !end) {
      return { error: "Both 'start' and 'end' query parameters are required" };
    }

    const startDate = new Date(start);
    const endDate = new Date(end);

    if (isNaN(startDate.getTime())) {
      return { error: `Invalid start date: ${start}` };
    }
    if (isNaN(endDate.getTime())) {
      return { error: `Invalid end date: ${end}` };
    }

    if (startDate >= endDate) {
      return { error: "start date must be before end date" };
    }

    const rangeMs = endDate.getTime() - startDate.getTime();
    if (rangeMs > MAX_DATE_RANGE_MS) {
      return { error: `Date range exceeds maximum of 90 days (requested: ${Math.ceil(rangeMs / 86400000)} days)` };
    }

    return { range: { start: startDate, end: endDate } };
  }

  /**
   * Get sales summary for a date range.
   * Combines CardMint orders + marketplace orders.
   */
  getSalesSummary(range: DateRange, source: SourceFilter = "all"): SalesSummary {
    const startTs = Math.floor(range.start.getTime() / 1000);
    const endTs = Math.floor(range.end.getTime() / 1000);

    // CardMint orders (if source filter allows)
    let cardmintData = {
      orderCount: 0,
      itemCount: 0,
      grossRevenueCents: 0,
      netRevenueCents: 0,
      discountCents: 0,
      topPromoCode: null as string | null,
    };

    if (source === "all" || source === "cardmint") {
      const statusPlaceholders = INCLUDED_STATUSES.map(() => "?").join(", ");
      const cardmintQuery = `
        SELECT
          COUNT(*) as order_count,
          COALESCE(SUM(item_count), 0) as item_count,
          COALESCE(SUM(COALESCE(original_subtotal_cents, subtotal_cents) + shipping_cents), 0) as gross_revenue_cents,
          COALESCE(SUM(subtotal_cents + shipping_cents), 0) as net_revenue_cents,
          COALESCE(SUM(COALESCE(discount_cents, 0)), 0) as discount_cents
        FROM orders
        WHERE created_at >= ? AND created_at < ?
          AND status IN (${statusPlaceholders})
      `;

      const cardmintRow = this.db.prepare(cardmintQuery).get(startTs, endTs, ...INCLUDED_STATUSES) as {
        order_count: number;
        item_count: number;
        gross_revenue_cents: number;
        net_revenue_cents: number;
        discount_cents: number;
      };

      // Get top promo code
      const topPromoQuery = `
        SELECT promo_code, COUNT(*) as usage_count
        FROM orders
        WHERE created_at >= ? AND created_at < ?
          AND status IN (${statusPlaceholders})
          AND promo_code IS NOT NULL AND promo_code != ''
        GROUP BY promo_code
        ORDER BY usage_count DESC
        LIMIT 1
      `;
      const topPromoRow = this.db.prepare(topPromoQuery).get(startTs, endTs, ...INCLUDED_STATUSES) as {
        promo_code: string;
      } | undefined;

      cardmintData = {
        orderCount: cardmintRow.order_count,
        itemCount: cardmintRow.item_count,
        grossRevenueCents: cardmintRow.gross_revenue_cents,
        netRevenueCents: cardmintRow.net_revenue_cents,
        discountCents: cardmintRow.discount_cents,
        topPromoCode: topPromoRow?.promo_code ?? null,
      };
    }

    // Marketplace orders
    let tcgplayerData = { orderCount: 0, revenueCents: 0 };
    let ebayData = { orderCount: 0, revenueCents: 0 };

    if (source === "all" || source === "tcgplayer" || source === "ebay") {
      // marketplace_orders.order_date is Unix timestamp (seconds)
      const marketplaceStatusPlaceholders = ["pending", "processing", "shipped", "delivered"].map(() => "?").join(", ");
      const includedMarketplaceStatuses = ["pending", "processing", "shipped", "delivered"];

      const marketplaceQuery = `
        SELECT
          source,
          COUNT(*) as order_count,
          COALESCE(SUM(product_value_cents + shipping_fee_cents), 0) as revenue_cents
        FROM marketplace_orders
        WHERE order_date >= ? AND order_date < ?
          AND status IN (${marketplaceStatusPlaceholders})
        GROUP BY source
      `;

      const marketplaceRows = this.db.prepare(marketplaceQuery).all(startTs, endTs, ...includedMarketplaceStatuses) as {
        source: string;
        order_count: number;
        revenue_cents: number;
      }[];

      for (const row of marketplaceRows) {
        if (row.source === "tcgplayer" && (source === "all" || source === "tcgplayer")) {
          tcgplayerData = { orderCount: row.order_count, revenueCents: row.revenue_cents };
        } else if (row.source === "ebay" && (source === "all" || source === "ebay")) {
          ebayData = { orderCount: row.order_count, revenueCents: row.revenue_cents };
        }
      }
    }

    // Combined metrics
    const totalGrossRevenueCents = cardmintData.grossRevenueCents + tcgplayerData.revenueCents + ebayData.revenueCents;
    const totalNetRevenueCents = cardmintData.netRevenueCents + tcgplayerData.revenueCents + ebayData.revenueCents;
    const totalOrders = cardmintData.orderCount + tcgplayerData.orderCount + ebayData.orderCount;
    const combinedAvgOrderValueCents = totalOrders > 0 ? Math.round(totalNetRevenueCents / totalOrders) : 0;

    return {
      period: {
        start: formatDate(range.start),
        end: formatDate(range.end),
      },
      cardmint: cardmintData,
      marketplace: {
        tcgplayer: tcgplayerData,
        ebay: ebayData,
      },
      combined: {
        totalGrossRevenueCents,
        totalNetRevenueCents,
        totalOrders,
        combinedAvgOrderValueCents,
      },
    };
  }

  /**
   * Get revenue broken down by time period.
   */
  getRevenueByPeriod(
    range: DateRange,
    granularity: "daily" | "weekly" | "monthly" = "weekly",
    source: SourceFilter = "all"
  ): RevenueByPeriod {
    const startTs = Math.floor(range.start.getTime() / 1000);
    const endTs = Math.floor(range.end.getTime() / 1000);

    // Map to aggregate data by period
    const periodMap = new Map<string, { orders: number; netRevenueCents: number; itemCount: number }>();

    // CardMint orders
    if (source === "all" || source === "cardmint") {
      const statusPlaceholders = INCLUDED_STATUSES.map(() => "?").join(", ");
      const cardmintQuery = `
        SELECT created_at, item_count, subtotal_cents, shipping_cents
        FROM orders
        WHERE created_at >= ? AND created_at < ?
          AND status IN (${statusPlaceholders})
      `;

      const cardmintRows = this.db.prepare(cardmintQuery).all(startTs, endTs, ...INCLUDED_STATUSES) as {
        created_at: number;
        item_count: number;
        subtotal_cents: number;
        shipping_cents: number;
      }[];

      for (const row of cardmintRows) {
        const date = new Date(row.created_at * 1000);
        const period = this.formatPeriod(date, granularity);
        const existing = periodMap.get(period) ?? { orders: 0, netRevenueCents: 0, itemCount: 0 };
        existing.orders += 1;
        existing.netRevenueCents += row.subtotal_cents + row.shipping_cents;
        existing.itemCount += row.item_count;
        periodMap.set(period, existing);
      }
    }

    // Marketplace orders
    if (source === "all" || source === "tcgplayer" || source === "ebay") {
      const includedMarketplaceStatuses = ["pending", "processing", "shipped", "delivered"];
      const marketplaceStatusPlaceholders = includedMarketplaceStatuses.map(() => "?").join(", ");

      let sourceFilter = "";
      const params: (number | string)[] = [startTs, endTs, ...includedMarketplaceStatuses];

      if (source === "tcgplayer") {
        sourceFilter = "AND source = ?";
        params.push("tcgplayer");
      } else if (source === "ebay") {
        sourceFilter = "AND source = ?";
        params.push("ebay");
      }

      const marketplaceQuery = `
        SELECT order_date, item_count, product_value_cents, shipping_fee_cents
        FROM marketplace_orders
        WHERE order_date >= ? AND order_date < ?
          AND status IN (${marketplaceStatusPlaceholders})
          ${sourceFilter}
      `;

      const marketplaceRows = this.db.prepare(marketplaceQuery).all(...params) as {
        order_date: number;
        item_count: number;
        product_value_cents: number;
        shipping_fee_cents: number;
      }[];

      for (const row of marketplaceRows) {
        const date = new Date(row.order_date * 1000);
        const period = this.formatPeriod(date, granularity);
        const existing = periodMap.get(period) ?? { orders: 0, netRevenueCents: 0, itemCount: 0 };
        existing.orders += 1;
        existing.netRevenueCents += row.product_value_cents + row.shipping_fee_cents;
        existing.itemCount += row.item_count;
        periodMap.set(period, existing);
      }
    }

    // Convert map to sorted array
    const data: RevenueByPeriodEntry[] = Array.from(periodMap.entries())
      .map(([period, stats]) => ({
        period,
        orders: stats.orders,
        netRevenueCents: stats.netRevenueCents,
        itemCount: stats.itemCount,
      }))
      .sort((a, b) => a.period.localeCompare(b.period));

    return {
      granularity,
      weekNumbering: "ISO8601",
      timezone: "UTC",
      data,
    };
  }

  /**
   * Get discount analysis for a date range.
   */
  getDiscountAnalysis(range: DateRange): DiscountAnalysis {
    const startTs = Math.floor(range.start.getTime() / 1000);
    const endTs = Math.floor(range.end.getTime() / 1000);
    const statusPlaceholders = INCLUDED_STATUSES.map(() => "?").join(", ");

    // Discount by source
    const bySourceQuery = `
      SELECT
        coupon_source as source,
        COUNT(*) as order_count,
        SUM(COALESCE(discount_cents, 0)) as total_discount_cents
      FROM orders
      WHERE created_at >= ? AND created_at < ?
        AND status IN (${statusPlaceholders})
        AND coupon_source IS NOT NULL
      GROUP BY coupon_source
      ORDER BY total_discount_cents DESC
    `;

    const bySourceRows = this.db.prepare(bySourceQuery).all(startTs, endTs, ...INCLUDED_STATUSES) as {
      source: string;
      order_count: number;
      total_discount_cents: number;
    }[];

    const bySource: DiscountBySource[] = bySourceRows.map((row) => ({
      source: row.source,
      orderCount: row.order_count,
      totalDiscountCents: row.total_discount_cents,
      avgDiscountCents: row.order_count > 0 ? Math.round(row.total_discount_cents / row.order_count) : 0,
    }));

    // Top promo codes
    const topPromoQuery = `
      SELECT
        promo_code as code,
        COUNT(*) as usage_count,
        SUM(COALESCE(discount_cents, 0)) as total_discount_cents
      FROM orders
      WHERE created_at >= ? AND created_at < ?
        AND status IN (${statusPlaceholders})
        AND promo_code IS NOT NULL AND promo_code != ''
      GROUP BY promo_code
      ORDER BY usage_count DESC
      LIMIT 10
    `;

    const topPromoRows = this.db.prepare(topPromoQuery).all(startTs, endTs, ...INCLUDED_STATUSES) as {
      code: string;
      usage_count: number;
      total_discount_cents: number;
    }[];

    const topPromoCodes: PromoCodeUsage[] = topPromoRows.map((row) => ({
      code: row.code,
      usageCount: row.usage_count,
      totalDiscountCents: row.total_discount_cents,
    }));

    // Summary stats
    const summaryQuery = `
      SELECT
        COUNT(CASE WHEN COALESCE(discount_cents, 0) > 0 THEN 1 END) as orders_with_discount,
        COUNT(CASE WHEN COALESCE(discount_cents, 0) = 0 THEN 1 END) as orders_without_discount,
        COALESCE(SUM(COALESCE(discount_cents, 0)), 0) as total_discount_cents,
        COUNT(*) as total_orders
      FROM orders
      WHERE created_at >= ? AND created_at < ?
        AND status IN (${statusPlaceholders})
    `;

    const summaryRow = this.db.prepare(summaryQuery).get(startTs, endTs, ...INCLUDED_STATUSES) as {
      orders_with_discount: number;
      orders_without_discount: number;
      total_discount_cents: number;
      total_orders: number;
    };

    const discountRate = summaryRow.total_orders > 0
      ? Number((summaryRow.orders_with_discount / summaryRow.total_orders).toFixed(2))
      : 0;

    return {
      period: {
        start: formatDate(range.start),
        end: formatDate(range.end),
      },
      bySource,
      topPromoCodes,
      summary: {
        ordersWithDiscount: summaryRow.orders_with_discount,
        ordersWithoutDiscount: summaryRow.orders_without_discount,
        totalDiscountCents: summaryRow.total_discount_cents,
        discountRate,
      },
    };
  }

  /**
   * Format a date into the appropriate period string.
   */
  private formatPeriod(date: Date, granularity: "daily" | "weekly" | "monthly"): string {
    switch (granularity) {
      case "daily":
        return formatDate(date);
      case "weekly":
        const { year, week } = getISOWeek(date);
        return formatISOWeek(year, week);
      case "monthly":
        return formatYearMonth(date);
    }
  }
}
