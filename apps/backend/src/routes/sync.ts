/**
 * Sync Routes
 * API endpoints for promotion workflow and sync health
 * RFC-fullduplexDB_triple Phase 1
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { SyncService } from "../services/sync/syncService";
import { runtimeConfig } from "../config";
import type {
  PromoteRequest,
  PromoteResponse,
  UnpromoteRequest,
  UnpromoteResponse,
  SyncEventStatus,
} from "../services/sync/types";

export function registerSyncRoutes(app: Express, ctx: AppContext): void {
  const { logger, db } = ctx;

  // Lazy initialization of sync service
  let syncService: SyncService | null = null;
  const getSyncService = (): SyncService => {
    if (!syncService) {
      syncService = new SyncService(db, logger);
    }
    return syncService;
  };

  // ==========================================================================
  // Health & Status
  // ==========================================================================

  /**
   * GET /api/sync/health
   * Three-DB health report (unauthenticated for monitoring)
   */
  app.get("/api/sync/health", async (_req: Request, res: Response) => {
    try {
      const health = await getSyncService().getSyncHealth();
      res.json(health);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Sync health check failed");
      res.status(500).json({
        error: "HEALTH_CHECK_FAILED",
        message,
        overall: "red",
      });
    }
  });

  // ==========================================================================
  // Promotion Candidates
  // ==========================================================================

  /**
   * GET /api/sync/candidates
   * Get products ready for promotion
   * Query params: limit (default 100)
   */
  app.get("/api/sync/candidates", (_req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(_req.query.limit as string, 10) || 100, 500);
      const candidates = getSyncService().getPromotionCandidates(limit);

      res.json({
        count: candidates.length,
        limit,
        candidates,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Failed to fetch promotion candidates");
      res.status(500).json({ error: "FETCH_FAILED", message });
    }
  });

  /**
   * GET /api/sync/state/:product_uid
   * Get sync state for a single product
   */
  app.get("/api/sync/state/:product_uid", (_req: Request, res: Response) => {
    try {
      const { product_uid } = _req.params;

      const row = db
        .prepare(
          `SELECT evershop_sync_state, promoted_at, last_synced_at, sync_version
           FROM products WHERE product_uid = ?`
        )
        .get(product_uid) as {
        evershop_sync_state: string | null;
        promoted_at: number | null;
        last_synced_at: number | null;
        sync_version: number;
      } | undefined;

      if (!row) {
        return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
      }

      res.json({
        product_uid,
        evershop_sync_state: row.evershop_sync_state ?? "not_synced",
        promoted_at: row.promoted_at,
        last_synced_at: row.last_synced_at,
        sync_version: row.sync_version ?? 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message, product_uid: _req.params.product_uid }, "Failed to fetch sync state");
      res.status(500).json({ error: "FETCH_FAILED", message });
    }
  });

  // ==========================================================================
  // Promotion
  // ==========================================================================

  /**
   * POST /api/sync/promote
   * Promote products from staging to production
   * Body: { product_uids: string[], dry_run?: boolean, operator_id?: string }
   */
  app.post("/api/sync/promote", async (req: Request, res: Response) => {
    const body = req.body as PromoteRequest;

    // Validate request
    if (!body.product_uids || !Array.isArray(body.product_uids) || body.product_uids.length === 0) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "product_uids array is required",
      });
    }

    // Enforce batch limit
    const batchLimit = runtimeConfig.evershopImportBatchLimit;
    if (body.product_uids.length > batchLimit) {
      return res.status(400).json({
        error: "BATCH_LIMIT_EXCEEDED",
        message: `Maximum ${batchLimit} products per batch. Received ${body.product_uids.length}`,
      });
    }

    const dryRun = body.dry_run === true;

    try {
      if (dryRun) {
        // Dry run: return what would be promoted
        const candidates = getSyncService().getPromotionCandidates(body.product_uids.length);
        const matchingCandidates = candidates.filter((c) =>
          body.product_uids.includes(c.product_uid)
        );

        const response: PromoteResponse = {
          dry_run: true,
          total: body.product_uids.length,
          promoted: matchingCandidates.length,
          failed: body.product_uids.length - matchingCandidates.length,
          results: body.product_uids.map((uid) => {
            const candidate = matchingCandidates.find((c) => c.product_uid === uid);
            return candidate
              ? { product_uid: uid, success: true }
              : { product_uid: uid, success: false, error: "Not a valid promotion candidate" };
          }),
        };

        return res.json(response);
      }

      // Real promotion
      const service = getSyncService();
      const results: PromoteResponse["results"] = [];
      let promoted = 0;
      let failed = 0;

      for (const productUid of body.product_uids) {
        const result = await service.promoteProduct(productUid, body.operator_id);

        results.push({
          product_uid: productUid,
          success: result.success,
          event_uid: result.event_uid,
          evershop_sync_state: result.evershop_sync_state,
          error: result.error,
        });

        if (result.success) {
          promoted++;
        } else {
          failed++;
        }
      }

      const response: PromoteResponse = {
        dry_run: false,
        total: body.product_uids.length,
        promoted,
        failed,
        results,
      };

      logger.info(
        { total: body.product_uids.length, promoted, failed },
        "Promotion batch completed"
      );

      res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Promotion failed");
      res.status(500).json({ error: "PROMOTION_FAILED", message });
    }
  });

  // ==========================================================================
  // Unpromote (Rollback)
  // ==========================================================================

  /**
   * POST /api/sync/unpromote
   * Rollback promoted products from production
   * Body: { product_uids: string[], operator_id?: string }
   */
  app.post("/api/sync/unpromote", async (req: Request, res: Response) => {
    const body = req.body as UnpromoteRequest;

    // Validate request
    if (!body.product_uids || !Array.isArray(body.product_uids) || body.product_uids.length === 0) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "product_uids array is required",
      });
    }

    try {
      const service = getSyncService();
      const results: UnpromoteResponse["results"] = [];
      let unpromoted = 0;
      let failed = 0;

      for (const productUid of body.product_uids) {
        const result = await service.unpromoteProduct(productUid, body.operator_id);

        results.push({
          product_uid: productUid,
          success: result.success,
          error: result.error,
        });

        if (result.success) {
          unpromoted++;
        } else {
          failed++;
        }
      }

      const response: UnpromoteResponse = {
        total: body.product_uids.length,
        unpromoted,
        failed,
        results,
      };

      logger.info(
        { total: body.product_uids.length, unpromoted, failed },
        "Unpromote batch completed"
      );

      res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Unpromote failed");
      res.status(500).json({ error: "UNPROMOTE_FAILED", message });
    }
  });

  // ==========================================================================
  // Sync Events (Audit Log)
  // ==========================================================================

  /**
   * GET /api/sync/events
   * Get sync event audit log with filters
   * Query params: status, event_type, limit
   */
  app.get("/api/sync/events", (_req: Request, res: Response) => {
    try {
      const filters = {
        status: _req.query.status as SyncEventStatus | undefined,
        event_type: _req.query.event_type as string | undefined,
        limit: Math.min(parseInt(_req.query.limit as string, 10) || 100, 500),
      };

      const events = getSyncService().getSyncEvents(filters);

      res.json({
        count: events.length,
        filters,
        events,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Failed to fetch sync events");
      res.status(500).json({ error: "FETCH_FAILED", message });
    }
  });

  /**
   * GET /api/sync/events/pending
   * Get pending sync events (convenience endpoint)
   */
  app.get("/api/sync/events/pending", (_req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(_req.query.limit as string, 10) || 50, 200);
      const events = getSyncService().getPendingSyncEvents(limit);

      res.json({
        count: events.length,
        events,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Failed to fetch pending events");
      res.status(500).json({ error: "FETCH_FAILED", message });
    }
  });

  /**
   * GET /api/sync/events/failed
   * Get failed sync events for review (convenience endpoint)
   */
  app.get("/api/sync/events/failed", (_req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(_req.query.limit as string, 10) || 50, 200);
      const events = getSyncService().getFailedSyncEvents(limit);

      res.json({
        count: events.length,
        events,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Failed to fetch failed events");
      res.status(500).json({ error: "FETCH_FAILED", message });
    }
  });

  // ==========================================================================
  // Phase 2: Sale Sync (prod -> staging)
  // ==========================================================================

  /**
   * POST /api/sync/pull-sales
   * Pull pending sale events from prod and archive to staging
   * Called manually or by daemon when staging comes online
   * Query params: limit (default 20)
   */
  app.post("/api/sync/pull-sales", async (_req: Request, res: Response) => {
    // Gate check - must be enabled
    if (!runtimeConfig.syncEnabled) {
      return res.status(503).json({
        error: "SYNC_DISABLED",
        message: "Sync is disabled (SYNC_ENABLED=false)",
      });
    }

    try {
      const limit = Math.min(parseInt(_req.query.limit as string, 10) || 20, 100);
      const result = await getSyncService().syncSales(limit);

      logger.info(
        { total: result.total, synced: result.synced, failed: result.failed, skipped: result.skipped },
        "Sale sync pull completed"
      );

      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Sale sync pull failed");
      res.status(500).json({ error: "SYNC_FAILED", message });
    }
  });

  /**
   * GET /api/sync/sales/pending
   * Get count of pending sale events in prod (without syncing)
   * Useful for monitoring when staging is offline
   */
  app.get("/api/sync/sales/pending", async (_req: Request, res: Response) => {
    try {
      const service = getSyncService();
      // Query prod for pending sale count
      const pendingCount = await service.getPendingSaleCount();

      res.json({
        pending_sales: pendingCount,
        message: pendingCount > 0
          ? `${pendingCount} sale(s) pending sync to staging`
          : "No pending sales",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message }, "Failed to check pending sales");
      res.status(500).json({ error: "FETCH_FAILED", message });
    }
  });
}
