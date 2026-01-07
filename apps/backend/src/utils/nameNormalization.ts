/**
 * Name Normalization Utilities
 *
 * Shared helper for consistent name normalization across storage and matching.
 * Used by marketplace orders (TCGPlayer/eBay) and EasyPost tracking linking.
 */

/**
 * Normalize a customer name for matching purposes.
 *
 * Transformations:
 * 1. Convert to uppercase (case-insensitive matching)
 * 2. Trim leading/trailing whitespace
 * 3. Remove all punctuation (apostrophes, hyphens, periods, etc.)
 * 4. Normalize internal whitespace (multiple spaces → single space)
 *
 * Examples:
 * - "John O'Donnell" → "JOHN ODONNELL"
 * - "Mary-Jane Watson" → "MARYJANE WATSON"
 * - "  Bob   Smith  " → "BOB SMITH"
 * - "Dr. James Jr." → "DR JAMES JR"
 *
 * @param name - Raw customer name
 * @returns Normalized name suitable for matching
 */
export function normalizeNameForMatching(name: string): string {
  if (!name) return "";
  return name
    .toUpperCase()
    .trim()
    .replace(/[^\w\s]/g, "") // Remove all punctuation (keeps letters, numbers, spaces)
    .replace(/\s+/g, " "); // Normalize whitespace
}

/**
 * Re-normalize an existing normalized name.
 *
 * Used for migrating existing DB records that may have been normalized
 * with the old logic (which kept punctuation).
 *
 * @param normalizedName - Previously normalized name from DB
 * @returns Name normalized with current logic
 */
export function reNormalizeName(normalizedName: string): string {
  // Simply apply the same normalization - idempotent for correctly normalized names
  return normalizeNameForMatching(normalizedName);
}
