/**
 * Slug generation utilities for CardMint product pages (backend).
 *
 * Format: {card-name}-{set-name}-{card-number}-{uid8}
 * Example: pikachu-base-set-25-a1b2c3d4
 *
 * Uses last 8 characters of product_uid for uniqueness guarantee.
 * Every product page is unique to a specific scan/asset. Once an item sells,
 * the listing (and slug) is deleted.
 */

/**
 * Generates a URL-safe slug from a card name.
 * Removes special characters, converts spaces to hyphens, lowercases.
 */
export function slugifyCardName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special chars except spaces and hyphens
    .replace(/\s+/g, '-')      // Replace spaces with hyphens
    .replace(/-+/g, '-');      // Collapse multiple hyphens
}

/**
 * Generates a URL-safe slug from a set name.
 * Handles common Pokemon set naming patterns.
 */
export function slugifySetName(setName: string): string {
  return setName
    .toLowerCase()
    .trim()
    .replace(/pokemon\s*/gi, '') // Remove "Pokemon" prefix
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');    // Trim leading/trailing hyphens
}

/**
 * Extracts card number from collector number (removes denominator).
 * Examples: "25/102" → "25", "14/108" → "14", "SWSH001" → "swsh001"
 */
export function extractCardNumber(collectorNumber: string | null | undefined): string {
  if (!collectorNumber) return '';

  const cleanNum = collectorNumber.trim();

  // If format is "X/Y", return just X
  if (cleanNum.includes('/')) {
    return cleanNum.split('/')[0].trim();
  }

  // Otherwise return as-is (lowercased for consistency)
  return cleanNum.toLowerCase();
}

/**
 * Generates a complete product slug for a CardMint listing.
 *
 * @param cardName - Card name (e.g., "Pikachu")
 * @param setName - Set name (e.g., "Base Set" or "Pokemon Evolutions")
 * @param collectorNumber - Collector number (e.g., "25/102" or "14/108")
 * @param productUid - Product UID (UUID v4, last 8 chars used for uniqueness)
 * @returns URL-safe slug (e.g., "pikachu-base-set-25-a1b2c3d4")
 */
export function generateProductSlug(
  cardName: string,
  setName: string,
  collectorNumber: string | null | undefined,
  productUid: string
): string {
  const slugName = slugifyCardName(cardName);
  const slugSet = slugifySetName(setName);
  const slugNumber = extractCardNumber(collectorNumber);
  const uid8 = productUid.slice(-8).toLowerCase(); // Last 8 chars of UUID

  const parts = [slugName, slugSet];
  if (slugNumber) {
    parts.push(slugNumber);
  }
  parts.push(uid8);

  return parts.join('-');
}

/**
 * Parses a product slug back into its components.
 * Useful for debugging and analytics.
 *
 * @param slug - Product slug (e.g., "pikachu-base-set-25-a1b2c3d4")
 * @returns Object with parsed components, or null if invalid format
 */
export function parseProductSlug(slug: string): {
  cardName: string;
  setName: string;
  cardNumber: string | null;
  uid8: string;
} | null {
  // Expected format: {name}-{set}-{?number}-{uid8}
  // uid8 is always the last segment (8 alphanumeric chars)

  const segments = slug.split('-');
  if (segments.length < 3) return null;

  const lastSegment = segments[segments.length - 1];

  // Validate uid8 format (8 hex chars)
  if (!/^[a-f0-9]{8}$/.test(lastSegment)) return null;

  const uid8 = lastSegment;

  // Remove uid8 from end
  const withoutUid = segments.slice(0, -1);

  // Last segment before uid8 might be card number (if numeric or alphanumeric like "swsh001")
  const possibleNumber = withoutUid[withoutUid.length - 1];
  const hasCardNumber = /^\d+$/.test(possibleNumber) || /^[a-z]+\d+$/.test(possibleNumber);

  let cardNumber: string | null = null;
  let restSegments: string[];

  if (hasCardNumber) {
    cardNumber = possibleNumber;
    restSegments = withoutUid.slice(0, -1);
  } else {
    restSegments = withoutUid;
  }

  // Remaining segments are card name + set name
  // We don't know the exact split, so just reconstruct as best guess
  // (This is lossy - for production use, query DB by product_slug directly)

  if (restSegments.length === 0) return null;

  // Simple heuristic: first half is card name, second half is set name
  const midpoint = Math.ceil(restSegments.length / 2);
  const cardName = restSegments.slice(0, midpoint).join('-');
  const setName = restSegments.slice(midpoint).join('-');

  return {
    cardName,
    setName,
    cardNumber,
    uid8,
  };
}
