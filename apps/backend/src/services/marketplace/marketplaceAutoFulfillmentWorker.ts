/**
 * Marketplace Auto-Fulfillment Worker (Phase 5)
 *
 * Auto-purchases shipping labels for eligible marketplace shipments:
 * - item_count <= 3
 * - product_value_cents <= 4999 ($49.99)
 * - shipment status = 'pending'
 *
 * After successful purchase:
 * - Updates shipment tracking + label fields
 * - Enqueues a print queue job (label_print_queue) for Fedora print agent archival/print
 *
 * Guardrails:
 * - Never runs unless MARKETPLACE_AUTO_FULFILLMENT_ENABLED=true
 * - Uses label purchase lock on marketplace_shipments to prevent double-spend
 * - Never auto-repurchases; failures are visible as shipment status='exception'
 */

import type { Logger } from "pino";
import type { Database } from "better-sqlite3";
import type { EasyPostAddress, EasyPostParcel, EasyPostRate } from "../easyPostService.js";
import type { EasyPostService } from "../easyPostService.js";
import { runtimeConfig } from "../../config.js";
import { MarketplaceService } from "./marketplaceService.js";
import { PrintQueueRepository } from "../../repositories/printQueueRepository.js";

type ParcelPreset = {
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  baseWeightOz: number;
  maxCards: number;
};

export interface MarketplaceAutoFulfillmentResult {
  processed: number;
  labelsCreated: number;
  errors: number;
  skipped: boolean;
}

function selectParcelPreset(itemCount: number): { key: string; preset: ParcelPreset } {
  const presets = runtimeConfig.parcelPresets as Record<string, ParcelPreset>;
  if (itemCount <= presets.singlecard.maxCards) {
    return { key: "singlecard", preset: presets.singlecard };
  }
  if (itemCount <= presets["multicard-bubble"].maxCards) {
    return { key: "multicard-bubble", preset: presets["multicard-bubble"] };
  }
  return { key: "multicard-box", preset: presets["multicard-box"] };
}

function cheapestRate(rates: EasyPostRate[]): EasyPostRate | null {
  if (rates.length === 0) return null;
  return rates.reduce((best, candidate) => {
    const bestPrice = Number.parseFloat(best.rate);
    const candPrice = Number.parseFloat(candidate.rate);
    if (!Number.isFinite(bestPrice)) return candidate;
    if (!Number.isFinite(candPrice)) return best;
    return candPrice < bestPrice ? candidate : best;
  });
}

/**
 * For automation, prefer:
 * 1) Cheapest USPS GroundAdvantage
 * 2) Cheapest USPS
 * 3) Cheapest UPS
 */
function chooseAutomationRate(allRates: EasyPostRate[]): EasyPostRate | null {
  const usps = allRates.filter((r) => r.carrier === "USPS");
  const groundAdv = usps.filter((r) => r.service === "GroundAdvantage");
  const ups = allRates.filter((r) => r.carrier === "UPS");

  return (
    cheapestRate(groundAdv) ||
    cheapestRate(usps) ||
    cheapestRate(ups) ||
    cheapestRate(allRates)
  );
}

export class MarketplaceAutoFulfillmentWorker {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private logger: Logger;
  private marketplaceService: MarketplaceService;
  private printQueueRepo: PrintQueueRepository;

  constructor(
    private readonly db: Database,
    private readonly easyPostService: EasyPostService,
    parentLogger: Logger,
    private readonly intervalMs: number = runtimeConfig.marketplaceAutoFulfillmentIntervalMs
  ) {
    this.logger = parentLogger.child({ worker: "marketplace-auto-fulfillment" });
    this.marketplaceService = new MarketplaceService(db, this.logger);
    this.printQueueRepo = new PrintQueueRepository(db, this.logger);
  }

  start(): void {
    if (this.intervalHandle) {
      this.logger.warn("Marketplace auto-fulfillment worker already running");
      return;
    }

    if (!runtimeConfig.marketplaceAutoFulfillmentEnabled) {
      this.logger.info("Marketplace auto-fulfillment worker disabled (MARKETPLACE_AUTO_FULFILLMENT_ENABLED=false)");
      return;
    }

    if (!this.easyPostService.isConfigured()) {
      this.logger.warn("Marketplace auto-fulfillment worker not starting - EasyPost not configured");
      return;
    }

    this.logger.info({ intervalMs: this.intervalMs }, "Starting marketplace auto-fulfillment worker");

    void this.runOnce();
    this.intervalHandle = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info("Marketplace auto-fulfillment worker stopped");
    }
  }

  async runOnce(): Promise<MarketplaceAutoFulfillmentResult> {
    if (this.isRunning) {
      this.logger.debug("Marketplace auto-fulfillment worker already running, skipping");
      return { processed: 0, labelsCreated: 0, errors: 0, skipped: true };
    }

    // Disabled at runtime: allow toggling without restart
    if (!runtimeConfig.marketplaceAutoFulfillmentEnabled) {
      return { processed: 0, labelsCreated: 0, errors: 0, skipped: true };
    }

    this.isRunning = true;
    const result: MarketplaceAutoFulfillmentResult = { processed: 0, labelsCreated: 0, errors: 0, skipped: false };

    try {
      // Process up to 5 shipments per iteration
      const candidates = this.db
        .prepare(
          `
          SELECT ms.id as shipment_id
          FROM marketplace_shipments ms
          JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id
          WHERE ms.status = 'pending'
            AND ms.tracking_number IS NULL
            AND ms.easypost_shipment_id IS NULL
            AND ms.shipping_address_encrypted IS NOT NULL
            AND COALESCE(ms.item_count, mo.item_count) <= 3
            AND mo.product_value_cents <= 4999
            AND mo.order_date > (strftime('%s', 'now') - 604800)  -- Order age < 7 days
          ORDER BY mo.order_date ASC
          LIMIT 5
        `
        )
        .all() as { shipment_id: number }[];

      if (candidates.length === 0) {
        return result;
      }

      for (const row of candidates) {
        const shipmentId = row.shipment_id;
        result.processed++;

        // Concurrency guard: acquire label purchase lock atomically
        const lockResult = this.marketplaceService.acquireLabelPurchaseLock(shipmentId);
        if (!lockResult.acquired) {
          // Skip if another request is processing (or already purchased)
          continue;
        }

        try {
          const shipmentData = this.marketplaceService.getShipmentWithDecryptedAddress(shipmentId);
          if (!shipmentData || !shipmentData.order) {
            throw new Error("Shipment/order not found");
          }

          if (shipmentData.status !== "pending") {
            // Status changed since selection; skip
            continue;
          }

          if (!shipmentData.decryptedAddress) {
            throw new Error("Shipping address expired or unavailable (PII retention)");
          }

          const itemCount = this.marketplaceService.getShipmentItemCount(shipmentData, shipmentData.order);
          const { key: presetKey, preset } = selectParcelPreset(itemCount);

          // Automation uses preset base weight (weight override is manual-only)
          const parcelWeightOz = preset.baseWeightOz;

          // Insurance threshold is >= $50, but automation is <= $49.99 by eligibility
          const insuredValueCents: number | null = null;
          const insuranceAmountDollars = 0;

          const parcel: EasyPostParcel = {
            length: preset.lengthIn,
            width: preset.widthIn,
            height: preset.heightIn,
            weight: parcelWeightOz,
          };

          const toAddress: EasyPostAddress = {
            name: shipmentData.decryptedAddress.name,
            street1: shipmentData.decryptedAddress.street1,
            street2: shipmentData.decryptedAddress.street2,
            city: shipmentData.decryptedAddress.city,
            state: shipmentData.decryptedAddress.state,
            zip: shipmentData.decryptedAddress.zip,
            country: shipmentData.decryptedAddress.country || "US",
          };

          const createResult = await this.easyPostService.createMarketplaceShipment(
            toAddress,
            parcel,
            insuranceAmountDollars
          );

          if (!createResult.success || !createResult.shipment || !createResult.rates) {
            throw new Error(createResult.error || "Failed to create EasyPost shipment");
          }

          // Store EasyPost shipment ID + audit fields
          this.marketplaceService.updateShipmentEasypostShipment(
            shipmentId,
            createResult.shipment.id,
            presetKey,
            parcelWeightOz,
            insuredValueCents,
            itemCount
          );

          const chosenRate = chooseAutomationRate(createResult.rates);
          if (!chosenRate) {
            throw new Error("No eligible rates returned from EasyPost");
          }

          const labelResult = await this.easyPostService.purchaseMarketplaceLabel(
            createResult.shipment.id,
            chosenRate.id
          );

          if (!labelResult.success) {
            throw new Error(labelResult.error || "Label purchase failed");
          }

          if (!labelResult.trackingNumber || !labelResult.labelUrl) {
            throw new Error("EasyPost returned incomplete label data (missing tracking number or label URL)");
          }

          const labelCostCents = labelResult.shipment?.selected_rate?.rate
            ? Math.round(Number.parseFloat(labelResult.shipment.selected_rate.rate) * 100)
            : Math.round(Number.parseFloat(chosenRate.rate) * 100);

          const shipmentTracker = (labelResult.shipment as any)?.tracker;
          const trackingUrl = shipmentTracker?.public_url ||
            (labelResult.carrier === "USPS"
              ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${labelResult.trackingNumber}`
              : null);

          this.marketplaceService.updateShipmentLabelPurchased(
            shipmentId,
            labelResult.trackingNumber,
            trackingUrl,
            labelResult.labelUrl,
            labelCostCents,
            labelResult.carrier || null,
            labelResult.service || null,
            chosenRate.id
          );

          // Phase 5: enqueue for archival/print
          this.printQueueRepo.upsertForShipment({
            shipmentType: "marketplace",
            shipmentId,
            labelUrl: labelResult.labelUrl,
          });

          result.labelsCreated++;
          this.logger.info(
            {
              shipmentId,
              orderId: shipmentData.order.id,
              displayOrderNumber: shipmentData.order.display_order_number,
              carrier: labelResult.carrier,
              service: labelResult.service,
              labelCostCents,
            },
            "Marketplace auto-fulfillment: label purchased"
          );
        } catch (err) {
          result.errors++;
          const msg = err instanceof Error ? err.message : String(err);

          // Failure visibility: mark shipment exception with notes
          this.db
            .prepare(
              `
              UPDATE marketplace_shipments
              SET status = 'exception',
                  exception_type = 'auto_fulfillment_failed',
                  exception_notes = ?,
                  updated_at = strftime('%s', 'now')
              WHERE id = ?
            `
            )
            .run(msg, shipmentId);

          this.logger.error({ err, shipmentId }, "Marketplace auto-fulfillment failed");
        } finally {
          // Always release lock
          this.marketplaceService.releaseLabelPurchaseLock(shipmentId);
        }
      }

      if (result.processed > 0) {
        this.logger.info(result, "Marketplace auto-fulfillment iteration complete");
      }
    } catch (err) {
      this.logger.error({ err }, "Marketplace auto-fulfillment worker failed");
    } finally {
      this.isRunning = false;
    }

    return result;
  }
}

export function createMarketplaceAutoFulfillmentWorker(
  db: Database,
  easyPostService: EasyPostService,
  logger: Logger
): MarketplaceAutoFulfillmentWorker {
  return new MarketplaceAutoFulfillmentWorker(db, easyPostService, logger);
}

