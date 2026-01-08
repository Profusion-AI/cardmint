/**
 * CSV Format Detector
 *
 * Auto-detects CSV format based on header columns.
 * Supports:
 * - TCGPlayer Shipping Export (full address data, label-ready)
 * - TCGPlayer Order List (no address, tracking/reconciliation only)
 * - TCGPlayer Pull Sheet (card-level line items with product details)
 * - EasyPost Tracking Export (tracking linkage)
 */

export type CsvFormat =
  | "tcgplayer_shipping"
  | "tcgplayer_orderlist"
  | "tcgplayer_pullsheet"
  | "easypost_tracking"
  | "unknown";

/**
 * Normalize header for comparison.
 * - Strips BOM (byte order mark)
 * - Trims whitespace
 * - Converts to lowercase
 */
function normalizeHeader(h: string): string {
  return h.replace(/^\uFEFF/, "").trim().toLowerCase();
}

/**
 * Required header sets for each format.
 * Multiple signature options per format for resilience against header changes.
 * Each array is a set of required headers; format matches if ANY set is fully present.
 */
const FORMAT_SIGNATURES: Record<Exclude<CsvFormat, "unknown">, string[][]> = {
  // TCGPlayer Shipping Export: has address fields
  // Signature: Order # + FirstName + Address1 (distinguishes from Order List)
  tcgplayer_shipping: [
    ["order #", "firstname", "address1"],
    ["order #", "first name", "address1"],   // Alternate: space in "First Name"
    ["order #", "firstname", "address 1"],   // Alternate: space in "Address 1"
  ],

  // TCGPlayer Order List: has buyer name but no address
  // Multiple signatures for resilience against TCGPlayer header changes:
  // Primary: Order # + Buyer Name + Product Amt
  // Fallbacks: alternative column names that uniquely identify Order List
  tcgplayer_orderlist: [
    ["order #", "buyer name", "product amt"],       // Current header names
    ["order #", "buyer name", "product amount"],    // Alternate: full word "Amount"
    ["order #", "buyer name", "total amt"],         // Alternate: "Total Amt" instead
    ["order #", "buyer name", "buyer paid"],        // Alternate: "Buyer Paid" is unique to Order List
    ["order #", "buyer name", "shipping type"],     // Alternate: "Shipping Type" is Order List specific
  ],

  // TCGPlayer Pull Sheet: card-level line items with "Order Quantity" field
  // "Order Quantity" is unique to Pull Sheet (format: "ORDER-ID:QTY")
  // Headers: Product Line, Product Name, Condition, Number, Set, Rarity, Quantity, Main Photo URL, Set Release Date, SkuId, Order Quantity
  tcgplayer_pullsheet: [
    ["product line", "product name", "order quantity"],           // Primary signature
    ["product name", "order quantity", "skuid"],                  // Alternate (case variations)
    ["product name", "order quantity", "sku id"],                 // Alternate: space in "Sku Id"
    ["product name", "set", "order quantity"],                    // Minimal signature
  ],

  // EasyPost exports: Tracking (delivery events) or Shipments (created labels)
  // Both can be used for tracking linkage - they share id + tracking_code
  easypost_tracking: [
    // Tracking export (has signed_by from delivery confirmation)
    ["id", "tracking_code", "signed_by"],
    ["tracker id", "tracking_code", "signed_by"],   // Alternate: "Tracker ID" header
    ["id", "tracking code", "signed_by"],           // Alternate: space in "Tracking Code"
    // Shipments export (has carrier, from_name - no signed_by)
    ["id", "tracking_code", "carrier"],             // Shipments export signature
    ["id", "tracking_code", "from_name"],           // Alternate shipments signature
  ],
};

/**
 * Detect CSV format from header row.
 *
 * @param rawHeaders - Array of header strings from first CSV row
 * @returns Detected format or 'unknown'
 */
export function detectCsvFormat(rawHeaders: string[]): CsvFormat {
  const normalizedHeaders = new Set(rawHeaders.map(normalizeHeader));

  // Check each format's signature options (multiple signatures per format)
  for (const [format, signatureOptions] of Object.entries(FORMAT_SIGNATURES)) {
    // Format matches if ANY of its signature options is fully present
    for (const requiredHeaders of signatureOptions) {
      const allPresent = requiredHeaders.every((h) => normalizedHeaders.has(h));
      if (allPresent) {
        return format as CsvFormat;
      }
    }
  }

  return "unknown";
}

/**
 * Extract headers from CSV content (first line).
 * Handles quoted fields and various delimiters.
 */
export function extractHeadersFromCsv(csvContent: string): string[] {
  // Get first line (handle both \n and \r\n)
  const firstLine = csvContent.split(/\r?\n/)[0];
  if (!firstLine) {
    return [];
  }

  // Simple CSV header parsing (handles quoted fields)
  const headers: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < firstLine.length; i++) {
    const char = firstLine[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      headers.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  // Push last field
  headers.push(current);

  return headers;
}

/**
 * Get human-readable format name for UI display.
 */
export function getFormatDisplayName(format: CsvFormat): string {
  switch (format) {
    case "tcgplayer_shipping":
      return "TCGPlayer Shipping Export";
    case "tcgplayer_orderlist":
      return "TCGPlayer Order List";
    case "tcgplayer_pullsheet":
      return "TCGPlayer Pull Sheet";
    case "easypost_tracking":
      return "EasyPost Tracking";
    case "unknown":
      return "Unknown Format";
  }
}
