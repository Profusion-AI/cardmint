/**
 * Stripe Payment Routes
 * Handles checkout sessions, webhooks, and admin Stripe operations
 * Reference: stripe-imp-plan.md, Codex runbook Dec 2
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { runtimeConfig } from "../config";
import { requireAdminAuth } from "../middleware/adminAuth";
import Stripe from "stripe";
import { lotBuilderService } from "../services/lotBuilder/lotBuilderService";
import { getLotPreview, clearLotPreviewCache, getLotPreviewCacheStats } from "../services/lotBuilder/llmDiscountService";
import type { LotBuilderItem, LotPreviewItem } from "../services/lotBuilder/types";
import { quoteShipping } from "../services/shippingResolver";
import type { Cart } from "../domain/shipping";

// Simple in-memory rate limiter for lot preview endpoint
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string, limitRpm: number): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const windowMs = 60_000; // 1 minute window

  const entry = rateLimitMap.get(ip);

  // Clean up old entries periodically (simple GC)
  if (rateLimitMap.size > 10000) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }

  if (!entry || now > entry.resetAt) {
    // New window
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (entry.count >= limitRpm) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  entry.count++;
  return { allowed: true };
}

// Allowed domains for checkout redirect URLs (prevents open redirect attacks)
const REDIRECT_ALLOWLIST = ["cardmintshop.com", "www.cardmintshop.com", "localhost", "127.0.0.1"];

/**
 * Validate redirect URL against domain allowlist.
 * Prevents open redirect attacks via checkout success/cancel URLs.
 * Returns null if URL is invalid or not in allowlist.
 */
function validateRedirectUrl(url: string | undefined, allowedDomains: string[]): string | null {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null; // Invalid URL
  }

  // Only allow http/https protocols
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  // Check hostname against allowlist
  const hostname = parsed.hostname.toLowerCase();
  const isAllowed = allowedDomains.some((domain) => {
    const d = domain.toLowerCase();
    return hostname === d || hostname.endsWith(`.${d}`);
  });

  return isAllowed ? url : null;
}

export function registerStripeRoutes(app: Express, ctx: AppContext): void {
  const { logger, stripeService, inventoryService } = ctx;

  // ==========================================================================
  // Checkout Session Creation
  // ==========================================================================

  /**
   * POST /api/checkout/session
   * Create Stripe checkout session for an item
   * Accepts either item_uid OR product_uid (will find available item)
   * Guards: item must be IN_STOCK, staging_ready=1
   */
  app.post("/api/checkout/session", async (req: Request, res: Response) => {
    let { item_uid } = req.body;
    const { product_uid, success_url, cancel_url } = req.body;

    // Accept either item_uid or product_uid
    if (!item_uid && !product_uid) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "item_uid or product_uid is required",
      });
    }

    // If product_uid provided, find an available item
    if (!item_uid && product_uid) {
      item_uid = inventoryService.getAvailableItemForProduct(product_uid);
      if (!item_uid) {
        return res.status(409).json({
          error: "NO_AVAILABLE_ITEMS",
          message: "No available items for this product",
        });
      }
      logger.debug({ product_uid, item_uid }, "Found available item for product");
    }

    if (!stripeService.isConfigured()) {
      return res.status(503).json({
        error: "STRIPE_NOT_CONFIGURED",
        message: "Stripe payments are not configured",
      });
    }

    try {
      // Get item data
      const item = inventoryService.getItemForCheckout(item_uid);

      if (!item) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: `Item ${item_uid} not found`,
        });
      }

      // Guard: item must be IN_STOCK
      if (item.status !== "IN_STOCK") {
        return res.status(409).json({
          error: "ITEM_NOT_AVAILABLE",
          message: `Item is ${item.status}, not available for checkout`,
        });
      }

      // Guard: staging_ready must be true
      if (!item.staging_ready) {
        return res.status(400).json({
          error: "ITEM_NOT_READY",
          message: "Item is not stage-3 ready for sale",
        });
      }

      // Guard: price must be positive
      if (!item.price_cents || item.price_cents <= 0) {
        return res.status(400).json({
          error: "NO_PRICE",
          message: "Item has no price configured",
        });
      }

      // Create Stripe product/price if needed
      let stripeProductId = item.stripe_product_id;
      let stripePriceId = item.stripe_price_id;

      if (!stripeProductId || !stripePriceId) {
        const stripeData = {
          item_uid: item.item_uid,
          product_uid: item.product_uid,
          cm_card_id: item.cm_card_id,
          set_name: item.set_name,
          collector_no: item.collector_no,
          condition: item.condition,
          canonical_sku: item.canonical_sku,
          name: item.name,
          description: `${item.name} - ${item.set_name ?? "Unknown Set"} ${item.collector_no ?? ""} (${item.condition ?? "Unknown"})`,
          price_cents: item.price_cents,
          image_url: item.image_url,
        };

        const result = await stripeService.createProductAndPrice(stripeData);
        stripeProductId = result.stripeProductId;
        stripePriceId = result.stripePriceId;
      }

      // Determine URLs (validate user-supplied against allowlist, default to safe values)
      const baseUrl = runtimeConfig.evershopApiUrl || "https://cardmintshop.com";
      const validatedSuccessUrl = validateRedirectUrl(success_url, REDIRECT_ALLOWLIST);
      const validatedCancelUrl = validateRedirectUrl(cancel_url, REDIRECT_ALLOWLIST);
      const effectiveSuccessUrl = validatedSuccessUrl || `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
      const effectiveCancelUrl = validatedCancelUrl || `${baseUrl}/checkout/cancel`;

      // Calculate shipping
      const cart: Cart = {
        isUS: true, // US-only enforced by Stripe shipping_address_collection
        quantity: 1,
        subtotal: item.price_cents / 100,
      };
      const shippingQuote = quoteShipping(cart);

      if (!shippingQuote.allowed) {
        return res.status(400).json({
          error: "SHIPPING_NOT_AVAILABLE",
          message: shippingQuote.explanation || "Shipping not available",
        });
      }

      logger.info(
        { item_uid, shippingMethod: shippingQuote.method, shippingCents: shippingQuote.priceCents, requiresReview: shippingQuote.requiresManualReview },
        "Shipping calculated for checkout"
      );

      // Create checkout session with shipping
      const session = await stripeService.createCheckoutSession(
        {
          item_uid: item.item_uid,
          product_uid: item.product_uid,
          cm_card_id: item.cm_card_id,
          set_name: item.set_name,
          collector_no: item.collector_no,
          condition: item.condition,
          canonical_sku: item.canonical_sku,
          name: item.name,
          description: `${item.name} - ${item.set_name ?? "Unknown Set"}`,
          price_cents: item.price_cents,
          image_url: item.image_url,
        },
        stripePriceId,
        shippingQuote,
        effectiveSuccessUrl,
        effectiveCancelUrl
      );

      // Reserve item (transactional update)
      const reserved = inventoryService.reserveItem(
        item_uid,
        session.sessionId,
        stripeProductId,
        stripePriceId,
        session.expiresAt
      );

      if (!reserved) {
        // Race condition - item was taken. Expire the session.
        logger.warn({ item_uid, sessionId: session.sessionId }, "Failed to reserve - expiring session");
        await stripeService.expireCheckoutSession(session.sessionId);
        return res.status(409).json({
          error: "ITEM_NOT_AVAILABLE",
          message: "Item was taken by another buyer",
        });
      }

      logger.info(
        { item_uid, sessionId: session.sessionId, checkoutUrl: session.checkoutUrl },
        "Checkout session created"
      );

      res.json({
        ok: true,
        checkout_url: session.checkoutUrl,
        session_id: session.sessionId,
        expires_at: session.expiresAt,
      });
    } catch (error) {
      logger.error({ err: error, item_uid }, "Failed to create checkout session");
      res.status(500).json({
        error: "CHECKOUT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/checkout/session/multi
   * Create Stripe checkout session for multiple items (Lot Builder)
   * Accepts array of product_uids, calculates lot discount, reserves all atomically
   */
  app.post("/api/checkout/session/multi", async (req: Request, res: Response) => {
    const { product_uids, success_url, cancel_url, cart_session_id } = req.body;

    // Validate input
    if (!Array.isArray(product_uids) || product_uids.length === 0) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "product_uids array is required and must not be empty",
      });
    }

    if (product_uids.length > 10) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "Maximum 10 items per checkout",
      });
    }

    // Optional cart_session_id for cart-reserved items
    const hasCartSession = cart_session_id && typeof cart_session_id === "string" && /^[0-9a-f-]{36}$/i.test(cart_session_id);

    if (!stripeService.isConfigured()) {
      return res.status(503).json({
        error: "STRIPE_NOT_CONFIGURED",
        message: "Stripe payments are not configured",
      });
    }

    try {
      // Step 1: Resolve all product_uids to available items
      // Now supports both cart-reserved items (promote) and fresh items (reserve)
      const items: Array<{
        item_uid: string;
        product_uid: string;
        itemData: ReturnType<typeof inventoryService.getItemForCheckout>;
        wasCartReserved: boolean; // Track if item was cart-reserved for later promotion
      }> = [];

      for (const product_uid of product_uids) {
        let item_uid: string | null = null;
        let wasCartReserved = false;

        // Check if item is already cart-reserved by this session
        if (hasCartSession) {
          const cartReserved = inventoryService.getReservedItemForProduct(product_uid, cart_session_id);
          if (cartReserved) {
            item_uid = cartReserved.item_uid;
            wasCartReserved = true;
          }
        }

        // If not cart-reserved, look for available IN_STOCK item
        if (!item_uid) {
          item_uid = inventoryService.getAvailableItemForProduct(product_uid);
        }

        if (!item_uid) {
          return res.status(409).json({
            error: "NO_AVAILABLE_ITEMS",
            message: `No available item for product ${product_uid}`,
            product_uid,
          });
        }

        const itemData = inventoryService.getItemForCheckout(item_uid);
        if (!itemData) {
          return res.status(404).json({
            error: "NOT_FOUND",
            message: `Item ${item_uid} not found`,
          });
        }

        // Guard checks - allow RESERVED status if it's our cart reservation
        if (itemData.status !== "IN_STOCK" && !wasCartReserved) {
          return res.status(409).json({
            error: "ITEM_NOT_AVAILABLE",
            message: `Item is ${itemData.status}, not available`,
            product_uid,
          });
        }

        if (!itemData.staging_ready) {
          return res.status(400).json({
            error: "ITEM_NOT_READY",
            message: "Item not stage-3 ready",
            product_uid,
          });
        }

        if (!itemData.price_cents || itemData.price_cents <= 0) {
          return res.status(400).json({
            error: "NO_PRICE",
            message: "Item has no price",
            product_uid,
          });
        }

        items.push({ item_uid, product_uid, itemData, wasCartReserved });
      }

      // Step 2: Calculate lot discount
      const lotBuilderItems: LotBuilderItem[] = items.map((i) => ({
        product_uid: i.product_uid,
        price_cents: i.itemData!.price_cents,
        set_name: i.itemData!.set_name ?? "",
        rarity: i.itemData!.rarity ?? "",
        condition: i.itemData!.condition ?? "",
      }));

      const lotResult = lotBuilderService.calculateDiscount(lotBuilderItems);

      logger.info(
        {
          itemCount: items.length,
          discountPct: lotResult.discountPct,
          reasonCode: lotResult.reasonCode,
          subtotalCents: lotResult.subtotalBeforeDiscountCents,
          finalCents: lotResult.finalTotalCents,
        },
        "Lot discount calculated"
      );

      // Step 3: Ensure Stripe products/prices exist for all items
      const stripeItems: Array<{
        itemData: NonNullable<ReturnType<typeof inventoryService.getItemForCheckout>>;
        stripeProductId: string;
        stripePriceId: string;
      }> = [];

      for (const { itemData } of items) {
        let stripeProductId = itemData!.stripe_product_id;
        let stripePriceId = itemData!.stripe_price_id;

        if (!stripeProductId || !stripePriceId) {
          const stripeData = {
            item_uid: itemData!.item_uid,
            product_uid: itemData!.product_uid,
            cm_card_id: itemData!.cm_card_id,
            set_name: itemData!.set_name,
            collector_no: itemData!.collector_no,
            condition: itemData!.condition,
            canonical_sku: itemData!.canonical_sku,
            name: itemData!.name,
            description: `${itemData!.name} - ${itemData!.set_name ?? "Unknown Set"} ${itemData!.collector_no ?? ""} (${itemData!.condition ?? "Unknown"})`,
            price_cents: itemData!.price_cents,
            image_url: itemData!.image_url,
          };

          const result = await stripeService.createProductAndPrice(stripeData);
          stripeProductId = result.stripeProductId;
          stripePriceId = result.stripePriceId;
        }

        stripeItems.push({
          itemData: itemData!,
          stripeProductId,
          stripePriceId,
        });
      }

      // Step 4: Calculate shipping for the lot
      // Use final total after discount for shipping threshold calculation
      const multiCart: Cart = {
        isUS: true, // US-only enforced by Stripe shipping_address_collection
        quantity: items.length,
        subtotal: lotResult.finalTotalCents / 100,
      };
      const multiShippingQuote = quoteShipping(multiCart);

      if (!multiShippingQuote.allowed) {
        return res.status(400).json({
          error: "SHIPPING_NOT_AVAILABLE",
          message: multiShippingQuote.explanation || "Shipping not available",
        });
      }

      logger.info(
        { itemCount: items.length, shippingMethod: multiShippingQuote.method, shippingCents: multiShippingQuote.priceCents, requiresReview: multiShippingQuote.requiresManualReview },
        "Shipping calculated for multi-item checkout"
      );

      // Step 5: Create multi-item checkout session with shipping
      // Validate user-supplied URLs against allowlist, default to safe values
      const baseUrl = runtimeConfig.evershopApiUrl || "https://cardmintshop.com";
      const validatedSuccessUrl = validateRedirectUrl(success_url, REDIRECT_ALLOWLIST);
      const validatedCancelUrl = validateRedirectUrl(cancel_url, REDIRECT_ALLOWLIST);
      const effectiveSuccessUrl = validatedSuccessUrl || `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
      const effectiveCancelUrl = validatedCancelUrl || `${baseUrl}/checkout/cancel`;

      const stripeItemData = stripeItems.map((s) => ({
        item_uid: s.itemData.item_uid,
        product_uid: s.itemData.product_uid,
        cm_card_id: s.itemData.cm_card_id,
        set_name: s.itemData.set_name,
        collector_no: s.itemData.collector_no,
        condition: s.itemData.condition,
        canonical_sku: s.itemData.canonical_sku,
        name: s.itemData.name,
        description: `${s.itemData.name} - ${s.itemData.set_name ?? "Unknown Set"}`,
        price_cents: s.itemData.price_cents,
        image_url: s.itemData.image_url,
      }));

      const lotDiscountInfo = lotResult.discountPct > 0
        ? {
            discountPct: lotResult.discountPct,
            discountAmountCents: lotResult.discountAmountCents,
            reasonCode: lotResult.reasonCode,
            reasonText: lotResult.reasonText,
            originalTotalCents: lotResult.subtotalBeforeDiscountCents,
            finalTotalCents: lotResult.finalTotalCents,
          }
        : null;

      const session = await stripeService.createMultiItemCheckoutSession(
        stripeItemData,
        stripeItems.map((s) => s.stripePriceId),
        multiShippingQuote,
        lotDiscountInfo,
        effectiveSuccessUrl,
        effectiveCancelUrl
      );

      // Step 6: Reserve or promote all items atomically
      // Cart-reserved items are promoted to checkout; fresh items are reserved new
      const reservedItems: string[] = [];
      const promotedItems: string[] = [];
      let reservationFailed = false;

      for (let i = 0; i < stripeItems.length; i++) {
        const { itemData, stripeProductId, stripePriceId } = stripeItems[i];
        const wasCartReserved = items[i].wasCartReserved;

        let success: boolean;

        if (wasCartReserved && hasCartSession) {
          // Promote cart reservation to checkout reservation
          success = inventoryService.promoteCartToCheckout(
            itemData.item_uid,
            cart_session_id,
            session.sessionId,
            stripeProductId,
            stripePriceId,
            session.expiresAt
          );
          if (success) {
            promotedItems.push(itemData.item_uid);
          }
        } else {
          // Fresh reservation for IN_STOCK item
          success = inventoryService.reserveItem(
            itemData.item_uid,
            session.sessionId,
            stripeProductId,
            stripePriceId,
            session.expiresAt
          );
        }

        if (!success) {
          reservationFailed = true;
          break;
        }
        reservedItems.push(itemData.item_uid);
      }

      // Rollback if any reservation failed
      if (reservationFailed) {
        for (const itemUid of reservedItems) {
          inventoryService.releaseReservation(itemUid);
        }
        await stripeService.expireCheckoutSession(session.sessionId);

        return res.status(409).json({
          error: "RESERVATION_FAILED",
          message: "One or more items were taken by another buyer",
        });
      }

      logger.info(
        {
          sessionId: session.sessionId,
          itemCount: items.length,
          itemUids: session.itemUids,
          discountPct: lotResult.discountPct,
        },
        "Multi-item checkout session created"
      );

      res.json({
        ok: true,
        checkout_url: session.checkoutUrl,
        session_id: session.sessionId,
        expires_at: session.expiresAt,
        item_count: items.length,
        lot_discount: lotDiscountInfo,
      });
    } catch (error) {
      logger.error({ err: error, product_uids }, "Failed to create multi-item checkout");
      res.status(500).json({
        error: "CHECKOUT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==========================================================================
  // Lot Preview (LLM-Enhanced Discount)
  // ==========================================================================

  /**
   * POST /api/lot/preview
   * Get real-time discount preview with LLM validation and creative text
   * Does NOT reserve items - use this before checkout to show discount
   *
   * Response includes:
   * - systemDiscountPct: Deterministic base calculation
   * - llmAdjustedPct: LLM-adjusted percentage (±5pp variance)
   * - llmReasonText: Creative reason text with theme detection
   * - themeBundle: Detected theme (e.g., "Gen 1 Collection")
   * - cached: Whether response came from cache
   */
  app.post("/api/lot/preview", async (req: Request, res: Response) => {
    // Rate limiting to prevent LLM spend abuse
    // Use req.ip which respects the "trust proxy 1" setting configured in http.ts
    const clientIp = req.ip || "unknown";
    const rateCheck = checkRateLimit(clientIp, runtimeConfig.lotBuilderRateLimitRpm);

    if (!rateCheck.allowed) {
      logger.warn({ ip: clientIp, retryAfter: rateCheck.retryAfter }, "Lot preview rate limited");
      res.setHeader("Retry-After", String(rateCheck.retryAfter));
      return res.status(429).json({
        error: "RATE_LIMITED",
        message: "Too many preview requests. Please try again later.",
        retry_after_sec: rateCheck.retryAfter,
      });
    }

    const { product_uids } = req.body;

    // Validate input
    if (!Array.isArray(product_uids) || product_uids.length === 0) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "product_uids array is required and must not be empty",
      });
    }

    if (product_uids.length > 10) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "Maximum 10 items per preview",
      });
    }

    try {
      // Resolve all product_uids to items (but don't reserve them)
      const previewItems: LotPreviewItem[] = [];

      for (const product_uid of product_uids) {
        const item_uid = inventoryService.getAvailableItemForProduct(product_uid);
        if (!item_uid) {
          return res.status(409).json({
            error: "NO_AVAILABLE_ITEMS",
            message: `No available item for product ${product_uid}`,
            product_uid,
          });
        }

        const itemData = inventoryService.getItemForCheckout(item_uid);
        if (!itemData) {
          return res.status(404).json({
            error: "NOT_FOUND",
            message: `Item ${item_uid} not found`,
          });
        }

        // Build preview item (includes card_name for LLM theme detection)
        previewItems.push({
          product_uid: itemData.product_uid,
          price_cents: itemData.price_cents,
          set_name: itemData.set_name ?? "",
          rarity: itemData.rarity ?? "",
          condition: itemData.condition ?? "",
          card_name: itemData.name,
          card_number: itemData.collector_no ?? undefined,
          image_url: itemData.image_url ?? undefined,
        });
      }

      // Get LLM-enhanced discount preview
      const preview = await getLotPreview(previewItems);

      logger.info(
        {
          itemCount: previewItems.length,
          systemPct: preview.systemDiscountPct,
          llmPct: preview.llmAdjustedPct,
          cached: preview.cached,
          model: preview.model,
          themeBundle: preview.themeBundle,
        },
        "Lot preview calculated"
      );

      res.json({
        ok: true,
        preview: {
          // Final discount values (use these for display)
          discountPct: preview.discountPct,
          discountAmountCents: preview.discountAmountCents,
          subtotalCents: preview.subtotalBeforeDiscountCents,
          finalTotalCents: preview.finalTotalCents,
          reasonText: preview.llmReasonText,
          // Debug/analytics fields
          systemDiscountPct: preview.systemDiscountPct,
          llmAdjustedPct: preview.llmAdjustedPct,
          reasonCode: preview.reasonCode,
          reasonTags: preview.reasonTags,
          themeBundle: preview.themeBundle,
          confidence: preview.confidence,
          cached: preview.cached,
          model: preview.model,
        },
        items: previewItems.map((i) => ({
          product_uid: i.product_uid,
          card_name: i.card_name,
          set_name: i.set_name,
          price_cents: i.price_cents,
        })),
      });
    } catch (error) {
      logger.error({ err: error, product_uids }, "Failed to get lot preview");
      res.status(500).json({
        error: "PREVIEW_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * DELETE /api/lot/preview/cache
   * Clear the LLM response cache (admin only - requires LOTBUILDER_ADMIN_TOKEN)
   */
  app.delete("/api/lot/preview/cache", (req: Request, res: Response) => {
    const adminToken = runtimeConfig.lotBuilderAdminToken;
    if (!adminToken) {
      return res.status(503).json({
        error: "NOT_CONFIGURED",
        message: "Admin token not configured",
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
      logger.warn({ ip: req.ip }, "Unauthorized cache clear attempt");
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Invalid or missing admin token",
      });
    }

    clearLotPreviewCache();
    logger.info({ ip: req.ip }, "Lot preview cache cleared by admin");
    res.json({ ok: true, message: "Cache cleared" });
  });

  /**
   * GET /api/lot/preview/cache/stats
   * Get cache statistics (admin only - requires LOTBUILDER_ADMIN_TOKEN)
   */
  app.get("/api/lot/preview/cache/stats", (req: Request, res: Response) => {
    const adminToken = runtimeConfig.lotBuilderAdminToken;
    if (!adminToken) {
      return res.status(503).json({
        error: "NOT_CONFIGURED",
        message: "Admin token not configured",
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Invalid or missing admin token",
      });
    }

    const stats = getLotPreviewCacheStats();
    res.json({ ok: true, stats });
  });

  // ==========================================================================
  // Cancel Checkout Session
  // ==========================================================================

  /**
   * POST /api/checkout/session/:sessionId/cancel
   * Cancel an active checkout session and release the reserved item.
   * Called by the cart when user removes an item or abandons checkout.
   *
   * IMPORTANT: Will NOT release inventory if session is already paid/complete.
   * This prevents double-sell scenarios where success page or stale client
   * accidentally releases inventory that the webhook should mark as SOLD.
   */
  app.post("/api/checkout/session/:sessionId/cancel", async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "sessionId is required",
      });
    }

    try {
      // CRITICAL: Check Stripe session payment status before releasing inventory.
      // If the session is paid/complete, refuse to release - webhook will mark SOLD.
      // FAIL-CLOSED: If we can't verify status, refuse to release (prevents double-sell on API errors).
      if (stripeService.isConfigured()) {
        try {
          const stripeSession = await stripeService.getCheckoutSession(sessionId);
          if (stripeSession.payment_status === "paid" || stripeSession.status === "complete") {
            logger.info(
              { sessionId, payment_status: stripeSession.payment_status, status: stripeSession.status },
              "Cancel rejected: session already paid/complete - inventory protected"
            );
            return res.status(409).json({
              ok: false,
              error: "SESSION_ALREADY_PAID",
              message: "Cannot cancel a paid session. Inventory will be marked SOLD by webhook.",
              payment_status: stripeSession.payment_status,
              status: stripeSession.status,
            });
          }
          // Session exists and is NOT paid - safe to proceed with release
        } catch (stripeError: unknown) {
          // FAIL-CLOSED: Only proceed if the session genuinely doesn't exist in Stripe.
          // Any other error (auth, network, rate limit) means we can't verify payment status,
          // so we must refuse to release to prevent double-sell risk.
          const isResourceMissing =
            stripeError instanceof Stripe.errors.StripeError &&
            stripeError.code === "resource_missing";

          if (isResourceMissing) {
            // Session doesn't exist in Stripe - safe to release (was never created or already expired)
            logger.debug({ sessionId }, "Stripe session not found (resource_missing), proceeding with release");
          } else {
            // Cannot verify payment status - refuse to release inventory
            logger.warn(
              { sessionId, err: stripeError },
              "Cancel rejected: cannot verify Stripe session status - inventory protected (fail-closed)"
            );
            return res.status(503).json({
              ok: false,
              error: "STRIPE_VERIFICATION_FAILED",
              message: "Cannot verify payment status. Retry later or wait for session TTL expiry.",
            });
          }
        }
      }

      // Release ALL items for this checkout session (multi-item support)
      const releasedCount = inventoryService.releaseReservationsByCheckoutSession(sessionId);

      if (releasedCount === 0) {
        // No items found or none were RESERVED - may already be released
        logger.debug({ sessionId }, "Cancel requested but no reserved items found");
        return res.json({ ok: true, releasedCount: 0, reason: "no_reserved_items" });
      }

      // Expire Stripe session (if still open)
      if (stripeService.isConfigured()) {
        try {
          await stripeService.expireCheckoutSession(sessionId);
          logger.debug({ sessionId }, "Stripe session expired");
        } catch (e) {
          // Session may already be expired/completed - continue anyway
          logger.debug({ sessionId, err: e }, "Stripe session already expired or completed");
        }
      }

      logger.info({ sessionId, releasedCount }, "Checkout session cancelled, reservations released");
      return res.json({ ok: true, releasedCount });
    } catch (error) {
      logger.error({ err: error, sessionId }, "Failed to cancel checkout session");
      return res.status(500).json({
        error: "CANCEL_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ==========================================================================
  // Stripe Webhook Handler
  // ==========================================================================

  /**
   * POST /api/webhooks/stripe
   * Handle Stripe webhook events
   * Note: Raw body parsing must be configured in http.ts for this route
   */
  app.post("/api/webhooks/stripe", async (req: Request, res: Response) => {
    const signature = req.headers["stripe-signature"] as string;

    if (!signature) {
      return res.status(400).json({ error: "Missing stripe-signature header" });
    }

    if (!stripeService.isConfigured()) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    let event: Stripe.Event;

    try {
      // req.body should be raw Buffer (configured in http.ts)
      const payload = req.body as Buffer;
      event = stripeService.verifyWebhookEvent(payload, signature);
    } catch (error) {
      logger.error({ err: error }, "Webhook signature verification failed");
      return res.status(400).json({ error: "Invalid webhook signature" });
    }

    // Idempotency check
    if (stripeService.isEventProcessed(event.id)) {
      logger.info({ eventId: event.id }, "Webhook event already processed (idempotent)");
      return res.json({ received: true, idempotent: true });
    }

    logger.info({ eventId: event.id, eventType: event.type }, "Processing webhook event");

    // Track item_uid discovered by handlers for idempotency log
    let discoveredItemUid: string | null = null;

    try {
      switch (event.type) {
        // ===========================================
        // Critical handlers (take action)
        // ===========================================
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          discoveredItemUid = await handleCheckoutCompleted(session, ctx, event.id);
          break;
        }

        case "checkout.session.expired": {
          const session = event.data.object as Stripe.Checkout.Session;
          discoveredItemUid = await handleCheckoutExpired(session, ctx);
          break;
        }

        case "charge.refunded": {
          const charge = event.data.object as Stripe.Charge;
          discoveredItemUid = await handleChargeRefunded(charge, ctx);
          break;
        }

        // ===========================================
        // Telemetry handlers (log only, no action)
        // ===========================================
        case "payment_intent.created":
        case "payment_intent.succeeded":
        case "charge.succeeded":
        case "refund.created":
        case "product.created":
        case "price.created": {
          logger.info(
            { eventType: event.type, eventId: event.id, objectId: (event.data.object as { id: string }).id },
            "Stripe telemetry event received"
          );
          break;
        }

        // ===========================================
        // Account/config events (log only)
        // ===========================================
        case "account.updated":
        case "product.updated":
        case "price.updated": {
          logger.debug(
            { eventType: event.type, eventId: event.id },
            "Stripe config event received"
          );
          break;
        }

        default:
          logger.debug({ eventType: event.type }, "Unhandled webhook event type");
      }

      // Mark event as processed - use handler-discovered item_uid, or fallback to metadata extraction
      const itemUid = discoveredItemUid ?? extractItemUid(event);
      stripeService.markEventProcessed(event.id, event.type, itemUid);

      res.json({ received: true });
    } catch (error) {
      logger.error({ err: error, eventId: event.id, eventType: event.type }, "Webhook processing failed");
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // ==========================================================================
  // Admin Endpoints
  // ==========================================================================

  /**
   * GET /api/admin/items/:itemUid/stripe
   * Get Stripe status for an item
   */
  app.get("/api/admin/items/:itemUid/stripe", requireAdminAuth, (req: Request, res: Response) => {
    const { itemUid } = req.params;

    const item = inventoryService.getItemForCheckout(itemUid);

    if (!item) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: `Item ${itemUid} not found`,
      });
    }

    res.json({
      item_uid: item.item_uid,
      status: item.status,
      stripe_product_id: item.stripe_product_id,
      stripe_price_id: item.stripe_price_id,
      staging_ready: item.staging_ready,
      price_cents: item.price_cents,
      stripe_configured: stripeService.isConfigured(),
    });
  });

  /**
   * POST /api/admin/items/:itemUid/stripe/sync
   * Create or regenerate Stripe product/price for an item
   */
  app.post("/api/admin/items/:itemUid/stripe/sync", requireAdminAuth, async (req: Request, res: Response) => {
    const { itemUid } = req.params;

    if (!stripeService.isConfigured()) {
      return res.status(503).json({
        error: "STRIPE_NOT_CONFIGURED",
        message: "Stripe payments are not configured",
      });
    }

    try {
      const item = inventoryService.getItemForCheckout(itemUid);

      if (!item) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: `Item ${itemUid} not found`,
        });
      }

      if (!item.price_cents || item.price_cents <= 0) {
        return res.status(400).json({
          error: "NO_PRICE",
          message: "Item has no price configured",
        });
      }

      const stripeData = {
        item_uid: item.item_uid,
        product_uid: item.product_uid,
        cm_card_id: item.cm_card_id,
        set_name: item.set_name,
        collector_no: item.collector_no,
        condition: item.condition,
        canonical_sku: item.canonical_sku,
        name: item.name,
        description: `${item.name} - ${item.set_name ?? "Unknown Set"} ${item.collector_no ?? ""} (${item.condition ?? "Unknown"})`,
        price_cents: item.price_cents,
        image_url: item.image_url,
      };

      const result = await stripeService.createProductAndPrice(stripeData);

      // Update item with new Stripe IDs
      inventoryService.updateStripeIds(itemUid, result.stripeProductId, result.stripePriceId);

      logger.info({ itemUid, ...result }, "Stripe product/price synced");

      res.json({
        ok: true,
        stripe_product_id: result.stripeProductId,
        stripe_price_id: result.stripePriceId,
      });
    } catch (error) {
      logger.error({ err: error, itemUid }, "Failed to sync Stripe product/price");
      res.status(500).json({
        error: "SYNC_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/admin/stripe/expire-reservations
   * Manually trigger expiry job for overdue reservations
   */
  app.post("/api/admin/stripe/expire-reservations", requireAdminAuth, async (req: Request, res: Response) => {
    const { dry_run } = req.body;

    if (!stripeService.isConfigured()) {
      return res.status(503).json({
        error: "STRIPE_NOT_CONFIGURED",
        message: "Stripe payments are not configured",
      });
    }

    try {
      const overdue = inventoryService.findOverdueReservations();

      if (dry_run) {
        return res.json({
          ok: true,
          dry_run: true,
          overdue_count: overdue.length,
          overdue,
        });
      }

      const results: Array<{ item_uid: string; success: boolean; error?: string }> = [];

      for (const reservation of overdue) {
        try {
          // Expire session in Stripe
          await stripeService.expireCheckoutSession(reservation.checkout_session_id);
          // Release item
          inventoryService.releaseReservation(reservation.item_uid);
          results.push({ item_uid: reservation.item_uid, success: true });
        } catch (error) {
          results.push({
            item_uid: reservation.item_uid,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info({ processed: results.length }, "Manual expiry job completed");

      res.json({
        ok: true,
        processed: results.length,
        results,
      });
    } catch (error) {
      logger.error({ err: error }, "Manual expiry job failed");
      res.status(500).json({
        error: "EXPIRY_JOB_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

// ==========================================================================
// Webhook Handler Helpers
// ==========================================================================

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  ctx: AppContext,
  stripeEventId: string
): Promise<string | null> {
  const { logger, stripeService, inventoryService, klaviyoService, db, emailOutboxRepo } = ctx;
  const sessionId = session.id;

  // Check if this is a multi-item checkout (Lot Builder)
  const metadata = session.metadata ?? {};
  const isMultiItem = !!metadata.item_uids;

  // Get payment intent ID (common to both flows)
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  if (!paymentIntentId) {
    logger.error({ sessionId, isMultiItem }, "checkout.session.completed: no payment_intent in session");
    return null;
  }

  // Parse item UIDs - either from metadata (multi) or find by session (single)
  let itemUids: string[];

  if (isMultiItem) {
    try {
      itemUids = JSON.parse(metadata.item_uids);
      if (!Array.isArray(itemUids) || itemUids.length === 0) {
        throw new Error("Invalid item_uids format");
      }
    } catch (e) {
      logger.error({ sessionId, rawItemUids: metadata.item_uids }, "Failed to parse multi-item item_uids");
      return null;
    }
  } else {
    // Single-item: find by checkout session
    const item = inventoryService.getItemByCheckoutSession(sessionId);
    if (!item) {
      logger.warn({ sessionId }, "checkout.session.completed: no item found for session");
      return null;
    }
    itemUids = [item.item_uid];
  }

  logger.info(
    { sessionId, itemCount: itemUids.length, isMultiItem, lotDiscountPct: metadata.lot_discount_pct },
    "checkout.session.completed: processing order"
  );

  // Process each item: mark sold, archive Stripe product/price, create sync event
  const processedItems: Array<{
    item_uid: string;
    product_uid: string;
    cm_card_id: string | null;
    canonical_sku: string | null;
    name: string;
    set_name: string | null;
    collector_no: string | null;
    condition: string | null;
    price_cents: number;
    image_url: string | null;
    stripe_product_id: string | null;
    stripe_price_id: string | null;
  }> = [];

  const shouldQueueEvershopHide =
    session.livemode === true &&
    runtimeConfig.cardmintEnv === "production" &&
    runtimeConfig.evershopSaleSyncEnabled;
  const queuedHideProducts = new Set<string>();

  for (const itemUid of itemUids) {
    // Mark item as sold
    const marked = inventoryService.markItemSold(itemUid, paymentIntentId);

    if (!marked) {
      logger.warn(
        { itemUid, sessionId },
        "checkout.session.completed: failed to mark sold (may already be processed)"
      );
      // Continue processing other items - this one may have been processed already
      continue;
    }

    // Get full item data
    const itemData = inventoryService.getItemForCheckout(itemUid);
    if (!itemData) {
      logger.warn({ itemUid }, "checkout.session.completed: item data not found after marking sold");
      continue;
    }

    // Archive Stripe product/price
    if (itemData.stripe_product_id && itemData.stripe_price_id) {
      try {
        await stripeService.archiveProductAndPrice(
          itemData.stripe_product_id,
          itemData.stripe_price_id
        );
      } catch (error) {
        logger.error(
          { err: error, itemUid },
          "Failed to archive Stripe product/price (non-fatal)"
        );
      }
    }

    // Clear DB references to archived Stripe IDs
    // Ensures future checkouts (if item is refunded/reset) create fresh prices
    inventoryService.clearStripeIds(itemUid);

    // Create sale sync_event for staging archival
    try {
      const now = Math.floor(Date.now() / 1000);
      const eventUid = `SALE:${itemUid}:${Math.floor(now / 60)}`;

      const saleSnapshot = {
        item_uid: itemUid,
        product_uid: itemData.product_uid ?? null,
        status: "SOLD",
        payment_intent_id: paymentIntentId,
        checkout_session_id: sessionId,
        stripe_product_id: itemData.stripe_product_id ?? null,
        stripe_price_id: itemData.stripe_price_id ?? null,
        name: itemData.name ?? null,
        set_name: itemData.set_name ?? null,
        collector_no: itemData.collector_no ?? null,
        condition: itemData.condition ?? null,
        price_cents: itemData.price_cents ?? null,
        sold_at: now,
        lot_item_count: itemUids.length,
        lot_discount_pct: metadata.lot_discount_pct ?? null,
      };

      db.prepare(
        `INSERT INTO sync_events (event_uid, event_type, product_uid, item_uid, source_db, target_db, payload, stripe_event_id, status, created_at)
         VALUES (?, 'sale', ?, ?, 'production', 'staging', ?, ?, 'pending', ?)
         ON CONFLICT(event_uid) DO NOTHING`
      ).run(
        eventUid,
        itemData.product_uid ?? "",
        itemUid,
        JSON.stringify(saleSnapshot),
        stripeEventId,
        now
      );
    } catch (syncError) {
      logger.warn(
        { err: syncError, itemUid, stripeEventId },
        "Failed to create sale sync_event (non-fatal)"
      );
    }

    // Collect for Klaviyo
    processedItems.push({
      item_uid: itemData.item_uid,
      product_uid: itemData.product_uid,
      cm_card_id: itemData.cm_card_id,
      canonical_sku: itemData.canonical_sku,
      name: itemData.name,
      set_name: itemData.set_name,
      collector_no: itemData.collector_no,
      condition: itemData.condition,
      price_cents: itemData.price_cents,
      image_url: itemData.image_url,
      stripe_product_id: itemData.stripe_product_id,
      stripe_price_id: itemData.stripe_price_id,
    });

    logger.info({ itemUid, sessionId, paymentIntentId }, "checkout.session.completed: item marked sold");

    // Enqueue EverShop hide listing event (async worker handles actual mutation)
    if (shouldQueueEvershopHide && itemData.product_uid && !queuedHideProducts.has(itemData.product_uid)) {
      const productRow = db
        .prepare(
          `SELECT product_sku, listing_sku, total_quantity, evershop_product_id
           FROM products WHERE product_uid = ?`
        )
        .get(itemData.product_uid) as
        | {
            product_sku: string | null;
            listing_sku: string | null;
            total_quantity: number;
            evershop_product_id: number | null;
          }
        | undefined;

      if (!productRow) {
        logger.warn({ product_uid: itemData.product_uid }, "EverShop hide skipped: product not found");
      } else if (productRow.total_quantity > 0) {
        logger.debug(
          { product_uid: itemData.product_uid, total_quantity: productRow.total_quantity },
          "EverShop hide skipped: product still has inventory"
        );
      } else {
        const productSku = productRow.product_sku ?? productRow.listing_sku;
        if (!productSku) {
          logger.warn({ product_uid: itemData.product_uid }, "EverShop hide skipped: missing product_sku");
        } else {
          const now = Math.floor(Date.now() / 1000);
          const eventUid = `EVERSHOP_HIDE:${sessionId}:${productSku}`;
          const payload = {
            product_uid: itemData.product_uid,
            item_uid: itemUid,
            stripe_session_id: sessionId,
            product_sku: productSku,
            reason: "sold",
            total_quantity: productRow.total_quantity,
            livemode: session.livemode === true,
            evershop_product_id: productRow.evershop_product_id ?? null,
          };

          db.prepare(
            `INSERT OR IGNORE INTO sync_events (
              event_uid,
              event_type,
              product_uid,
              item_uid,
              stripe_session_id,
              product_sku,
              source_db,
              target_db,
              operator_id,
              payload,
              stripe_event_id,
              status,
              created_at
            ) VALUES (?, 'evershop_hide_listing', ?, ?, ?, ?, 'production', 'production', 'stripe_webhook', ?, ?, 'pending', ?)`
          ).run(
            eventUid,
            itemData.product_uid,
            itemUid,
            sessionId,
            productSku,
            JSON.stringify(payload),
            stripeEventId,
            now
          );

          queuedHideProducts.add(itemData.product_uid);
          logger.info(
            { product_uid: itemData.product_uid, product_sku: productSku, sessionId },
            "EverShop hide listing event enqueued"
          );
        }
      }
    }
  }

  // Emit Klaviyo order events (fire-and-forget, never block webhook)
  if (klaviyoService.isConfigured() && processedItems.length > 0) {
    // Build lot discount info from metadata if present
    const lotDiscountInfo = metadata.lot_discount_pct
      ? {
          discountPct: parseInt(metadata.lot_discount_pct, 10) || 0,
          reasonCode: metadata.lot_reason_code ?? "QUANTITY_ONLY",
          reasonTags: metadata.lot_reason_code ? [metadata.lot_reason_code.toLowerCase().replace("_", "-")] : [],
          reasonText: "",
        }
      : null;

    void (async () => {
      try {
        // One "Placed Order" event with all items
        await klaviyoService.trackPlacedOrder(session, processedItems, stripeEventId, lotDiscountInfo);

        // One "Ordered Product" event per item
        for (const item of processedItems) {
          await klaviyoService.trackOrderedProduct(session, item, stripeEventId, processedItems.length);
        }
      } catch (err) {
        logger.error(
          { err, itemUids, stripeEventId },
          "Klaviyo tracking failed (non-fatal)"
        );
      }
    })();
  }

  // Create fulfillment record for shipping workflow
  // Use metadata for item_count/totals so this works even on webhook retries when processedItems is empty
  if (metadata.shipping_method) {
    try {
      // Check if fulfillment already exists (idempotent on retry)
      const existingFulfillment = db
        .prepare(`SELECT stripe_session_id FROM fulfillment WHERE stripe_session_id = ?`)
        .get(sessionId);

      if (existingFulfillment) {
        logger.debug({ sessionId }, "checkout.session.completed: fulfillment already exists (idempotent)");
      } else {
        // Use metadata totals with Stripe session fallback (works on retries)
        const calculatedSubtotal = processedItems.reduce((sum, item) => sum + (item.price_cents || 0), 0);
        const originalSubtotalCents =
          parseInt(metadata.original_subtotal_cents || "0", 10) ||
          calculatedSubtotal ||
          session.amount_subtotal ||
          0;
        const finalSubtotalCents =
          parseInt(metadata.final_subtotal_cents || "0", 10) ||
          calculatedSubtotal ||
          session.amount_subtotal ||
          0;
        const shippingCostCents = parseInt(metadata.shipping_cost_cents || "0", 10);
        const requiresManualReview = metadata.requires_manual_review === "1" ? 1 : 0;

        // Get item_count from metadata (works on retries) or processedItems
        const itemCount = parseInt(metadata.item_count || "0", 10) || processedItems.length || itemUids.length;

        db.prepare(
          `INSERT INTO fulfillment (
            stripe_session_id,
            stripe_payment_intent_id,
            item_count,
            original_subtotal_cents,
            final_subtotal_cents,
            shipping_method,
            shipping_cost_cents,
            requires_manual_review,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
        ).run(
          sessionId,
          paymentIntentId,
          itemCount,
          originalSubtotalCents,
          finalSubtotalCents,
          metadata.shipping_method,
          shippingCostCents,
          requiresManualReview
        );

        logger.info(
          {
            sessionId,
            itemCount,
            originalSubtotalCents,
            finalSubtotalCents,
            shippingMethod: metadata.shipping_method,
            shippingCostCents,
            requiresManualReview: !!requiresManualReview,
          },
          "checkout.session.completed: fulfillment record created"
        );
      }
    } catch (fulfillmentErr) {
      logger.error(
        { err: fulfillmentErr, sessionId },
        "Failed to create fulfillment record (non-fatal)"
      );
    }
  }

  // Create order record with human-readable order number
  // Always attempt creation - use upsert pattern for idempotency on webhook retries
  // Use metadata for totals (works even when processedItems is empty on retry)
  try {
    // Check if order already exists for this session (webhook retry case)
    const existingOrder = db
      .prepare(`SELECT order_uid, order_number FROM orders WHERE stripe_session_id = ?`)
      .get(sessionId) as { order_uid: string; order_number: string } | undefined;

    if (existingOrder) {
      logger.debug(
        { orderNumber: existingOrder.order_number, sessionId },
        "checkout.session.completed: order already exists (idempotent)"
      );
    } else {
      // Generate order atomically using a transaction with retry on collision
      const { randomUUID } = await import("crypto");
      const now = Math.floor(Date.now() / 1000);
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const prefix = `CM-${today}-`;

      // Get item count from metadata (works on retries) or processedItems
      const itemCount = parseInt(metadata.item_count || "0", 10) || processedItems.length || itemUids.length;

      // Get totals: prefer metadata, fallback to processedItems, ultimate fallback to Stripe session
      // (Stripe session amounts work on retries even when metadata/processedItems are empty)
      const calculatedSubtotal = processedItems.reduce((sum, item) => sum + (item.price_cents || 0), 0);
      const subtotalCents =
        parseInt(metadata.final_subtotal_cents || "0", 10) ||
        calculatedSubtotal ||
        session.amount_subtotal ||
        0;
      const shippingCents = parseInt(metadata.shipping_cost_cents || "0", 10);
      // Total: calculated from subtotal+shipping, or Stripe session total as ultimate fallback
      const totalCents = (subtotalCents + shippingCents) || session.amount_total || 0;

      // Atomic order creation with transaction and retry on unique constraint violation
      const MAX_RETRIES = 3;
      let orderCreated = false;
      let finalOrderNumber = "";
      let finalOrderUid = "";

      for (let attempt = 0; attempt < MAX_RETRIES && !orderCreated; attempt++) {
        try {
          const orderUid = randomUUID();

          // Use transaction to make MAX() + INSERT atomic
          const createOrder = db.transaction(() => {
            const maxSeq = db
              .prepare(
                `SELECT MAX(CAST(SUBSTR(order_number, 13) AS INTEGER)) as seq
                 FROM orders
                 WHERE order_number LIKE ?`
              )
              .get(`${prefix}%`) as { seq: number | null } | undefined;

            const nextSeq = (maxSeq?.seq ?? 0) + 1;
            const orderNumber = `${prefix}${String(nextSeq).padStart(6, "0")}`;

            const result = db.prepare(
              `INSERT INTO orders (
                order_uid, order_number, stripe_session_id, stripe_payment_intent_id,
                item_count, subtotal_cents, shipping_cents, total_cents,
                status, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`
            ).run(
              orderUid,
              orderNumber,
              sessionId,
              paymentIntentId,
              itemCount,
              subtotalCents,
              shippingCents,
              totalCents,
              now,
              now
            );

            return { orderNumber, orderUid, changes: result.changes };
          });

          const result = createOrder();

          if (result.changes > 0) {
            orderCreated = true;
            finalOrderNumber = result.orderNumber;
            finalOrderUid = result.orderUid;

            // Create order_events audit record (only after confirming order exists)
            db.prepare(
              `INSERT INTO order_events (order_uid, event_type, new_value, actor, created_at)
               VALUES (?, 'created', ?, 'webhook', ?)`
            ).run(
              finalOrderUid,
              JSON.stringify({ order_number: finalOrderNumber, item_count: itemCount }),
              now
            );

            logger.info(
              { orderNumber: finalOrderNumber, orderUid: finalOrderUid, sessionId, itemCount },
              "checkout.session.completed: order record created"
            );
          }
        } catch (insertErr: unknown) {
          // Check for unique constraint violation (order_number or stripe_session_id collision)
          const errMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
          if (errMsg.includes("UNIQUE constraint failed")) {
            // Re-check if order exists now (concurrent webhook created it)
            const nowExists = db
              .prepare(`SELECT order_uid, order_number FROM orders WHERE stripe_session_id = ?`)
              .get(sessionId) as { order_uid: string; order_number: string } | undefined;

            if (nowExists) {
              logger.debug(
                { orderNumber: nowExists.order_number, sessionId, attempt },
                "checkout.session.completed: order created by concurrent webhook"
              );
              orderCreated = true;
              finalOrderNumber = nowExists.order_number;
              break;
            }
            // order_number collision - retry with next sequence
            logger.warn({ attempt, sessionId }, "Order number collision, retrying");
            continue;
          }
          throw insertErr;
        }
      }

      if (!orderCreated) {
        logger.error({ sessionId }, "Failed to create order after max retries");
      }

      // PR2.1: Enqueue order confirmation email (sent at checkout - no tracking)
      // This is the first touchpoint - customer knows their order was received
      if (orderCreated && finalOrderNumber) {
        try {
          // Build items list for email template
          // Prefer processedItems, but on webhook retry they may be empty
          // (items already marked SOLD don't get added to processedItems)
          // Fallback: look up item data from inventory by itemUid
          let emailItems: Array<{ name: string; priceCents: number; imageUrl: string | null }>;

          if (processedItems.length > 0) {
            emailItems = processedItems.map((item) => ({
              name: item.name ?? "Pokemon Card",
              priceCents: item.price_cents ?? 0,
              imageUrl: item.image_url,
            }));
          } else {
            // Webhook retry: items already processed, look up from inventory
            emailItems = itemUids
              .map((uid) => inventoryService.getItemForCheckout(uid))
              .filter((item): item is NonNullable<typeof item> => item !== null)
              .map((item) => ({
                name: item.name ?? "Pokemon Card",
                priceCents: item.price_cents ?? 0,
                imageUrl: item.image_url,
              }));
          }

          const emailUid = emailOutboxRepo.enqueue({
            stripeSessionId: sessionId,
            emailType: "order_confirmation",
            templateData: {
              orderNumber: finalOrderNumber,
              items: emailItems,
              subtotalCents,
              shippingCents,
              totalCents,
            },
          });

          if (emailUid) {
            logger.info(
              { emailUid, orderNumber: finalOrderNumber, sessionId },
              "checkout.session.completed: order confirmation email enqueued"
            );
          } else {
            logger.debug({ sessionId }, "checkout.session.completed: order confirmation email already enqueued (idempotent)");
          }
        } catch (emailErr) {
          // Non-fatal: email queueing failure shouldn't block the webhook
          logger.error(
            { err: emailErr, sessionId },
            "checkout.session.completed: failed to enqueue order confirmation email (non-fatal)"
          );
        }
      }
    }
  } catch (orderErr) {
    // Non-fatal: order creation failure shouldn't block the webhook
    // The fulfillment record is already created, so shipping can proceed
    logger.error(
      { err: orderErr, sessionId },
      "Failed to create order record (non-fatal)"
    );
  }

  // Return first item_uid for idempotency record (or null if none processed)
  return itemUids[0] ?? null;
}

async function handleCheckoutExpired(
  session: Stripe.Checkout.Session,
  ctx: AppContext
): Promise<string | null> {
  const { logger, inventoryService } = ctx;
  const sessionId = session.id;

  // Release ALL reserved items for this session (multi-item support)
  const releasedCount = inventoryService.releaseReservationsByCheckoutSession(sessionId);

  if (releasedCount === 0) {
    logger.debug({ sessionId }, "checkout.session.expired: no reserved items found for session");
    return null;
  }

  logger.info(
    { sessionId, releasedCount },
    "checkout.session.expired: reservations released"
  );

  // Return sessionId for idempotency tracking (legacy: used to return single item_uid)
  return sessionId;
}

/**
 * Handle charge.refunded event
 * Restores item to IN_STOCK when a refund is processed
 * Re-activates Stripe product/price so item can be sold again
 */
async function handleChargeRefunded(
  charge: Stripe.Charge,
  ctx: AppContext
): Promise<string | null> {
  const { logger, stripeService, inventoryService } = ctx;

  // Get payment_intent from charge
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id ?? null;

  if (!paymentIntentId) {
    logger.warn({ chargeId: charge.id }, "charge.refunded: no payment_intent in charge");
    return null;
  }

  // Find item by payment intent
  const item = inventoryService.getItemByPaymentIntent(paymentIntentId);

  if (!item) {
    logger.warn(
      { chargeId: charge.id, paymentIntentId },
      "charge.refunded: no item found for payment intent"
    );
    return null;
  }

  // Only restore if currently SOLD
  if (item.status !== "SOLD") {
    logger.debug(
      { itemUid: item.item_uid, status: item.status, chargeId: charge.id },
      "charge.refunded: item not SOLD, skipping restore"
    );
    return item.item_uid;
  }

  // Restore item to IN_STOCK
  const restored = inventoryService.restoreItemFromRefund(item.item_uid);

  if (!restored) {
    logger.error(
      { itemUid: item.item_uid, chargeId: charge.id },
      "charge.refunded: failed to restore item"
    );
    return item.item_uid;
  }

  // NOTE: EverShop republish is manual; refunds do NOT auto-unhide listings.

  // Re-activate Stripe product/price so item can be sold again
  if (item.stripe_product_id && item.stripe_price_id) {
    try {
      await stripeService.reactivateProductAndPrice(
        item.stripe_product_id,
        item.stripe_price_id
      );
      logger.info(
        { itemUid: item.item_uid, stripeProductId: item.stripe_product_id },
        "charge.refunded: Stripe product/price reactivated"
      );
    } catch (error) {
      // Non-fatal - item is restored, can create new product/price on next checkout
      logger.warn(
        { err: error, itemUid: item.item_uid },
        "charge.refunded: failed to reactivate Stripe product/price (non-fatal)"
      );
    }
  }

  logger.info(
    { itemUid: item.item_uid, chargeId: charge.id, paymentIntentId, refundAmount: charge.amount_refunded },
    "charge.refunded: item restored to IN_STOCK"
  );

  return item.item_uid;
}

function extractItemUid(event: Stripe.Event): string | null {
  try {
    const obj = event.data.object as Record<string, unknown>;

    // Try session.metadata.item_uid (checkout session events)
    if (obj.metadata && typeof obj.metadata === "object") {
      const metadata = obj.metadata as Record<string, string>;
      if (metadata.item_uid) {
        return metadata.item_uid;
      }
    }

    // Try payment_intent.metadata.item_uid (payment_intent events, charge events)
    if (obj.payment_intent) {
      const pi = obj.payment_intent as Record<string, unknown>;
      if (pi.metadata && typeof pi.metadata === "object") {
        const piMeta = pi.metadata as Record<string, string>;
        if (piMeta.item_uid) {
          return piMeta.item_uid;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
