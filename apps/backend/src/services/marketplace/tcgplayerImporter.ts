/**
 * TCGPlayer CSV Importer
 *
 * Parses TCGPlayer Shipping Export CSV and creates marketplace orders.
 * Supports dry-run mode for previewing imports.
 *
 * CSV Format (TCGPlayer Shipping Export):
 * Order #,FirstName,LastName,Address1,Address2,City,State,PostalCode,Country,
 * Order Date,Product Weight,Shipping Method,Item Count,Value Of Products,
 * Shipping Fee Paid,Tracking #,Carrier
 */

import { parse as parseCsv } from "csv-parse/sync";
import type { Logger } from "pino";
import { computeChecksum } from "../../utils/encryption";
import {
  MarketplaceService,
  type CreateOrderInput,
  type ShippingAddress,
} from "./marketplaceService";

// ============================================================================
// Types
// ============================================================================

export interface TcgplayerCsvRow {
  "Order #": string;
  FirstName: string;
  LastName: string;
  Address1: string;
  Address2: string;
  City: string;
  State: string;
  PostalCode: string;
  Country: string;
  "Order Date": string;
  "Product Weight": string;
  "Shipping Method": string;
  "Item Count": string;
  "Value Of Products": string;
  "Shipping Fee Paid": string;
  "Tracking #": string;
  Carrier: string;
}

/**
 * TCGPlayer Order List CSV row structure.
 * Different from Shipping Export: no address, different date format, combined buyer name.
 */
export interface TcgplayerOrderListRow {
  "Order #": string;
  "Buyer Name": string;
  "Order Date": string; // "Saturday, 03 January 2026"
  Status: string;
  "Shipping Type": string;
  "Product Amt": string;
  "Shipping Amt": string;
  "Total Amt": string;
  "Buyer Paid": string;
  "Carrier Information": string;
}

export interface ImportResult {
  batchId: number;
  dryRun: boolean;
  imported: number;
  skipped: number;
  upgraded: number; // Order List → Shipping Export upgrades
  errors: Array<{ row: number; orderId: string; error: string }>;
  preview?: Array<{
    orderId: string;
    customerName: string;
    displayOrderNumber: string;
    itemCount: number;
    valueCents: number;
    orderDate: string;
    status: "new" | "exists" | "upgrade";
  }>;
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse TCGPlayer Shipping Export date as CST midnight.
 *
 * TCGPlayer exports dates in formats like "2025-12-30" or "12/30/2025".
 * We interpret these as CST (America/Chicago) midnight for consistent
 * date matching with EasyPost tracking timestamps.
 *
 * CST = UTC-6 (standard) or UTC-5 (daylight saving)
 * For simplicity, we use fixed UTC-6 offset. The 1-hour edge case during
 * DST transitions is acceptable for CardMint's volume.
 */
function parseDate(dateStr: string): number {
  if (!dateStr) {
    throw new Error("Empty date string");
  }

  let year: number, month: number, day: number;

  // Try ISO format first: "2025-12-30"
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    year = parseInt(isoMatch[1], 10);
    month = parseInt(isoMatch[2], 10);
    day = parseInt(isoMatch[3], 10);
  } else {
    // Try US format: "12/30/2025"
    const usMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (usMatch) {
      month = parseInt(usMatch[1], 10);
      day = parseInt(usMatch[2], 10);
      year = parseInt(usMatch[3], 10);
    } else {
      throw new Error(`Invalid date format: ${dateStr}`);
    }
  }

  // Validate parsed values
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid date values: ${dateStr}`);
  }

  // Create date at CST midnight (UTC-6)
  // CST midnight = UTC 06:00
  const utcDate = Date.UTC(year, month - 1, day, 6, 0, 0, 0);
  return Math.floor(utcDate / 1000);
}

/**
 * Month name to number mapping for long date parsing.
 */
const MONTH_MAP: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/**
 * Parse TCGPlayer Order List long date format as CST midnight.
 *
 * Format: "Saturday, 03 January 2026"
 * We extract day, month, year and interpret as CST midnight.
 */
function parseLongDate(dateStr: string): number {
  if (!dateStr) {
    throw new Error("Empty date string");
  }

  // Pattern: "DayName, DD MonthName YYYY"
  // Example: "Saturday, 03 January 2026"
  const match = dateStr.match(/^\w+,\s*(\d{1,2})\s+(\w+)\s+(\d{4})$/);
  if (!match) {
    throw new Error(`Invalid long date format: ${dateStr}`);
  }

  const day = parseInt(match[1], 10);
  const monthName = match[2].toLowerCase();
  const year = parseInt(match[3], 10);

  const month = MONTH_MAP[monthName];
  if (!month) {
    throw new Error(`Unknown month name: ${match[2]}`);
  }

  // Validate parsed values
  if (day < 1 || day > 31) {
    throw new Error(`Invalid day value: ${day}`);
  }

  // Create date at CST midnight (UTC-6)
  // CST midnight = UTC 06:00
  const utcDate = Date.UTC(year, month - 1, day, 6, 0, 0, 0);
  return Math.floor(utcDate / 1000);
}

function parseWeight(weightStr: string): number {
  // TCGPlayer provides weight in oz as decimal (e.g., "0.07")
  const weight = parseFloat(weightStr);
  if (isNaN(weight)) {
    return 0;
  }
  return weight;
}

function parseCurrency(valueStr: string): number {
  // TCGPlayer provides values like "26.50" (dollars)
  const value = parseFloat(valueStr.replace(/[$,]/g, ""));
  if (isNaN(value)) {
    return 0;
  }
  return Math.round(value * 100); // Convert to cents
}

function parseItemCount(countStr: string): number {
  const count = parseInt(countStr, 10);
  if (isNaN(count)) {
    return 1;
  }
  return count;
}

function rowToOrderInput(row: TcgplayerCsvRow): CreateOrderInput {
  const shippingAddress: ShippingAddress = {
    name: `${row.FirstName} ${row.LastName}`.trim(),
    street1: row.Address1,
    street2: row.Address2 || undefined,
    city: row.City,
    state: row.State,
    zip: row.PostalCode,
    country: row.Country || "US",
  };

  return {
    source: "tcgplayer",
    external_order_id: row["Order #"],
    customer_name: `${row.FirstName} ${row.LastName}`.trim(),
    order_date: parseDate(row["Order Date"]),
    item_count: parseItemCount(row["Item Count"]),
    product_value_cents: parseCurrency(row["Value Of Products"]),
    shipping_fee_cents: parseCurrency(row["Shipping Fee Paid"]),
    product_weight_oz: parseWeight(row["Product Weight"]),
    shipping_method: row["Shipping Method"] || undefined,
    shipping_address: shippingAddress,
  };
}

// ============================================================================
// Importer
// ============================================================================

export class TcgplayerImporter {
  private marketplaceService: MarketplaceService;
  private logger: Logger;

  constructor(marketplaceService: MarketplaceService, logger: Logger) {
    this.marketplaceService = marketplaceService;
    this.logger = logger.child({ service: "TcgplayerImporter" });
  }

  /**
   * Import TCGPlayer orders from CSV content.
   *
   * @param csvContent - Raw CSV string
   * @param importedBy - Operator username
   * @param fileName - Original file name (optional)
   * @param dryRun - If true, preview without creating records
   */
  async import(
    csvContent: string,
    importedBy: string,
    fileName: string | null,
    dryRun: boolean = true
  ): Promise<ImportResult> {
    const checksum = computeChecksum(csvContent);

    // Parse CSV
    let rows: TcgplayerCsvRow[];
    try {
      rows = parseCsv(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        // TCGPlayer exports sometimes omit trailing empty columns on some rows.
        // Allow rows with fewer columns than the header (e.g., missing last column).
        relax_column_count_less: true,
      }) as TcgplayerCsvRow[];
    } catch (error) {
      this.logger.error({ error }, "Failed to parse CSV");
      throw new Error(`CSV parsing error: ${(error as Error).message}`);
    }

    if (rows.length === 0) {
      throw new Error("CSV contains no data rows");
    }

    this.logger.info(
      { rowCount: rows.length, dryRun, fileName },
      "Starting TCGPlayer import"
    );

    // Create batch record only for actual imports (not dry-run)
    let batchId = 0;
    if (!dryRun) {
      batchId = this.marketplaceService.createImportBatch(
        "tcgplayer",
        importedBy,
        checksum,
        fileName,
        rows.length
      );
    }

    const result: ImportResult = {
      batchId,
      dryRun,
      imported: 0,
      skipped: 0,
      upgraded: 0,
      errors: [],
      preview: dryRun ? [] : undefined,
    };

    // Process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // +2 for header row and 0-indexing

      try {
        const orderId = row["Order #"];

        if (!orderId) {
          result.errors.push({
            row: rowNum,
            orderId: "(empty)",
            error: "Missing Order #",
          });
          continue;
        }

        // Check if order already exists
        const existingOrder = this.marketplaceService.getOrderByExternalId("tcgplayer", orderId);
        const exists = !!existingOrder;

        if (dryRun) {
          // Build preview
          const input = rowToOrderInput(row);
          const displayNumber = existingOrder?.display_order_number ??
            this.marketplaceService.generateDisplayOrderNumber("tcgplayer", input.order_date);

          // Check if this is an upgrade candidate (Order List → Shipping Export)
          const canUpgrade = existingOrder?.import_format === "orderlist";

          result.preview!.push({
            orderId,
            customerName: input.customer_name,
            displayOrderNumber: displayNumber,
            itemCount: input.item_count,
            valueCents: input.product_value_cents,
            orderDate: row["Order Date"],
            status: canUpgrade ? "upgrade" : exists ? "exists" : "new",
          });

          if (canUpgrade) {
            result.upgraded++;
          } else if (exists) {
            result.skipped++;
          } else {
            result.imported++;
          }
        } else {
          // Actual import
          if (existingOrder) {
            // Check for upgrade: Order List → Shipping Export
            if (existingOrder.import_format === "orderlist") {
              const input = rowToOrderInput(row);
              this.marketplaceService.upgradeOrderWithAddress(
                existingOrder.id,
                input.shipping_address!,
                input.product_weight_oz
              );
              result.upgraded++;
              this.logger.info(
                { orderId, existingOrderId: existingOrder.id },
                "Upgraded Order List to Shipping Export"
              );
            } else {
              result.skipped++;
              this.logger.debug({ orderId }, "Skipping existing order (already shipping_export)");
            }
            continue;
          }

          const input = rowToOrderInput(row);
          input.import_batch_id = batchId;
          input.import_format = "shipping_export";

          this.marketplaceService.createOrder(input);
          result.imported++;
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        result.errors.push({
          row: rowNum,
          orderId: row["Order #"] || "(unknown)",
          error: errorMessage,
        });
        this.logger.warn(
          { row: rowNum, orderId: row["Order #"], error: errorMessage },
          "Error processing row"
        );
      }
    }

    // Update batch status
    if (!dryRun && batchId > 0) {
      this.marketplaceService.updateImportBatch(
        batchId,
        result.imported,
        result.skipped,
        result.errors.length,
        result.errors.length > 0 && result.imported === 0 ? "failed" : "completed",
        result.errors.length > 0 ? JSON.stringify(result.errors) : null
      );
    }

    this.logger.info(
      {
        batchId,
        imported: result.imported,
        upgraded: result.upgraded,
        skipped: result.skipped,
        errors: result.errors.length,
        dryRun,
      },
      "TCGPlayer Shipping Export import completed"
    );

    return result;
  }

  /**
   * Import TCGPlayer Order List CSV content.
   *
   * Order List format has no address data - creates "external" fulfillment records
   * for tracking reconciliation only (no CardMint label purchase capability).
   *
   * @param csvContent - Raw CSV string
   * @param importedBy - Operator username
   * @param fileName - Original file name (optional)
   * @param dryRun - If true, preview without creating records
   */
  async importOrderList(
    csvContent: string,
    importedBy: string,
    fileName: string | null,
    dryRun: boolean = true
  ): Promise<ImportResult> {
    const checksum = computeChecksum(csvContent);

    // Parse CSV
    let rows: TcgplayerOrderListRow[];
    try {
      rows = parseCsv(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        // Order List exports sometimes omit trailing empty columns (e.g., Carrier Information).
        // Allow rows with fewer columns than the header.
        relax_column_count_less: true,
      }) as TcgplayerOrderListRow[];
    } catch (error) {
      this.logger.error({ error }, "Failed to parse Order List CSV");
      throw new Error(`CSV parsing error: ${(error as Error).message}`);
    }

    if (rows.length === 0) {
      throw new Error("CSV contains no data rows");
    }

    this.logger.info(
      { rowCount: rows.length, dryRun, fileName },
      "Starting TCGPlayer Order List import"
    );

    // Create batch record only for actual imports (not dry-run)
    let batchId = 0;
    if (!dryRun) {
      batchId = this.marketplaceService.createImportBatch(
        "tcgplayer",
        importedBy,
        checksum,
        fileName,
        rows.length
      );
    }

    const result: ImportResult = {
      batchId,
      dryRun,
      imported: 0,
      skipped: 0,
      upgraded: 0,
      errors: [],
      preview: dryRun ? [] : undefined,
    };

    // Process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // +2 for header row and 0-indexing

      try {
        const orderId = row["Order #"];

        if (!orderId) {
          result.errors.push({
            row: rowNum,
            orderId: "(empty)",
            error: "Missing Order #",
          });
          continue;
        }

        // Check if order already exists
        const existingOrder = this.marketplaceService.getOrderByExternalId("tcgplayer", orderId);
        const exists = !!existingOrder;

        // Parse order data
        const orderDate = parseLongDate(row["Order Date"]);
        const customerName = row["Buyer Name"]?.trim() || "";
        const productValueCents = parseCurrency(row["Product Amt"]);
        const shippingFeeCents = parseCurrency(row["Shipping Amt"]);

        if (dryRun) {
          // Build preview
          const displayNumber = existingOrder?.display_order_number ??
            this.marketplaceService.generateDisplayOrderNumber("tcgplayer", orderDate);

          result.preview!.push({
            orderId,
            customerName,
            displayOrderNumber: displayNumber,
            itemCount: 1, // Order List doesn't include item count
            valueCents: productValueCents,
            orderDate: row["Order Date"],
            status: exists ? "exists" : "new",
          });

          if (exists) {
            result.skipped++;
          } else {
            result.imported++;
          }
        } else {
          // Actual import
          if (exists) {
            result.skipped++;
            this.logger.debug({ orderId }, "Skipping existing order");
            continue;
          }

          // Create order with external flag (no address, no label capability)
          this.marketplaceService.createOrder({
            source: "tcgplayer",
            external_order_id: orderId,
            customer_name: customerName,
            order_date: orderDate,
            item_count: 1, // Order List doesn't include item count
            product_value_cents: productValueCents,
            shipping_fee_cents: shippingFeeCents,
            import_batch_id: batchId,
            import_format: "orderlist",
            is_external: true, // External fulfillment - no CardMint label
            // No shipping_address - Order List doesn't include it
          });

          result.imported++;
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        result.errors.push({
          row: rowNum,
          orderId: row["Order #"] || "(unknown)",
          error: errorMessage,
        });
        this.logger.warn(
          { row: rowNum, orderId: row["Order #"], error: errorMessage },
          "Error processing Order List row"
        );
      }
    }

    // Update batch status
    if (!dryRun && batchId > 0) {
      this.marketplaceService.updateImportBatch(
        batchId,
        result.imported,
        result.skipped,
        result.errors.length,
        result.errors.length > 0 && result.imported === 0 ? "failed" : "completed",
        result.errors.length > 0 ? JSON.stringify(result.errors) : null
      );
    }

    this.logger.info(
      {
        batchId,
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors.length,
        dryRun,
      },
      "TCGPlayer Order List import completed"
    );

    return result;
  }
}
