/**
 * Cart Reservation Routes
 *
 * Handles cart-level item reservations for WYSIWYG inventory model.
 * Items are reserved immediately on add to cart (15-min TTL).
 *
 * Security measures:
 * - Rate limiting per IP (30 reserves/min)
 * - Max items per call (5)
 * - Max items per cart session (10)
 * - Max extension window (60 min total hold)
 * - Atomic operations (UPDATE-with-conditions)
 *
 * Reference: cart-reservation-system plan Dec 18
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import type { Database } from "better-sqlite3";
import { runtimeConfig } from "../config";

// Rate limit window in seconds
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Max items per reserve call
const MAX_ITEMS_PER_CALL = 5;

interface CartReserveRequest {
  product_uids: string[];
  cart_session_id: string;
}

interface CartReleaseRequest {
  product_uids: string[];
  cart_session_id: string;
}

interface CartValidateRequest {
  product_uids: string[];
  cart_session_id: string;
}

interface ReserveFailure {
  product_uid: string;
  reason: "UNAVAILABLE" | "MAX_ITEMS_EXCEEDED" | "RATE_LIMITED" | "ALREADY_RESERVED";
}

/**
 * Check rate limit for IP address.
 * Returns true if within limit, false if exceeded.
 */
function checkRateLimit(
  db: Database,
  ipAddress: string,
  maxRequestsPerMinute: number
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % RATE_LIMIT_WINDOW_SECONDS);

  // Try to increment existing counter
  const result = db
    .prepare(
      `INSERT INTO cart_rate_limits (ip_address, window_start, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT(ip_address, window_start) DO UPDATE
       SET request_count = request_count + 1
       RETURNING request_count`
    )
    .get(ipAddress, windowStart) as { request_count: number } | undefined;

  const count = result?.request_count ?? 1;

  // Clean up old entries (older than 5 minutes)
  db.prepare("DELETE FROM cart_rate_limits WHERE window_start < ?").run(now - 300);

  return count <= maxRequestsPerMinute;
}

/**
 * Get client IP from request.
 * Note: Express is configured with `trust proxy`, so `req.ip` reflects the real client.
 */
function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function registerCartRoutes(app: Express, ctx: AppContext): void {
  const { db, logger, inventoryService } = ctx;
  const log = logger.child({ module: "cart-routes" });

  // Cart settings from runtime config
  const ttlSeconds = runtimeConfig.cartReservationTtlMinutes * 60;
  const maxItemsPerSession = runtimeConfig.cartMaxItemsPerSession;
  const maxExtensionWindowSeconds = runtimeConfig.cartMaxExtensionWindowMinutes * 60;
  const rateLimitRpm = runtimeConfig.cartReserveRateLimitRpm;

  /**
   * POST /api/cart/reserve
   * Reserve items for cart - called when customer adds to cart
   */
  app.post("/api/cart/reserve", async (req: Request, res: Response) => {
    try {
      const body = req.body as CartReserveRequest;

      // Validate request body
      if (!body.product_uids || !Array.isArray(body.product_uids)) {
        return res.status(400).json({ ok: false, message: "product_uids array required" });
      }
      if (!body.cart_session_id || typeof body.cart_session_id !== "string") {
        return res.status(400).json({ ok: false, message: "cart_session_id required" });
      }

      // UUID format validation (basic check)
      if (!/^[0-9a-f-]{36}$/i.test(body.cart_session_id)) {
        return res.status(400).json({ ok: false, message: "Invalid cart_session_id format" });
      }

      const productUids = body.product_uids.slice(0, MAX_ITEMS_PER_CALL); // Enforce max
      const cartSessionId = body.cart_session_id;

      // Rate limiting
      const clientIp = getClientIp(req);
      if (!checkRateLimit(db, clientIp, rateLimitRpm)) {
        log.warn({ ip: clientIp, cartSessionId }, "Cart reserve rate limit exceeded");
        return res.status(429).json({
          ok: false,
          message: "Rate limit exceeded. Try again in a minute.",
          reserved: [],
          failed: productUids.map((uid) => ({ product_uid: uid, reason: "RATE_LIMITED" })),
        });
      }

      // Check current cart item count
      const currentCount = inventoryService.countCartSessionItems(cartSessionId);
      const availableSlots = maxItemsPerSession - currentCount;

      if (availableSlots <= 0) {
        log.warn({ cartSessionId, currentCount }, "Cart max items exceeded");
        return res.status(400).json({
          ok: false,
          message: `Cart is full. Maximum ${maxItemsPerSession} items allowed.`,
          reserved: [],
          failed: productUids.map((uid) => ({ product_uid: uid, reason: "MAX_ITEMS_EXCEEDED" })),
        });
      }

      const now = Math.floor(Date.now() / 1000);
      const reservedUntil = now + ttlSeconds;

      const reserved: string[] = [];
      const failed: ReserveFailure[] = [];

      // Process each product_uid (up to available slots)
      for (const productUid of productUids) {
        if (reserved.length >= availableSlots) {
          failed.push({ product_uid: productUid, reason: "MAX_ITEMS_EXCEEDED" });
          continue;
        }

        // Check if already reserved by this cart
        const existing = inventoryService.getReservedItemForProduct(productUid, cartSessionId);
        if (existing) {
          // Already reserved - extend TTL instead of failing
          const extended = inventoryService.extendCartReservation(
            existing.item_uid,
            cartSessionId,
            reservedUntil,
            maxExtensionWindowSeconds
          );
          if (extended) {
            reserved.push(productUid);
          } else {
            failed.push({ product_uid: productUid, reason: "ALREADY_RESERVED" });
          }
          continue;
        }

        // Find an available item for this product
        const itemUid = inventoryService.getAvailableItemForProduct(productUid);
        if (!itemUid) {
          failed.push({ product_uid: productUid, reason: "UNAVAILABLE" });
          continue;
        }

        // Atomic reserve
        const success = inventoryService.reserveItemForCart(itemUid, cartSessionId, reservedUntil);
        if (success) {
          reserved.push(productUid);
          log.info({ productUid, itemUid, cartSessionId }, "Item reserved for cart");
        } else {
          // Race condition - another customer grabbed it
          failed.push({ product_uid: productUid, reason: "UNAVAILABLE" });
        }
      }

      // Recount from DB to ensure accuracy (handles extensions correctly)
      const newCount = inventoryService.countCartSessionItems(cartSessionId);

      return res.json({
        ok: true,
        reserved,
        failed,
        expires_at: reservedUntil,
        cart_item_count: newCount,
      });
    } catch (error) {
      log.error({ err: error }, "Cart reserve failed");
      return res.status(500).json({ ok: false, message: "Internal server error" });
    }
  });

  /**
   * POST /api/cart/release
   * Release items from cart reservation - called when customer removes from cart
   */
  app.post("/api/cart/release", async (req: Request, res: Response) => {
    try {
      const body = req.body as CartReleaseRequest;

      if (!body.product_uids || !Array.isArray(body.product_uids)) {
        return res.status(400).json({ ok: false, message: "product_uids array required" });
      }
      if (!body.cart_session_id || typeof body.cart_session_id !== "string") {
        return res.status(400).json({ ok: false, message: "cart_session_id required" });
      }

      const productUids = body.product_uids;
      const cartSessionId = body.cart_session_id;

      const released: string[] = [];
      const notFound: string[] = [];

      for (const productUid of productUids) {
        // Find the reserved item for this product + cart session
        const item = inventoryService.getReservedItemForProduct(productUid, cartSessionId);
        if (!item) {
          notFound.push(productUid);
          continue;
        }

        // Release it
        const success = inventoryService.releaseCartReservation(item.item_uid, cartSessionId);
        if (success) {
          released.push(productUid);
          log.info({ productUid, itemUid: item.item_uid, cartSessionId }, "Cart item released");
        } else {
          notFound.push(productUid);
        }
      }

      return res.json({
        ok: true,
        released,
        not_found: notFound,
      });
    } catch (error) {
      log.error({ err: error }, "Cart release failed");
      return res.status(500).json({ ok: false, message: "Internal server error" });
    }
  });

  /**
   * POST /api/cart/validate
   * Validate cart items are still reserved - called on cart page load
   */
  app.post("/api/cart/validate", async (req: Request, res: Response) => {
    try {
      const body = req.body as CartValidateRequest;

      if (!body.product_uids || !Array.isArray(body.product_uids)) {
        return res.status(400).json({ ok: false, message: "product_uids array required" });
      }
      if (!body.cart_session_id || typeof body.cart_session_id !== "string") {
        return res.status(400).json({ ok: false, message: "cart_session_id required" });
      }

      const productUids = body.product_uids;
      const cartSessionId = body.cart_session_id;
      const now = Math.floor(Date.now() / 1000);

      const valid: string[] = [];
      const expired: string[] = [];
      const unavailable: string[] = [];

      for (const productUid of productUids) {
        const item = inventoryService.getReservedItemForProduct(productUid, cartSessionId);

        if (!item) {
          // Not reserved by this cart - could have expired or been taken
          unavailable.push(productUid);
          continue;
        }

        if (item.reserved_until < now) {
          // Reservation expired (expiry job will clean up)
          expired.push(productUid);
        } else {
          // Still valid
          valid.push(productUid);
        }
      }

      return res.json({
        ok: true,
        valid,
        expired,
        unavailable,
      });
    } catch (error) {
      log.error({ err: error }, "Cart validate failed");
      return res.status(500).json({ ok: false, message: "Internal server error" });
    }
  });

  /**
   * DELETE /api/cart/session/:cartSessionId
   * Clear entire cart session - releases all items
   */
  app.delete("/api/cart/session/:cartSessionId", async (req: Request, res: Response) => {
    try {
      const cartSessionId = req.params.cartSessionId;

      if (!cartSessionId || !/^[0-9a-f-]{36}$/i.test(cartSessionId)) {
        return res.status(400).json({ ok: false, message: "Invalid cart_session_id" });
      }

      const releasedCount = inventoryService.releaseCartSession(cartSessionId);
      log.info({ cartSessionId, releasedCount }, "Cart session cleared");

      return res.json({
        ok: true,
        released: releasedCount,
      });
    } catch (error) {
      log.error({ err: error }, "Cart session clear failed");
      return res.status(500).json({ ok: false, message: "Internal server error" });
    }
  });

  log.info("Cart routes registered");
}
