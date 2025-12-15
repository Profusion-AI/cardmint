/**
 * Webhook Routes
 * Receive callbacks from EverShop and other external systems
 * RFC-fullduplexDB_triple Phase 2 - Bidirectional Sync
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { runtimeConfig } from "../config";
import { SyncService } from "../services/sync/syncService";
import type {
  EverShopWebhookPayload,
  WebhookEventStatus,
  EverShopSyncState,
} from "../services/sync/types";

// Simple in-memory rate limiter
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function checkRateLimit(ip: string, maxRpm: number): boolean {
  const now = Date.now();
  const windowMs = 60_000; // 1 minute

  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > windowMs) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= maxRpm) {
    return false;
  }

  entry.count++;
  return true;
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  const windowMs = 60_000;
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > windowMs * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 120_000);

export function registerWebhookRoutes(app: Express, ctx: AppContext): void {
  const { logger, db } = ctx;

  // Lazy initialization of sync service
  let syncService: SyncService | null = null;
  const getSyncService = (): SyncService => {
    if (!syncService) {
      syncService = new SyncService(db, logger);
    }
    return syncService;
  };

  /**
   * Verify HMAC signature for webhook payload
   * Signature format: sha256=<hex_digest>
   * The digest is computed over the raw JSON body
   */
  function verifySignature(
    signature: string | undefined,
    body: string,
    secret: string
  ): boolean {
    if (!signature || !secret) {
      return false;
    }

    const [algo, receivedDigest] = signature.split("=");
    if (algo !== "sha256" || !receivedDigest) {
      return false;
    }

    const expectedDigest = createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    // Use timing-safe comparison to prevent timing attacks
    try {
      return timingSafeEqual(
        Buffer.from(receivedDigest, "hex"),
        Buffer.from(expectedDigest, "hex")
      );
    } catch {
      return false;
    }
  }

  /**
   * Log webhook event to database (even if processing fails)
   */
  function logWebhookEvent(
    eventUid: string,
    eventType: string,
    source: string,
    payload: unknown,
    productUid: string | null,
    status: WebhookEventStatus,
    errorMessage: string | null
  ): void {
    try {
      db.prepare(
        `INSERT INTO webhook_events
         (event_uid, event_type, source, payload, product_uid, status, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        eventUid,
        eventType,
        source,
        JSON.stringify(payload),
        productUid,
        status,
        errorMessage,
        Math.floor(Date.now() / 1000)
      );
    } catch (error) {
      logger.error(
        { error, eventUid },
        "Failed to log webhook event to database"
      );
    }
  }

  /**
   * Mark webhook event as processed
   */
  function markWebhookProcessed(
    eventUid: string,
    status: WebhookEventStatus,
    errorMessage: string | null = null
  ): void {
    try {
      db.prepare(
        `UPDATE webhook_events
         SET status = ?, processed_at = ?, error_message = COALESCE(?, error_message)
         WHERE event_uid = ?`
      ).run(status, Math.floor(Date.now() / 1000), errorMessage, eventUid);
    } catch (error) {
      logger.error({ error, eventUid }, "Failed to update webhook event status");
    }
  }

  // ==========================================================================
  // EverShop Product Webhook
  // ==========================================================================

  /**
   * POST /api/webhooks/evershop
   * Receive product update notifications from EverShop
   *
   * Features (per Codex QA):
   * - HMAC signature verification (sha256=<digest>)
   * - Rate limiting (configurable RPM)
   * - Stale event rejection (updated_at comparison)
   * - Full audit logging (even for failures)
   * - Idempotent state transitions
   * - Async vault sync (enqueues to daemon)
   */
  app.post(
    "/api/webhooks/evershop",
    async (req: Request, res: Response): Promise<void> => {
      const eventUid = randomUUID();
      const clientIp = req.ip || req.socket.remoteAddress || "unknown";

      // Feature flag check
      if (!runtimeConfig.evershopWebhookEnabled) {
        logger.debug("EverShop webhook received but feature is disabled");
        res.status(503).json({
          error: "WEBHOOK_DISABLED",
          message: "EverShop webhook receiver is not enabled",
        });
        return;
      }

      // Rate limiting
      if (!checkRateLimit(clientIp, runtimeConfig.evershopWebhookRateLimitRpm)) {
        logger.warn({ ip: clientIp }, "EverShop webhook rate limit exceeded");
        logWebhookEvent(
          eventUid,
          "evershop_product_updated",
          "evershop",
          req.body,
          null,
          "failed",
          "Rate limit exceeded"
        );
        res.status(429).json({
          error: "RATE_LIMIT_EXCEEDED",
          message: `Max ${runtimeConfig.evershopWebhookRateLimitRpm} requests per minute`,
        });
        return;
      }

      // Get raw body for signature verification
      // With express.raw() middleware, req.body is a Buffer - convert to UTF-8 string
      let rawBody: string;
      if (Buffer.isBuffer(req.body)) {
        rawBody = req.body.toString("utf8");
      } else if (typeof req.body === "string") {
        rawBody = req.body;
      } else {
        // Fallback for already-parsed JSON (shouldn't happen with raw middleware)
        rawBody = JSON.stringify(req.body);
      }

      // Verify signature
      const signature = req.headers["x-cardmint-signature"] as string | undefined;
      if (!verifySignature(signature, rawBody, runtimeConfig.evershopWebhookSecret)) {
        logger.warn(
          { ip: clientIp, hasSignature: !!signature },
          "EverShop webhook signature verification failed"
        );
        logWebhookEvent(
          eventUid,
          "evershop_product_updated",
          "evershop",
          rawBody,
          null,
          "failed",
          "Invalid signature"
        );
        res.status(401).json({
          error: "INVALID_SIGNATURE",
          message: "Webhook signature verification failed",
        });
        return;
      }

      // Parse payload from raw body string
      let payload: EverShopWebhookPayload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        logger.warn("EverShop webhook received invalid JSON");
        logWebhookEvent(
          eventUid,
          "evershop_product_updated",
          "evershop",
          rawBody,
          null,
          "failed",
          "Invalid JSON payload"
        );
        res.status(400).json({
          error: "INVALID_PAYLOAD",
          message: "Request body must be valid JSON",
        });
        return;
      }

      // Validate required fields
      if (!payload.uuid || !payload.sku || typeof payload.visibility !== "boolean") {
        logger.warn({ payload }, "EverShop webhook missing required fields");
        logWebhookEvent(
          eventUid,
          "evershop_product_updated",
          "evershop",
          payload,
          null,
          "failed",
          "Missing required fields: uuid, sku, visibility"
        );
        res.status(400).json({
          error: "MISSING_FIELDS",
          message: "Required fields: uuid, sku, visibility",
        });
        return;
      }

      // Stale event check
      if (payload.updated_at) {
        const eventTime = new Date(payload.updated_at).getTime();
        const now = Date.now();
        const staleThresholdMs =
          runtimeConfig.evershopWebhookStaleThresholdSec * 1000;

        if (now - eventTime > staleThresholdMs) {
          logger.info(
            {
              eventUid,
              eventTime: payload.updated_at,
              age_seconds: Math.floor((now - eventTime) / 1000),
            },
            "Rejecting stale EverShop webhook event"
          );
          logWebhookEvent(
            eventUid,
            "evershop_product_updated",
            "evershop",
            payload,
            null,
            "skipped",
            `Event too old: ${Math.floor((now - eventTime) / 1000)}s > ${runtimeConfig.evershopWebhookStaleThresholdSec}s threshold`
          );
          res.status(200).json({
            ok: true,
            event_uid: eventUid,
            status: "skipped",
            reason: "stale_event",
          });
          return;
        }
      }

      // Log the webhook event (pending status)
      logWebhookEvent(
        eventUid,
        "evershop_product_updated",
        "evershop",
        payload,
        null, // product_uid resolved during processing
        "pending",
        null
      );

      // Process the webhook via SyncService
      try {
        const result = await getSyncService().handleEverShopWebhook(
          eventUid,
          payload
        );

        // Update event with product_uid if found
        if (result.product_uid) {
          db.prepare(
            `UPDATE webhook_events SET product_uid = ? WHERE event_uid = ?`
          ).run(result.product_uid, eventUid);
        }

        if (result.success) {
          markWebhookProcessed(eventUid, "processed");
          logger.info(
            {
              eventUid,
              productUid: result.product_uid,
              previousState: result.previous_state,
              newState: result.new_state,
              stateChanged: result.state_changed,
              vaultSyncEnqueued: result.vault_sync_enqueued,
            },
            "EverShop webhook processed successfully"
          );

          res.status(200).json({
            ok: true,
            event_uid: eventUid,
            product_uid: result.product_uid,
            previous_state: result.previous_state,
            new_state: result.new_state,
            state_changed: result.state_changed,
            vault_sync_enqueued: result.vault_sync_enqueued,
          });
        } else {
          markWebhookProcessed(eventUid, "failed", result.error);
          logger.warn(
            { eventUid, error: result.error },
            "EverShop webhook processing failed"
          );

          res.status(200).json({
            ok: false,
            event_uid: eventUid,
            error: result.error,
          });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        markWebhookProcessed(eventUid, "failed", errorMsg);
        logger.error(
          { error: errorMsg, eventUid },
          "EverShop webhook handler threw exception"
        );

        res.status(500).json({
          ok: false,
          event_uid: eventUid,
          error: "INTERNAL_ERROR",
          message: errorMsg,
        });
      }
    }
  );

  // ==========================================================================
  // Webhook Health & Stats
  // ==========================================================================

  /**
   * GET /api/webhooks/health
   * Get webhook queue health stats
   */
  app.get("/api/webhooks/health", (_req: Request, res: Response) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const oneHourAgo = now - 3600;

      // Pending count
      const pendingCount = (
        db
          .prepare(
            `SELECT COUNT(*) as count FROM webhook_events WHERE status = 'pending'`
          )
          .get() as { count: number }
      ).count;

      // Processed last hour
      const processedLastHour = (
        db
          .prepare(
            `SELECT COUNT(*) as count FROM webhook_events
             WHERE status = 'processed' AND processed_at >= ?`
          )
          .get(oneHourAgo) as { count: number }
      ).count;

      // Failed last hour
      const failedLastHour = (
        db
          .prepare(
            `SELECT COUNT(*) as count FROM webhook_events
             WHERE status = 'failed' AND created_at >= ?`
          )
          .get(oneHourAgo) as { count: number }
      ).count;

      // Oldest pending age
      const oldestPending = db
        .prepare(
          `SELECT created_at FROM webhook_events
           WHERE status = 'pending'
           ORDER BY created_at ASC LIMIT 1`
        )
        .get() as { created_at: number } | undefined;

      const oldestPendingAgeSeconds = oldestPending
        ? now - oldestPending.created_at
        : null;

      // Webhook-driven state transitions last hour (count sync_events triggered by webhooks)
      // Sync events from webhooks use operator_id = 'evershop_webhook' (see syncService.ts)
      const webhookTransitionsLastHour = (
        db
          .prepare(
            `SELECT COUNT(*) as count FROM sync_events
             WHERE created_at >= ? AND operator_id = 'evershop_webhook'`
          )
          .get(oneHourAgo) as { count: number }
      ).count;

      res.json({
        ok: true,
        pending_count: pendingCount,
        processed_last_hour: processedLastHour,
        failed_last_hour: failedLastHour,
        oldest_pending_age_seconds: oldestPendingAgeSeconds,
        webhook_driven_transitions_last_hour: webhookTransitionsLastHour,
        config: {
          enabled: runtimeConfig.evershopWebhookEnabled,
          rate_limit_rpm: runtimeConfig.evershopWebhookRateLimitRpm,
          stale_threshold_sec: runtimeConfig.evershopWebhookStaleThresholdSec,
          cleanup_days: runtimeConfig.evershopWebhookCleanupDays,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Webhook health check failed");
      res.status(500).json({
        ok: false,
        error: "HEALTH_CHECK_FAILED",
        message,
      });
    }
  });

  /**
   * POST /api/webhooks/cleanup
   * Prune old processed webhook events (manual trigger)
   */
  app.post("/api/webhooks/cleanup", (_req: Request, res: Response) => {
    try {
      const cutoffDays = runtimeConfig.evershopWebhookCleanupDays;
      const cutoffTime = Math.floor(Date.now() / 1000) - cutoffDays * 86400;

      const result = db
        .prepare(
          `DELETE FROM webhook_events
           WHERE status IN ('processed', 'skipped') AND created_at < ?`
        )
        .run(cutoffTime);

      logger.info(
        { deleted: result.changes, cutoff_days: cutoffDays },
        "Webhook events cleanup completed"
      );

      res.json({
        ok: true,
        deleted: result.changes,
        cutoff_days: cutoffDays,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Webhook cleanup failed");
      res.status(500).json({
        ok: false,
        error: "CLEANUP_FAILED",
        message,
      });
    }
  });
}
