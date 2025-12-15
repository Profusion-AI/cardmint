/**
 * Stripe Payment Routes
 * Handles checkout sessions, webhooks, and admin Stripe operations
 * Reference: stripe-imp-plan.md, Codex runbook Dec 2
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { runtimeConfig } from "../config";
import Stripe from "stripe";

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

      // Determine URLs (default to generic if not provided)
      const baseUrl = runtimeConfig.evershopApiUrl || "https://cardmintshop.com";
      const effectiveSuccessUrl = success_url || `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
      const effectiveCancelUrl = cancel_url || `${baseUrl}/checkout/cancel`;

      // Create checkout session
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

  // ==========================================================================
  // Cancel Checkout Session
  // ==========================================================================

  /**
   * POST /api/checkout/session/:sessionId/cancel
   * Cancel an active checkout session and release the reserved item.
   * Called by the cart when user removes an item or abandons checkout.
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
      // Find item by checkout_session_id
      const item = inventoryService.getItemByCheckoutSession(sessionId);

      if (!item) {
        // Session may have already expired or been completed - that's okay
        logger.debug({ sessionId }, "Cancel requested but session not found (may already be released)");
        return res.json({ ok: true, released: false, reason: "session_not_found" });
      }

      // Only release if item is still RESERVED
      if (item.status !== "RESERVED") {
        logger.debug({ sessionId, status: item.status }, "Cancel requested but item not reserved");
        return res.json({ ok: true, released: false, reason: "not_reserved" });
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

      // Release reservation
      const released = inventoryService.releaseReservation(item.item_uid);

      if (released) {
        logger.info({ sessionId, itemUid: item.item_uid }, "Checkout session cancelled, reservation released");
      }

      return res.json({ ok: true, released });
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
  app.get("/api/admin/items/:itemUid/stripe", (req: Request, res: Response) => {
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
  app.post("/api/admin/items/:itemUid/stripe/sync", async (req: Request, res: Response) => {
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
  app.post("/api/admin/stripe/expire-reservations", async (req: Request, res: Response) => {
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
  const { logger, stripeService, inventoryService, db } = ctx;
  const sessionId = session.id;

  // Find item by checkout session
  const item = inventoryService.getItemByCheckoutSession(sessionId);

  if (!item) {
    logger.warn({ sessionId }, "checkout.session.completed: no item found for session");
    return null;
  }

  // Get payment intent ID
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  if (!paymentIntentId) {
    logger.error({ sessionId }, "checkout.session.completed: no payment_intent in session");
    return item.item_uid; // Still return item_uid for telemetry even if PI missing
  }

  // Mark item as sold
  const marked = inventoryService.markItemSold(item.item_uid, paymentIntentId);

  if (!marked) {
    logger.warn(
      { itemUid: item.item_uid, status: item.status },
      "checkout.session.completed: failed to mark sold (may already be processed)"
    );
    return item.item_uid; // Still return item_uid for idempotency record
  }

  // Archive Stripe product/price
  const itemData = inventoryService.getItemForCheckout(item.item_uid);
  if (itemData?.stripe_product_id && itemData?.stripe_price_id) {
    try {
      await stripeService.archiveProductAndPrice(
        itemData.stripe_product_id,
        itemData.stripe_price_id
      );
    } catch (error) {
      logger.error(
        { err: error, itemUid: item.item_uid },
        "Failed to archive Stripe product/price (non-fatal)"
      );
    }
  }

  logger.info(
    { itemUid: item.item_uid, sessionId, paymentIntentId },
    "checkout.session.completed: item marked sold"
  );

  // Create sale sync_event for staging archival (Phase 2 sync)
  // This allows staging to learn about sales when it comes online
  try {
    const now = Math.floor(Date.now() / 1000);
    const eventUid = `SALE:${item.item_uid}:${Math.floor(now / 60)}`;

    // Get full item/product data for snapshot
    const itemData = inventoryService.getItemForCheckout(item.item_uid);
    const saleSnapshot = {
      item_uid: item.item_uid,
      product_uid: itemData?.product_uid ?? null,
      status: "SOLD",
      payment_intent_id: paymentIntentId,
      checkout_session_id: sessionId,
      stripe_product_id: itemData?.stripe_product_id ?? null,
      stripe_price_id: itemData?.stripe_price_id ?? null,
      name: itemData?.name ?? null,
      set_name: itemData?.set_name ?? null,
      collector_no: itemData?.collector_no ?? null,
      condition: itemData?.condition ?? null,
      price_cents: itemData?.price_cents ?? null,
      sold_at: now,
    };

    db.prepare(
      `INSERT INTO sync_events (event_uid, event_type, product_uid, item_uid, source_db, target_db, payload, stripe_event_id, status, created_at)
       VALUES (?, 'sale', ?, ?, 'production', 'staging', ?, ?, 'pending', ?)
       ON CONFLICT(event_uid) DO NOTHING`
    ).run(
      eventUid,
      itemData?.product_uid ?? "",
      item.item_uid,
      JSON.stringify(saleSnapshot),
      stripeEventId,
      now
    );

    logger.debug(
      { eventUid, itemUid: item.item_uid, stripeEventId },
      "Sale sync_event created for staging archival"
    );
  } catch (syncError) {
    // Non-fatal: sale succeeded, sync event creation failed
    // Staging can recover via stripe_webhook_events query
    logger.warn(
      { err: syncError, itemUid: item.item_uid, stripeEventId },
      "Failed to create sale sync_event (non-fatal)"
    );
  }

  return item.item_uid;
}

async function handleCheckoutExpired(
  session: Stripe.Checkout.Session,
  ctx: AppContext
): Promise<string | null> {
  const { logger, inventoryService } = ctx;
  const sessionId = session.id;

  // Find item by checkout session
  const item = inventoryService.getItemByCheckoutSession(sessionId);

  if (!item) {
    logger.debug({ sessionId }, "checkout.session.expired: no item found for session");
    return null;
  }

  // Only release if still RESERVED
  if (item.status !== "RESERVED") {
    logger.debug(
      { itemUid: item.item_uid, status: item.status },
      "checkout.session.expired: item not reserved, skipping"
    );
    return item.item_uid;
  }

  // Release reservation
  const released = inventoryService.releaseReservation(item.item_uid);

  if (released) {
    logger.info(
      { itemUid: item.item_uid, sessionId },
      "checkout.session.expired: reservation released"
    );
  }

  return item.item_uid;
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
