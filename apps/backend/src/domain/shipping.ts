/**
 * Shipping domain types for CardMint
 *
 * Shipping Policy (Dec 2025) — Tracked-only, U.S.-only:
 * - Tracked Package (USPS Ground Advantage): $4.95 default.
 * - Priority Mail: $9.95 when quantity ≥20 or subtotal ≥$45.
 *
 * All shipments include tracking. CardMint does not offer an untracked shipping option.
 *
 * References:
 * - USPS Ground Advantage: https://www.usps.com/ship/ground-advantage.htm
 * - CardMint Shipping Policy: docs/POLICY_SHIPPING_2025-10-31.md
 */

export type ShippingMethod = "TRACKED" | "PRIORITY";

export interface Cart {
  /** Customer shipping address is in U.S. (50 states, DC, APO/FPO) */
  isUS: boolean;

  /** Total card quantity in cart (raw count of singles) */
  quantity: number;

  /** Cart subtotal before shipping (USD) */
  subtotal: number;
}

export interface ShippingQuote {
  /** Whether checkout is allowed */
  allowed: boolean;

  /** Reason if not allowed (e.g., "US-only") */
  reason?: string;

  /** Selected shipping method */
  method?: ShippingMethod;

  /** Shipping price in USD */
  price?: number;

  /** Shipping price in cents (for Stripe) */
  priceCents?: number;

  /** Customer-facing explanation of shipping choice */
  explanation?: string;

  /** Flag for orders >$100 requiring manual review before label purchase */
  requiresManualReview?: boolean;
}

// ShippingResolverOptions removed - high-value safeguard was redundant with $45 threshold

/**
 * Non-U.S. checkout message
 */
export const NON_US_MESSAGE =
  "We're sorry. At the moment, CardMint only ships to U.S. addresses. " +
  "We look forward to shipping internationally soon! " +
  "Please feel free to contact support@cardmintshop.com for further inquiries about international shipping.";

/**
 * Customer-facing microcopy for shipping step
 */
export const SHIPPING_STEP_COPY =
  "All orders ship with tracking via USPS. " +
  "Orders of 20+ cards or $45+ ship Priority Mail for faster delivery.";

export const PRIORITY_THRESHOLD_COPY =
  "Your order qualifies for Priority Mail shipping with faster 2-3 day delivery.";
