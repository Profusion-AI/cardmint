/**
 * TCGPlayer Order Number Formatting Utilities
 *
 * Handles conversion between raw TCGPlayer order IDs (with seller prefix)
 * and display format (TCGP-...).
 *
 * Raw format:    36666676-C978EE-DD7D0  (seller ID + order suffix)
 * Display format: TCGP-C978EE-DD7D0     (normalized for operator UX)
 *
 * Used across fulfillment dashboard surfaces:
 * - Unified list view
 * - Order details
 * - Print queue
 * - EasyPost tracking matching (input parsing)
 */

/** CardMint's TCGPlayer seller ID prefix */
const TCGPLAYER_SELLER_PREFIX = "36666676";

/** Display prefix for TCGPlayer orders */
const TCGPLAYER_DISPLAY_PREFIX = "TCGP";

/**
 * Format a raw TCGPlayer external_order_id for display.
 *
 * Converts the seller ID prefix to "TCGP" for cleaner operator UX.
 * Non-TCGPlayer order IDs pass through unchanged.
 *
 * Examples:
 * - "36666676-C978EE-DD7D0" → "TCGP-C978EE-DD7D0"
 * - "TCGP-C978EE-DD7D0" → "TCGP-C978EE-DD7D0" (idempotent)
 * - "some-other-id" → "some-other-id" (pass-through)
 *
 * @param externalOrderId - Raw external_order_id from DB or CSV
 * @returns Display-formatted order number
 */
export function formatTcgplayerOrderNumber(externalOrderId: string | null | undefined): string {
  if (!externalOrderId) return "";

  const trimmed = externalOrderId.trim();

  // Already formatted - return as-is (idempotent)
  if (trimmed.toUpperCase().startsWith(`${TCGPLAYER_DISPLAY_PREFIX}-`)) {
    return `${TCGPLAYER_DISPLAY_PREFIX}-${trimmed.substring(5)}`;
  }

  // Raw TCGPlayer format - convert
  if (trimmed.startsWith(`${TCGPLAYER_SELLER_PREFIX}-`)) {
    return `${TCGPLAYER_DISPLAY_PREFIX}-${trimmed.substring(TCGPLAYER_SELLER_PREFIX.length + 1)}`;
  }

  // Not a recognized TCGPlayer format - pass through unchanged
  return trimmed;
}

/**
 * Parse a display-formatted TCGPlayer order number back to raw format.
 *
 * Used when accepting order numbers as input (e.g., CSV reference field,
 * operator search) and needing to match against stored external_order_id.
 *
 * Examples:
 * - "TCGP-C978EE-DD7D0" → "36666676-C978EE-DD7D0"
 * - "tcgp-c978ee-dd7d0" → "36666676-C978EE-DD7D0" (case-insensitive)
 * - "36666676-C978EE-DD7D0" → "36666676-C978EE-DD7D0" (pass-through)
 * - "some-other-id" → "some-other-id" (pass-through)
 *
 * @param displayOrderNumber - Display-formatted or raw order number
 * @returns Raw external_order_id format for DB queries
 */
export function parseTcgplayerOrderNumber(displayOrderNumber: string | null | undefined): string {
  if (!displayOrderNumber) return "";

  const trimmed = displayOrderNumber.trim();
  const upper = trimmed.toUpperCase();

  // Display format - convert to raw
  if (upper.startsWith(`${TCGPLAYER_DISPLAY_PREFIX}-`)) {
    // Preserve the original case of the suffix (order IDs are case-sensitive)
    const suffix = trimmed.substring(5);
    return `${TCGPLAYER_SELLER_PREFIX}-${suffix}`;
  }

  // Already raw format or unknown - pass through
  return trimmed;
}

/**
 * Check if an order number appears to be a TCGPlayer order.
 *
 * Recognizes both raw (36666676-...) and display (TCGP-...) formats.
 *
 * @param orderNumber - Order number in any format
 * @returns true if this looks like a TCGPlayer order
 */
export function isTcgplayerOrderNumber(orderNumber: string | null | undefined): boolean {
  if (!orderNumber) return false;

  const trimmed = orderNumber.trim();
  const upper = trimmed.toUpperCase();

  return (
    trimmed.startsWith(`${TCGPLAYER_SELLER_PREFIX}-`) ||
    upper.startsWith(`${TCGPLAYER_DISPLAY_PREFIX}-`)
  );
}

/**
 * Extract the order suffix (the part after the prefix) from either format.
 *
 * Useful for generating stable item keys or doing suffix-based matching.
 *
 * Examples:
 * - "36666676-C978EE-DD7D0" → "C978EE-DD7D0"
 * - "TCGP-C978EE-DD7D0" → "C978EE-DD7D0"
 * - "other" → "other"
 *
 * @param orderNumber - Order number in any format
 * @returns Order suffix without prefix
 */
export function extractTcgplayerOrderSuffix(orderNumber: string | null | undefined): string {
  if (!orderNumber) return "";

  const trimmed = orderNumber.trim();
  const upper = trimmed.toUpperCase();

  if (trimmed.startsWith(`${TCGPLAYER_SELLER_PREFIX}-`)) {
    return trimmed.substring(TCGPLAYER_SELLER_PREFIX.length + 1);
  }

  if (upper.startsWith(`${TCGPLAYER_DISPLAY_PREFIX}-`)) {
    return trimmed.substring(5);
  }

  return trimmed;
}
