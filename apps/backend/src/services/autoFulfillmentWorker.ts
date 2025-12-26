/**
 * Auto-Fulfillment Worker
 *
 * Background worker that auto-purchases shipping labels for orders that don't require manual review.
 * After successful label purchase, enqueues the combined confirmation + tracking email.
 *
 * Design principles:
 * - No PII stored: fetches shipping address from Stripe at purchase time
 * - Idempotent: checks fulfillment state before purchasing
 * - Atomic claim: uses UPDATE...RETURNING with 'processing' status to prevent multi-instance races
 * - Cheapest compatible rate: selects lowest price within tier allowlist
 * - Label cost guardrail: flags exception if label cost > max(shipping*1.5, shipping+$2)
 * - Failure visibility: marks orders as needs_attention on error
 * - Concurrency guard: isRunning flag prevents overlapping runs within same instance
 *
 * Reference: PR2 Email Outbox plan + Codex review fixes
 */

import type { Logger } from "pino";
import type { Database } from "better-sqlite3";
import type { EasyPostService, EasyPostAddress } from "./easyPostService.js";
import type { StripeService } from "./stripeService.js";
import type { EmailOutboxRepository, OrderConfirmedTrackingData } from "../repositories/emailOutboxRepository.js";
import { runtimeConfig } from "../config.js";
import type { ShippingMethod } from "../domain/shipping.js";

// Reuse email outbox stuck threshold for processing recovery (5 min default)
const PROCESSING_STUCK_THRESHOLD_MS = runtimeConfig.emailOutboxStuckThresholdMs;

interface PendingFulfillment {
  id: number;
  stripe_session_id: string;
  stripe_payment_intent_id: string | null;
  item_count: number;
  original_subtotal_cents: number;
  final_subtotal_cents: number;
  shipping_method: ShippingMethod;
  shipping_cost_cents: number;
  requires_manual_review: number;
  status: string;
  easypost_shipment_id: string | null;
  tracking_number: string | null;
  label_url: string | null;
}

export interface AutoFulfillmentResult {
  processed: number;
  labelsCreated: number;
  emailsEnqueued: number;
  errors: number;
  skipped: boolean;
}

interface ProcessFulfillmentResult {
  labelPurchased: boolean;
  emailEnqueued: boolean;
}

export class AutoFulfillmentWorker {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private logger: Logger;

  constructor(
    private readonly db: Database,
    private readonly easyPostService: EasyPostService,
    private readonly stripeService: StripeService,
    private readonly emailOutboxRepo: EmailOutboxRepository,
    parentLogger: Logger,
    private readonly intervalMs: number = runtimeConfig.autoFulfillmentIntervalMs
  ) {
    this.logger = parentLogger.child({ worker: "auto-fulfillment" });
  }

  /**
   * Start the worker with interval-based polling
   */
  start(): void {
    if (this.intervalHandle) {
      this.logger.warn("Auto-fulfillment worker already running");
      return;
    }

    if (!this.easyPostService.isConfigured()) {
      this.logger.warn("Auto-fulfillment worker not starting - EasyPost not configured");
      return;
    }

    if (!runtimeConfig.autoFulfillmentEnabled) {
      this.logger.info("Auto-fulfillment worker disabled (AUTO_FULFILLMENT_ENABLED=false)");
      return;
    }

    this.logger.info({ intervalMs: this.intervalMs }, "Starting auto-fulfillment worker");

    // Run immediately on start
    void this.runOnce();

    // Then run on interval
    this.intervalHandle = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  /**
   * Stop the worker
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info("Auto-fulfillment worker stopped");
    }
  }

  /**
   * Run a single iteration of the worker.
   * Uses atomic claim pattern to prevent multi-instance race conditions.
   */
  async runOnce(): Promise<AutoFulfillmentResult> {
    if (this.isRunning) {
      this.logger.debug("Auto-fulfillment worker already running, skipping");
      return { processed: 0, labelsCreated: 0, emailsEnqueued: 0, errors: 0, skipped: true };
    }

    this.isRunning = true;
    const result: AutoFulfillmentResult = {
      processed: 0,
      labelsCreated: 0,
      emailsEnqueued: 0,
      errors: 0,
      skipped: false,
    };

    try {
      // Recover stuck 'processing' rows before claiming new ones
      // (Worker crash recovery - rows stuck longer than threshold)
      this.recoverStuckProcessing();

      // Process up to 10 fulfillments per iteration using atomic claim
      const maxPerIteration = 10;

      for (let i = 0; i < maxPerIteration; i++) {
        // Atomic claim: UPDATE...RETURNING prevents multi-instance race
        const now = Math.floor(Date.now() / 1000);
        const fulfillment = this.db
          .prepare(
            `
            UPDATE fulfillment
            SET status = 'processing', updated_at = ?
            WHERE stripe_session_id = (
              SELECT stripe_session_id FROM fulfillment
              WHERE status = 'pending' AND requires_manual_review = 0
              ORDER BY created_at ASC LIMIT 1
            )
            RETURNING *
          `
          )
          .get(now) as PendingFulfillment | undefined;

        if (!fulfillment) {
          // No more pending fulfillments
          if (i === 0) {
            this.logger.debug("No pending auto-fulfillments");
          }
          break;
        }

        result.processed++;
        try {
          const { labelPurchased, emailEnqueued } = await this.processFulfillment(fulfillment);
          if (labelPurchased) result.labelsCreated++;
          if (emailEnqueued) result.emailsEnqueued++;
        } catch (err) {
          result.errors++;
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.markException(fulfillment.stripe_session_id, "auto_fulfillment_failed", errorMsg);
          this.logger.error(
            {
              err,
              sessionId: fulfillment.stripe_session_id,
            },
            "Auto-fulfillment failed"
          );
        }
      }

      if (result.processed > 0) {
        this.logger.info(result, "Auto-fulfillment processing complete");
      }
    } catch (err) {
      this.logger.error({ err }, "Auto-fulfillment worker failed");
    } finally {
      this.isRunning = false;
    }

    return result;
  }

  /**
   * Process a single fulfillment: fetch address, create shipment, buy label, enqueue email.
   * Fulfillment is already claimed with status='processing' by atomic UPDATE.
   *
   * @returns { labelPurchased, emailEnqueued } for accurate metrics
   */
  private async processFulfillment(fulfillment: PendingFulfillment): Promise<ProcessFulfillmentResult> {
    const sessionId = fulfillment.stripe_session_id;

    // Idempotency guard: skip if label already purchased (shouldn't happen with atomic claim, but defensive)
    if (fulfillment.tracking_number && fulfillment.label_url) {
      this.logger.info({ sessionId }, "Label already purchased (skipping)");
      // Restore status to label_purchased since we already have a label
      this.db
        .prepare(`UPDATE fulfillment SET status = 'label_purchased', updated_at = strftime('%s', 'now') WHERE stripe_session_id = ?`)
        .run(sessionId);
      return { labelPurchased: false, emailEnqueued: false };
    }

    // Check if label already purchased via EasyPost (idempotent recovery)
    if (fulfillment.easypost_shipment_id) {
      const existing = await this.easyPostService.getShipment(fulfillment.easypost_shipment_id);
      if (existing?.tracking_code) {
        this.logger.info({ sessionId, trackingCode: existing.tracking_code }, "Label already purchased in EasyPost (updating DB)");
        // Update our DB to match EasyPost state
        this.updateFulfillmentWithLabel(
          sessionId,
          existing.tracking_code,
          existing.postage_label?.label_url ?? null,
          existing.selected_rate?.carrier ?? "USPS",
          existing.selected_rate?.service ?? null,
          existing.selected_rate ? Math.round(parseFloat(existing.selected_rate.rate) * 100) : null
        );
        // Enqueue email for this already-purchased label
        const emailEnqueued = await this.enqueueConfirmationEmail(sessionId, existing.tracking_code);
        return { labelPurchased: false, emailEnqueued }; // Label was already purchased externally
      }
    }

    // Fetch shipping address from Stripe (not persisted per PII requirement)
    const session = await this.stripeService.getCheckoutSession(sessionId);
    if (!session) {
      throw new Error(`Stripe session not found: ${sessionId}`);
    }

    const shippingDetails = session.shipping_details ?? session.customer_details;
    if (!shippingDetails?.address) {
      throw new Error("No shipping address on Stripe session");
    }

    const toAddress: EasyPostAddress = {
      name: shippingDetails.name ?? undefined,
      street1: shippingDetails.address.line1 ?? "",
      street2: shippingDetails.address.line2 ?? undefined,
      city: shippingDetails.address.city ?? "",
      state: shippingDetails.address.state ?? "",
      zip: shippingDetails.address.postal_code ?? "",
      country: shippingDetails.address.country ?? "US",
      phone: shippingDetails.phone ?? undefined,
      email: session.customer_details?.email ?? undefined,
    };

    // Create shipment and get rates
    const shipmentResult = await this.easyPostService.createShipment(
      toAddress,
      fulfillment.item_count,
      fulfillment.shipping_method
    );

    if (!shipmentResult.success || !shipmentResult.shipment) {
      throw new Error(shipmentResult.error || "Failed to create EasyPost shipment");
    }

    if (!shipmentResult.compatibleRates || shipmentResult.compatibleRates.length === 0) {
      throw new Error(`No compatible ${fulfillment.shipping_method} rates available`);
    }

    // Store shipment ID for idempotency
    this.db
      .prepare(
        `UPDATE fulfillment SET easypost_shipment_id = ?, updated_at = strftime('%s', 'now') WHERE stripe_session_id = ?`
      )
      .run(shipmentResult.shipment.id, sessionId);

    // Purchase cheapest compatible rate
    const cheapestRate = shipmentResult.compatibleRates.sort(
      (a, b) => parseFloat(a.rate) - parseFloat(b.rate)
    )[0];

    // GUARDRAIL: Check label cost before purchasing
    // Threshold: max(shipping * 1.5, shipping + $2)
    const labelCostCents = Math.round(parseFloat(cheapestRate.rate) * 100);
    const shippingChargedCents = fulfillment.shipping_cost_cents;
    const costThresholdCents = Math.max(shippingChargedCents * 1.5, shippingChargedCents + 200);

    if (labelCostCents > costThresholdCents) {
      this.logger.warn(
        {
          sessionId,
          labelCostCents,
          shippingChargedCents,
          costThresholdCents,
          carrier: cheapestRate.carrier,
          service: cheapestRate.service,
        },
        "Label cost exceeds threshold - flagging for admin review"
      );
      this.markException(
        sessionId,
        "label_cost_exceeds_shipping",
        `Label $${(labelCostCents / 100).toFixed(2)} exceeds threshold $${(costThresholdCents / 100).toFixed(2)} (shipping charged $${(shippingChargedCents / 100).toFixed(2)})`
      );
      return { labelPurchased: false, emailEnqueued: false };
    }

    const labelResult = await this.easyPostService.purchaseLabel(
      shipmentResult.shipment.id,
      cheapestRate.id,
      fulfillment.shipping_method
    );

    if (!labelResult.success) {
      throw new Error(labelResult.error || "Label purchase failed");
    }

    const actualLabelCostCents = labelResult.shipment?.selected_rate
      ? Math.round(parseFloat(labelResult.shipment.selected_rate.rate) * 100)
      : labelCostCents;

    // Update fulfillment record
    this.updateFulfillmentWithLabel(
      sessionId,
      labelResult.trackingNumber ?? null,
      labelResult.labelUrl ?? null,
      labelResult.carrier ?? "USPS",
      labelResult.service ?? null,
      actualLabelCostCents
    );

    this.logger.info(
      {
        sessionId,
        trackingNumber: labelResult.trackingNumber,
        carrier: labelResult.carrier,
        service: labelResult.service,
        labelCostCents: actualLabelCostCents,
      },
      "Auto-fulfillment: label purchased"
    );

    // Enqueue confirmation email
    let emailEnqueued = false;
    if (labelResult.trackingNumber) {
      emailEnqueued = await this.enqueueConfirmationEmail(sessionId, labelResult.trackingNumber);
    }

    return { labelPurchased: true, emailEnqueued };
  }

  /**
   * Update fulfillment record with label details
   */
  private updateFulfillmentWithLabel(
    sessionId: string,
    trackingNumber: string | null,
    labelUrl: string | null,
    carrier: string,
    service: string | null,
    labelCostCents: number | null
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const trackingUrl = trackingNumber
      ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`
      : null;

    this.db
      .prepare(
        `
      UPDATE fulfillment SET
        status = 'label_purchased',
        carrier = ?,
        tracking_number = ?,
        tracking_url = ?,
        easypost_service = ?,
        label_url = ?,
        label_cost_cents = ?,
        label_purchased_at = ?,
        updated_at = ?
      WHERE stripe_session_id = ?
    `
      )
      .run(carrier, trackingNumber, trackingUrl, service, labelUrl, labelCostCents, now, now, sessionId);
  }

  /**
   * Enqueue the confirmation + tracking email
   * @returns true if email was enqueued, false if already exists
   */
  private async enqueueConfirmationEmail(sessionId: string, trackingNumber: string): Promise<boolean> {
    try {
      // Get order details
      const order = this.db
        .prepare(
          `
        SELECT order_number, subtotal_cents, shipping_cents, total_cents
        FROM orders WHERE stripe_session_id = ?
      `
        )
        .get(sessionId) as
        | {
            order_number: string;
            subtotal_cents: number;
            shipping_cents: number;
            total_cents: number;
          }
        | undefined;

      if (!order) {
        this.logger.warn({ sessionId }, "Order not found for email enqueue");
        return false;
      }

      // Get item details from Stripe session metadata
      const session = await this.stripeService.getCheckoutSession(sessionId);
      const items = await this.getOrderItems(session);

      // Get fulfillment for carrier info
      const fulfillment = this.db
        .prepare(`SELECT carrier FROM fulfillment WHERE stripe_session_id = ?`)
        .get(sessionId) as { carrier: string } | undefined;

      const templateData: OrderConfirmedTrackingData = {
        orderNumber: order.order_number,
        trackingNumber,
        trackingUrl: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
        carrier: fulfillment?.carrier ?? "USPS",
        items,
        subtotalCents: order.subtotal_cents,
        shippingCents: order.shipping_cents,
        totalCents: order.total_cents,
      };

      const emailUid = this.emailOutboxRepo.enqueue({
        stripeSessionId: sessionId,
        emailType: "order_confirmed_tracking",
        templateData,
      });

      if (emailUid) {
        this.logger.info({ emailUid, orderNumber: order.order_number }, "Confirmation email enqueued");
        return true;
      } else {
        this.logger.debug({ sessionId }, "Email already enqueued (idempotent skip)");
        return false;
      }
    } catch (err) {
      // Non-fatal: don't fail the fulfillment if email enqueue fails
      this.logger.warn({ err, sessionId }, "Failed to enqueue confirmation email (non-fatal)");
      return false;
    }
  }

  /**
   * Get order items for email template
   */
  private async getOrderItems(
    session: Awaited<ReturnType<StripeService["getCheckoutSession"]>>
  ): Promise<Array<{ name: string; priceCents: number; imageUrl: string | null }>> {
    if (!session) {
      return [{ name: "Pokemon Card", priceCents: 0, imageUrl: null }];
    }

    // Parse item_uids from session metadata
    const itemUids: string[] = session.metadata?.item_uids
      ? JSON.parse(session.metadata.item_uids)
      : session.metadata?.item_uid
        ? [session.metadata.item_uid]
        : [];

    if (itemUids.length === 0) {
      return [
        {
          name: "Pokemon Card",
          priceCents: session.amount_subtotal ?? 0,
          imageUrl: null,
        },
      ];
    }

    const items: Array<{ name: string; priceCents: number; imageUrl: string | null }> = [];

    for (const itemUid of itemUids) {
      const item = this.db
        .prepare(
          `
        SELECT p.name, i.price_cents, p.master_front_cdn_url as image_url
        FROM items i
        JOIN products p ON i.product_uid = p.product_uid
        WHERE i.item_uid = ?
      `
        )
        .get(itemUid) as
        | {
            name: string;
            price_cents: number;
            image_url: string | null;
          }
        | undefined;

      if (item) {
        items.push({
          name: item.name,
          priceCents: item.price_cents,
          imageUrl: item.image_url,
        });
      }
    }

    return items.length > 0
      ? items
      : [{ name: "Pokemon Card", priceCents: session.amount_subtotal ?? 0, imageUrl: null }];
  }

  /**
   * Mark fulfillment as exception for admin visibility
   */
  private markException(sessionId: string, exceptionType: string, notes: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `
      UPDATE fulfillment SET
        status = 'exception',
        exception_type = ?,
        exception_notes = ?,
        exception_at = ?,
        updated_at = ?
      WHERE stripe_session_id = ?
    `
      )
      .run(exceptionType, notes.slice(0, 500), now, now, sessionId);
  }

  /**
   * Recover stuck 'processing' fulfillments.
   * Rows stuck in 'processing' longer than threshold are reset to 'pending'.
   * Handles worker crash recovery to prevent orders stuck indefinitely.
   */
  private recoverStuckProcessing(): void {
    const now = Math.floor(Date.now() / 1000);
    const stuckThresholdSec = Math.floor(PROCESSING_STUCK_THRESHOLD_MS / 1000);
    const stuckCutoff = now - stuckThresholdSec;

    const result = this.db
      .prepare(
        `
        UPDATE fulfillment
        SET status = 'pending',
            updated_at = ?
        WHERE status = 'processing'
          AND updated_at < ?
      `
      )
      .run(now, stuckCutoff);

    if (result.changes > 0) {
      this.logger.warn(
        { recovered: result.changes, stuckThresholdSec },
        "Recovered stuck 'processing' fulfillments (worker crash recovery)"
      );
    }
  }

  /**
   * Check if worker is active
   */
  isActive(): boolean {
    return this.intervalHandle !== null;
  }
}

/**
 * Factory function to create AutoFulfillmentWorker instance
 */
export function createAutoFulfillmentWorker(
  db: Database,
  easyPostService: EasyPostService,
  stripeService: StripeService,
  emailOutboxRepo: EmailOutboxRepository,
  logger: Logger
): AutoFulfillmentWorker {
  return new AutoFulfillmentWorker(db, easyPostService, stripeService, emailOutboxRepo, logger);
}
