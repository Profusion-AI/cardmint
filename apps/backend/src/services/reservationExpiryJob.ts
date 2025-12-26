/**
 * Reservation Expiry Job
 * Background timer that expires overdue reservations (both cart and checkout)
 *
 * Key behaviors:
 * - Always starts regardless of Stripe config (cart reservations need cleanup)
 * - Processes cart reservations first (no Stripe API call needed)
 * - Only calls Stripe API for checkout reservations
 * - Separates cart vs checkout expiry for clean metrics
 *
 * Reference: stripe-imp-plan.md, cart-reservation-system plan Dec 18
 */

import type { Logger } from "pino";
import type { StripeService } from "./stripeService";
import type { InventoryService, OverdueReservation, OverdueCartReservation } from "./inventory/inventoryService";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class ReservationExpiryJob {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(
    private readonly stripeService: StripeService | null,
    private readonly inventoryService: InventoryService,
    private readonly logger: Logger,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS
  ) {}

  /**
   * Start the background expiry timer.
   * ALWAYS starts - cart reservations need cleanup even without Stripe.
   */
  start(): void {
    if (this.intervalHandle) {
      this.logger.warn("Reservation expiry job already running");
      return;
    }

    const stripeConfigured = this.stripeService?.isConfigured() ?? false;

    this.logger.info(
      { intervalMs: this.intervalMs, stripeConfigured },
      "Starting reservation expiry job"
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
      this.logger.info("Reservation expiry job stopped");
    }
  }

  /**
   * Run one iteration of the expiry job
   */
  async runOnce(): Promise<ExpiryJobResult> {
    if (this.isRunning) {
      this.logger.debug("Expiry job already running, skipping");
      return {
        cartProcessed: 0,
        cartReleased: 0,
        checkoutProcessed: 0,
        checkoutReleased: 0,
        errors: 0,
        skipped: true,
      };
    }

    this.isRunning = true;
    const result: ExpiryJobResult = {
      cartProcessed: 0,
      cartReleased: 0,
      checkoutProcessed: 0,
      checkoutReleased: 0,
      errors: 0,
      skipped: false,
    };

    try {
      // 1. Process cart reservations (no Stripe API call needed)
      await this.processCartReservations(result);

      // 2. Process checkout reservations (call Stripe if configured)
      await this.processCheckoutReservations(result);

      const total = result.cartProcessed + result.checkoutProcessed;
      if (total > 0) {
        this.logger.info(
          {
            cartProcessed: result.cartProcessed,
            cartReleased: result.cartReleased,
            checkoutProcessed: result.checkoutProcessed,
            checkoutReleased: result.checkoutReleased,
            errors: result.errors,
          },
          "Expiry job iteration complete"
        );
      } else {
        this.logger.debug("No overdue reservations found");
      }
    } catch (error) {
      this.logger.error({ err: error }, "Expiry job failed");
    } finally {
      this.isRunning = false;
    }

    return result;
  }

  /**
   * Process overdue cart reservations.
   * These don't need Stripe API calls - just release back to IN_STOCK.
   */
  private async processCartReservations(result: ExpiryJobResult): Promise<void> {
    const overdue = this.inventoryService.findOverdueCartReservations();

    if (overdue.length === 0) return;

    this.logger.info({ count: overdue.length }, "Processing overdue cart reservations");

    for (const reservation of overdue) {
      result.cartProcessed++;

      try {
        await this.processCartReservation(reservation);
        result.cartReleased++;
      } catch (error) {
        result.errors++;
        this.logger.error(
          { err: error, itemUid: reservation.item_uid },
          "Failed to process overdue cart reservation"
        );
      }
    }
  }

  /**
   * Process overdue checkout reservations.
   * These need Stripe API calls to expire the session.
   */
  private async processCheckoutReservations(result: ExpiryJobResult): Promise<void> {
    const stripeConfigured = this.stripeService?.isConfigured() ?? false;

    if (!stripeConfigured) {
      // Without Stripe, still release items but don't call Stripe API
      const overdue = this.inventoryService.findOverdueCheckoutReservations();
      if (overdue.length > 0) {
        this.logger.warn(
          { count: overdue.length },
          "Overdue checkout reservations found but Stripe not configured - releasing without API call"
        );
        for (const reservation of overdue) {
          result.checkoutProcessed++;
          try {
            // Release without Stripe call
            const released = this.inventoryService.releaseReservation(reservation.item_uid);
            if (released) result.checkoutReleased++;
          } catch (error) {
            result.errors++;
            this.logger.error(
              { err: error, itemUid: reservation.item_uid },
              "Failed to release checkout reservation"
            );
          }
        }
      }
      return;
    }

    const overdue = this.inventoryService.findOverdueCheckoutReservations();

    if (overdue.length === 0) return;

    this.logger.info({ count: overdue.length }, "Processing overdue checkout reservations");

    for (const reservation of overdue) {
      result.checkoutProcessed++;

      try {
        await this.processCheckoutReservation(reservation);
        result.checkoutReleased++;
      } catch (error) {
        result.errors++;
        this.logger.error(
          { err: error, itemUid: reservation.item_uid },
          "Failed to process overdue checkout reservation"
        );
      }
    }
  }

  /**
   * Process a single overdue cart reservation
   */
  private async processCartReservation(reservation: OverdueCartReservation): Promise<void> {
    const { item_uid, cart_session_id, reserved_until } = reservation;

    this.logger.debug(
      { itemUid: item_uid, cartSessionId: cart_session_id, reservedUntil: reserved_until },
      "Expiring overdue cart reservation"
    );

    // Release item back to IN_STOCK (no Stripe call needed)
    const released = this.inventoryService.releaseCartReservation(item_uid, cart_session_id);

    if (released) {
      this.logger.info({ itemUid: item_uid, cartSessionId: cart_session_id }, "Cart reservation expired and released");
    } else {
      this.logger.warn(
        { itemUid: item_uid },
        "Could not release cart reservation (may have been promoted to checkout or already released)"
      );
    }
  }

  /**
   * Process a single overdue checkout reservation
   */
  private async processCheckoutReservation(reservation: OverdueReservation): Promise<void> {
    const { item_uid, checkout_session_id, reserved_until } = reservation;

    this.logger.debug(
      { itemUid: item_uid, sessionId: checkout_session_id, reservedUntil: reserved_until },
      "Expiring overdue checkout reservation"
    );

    // Expire checkout session in Stripe (may already be expired)
    if (this.stripeService) {
      await this.stripeService.expireCheckoutSession(checkout_session_id);
    }

    // Release item back to IN_STOCK
    const released = this.inventoryService.releaseReservation(item_uid);

    if (released) {
      this.logger.info({ itemUid: item_uid }, "Checkout reservation expired and released");
    } else {
      this.logger.warn(
        { itemUid: item_uid },
        "Could not release checkout reservation (may have been sold or already released)"
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
  cartProcessed: number;
  cartReleased: number;
  checkoutProcessed: number;
  checkoutReleased: number;
  errors: number;
  skipped: boolean;
}

// Re-export old name for backwards compatibility during migration
export { ReservationExpiryJob as StripeExpiryJob };
