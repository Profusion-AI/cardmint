/**
 * Stripe Expiry Job
 * Background timer that expires overdue checkout sessions and releases reservations
 * Reference: stripe-imp-plan.md, Codex runbook Dec 2
 */

import type { Logger } from "pino";
import type { StripeService } from "./stripeService";
import type { InventoryService, OverdueReservation } from "./inventory/inventoryService";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class StripeExpiryJob {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(
    private readonly stripeService: StripeService,
    private readonly inventoryService: InventoryService,
    private readonly logger: Logger,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS
  ) {}

  /**
   * Start the background expiry timer
   */
  start(): void {
    if (this.intervalHandle) {
      this.logger.warn("Stripe expiry job already running");
      return;
    }

    if (!this.stripeService.isConfigured()) {
      this.logger.info("Stripe not configured - expiry job not started");
      return;
    }

    this.logger.info(
      { intervalMs: this.intervalMs },
      "Starting Stripe expiry job"
    );

    // Run immediately on start
    this.runOnce();

    // Then run on interval
    this.intervalHandle = setInterval(() => {
      this.runOnce();
    }, this.intervalMs);
  }

  /**
   * Stop the background expiry timer
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info("Stripe expiry job stopped");
    }
  }

  /**
   * Run one iteration of the expiry job
   */
  async runOnce(): Promise<ExpiryJobResult> {
    if (this.isRunning) {
      this.logger.debug("Expiry job already running, skipping");
      return { processed: 0, released: 0, errors: 0, skipped: true };
    }

    this.isRunning = true;
    const result: ExpiryJobResult = {
      processed: 0,
      released: 0,
      errors: 0,
      skipped: false,
    };

    try {
      const overdue = this.inventoryService.findOverdueReservations();

      if (overdue.length === 0) {
        this.logger.debug("No overdue reservations found");
        return result;
      }

      this.logger.info({ count: overdue.length }, "Processing overdue reservations");

      for (const reservation of overdue) {
        result.processed++;

        try {
          await this.processReservation(reservation);
          result.released++;
        } catch (error) {
          result.errors++;
          this.logger.error(
            { err: error, itemUid: reservation.item_uid },
            "Failed to process overdue reservation"
          );
        }
      }

      this.logger.info(
        { processed: result.processed, released: result.released, errors: result.errors },
        "Expiry job iteration complete"
      );
    } catch (error) {
      this.logger.error({ err: error }, "Expiry job failed");
    } finally {
      this.isRunning = false;
    }

    return result;
  }

  /**
   * Process a single overdue reservation
   */
  private async processReservation(reservation: OverdueReservation): Promise<void> {
    const { item_uid, checkout_session_id, reserved_until } = reservation;

    this.logger.debug(
      { itemUid: item_uid, sessionId: checkout_session_id, reservedUntil: reserved_until },
      "Expiring overdue reservation"
    );

    // Expire checkout session in Stripe (may already be expired)
    await this.stripeService.expireCheckoutSession(checkout_session_id);

    // Release item back to IN_STOCK
    const released = this.inventoryService.releaseReservation(item_uid);

    if (released) {
      this.logger.info({ itemUid: item_uid }, "Overdue reservation expired and released");
    } else {
      this.logger.warn(
        { itemUid: item_uid },
        "Could not release reservation (may have been sold or already released)"
      );
    }
  }

  /**
   * Check if the job is currently running
   */
  isActive(): boolean {
    return this.intervalHandle !== null;
  }
}

export interface ExpiryJobResult {
  processed: number;
  released: number;
  errors: number;
  skipped: boolean;
}
