/**
 * CardMint U.S. Shipping Resolver
 *
 * Deterministic shipping method selection for U.S.-only orders.
 * All shipments include tracking (tracked-only policy).
 *
 * Two-tier pricing:
 * - TRACKED (USPS Ground Advantage): $4.95 default
 * - PRIORITY (USPS Priority Mail): $9.95 for larger/higher-value orders
 *
 * Decision order:
 * 1. Geography check (U.S. only)
 * 2. Priority triggers: qty ≥20 OR subtotal ≥$45
 * 3. Default to TRACKED
 * 4. Flag orders >$100 for manual review (non-blocking)
 */

import {
  NON_US_MESSAGE,
  SHIPPING_STEP_COPY,
  PRIORITY_THRESHOLD_COPY,
} from "../domain/shipping";
import type {
  Cart,
  ShippingQuote,
} from "../domain/shipping";

/**
 * Pricing constants (USD)
 */
const PRICING = {
  TRACKED: 4.95,
  PRIORITY: 9.95,
} as const;

/**
 * Threshold constants
 */
const THRESHOLDS = {
  PRIORITY_MIN_QUANTITY: 20,
  PRIORITY_MIN_SUBTOTAL: 45,
  MANUAL_REVIEW_THRESHOLD: 100,
} as const;

/**
 * Quotes shipping method and price for a cart.
 *
 * @param cart - Cart details (quantity, subtotal, isUS)
 * @returns Shipping quote with method, price, and flags
 *
 * @example
 * ```ts
 * const quote = quoteShipping({
 *   isUS: true,
 *   quantity: 3,
 *   subtotal: 25.00,
 * });
 * // => { allowed: true, method: "TRACKED", price: 4.95, priceCents: 495 }
 * ```
 */
export function quoteShipping(cart: Cart): ShippingQuote {
  // Step 1: Geography check
  if (!cart.isUS) {
    return {
      allowed: false,
      reason: "US-only",
      explanation: NON_US_MESSAGE,
    };
  }

  let method: "TRACKED" | "PRIORITY";
  let price: number;
  let explanation: string = SHIPPING_STEP_COPY;

  // Step 2: Priority triggers (qty ≥20 OR subtotal ≥$45)
  const priorityByQuantity = cart.quantity >= THRESHOLDS.PRIORITY_MIN_QUANTITY;
  const priorityBySubtotal = cart.subtotal >= THRESHOLDS.PRIORITY_MIN_SUBTOTAL;

  if (priorityByQuantity || priorityBySubtotal) {
    method = "PRIORITY";
    price = PRICING.PRIORITY;
    explanation = PRIORITY_THRESHOLD_COPY;
  } else {
    // Step 3: Default to TRACKED
    method = "TRACKED";
    price = PRICING.TRACKED;
  }

  // Step 4: Manual review flag (non-blocking)
  const requiresManualReview = cart.subtotal > THRESHOLDS.MANUAL_REVIEW_THRESHOLD;

  return {
    allowed: true,
    method,
    price,
    priceCents: Math.round(price * 100),
    explanation,
    requiresManualReview,
  };
}

/**
 * Validates cart state before quoting shipping.
 * Throws error if cart data is invalid.
 */
export function validateCart(cart: Cart): void {
  if (cart.quantity < 0) {
    throw new Error("Cart quantity must be non-negative");
  }
  if (cart.subtotal < 0) {
    throw new Error("Cart subtotal must be non-negative");
  }
}

// Re-export types for convenience
export type { Cart, ShippingQuote } from "../domain/shipping";
