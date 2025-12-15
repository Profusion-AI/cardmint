/**
 * CardMint U.S. Shipping Resolver (MVP)
 *
 * Deterministic shipping method selection for U.S.-only orders.
 * Implements three-tier pricing with PWE/First-Class/Priority based on
 * quantity, value, and cart contents.
 *
 * Decision order:
 * 1. Geography check (U.S. only)
 * 2. Store-credit rule (no PWE when store credit used)
 * 3. PWE eligibility (1-5 cards, ≤$14.99, no ineligible items)
 * 4. Priority trigger (≥20 cards OR ≥$45 subtotal)
 * 5. Default to Tracked First-Class
 * 6. High-value safeguard (≥$200 → Priority)
 */

import {
  NON_US_MESSAGE,
  PWE_RIGID_COPY,
  SHIPPING_STEP_COPY,
  STORE_CREDIT_COPY,
  HIGH_VALUE_COPY,
} from "../domain/shipping";
import type {
  Cart,
  ShippingQuote,
  ShippingResolverOptions,
} from "../domain/shipping";

/**
 * Pricing constants (USD)
 */
const PRICING = {
  PWE: 1.5,
  FIRST_CLASS: 4.95,
  PRIORITY: 9.95,
} as const;

/**
 * Threshold constants
 */
const THRESHOLDS = {
  PWE_MAX_WEIGHT_OZ: 1.0,
  PWE_MAX_CARD_SAVERS: 2,
  PWE_MAX_CARDS: 3,
  PRIORITY_MIN_QUANTITY: 20,
  PRIORITY_MIN_SUBTOTAL: 45,
  HIGH_VALUE_SAFEGUARD: 200,
} as const;

/**
 * Quotes shipping method and price for a cart.
 *
 * @param cart - Cart details (quantity, subtotal, eligibility flags)
 * @param options - Resolver options (high-value safeguard toggle)
 * @returns Shipping quote with method, price, and customer-facing explanation
 *
 * @example
 * ```ts
 * const quote = quoteShipping({
 *   isUS: true,
 *   usesStoreCredit: false,
 *   quantity: 3,
 *   subtotal: 12.00,
 *   containsPWEIneligible: false
 * });
 * // => { allowed: true, method: "PWE", price: 1.00, explanation: "..." }
 * ```
 */
export function quoteShipping(
  cart: Cart,
  options: ShippingResolverOptions = { highValueSafeguard: true },
): ShippingQuote {
  // Step 1: Geography check
  if (!cart.isUS) {
    return {
      allowed: false,
      reason: "US-only",
      explanation: NON_US_MESSAGE,
    };
  }

  let method: "PWE" | "FIRST_CLASS" | "PRIORITY";
  let price: number;
  let explanation: string = SHIPPING_STEP_COPY;

  // Step 2-3: PWE eligibility check
  const wantsTracking = cart.customerRequestsTracking ?? false;
  const cardSaverCount = cart.cardSaverCount ?? 0;
  const cardCount = cart.cardCount ?? cart.quantity;
  const pweEligible =
    !cart.usesStoreCredit &&
    !cart.containsPWEIneligible &&
    !wantsTracking &&
    cart.quantity >= 1 &&
    cart.estimatedWeightOz > 0 &&
    cart.estimatedWeightOz <= THRESHOLDS.PWE_MAX_WEIGHT_OZ &&
    cardSaverCount <= THRESHOLDS.PWE_MAX_CARD_SAVERS &&
    cardCount <= THRESHOLDS.PWE_MAX_CARDS;

  if (pweEligible) {
    method = "PWE";
    price = PRICING.PWE;
    explanation = PWE_RIGID_COPY;
  } else if (
    cart.quantity >= THRESHOLDS.PRIORITY_MIN_QUANTITY ||
    cart.subtotal >= THRESHOLDS.PRIORITY_MIN_SUBTOTAL
  ) {
    // Step 4: Priority trigger
    method = "PRIORITY";
    price = PRICING.PRIORITY;
  } else {
    // Step 5: Default to First-Class
    method = "FIRST_CLASS";
    price = PRICING.FIRST_CLASS;
  }

  // Step 6: High-value safeguard
  if (
    options.highValueSafeguard &&
    cart.subtotal >= THRESHOLDS.HIGH_VALUE_SAFEGUARD
  ) {
    method = "PRIORITY";
    price = PRICING.PRIORITY;
    explanation = HIGH_VALUE_COPY;
  }

  // Customer requested tracking - ensure at least First-Class
  if (wantsTracking && method === "PWE") {
    method = "FIRST_CLASS";
    price = PRICING.FIRST_CLASS;
  }

  // Enforce $4.95 minimum when store credit is used
  if (
    cart.usesStoreCredit &&
    (method === "PWE" || price < PRICING.FIRST_CLASS)
  ) {
    method = "FIRST_CLASS";
    price = PRICING.FIRST_CLASS;
  }

  // Update explanations based on final method
  if (cart.usesStoreCredit && method === "FIRST_CLASS") {
    explanation = STORE_CREDIT_COPY;
  } else if (wantsTracking && method === "FIRST_CLASS") {
    explanation = "Tracking requested; upgraded to Tracked Package.";
  }

  return {
    allowed: true,
    method,
    price,
    explanation,
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
  if (cart.estimatedWeightOz < 0) {
    throw new Error("Cart estimated weight must be non-negative");
  }
  if (cart.cardSaverCount < 0) {
    throw new Error("Card Saver count must be non-negative");
  }
  if (cart.cardCount < 0) {
    throw new Error("Card count must be non-negative");
  }
}
