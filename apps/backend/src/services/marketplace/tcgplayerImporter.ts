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

export interface ImportResult {
  batchId: number;
  dryRun: boolean;
  imported: number;
  skipped: number;
  errors: Array<{ row: number; orderId: string; error: string }>;
  preview?: Array<{
    orderId: string;
    customerName: string;
    displayOrderNumber: string;
    itemCount: number;
    valueCents: number;
    orderDate: string;
    status: "new" | "exists";
  }>;
}

// ============================================================================
// Parser
// ============================================================================

function parseDate(dateStr: string): number {
  // TCGPlayer format: "2025-12-30" or "12/30/2025"
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${dateStr}`);
  }
  return Math.floor(date.getTime() / 1000);
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

        // Check if already exists
        const exists = this.marketplaceService.orderExists("tcgplayer", orderId);

        if (dryRun) {
          // Build preview
          const input = rowToOrderInput(row);
          const displayNumber = this.marketplaceService.generateDisplayOrderNumber(
            "tcgplayer",
            input.order_date
          );

          result.preview!.push({
            orderId,
            customerName: input.customer_name,
            displayOrderNumber: displayNumber,
            itemCount: input.item_count,
            valueCents: input.product_value_cents,
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

          const input = rowToOrderInput(row);
          input.import_batch_id = batchId;

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
        skipped: result.skipped,
        errors: result.errors.length,
        dryRun,
      },
      "TCGPlayer import completed"
    );

    return result;
  }
}
