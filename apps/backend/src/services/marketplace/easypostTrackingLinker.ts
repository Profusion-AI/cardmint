/**
 * EasyPost Tracking Linker
 *
 * Parses EasyPost tracking export CSV and links tracking to marketplace orders.
 * Uses confidence-based matching: auto-link on exact name+ZIP, queue ambiguous.
 *
 * CSV Format (EasyPost Tracking Export):
 * created_at,updated_at,id,shipment_id,tracking_code,status,signed_by,weight,
 * carrier,service,container_type,est_delivery_date,est_delivery_date_local,
 * est_delivery_time_local,origin_location,destination_location,...
 */

import { parse as parseCsv } from "csv-parse/sync";
import type { Logger } from "pino";
import { computeChecksum } from "../../utils/encryption";
import {
  MarketplaceService,
  type MarketplaceOrder,
  type MarketplaceShipment,
} from "./marketplaceService";

// ============================================================================
// Types
// ============================================================================

export interface EasypostTrackingRow {
  created_at: string;
  updated_at: string;
  id: string; // tracker ID
  shipment_id: string;
  tracking_code: string;
  status: string;
  signed_by: string;
  weight: string;
  carrier: string;
  service: string;
  container_type: string;
  est_delivery_date: string;
  est_delivery_date_local: string;
  est_delivery_time_local: string;
  origin_location: string;
  destination_location: string;
  current_detail_message: string;
  current_detail_status: string;
  current_detail_datetime: string;
  current_detail_source: string;
  current_detail_city: string;
  current_detail_state: string;
  current_detail_country: string;
  current_detail_zip: string;
  public_url: string;
  // ... additional transit detail fields
}

export interface MatchResult {
  confidence: "auto" | "review" | "unmatched";
  order?: MarketplaceOrder;
  shipment?: MarketplaceShipment;
  candidates?: MarketplaceOrder[];
  reason?: string;
}

export interface LinkingResult {
  batchId: number;
  dryRun: boolean;
  autoLinked: number;
  queued: number; // Needs manual review
  unmatched: number;
  errors: Array<{ row: number; trackerId: string; error: string }>;
  preview?: Array<{
    trackerId: string;
    trackingNumber: string;
    signedBy: string;
    carrier: string;
    matchStatus: "auto" | "review" | "unmatched";
    matchedOrderNumber?: string;
    reason?: string;
  }>;
}

// ============================================================================
// Parser
// ============================================================================

function parseEasypostDate(dateStr: string): number | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}

/**
 * Extract ZIP code from destination_location string
 * Format: "CITY STATE, ZIP" or "CITY STATE, COUNTRY, ZIP"
 * Example: "TAMPA FL, 33607-2546" or "SAN ANTONIO TX, US, 78229"
 */
function extractZipFromDestination(destination: string): string | null {
  if (!destination) return null;

  // Try to extract ZIP at the end
  const zipMatch = destination.match(/(\d{5}(?:-\d{4})?)$/);
  if (zipMatch) {
    return zipMatch[1].split("-")[0]; // Return just the 5-digit part
  }

  return null;
}

// ============================================================================
// Linker
// ============================================================================

export class EasypostTrackingLinker {
  private marketplaceService: MarketplaceService;
  private logger: Logger;

  constructor(marketplaceService: MarketplaceService, logger: Logger) {
    this.marketplaceService = marketplaceService;
    this.logger = logger.child({ service: "EasypostTrackingLinker" });
  }

  /**
   * Normalize name for matching (uppercase, trim, remove punctuation)
   */
  private normalizeName(name: string): string {
    if (!name) return "";
    return name
      .toUpperCase()
      .trim()
      .replace(/[^\w\s]/g, "") // Remove punctuation
      .replace(/\s+/g, " "); // Normalize whitespace
  }

  /**
   * Attempt to match tracking to an order
   */
  matchTracking(
    signedBy: string,
    destinationZip: string | null
  ): MatchResult {
    const normalizedName = this.normalizeName(signedBy);

    if (!normalizedName) {
      return { confidence: "unmatched", reason: "no-signed-by" };
    }

    // Find candidates by normalized name
    const candidates = this.marketplaceService.findMatchCandidates(
      normalizedName,
      destinationZip
    );

    if (candidates.length === 0) {
      // Try without ZIP
      const nameOnlyCandidates = this.marketplaceService.findMatchCandidates(
        normalizedName,
        null
      );

      if (nameOnlyCandidates.length === 0) {
        return { confidence: "unmatched", reason: "no-match" };
      }

      if (nameOnlyCandidates.length === 1) {
        const order = nameOnlyCandidates[0];
        const shipments = this.marketplaceService.getShipmentsByOrderId(order.id);
        // Find eligible shipment (including shipped for backfill)
        const eligibleShipment = shipments.find(
          (s) =>
            s.status === "pending" ||
            s.status === "label_purchased" ||
            s.status === "shipped"
        );

        return {
          confidence: "review",
          order,
          shipment: eligibleShipment,
          reason: "name-only-no-zip-confirm",
        };
      }

      return {
        confidence: "review",
        candidates: nameOnlyCandidates,
        reason: "multiple-name-matches",
      };
    }

    // We have candidates that match name AND zip
    if (candidates.length === 1) {
      const order = candidates[0];
      const shipments = this.marketplaceService.getShipmentsByOrderId(order.id);
      // Find a shipment that can accept tracking (pending, label_purchased, or shipped for backfill)
      const eligibleShipment = shipments.find(
        (s) =>
          s.status === "pending" ||
          s.status === "label_purchased" ||
          s.status === "shipped"
      );

      // If no eligible shipment found, queue for review instead of auto-linking
      if (!eligibleShipment) {
        return {
          confidence: "review",
          order,
          reason: "no-eligible-shipment",
        };
      }

      return {
        confidence: "auto",
        order,
        shipment: eligibleShipment,
      };
    }

    // Multiple matches with same name and zip - unusual, needs review
    return {
      confidence: "review",
      candidates,
      reason: "multiple-exact-matches",
    };
  }

  /**
   * Import EasyPost tracking from CSV and link to orders
   */
  async link(
    csvContent: string,
    importedBy: string,
    fileName: string | null,
    dryRun: boolean = true
  ): Promise<LinkingResult> {
    const checksum = computeChecksum(csvContent);

    // Parse CSV
    let rows: EasypostTrackingRow[];
    try {
      rows = parseCsv(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as EasypostTrackingRow[];
    } catch (error) {
      this.logger.error({ error }, "Failed to parse CSV");
      throw new Error(`CSV parsing error: ${(error as Error).message}`);
    }

    if (rows.length === 0) {
      throw new Error("CSV contains no data rows");
    }

    this.logger.info(
      { rowCount: rows.length, dryRun, fileName },
      "Starting EasyPost tracking linking"
    );

    // Create batch record
    let batchId = 0;
    if (!dryRun) {
      batchId = this.marketplaceService.createImportBatch(
        "easypost_tracking",
        importedBy,
        checksum,
        fileName,
        rows.length
      );
    }

    const result: LinkingResult = {
      batchId,
      dryRun,
      autoLinked: 0,
      queued: 0,
      unmatched: 0,
      errors: [],
      preview: dryRun ? [] : undefined,
    };

    // Process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      try {
        const trackerId = row.id;
        const trackingNumber = row.tracking_code;
        const signedBy = row.signed_by;
        const destinationZip = extractZipFromDestination(row.destination_location);

        if (!trackerId || !trackingNumber) {
          result.errors.push({
            row: rowNum,
            trackerId: trackerId || "(empty)",
            error: "Missing tracker ID or tracking code",
          });
          continue;
        }

        // Attempt to match
        const matchResult = this.matchTracking(signedBy, destinationZip);

        if (dryRun) {
          result.preview!.push({
            trackerId,
            trackingNumber,
            signedBy: signedBy || "(empty)",
            carrier: row.carrier,
            matchStatus: matchResult.confidence,
            matchedOrderNumber: matchResult.order?.display_order_number,
            reason: matchResult.reason,
          });
        }

        switch (matchResult.confidence) {
          case "auto":
            if (!dryRun && matchResult.order && matchResult.shipment) {
              // Auto-link tracking to shipment
              this.marketplaceService.updateShipmentTracking(
                matchResult.shipment.id,
                trackingNumber,
                row.public_url || null,
                row.carrier || null,
                "auto",
                "system"
              );

              // Update shipment status based on tracking status
              if (row.status === "delivered") {
                this.marketplaceService.updateShipmentStatus(
                  matchResult.shipment.id,
                  "delivered"
                );
              } else if (
                row.status === "in_transit" ||
                row.current_detail_status === "in_transit"
              ) {
                this.marketplaceService.updateShipmentStatus(
                  matchResult.shipment.id,
                  "in_transit"
                );
              } else if (row.current_detail_status === "pre_transit") {
                this.marketplaceService.updateShipmentStatus(
                  matchResult.shipment.id,
                  "shipped"
                );
              }
            }
            result.autoLinked++;
            break;

          case "review":
            if (!dryRun) {
              // Queue for manual review
              this.marketplaceService.createUnmatchedTracking(
                batchId,
                trackerId,
                row.shipment_id || null,
                trackingNumber,
                row.carrier || null,
                signedBy || null,
                destinationZip,
                row.status || null,
                parseEasypostDate(row.created_at)
              );
            }
            result.queued++;
            break;

          case "unmatched":
            if (!dryRun) {
              // Add to unmatched queue
              this.marketplaceService.createUnmatchedTracking(
                batchId,
                trackerId,
                row.shipment_id || null,
                trackingNumber,
                row.carrier || null,
                signedBy || null,
                destinationZip,
                row.status || null,
                parseEasypostDate(row.created_at)
              );
            }
            result.unmatched++;
            break;
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        result.errors.push({
          row: rowNum,
          trackerId: row.id || "(unknown)",
          error: errorMessage,
        });
        this.logger.warn(
          { row: rowNum, trackerId: row.id, error: errorMessage },
          "Error processing tracking row"
        );
      }
    }

    // Update batch status
    if (!dryRun && batchId > 0) {
      this.marketplaceService.updateImportBatch(
        batchId,
        result.autoLinked,
        0, // No "skip" concept for tracking
        result.errors.length,
        result.errors.length > 0 && result.autoLinked === 0 ? "failed" : "completed",
        result.errors.length > 0 ? JSON.stringify(result.errors) : null
      );
    }

    this.logger.info(
      {
        batchId,
        autoLinked: result.autoLinked,
        queued: result.queued,
        unmatched: result.unmatched,
        errors: result.errors.length,
        dryRun,
      },
      "EasyPost tracking linking completed"
    );

    return result;
  }
}
