/**
 * Fulfillment Search Service
 *
 * Provides search functionality across Stripe and marketplace shipments.
 * Used by the unified fulfillment search endpoint.
 */

import type { Database } from "better-sqlite3";
import { formatTcgplayerOrderNumber, parseTcgplayerOrderNumber } from "../utils/orderNumberFormat.js";

/**
 * Unified fulfillment result for search
 */
export interface UnifiedFulfillmentSearchResult {
  id: string;
  source: "cardmint" | "tcgplayer" | "ebay";
  orderNumber: string;
  customerName: string | null;
  itemCount: number;
  valueCents: number;
  shippingCostCents: number;
  shippingMethod: string | null;
  status: string;
  isExternal: boolean;
  isPwe: boolean;
  importFormat?: string | null;
  shipping: {
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    service: string | null;
    labelUrl: string | null;
    labelCostCents: number | null;
    labelPurchasedAt: number | null;
    labelViewedAt?: number | null;
  };
  timeline: {
    createdAt: number;
    shippedAt: number | null;
    deliveredAt: number | null;
  };
  exception: {
    type: string | null;
    notes: string | null;
  } | null;
  refundStatus?: string | null;
  easypostShipmentId?: string | null;
  // Combined shipment metadata
  combinedWith?: {
    parentShipmentId: number;
    parentOrderNumber: string;
    combinedAt: number;
    combinedBy: string;
  } | null;
  isCombinedParent?: boolean;
  labelActionsDisabled?: boolean;
  sourceRef: {
    stripeSessionId?: string;
    marketplaceOrderId?: number;
    shipmentId?: number;
    externalOrderId?: string;
  };
}

/**
 * Search by tracking number.
 * Matches against both Stripe fulfillment and marketplace shipments.
 */
export function searchByTrackingNumber(
  db: Database,
  trackingNumber: string,
  limit: number = 20
): UnifiedFulfillmentSearchResult[] {
  const results: UnifiedFulfillmentSearchResult[] = [];
  const normalized = trackingNumber.replace(/[\s-]/g, "").toUpperCase();

  // Search Stripe fulfillments
  const stripeRows = db.prepare(`
    SELECT f.*, o.order_number, o.order_uid
    FROM fulfillment f
    LEFT JOIN orders o ON f.stripe_session_id = o.stripe_session_id
    WHERE f.tracking_number = ?
       OR UPPER(REPLACE(REPLACE(f.tracking_number, '-', ''), ' ', '')) = ?
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(trackingNumber, normalized, limit) as any[];

  for (const row of stripeRows) {
    results.push(formatStripeResult(row));
  }

  // Search marketplace shipments
  const mpRows = db.prepare(`
    SELECT
      ms.id as shipment_id,
      ms.shipment_sequence,
      ms.carrier,
      ms.service,
      ms.tracking_number,
      ms.tracking_url,
      ms.label_url,
      ms.label_cost_cents,
      ms.label_purchased_at,
      ms.status as shipment_status,
      ms.shipped_at,
      ms.delivered_at,
      ms.exception_type,
      ms.exception_notes,
      ms.created_at as shipment_created_at,
      ms.is_external,
      ms.is_pwe,
      ms.label_viewed_at,
      ms.refund_status,
      ms.easypost_shipment_id,
      ms.fulfilled_by_shipment_id,
      ms.combined_at,
      ms.combined_by,
      mo.id as order_id,
      mo.source,
      mo.external_order_id,
      mo.display_order_number,
      mo.customer_name,
      mo.order_date,
      mo.item_count,
      mo.product_value_cents,
      mo.shipping_fee_cents,
      mo.shipping_method,
      mo.status as order_status,
      mo.import_format,
      parent_mo.display_order_number as parent_order_number,
      (SELECT COUNT(*) FROM marketplace_shipments WHERE fulfilled_by_shipment_id = ms.id) > 0 as is_combined_parent
    FROM marketplace_shipments ms
    JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id
    LEFT JOIN marketplace_shipments parent_ms ON ms.fulfilled_by_shipment_id = parent_ms.id
    LEFT JOIN marketplace_orders parent_mo ON parent_ms.marketplace_order_id = parent_mo.id
    WHERE ms.tracking_number = ?
       OR UPPER(REPLACE(REPLACE(ms.tracking_number, '-', ''), ' ', '')) = ?
    ORDER BY ms.created_at DESC
    LIMIT ?
  `).all(trackingNumber, normalized, limit) as any[];

  for (const row of mpRows) {
    results.push(formatMarketplaceResult(row));
  }

  return results.slice(0, limit);
}

/**
 * Search by order number.
 * Handles multiple formats: TCGP-*, TCG-*, raw UUIDs, Stripe session IDs.
 */
export function searchByOrderNumber(
  db: Database,
  orderNumber: string,
  limit: number = 20
): UnifiedFulfillmentSearchResult[] {
  const results: UnifiedFulfillmentSearchResult[] = [];
  const trimmed = orderNumber.trim();

  // Parse TCGPlayer formatted order number to raw ID
  const rawOrderId = parseTcgplayerOrderNumber(trimmed);

  // Search Stripe fulfillments
  const stripeRows = db.prepare(`
    SELECT f.*, o.order_number, o.order_uid
    FROM fulfillment f
    LEFT JOIN orders o ON f.stripe_session_id = o.stripe_session_id
    WHERE o.order_number = ?
       OR o.order_uid = ?
       OR f.stripe_session_id = ?
       OR f.stripe_session_id LIKE ?
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(
    trimmed,
    trimmed,
    trimmed,
    `%${trimmed.replace("Session: ", "")}%`,
    limit
  ) as any[];

  for (const row of stripeRows) {
    results.push(formatStripeResult(row));
  }

  // Search marketplace orders
  const mpRows = db.prepare(`
    SELECT
      ms.id as shipment_id,
      ms.shipment_sequence,
      ms.carrier,
      ms.service,
      ms.tracking_number,
      ms.tracking_url,
      ms.label_url,
      ms.label_cost_cents,
      ms.label_purchased_at,
      ms.status as shipment_status,
      ms.shipped_at,
      ms.delivered_at,
      ms.exception_type,
      ms.exception_notes,
      ms.created_at as shipment_created_at,
      ms.is_external,
      ms.is_pwe,
      ms.label_viewed_at,
      ms.refund_status,
      ms.easypost_shipment_id,
      ms.fulfilled_by_shipment_id,
      ms.combined_at,
      ms.combined_by,
      mo.id as order_id,
      mo.source,
      mo.external_order_id,
      mo.display_order_number,
      mo.customer_name,
      mo.order_date,
      mo.item_count,
      mo.product_value_cents,
      mo.shipping_fee_cents,
      mo.shipping_method,
      mo.status as order_status,
      mo.import_format,
      parent_mo.display_order_number as parent_order_number,
      (SELECT COUNT(*) FROM marketplace_shipments WHERE fulfilled_by_shipment_id = ms.id) > 0 as is_combined_parent
    FROM marketplace_shipments ms
    JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id
    LEFT JOIN marketplace_shipments parent_ms ON ms.fulfilled_by_shipment_id = parent_ms.id
    LEFT JOIN marketplace_orders parent_mo ON parent_ms.marketplace_order_id = parent_mo.id
    WHERE mo.external_order_id = ?
       OR mo.display_order_number = ?
       OR mo.external_order_id LIKE ?
    ORDER BY ms.created_at DESC
    LIMIT ?
  `).all(rawOrderId, trimmed, `%${rawOrderId}%`, limit) as any[];

  for (const row of mpRows) {
    results.push(formatMarketplaceResult(row));
  }

  return results.slice(0, limit);
}

/**
 * Search by customer name.
 * Uses normalized name matching for fuzzy search.
 */
export function searchByCustomerName(
  db: Database,
  name: string,
  limit: number = 20
): UnifiedFulfillmentSearchResult[] {
  const results: UnifiedFulfillmentSearchResult[] = [];

  // Normalize for matching: uppercase, strip punctuation
  const normalized = name.trim().toUpperCase().replace(/[^A-Z0-9 ]/g, "");

  // Only search marketplace (Stripe doesn't store customer name in DB)
  const mpRows = db.prepare(`
    SELECT
      ms.id as shipment_id,
      ms.shipment_sequence,
      ms.carrier,
      ms.service,
      ms.tracking_number,
      ms.tracking_url,
      ms.label_url,
      ms.label_cost_cents,
      ms.label_purchased_at,
      ms.status as shipment_status,
      ms.shipped_at,
      ms.delivered_at,
      ms.exception_type,
      ms.exception_notes,
      ms.created_at as shipment_created_at,
      ms.is_external,
      ms.is_pwe,
      ms.label_viewed_at,
      ms.refund_status,
      ms.easypost_shipment_id,
      ms.fulfilled_by_shipment_id,
      ms.combined_at,
      ms.combined_by,
      mo.id as order_id,
      mo.source,
      mo.external_order_id,
      mo.display_order_number,
      mo.customer_name,
      mo.customer_name_normalized,
      mo.order_date,
      mo.item_count,
      mo.product_value_cents,
      mo.shipping_fee_cents,
      mo.shipping_method,
      mo.status as order_status,
      mo.import_format,
      parent_mo.display_order_number as parent_order_number,
      (SELECT COUNT(*) FROM marketplace_shipments WHERE fulfilled_by_shipment_id = ms.id) > 0 as is_combined_parent
    FROM marketplace_shipments ms
    JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id
    LEFT JOIN marketplace_shipments parent_ms ON ms.fulfilled_by_shipment_id = parent_ms.id
    LEFT JOIN marketplace_orders parent_mo ON parent_ms.marketplace_order_id = parent_mo.id
    WHERE mo.customer_name_normalized LIKE ?
       OR mo.customer_name LIKE ?
    ORDER BY ms.created_at DESC
    LIMIT ?
  `).all(`%${normalized}%`, `%${name.trim()}%`, limit) as any[];

  for (const row of mpRows) {
    results.push(formatMarketplaceResult(row));
  }

  return results.slice(0, limit);
}

/**
 * Parse a date string into Unix timestamp range (start and end of day).
 *
 * Supports:
 * - YYYY-MM-DD (ISO format)
 * - MM/DD/YYYY or MM/DD/YY (US format)
 * - MM/DD (current year implied)
 * - "Jan 15" or "January 15" (current year implied)
 */
function parseDateRange(dateStr: string): { dayStart: number; dayEnd: number } | null {
  const trimmed = dateStr.trim();
  let date: Date | null = null;

  // ISO format: YYYY-MM-DD
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    date = new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
  }

  // US format: MM/DD/YYYY or MM/DD/YY
  if (!date) {
    const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (usMatch) {
      let year = parseInt(usMatch[3]);
      if (year < 100) {
        year += year > 50 ? 1900 : 2000; // 2-digit year handling
      }
      date = new Date(year, parseInt(usMatch[1]) - 1, parseInt(usMatch[2]));
    }
  }

  // Short US format: MM/DD (current year implied)
  if (!date) {
    const shortUsMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (shortUsMatch) {
      const currentYear = new Date().getFullYear();
      date = new Date(currentYear, parseInt(shortUsMatch[1]) - 1, parseInt(shortUsMatch[2]));
    }
  }

  // Month name + day: "Jan 15", "January 15"
  if (!date) {
    const monthNames: Record<string, number> = {
      jan: 0, january: 0,
      feb: 1, february: 1,
      mar: 2, march: 2,
      apr: 3, april: 3,
      may: 4,
      jun: 5, june: 5,
      jul: 6, july: 6,
      aug: 7, august: 7,
      sep: 8, september: 8,
      oct: 9, october: 9,
      nov: 10, november: 10,
      dec: 11, december: 11,
    };
    const monthMatch = trimmed.match(/^([a-z]+)\s+(\d{1,2})$/i);
    if (monthMatch) {
      const monthName = monthMatch[1].toLowerCase();
      const day = parseInt(monthMatch[2]);
      if (monthName in monthNames) {
        const currentYear = new Date().getFullYear();
        date = new Date(currentYear, monthNames[monthName], day);
      }
    }
  }

  if (!date || isNaN(date.getTime())) {
    return null;
  }

  // Get start and end of day in Unix timestamp
  const dayStart = Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000);
  const dayEnd = dayStart + 86400; // Add 24 hours

  return { dayStart, dayEnd };
}

/**
 * Search by order date.
 * Matches against both Stripe fulfillment and marketplace orders.
 */
export function searchByOrderDate(
  db: Database,
  dateStr: string,
  limit: number = 20
): UnifiedFulfillmentSearchResult[] {
  const results: UnifiedFulfillmentSearchResult[] = [];
  const dateRange = parseDateRange(dateStr);

  if (!dateRange) {
    return results; // Invalid date format
  }

  const { dayStart, dayEnd } = dateRange;

  // Search Stripe fulfillments by created_at
  const stripeRows = db.prepare(`
    SELECT f.*, o.order_number, o.order_uid
    FROM fulfillment f
    LEFT JOIN orders o ON f.stripe_session_id = o.stripe_session_id
    WHERE f.created_at >= ? AND f.created_at < ?
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(dayStart, dayEnd, limit) as any[];

  for (const row of stripeRows) {
    results.push(formatStripeResult(row));
  }

  // Search marketplace orders by order_date
  const mpRows = db.prepare(`
    SELECT
      ms.id as shipment_id,
      ms.shipment_sequence,
      ms.carrier,
      ms.service,
      ms.tracking_number,
      ms.tracking_url,
      ms.label_url,
      ms.label_cost_cents,
      ms.label_purchased_at,
      ms.status as shipment_status,
      ms.shipped_at,
      ms.delivered_at,
      ms.exception_type,
      ms.exception_notes,
      ms.created_at as shipment_created_at,
      ms.is_external,
      ms.is_pwe,
      ms.label_viewed_at,
      ms.refund_status,
      ms.easypost_shipment_id,
      ms.fulfilled_by_shipment_id,
      ms.combined_at,
      ms.combined_by,
      mo.id as order_id,
      mo.source,
      mo.external_order_id,
      mo.display_order_number,
      mo.customer_name,
      mo.order_date,
      mo.item_count,
      mo.product_value_cents,
      mo.shipping_fee_cents,
      mo.shipping_method,
      mo.status as order_status,
      mo.import_format,
      parent_mo.display_order_number as parent_order_number,
      (SELECT COUNT(*) FROM marketplace_shipments WHERE fulfilled_by_shipment_id = ms.id) > 0 as is_combined_parent
    FROM marketplace_shipments ms
    JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id
    LEFT JOIN marketplace_shipments parent_ms ON ms.fulfilled_by_shipment_id = parent_ms.id
    LEFT JOIN marketplace_orders parent_mo ON parent_ms.marketplace_order_id = parent_mo.id
    WHERE mo.order_date >= ? AND mo.order_date < ?
    ORDER BY mo.order_date DESC
    LIMIT ?
  `).all(dayStart, dayEnd, limit) as any[];

  for (const row of mpRows) {
    results.push(formatMarketplaceResult(row));
  }

  return results.slice(0, limit);
}

/**
 * Search by card name (marketplace only).
 * Searches product_name and set_name in marketplace_order_items.
 * Returns shipments (not individual items).
 */
export function searchByCardName(
  db: Database,
  query: string,
  limit: number = 20
): UnifiedFulfillmentSearchResult[] {
  const results: UnifiedFulfillmentSearchResult[] = [];
  const searchPattern = `%${query.trim()}%`;

  // Search marketplace orders via items table
  // We need to find shipments where any item matches the card name
  const mpRows = db.prepare(`
    SELECT DISTINCT
      ms.id as shipment_id,
      ms.shipment_sequence,
      ms.carrier,
      ms.service,
      ms.tracking_number,
      ms.tracking_url,
      ms.label_url,
      ms.label_cost_cents,
      ms.label_purchased_at,
      ms.status as shipment_status,
      ms.shipped_at,
      ms.delivered_at,
      ms.exception_type,
      ms.exception_notes,
      ms.created_at as shipment_created_at,
      ms.is_external,
      ms.is_pwe,
      ms.label_viewed_at,
      ms.refund_status,
      ms.easypost_shipment_id,
      ms.fulfilled_by_shipment_id,
      ms.combined_at,
      ms.combined_by,
      mo.id as order_id,
      mo.source,
      mo.external_order_id,
      mo.display_order_number,
      mo.customer_name,
      mo.order_date,
      mo.item_count,
      mo.product_value_cents,
      mo.shipping_fee_cents,
      mo.shipping_method,
      mo.status as order_status,
      mo.import_format,
      parent_mo.display_order_number as parent_order_number,
      (SELECT COUNT(*) FROM marketplace_shipments WHERE fulfilled_by_shipment_id = ms.id) > 0 as is_combined_parent
    FROM marketplace_shipments ms
    JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id
    JOIN marketplace_order_items moi ON moi.marketplace_order_id = mo.id
    LEFT JOIN marketplace_shipments parent_ms ON ms.fulfilled_by_shipment_id = parent_ms.id
    LEFT JOIN marketplace_orders parent_mo ON parent_ms.marketplace_order_id = parent_mo.id
    WHERE moi.product_name LIKE ?
       OR moi.set_name LIKE ?
    ORDER BY mo.order_date DESC
    LIMIT ?
  `).all(searchPattern, searchPattern, limit) as any[];

  for (const row of mpRows) {
    results.push(formatMarketplaceResult(row));
  }

  return results.slice(0, limit);
}

/**
 * Format Stripe fulfillment row to unified search result
 */
function formatStripeResult(row: any): UnifiedFulfillmentSearchResult {
  return {
    id: `stripe:${row.stripe_session_id}`,
    source: "cardmint",
    orderNumber: row.order_number ?? `Session: ${row.stripe_session_id.slice(-8)}`,
    customerName: null,
    itemCount: row.item_count,
    valueCents: row.final_subtotal_cents,
    shippingCostCents: row.shipping_cost_cents,
    shippingMethod: row.shipping_method,
    status: row.status,
    isExternal: false,
    isPwe: false,
    shipping: {
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
      trackingUrl: row.tracking_url,
      service: row.easypost_service,
      labelUrl: row.label_url,
      labelCostCents: row.label_cost_cents,
      labelPurchasedAt: row.label_purchased_at,
    },
    timeline: {
      createdAt: row.created_at,
      shippedAt: row.shipped_at,
      deliveredAt: row.delivered_at,
    },
    exception: row.exception_type
      ? { type: row.exception_type, notes: row.exception_notes }
      : null,
    sourceRef: {
      stripeSessionId: row.stripe_session_id,
    },
  };
}

/**
 * Format marketplace shipment row to unified search result
 */
function formatMarketplaceResult(row: any): UnifiedFulfillmentSearchResult {
  const effectiveStatus = row.is_pwe === 1 ? "shipped" : row.shipment_status;
  const isCombinedChild = row.fulfilled_by_shipment_id != null;
  const isCombinedParent = row.is_combined_parent === 1 || row.is_combined_parent === true;

  return {
    id: `mp:${row.shipment_id}`,
    source: row.source as "tcgplayer" | "ebay",
    orderNumber:
      row.source === "tcgplayer"
        ? formatTcgplayerOrderNumber(row.external_order_id)
        : row.display_order_number,
    customerName: row.customer_name,
    itemCount: row.item_count,
    valueCents: row.product_value_cents,
    shippingCostCents: row.shipping_fee_cents,
    shippingMethod: row.shipping_method,
    status: effectiveStatus,
    isExternal: row.is_external === 1,
    isPwe: row.is_pwe === 1,
    importFormat: row.import_format,
    shipping: {
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
      trackingUrl: row.tracking_url,
      service: row.service,
      labelUrl: row.label_url,
      labelCostCents: row.label_cost_cents,
      labelPurchasedAt: row.label_purchased_at,
      labelViewedAt: row.label_viewed_at,
    },
    timeline: {
      createdAt: row.order_date,
      shippedAt: row.shipped_at,
      deliveredAt: row.delivered_at,
    },
    exception: row.exception_type
      ? { type: row.exception_type, notes: row.exception_notes }
      : null,
    refundStatus: row.refund_status,
    easypostShipmentId: row.easypost_shipment_id,
    // Combined shipment metadata
    combinedWith: isCombinedChild
      ? {
          parentShipmentId: row.fulfilled_by_shipment_id,
          parentOrderNumber: row.parent_order_number,
          combinedAt: row.combined_at,
          combinedBy: row.combined_by,
        }
      : null,
    isCombinedParent,
    labelActionsDisabled: isCombinedChild,
    sourceRef: {
      marketplaceOrderId: row.order_id,
      shipmentId: row.shipment_id,
      externalOrderId: row.external_order_id,
    },
  };
}
