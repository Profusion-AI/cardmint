/**
 * EasyPost Tracking Linker
 *
 * Parses EasyPost export CSVs and links tracking to marketplace orders.
 * Uses confidence-based matching: auto-link on exact name+ZIP, queue ambiguous.
 *
 * Supports TWO EasyPost export formats:
 *
 * 1. Tracking Export (delivery events):
 *    created_at,updated_at,id,shipment_id,tracking_code,status,signed_by,weight,
 *    carrier,service,...,destination_location,...
 *    - Uses: signed_by (customer name), destination_location (parse ZIP)
 *
 * 2. Shipments Export (created labels):
 *    created_at,id,tracking_code,status,...,to_name,to_zip,...,carrier,...
 *    - Uses: to_name (customer name), to_zip (direct ZIP)
 */

import { parse as parseCsv } from "csv-parse/sync";
import type { Logger } from "pino";
import { computeChecksum } from "../../utils/encryption";
import { normalizeNameForMatching } from "../../utils/nameNormalization.js";
import {
  MarketplaceService,
  type MarketplaceOrder,
  type MarketplaceShipment,
  type ShippingAddress,
} from "./marketplaceService";

// ============================================================================
// Types
// ============================================================================

/**
 * Combined type for both EasyPost export formats.
 * Fields may be present or absent depending on export type.
 */
export interface EasypostTrackingRow {
  // Common fields (both formats)
  created_at: string;
  id: string;
  tracking_code: string;
  status: string;
  carrier: string;

  // Tracking Export specific
  updated_at?: string;
  shipment_id?: string;
  signed_by?: string;           // Customer name (Tracking Export)
  destination_location?: string; // Parse ZIP from this (Tracking Export)
  weight?: string;
  service?: string;
  container_type?: string;
  est_delivery_date?: string;
  est_delivery_date_local?: string;
  est_delivery_time_local?: string;
  origin_location?: string;
  current_detail_message?: string;
  current_detail_status?: string;
  current_detail_datetime?: string;
  current_detail_source?: string;
  current_detail_city?: string;
  current_detail_state?: string;
  current_detail_country?: string;
  current_detail_zip?: string;
  public_url?: string;

  // Shipments Export specific
  to_name?: string;             // Customer name (Shipments Export)
  to_zip?: string;              // Direct ZIP (Shipments Export)
  to_street1?: string;
  to_street2?: string;
  to_city?: string;
  to_state?: string;
  to_country?: string;
  postage_label_created_at?: string;
  options?: string;
  from_name?: string;
  from_zip?: string;
  rate?: string;
  insured_value?: string;
  is_return?: string;
  refund_status?: string;
  reference?: string;
  label_fee?: string;
  postage_fee?: string;
  insurance_fee?: string;
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

function normalizeZip(zip: string | null | undefined): string | null {
  if (!zip) return null;
  return zip.split("-")[0].trim() || null;
}

function buildShipToAddress(row: EasypostTrackingRow): ShippingAddress | null {
  const street1 = row.to_street1?.trim();
  const city = row.to_city?.trim();
  const state = row.to_state?.trim();
  const zip = normalizeZip(row.to_zip);
  const country = row.to_country?.trim() || "US";

  if (!street1 || !city || !state || !zip) {
    return null;
  }

  return {
    name: row.to_name?.trim() || "",
    street1,
    street2: row.to_street2?.trim() || undefined,
    city,
    state,
    zip,
    country,
  };
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
   * Normalize name for matching.
   * Delegates to shared helper for consistency with marketplaceService.
   */
  private normalizeName(name: string): string {
    return normalizeNameForMatching(name);
  }

  /**
   * Attempt to match tracking to an order.
   *
   * Matching strategy (in order):
   * 1. Primary: Name + Date match (CST-normalized) - most reliable
   * 2. Fallback: Name + ZIP match (legacy, for edge cases)
   * 3. Last resort: Name-only with review flag
   *
   * @param signedBy - Customer name from EasyPost tracking
   * @param destinationZip - Destination ZIP from EasyPost (may be null/unknown)
   * @param createdAtEasypost - Unix timestamp from EasyPost created_at (for date matching)
   */
  matchTracking(
    signedBy: string,
    destinationZip: string | null,
    createdAtEasypost: number | null = null
  ): MatchResult {
    const normalizedName = this.normalizeName(signedBy);

    if (!normalizedName) {
      return { confidence: "unmatched", reason: "no-signed-by" };
    }

    // PRIMARY: Try date-based matching first (if we have a timestamp)
    if (createdAtEasypost) {
      const dateCandidates = this.marketplaceService.findMatchCandidatesByDate(
        normalizedName,
        createdAtEasypost
      );

      if (dateCandidates.length === 1) {
        const order = dateCandidates[0];
        const shipments = this.marketplaceService.getShipmentsByOrderId(order.id);
        const eligibleShipment = shipments.find(
          (s) =>
            (s.status === "pending" ||
              s.status === "label_purchased" ||
              s.status === "shipped") &&
            !s.tracking_number // Guardrail: no existing tracking
        );

        if (eligibleShipment) {
          return {
            confidence: "auto",
            order,
            shipment: eligibleShipment,
          };
        }

        // Order found but no eligible shipment
        return {
          confidence: "review",
          order,
          reason: "no-eligible-shipment",
        };
      }

      if (dateCandidates.length > 1) {
        // Multiple matches on same date - unusual, needs review
        return {
          confidence: "review",
          candidates: dateCandidates,
          reason: "multiple-date-matches",
        };
      }
      // No date matches - fall through to ZIP-based matching
    }

    // FALLBACK: ZIP-based matching (legacy approach)
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
        // Guard: Only eligible if status is valid AND no existing tracking number
        const eligibleShipment = shipments.find(
          (s) =>
            (s.status === "pending" ||
              s.status === "label_purchased" ||
              s.status === "shipped") &&
            !s.tracking_number
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
      // Guard: Only eligible if status is valid AND no existing tracking number
      const eligibleShipment = shipments.find(
        (s) =>
          (s.status === "pending" ||
            s.status === "label_purchased" ||
            s.status === "shipped") &&
          !s.tracking_number
      );

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
   * Attempt to match by explicit order number first (if present in CSV).
   * This is deterministic and preferred over fuzzy name matching.
   */
  matchByOrderNumber(orderNumber: string): MatchResult {
    const trimmed = orderNumber.trim();
    if (!trimmed) {
      return { confidence: "unmatched", reason: "empty-order-number" };
    }

    const orders = this.marketplaceService.findOrdersByOrderNumber(trimmed);

    if (orders.length === 0) {
      return { confidence: "unmatched", reason: "order-number-no-match" };
    }

    if (orders.length > 1) {
      return { confidence: "review", candidates: orders, reason: "multiple-order-number-matches" };
    }

    const order = orders[0];
    const shipments = this.marketplaceService.getShipmentsByOrderId(order.id);
    const eligibleShipments = shipments.filter(
      (s) =>
        (s.status === "pending" || s.status === "label_purchased" || s.status === "shipped") &&
        !s.tracking_number
    );

    if (eligibleShipments.length === 0) {
      return { confidence: "review", order, reason: "no-eligible-shipment" };
    }

    // Deterministic: lowest shipment_sequence first
    const eligibleShipment = eligibleShipments.sort((a, b) => a.shipment_sequence - b.shipment_sequence)[0];
    return { confidence: "auto", order, shipment: eligibleShipment };
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

      // Ensure name normalization is consistent before matching (one-time, process-wide)
      // Only run in non-dry-run mode to keep dry-run write-free
      this.marketplaceService.ensureCustomerNameNormalizationBackfilled();
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

        // Handle both export formats:
        // - Tracking Export: signed_by, destination_location
        // - Shipments Export: to_name, to_zip
        const customerName = row.signed_by || row.to_name || "";
        const destinationZip = normalizeZip(row.to_zip) || extractZipFromDestination(row.destination_location || "");

        if (!trackerId || !trackingNumber) {
          result.errors.push({
            row: rowNum,
            trackerId: trackerId || "(empty)",
            error: "Missing tracker ID or tracking code",
          });
          continue;
        }

        // Attempt deterministic order-number match first, then fall back to fuzzy matching.
        const createdAtEasypost = parseEasypostDate(row.created_at);
        const matchResult = row.reference?.trim()
          ? this.matchByOrderNumber(row.reference)
          : this.matchTracking(customerName, destinationZip, createdAtEasypost);

        if (
          row.reference?.trim() &&
          matchResult.confidence === "review" &&
          matchResult.reason === "multiple-order-number-matches"
        ) {
          this.logger.warn(
            {
              reference: row.reference.trim(),
              candidateCount: matchResult.candidates?.length ?? 0,
            },
            "Multiple orders matched by EasyPost reference; queued for review"
          );
        }

        if (dryRun) {
          result.preview!.push({
            trackerId,
            trackingNumber,
            signedBy: customerName || "(empty)",
            carrier: row.carrier,
            matchStatus: matchResult.confidence,
            matchedOrderNumber: matchResult.order?.display_order_number,
            reason: matchResult.reason,
          });
        }

        switch (matchResult.confidence) {
          case "auto":
            if (!dryRun && matchResult.order && matchResult.shipment) {
              const trackingUrl =
                row.public_url ||
                this.marketplaceService.generateTrackingUrl(trackingNumber, row.carrier || null);

              // Auto-link tracking to shipment
              this.marketplaceService.updateShipmentTracking(
                matchResult.shipment.id,
                trackingNumber,
                trackingUrl,
                row.carrier || null,
                row.service || null,
                "auto",
                "system"
              );

              // Enrich address for Shipments Export rows (if present, and shipment has no address)
              const shipToAddress = buildShipToAddress(row);
              if (shipToAddress) {
                this.marketplaceService.updateShipmentAddressIfMissing(matchResult.shipment.id, shipToAddress);
              }

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
                customerName || null,
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
                customerName || null,
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
