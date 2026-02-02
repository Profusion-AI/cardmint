/**
 * Refund Eligibility Check
 *
 * Determines if a marketplace shipment is eligible for label refund.
 * Uses EasyPost status cache with TTL to avoid excessive API calls.
 *
 * Eligibility rules:
 * 1. Must have easypost_shipment_id
 * 2. refund_status must be null (no pending/completed refund)
 * 3. Status is 'label_purchased' → eligible (no EasyPost call needed)
 * 4. Status is 'shipped' → check EasyPost pre_transit status
 * 5. Status is 'in_transit', 'delivered' → not eligible
 */

import type { Database } from "better-sqlite3";
import type { EasyPostService } from "../services/easyPostService.js";

/** Cache TTL in seconds (5 minutes) */
const CACHE_TTL_SECONDS = 5 * 60;

/** EasyPost API timeout in milliseconds */
const EASYPOST_TIMEOUT_MS = 5000;

export interface RefundEligibilityResult {
  eligible: boolean;
  reason: string;
  easypostStatus?: string | null;
  cached: boolean;
}

export interface MarketplaceShipmentForRefund {
  id: number;
  status: string;
  easypost_shipment_id: string | null;
  refund_status: string | null;
  easypost_status_cached: string | null;
  easypost_status_cached_at: number | null;
}

/**
 * Check if a shipment is eligible for refund.
 *
 * @param shipment - The marketplace shipment to check
 * @param easyPostService - EasyPost service for live status checks
 * @param db - Database for cache operations
 * @returns Eligibility result with reason and cache status
 */
export async function isRefundEligible(
  shipment: MarketplaceShipmentForRefund,
  easyPostService: EasyPostService,
  db: Database
): Promise<RefundEligibilityResult> {
  // 1. Must have easypost_shipment_id
  if (!shipment.easypost_shipment_id) {
    return {
      eligible: false,
      reason: "NO_EASYPOST_SHIPMENT",
      cached: false,
    };
  }

  // 2. refund_status must be null (no pending/completed refund)
  if (shipment.refund_status) {
    return {
      eligible: false,
      reason: `REFUND_ALREADY_${shipment.refund_status.toUpperCase()}`,
      cached: false,
    };
  }

  // 3. Status is 'label_purchased' → eligible (no EasyPost call needed)
  if (shipment.status === "label_purchased") {
    return {
      eligible: true,
      reason: "LABEL_PURCHASED",
      cached: false,
    };
  }

  // 4. Status is 'shipped' → check EasyPost pre_transit status
  if (shipment.status === "shipped") {
    const cacheResult = checkCache(shipment);

    if (cacheResult.valid) {
      // Use cached status
      return evaluateEasypostStatus(cacheResult.status!, true);
    }

    // Cache miss or stale - fetch from EasyPost
    try {
      const liveStatus = await fetchEasypostStatusWithTimeout(
        shipment.easypost_shipment_id,
        easyPostService,
        EASYPOST_TIMEOUT_MS
      );

      if (liveStatus.error) {
        return {
          eligible: false,
          reason: liveStatus.error,
          cached: false,
        };
      }

      // Update cache
      updateCache(db, shipment.id, liveStatus.status!);

      return evaluateEasypostStatus(liveStatus.status!, false);
    } catch (err) {
      return {
        eligible: false,
        reason: "EASYPOST_ERROR",
        cached: false,
      };
    }
  }

  // 5. Status is 'in_transit', 'delivered' → not eligible
  if (shipment.status === "in_transit" || shipment.status === "delivered") {
    return {
      eligible: false,
      reason: `SHIPMENT_${shipment.status.toUpperCase()}`,
      cached: false,
    };
  }

  // Pending or other status - not eligible (no label purchased yet)
  return {
    eligible: false,
    reason: `INVALID_STATUS_${shipment.status.toUpperCase()}`,
    cached: false,
  };
}

/**
 * Check if cached status is valid (exists and not stale)
 */
function checkCache(shipment: MarketplaceShipmentForRefund): {
  valid: boolean;
  status: string | null;
} {
  if (!shipment.easypost_status_cached || !shipment.easypost_status_cached_at) {
    return { valid: false, status: null };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cacheAge = nowSec - shipment.easypost_status_cached_at;

  if (cacheAge >= CACHE_TTL_SECONDS) {
    return { valid: false, status: null };
  }

  return { valid: true, status: shipment.easypost_status_cached };
}

/**
 * Evaluate EasyPost tracking status for refund eligibility
 */
function evaluateEasypostStatus(
  status: string,
  cached: boolean
): RefundEligibilityResult {
  const normalizedStatus = status.toLowerCase();

  // pre_transit = label created but not yet scanned by carrier → eligible
  if (normalizedStatus === "pre_transit") {
    return {
      eligible: true,
      reason: "PRE_TRANSIT",
      easypostStatus: status,
      cached,
    };
  }

  // unknown = EasyPost hasn't received carrier data yet → eligible (conservative)
  if (normalizedStatus === "unknown") {
    return {
      eligible: true,
      reason: "STATUS_UNKNOWN",
      easypostStatus: status,
      cached,
    };
  }

  // in_transit, out_for_delivery, delivered, etc. → not eligible
  return {
    eligible: false,
    reason: `CARRIER_STATUS_${normalizedStatus.toUpperCase()}`,
    easypostStatus: status,
    cached,
  };
}

/**
 * Fetch EasyPost shipment status with timeout.
 * Uses Promise.race since EasyPostService doesn't support AbortSignal.
 */
async function fetchEasypostStatusWithTimeout(
  shipmentId: string,
  easyPostService: EasyPostService,
  timeoutMs: number
): Promise<{ status: string | null; error: string | null }> {
  const fetchPromise = (async () => {
    try {
      const shipment = await easyPostService.getShipment(shipmentId);

      if (!shipment) {
        return { status: null, error: "EASYPOST_SHIPMENT_NOT_FOUND" };
      }

      return { status: shipment.status, error: null };
    } catch (err) {
      return { status: null, error: "EASYPOST_ERROR" };
    }
  })();

  const timeoutPromise = new Promise<{ status: null; error: string }>((resolve) =>
    setTimeout(() => resolve({ status: null, error: "EASYPOST_TIMEOUT" }), timeoutMs)
  );

  return Promise.race([fetchPromise, timeoutPromise]);
}

/**
 * Update EasyPost status cache
 */
function updateCache(db: Database, shipmentId: number, status: string): void {
  const nowSec = Math.floor(Date.now() / 1000);

  db.prepare(`
    UPDATE marketplace_shipments
    SET easypost_status_cached = ?,
        easypost_status_cached_at = ?,
        updated_at = strftime('%s', 'now')
    WHERE id = ?
  `).run(status, nowSec, shipmentId);
}

/**
 * Get cached EasyPost status for a shipment
 */
export function getCachedEasypostStatus(
  db: Database,
  shipmentId: number
): { status: string | null; cachedAt: number | null; stale: boolean } {
  const row = db
    .prepare(`
      SELECT easypost_status_cached, easypost_status_cached_at
      FROM marketplace_shipments
      WHERE id = ?
    `)
    .get(shipmentId) as {
      easypost_status_cached: string | null;
      easypost_status_cached_at: number | null;
    } | undefined;

  if (!row || !row.easypost_status_cached || !row.easypost_status_cached_at) {
    return { status: null, cachedAt: null, stale: true };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cacheAge = nowSec - row.easypost_status_cached_at;

  return {
    status: row.easypost_status_cached,
    cachedAt: row.easypost_status_cached_at,
    stale: cacheAge >= CACHE_TTL_SECONDS,
  };
}

/**
 * Clear EasyPost status cache for a shipment
 */
export function clearEasypostStatusCache(db: Database, shipmentId: number): void {
  db.prepare(`
    UPDATE marketplace_shipments
    SET easypost_status_cached = NULL,
        easypost_status_cached_at = NULL,
        updated_at = strftime('%s', 'now')
    WHERE id = ?
  `).run(shipmentId);
}
