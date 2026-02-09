/**
 * Normalize a collector number for symmetric matching across inventory and reference DBs.
 *
 * Rules:
 *   "177/264" → "177"     strip /total suffix
 *   "099/102" → "99"      strip leading zeros
 *   "007"     → "7"       strip leading zeros
 *   "0"       → "0"       zero stays zero
 *   "TG05"    → "tg05"    lowercase, strip leading zeros after prefix
 *   "002a/131"→ "2a"      strip /total, strip leading zeros before alpha suffix
 *   null      → null
 *   ""        → null
 */
export function normalizeCollectorNo(raw: string | null | undefined): string | null {
  if (raw == null || raw === "") return null;

  // Strip /total suffix (e.g. "4/102" → "4", "002a/131" → "002a")
  let value = raw.split("/")[0].trim();

  if (value === "") return null;

  // Lowercase for case-insensitive matching
  value = value.toLowerCase();

  // Strip leading zeros, but preserve at least one char.
  // Handle cases like "007" → "7", "0" → "0", "002a" → "2a", "TG05" → "tg05"
  // Strategy: find first non-zero char; if it's a digit or letter, strip zeros before it.
  // Special case: if all digits are zero (e.g. "0", "00"), keep single "0".
  value = value.replace(/^0+(?=.)/, "");

  return value || "0";
}
