/**
 * Email Outbox Worker
 *
 * Background worker that drains the email outbox and sends transactional emails via Resend.
 * Follows the interval-based worker pattern (ReservationExpiryJob).
 *
 * Design principles:
 * - No PII stored: fetches customer email from Stripe at send time
 * - Retry with backoff: handles transient failures gracefully
 * - Audit trail: logs email_sent event to order_events table
 * - Concurrency guard: isRunning flag prevents overlapping runs
 *
 * Reference: PR2 Email Outbox plan
 */

import type { Logger } from "pino";
import type { Database } from "better-sqlite3";
import type { EmailOutboxRepository, EmailOutboxRow, OrderConfirmationData, OrderConfirmedTrackingData } from "../repositories/emailOutboxRepository.js";
import type { ResendService } from "./resendService.js";
import type { StripeService } from "./stripeService.js";
import { runtimeConfig } from "../config.js";

export interface EmailOutboxWorkerResult {
  processed: number;
  sent: number;
  failed: number;
  skipped: boolean;
}

export class EmailOutboxWorker {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private logger: Logger;

  constructor(
    private readonly db: Database,
    private readonly emailOutboxRepo: EmailOutboxRepository,
    private readonly resendService: ResendService,
    private readonly stripeService: StripeService,
    parentLogger: Logger,
    private readonly intervalMs: number = runtimeConfig.emailOutboxIntervalMs
  ) {
    this.logger = parentLogger.child({ worker: "email-outbox" });
  }

  /**
   * Start the worker with interval-based polling
   */
  start(): void {
    if (this.intervalHandle) {
      this.logger.warn("Email outbox worker already running");
      return;
    }

    if (!this.resendService.isConfigured()) {
      this.logger.warn("Email outbox worker not starting - Resend not configured");
      return;
    }

    if (!runtimeConfig.emailOutboxEnabled) {
      this.logger.info("Email outbox worker disabled (EMAIL_OUTBOX_ENABLED=false)");
      return;
    }

    this.logger.info({ intervalMs: this.intervalMs }, "Starting email outbox worker");

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
      this.logger.info("Email outbox worker stopped");
    }
  }

  /**
   * Run a single iteration of the worker
   */
  async runOnce(): Promise<EmailOutboxWorkerResult> {
    if (this.isRunning) {
      this.logger.debug("Email outbox worker already running, skipping");
      return { processed: 0, sent: 0, failed: 0, skipped: true };
    }

    this.isRunning = true;
    const result: EmailOutboxWorkerResult = {
      processed: 0,
      sent: 0,
      failed: 0,
      skipped: false,
    };

    try {
      // Claim pending emails (also recovers stuck 'sending' rows)
      const emails = this.emailOutboxRepo.claimPending(10);

      if (emails.length === 0) {
        this.logger.debug("No pending emails to process");
        return result;
      }

      this.logger.info({ count: emails.length }, "Processing pending emails");

      for (const email of emails) {
        result.processed++;
        try {
          await this.processEmail(email);
          result.sent++;
        } catch (err) {
          result.failed++;
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.emailOutboxRepo.markFailed(email.email_uid, errorMsg);
          this.logger.error({ err, emailUid: email.email_uid, sessionId: email.stripe_session_id }, "Failed to send email");
        }
      }

      if (result.processed > 0) {
        this.logger.info(result, "Email outbox processing complete");
      }
    } catch (err) {
      this.logger.error({ err }, "Email outbox worker failed");
    } finally {
      this.isRunning = false;
    }

    return result;
  }

  /**
   * Process a single email
   * Routes to appropriate handler based on email_type
   */
  private async processEmail(email: EmailOutboxRow): Promise<void> {
    // Fetch customer email from Stripe (no PII in our DB)
    const session = await this.stripeService.getCheckoutSession(email.stripe_session_id);
    if (!session) {
      throw new Error(`Stripe session not found: ${email.stripe_session_id}`);
    }

    const customerEmail = session.customer_details?.email;
    if (!customerEmail) {
      throw new Error("No customer email found in Stripe session");
    }

    let subject: string;
    let html: string;
    let text: string;
    let orderNumber: string;

    // Route to appropriate template based on email type
    if (email.email_type === "order_confirmation") {
      // Simple order confirmation (sent at checkout - no tracking)
      const templateData = JSON.parse(email.template_data) as OrderConfirmationData;
      orderNumber = templateData.orderNumber;
      ({ subject, html, text } = this.resendService.buildSimpleOrderConfirmationEmail(templateData));
    } else if (email.email_type === "order_confirmed_tracking") {
      // Shipping confirmation with tracking (sent after label purchase)
      const templateData = JSON.parse(email.template_data) as OrderConfirmedTrackingData;
      orderNumber = templateData.orderNumber;

      // Guard: tracking email requires tracking number
      if (!templateData.trackingNumber) {
        throw new Error("Cannot send tracking email: tracking number missing from template data");
      }

      ({ subject, html, text } = this.resendService.buildOrderConfirmationEmail(templateData));
    } else {
      throw new Error(`Unknown email_type: ${email.email_type}`);
    }

    // Send via Resend
    const result = await this.resendService.sendEmail({
      to: customerEmail,
      subject,
      html,
      text,
      tags: [
        { name: "order_number", value: orderNumber },
        { name: "email_type", value: email.email_type },
      ],
    });

    if (!result.success) {
      throw new Error(result.error || "Unknown send error");
    }

    // Mark as sent
    this.emailOutboxRepo.markSent(email.email_uid);

    // Log to order_events audit trail
    this.logEmailSentEvent(email, result.messageId);

    this.logger.info(
      {
        emailUid: email.email_uid,
        messageId: result.messageId,
        emailType: email.email_type,
        orderNumber,
        // Redact PII: only log domain portion of email
        recipientDomain: customerEmail.split("@")[1],
      },
      "Transactional email sent"
    );
  }

  /**
   * Log email_sent event to order_events table for audit trail
   */
  private logEmailSentEvent(email: EmailOutboxRow, messageId?: string): void {
    try {
      const order = this.db
        .prepare(`SELECT order_uid FROM orders WHERE stripe_session_id = ?`)
        .get(email.stripe_session_id) as { order_uid: string } | undefined;

      if (!order) {
        this.logger.warn({ sessionId: email.stripe_session_id }, "Order not found for email_sent event");
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      this.db
        .prepare(
          `
        INSERT INTO order_events (order_uid, event_type, new_value, actor, created_at)
        VALUES (?, 'email_sent', ?, 'system', ?)
      `
        )
        .run(
          order.order_uid,
          JSON.stringify({
            email_type: email.email_type,
            email_uid: email.email_uid,
            message_id: messageId,
          }),
          now
        );
    } catch (err) {
      // Non-fatal: don't fail the email send if audit logging fails
      this.logger.warn({ err, emailUid: email.email_uid }, "Failed to log email_sent event (non-fatal)");
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
 * Factory function to create EmailOutboxWorker instance
 */
export function createEmailOutboxWorker(
  db: Database,
  emailOutboxRepo: EmailOutboxRepository,
  resendService: ResendService,
  stripeService: StripeService,
  logger: Logger
): EmailOutboxWorker {
  return new EmailOutboxWorker(db, emailOutboxRepo, resendService, stripeService, logger);
}
