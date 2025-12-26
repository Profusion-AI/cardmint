/**
 * Email Outbox Repository
 *
 * Provides persistence and query methods for the email_outbox table.
 * Used by EmailOutboxWorker to drain pending transactional emails.
 *
 * Design principles:
 * - No PII stored: customer email fetched from Stripe at send time
 * - Idempotent: UNIQUE(stripe_session_id, email_type) prevents double-enqueue
 * - Retry with backoff: stuck 'sending' rows recovered after threshold
 *
 * Reference: PR2 Email Outbox plan
 */

import type { Database } from "better-sqlite3";
import { randomUUID } from "crypto";
import { runtimeConfig } from "../config.js";

export type EmailType = "order_confirmation" | "order_confirmed_tracking";
export type EmailStatus = "pending" | "sending" | "sent" | "failed";

export interface EmailOutboxRow {
  id: number;
  email_uid: string;
  stripe_session_id: string;
  email_type: EmailType;
  status: EmailStatus;
  retry_count: number;
  max_retries: number;
  next_retry_at: number | null;
  last_error: string | null;
  sending_started_at: number | null;
  template_data: string; // JSON
  created_at: number;
  sent_at: number | null;
  updated_at: number;
}

/**
 * Template data for order_confirmation email (sent at checkout)
 * No tracking info - just order acknowledgment
 */
export interface OrderConfirmationData {
  orderNumber: string;
  items: Array<{
    name: string;
    priceCents: number;
    imageUrl: string | null;
  }>;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
}

/**
 * Template data for order_confirmed_tracking email (sent after label purchase)
 * Includes tracking info for shipment notification
 */
export interface OrderConfirmedTrackingData {
  orderNumber: string;
  trackingNumber: string;
  trackingUrl: string;
  carrier: string;
  items: Array<{
    name: string;
    priceCents: number;
    imageUrl: string | null;
  }>;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
}

/** Union type for all email template data */
export type EmailTemplateData = OrderConfirmationData | OrderConfirmedTrackingData;

export interface EnqueueEmailParams {
  stripeSessionId: string;
  emailType: EmailType;
  templateData: EmailTemplateData;
}

export interface EmailOutboxStats {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
}

export class EmailOutboxRepository {
  constructor(private readonly db: Database) {}

  /**
   * Enqueue an email for sending.
   * Idempotent via UNIQUE constraint on (stripe_session_id, email_type).
   *
   * @returns email_uid if newly created, null if already exists
   */
  enqueue(params: EnqueueEmailParams): string | null {
    const emailUid = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    try {
      this.db
        .prepare(
          `
        INSERT INTO email_outbox (
          email_uid, stripe_session_id, email_type, status,
          template_data, max_retries, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
      `
        )
        .run(
          emailUid,
          params.stripeSessionId,
          params.emailType,
          JSON.stringify(params.templateData),
          runtimeConfig.emailOutboxMaxRetries,
          now,
          now
        );
      return emailUid;
    } catch (err: unknown) {
      // UNIQUE constraint violation = already enqueued (idempotent)
      if (err instanceof Error && err.message?.includes("UNIQUE constraint failed")) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Claim pending emails ready for processing.
   * Atomically sets status to 'sending' and returns claimed rows.
   * Also recovers stuck 'sending' rows older than threshold.
   *
   * @param limit Maximum number of emails to claim (default 10)
   * @returns Array of claimed email rows
   */
  claimPending(limit: number = 10): EmailOutboxRow[] {
    const now = Math.floor(Date.now() / 1000);
    const stuckThresholdSec = Math.floor(runtimeConfig.emailOutboxStuckThresholdMs / 1000);
    const stuckCutoff = now - stuckThresholdSec;

    return this.db.transaction(() => {
      // First, recover stuck 'sending' rows (older than threshold)
      this.db
        .prepare(
          `
        UPDATE email_outbox
        SET status = 'pending',
            sending_started_at = NULL,
            retry_count = retry_count + 1,
            last_error = 'Worker timeout - recovered from stuck sending state',
            updated_at = ?
        WHERE status = 'sending'
          AND sending_started_at IS NOT NULL
          AND sending_started_at < ?
          AND retry_count < max_retries
      `
        )
        .run(now, stuckCutoff);

      // Mark exceeded retries as failed
      this.db
        .prepare(
          `
        UPDATE email_outbox
        SET status = 'failed',
            sending_started_at = NULL,
            last_error = 'Max retries exceeded after worker timeout',
            updated_at = ?
        WHERE status = 'sending'
          AND sending_started_at IS NOT NULL
          AND sending_started_at < ?
          AND retry_count >= max_retries
      `
        )
        .run(now, stuckCutoff);

      // Atomic claim: UPDATE...RETURNING with subquery prevents multi-instance race
      // The SELECT is part of the UPDATE, so no gap for another worker to steal rows
      const claimedRows = this.db
        .prepare(
          `
        UPDATE email_outbox
        SET status = 'sending',
            sending_started_at = ?,
            updated_at = ?
        WHERE id IN (
          SELECT id FROM email_outbox
          WHERE status = 'pending'
            AND (next_retry_at IS NULL OR next_retry_at <= ?)
          ORDER BY created_at ASC
          LIMIT ?
        )
        RETURNING *
      `
        )
        .all(now, now, now, limit) as EmailOutboxRow[];

      return claimedRows;
    })();
  }

  /**
   * Mark email as successfully sent.
   */
  markSent(emailUid: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `
      UPDATE email_outbox
      SET status = 'sent',
          sent_at = ?,
          sending_started_at = NULL,
          updated_at = ?
      WHERE email_uid = ?
    `
      )
      .run(now, now, emailUid);
  }

  /**
   * Mark email as failed with error. Handles retry logic.
   * If retry_count < max_retries, sets status back to 'pending' with next_retry_at.
   * Otherwise, sets status to 'failed' (permanent).
   */
  markFailed(emailUid: string, error: string): void {
    const now = Math.floor(Date.now() / 1000);
    const nextRetryDelaySec = Math.floor(runtimeConfig.emailOutboxRetryDelayMs / 1000);
    const nextRetryAt = now + nextRetryDelaySec;

    this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT retry_count, max_retries FROM email_outbox WHERE email_uid = ?`)
        .get(emailUid) as { retry_count: number; max_retries: number } | undefined;

      if (!row) return;

      const newRetryCount = row.retry_count + 1;
      const isFinalFailure = newRetryCount >= row.max_retries;

      this.db
        .prepare(
          `
        UPDATE email_outbox
        SET status = ?,
            retry_count = ?,
            last_error = ?,
            next_retry_at = ?,
            sending_started_at = NULL,
            updated_at = ?
        WHERE email_uid = ?
      `
        )
        .run(
          isFinalFailure ? "failed" : "pending",
          newRetryCount,
          error.slice(0, 1000), // Truncate long errors
          isFinalFailure ? null : nextRetryAt,
          now,
          emailUid
        );
    })();
  }

  /**
   * Get email by stripe_session_id and type.
   * Used for checking if email was already sent (admin visibility).
   */
  getBySessionAndType(stripeSessionId: string, emailType: EmailType): EmailOutboxRow | undefined {
    return this.db
      .prepare(`SELECT * FROM email_outbox WHERE stripe_session_id = ? AND email_type = ?`)
      .get(stripeSessionId, emailType) as EmailOutboxRow | undefined;
  }

  /**
   * Get email by email_uid.
   */
  getByUid(emailUid: string): EmailOutboxRow | undefined {
    return this.db.prepare(`SELECT * FROM email_outbox WHERE email_uid = ?`).get(emailUid) as
      | EmailOutboxRow
      | undefined;
  }

  /**
   * Get outbox statistics for admin health monitoring.
   */
  getStats(): EmailOutboxStats {
    const result = this.db
      .prepare(
        `
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) as sending,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM email_outbox
    `
      )
      .get() as { pending: number; sending: number; sent: number; failed: number };

    return {
      pending: result.pending ?? 0,
      sending: result.sending ?? 0,
      sent: result.sent ?? 0,
      failed: result.failed ?? 0,
    };
  }

  /**
   * Get failed emails for admin review and manual resend.
   */
  getFailedEmails(limit: number = 50): EmailOutboxRow[] {
    return this.db
      .prepare(
        `
      SELECT * FROM email_outbox
      WHERE status = 'failed'
      ORDER BY updated_at DESC
      LIMIT ?
    `
      )
      .all(limit) as EmailOutboxRow[];
  }

  /**
   * Reset a failed email to pending for manual resend.
   * Clears retry_count and error state.
   */
  resetForResend(emailUid: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare(
        `
      UPDATE email_outbox
      SET status = 'pending',
          retry_count = 0,
          next_retry_at = NULL,
          last_error = NULL,
          sending_started_at = NULL,
          updated_at = ?
      WHERE email_uid = ?
        AND status = 'failed'
    `
      )
      .run(now, emailUid);

    return result.changes > 0;
  }
}
