/**
 * TCGPlayer Pull Sheet CSV Importer
 *
 * Parses TCGPlayer Pull Sheet CSV and creates marketplace order items.
 * Supports dry-run mode for previewing imports.
 *
 * Key behaviors:
 * - Items can arrive BEFORE the order exists (Pull Sheet exported before Order List)
 * - Multiple items per order are supported
 * - Idempotent via UNIQUE(source, external_order_id, item_key) constraint
 * - Price confidence based on order data availability
 *
 * CSV Format (TCGPlayer Pull Sheet):
 * Product Line,Product Name,Condition,Number,Set,Rarity,Quantity,Main Photo URL,Set Release Date,SkuId,Order Quantity
 */

import { parse as parseCsv } from "csv-parse/sync";
import type { Logger } from "pino";
import { createHash } from "crypto";
import { computeChecksum } from "../../utils/encryption.js";
import { MarketplaceService } from "./marketplaceService.js";

// ============================================================================
// Types
// ============================================================================

export interface PullSheetCsvRow {
  "Product Line": string;       // "Pokemon"
  "Product Name": string;       // "Kabuto"
  Condition: string;            // "Lightly Played 1st Edition"
  Number: string;               // "50/62"
  Set: string;                  // "Fossil"
  Rarity: string;               // "Common"
  Quantity: string;             // "10" (seller inventory, not order qty)
  "Main Photo URL": string;     // Often empty
  "Set Release Date": string;   // "10/10/1999 00:00:00"
  SkuId: string;                // "2995546"
  "Order Quantity": string;     // "36666676-C978EE-DD7D0:10"
}

export interface ParsedItem {
  externalOrderId: string;      // Raw order ID (e.g., "36666676-C978EE-DD7D0")
  quantity: number;             // Quantity for THIS order
  itemKey: string;              // SKU or hash for uniqueness
  skuId: string | null;
  productName: string;
  setName: string | null;
  cardNumber: string | null;
  condition: string | null;
  rarity: string | null;
  productLine: string | null;
  setReleaseDate: number | null;
  imageUrl: string | null;
}

export interface PullSheetImportResult {
  batchId: number;
  dryRun: boolean;
  imported: number;             // Items inserted/updated
  skipped: number;              // Rows skipped (footer, invalid)
  attached: number;             // Items attached to existing orders
  unattached: number;           // Items without orders (awaiting Order List import)
  errors: Array<{ row: number; error: string }>;
  preview?: Array<{
    externalOrderId: string;
    itemKey: string;
    productName: string;
    quantity: number;
    hasOrder: boolean;
  }>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse "Order Quantity" field to extract order ID and quantity.
 * Format: "36666676-XXXX-XXXXX:QTY"
 *
 * @returns { orderId, quantity } or null if invalid
 */
function parseOrderQuantity(value: string): { orderId: string; quantity: number } | null {
  if (!value || !value.includes(":")) {
    return null;
  }

  const colonIdx = value.lastIndexOf(":");
  const orderId = value.substring(0, colonIdx).trim();
  const qtyStr = value.substring(colonIdx + 1).trim();
  const quantity = parseInt(qtyStr, 10);

  if (!orderId || isNaN(quantity) || quantity <= 0) {
    return null;
  }

  return { orderId, quantity };
}

/**
 * Generate deterministic item_key for uniqueness.
 *
 * If SKU is present and non-empty, use it directly.
 * Otherwise, generate a hash from card attributes.
 */
function generateItemKey(row: PullSheetCsvRow): string {
  const skuId = row.SkuId?.trim();
  if (skuId) {
    return `sku:${skuId}`;
  }

  // Fallback: hash of card attributes
  const parts = [
    row["Product Name"]?.trim() || "",
    row.Set?.trim() || "",
    row.Number?.trim() || "",
    row.Condition?.trim() || "",
    row.Rarity?.trim() || "",
    row["Product Line"]?.trim() || "",
  ].join("|");

  const hash = createHash("sha256").update(parts).digest("hex").substring(0, 16);
  return `hash:${hash}`;
}

/**
 * Parse set release date.
 * Format: "MM/DD/YYYY HH:MM:SS" or "MM/DD/YYYY"
 *
 * @returns Unix timestamp or null
 */
function parseSetReleaseDate(dateStr: string): number | null {
  if (!dateStr) return null;

  // Try MM/DD/YYYY format
  const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) {
    const [, month, day, year] = match;
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    if (!isNaN(date.getTime())) {
      return Math.floor(date.getTime() / 1000);
    }
  }

  return null;
}

/**
 * Validate image URL (only allow http/https schemes).
 */
function validateImageUrl(url: string | null | undefined): string | null {
  if (!url?.trim()) return null;
  const trimmed = url.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  return null;
}

/**
 * Check if a row is the footer row.
 * Footer format: "Orders Contained in Pull Sheet:,ORDER1|ORDER2|..."
 */
function isFooterRow(row: PullSheetCsvRow): boolean {
  const productLine = row["Product Line"]?.trim() || "";
  return productLine.toLowerCase().startsWith("orders contained");
}

// ============================================================================
// Importer Class
// ============================================================================

export class PullSheetImporter {
  constructor(
    private marketplaceService: MarketplaceService,
    private logger: Logger
  ) {}

  /**
   * Import Pull Sheet CSV content.
   *
   * Workflow:
   * 1. Parse CSV to extract items + order IDs
   * 2. Aggregate quantities in memory (per order+item to ensure idempotency)
   * 3. For each aggregated item:
   *    a. Check if order exists in marketplace_orders
   *    b. Upsert item with marketplace_order_id (nullable)
   *    c. Compute unit price if order exists and single-item
   * 4. Return summary
   *
   * @param csvContent - Raw CSV string
   * @param importedBy - Operator username
   * @param fileName - Original filename (for audit)
   * @param dryRun - If true, validate only without DB writes
   */
  async import(
    csvContent: string,
    importedBy: string,
    fileName: string | null,
    dryRun: boolean = true
  ): Promise<PullSheetImportResult> {
    const checksum = computeChecksum(csvContent);

    // Parse CSV
    let rows: PullSheetCsvRow[];
    try {
      rows = parseCsv(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count_less: true,
      });
    } catch (err: any) {
      this.logger.error({ error: err.message }, "PullSheetImporter: CSV parse failed");
      throw new Error(`CSV parse error: ${err.message}`);
    }

    // Phase 1: Parse and aggregate items by (orderId, itemKey)
    const aggregated = new Map<string, ParsedItem>();
    const errors: Array<{ row: number; error: string }> = [];
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // 1-indexed, skip header

      // Skip footer row
      if (isFooterRow(row)) {
        skipped++;
        continue;
      }

      // Parse Order Quantity
      const orderQty = parseOrderQuantity(row["Order Quantity"]);
      if (!orderQty) {
        errors.push({ row: rowNum, error: "Invalid or missing Order Quantity field" });
        skipped++;
        continue;
      }

      // Validate product name
      const productName = row["Product Name"]?.trim();
      if (!productName) {
        errors.push({ row: rowNum, error: "Missing Product Name" });
        skipped++;
        continue;
      }

      // Generate item key
      const itemKey = generateItemKey(row);
      const aggKey = `${orderQty.orderId}::${itemKey}`;

      // Aggregate (overwrite with latest data, sum quantities would break idempotency)
      // Per Codex QA: aggregate in memory, then upsert with OVERWRITE semantics
      const existing = aggregated.get(aggKey);
      if (existing) {
        // Same item in same order - use maximum quantity seen (idempotent)
        // This handles re-imports correctly
        existing.quantity = Math.max(existing.quantity, orderQty.quantity);
      } else {
        aggregated.set(aggKey, {
          externalOrderId: orderQty.orderId,
          quantity: orderQty.quantity,
          itemKey,
          skuId: row.SkuId?.trim() || null,
          productName,
          setName: row.Set?.trim() || null,
          cardNumber: row.Number?.trim() || null,
          condition: row.Condition?.trim() || null,
          rarity: row.Rarity?.trim() || null,
          productLine: row["Product Line"]?.trim() || null,
          setReleaseDate: parseSetReleaseDate(row["Set Release Date"]),
          imageUrl: validateImageUrl(row["Main Photo URL"]),
        });
      }
    }

    // Dry-run: return preview without DB writes
    if (dryRun) {
      const preview: PullSheetImportResult["preview"] = [];

      for (const item of aggregated.values()) {
        const order = this.marketplaceService.getOrderByExternalId("tcgplayer", item.externalOrderId);
        preview.push({
          externalOrderId: item.externalOrderId,
          itemKey: item.itemKey,
          productName: item.productName,
          quantity: item.quantity,
          hasOrder: !!order,
        });
      }

      return {
        batchId: 0,
        dryRun: true,
        imported: 0,
        skipped,
        attached: preview.filter((p) => p.hasOrder).length,
        unattached: preview.filter((p) => !p.hasOrder).length,
        errors,
        preview,
      };
    }

    // Phase 2: Create import batch
    // Use 'tcgplayer' per Codex QA (CHECK constraint)
    const batchId = this.marketplaceService.createImportBatch(
      "tcgplayer",
      importedBy,
      checksum,
      fileName,
      rows.length
    );

    // Phase 3: Upsert items
    let imported = 0;
    let attached = 0;
    let unattached = 0;

    // Group items by order for price computation
    const itemsByOrder = new Map<string, ParsedItem[]>();
    for (const item of aggregated.values()) {
      const existing = itemsByOrder.get(item.externalOrderId) || [];
      existing.push(item);
      itemsByOrder.set(item.externalOrderId, existing);
    }

    for (const [externalOrderId, items] of itemsByOrder.entries()) {
      // Look up order
      const order = this.marketplaceService.getOrderByExternalId("tcgplayer", externalOrderId);
      const marketplaceOrderId = order?.id ?? null;

      // Compute price confidence
      // Per Codex QA: use items array length (not order.item_count which may be 1 from Order List)
      const uniqueItemCount = items.length;
      const totalQty = items.reduce((sum, it) => sum + it.quantity, 0);

      for (const item of items) {
        let unitPriceCents: number | null = null;
        let priceConfidence: "exact" | "estimated" | "unavailable" = "unavailable";

        if (order && order.product_value_cents > 0) {
          if (uniqueItemCount === 1) {
            // Single unique item - exact price
            unitPriceCents = Math.round(order.product_value_cents / totalQty);
            priceConfidence = "exact";
          } else {
            // Multiple items - could estimate, but safer to leave unavailable
            // Per Codex QA: prefer NULL over estimated
            priceConfidence = "unavailable";
          }
        }

        try {
          this.marketplaceService.upsertOrderItem({
            marketplaceOrderId,
            source: "tcgplayer",
            externalOrderId,
            itemKey: item.itemKey,
            tcgplayerSkuId: item.skuId,
            productName: item.productName,
            setName: item.setName,
            cardNumber: item.cardNumber,
            condition: item.condition,
            rarity: item.rarity,
            productLine: item.productLine,
            setReleaseDate: item.setReleaseDate,
            quantity: item.quantity,
            unitPriceCents,
            priceConfidence,
            imageUrl: item.imageUrl,
            importBatchId: batchId,
          });

          imported++;
          if (marketplaceOrderId) {
            attached++;
          } else {
            unattached++;
          }
        } catch (err: any) {
          errors.push({
            row: 0, // Can't map back to row after aggregation
            error: `Item ${item.itemKey}: ${err.message}`,
          });
        }
      }
    }

    // Update batch status
    this.marketplaceService.updateImportBatch(
      batchId,
      imported,           // successCount
      skipped,            // skipCount
      errors.length,      // errorCount
      "completed",        // status
      errors.length > 0 ? JSON.stringify(errors) : null  // errorDetails
    );

    this.logger.info(
      { batchId, imported, attached, unattached, skipped, errors: errors.length },
      "PullSheetImporter: import complete"
    );

    return {
      batchId,
      dryRun: false,
      imported,
      skipped,
      attached,
      unattached,
      errors,
    };
  }
}
