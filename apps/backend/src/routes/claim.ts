/**
 * Claim Order Routes (P1.3)
 *
 * Handles order claim flow via email link:
 * - /api/claim/initiate - Start claim, send email
 * - /api/claim/complete - Complete claim with token
 * - /api/claim/zip-fallback - ZIP verification fallback (requires Turnstile)
 *
 * CRITICAL SECURITY REQUIREMENTS:
 * - Non-revealing errors: NEVER reveal order existence, email address, or specific failure reason
 * - Rate limiting: prevent enumeration and email spam
 * - Single-use tokens: 30-min TTL, consumed on use
 *
 * Kill-switch: Set CLAIM_ORDER_ENABLED=false to disable all endpoints.
 *
 * @see RFC-community-growth.md, phase1-diff-checklist.md for requirements
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { runtimeConfig } from "../config";
import { ClaimService, CLAIM_ERROR_MESSAGE } from "../services/claimService";
import { type ClaimEmailData } from "../services/resendService";
import {
  type AuthenticatedRequest,
  optionalWorkOSAuth,
} from "../middleware/workosAuth";
import { csrfProtection } from "../middleware/csrfProtection";
import { checkIpRateLimit, startIpRateLimitCleanup } from "../middleware/ipRateLimiter";

/**
 * Validate Cloudflare Turnstile token (for ZIP fallback)
 */
async function validateTurnstile(token: string): Promise<boolean> {
  if (!runtimeConfig.turnstileSecretKey) {
    return false;
  }

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: runtimeConfig.turnstileSecretKey,
        response: token,
      }),
    });

    const data = await response.json() as { success: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

export function registerClaimRoutes(app: Express, ctx: AppContext): void {
  const log = ctx.logger.child({ module: "claim-routes" });
  const claimService = new ClaimService(ctx.db, ctx.logger);
  const { resendService, stripeService } = ctx;

  // Start IP rate limit cleanup (prevents memory bloat)
  startIpRateLimitCleanup();

  /**
   * GET /api/claim/status
   * Check if claim feature is enabled.
   * Public endpoint - no auth required.
   */
  app.get("/api/claim/status", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      enabled: runtimeConfig.claimOrderEnabled,
      turnstileConfigured: !!runtimeConfig.turnstileSiteKey,
      turnstileSiteKey: runtimeConfig.turnstileSiteKey || undefined,
    });
  });

  /**
   * POST /api/claim/initiate
   * Start a claim by sending email link to order's email address.
   *
   * Body: { orderNumber: "CM-20260113-000001" }
   *
   * CRITICAL: Always returns same error message regardless of actual failure reason.
   * This prevents order enumeration attacks.
   */
  app.post("/api/claim/initiate", async (req: Request, res: Response) => {
    // Kill-switch check
    if (!runtimeConfig.claimOrderEnabled) {
      return res.status(503).json({
        ok: false,
        error: "CLAIM_DISABLED",
        message: "Order claiming is currently disabled",
      });
    }

    // IP rate limit (prevents enumeration via timing - 10 req/min per IP)
    const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
    if (!checkIpRateLimit(clientIp, "claim/initiate", 10, 60)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_REQUEST",
        message: CLAIM_ERROR_MESSAGE,
      });
    }

    const { orderNumber } = req.body as { orderNumber?: string };

    // Basic validation (non-revealing)
    if (!orderNumber || typeof orderNumber !== "string" || orderNumber.length < 5) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_REQUEST",
        message: CLAIM_ERROR_MESSAGE,
      });
    }

    // Only support CardMint orders (CM-*), not marketplace orders (TCG-*/EBAY-*)
    const normalized = orderNumber.trim().toUpperCase();
    if (!normalized.startsWith("CM-")) {
      log.debug({ orderNumber: normalized }, "Claim attempted for non-CardMint order");
      return res.status(400).json({
        ok: false,
        error: "INVALID_REQUEST",
        message: CLAIM_ERROR_MESSAGE,
      });
    }

    // NON-REVEALING RESPONSE: For any syntactically valid CM-* order, always return
    // 200 OK with the same generic message. This prevents order-existence oracles.
    const successResponse = {
      ok: true,
      message: "If this order exists, a claim link has been sent to the associated email address.",
    };

    try {
      // Generate token (handles rate limiting internally)
      const tokenResult = await claimService.generateToken(normalized);

      if (!tokenResult.success) {
        // Rate limited or order not found - return 200 with generic message (non-revealing)
        log.debug({ orderNumber: normalized, rateLimited: tokenResult.rateLimited }, "Claim initiate: token generation failed");
        return res.json(successResponse);
      }

      // Look up order to get stripe_session_id
      const orderInfo = claimService.getOrderByNumber(normalized);
      if (!orderInfo) {
        // Should not happen since generateToken succeeded, but handle gracefully
        log.error({ orderNumber: normalized }, "Order disappeared after token generation");
        return res.json(successResponse);
      }

      // Fetch customer email from Stripe (no PII in our DB)
      let customerEmail: string;
      try {
        const session = await stripeService.getCheckoutSession(orderInfo.stripeSessionId);
        const email = session?.customer_details?.email;
        if (!email) {
          throw new Error("No email in Stripe session");
        }
        customerEmail = email;
      } catch (err) {
        log.error({ err, orderNumber: normalized }, "Failed to fetch email from Stripe");
        // Return 200 with generic message (non-revealing)
        return res.json(successResponse);
      }

      // Build claim URL (use PUBLIC_BASE_URL if configured, otherwise fall back to defaults)
      const baseUrl = runtimeConfig.publicBaseUrl
        ?? (runtimeConfig.cardmintEnv === "production"
          ? "https://cardmintshop.com"
          : `http://localhost:${runtimeConfig.port}`);
      const claimUrl = `${baseUrl}/claim#token=${encodeURIComponent(tokenResult.token!)}`;

      // Build and send claim email
      const emailData: ClaimEmailData = {
        orderNumber: normalized,
        claimUrl,
        expiresInMinutes: runtimeConfig.claimTokenTtlMinutes,
      };

      const emailContent = resendService.buildClaimEmail(emailData);
      const sendResult = await resendService.sendEmail({
        to: customerEmail,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
        tags: [
          { name: "email_type", value: "claim" },
          { name: "order_number", value: normalized },
        ],
      });

      if (!sendResult.success) {
        log.error({ err: sendResult.error, orderNumber: normalized }, "Failed to send claim email");
        // Return 200 with generic message (non-revealing)
        return res.json(successResponse);
      }

      // Log success (no PII - email domain removed to avoid long-lived PII in logs/DB)
      claimService.logClaimEvent(orderInfo.orderUid, "email_sent", {
        tokenId: tokenResult.tokenId,
      });

      log.info(
        {
          orderNumber: normalized,
          tokenId: tokenResult.tokenId,
        },
        "Claim email sent"
      );

      // Return same 200 response as all other paths (non-revealing)
      res.json(successResponse);
    } catch (err) {
      log.error({ err, orderNumber: normalized }, "Claim initiation failed");
      // Return 200 with generic message (non-revealing)
      res.json(successResponse);
    }
  });

  /**
   * POST /api/claim/complete
   * Complete claim using token from email link.
   * Links order to authenticated user's identity if logged in.
   *
   * Body: { token: "..." }
   */
  app.post(
    "/api/claim/complete",
    optionalWorkOSAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      // Kill-switch check
      if (!runtimeConfig.claimOrderEnabled) {
        return res.status(503).json({
          ok: false,
          error: "CLAIM_DISABLED",
          message: "Order claiming is currently disabled",
        });
      }

      const { token } = req.body as { token?: string };

      if (!token || typeof token !== "string") {
        return res.status(400).json({
          ok: false,
          error: "INVALID_TOKEN",
          message: CLAIM_ERROR_MESSAGE,
        });
      }

      try {
        // Complete claim (validates + consumes token atomically)
        const identityId = req.workosUser?.userId;
        const result = claimService.completeClaimWithToken(token, identityId);

        if (!result.success) {
          // Token invalid, expired, or already used
          const statusCode = result.expired ? 410 : 400;
          return res.status(statusCode).json({
            ok: false,
            error: result.expired ? "TOKEN_EXPIRED" : "INVALID_TOKEN",
            message: CLAIM_ERROR_MESSAGE,
          });
        }

        log.info(
          {
            orderNumber: result.orderNumber,
            hasIdentity: !!identityId,
          },
          "Claim completed successfully"
        );

        res.json({
          ok: true,
          orderNumber: result.orderNumber,
          linked: !!identityId,
          message: identityId
            ? "Order claimed and linked to your account."
            : "Order claimed. Sign in to link it to your account.",
        });
      } catch (err) {
        log.error({ err }, "Claim completion failed");
        res.status(400).json({
          ok: false,
          error: "INVALID_TOKEN",
          message: CLAIM_ERROR_MESSAGE,
        });
      }
    }
  );

  /**
   * POST /api/claim/zip-fallback
   * Alternative claim method using ZIP verification.
   * Requires: valid Turnstile token + matching ZIP code.
   *
   * Body: { orderNumber: "...", zip: "...", turnstileToken: "..." }
   *
   * Rate limited: 3 attempts/hr, lockout after 3 failures in 24h.
   */
  app.post(
    "/api/claim/zip-fallback",
    optionalWorkOSAuth,
    csrfProtection,
    async (req: AuthenticatedRequest, res: Response) => {
      // Kill-switch check
      if (!runtimeConfig.claimOrderEnabled) {
        return res.status(503).json({
          ok: false,
          error: "CLAIM_DISABLED",
          message: "Order claiming is currently disabled",
        });
      }

      // Turnstile required for ZIP fallback
      if (!runtimeConfig.turnstileSecretKey) {
        return res.status(503).json({
          ok: false,
          error: "TURNSTILE_NOT_CONFIGURED",
          message: "ZIP verification is not available",
        });
      }

      // IP rate limit (prevents enumeration via timing - 10 req/min per IP)
      const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
      if (!checkIpRateLimit(clientIp, "claim/zip-fallback", 10, 60)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_REQUEST",
          message: CLAIM_ERROR_MESSAGE,
        });
      }

      const { orderNumber, zip, turnstileToken } = req.body as {
        orderNumber?: string;
        zip?: string;
        turnstileToken?: string;
      };

      // Basic validation
      if (
        !orderNumber ||
        !zip ||
        !turnstileToken ||
        typeof orderNumber !== "string" ||
        typeof zip !== "string" ||
        typeof turnstileToken !== "string"
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_REQUEST",
          message: CLAIM_ERROR_MESSAGE,
        });
      }

      // Normalize
      const normalizedOrder = orderNumber.trim().toUpperCase();
      const normalizedZip = zip.trim().replace(/\D/g, "").slice(0, 5);

      if (!normalizedOrder.startsWith("CM-") || normalizedZip.length !== 5) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_REQUEST",
          message: CLAIM_ERROR_MESSAGE,
        });
      }

      try {
        // Validate Turnstile token first
        const turnstileValid = await validateTurnstile(turnstileToken);
        if (!turnstileValid) {
          return res.status(400).json({
            ok: false,
            error: "TURNSTILE_FAILED",
            message: "Verification failed. Please try again.",
          });
        }

        // Look up order
        const orderInfo = claimService.getOrderByNumber(normalizedOrder);
        if (!orderInfo) {
          // Don't reveal order doesn't exist
          return res.status(400).json({
            ok: false,
            error: "INVALID_REQUEST",
            message: CLAIM_ERROR_MESSAGE,
          });
        }

        // Check rate limit (returns same error shape whether locked out or rate limited - non-revealing)
        const rateStatus = claimService.checkRateLimit(orderInfo.orderUid, "zip_verify");
        if (!rateStatus.allowed) {
          return res.status(400).json({
            ok: false,
            error: "INVALID_REQUEST",
            message: CLAIM_ERROR_MESSAGE,
          });
        }

        // Fetch shipping ZIP from Stripe
        let actualZip: string | undefined;
        try {
          const session = await stripeService.getCheckoutSession(orderInfo.stripeSessionId);
          const address = session?.shipping_details?.address || session?.customer_details?.address;
          actualZip = address?.postal_code?.replace(/\D/g, "").slice(0, 5);
        } catch (err) {
          log.error({ err, orderNumber: normalizedOrder }, "Failed to fetch shipping info from Stripe");
          return res.status(400).json({
            ok: false,
            error: "INVALID_REQUEST",
            message: CLAIM_ERROR_MESSAGE,
          });
        }

        // Increment rate limit (count the attempt)
        claimService.incrementRateLimit(orderInfo.orderUid, "zip_verify");

        // Verify ZIP
        if (!actualZip || actualZip !== normalizedZip) {
          claimService.logClaimEvent(orderInfo.orderUid, "zip_failure", {
            attemptCount: rateStatus.hourlyCount + 1,
          });

          // Check if should trigger lockout (3 attempts in an hour triggers 24h lockout)
          if (rateStatus.hourlyCount + 1 >= 3) {
            claimService.triggerZipLockout(orderInfo.orderUid);
          }

          // Return same error shape as all other failures (non-revealing)
          return res.status(400).json({
            ok: false,
            error: "INVALID_REQUEST",
            message: CLAIM_ERROR_MESSAGE,
          });
        }

        // ZIP matches - generate single-use token and complete claim
        const tokenResult = await claimService.generateToken(normalizedOrder);
        if (!tokenResult.success || !tokenResult.token) {
          return res.status(400).json({
            ok: false,
            error: "INVALID_REQUEST",
            message: CLAIM_ERROR_MESSAGE,
          });
        }

        // Complete claim with the token
        const identityId = req.workosUser?.userId;
        const claimResult = claimService.completeClaimWithToken(tokenResult.token, identityId);

        if (!claimResult.success) {
          return res.status(400).json({
            ok: false,
            error: "CLAIM_FAILED",
            message: CLAIM_ERROR_MESSAGE,
          });
        }

        claimService.logClaimEvent(orderInfo.orderUid, "zip_success", {
          hasIdentity: !!identityId,
        });

        log.info(
          {
            orderNumber: normalizedOrder,
            hasIdentity: !!identityId,
          },
          "ZIP fallback claim completed"
        );

        res.json({
          ok: true,
          orderNumber: claimResult.orderNumber,
          linked: !!identityId,
          message: identityId
            ? "Order verified and linked to your account."
            : "Order verified. Sign in to link it to your account.",
        });
      } catch (err) {
        log.error({ err, orderNumber: normalizedOrder }, "ZIP fallback failed");
        res.status(400).json({
          ok: false,
          error: "INVALID_REQUEST",
          message: CLAIM_ERROR_MESSAGE,
        });
      }
    }
  );
}
