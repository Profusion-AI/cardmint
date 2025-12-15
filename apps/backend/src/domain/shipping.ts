/**
 * Shipping domain types for CardMint
 *
 * Launch policy (Oct 31, 2025) — USPS-aligned, U.S.-only:
 * - PWE (Rigid Letter, non-machinable): $1.50, ≤1 oz, ≤2 Card Saver 2s, ≤3 raw cards.
 * - Tracked First-Class (Ground Advantage 0–4 oz): $4.95 default.
 * - Priority Mail: $9.95 when quantity ≥20 or subtotal ≥$45 (or ≥$200 safeguard).
 *
 * References:
 * - USPS Notice 123 (letter specs & pricing): https://pe.usps.com/text/dmm300/notice123.htm
 * - USPS First-Class Mail non-machinable rules: https://www.usps.com/ship/first-class-mail.htm
 * - USPS July 13, 2025 price update: https://about.usps.com/newsroom/national-releases/2025/0409-usps-recommends-new-prices-for-july-2025.htm
 */

export type ShippingMethod = "PWE" | "FIRST_CLASS" | "PRIORITY";

export interface Cart {
  /** Customer shipping address is in U.S. (50 states, DC, APO/FPO) */
  isUS: boolean;

  /** Cart uses store credit or is return/replacement shipment */
  usesStoreCredit: boolean;

  /** Total card quantity in cart (raw count of singles) */
  quantity: number;

  /** Cart subtotal before shipping (USD) */
  subtotal: number;

  /** Estimated packed weight in ounces (post-protection) */
  estimatedWeightOz: number;

  /** Number of Card Saver 2 holders in shipment */
  cardSaverCount: number;

  /** Total physical cards (allows PWE check when quantity != card count) */
  cardCount: number;

  /** Customer explicitly wants tracked shipping (disables PWE) */
  customerRequestsTracking?: boolean;

  /** Contains graded/slabbed cards, sealed items, or thick bundles ineligible for PWE */
  containsPWEIneligible: boolean;
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

  /** Customer-facing explanation of shipping choice */
  explanation?: string;
}

export interface ShippingResolverOptions {
  /** Enable high-value safeguard (≥$200 → Priority Mail) */
  highValueSafeguard?: boolean;
}

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
  "We automatically select the best U.S. shipping option. " +
  "Rigid letters ship non-machinable for premium protection. " +
  "Tracked packages cover everything else, and bigger orders upgrade to Priority.";

export const PWE_RIGID_COPY =
  "Rigid letter (non-machinable) for premium protection; no tracking included.";

export const STORE_CREDIT_COPY =
  "Store-credit shipments include tracking; the rigid letter option is not available.";

export const HIGH_VALUE_COPY =
  "High-value orders ship via Priority Mail for faster, safer delivery.";
