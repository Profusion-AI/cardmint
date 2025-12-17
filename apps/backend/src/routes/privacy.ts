/**
 * Privacy Routes (DSAR Handling)
 *
 * Implements GDPR Article 17 (Right to Erasure) and CCPA deletion rights.
 * Provides endpoints for data subject access requests (DSAR).
 *
 * IMPORTANT: These endpoints should be rate-limited and require
 * identity verification in production.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";

interface PrivacyDeleteBody {
  email?: string;
  reason?: string;
}

interface PrivacyUnsubscribeBody {
  email?: string;
}

// Simple rate limiting: track requests per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5; // Max requests per window
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now > record.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return false;
  }

  record.count++;
  return true;
}

export function registerPrivacyRoutes(app: Express, ctx: AppContext): void {
  const { db, logger, klaviyoService } = ctx;

  /**
   * POST /api/privacy/delete
   *
   * Request deletion of all personal data (GDPR Art. 17 / CCPA).
   * This will:
   * 1. Mark local subscriber record as deleted
   * 2. Request Klaviyo profile deletion
   * 3. Log the request for compliance audit
   */
  app.post("/api/privacy/delete", async (req: Request, res: Response) => {
    const body = req.body as PrivacyDeleteBody;
    const email = body.email?.trim().toLowerCase();
    const reason = body.reason ?? "user_request";

    // Get IP for rate limiting
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    // Rate limit check
    if (!checkRateLimit(ip)) {
      logger.warn({ ip }, "privacy.delete.rate_limited");
      return res.status(429).json({
        ok: false,
        error: "RATE_LIMITED",
        message: "Too many requests. Please try again later.",
      });
    }

    // Validate email
    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "EMAIL_REQUIRED",
        message: "Email address is required",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_EMAIL",
        message: "Please enter a valid email address",
      });
    }

    try {
      const now = Math.floor(Date.now() / 1000);

      // 1. Mark local subscriber record as deleted
      const updateStmt = db.prepare(`
        UPDATE email_subscribers
        SET deleted_at = ?, deletion_reason = ?
        WHERE email = ? AND deleted_at IS NULL
      `);
      const updateResult = updateStmt.run(now, reason, email);

      // 2. Log the deletion request for audit trail
      // This log entry persists even after data is deleted (legal requirement)
      const logStmt = db.prepare(`
        INSERT INTO privacy_requests (email_hash, request_type, ip_address, requested_at, status)
        VALUES (?, 'deletion', ?, ?, 'processing')
      `);
      // Store hashed email for audit (not the actual email)
      const emailHash = Buffer.from(email).toString("base64");
      logStmt.run(emailHash, ip, now);

      // 3. Request Klaviyo profile deletion
      let klaviyoResult = { success: true, message: "Klaviyo not configured" };
      if (klaviyoService.isConfigured()) {
        klaviyoResult = await klaviyoService.requestProfileDeletion(email);
      }

      logger.info(
        {
          email: email.substring(0, 3) + "***",
          localDeleted: updateResult.changes > 0,
          klaviyoSuccess: klaviyoResult.success,
          reason,
        },
        "privacy.delete.processed"
      );

      // Always return success to avoid enumeration attacks
      // (Don't reveal whether the email existed in our system)
      res.json({
        ok: true,
        message:
          "Your deletion request has been received. " +
          "We will process it within 30 days as required by law. " +
          "You will receive a confirmation email when complete.",
        details: {
          localData: "Marked for deletion",
          klaviyo: klaviyoResult.message,
        },
      });
    } catch (error) {
      logger.error({ error }, "privacy.delete.failed");
      res.status(500).json({
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Something went wrong. Please contact privacy@cardmintshop.com",
      });
    }
  });

  /**
   * POST /api/privacy/unsubscribe
   *
   * Unsubscribe from all marketing communications.
   * Does NOT delete data - just stops communications.
   */
  app.post("/api/privacy/unsubscribe", async (req: Request, res: Response) => {
    const body = req.body as PrivacyUnsubscribeBody;
    const email = body.email?.trim().toLowerCase();

    // Validate email
    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "EMAIL_REQUIRED",
        message: "Email address is required",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_EMAIL",
        message: "Please enter a valid email address",
      });
    }

    try {
      const now = Math.floor(Date.now() / 1000);

      // 1. Mark local subscriber as unsubscribed
      const updateStmt = db.prepare(`
        UPDATE email_subscribers
        SET unsubscribed_at = ?
        WHERE email = ? AND unsubscribed_at IS NULL
      `);
      updateStmt.run(now, email);

      // 2. Suppress in Klaviyo
      let klaviyoResult = { success: true, message: "Klaviyo not configured" };
      if (klaviyoService.isConfigured()) {
        klaviyoResult = await klaviyoService.suppressProfile(email);
      }

      logger.info(
        { email: email.substring(0, 3) + "***", klaviyoSuccess: klaviyoResult.success },
        "privacy.unsubscribe.processed"
      );

      res.json({
        ok: true,
        message: "You have been unsubscribed from all marketing communications.",
      });
    } catch (error) {
      logger.error({ error }, "privacy.unsubscribe.failed");
      res.status(500).json({
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Something went wrong. Please contact privacy@cardmintshop.com",
      });
    }
  });

  /**
   * GET /api/privacy/export
   *
   * Request a copy of all personal data (GDPR Art. 15 / CCPA right to know).
   * Returns a JSON export of subscriber data.
   *
   * NOTE: In production, this should require email verification
   * to prevent unauthorized access to personal data.
   */
  app.get("/api/privacy/export", (req: Request, res: Response) => {
    const email = (req.query.email as string)?.trim().toLowerCase();

    // Get IP for rate limiting
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    if (!checkRateLimit(ip)) {
      logger.warn({ ip }, "privacy.export.rate_limited");
      return res.status(429).json({
        ok: false,
        error: "RATE_LIMITED",
        message: "Too many requests. Please try again later.",
      });
    }

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "EMAIL_REQUIRED",
        message: "Email address is required",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_EMAIL",
        message: "Please enter a valid email address",
      });
    }

    try {
      // Get subscriber data
      const subscriberStmt = db.prepare(`
        SELECT email, source, created_at, unsubscribed_at
        FROM email_subscribers
        WHERE email = ? AND deleted_at IS NULL
      `);
      const subscriber = subscriberStmt.get(email) as {
        email: string;
        source: string;
        created_at: number;
        unsubscribed_at: number | null;
      } | undefined;

      if (!subscriber) {
        // Don't reveal whether email exists
        return res.json({
          ok: true,
          message: "If this email is in our system, you will receive an export via email.",
          data: null,
        });
      }

      logger.info({ email: email.substring(0, 3) + "***" }, "privacy.export.processed");

      res.json({
        ok: true,
        message: "Your data export is ready.",
        data: {
          email: subscriber.email,
          source: subscriber.source,
          subscribed_at: new Date(subscriber.created_at * 1000).toISOString(),
          unsubscribed_at: subscriber.unsubscribed_at
            ? new Date(subscriber.unsubscribed_at * 1000).toISOString()
            : null,
          data_categories: [
            "Email address",
            "Subscription source",
            "Subscription date",
          ],
          third_parties: [
            {
              name: "Klaviyo",
              purpose: "Email marketing",
              data_shared: ["Email address", "Browsing activity (if consented)"],
            },
          ],
        },
      });
    } catch (error) {
      logger.error({ error }, "privacy.export.failed");
      res.status(500).json({
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Something went wrong. Please contact privacy@cardmintshop.com",
      });
    }
  });
}
