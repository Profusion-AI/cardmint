/**
 * Search Query Parser
 *
 * Detects the type of search query for unified fulfillment search.
 * Uses heuristics based on query patterns.
 */

export type QueryType = "tracking" | "order_number" | "customer_name" | "date" | "card_name";

/**
 * Detect if query looks like a date string.
 *
 * Patterns:
 * - YYYY-MM-DD (ISO format)
 * - MM/DD/YYYY or MM/DD/YY (US format)
 * - MM/DD (current year implied)
 * - "Jan 15" or "January 15" (month name + day)
 */
function detectDateQuery(query: string): boolean {
  const trimmed = query.trim();

  // ISO format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return true;
  }

  // US format: MM/DD/YYYY or MM/DD/YY
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(trimmed)) {
    return true;
  }

  // Short US format: MM/DD (current year implied)
  if (/^\d{1,2}\/\d{1,2}$/.test(trimmed)) {
    return true;
  }

  // Month name + day: "Jan 15", "January 15"
  const monthNamePattern = /^(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)\s+\d{1,2}$/i;
  if (monthNamePattern.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Detect the type of search query based on pattern matching.
 *
 * Heuristics:
 * - Date: YYYY-MM-DD, MM/DD/YYYY, MM/DD, "Jan 15"
 * - USPS tracking: 20-22 digit number starting with '9'
 * - UPS tracking: '1Z' followed by alphanumeric
 * - FedEx tracking: 12-22 digit number
 * - TCGPlayer order: 'TCGP-XXXXXX-XXXXX' or raw UUID-like format
 * - CardMint order: 'TCG-YYYYMMDD-NNNNNN' or 'EBAY-YYYYMMDD-NNNNNN'
 * - Customer name: fallback for anything else
 *
 * @param query - The raw search query
 * @returns The detected query type
 */
export function detectQueryType(query: string): QueryType {
  const trimmed = query.trim();

  if (!trimmed || trimmed.length < 2) {
    return "customer_name";
  }

  // Check for date patterns first
  if (detectDateQuery(trimmed)) {
    return "date";
  }

  // USPS tracking: 20-22 digit number starting with 9
  if (/^9\d{19,24}$/.test(trimmed)) {
    return "tracking";
  }

  // USPS international: 2 letters + 9 digits + 'US'
  if (/^[A-Z]{2}\d{9}US$/i.test(trimmed)) {
    return "tracking";
  }

  // UPS tracking: starts with '1Z'
  if (/^1Z[A-Z0-9]{16,}$/i.test(trimmed)) {
    return "tracking";
  }

  // FedEx tracking: 12-22 digits
  if (/^\d{12,22}$/.test(trimmed)) {
    return "tracking";
  }

  // TCGPlayer formatted order number: TCGP-XXXXXX-XXXXX
  if (/^TCGP-[A-Z0-9]{6}-[A-Z0-9]{5}$/i.test(trimmed)) {
    return "order_number";
  }

  // Raw TCGPlayer order ID: 36666676-... (UUID-like)
  if (/^\d{8}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{12}$/i.test(trimmed)) {
    return "order_number";
  }

  // CardMint order number: TCG-YYYYMMDD-NNNNNN or EBAY-YYYYMMDD-NNNNNN
  if (/^(TCG|EBAY)-\d{8}-\d{6}$/i.test(trimmed)) {
    return "order_number";
  }

  // Stripe session ID prefix
  if (/^cs_test_|^cs_live_|^Session:/i.test(trimmed)) {
    return "order_number";
  }

  // If mostly numbers and dashes, probably an order number
  if (/^[\d-]+$/.test(trimmed) && trimmed.length >= 8) {
    return "order_number";
  }

  // Default: assume customer name
  return "customer_name";
}

/**
 * Normalize a search query for matching.
 * - Trims whitespace
 * - Uppercase for tracking/order numbers
 * - Normalize name for customer search
 * - Keep date as-is (parsing happens in search function)
 *
 * @param query - The raw search query
 * @param type - The detected query type
 * @returns Normalized query string
 */
export function normalizeQuery(query: string, type: QueryType): string {
  const trimmed = query.trim();

  if (type === "tracking" || type === "order_number") {
    return trimmed.toUpperCase();
  }

  if (type === "date" || type === "card_name") {
    // Keep original casing for date parsing and card name matching
    return trimmed;
  }

  // Customer name: normalize for fuzzy matching
  return trimmed.toUpperCase().replace(/[^A-Z0-9 ]/g, "");
}
