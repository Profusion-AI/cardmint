/**
 * Stripe Service
 * Manages Stripe Product/Price/Session lifecycle for one-off card listings
 * Reference: stripe-imp-plan.md, Codex runbook Dec 2
 */

import Stripe from "stripe";
import type { Database } from "better-sqlite3";
import type { Logger } from "pino";
import { runtimeConfig } from "../config";
import type { ShippingQuote } from "../domain/shipping";

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

export interface MultiItemSessionResult {
  sessionId: string;
  checkoutUrl: string;
  expiresAt: number;
  itemUids: string[];
}

export interface LotDiscountInfo {
  discountPct: number;
  discountAmountCents: number;
  reasonCode: string;
  reasonText: string;
  /** Pre-discount sum of all item prices */
  originalTotalCents: number;
  /** Post-discount total customer pays (before shipping) */
  finalTotalCents: number;
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
   * Create Stripe Product and Price for an item (idempotent)
   * Product ID: cm_item_<item_uid>
   * If product already exists in Stripe, retrieves and reactivates it.
   * Always creates a fresh price (Stripe prices are immutable for amount).
   * Metadata includes all item identifiers for audit trail.
   */
  async createProductAndPrice(item: StripeItemData): Promise<CreateProductResult> {
    const stripe = this.ensureStripe();
    const productId = `cm_item_${item.item_uid}`;

    this.logger.info({ itemUid: item.item_uid, productId }, "Creating/retrieving Stripe product");

    let product: Stripe.Product;

    try {
      // Try to retrieve existing product first
      product = await stripe.products.retrieve(productId);
      this.logger.info({ productId }, "Stripe product already exists, reactivating");

      // Reactivate if archived and update metadata
      product = await stripe.products.update(productId, {
        active: true,
        name: item.name,
        description: item.description,
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
    } catch (err) {
      // Product doesn't exist, create it
      if ((err as { code?: string }).code === "resource_missing") {
        product = await stripe.products.create({
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
        this.logger.info({ productId }, "Stripe product created");
      } else {
        throw err;
      }
    }

    // Always create a fresh price (Stripe prices are immutable)
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: item.price_cents,
      currency: "usd",
      active: true,
    });

    this.logger.info(
      { itemUid: item.item_uid, stripeProductId: product.id, stripePriceId: price.id },
      "Stripe product/price ready"
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
   * Create Checkout Session for an item with shipping
   * Mode: payment, quantity: 1 (non-adjustable), expires in configured TTL
   * Includes shipping_options for deterministic shipping fee
   */
  async createCheckoutSession(
    item: StripeItemData,
    stripePriceId: string,
    shippingQuote: ShippingQuote,
    successUrl: string,
    cancelUrl: string
  ): Promise<CreateSessionResult> {
    const stripe = this.ensureStripe();

    if (!shippingQuote.allowed || !shippingQuote.method || !shippingQuote.priceCents) {
      throw new Error("Invalid shipping quote: checkout not allowed or missing shipping details");
    }

    const ttlMinutes = runtimeConfig.stripeReservationTtlMinutes;
    const expiresAt = Math.floor(Date.now() / 1000) + ttlMinutes * 60;

    this.logger.info(
      { itemUid: item.item_uid, stripePriceId, shippingMethod: shippingQuote.method, shippingCents: shippingQuote.priceCents, ttlMinutes },
      "Creating Stripe checkout session with shipping"
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
      // Single shipping option - deterministic, no customer choice
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: {
              amount: shippingQuote.priceCents,
              currency: "usd",
            },
            display_name: shippingQuote.method === "PRIORITY"
              ? "Priority Mail (2-3 business days)"
              : "Tracked Shipping (3-5 business days)",
            delivery_estimate: {
              minimum: { unit: "business_day", value: shippingQuote.method === "PRIORITY" ? 2 : 3 },
              maximum: { unit: "business_day", value: shippingQuote.method === "PRIORITY" ? 3 : 5 },
            },
          },
        },
      ],
      allow_promotion_codes: false,
      // Session-level metadata for webhook event correlation
      metadata: {
        item_uid: item.item_uid,
        product_uid: item.product_uid,
        shipping_method: shippingQuote.method,
        shipping_cost_cents: shippingQuote.priceCents.toString(),
        requires_manual_review: shippingQuote.requiresManualReview ? "1" : "0",
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
      { itemUid: item.item_uid, sessionId: session.id, expiresAt, shippingMethod: shippingQuote.method },
      "Stripe checkout session created with shipping"
    );

    return {
      sessionId: session.id,
      checkoutUrl: session.url!,
      expiresAt,
    };
  }

  /**
   * Create Checkout Session for multiple items with shipping and optional discounts
   * Mode: payment, quantity: 1 per item (unique 1-of-1 cards), expires in configured TTL
   * Discount applied via dynamic Stripe Coupon (negative line items not supported)
   * Includes shipping_options for deterministic shipping fee
   *
   * Discounts are stacked: lot discount applied first, promo discount applied to post-lot subtotal
   * Both discounts are combined into a single Stripe coupon (Stripe doesn't allow multiple)
   */
  async createMultiItemCheckoutSession(
    items: StripeItemData[],
    stripePriceIds: string[],
    shippingQuote: ShippingQuote,
    lotDiscount: LotDiscountInfo | null,
    promoDiscount: { code: string; discount_pct: number; discount_cents: number } | null,
    successUrl: string,
    cancelUrl: string
  ): Promise<MultiItemSessionResult> {
    const stripe = this.ensureStripe();

    if (items.length !== stripePriceIds.length) {
      throw new Error(`Item count mismatch: ${items.length} items, ${stripePriceIds.length} prices`);
    }

    if (items.length === 0) {
      throw new Error("Cannot create checkout session with zero items");
    }

    if (!shippingQuote.allowed || !shippingQuote.method || !shippingQuote.priceCents) {
      throw new Error("Invalid shipping quote: checkout not allowed or missing shipping details");
    }

    const ttlMinutes = runtimeConfig.stripeReservationTtlMinutes;
    const expiresAt = Math.floor(Date.now() / 1000) + ttlMinutes * 60;
    const itemUids = items.map((item) => item.item_uid);

    this.logger.info(
      { itemCount: items.length, itemUids, lotDiscount: lotDiscount?.discountPct ?? null, shippingMethod: shippingQuote.method, shippingCents: shippingQuote.priceCents, ttlMinutes },
      "Creating multi-item Stripe checkout session with shipping"
    );

    // Build line items for all products (each card is unique, qty=1)
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = stripePriceIds.map((priceId) => ({
      price: priceId,
      quantity: 1,
      adjustable_quantity: { enabled: false },
    }));

    // Create dynamic coupon for combined discounts if applicable
    // Stripe does NOT support negative line items or multiple coupons - must use single combined coupon
    // Stacking: lot discount applied first, promo discount applied to post-lot subtotal
    let couponId: string | undefined;
    const lotDiscountCents = lotDiscount?.discountAmountCents ?? 0;
    const promoDiscountCents = promoDiscount?.discount_cents ?? 0;
    const rawCombinedDiscountCents = lotDiscountCents + promoDiscountCents;

    // Cap combined discount to not exceed subtotal (safety guard)
    const subtotalCents = lotDiscount?.originalTotalCents ?? items.reduce((sum, item) => sum + item.price_cents, 0);
    const combinedDiscountCents = Math.min(rawCombinedDiscountCents, subtotalCents);

    if (combinedDiscountCents > 0) {
      // Build customer-facing name based on which discounts are applied
      let couponName: string;
      let couponType: string;

      if (lotDiscountCents > 0 && promoDiscountCents > 0) {
        // Both discounts - show combined
        couponName = `Bundle + Promo Savings ($${(combinedDiscountCents / 100).toFixed(2)} off)`;
        couponType = "combined";
      } else if (promoDiscountCents > 0) {
        // Promo only
        couponName = `Promo ${promoDiscount!.code} (${promoDiscount!.discount_pct}% off)`;
        couponType = "promo";
      } else {
        // Lot only
        couponName = `Bundle Savings (${lotDiscount!.discountPct}% off)`;
        couponType = "lot_builder";
      }

      const couponMetadata: Record<string, string> = {
        coupon_type: couponType,
        source: "system_generated",
        created_at: new Date().toISOString(),
      };

      // Add lot discount info if present
      if (lotDiscount) {
        couponMetadata.lot_discount_cents = lotDiscountCents.toString();
        couponMetadata.lot_discount_pct = lotDiscount.discountPct.toString();
        couponMetadata.lot_reason_code = lotDiscount.reasonCode;
        couponMetadata.lot_reason_text = lotDiscount.reasonText.slice(0, 200);
      }

      // Add promo discount info if present
      if (promoDiscount) {
        couponMetadata.promo_code = promoDiscount.code;
        couponMetadata.promo_discount_cents = promoDiscountCents.toString();
        couponMetadata.promo_discount_pct = promoDiscount.discount_pct.toString();
      }

      const coupon = await stripe.coupons.create({
        amount_off: combinedDiscountCents,
        currency: "usd",
        duration: "once",
        name: couponName,
        metadata: couponMetadata,
      });
      couponId = coupon.id;

      this.logger.info(
        {
          couponId,
          combinedDiscountCents,
          lotDiscountCents,
          promoDiscountCents,
          promoCode: promoDiscount?.code ?? null,
          lotReasonCode: lotDiscount?.reasonCode ?? null,
        },
        "Created Stripe coupon for combined discounts"
      );
    }

    // Calculate totals for metadata (used by webhook for fulfillment record)
    // subtotalCents is already calculated above (pre-discount total)
    // Final subtotal is original minus all discounts (lot + promo)
    const finalTotalCents = subtotalCents - combinedDiscountCents;

    // Prepare metadata with shipping info
    const metadata: Record<string, string> = {
      item_uids: JSON.stringify(itemUids),
      item_count: items.length.toString(),
      shipping_method: shippingQuote.method,
      shipping_cost_cents: shippingQuote.priceCents.toString(),
      requires_manual_review: shippingQuote.requiresManualReview ? "1" : "0",
      // Store both pre-discount and post-discount totals for operational clarity
      original_subtotal_cents: subtotalCents.toString(),
      final_subtotal_cents: finalTotalCents.toString(),
      // Combined discount for quick reference
      combined_discount_cents: combinedDiscountCents.toString(),
    };

    if (lotDiscount) {
      metadata.lot_discount_pct = lotDiscount.discountPct.toString();
      metadata.lot_discount_cents = lotDiscountCents.toString();
      metadata.lot_reason_code = lotDiscount.reasonCode;
    }

    if (promoDiscount) {
      metadata.promo_code = promoDiscount.code;
      metadata.promo_discount_pct = promoDiscount.discount_pct.toString();
      metadata.promo_discount_cents = promoDiscountCents.toString();
    }

    if (couponId) {
      metadata.stripe_coupon_id = couponId;
    }

    // Aggregate product_uids for correlation (first product_uid as representative)
    const productUid = items[0].product_uid;

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: lineItems,
      expires_at: expiresAt,
      success_url: successUrl,
      cancel_url: cancelUrl,
      shipping_address_collection: {
        allowed_countries: ["US"],
      },
      // Single shipping option - deterministic, no customer choice
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: {
              amount: shippingQuote.priceCents,
              currency: "usd",
            },
            display_name: shippingQuote.method === "PRIORITY"
              ? "Priority Mail (2-3 business days)"
              : "Tracked Shipping (3-5 business days)",
            delivery_estimate: {
              minimum: { unit: "business_day", value: shippingQuote.method === "PRIORITY" ? 2 : 3 },
              maximum: { unit: "business_day", value: shippingQuote.method === "PRIORITY" ? 3 : 5 },
            },
          },
        },
      ],
      metadata,
      payment_intent_data: {
        metadata: {
          item_uids: JSON.stringify(itemUids),
          item_count: items.length.toString(),
          product_uid: productUid,
        },
      },
    };

    // Apply coupon discount if created
    // Note: Stripe does not allow both allow_promotion_codes and discounts
    // When using bundle discounts, we don't allow promotion codes
    if (couponId) {
      sessionParams.discounts = [{ coupon: couponId }];
    } else {
      sessionParams.allow_promotion_codes = false;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    this.logger.info(
      {
        sessionId: session.id,
        itemUids,
        expiresAt,
        lotDiscountPct: lotDiscount?.discountPct ?? null,
        promoCode: promoDiscount?.code ?? null,
        promoDiscountPct: promoDiscount?.discount_pct ?? null,
        combinedDiscountCents,
        couponId,
        shippingMethod: shippingQuote.method,
      },
      "Multi-item Stripe checkout session created with shipping"
    );

    return {
      sessionId: session.id,
      checkoutUrl: session.url!,
      expiresAt,
      itemUids,
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
   * List checkout session line items (expanded to include Product metadata/images).
   */
  async listCheckoutSessionLineItems(sessionId: string): Promise<Stripe.ApiList<Stripe.LineItem>> {
    const stripe = this.ensureStripe();
    return stripe.checkout.sessions.listLineItems(sessionId, {
      expand: ["data.price.product"],
      limit: 100,
    });
  }

  /**
   * Check if Stripe is configured and available
   */
  isConfigured(): boolean {
    return this.stripe !== null;
  }
}
