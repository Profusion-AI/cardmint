/**
 * Welcome Coupon Service (Jan 2026)
 *
 * Generates unique 10% off codes for new email subscribers.
 * Codes are Stripe Promotion Codes linked to a master coupon.
 *
 * Features:
 * - Generate unique WELCOME-{8-char} codes per subscriber
 * - Idempotent: reuses existing code if subscriber re-subscribes
 * - Single-use enforcement via Stripe Promotion Code settings
 * - 30-day expiration (configurable via WELCOME_CODE_TTL_DAYS)
 * - Validation for checkout with discount calculation
 * - Redemption tracking in local DB
 */

import { randomBytes } from "crypto";
import Stripe from "stripe";
import type { Database } from "better-sqlite3";
import type { Logger } from "pino";
import { runtimeConfig } from "../config";

/** Code prefix for easy identification */
const CODE_PREFIX = "WELCOME-";
const DISCOUNT_PERCENT = 10;

/** Validation failure reasons */
export type WelcomeCodeInvalidReason =
  | "NOT_FOUND"
  | "ALREADY_REDEEMED"
  | "EXPIRED"
  | "STRIPE_ERROR";

/** Successful validation result */
export interface WelcomeCodeValidResult {
  valid: true;
  code: string;
  discount_pct: number;
  discount_cents: number;
  /** Stripe Promotion Code ID - use this in Checkout Session discounts */
  stripe_promo_code_id: string;
}

/** Failed validation result */
export interface WelcomeCodeInvalidResult {
  valid: false;
  reason: WelcomeCodeInvalidReason;
  message: string;
}

export type WelcomeCodeValidationResult = WelcomeCodeValidResult | WelcomeCodeInvalidResult;

/** Database row type */
interface WelcomeCouponRow {
  id: number;
  email: string;
  stripe_promo_code_id: string;
  code: string;
  created_at: number;
  expires_at: number | null;
  redeemed_at: number | null;
  stripe_session_id: string | null;
}

export class WelcomeCouponService {
  private stripe: Stripe | null = null;
  private masterCouponId: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger
  ) {
    if (runtimeConfig.stripeSecretKey) {
      this.stripe = new Stripe(runtimeConfig.stripeSecretKey);
    }

    this.masterCouponId = runtimeConfig.stripeWelcomeCouponId || null;
  }

  /**
   * Check if the welcome coupon service is enabled and configured
   */
  isEnabled(): boolean {
    return (
      runtimeConfig.welcomeCodeEnabled &&
      !!this.stripe &&
      !!this.masterCouponId
    );
  }

  /**
   * Check if a code looks like a welcome code (starts with WELCOME-)
   */
  isWelcomeCode(code: string): boolean {
    return code.toUpperCase().startsWith(CODE_PREFIX);
  }

  /**
   * Get existing welcome code for an email (idempotency)
   */
  getCodeForEmail(email: string): string | null {
    const normalizedEmail = email.toLowerCase().trim();

    const row = this.db
      .prepare("SELECT code FROM welcome_coupons WHERE email = ? LIMIT 1")
      .get(normalizedEmail) as { code: string } | undefined;

    return row?.code ?? null;
  }

  /**
   * Generate a unique welcome code for a new subscriber
   * Returns existing code if subscriber already has one (idempotent)
   * Uses crypto-safe randomness with collision retry
   */
  async generateCode(email: string, source: string): Promise<{ code: string; expiresAt: number } | null> {
    if (!this.isEnabled()) {
      this.logger.debug("Welcome coupon service not enabled, skipping code generation");
      return null;
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check for existing code (idempotency)
    const existingRow = this.db
      .prepare("SELECT code, expires_at FROM welcome_coupons WHERE email = ? LIMIT 1")
      .get(normalizedEmail) as { code: string; expires_at: number | null } | undefined;

    if (existingRow) {
      this.logger.debug(
        { email: normalizedEmail.slice(0, 3) + "***", code: existingRow.code },
        "Reusing existing welcome code"
      );
      return { code: existingRow.code, expiresAt: existingRow.expires_at ?? 0 };
    }

    // Calculate expiration
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = runtimeConfig.welcomeCodeTtlDays * 24 * 60 * 60;
    const expiresAt = now + ttlSeconds;
    const expiresAtDate = new Date(expiresAt * 1000);

    // Retry loop for collision handling (crypto-safe generation)
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Generate unique code suffix (8 alphanumeric chars, crypto-safe)
        const suffix = this.generateCodeSuffix();
        const code = `${CODE_PREFIX}${suffix}`;

        // Create Stripe Promotion Code first (Stripe enforces uniqueness)
        const promoCode = await this.stripe!.promotionCodes.create({
          coupon: this.masterCouponId!,
          code,
          max_redemptions: 1, // Single use
          expires_at: expiresAt,
          metadata: {
            email: normalizedEmail,
            source,
            purpose: "welcome_discount",
            created_at: new Date().toISOString(),
          },
        });

        // Store in local DB (with UNIQUE constraint on code)
        try {
          this.db
            .prepare(
              `INSERT INTO welcome_coupons (email, stripe_promo_code_id, code, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(normalizedEmail, promoCode.id, code, now, expiresAt);
        } catch (dbError: unknown) {
          // If DB insert fails (e.g., concurrent insert for same email), check if code now exists
          const errMsg = dbError instanceof Error ? dbError.message : String(dbError);
          if (errMsg.includes("UNIQUE constraint failed")) {
            // Concurrent insert - return the existing code
            const existingCode = this.getCodeForEmail(normalizedEmail);
            if (existingCode) {
              this.logger.debug(
                { email: normalizedEmail.slice(0, 3) + "***", code: existingCode },
                "Returning code created by concurrent request"
              );
              return { code: existingCode, expiresAt };
            }
          }
          throw dbError;
        }

        this.logger.info(
          {
            email: normalizedEmail.slice(0, 3) + "***",
            code,
            expiresAt: expiresAtDate.toISOString(),
            source,
            attempt,
          },
          "Generated welcome code"
        );

        return { code, expiresAt };
      } catch (error: unknown) {
        // Check if Stripe rejected due to code collision
        const isCodeCollision =
          error instanceof Stripe.errors.StripeInvalidRequestError &&
          error.message.includes("already exists");

        if (isCodeCollision && attempt < MAX_RETRIES - 1) {
          this.logger.warn(
            { attempt, email: normalizedEmail.slice(0, 3) + "***" },
            "Welcome code collision, retrying with new code"
          );
          continue;
        }

        this.logger.error(
          { error, email: normalizedEmail.slice(0, 3) + "***", attempt },
          "Failed to generate welcome code"
        );
        return null;
      }
    }

    this.logger.error(
      { email: normalizedEmail.slice(0, 3) + "***", maxRetries: MAX_RETRIES },
      "Failed to generate unique welcome code after max retries"
    );
    return null;
  }

  /**
   * Validate a welcome code for checkout
   * Gated on WELCOME_CODE_ENABLED for clean feature rollback
   */
  async validateCode(
    code: string,
    subtotalCents: number
  ): Promise<WelcomeCodeValidationResult> {
    // Feature flag gate: allow clean rollback
    if (!runtimeConfig.welcomeCodeEnabled) {
      return {
        valid: false,
        reason: "NOT_FOUND",
        message: "Welcome codes are not currently accepted",
      };
    }

    const normalizedCode = code.toUpperCase().trim();

    if (!this.isWelcomeCode(normalizedCode)) {
      return {
        valid: false,
        reason: "NOT_FOUND",
        message: "Invalid welcome code format",
      };
    }

    // Check local DB first
    const row = this.db
      .prepare("SELECT * FROM welcome_coupons WHERE code = ? LIMIT 1")
      .get(normalizedCode) as WelcomeCouponRow | undefined;

    if (!row) {
      return {
        valid: false,
        reason: "NOT_FOUND",
        message: "Welcome code not found",
      };
    }

    // Check if already redeemed locally
    if (row.redeemed_at) {
      return {
        valid: false,
        reason: "ALREADY_REDEEMED",
        message: "This welcome code has already been used",
      };
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (row.expires_at && row.expires_at < now) {
      return {
        valid: false,
        reason: "EXPIRED",
        message: "This welcome code has expired",
      };
    }

    // Verify with Stripe (check times_redeemed, not just active status)
    if (this.stripe) {
      try {
        const promoCode = await this.stripe.promotionCodes.retrieve(row.stripe_promo_code_id);

        // Check if redeemed via Stripe's times_redeemed (authoritative)
        // max_redemptions is 1 for welcome codes, so times_redeemed >= 1 means used
        const maxRedemptions = promoCode.max_redemptions ?? Infinity;
        if (promoCode.times_redeemed >= maxRedemptions) {
          // Sync local DB state if Stripe says it's redeemed
          this.db
            .prepare("UPDATE welcome_coupons SET redeemed_at = ? WHERE code = ? AND redeemed_at IS NULL")
            .run(now, normalizedCode);

          return {
            valid: false,
            reason: "ALREADY_REDEEMED",
            message: "This welcome code has already been used",
          };
        }

        // Also check if deactivated (admin disabled)
        if (!promoCode.active) {
          return {
            valid: false,
            reason: "EXPIRED",
            message: "This welcome code is no longer valid",
          };
        }
      } catch (error) {
        // Stripe verification failed - log and return error (fail-closed for safety)
        this.logger.error(
          { error, code: normalizedCode },
          "Failed to verify welcome code with Stripe"
        );
        return {
          valid: false,
          reason: "STRIPE_ERROR",
          message: "Unable to verify welcome code. Please try again.",
        };
      }
    }

    // Calculate discount
    const discountCents = Math.floor((subtotalCents * DISCOUNT_PERCENT) / 100);

    this.logger.info(
      {
        code: normalizedCode,
        subtotalCents,
        discountCents,
        discountPct: DISCOUNT_PERCENT,
      },
      "Welcome code validated"
    );

    return {
      valid: true,
      code: normalizedCode,
      discount_pct: DISCOUNT_PERCENT,
      discount_cents: discountCents,
      stripe_promo_code_id: row.stripe_promo_code_id,
    };
  }

  /**
   * Mark a welcome code as redeemed after successful payment
   * NOTE: No feature flag gate - webhook should always record redemption
   * even if feature is disabled (prevents reuse on re-enable)
   */
  markRedeemed(code: string, stripeSessionId: string): boolean {
    const normalizedCode = code.toUpperCase().trim();
    const now = Math.floor(Date.now() / 1000);

    const result = this.db
      .prepare(
        `UPDATE welcome_coupons
         SET redeemed_at = ?, stripe_session_id = ?
         WHERE code = ? AND redeemed_at IS NULL`
      )
      .run(now, stripeSessionId, normalizedCode);

    if (result.changes > 0) {
      this.logger.info(
        { code: normalizedCode, stripeSessionId },
        "Welcome code marked as redeemed"
      );
      return true;
    }

    this.logger.warn(
      { code: normalizedCode, stripeSessionId },
      "Failed to mark welcome code as redeemed (may already be redeemed)"
    );
    return false;
  }

  /**
   * Get welcome code details by code
   */
  getCodeDetails(code: string): WelcomeCouponRow | null {
    const normalizedCode = code.toUpperCase().trim();
    const row = this.db
      .prepare("SELECT * FROM welcome_coupons WHERE code = ? LIMIT 1")
      .get(normalizedCode) as WelcomeCouponRow | undefined;

    return row ?? null;
  }

  /**
   * Get welcome code expiration date
   */
  getExpirationDate(code: string): Date | null {
    const details = this.getCodeDetails(code);
    if (!details?.expires_at) return null;
    return new Date(details.expires_at * 1000);
  }

  /**
   * Generate random 8-character alphanumeric suffix using crypto-safe randomness
   */
  private generateCodeSuffix(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Exclude ambiguous: 0,O,1,I
    const bytes = randomBytes(8);
    let suffix = "";
    for (let i = 0; i < 8; i++) {
      suffix += chars.charAt(bytes[i] % chars.length);
    }
    return suffix;
  }

  /**
   * Auto-create master coupon if not configured (with warning)
   * Called during service initialization if STRIPE_WELCOME_COUPON_ID is not set
   */
  async ensureMasterCoupon(): Promise<string | null> {
    if (this.masterCouponId) {
      return this.masterCouponId;
    }

    if (!this.stripe || !runtimeConfig.welcomeCodeEnabled) {
      return null;
    }

    this.logger.warn(
      "STRIPE_WELCOME_COUPON_ID not set - attempting to find or create master coupon"
    );

    try {
      // Search for existing coupon
      const coupons = await this.stripe.coupons.list({ limit: 100 });
      const existingCoupon = coupons.data.find(
        (c) => c.name === "CardMint Welcome 10% Off" && c.valid && c.percent_off === DISCOUNT_PERCENT
      );

      if (existingCoupon) {
        this.masterCouponId = existingCoupon.id;
        this.logger.info(
          { couponId: existingCoupon.id },
          "Found existing master welcome coupon"
        );
        return this.masterCouponId;
      }

      // Create new coupon
      const newCoupon = await this.stripe.coupons.create({
        name: "CardMint Welcome 10% Off",
        percent_off: DISCOUNT_PERCENT,
        duration: "once",
        metadata: {
          purpose: "welcome_discount",
          source: "auto_created",
          created_at: new Date().toISOString(),
        },
      });

      this.masterCouponId = newCoupon.id;
      this.logger.warn(
        { couponId: newCoupon.id },
        "Auto-created master welcome coupon - please set STRIPE_WELCOME_COUPON_ID in .env"
      );

      return this.masterCouponId;
    } catch (error) {
      this.logger.error(
        { error },
        "Failed to ensure master coupon exists"
      );
      return null;
    }
  }
}
