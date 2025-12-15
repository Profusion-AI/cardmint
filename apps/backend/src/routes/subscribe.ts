/**
 * Subscribe Routes (Email Collection)
 *
 * Interim mailing list collection (Dec 2025).
 * Stores emails in SQLite until Mailchimp/Klaviyo integration.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";

interface SubscribeBody {
  email?: string;
  source?: string;
}

export function registerSubscribeRoutes(app: Express, ctx: AppContext): void {
  const { db, logger } = ctx;

  /**
   * POST /api/subscribe
   *
   * Adds an email to the subscriber list.
   * Returns success even if email already exists (to avoid enumeration).
   */
  app.post("/api/subscribe", (req: Request, res: Response) => {
    const body = req.body as SubscribeBody;
    const email = body.email?.trim().toLowerCase();
    const source = body.source ?? "vault_landing";

    // Basic validation
    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "EMAIL_REQUIRED",
        message: "Email address is required",
      });
    }

    // Simple email format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_EMAIL",
        message: "Please enter a valid email address",
      });
    }

    try {
      // Get IP for rate limiting / spam detection (optional)
      const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
        || req.socket.remoteAddress
        || null;

      // Insert or ignore if already exists
      const stmt = db.prepare(`
        INSERT INTO email_subscribers (email, source, ip_address)
        VALUES (?, ?, ?)
        ON CONFLICT(email) DO NOTHING
      `);

      const result = stmt.run(email, source, ip);

      if (result.changes > 0) {
        logger.info({ email: email.substring(0, 3) + "***", source }, "subscribe.new");
      } else {
        logger.debug({ source }, "subscribe.duplicate");
      }

      // Always return success to avoid email enumeration
      res.json({
        ok: true,
        message: "You're on the list! Check your email for your welcome code.",
      });
    } catch (error) {
      logger.error({ error }, "subscribe.failed");
      res.status(500).json({
        ok: false,
        error: "INTERNAL_ERROR",
        message: "Something went wrong. Please try again.",
      });
    }
  });

  /**
   * GET /api/subscribe/count
   *
   * Returns subscriber count (for internal metrics only).
   * Could be protected in prod if needed.
   */
  app.get("/api/subscribe/count", (_req: Request, res: Response) => {
    try {
      const result = db.prepare(`
        SELECT COUNT(*) as total FROM email_subscribers WHERE unsubscribed_at IS NULL
      `).get() as { total: number };

      res.json({
        ok: true,
        count: result.total,
      });
    } catch (error) {
      logger.error({ error }, "subscribe.count.failed");
      res.status(500).json({
        ok: false,
        error: "INTERNAL_ERROR",
      });
    }
  });
}
