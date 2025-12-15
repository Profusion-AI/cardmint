/**
 * Stripe Service
 * Manages Stripe Product/Price/Session lifecycle for one-off card listings
 * Reference: stripe-imp-plan.md, Codex runbook Dec 2
 */

import Stripe from "stripe";
import type { Database } from "better-sqlite3";
import type { Logger } from "pino";
import { runtimeConfig } from "../config";

export interface StripeItemData {
  item_uid: string;
  product_uid: string;
  cm_card_id: string | null;
  set_name: string | null;
  collector_no: string | null;
  condition: string | null;
  canonical_sku: string | null;
  name: string;
  description: string;
  price_cents: number;
  image_url: string | null;
}

export interface CreateProductResult {
  stripeProductId: string;
  stripePriceId: string;
}

export interface CreateSessionResult {
  sessionId: string;
  checkoutUrl: string;
  expiresAt: number;
}

export class StripeService {
  private stripe: Stripe | null = null;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger
  ) {
    if (runtimeConfig.stripeSecretKey) {
      this.stripe = new Stripe(runtimeConfig.stripeSecretKey);
      this.logger.info("Stripe client initialized");
    } else {
      this.logger.warn("Stripe API key not configured - payment features disabled");
    }
  }

  private ensureStripe(): Stripe {
    if (!this.stripe) {
      throw new Error("Stripe not configured - set STRIPE_SECRET_KEY");
    }
    return this.stripe;
  }

  /**
   * Create Stripe Product and Price for an item
   * Product ID: cm_item_<item_uid>
   * Metadata includes all item identifiers for audit trail
   */
  async createProductAndPrice(item: StripeItemData): Promise<CreateProductResult> {
    const stripe = this.ensureStripe();
    const productId = `cm_item_${item.item_uid}`;

    this.logger.info({ itemUid: item.item_uid, productId }, "Creating Stripe product/price");

    const product = await stripe.products.create({
      id: productId,
      name: item.name,
      description: item.description,
      active: true,
      images: item.image_url ? [item.image_url] : undefined,
      metadata: {
        item_uid: item.item_uid,
        product_uid: item.product_uid,
        cm_card_id: item.cm_card_id ?? "",
        set_name: item.set_name ?? "",
        collector_no: item.collector_no ?? "",
        condition: item.condition ?? "",
        canonical_sku: item.canonical_sku ?? "",
      },
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: item.price_cents,
      currency: "usd",
      active: true,
    });

    this.logger.info(
      { itemUid: item.item_uid, stripeProductId: product.id, stripePriceId: price.id },
      "Stripe product/price created"
    );

    return {
      stripeProductId: product.id,
      stripePriceId: price.id,
    };
  }

  /**
   * Archive Stripe Product and Price after sale
   * Sets active=false on both objects (Stripe best practice for sold items)
   */
  async archiveProductAndPrice(stripeProductId: string, stripePriceId: string): Promise<void> {
    const stripe = this.ensureStripe();

    this.logger.info({ stripeProductId, stripePriceId }, "Archiving Stripe product/price");

    await stripe.prices.update(stripePriceId, { active: false });
    await stripe.products.update(stripeProductId, { active: false });

    this.logger.info({ stripeProductId, stripePriceId }, "Stripe product/price archived");
  }

  /**
   * Reactivate Stripe Product and Price after refund
   * Sets active=true on both objects so item can be sold again
   */
  async reactivateProductAndPrice(stripeProductId: string, stripePriceId: string): Promise<void> {
    const stripe = this.ensureStripe();

    this.logger.info({ stripeProductId, stripePriceId }, "Reactivating Stripe product/price after refund");

    await stripe.products.update(stripeProductId, { active: true });
    await stripe.prices.update(stripePriceId, { active: true });

    this.logger.info({ stripeProductId, stripePriceId }, "Stripe product/price reactivated");
  }

  /**
   * Create Checkout Session for an item
   * Mode: payment, quantity: 1 (non-adjustable), expires in configured TTL
   */
  async createCheckoutSession(
    item: StripeItemData,
    stripePriceId: string,
    successUrl: string,
    cancelUrl: string
  ): Promise<CreateSessionResult> {
    const stripe = this.ensureStripe();

    const ttlMinutes = runtimeConfig.stripeReservationTtlMinutes;
    const expiresAt = Math.floor(Date.now() / 1000) + ttlMinutes * 60;

    this.logger.info(
      { itemUid: item.item_uid, stripePriceId, ttlMinutes },
      "Creating Stripe checkout session"
    );

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price: stripePriceId,
          quantity: 1,
          adjustable_quantity: { enabled: false },
        },
      ],
      expires_at: expiresAt,
      success_url: successUrl,
      cancel_url: cancelUrl,
      shipping_address_collection: {
        allowed_countries: ["US"],
      },
      allow_promotion_codes: false,
      // Session-level metadata for webhook event correlation
      metadata: {
        item_uid: item.item_uid,
        product_uid: item.product_uid,
      },
      payment_intent_data: {
        metadata: {
          item_uid: item.item_uid,
          product_uid: item.product_uid,
          cm_card_id: item.cm_card_id ?? "",
          canonical_sku: item.canonical_sku ?? "",
        },
      },
    });

    this.logger.info(
      { itemUid: item.item_uid, sessionId: session.id, expiresAt },
      "Stripe checkout session created"
    );

    return {
      sessionId: session.id,
      checkoutUrl: session.url!,
      expiresAt,
    };
  }

  /**
   * Force-expire an open Checkout Session
   * Used by background expiry job and manual release
   */
  async expireCheckoutSession(sessionId: string): Promise<void> {
    const stripe = this.ensureStripe();

    this.logger.info({ sessionId }, "Expiring Stripe checkout session");

    try {
      await stripe.checkout.sessions.expire(sessionId);
      this.logger.info({ sessionId }, "Stripe checkout session expired");
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError) {
        // Session may already be expired or completed
        this.logger.warn(
          { sessionId, err: error.message },
          "Could not expire session (may already be expired/completed)"
        );
      } else {
        throw error;
      }
    }
  }

  /**
   * Verify webhook signature and parse event
   */
  verifyWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    const stripe = this.ensureStripe();

    if (!runtimeConfig.stripeWebhookSecret) {
      throw new Error("Stripe webhook secret not configured");
    }

    return stripe.webhooks.constructEvent(
      payload,
      signature,
      runtimeConfig.stripeWebhookSecret
    );
  }

  /**
   * Check if webhook event has already been processed (idempotency)
   */
  isEventProcessed(eventId: string): boolean {
    const row = this.db
      .prepare("SELECT event_id FROM stripe_webhook_events WHERE event_id = ?")
      .get(eventId);
    return !!row;
  }

  /**
   * Mark webhook event as processed
   */
  markEventProcessed(eventId: string, eventType: string, itemUid: string | null): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO stripe_webhook_events (event_id, event_type, item_uid, processed_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(eventId, eventType, itemUid, now, now);
  }

  /**
   * Retrieve checkout session (for getting payment intent after completion)
   */
  async getCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    const stripe = this.ensureStripe();
    return stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });
  }

  /**
   * Check if Stripe is configured and available
   */
  isConfigured(): boolean {
    return this.stripe !== null;
  }
}
