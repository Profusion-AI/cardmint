/**
 * Claim Order Service (P1.3)
 *
 * Handles order claim flow via email link:
 * - Token generation with 32-byte crypto random
 * - Rate limiting for email sends and ZIP fallback
 * - Token validation and consumption
 * - Integration with WorkOS identity
 *
 * Security principles:
 * - Non-revealing errors: same message regardless of order existence
 * - Token hash storage: never store plaintext token
 * - Single-use tokens: consumed immediately on success
 * - Rate limiting: prevent enumeration and spam
 *
 * @see RFC-community-growth.md for requirements
 */

import type { Database } from "better-sqlite3";
import type { Logger } from "pino";
import crypto from "crypto";
import { runtimeConfig } from "../config.js";

// Non-revealing error message (CRITICAL: never change based on actual error)
export const CLAIM_ERROR_MESSAGE = "We couldn't start a claim for that order. Check the order code or try again later.";

export interface ClaimTokenResult {
  success: boolean;
  tokenId?: string;
  token?: string; // Plaintext token (only returned once, for email)
  error?: string;
  rateLimited?: boolean;
}

export interface ValidateTokenResult {
  success: boolean;
  orderUid?: string;
  orderNumber?: string;
  error?: string;
  expired?: boolean;
  invalid?: boolean;
}

export interface ClaimRateLimitStatus {
  allowed: boolean;
  hourlyCount: number;
  dailyCount: number;
  lockedOut?: boolean;
  lockoutUntil?: number;
}

interface ClaimTokenRow {
  id: number;
  token_id: string;
  order_uid: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  claimed_by_identity: string | null;
}

interface RateLimitRow {
  id: number;
  order_uid: string;
  action: string;
  window_start: number;
  count_hourly: number;
  count_daily: number;
  last_attempt_at: number;
  lockout_until: number | null;
}

interface OrderRow {
  order_uid: string;
  order_number: string;
  stripe_session_id: string;
}

export class ClaimService {
  private logger: Logger;

  constructor(
    private readonly db: Database,
    logger: Logger
  ) {
    this.logger = logger.child({ service: "claim" });
  }

  /**
   * Check if claim feature is enabled.
   */
  isEnabled(): boolean {
    return runtimeConfig.claimOrderEnabled;
  }

  /**
   * Generate a secure claim token for an order.
   * Returns plaintext token (once) for email, stores hash in DB.
   *
   * @param orderNumber - Human-readable order number (CM-YYYYMMDD-######)
   * @returns Token result with plaintext token for email
   */
  async generateToken(orderNumber: string): Promise<ClaimTokenResult> {
    // Normalize order number (case-insensitive, trim whitespace)
    const normalized = orderNumber.trim().toUpperCase();

    // Look up order (fail silently with generic error if not found)
    const order = this.db
      .prepare("SELECT order_uid, order_number, stripe_session_id FROM orders WHERE UPPER(order_number) = ?")
      .get(normalized) as OrderRow | undefined;

    if (!order) {
      // Log but don't reveal to caller
      this.logger.debug({ orderNumber: normalized }, "Claim token requested for unknown order");
      return { success: false, error: CLAIM_ERROR_MESSAGE };
    }

    // Check rate limit for email sends
    const rateStatus = this.checkRateLimit(order.order_uid, "email_send");
    if (!rateStatus.allowed) {
      this.logClaimEvent(order.order_uid, "email_rate_limited", {
        hourly: rateStatus.hourlyCount,
        daily: rateStatus.dailyCount,
      });
      return { success: false, error: CLAIM_ERROR_MESSAGE, rateLimited: true };
    }

    // Check for existing unexpired token (return new one anyway, but clean up old)
    this.cleanupExpiredTokens(order.order_uid);

    // Generate cryptographically secure token
    const tokenBytes = crypto.randomBytes(32);
    const token = tokenBytes.toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const tokenId = crypto.randomUUID();

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + runtimeConfig.claimTokenTtlMinutes * 60;

    // Store token hash (never plaintext)
    this.db
      .prepare(
        `
        INSERT INTO claim_tokens (token_id, order_uid, token_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `
      )
      .run(tokenId, order.order_uid, tokenHash, now, expiresAt);

    // Increment rate limit counter
    this.incrementRateLimit(order.order_uid, "email_send");

    this.logger.info(
      { orderUid: order.order_uid, tokenId, expiresAt },
      "Claim token generated"
    );

    return {
      success: true,
      tokenId,
      token, // Plaintext returned ONCE for email
    };
  }

  /**
   * Validate a claim token and return order info if valid.
   * Does NOT consume the token - use completeClaimWithToken for that.
   *
   * @param token - Plaintext token from email link
   * @returns Validation result with order info if valid
   */
  validateToken(token: string): ValidateTokenResult {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = Math.floor(Date.now() / 1000);

    const row = this.db
      .prepare(
        `
        SELECT ct.*, o.order_number
        FROM claim_tokens ct
        JOIN orders o ON o.order_uid = ct.order_uid
        WHERE ct.token_hash = ?
      `
      )
      .get(tokenHash) as (ClaimTokenRow & { order_number: string }) | undefined;

    if (!row) {
      this.logger.debug({}, "Token validation failed: unknown token");
      return { success: false, error: CLAIM_ERROR_MESSAGE, invalid: true };
    }

    // Check if already used
    if (row.used_at !== null) {
      this.logClaimEvent(row.order_uid, "token_invalid", { reason: "already_used" });
      return { success: false, error: CLAIM_ERROR_MESSAGE, invalid: true };
    }

    // Check if expired
    if (row.expires_at < now) {
      this.logClaimEvent(row.order_uid, "token_expired", { expiresAt: row.expires_at });
      return { success: false, error: CLAIM_ERROR_MESSAGE, expired: true };
    }

    this.logClaimEvent(row.order_uid, "token_validated", {});

    return {
      success: true,
      orderUid: row.order_uid,
      orderNumber: row.order_number,
    };
  }

  /**
   * Complete claim: validate token, mark as used, link to identity.
   * This is the atomic "consume token" operation.
   *
   * @param token - Plaintext token from email link
   * @param identityId - WorkOS user ID (if authenticated)
   * @returns Validation result
   */
  completeClaimWithToken(token: string, identityId?: string): ValidateTokenResult {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = Math.floor(Date.now() / 1000);

    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `
          SELECT ct.*, o.order_number
          FROM claim_tokens ct
          JOIN orders o ON o.order_uid = ct.order_uid
          WHERE ct.token_hash = ?
        `
        )
        .get(tokenHash) as (ClaimTokenRow & { order_number: string }) | undefined;

      if (!row) {
        return { success: false, error: CLAIM_ERROR_MESSAGE, invalid: true };
      }

      if (row.used_at !== null) {
        return { success: false, error: CLAIM_ERROR_MESSAGE, invalid: true };
      }

      if (row.expires_at < now) {
        return { success: false, error: CLAIM_ERROR_MESSAGE, expired: true };
      }

      // Mark token as used (atomic) - check result to handle race condition
      const updateResult = this.db
        .prepare(
          `
          UPDATE claim_tokens
          SET used_at = ?, claimed_by_identity = ?
          WHERE token_hash = ? AND used_at IS NULL
        `
        )
        .run(now, identityId ?? null, tokenHash);

      // If no rows updated, token was consumed by concurrent request
      if (updateResult.changes === 0) {
        return { success: false, error: CLAIM_ERROR_MESSAGE, invalid: true };
      }

      this.logClaimEvent(row.order_uid, "claim_completed", {
        tokenId: row.token_id,
        hasIdentity: !!identityId,
      });

      this.logger.info(
        { orderUid: row.order_uid, tokenId: row.token_id, identityId },
        "Claim completed successfully"
      );

      return {
        success: true,
        orderUid: row.order_uid,
        orderNumber: row.order_number,
      };
    })();
  }

  /**
   * Get order details by order number (for claim UI).
   * Returns minimal info - no PII.
   */
  getOrderByNumber(orderNumber: string): { orderUid: string; stripeSessionId: string } | null {
    const normalized = orderNumber.trim().toUpperCase();
    const row = this.db
      .prepare("SELECT order_uid, stripe_session_id FROM orders WHERE UPPER(order_number) = ?")
      .get(normalized) as { order_uid: string; stripe_session_id: string } | undefined;

    return row ? { orderUid: row.order_uid, stripeSessionId: row.stripe_session_id } : null;
  }

  /**
   * Check rate limit for an action on an order.
   */
  checkRateLimit(orderUid: string, action: "email_send" | "zip_verify"): ClaimRateLimitStatus {
    const now = Math.floor(Date.now() / 1000);
    const hourAgo = now - 3600;
    const dayAgo = now - 86400;

    const limits =
      action === "email_send"
        ? { hourly: runtimeConfig.claimEmailRateLimitHourly, daily: runtimeConfig.claimEmailRateLimitDaily }
        : { hourly: runtimeConfig.claimZipRateLimitHourly, daily: runtimeConfig.claimZipRateLimitDaily };

    const row = this.db
      .prepare("SELECT * FROM claim_rate_limits WHERE order_uid = ? AND action = ?")
      .get(orderUid, action) as RateLimitRow | undefined;

    if (!row) {
      return { allowed: true, hourlyCount: 0, dailyCount: 0 };
    }

    // Check for lockout (ZIP fallback only)
    if (row.lockout_until && row.lockout_until > now) {
      return {
        allowed: false,
        hourlyCount: row.count_hourly,
        dailyCount: row.count_daily,
        lockedOut: true,
        lockoutUntil: row.lockout_until,
      };
    }

    // Reset counters if window has passed
    const hourlyCount = row.last_attempt_at >= hourAgo ? row.count_hourly : 0;
    const dailyCount = row.window_start >= dayAgo ? row.count_daily : 0;

    const allowed = hourlyCount < limits.hourly && dailyCount < limits.daily;

    return { allowed, hourlyCount, dailyCount };
  }

  /**
   * Increment rate limit counter for an action.
   */
  incrementRateLimit(orderUid: string, action: "email_send" | "zip_verify"): void {
    const now = Math.floor(Date.now() / 1000);
    const hourAgo = now - 3600;
    const dayAgo = now - 86400;

    this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM claim_rate_limits WHERE order_uid = ? AND action = ?")
        .get(orderUid, action) as RateLimitRow | undefined;

      if (!row) {
        // First attempt
        this.db
          .prepare(
            `
            INSERT INTO claim_rate_limits (order_uid, action, window_start, count_hourly, count_daily, last_attempt_at)
            VALUES (?, ?, ?, 1, 1, ?)
          `
          )
          .run(orderUid, action, now, now);
      } else {
        // Reset hourly if hour has passed
        const newHourlyCount = row.last_attempt_at >= hourAgo ? row.count_hourly + 1 : 1;
        // Reset daily if day has passed
        const newDailyCount = row.window_start >= dayAgo ? row.count_daily + 1 : 1;
        const newWindowStart = row.window_start >= dayAgo ? row.window_start : now;

        this.db
          .prepare(
            `
            UPDATE claim_rate_limits
            SET count_hourly = ?, count_daily = ?, window_start = ?, last_attempt_at = ?
            WHERE order_uid = ? AND action = ?
          `
          )
          .run(newHourlyCount, newDailyCount, newWindowStart, now, orderUid, action);
      }
    })();
  }

  /**
   * Trigger ZIP lockout (after 3 failed attempts).
   */
  triggerZipLockout(orderUid: string): void {
    const now = Math.floor(Date.now() / 1000);
    const lockoutUntil = now + runtimeConfig.claimZipLockoutHours * 3600;

    this.db
      .prepare(
        `
        UPDATE claim_rate_limits
        SET lockout_until = ?
        WHERE order_uid = ? AND action = 'zip_verify'
      `
      )
      .run(lockoutUntil, orderUid);

    this.logClaimEvent(orderUid, "zip_locked_out", { lockoutUntil });
    this.logger.warn({ orderUid, lockoutUntil }, "ZIP verification locked out");
  }

  /**
   * Log a claim event for audit trail.
   */
  logClaimEvent(orderUid: string, eventType: string, metadata: Record<string, unknown>): void {
    this.db
      .prepare(
        `
        INSERT INTO claim_events (order_uid, event_type, metadata)
        VALUES (?, ?, ?)
      `
      )
      .run(orderUid, eventType, JSON.stringify(metadata));
  }

  /**
   * Clean up expired tokens for an order (housekeeping).
   */
  private cleanupExpiredTokens(orderUid: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare("DELETE FROM claim_tokens WHERE order_uid = ? AND expires_at < ? AND used_at IS NULL")
      .run(orderUid, now);
  }
}

/**
 * Factory function to create ClaimService instance.
 */
export function createClaimService(db: Database, logger: Logger): ClaimService {
  return new ClaimService(db, logger);
}
