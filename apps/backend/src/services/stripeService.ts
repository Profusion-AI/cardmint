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

/**
 * Distribute a target total across items proportionally, ensuring exact sum.
 * Uses largest-remainder method to allocate fractional cents deterministically.
 * This prevents cent drift when applying percentage discounts to multiple items.
 */
function allocateCentsProportionally(
  itemPriceCents: number[],
  targetTotalCents: number
): number[] {
  const originalTotal = itemPriceCents.reduce((a, b) => a + b, 0);
  if (originalTotal === 0) return itemPriceCents.map(() => 0);

  // Calculate ideal amounts (may have fractional cents)
  const idealAmounts = itemPriceCents.map(
    (price) => (price / originalTotal) * targetTotalCents
  );

  // Floor all amounts first
  const flooredAmounts = idealAmounts.map(Math.floor);
  let remaining = targetTotalCents - flooredAmounts.reduce((a, b) => a + b, 0);

  // Distribute remaining cents to items with largest fractional parts
  // Tie-breaker: lower index wins (deterministic across JS runtimes)
  const fractionalParts = idealAmounts.map((ideal, i) => ({
    index: i,
    fraction: ideal - flooredAmounts[i],
  }));
  fractionalParts.sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...flooredAmounts];
  for (let i = 0; i < remaining; i++) {
    result[fractionalParts[i].index]++;
  }

  return result;
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
   * Includes shipping_options for deterministic shipping fee
   *
   * Discount handling:
   * - Welcome codes (with stripe_promo_code_id): Use native Stripe Promotion Code
   *   This enables Stripe-side single-use enforcement via times_redeemed
   * - Lot discounts: Use dynamically-created Stripe Coupon
   * - Lot + Welcome stacking: Apply lot discount via proportionally-allocated
   *   line-item prices (guarantees exact finalTotalCents), welcome via promotion_code
   */
  async createMultiItemCheckoutSession(
    items: StripeItemData[],
    stripePriceIds: string[],
    shippingQuote: ShippingQuote,
    lotDiscount: LotDiscountInfo | null,
    promoDiscount: { code: string; discount_pct: number; discount_cents: number; stripe_promo_code_id?: string } | null,
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

    // Calculate discount values
    const lotDiscountCents = lotDiscount?.discountAmountCents ?? 0;
    const lotDiscountPct = lotDiscount?.discountPct ?? 0;
    const promoDiscountCents = promoDiscount?.discount_cents ?? 0;
    const subtotalCents = lotDiscount?.originalTotalCents ?? items.reduce((sum, item) => sum + item.price_cents, 0);

    // Stripe Checkout constraint: Only ONE discount entry allowed
    // Strategy:
    // - Welcome codes (with stripe_promo_code_id): Use { promotion_code } for native Stripe enforcement
    // - Lot discount only: Use { coupon }
    // - EverShop promo only: Use { coupon }
    // - Lot + Welcome: Apply lot discount via adjusted line-item prices, use promotion_code
    // - Lot + EverShop promo: Combine into single coupon
    const hasWelcomeCode = !!promoDiscount?.stripe_promo_code_id;
    const hasLotDiscount = lotDiscountCents > 0;
    const hasEvershopPromo = promoDiscount && !promoDiscount.stripe_promo_code_id && promoDiscountCents > 0;

    // Build line items - may use adjusted prices if lot + welcome stacking
    let lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
    let lotCouponId: string | undefined;
    let welcomePromoCodeId: string | undefined;
    let lotAppliedViaLineItems = false;

    if (hasLotDiscount && hasWelcomeCode) {
      // STACKING CASE: Lot discount + Welcome code
      // Apply lot discount via proportionally-allocated line-item prices (using price_data)
      // Use promotion_code for welcome code (enables Stripe native enforcement)
      const targetTotal = lotDiscount!.finalTotalCents;
      const itemPrices = items.map((item) => item.price_cents);
      const allocatedPrices = allocateCentsProportionally(itemPrices, targetTotal);

      // INVARIANT: Allocated prices must sum to target (prevents cent drift)
      const allocatedSum = allocatedPrices.reduce((a, b) => a + b, 0);
      if (allocatedSum !== targetTotal) {
        this.logger.error(
          { allocatedSum, targetTotal, itemPrices, allocatedPrices },
          "BUG: Cent allocation does not match target total"
        );
        throw new Error(`Cent allocation mismatch: ${allocatedSum} !== ${targetTotal}`);
      }

      lineItems = items.map((item, idx) => ({
        price_data: {
          currency: "usd",
          product: `cm_item_${item.item_uid}`,
          unit_amount: allocatedPrices[idx],
        },
        quantity: 1,
        adjustable_quantity: { enabled: false },
      }));

      welcomePromoCodeId = promoDiscount.stripe_promo_code_id;
      lotAppliedViaLineItems = true;

      this.logger.info(
        {
          lotDiscountPct,
          lotDiscountCents,
          targetTotal,
          allocatedPrices,
          welcomePromoCodeId,
          welcomeCode: promoDiscount.code,
          welcomeDiscountCents: promoDiscountCents,
        },
        "Lot + Welcome stacking: lot via allocated line-item prices, welcome via promotion_code"
      );
    } else {
      // Standard case: Use pre-created price IDs
      lineItems = stripePriceIds.map((priceId) => ({
        price: priceId,
        quantity: 1,
        adjustable_quantity: { enabled: false },
      }));

      // Welcome code only: Use promotion_code
      if (hasWelcomeCode) {
        welcomePromoCodeId = promoDiscount.stripe_promo_code_id;
        this.logger.info(
          {
            welcomePromoCodeId,
            promoCode: promoDiscount.code,
            discountCents: promoDiscountCents,
          },
          "Using Stripe Promotion Code for welcome discount (native enforcement)"
        );
      }

      // Lot discount only (no welcome code): Use coupon
      if (hasLotDiscount && !hasWelcomeCode) {
        const couponName = `Bundle Savings (${lotDiscountPct}% off)`;
        const coupon = await stripe.coupons.create({
          amount_off: lotDiscountCents,
          currency: "usd",
          duration: "once",
          name: couponName,
          metadata: {
            coupon_type: "lot_builder",
            source: "system_generated",
            created_at: new Date().toISOString(),
            lot_discount_cents: lotDiscountCents.toString(),
            lot_discount_pct: lotDiscountPct.toString(),
            lot_reason_code: lotDiscount!.reasonCode,
            lot_reason_text: lotDiscount!.reasonText.slice(0, 200),
          },
        });
        lotCouponId = coupon.id;

        this.logger.info(
          { lotCouponId, lotDiscountCents, lotReasonCode: lotDiscount!.reasonCode },
          "Created Stripe coupon for lot discount"
        );
      }

      // EverShop promo code: Use coupon (combine with lot if both present)
      if (hasEvershopPromo) {
        if (lotCouponId) {
          // Lot + EverShop promo: Combine into single coupon
          await stripe.coupons.del(lotCouponId);
          const combinedCents = Math.min(lotDiscountCents + promoDiscountCents, subtotalCents);
          const combinedCoupon = await stripe.coupons.create({
            amount_off: combinedCents,
            currency: "usd",
            duration: "once",
            name: `Bundle + Promo Savings ($${(combinedCents / 100).toFixed(2)} off)`,
            metadata: {
              coupon_type: "combined",
              source: "system_generated",
              created_at: new Date().toISOString(),
              lot_discount_cents: lotDiscountCents.toString(),
              lot_discount_pct: lotDiscountPct.toString(),
              lot_reason_code: lotDiscount!.reasonCode,
              promo_code: promoDiscount!.code,
              promo_discount_cents: promoDiscountCents.toString(),
              promo_discount_pct: promoDiscount!.discount_pct.toString(),
            },
          });
          lotCouponId = combinedCoupon.id;
          this.logger.info({ combinedCouponId: lotCouponId, combinedCents }, "Created combined coupon for lot + EverShop promo");
        } else {
          // EverShop promo only
          const promoCoupon = await stripe.coupons.create({
            amount_off: promoDiscountCents,
            currency: "usd",
            duration: "once",
            name: `Promo ${promoDiscount!.code} (${promoDiscount!.discount_pct}% off)`,
            metadata: {
              coupon_type: "promo",
              source: "system_generated",
              created_at: new Date().toISOString(),
              promo_code: promoDiscount!.code,
              promo_discount_cents: promoDiscountCents.toString(),
              promo_discount_pct: promoDiscount!.discount_pct.toString(),
            },
          });
          lotCouponId = promoCoupon.id;
        }
      }
    }

    // Calculate combined discount for metadata (for analytics)
    const combinedDiscountCents = Math.min(lotDiscountCents + promoDiscountCents, subtotalCents);

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
      // Track how lot discount was applied (for operational clarity)
      metadata.lot_applied_via = lotAppliedViaLineItems ? "line_item_prices" : "coupon";
    }

    if (promoDiscount) {
      metadata.promo_code = promoDiscount.code;
      metadata.promo_discount_pct = promoDiscount.discount_pct.toString();
      metadata.promo_discount_cents = promoDiscountCents.toString();
      // Track whether this is a welcome code (native enforcement) or EverShop coupon
      if (promoDiscount.stripe_promo_code_id) {
        metadata.welcome_promo_code_id = promoDiscount.stripe_promo_code_id;
      }
    }

    if (lotCouponId) {
      metadata.stripe_coupon_id = lotCouponId;
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

    // Apply single discount (Stripe constraint: only ONE discount entry allowed)
    // - Lot + Welcome: lot applied via line-item prices, use promotion_code only
    // - Lot only: use coupon
    // - Welcome only: use promotion_code
    // - EverShop promo (± lot): combined into single coupon
    //
    // INVARIANT: Only one of lotCouponId or welcomePromoCodeId should be set
    if (lotCouponId && welcomePromoCodeId) {
      // This should never happen due to the logic above, but guard anyway
      throw new Error("BUG: Both lotCouponId and welcomePromoCodeId set - violates Stripe single-discount constraint");
    }

    if (lotCouponId) {
      sessionParams.discounts = [{ coupon: lotCouponId }];
    } else if (welcomePromoCodeId) {
      sessionParams.discounts = [{ promotion_code: welcomePromoCodeId }];
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
        lotCouponId: lotCouponId ?? null,
        welcomePromoCodeId: welcomePromoCodeId ?? null,
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
