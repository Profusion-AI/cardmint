/**
 * Job Actions Router
 *
 * Phase 3 extraction (Nov 2025).
 * Handles operator actions on jobs: ACCEPT, FLAG, RETRY.
 * See apps/backend/docs/routes-job-actions.md for rationale.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";

import {
  validateStagedOverrides,
  normalizeStagedOverrides,
  type StagedOverrides,
} from "../domain/manualOverrideValidator";
import { computeOverrideDiff } from "../domain/job";
import { normalizeCondition } from "../services/inventory/skuHelpers";
import { runtimeConfig } from "../config";
import { EverShopImporter } from "../services/importer/evershopClient";
import type { EverShopConfig } from "../services/importer/types";
import { SyncService } from "../services/sync/syncService";

export function registerJobActionRoutes(app: Express, ctx: AppContext): void {
  const { db, queue, sessionService, logger, stage3Promotion, jobRepo } = ctx;

  // EverShop auto-import (Dec 2025): instantiate importer if enabled
  // Config loaded from centralized runtimeConfig (env-driven, no hardcoding)
  let evershopImporter: EverShopImporter | null = null;
  if (runtimeConfig.evershopAutoImportEnabled) {
    const evershopConfig: EverShopConfig = {
      apiUrl: runtimeConfig.evershopApiUrl,
      adminToken: runtimeConfig.evershopAdminToken,
      environment: runtimeConfig.evershopEnvironment as "staging" | "production",
      sshKeyPath: runtimeConfig.evershopSshKeyPath,
      sshUser: runtimeConfig.evershopSshUser,
      sshHost: runtimeConfig.evershopSshHost,
      dockerComposePath: runtimeConfig.evershopDockerComposePath,
      dbUser: runtimeConfig.evershopDbUser,
      dbName: runtimeConfig.evershopDbName,
    };
    evershopImporter = new EverShopImporter(db, evershopConfig, logger);
    logger.info({ host: runtimeConfig.evershopSshHost, env: runtimeConfig.evershopEnvironment }, "EverShop auto-import ENABLED");
  }

  // Sync service for production SQLite sync (Dec 2025 3DB alignment)
  const syncService = new SyncService(db, logger);

  /**
   * PATCH /api/jobs/:id - Accept, Flag, or Retry a job
   *
   * Primary operator workflow endpoint. ACCEPT triggers Stage 2 inventory
   * creation with Truth Core persistence.
   */
  app.patch("/api/jobs/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { action, candidateIndex, selectionSource, telemetry } = req.body ?? {};

    if (typeof action !== "string") {
      return res.status(400).json({ error: "action is required" });
    }

    const validActions = ["ACCEPT", "FLAG", "RETRY"];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `action must be one of: ${validActions.join(", ")}` });
    }

    if (ctx.isShuttingDown()) {
      return res.status(503).json({ error: "Server is shutting down" });
    }

    try {
      const job = queue.getById(id);
      if (!job) {
        return res.status(404).json({ error: "job not found" });
      }

      let normalizedOverrides: StagedOverrides | undefined;
      let overrideDiffs: Record<string, { from: any; to: any }> | undefined;
      let validationWarnings: any[] | undefined;

      if (action === "ACCEPT" && telemetry?.staged_overrides) {
        const stagedOverrides = telemetry.staged_overrides as StagedOverrides;

        const validationResult = validateStagedOverrides(stagedOverrides, job.extracted);

        if (!validationResult.valid) {
          return res.status(400).json({
            error: "Invalid manual overrides",
            validation_errors: validationResult.errors,
          });
        }

        normalizedOverrides = normalizeStagedOverrides(stagedOverrides);
        overrideDiffs = computeOverrideDiff(job.extracted, normalizedOverrides);

        if (validationResult.warnings.length > 0) {
          validationWarnings = validationResult.warnings;
        }

        logger.info(
          {
            jobId: id,
            normalized: normalizedOverrides,
            diffs: overrideDiffs,
            warnings: validationWarnings,
          },
          "Manual overrides validated and normalized"
        );
      }

      const timeToResolutionMs = Date.now() - job.updated_at;

      let newStatus: string;
      switch (action) {
        case "ACCEPT":
          newStatus = "ACCEPTED";

          const telemetryTruth =
            telemetry && typeof telemetry === "object" ? (telemetry as any).truth_core : undefined;

          const parseSetSize = (setNum?: string | null): number | null => {
            if (!setNum) return null;
            const m = String(setNum).match(/^[^/]+\/(\d+)$/);
            return m ? parseInt(m[1], 10) : null;
          };

          const truthCore = {
            name:
              telemetryTruth?.name ??
              normalizedOverrides?.card_name ??
              job.extracted.card_name ??
              "",
            hp:
              telemetryTruth?.hp ??
              normalizedOverrides?.hp_value ??
              job.extracted.hp_value ??
              null,
            collector_no:
              telemetryTruth?.collector_no ??
              normalizedOverrides?.set_number ??
              job.extracted.set_number ??
              "",
            set_name:
              telemetryTruth?.set_name ??
              normalizedOverrides?.set_name ??
              job.extracted.set_name ??
              "",
            set_size:
              telemetryTruth?.set_size ??
              parseSetSize(
                telemetryTruth?.collector_no ??
                  normalizedOverrides?.set_number ??
                  job.extracted.set_number ??
                  null
              ),
            // Dec 8, 2025: Include variant_tags for persistence to products table
            variant_tags: Array.isArray(telemetryTruth?.variant_tags)
              ? telemetryTruth.variant_tags.filter((t: unknown) => typeof t === "string" && t.trim().length > 0)
              : [],
          };

          // Check if this is a baseline session (relaxed Accept gates)
          const sessionRow = job.session_id
            ? (db.prepare(`SELECT baseline FROM operator_sessions WHERE id = ?`).get(job.session_id) as { baseline: number } | undefined)
            : undefined;
          const isBaselineSession = sessionRow?.baseline === 1;

          if (!job.front_locked) {
            return res.status(400).json({
              error: "Front must be locked before Accept",
              details: "Lock front image first (Stage 1A requirement)",
              required_flags: {
                front_locked: false,
                back_ready: job.back_ready,
                canonical_locked: job.canonical_locked,
              },
            });
          }
          // Skip back_ready and canonical_locked checks for baseline sessions
          if (!isBaselineSession) {
            if (!job.back_ready) {
              return res.status(400).json({
                error: "Back image required before Accept",
                details: "Capture back image first (Stage 1B requirement)",
                required_flags: {
                  front_locked: job.front_locked,
                  back_ready: false,
                  canonical_locked: job.canonical_locked,
                },
              });
            }
            if (!job.canonical_locked) {
              return res.status(400).json({
                error: "Canonical ID must be locked before Accept",
                details: "Canonicalize the scan first (Stage 1B requirement)",
                required_flags: {
                  front_locked: job.front_locked,
                  back_ready: job.back_ready,
                  canonical_locked: false,
                },
              });
            }
          } else {
            logger.info({ jobId: id, sessionId: job.session_id }, "Baseline session: skipping back_ready and canonical_locked checks");
          }

          const rawCondition =
            typeof req.body.condition === "string" ? req.body.condition : "UNKNOWN";
          const condition = normalizeCondition(rawCondition);

          const hasValidCmCardId =
            job.cm_card_id &&
            job.cm_card_id.trim().length > 0 &&
            !job.cm_card_id.toUpperCase().startsWith("UNKNOWN_");

          if (!hasValidCmCardId) {
            logger.warn(
              {
                jobId: id,
                cm_card_id: job.cm_card_id,
                truth_core: truthCore,
                condition,
              },
              "Accepting without canonical match - inventory will be marked for reconciliation"
            );
          }

          // Baseline sessions: skip inventory creation, stage 3, and EverShop import
          // Only record the acceptance in scans table for baseline CSV validation
          if (isBaselineSession) {
            try {
              await queue.acceptForBaseline(id, truthCore);
              logger.info({ jobId: id, sessionId: job.session_id }, "Baseline session: accepted without inventory/promotion");
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              logger.error({ err, jobId: id, truthCore }, "Baseline accept failed");
              return res.status(500).json({
                error: "Baseline accept failed",
                details: errorMessage,
                jobId: id,
              });
            }
          } else {
            // Production flow: full inventory creation
            try {
              await queue.acceptWithTruthCore(id, truthCore, condition);
              // Clear reconciliation_status if cm_card_id is now set
              const refreshed = queue.getById(id);
              if (
                refreshed?.cm_card_id &&
                refreshed.cm_card_id.trim().length > 0 &&
                !refreshed.cm_card_id.toUpperCase().startsWith("UNKNOWN_")
              ) {
                db.prepare(
                  `UPDATE scans
                   SET reconciliation_status = NULL
                   WHERE id = ?`
                ).run(id);
              }
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              logger.error(
                { err, jobId: id, truthCore, condition },
                "Accept failed: inventory creation error"
              );
              return res.status(500).json({
                error: "Accept failed: inventory could not be created",
                details: errorMessage,
                jobId: id,
              });
            }

            try {
              const variantTags: string[] | undefined =
                telemetryTruth && Array.isArray((telemetryTruth as any).variant_tags)
                  ? (telemetryTruth as any).variant_tags
                  : Array.isArray((telemetry as any)?.truth_variants)
                    ? (telemetry as any).truth_variants
                    : undefined;
              if (variantTags && Array.isArray(variantTags)) {
                const normalized = variantTags
                  .map((v) => String(v || "").trim())
                  .filter((v) => v.length > 0);
                const payload = JSON.stringify(normalized);
                db.prepare(
                  `UPDATE scans SET accepted_variant_tags = @tags, updated_at = @ts WHERE id = @id`
                ).run({ id, tags: payload, ts: Date.now() });
              }
            } catch (err) {
              logger.warn({ err }, "Failed to persist variant tags (non-blocking)");
            }

            // Stage 3 automation: publish images + enrich pricing (non-blocking)
            // Fire-and-forget to not delay Accept response
            stage3Promotion
              .promoteAfterAccept(id)
              .then(async () => {
                const productRow = jobRepo.getProductByJobId(id);
                if (!productRow?.product_uid) return;

                // Sync to production SQLite FIRST (3DB alignment - Dec 2025)
                // Ensures vault shows the product even if EverShop import fails
                try {
                  const syncResult = await syncService.syncProductToProdSqlite(
                    productRow.product_uid,
                    "job_accept"
                  );
                  if (syncResult.success) {
                    logger.info({ productUid: productRow.product_uid }, "Product synced to prod SQLite after accept");
                  } else {
                    logger.warn({ productUid: productRow.product_uid, error: syncResult.error }, "Prod SQLite sync failed (non-blocking)");
                  }
                } catch (err) {
                  logger.warn({ err, productUid: productRow.product_uid }, "Prod SQLite sync threw (non-blocking)");
                }

                // Auto-import to EverShop after prod sync completes (if enabled)
                if (evershopImporter) {
                  try {
                    await evershopImporter.importProductIfReady(productRow.product_uid);
                  } catch (err) {
                    logger.warn({ err, productUid: productRow.product_uid }, "EverShop auto-import failed (non-blocking)");
                  }
                }
              })
              .catch((err) => {
                logger.warn({ err, jobId: id }, "Stage 3 promotion failed (non-blocking)");
              });
          }
          break;

        case "FLAG":
          newStatus = "FLAGGED";
          queue.updateStatus(id, newStatus as any);
          break;

        case "RETRY":
          newStatus = "QUEUED";
          queue.updateStatus(id, newStatus as any);
          break;

        default:
          return res.status(400).json({ error: "invalid action" });
      }

      const eventSource =
        action === "ACCEPT"
          ? "job_accepted"
          : action === "FLAG"
            ? "job_flagged"
            : "job_status_changed";
      const eventPayload: Record<string, any> = {
        jobId: id,
        previousStatus: job.status,
        newStatus,
        time_to_resolution_ms: timeToResolutionMs,
        time_to_resolution_s: Math.round(timeToResolutionMs / 1000),
      };

      if (typeof candidateIndex === "number") {
        eventPayload.candidateIndex = candidateIndex;
      }

      if (typeof selectionSource === "string") {
        eventPayload.selection_source = selectionSource;
      }

      if (telemetry && typeof telemetry === "object") {
        eventPayload.telemetry = telemetry;
      }

      try {
        await sessionService.emitEvent(
          eventSource as any,
          "info",
          action === "ACCEPT"
            ? `Job accepted (candidate #${candidateIndex ?? 0}, source: ${selectionSource ?? "top3"})`
            : action === "FLAG"
              ? `Job flagged`
              : `Job status changed to ${newStatus}`,
          eventPayload
        );
      } catch (err) {
        logger.warn({ err }, "Failed to emit job action event");
      }

      if (action === "ACCEPT" && normalizedOverrides && Object.keys(normalizedOverrides).length > 0) {
        try {
          await sessionService.emitEvent(
            "manual_overrides_applied",
            "info",
            `Manual overrides applied: ${Object.keys(overrideDiffs ?? {}).join(", ")}`,
            {
              jobId: id,
              normalized_overrides: normalizedOverrides,
              deltas: overrideDiffs,
              warnings: validationWarnings,
              selection_source: selectionSource ?? "manual_tab",
              provenance: "operator_manual_tab",
              operator_id: job.operator_id,
              session_id: job.session_id,
            }
          );
        } catch (err) {
          logger.warn({ err }, "Failed to emit manual overrides event");
        }
      }

      if (action === "ACCEPT" && typeof candidateIndex === "number") {
        logger.info(
          { jobId: id, candidateIndex, selectionSource },
          "Job accepted with candidate selection"
        );
      }

      res.json({ ok: true, job: queue.getById(id) });
    } catch (error) {
      logger.error(error);
      res.status(500).json({ error: "failed to update job" });
    }
  });

  /**
   * PATCH /api/jobs/:id/timings - Record operator timing metrics
   */
  app.patch("/api/jobs/:id/timings", (req: Request, res: Response) => {
    const { id } = req.params;
    const { operator_first_view_ms } = req.body ?? {};

    if (typeof operator_first_view_ms !== "number") {
      return res.status(400).json({
        error: "operator_first_view_ms is required and must be a number",
      });
    }

    if (ctx.isShuttingDown()) {
      return res.status(503).json({ error: "Server is shutting down" });
    }

    try {
      const job = queue.getById(id);
      if (!job) {
        return res.status(404).json({ error: "job not found" });
      }

      queue.updateTimings(id, { operator_first_view_ms });
      logger.debug({ jobId: id, operator_first_view_ms }, "Operator first view timing recorded");

      res.json({ ok: true });
    } catch (error) {
      logger.error(error);
      res.status(500).json({ error: "failed to update job timings" });
    }
  });
}
