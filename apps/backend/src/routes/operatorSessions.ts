/**
 * Operator Session Routes
 *
 * Phase 3 extraction (Nov 2025).
 * Handles operator session lifecycle: start/end/abort, heartbeat, events, summary, and baseline finalization.
 * See apps/backend/docs/routes-operatorSessions.md for rationale.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { runtimeConfig } from "../config";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function registerOperatorSessionRoutes(app: Express, ctx: AppContext): void {
  const { db, logger, sessionRepo, sessionService, sftpWatcher } = ctx;

  /**
   * GET /api/operator-sessions/active
   * Fetch the currently active operator session (if any)
   */
  app.get("/api/operator-sessions/active", (_req: Request, res: Response) => {
    try {
      const activeSession = sessionService.getActiveSession();
      if (!activeSession) {
        return res.json({ session: null, status: "PREP", quota: null });
      }

      const timeSinceHeartbeat = activeSession.heartbeat_at
        ? Date.now() - activeSession.heartbeat_at
        : null;

      // Fetch latest quota state from session events
      const quota = sessionRepo.getQuotaState(activeSession.id);

      res.json({
        session: activeSession,
        status: activeSession.status,
        phase: activeSession.phase,
        heartbeat_stale: timeSinceHeartbeat && timeSinceHeartbeat > 90000, // 90s lapse
        quota,
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to fetch active session");
      res.status(500).json({ error: "failed to fetch active session" });
    }
  });

  /**
   * POST /api/operator-sessions/start
   * Start a new operator session
   * @body baseline - If true, starts a baseline session with relaxed Accept gates
   */
  app.post("/api/operator-sessions/start", async (req: Request, res: Response) => {
    const { baseline } = req.body ?? {};
    try {
      const session = await sessionService.startSession("operator", baseline === true);

      // Clear stale pending pairs (files deleted during inbox purge)
      // Must happen before retryPendingPairs() to prevent enqueueing missing files
      if (sftpWatcher) {
        sftpWatcher.clearPendingPairs();
      }

      // Retry pending SFTP pairs when session transitions to RUNNING
      // (handles files captured outside the previous session window)
      if (sftpWatcher) {
        void sftpWatcher.retryPendingPairs().catch((error) => {
          logger.warn({ err: error }, "SFTP pending pair retry failed (non-blocking)");
        });
      }

      res.status(201).json({
        ok: true,
        session,
        message: "Session started successfully",
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("409")) {
        logger.warn("Session conflict: another session already active");
        return res.status(409).json({
          error: "conflict",
          message: "Another session is already active",
        });
      }
      logger.error({ err: error }, "Failed to start session");
      res.status(500).json({ error: "failed to start session" });
    }
  });

  /**
   * POST /api/operator-sessions/:id/end
   * End an operator session normally
   */
  app.post("/api/operator-sessions/:id/end", async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const session = await sessionService.endSession(id);
      res.json({
        ok: true,
        session,
        message: "Session ended successfully",
      });
    } catch (error) {
      logger.error({ err: error, sessionId: id }, "Failed to end session");
      res.status(500).json({ error: "failed to end session" });
    }
  });

  /**
   * PATCH /api/operator-sessions/:id/abort
   * Abort an operator session with optional reason
   */
  app.patch("/api/operator-sessions/:id/abort", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { reason } = req.body ?? {};
    try {
      const session = await sessionService.abortSession(id, reason);
      res.json({
        ok: true,
        session,
        message: "Session aborted",
      });
    } catch (error) {
      logger.error({ err: error, sessionId: id }, "Failed to abort session");
      res.status(500).json({ error: "failed to abort session" });
    }
  });

  /**
   * POST /api/operator-sessions/:id/heartbeat
   * Update session heartbeat timestamp
   */
  app.post("/api/operator-sessions/:id/heartbeat", (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      sessionService.updateHeartbeat(id);
      res.json({ ok: true });
    } catch (error) {
      logger.error({ err: error, sessionId: id }, "Failed to update heartbeat");
      res.status(404).json({ error: "session not found" });
    }
  });

  /**
   * GET /api/operator-sessions/:id/events
   * Fetch session events since a given timestamp
   */
  app.get("/api/operator-sessions/:id/events", (req: Request, res: Response) => {
    const { id } = req.params;
    const { since } = req.query;
    const sinceTimestamp = typeof since === "string" ? parseInt(since, 10) : undefined;

    try {
      const events = sessionService.getEventsSince(id, sinceTimestamp);
      res.json({
        session_id: id,
        events,
        latest_timestamp: events.length > 0 ? events[events.length - 1].timestamp : null,
      });
    } catch (error) {
      logger.error({ err: error, sessionId: id }, "Failed to fetch session events");
      res.status(500).json({ error: "failed to fetch session events" });
    }
  });

  /**
   * GET /api/operator-sessions/:id/summary
   * Get session summary with scan/product counts, metrics, and quota state
   */
  app.get("/api/operator-sessions/:id/summary", (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const session = sessionRepo.getById(id);
      if (!session) {
        return res.status(404).json({ error: "NOT_FOUND", message: "Session not found" });
      }

      // Defensive guard: only allow finalize from RUNNING/VALIDATING states
      if (session.status !== "RUNNING" && session.status !== "VALIDATING") {
        return res.status(400).json({
          error: "INVALID_SESSION_STATE",
          message: "Session must be RUNNING or VALIDATING to finalize baseline",
          status: session.status,
        });
      }

      // Defensive guard: require at least one scan associated with the session
      const scanCountRow = db
        .prepare(`SELECT COUNT(*) as cnt FROM scans WHERE session_id = ?`)
        .get(id) as { cnt: number } | undefined;
      const scanCount = scanCountRow?.cnt ?? 0;
      if (scanCount === 0) {
        return res.status(400).json({
          error: "NO_SCANS_FOR_SESSION",
          message: "Cannot finalize baseline: no scans found for this session",
        });
      }

      // Query scan counts by status for this session
      const scanCounts = db.prepare(`
        SELECT
          COUNT(*) as total_scans,
          SUM(CASE WHEN status = 'ACCEPTED' THEN 1 ELSE 0 END) as accepted_count,
          SUM(CASE WHEN status = 'FLAGGED' THEN 1 ELSE 0 END) as flagged_count,
          SUM(CASE WHEN status = 'UNMATCHED_NO_REASONABLE_CANDIDATE' THEN 1 ELSE 0 END) as unmatched_count,
          MIN(created_at) as first_scan_at,
          MAX(created_at) as last_scan_at
        FROM scans
        WHERE session_id = ?
      `).get(id) as {
        total_scans: number;
        accepted_count: number;
        flagged_count: number;
        unmatched_count: number;
        first_scan_at: number | null;
        last_scan_at: number | null;
      };

      // Query product counts for this session (via scans -> products)
      // Products are linked to scans via product_uid, so we need to join through items
      // For now, we'll query products created during this session timeframe
      const productCounts = db.prepare(`
        SELECT
          COUNT(*) as total_products,
          SUM(CASE WHEN cm_card_id IS NOT NULL THEN 1 ELSE 0 END) as canonicalized_count,
          SUM(CASE WHEN pricing_source = 'ppt' THEN 1 ELSE 0 END) as enriched_count,
          SUM(CASE WHEN pricing_status = 'fresh' THEN 1 ELSE 0 END) as fresh_pricing_count,
          SUM(CASE WHEN pricing_source = 'csv' THEN 1 ELSE 0 END) as csv_fallback_count,
          SUM(CASE WHEN staging_ready = 1 THEN 1 ELSE 0 END) as staging_ready_count,
          SUM(CASE WHEN cm_card_id IS NOT NULL AND staging_ready = 0 THEN 1 ELSE 0 END) as eligible_not_staged_count,
          SUM(CASE WHEN manual_reason_code IS NOT NULL THEN 1 ELSE 0 END) as manual_override_count,
          SUM(CASE WHEN accepted_without_canonical = 1 THEN 1 ELSE 0 END) as accepted_without_canonical_count
        FROM products
        WHERE created_at >= ? AND created_at <= ?
      `).get(session.started_at, session.ended_at ?? Date.now()) as {
        total_products: number;
        canonicalized_count: number;
        enriched_count: number;
        fresh_pricing_count: number;
        csv_fallback_count: number;
        staging_ready_count: number;
        eligible_not_staged_count: number;
        manual_override_count: number;
        accepted_without_canonical_count: number;
      };

      // Get quota state from session events
      const quotaState = sessionRepo.getQuotaState(id);

      // Get retrieval corpus hash (from config or first scan's evidence)
      const corpusHashRow = db.prepare(`
        SELECT json_extract(extracted_json, '$.provenance.corpus_hash') as corpus_hash
        FROM scans
        WHERE session_id = ? AND extracted_json IS NOT NULL
        LIMIT 1
      `).get(id) as { corpus_hash: string | null } | undefined;

      const summary = {
        session_id: id,
        finalized_at: Date.now(),
        first_scan_at: scanCounts.first_scan_at ?? 0,
        last_scan_at: scanCounts.last_scan_at ?? 0,
        total_scans: scanCounts.total_scans ?? 0,
        accepted_count: scanCounts.accepted_count ?? 0,
        flagged_count: scanCounts.flagged_count ?? 0,
        unmatched_count: scanCounts.unmatched_count ?? 0,
        canonicalized_count: productCounts.canonicalized_count ?? 0,
        enriched_count: productCounts.enriched_count ?? 0,
        fresh_pricing_count: productCounts.fresh_pricing_count ?? 0,
        csv_fallback_count: productCounts.csv_fallback_count ?? 0,
        ppt_calls_consumed: quotaState?.callsConsumed ?? null,
        ppt_daily_remaining: quotaState?.dailyRemaining ?? null,
        staging_ready_count: productCounts.staging_ready_count ?? 0,
        eligible_not_staged_count: productCounts.eligible_not_staged_count ?? 0,
        manual_override_count: productCounts.manual_override_count ?? 0,
        accepted_without_canonical_count: productCounts.accepted_without_canonical_count ?? 0,
        retrieval_corpus_hash: corpusHashRow?.corpus_hash ?? null,
        openai_model: runtimeConfig.openaiModel ?? null,
      };

      res.json(summary);
    } catch (error) {
      logger.error({ err: error, sessionId: id }, "Failed to fetch session summary");
      res.status(500).json({ error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * POST /api/operator-sessions/:id/finalize-baseline
   * Finalize a session as the active Baseline (latest baseline wins)
   */
  app.post("/api/operator-sessions/:id/finalize-baseline", (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const session = sessionRepo.getById(id);
      if (!session) {
        return res.status(404).json({ error: "NOT_FOUND", message: "Session not found" });
      }

      // Latest baseline wins: clear any existing baseline flag first
      db.prepare(`UPDATE operator_sessions SET baseline = 0 WHERE baseline = 1`).run();
      db.prepare(`UPDATE operator_sessions SET baseline = 1, updated_at = ? WHERE id = ?`).run(Date.now(), id);

      // Fetch summary inline (reuse summary logic)
      let summary: Record<string, unknown> | null = null;
      try {
        // Query scan counts by status for this session
        const scanCounts = db.prepare(`
          SELECT
            COUNT(*) as total_scans,
            SUM(CASE WHEN status = 'ACCEPTED' THEN 1 ELSE 0 END) as accepted_count,
            SUM(CASE WHEN status = 'FLAGGED' THEN 1 ELSE 0 END) as flagged_count,
            SUM(CASE WHEN status = 'UNMATCHED_NO_REASONABLE_CANDIDATE' THEN 1 ELSE 0 END) as unmatched_count,
            MIN(created_at) as first_scan_at,
            MAX(created_at) as last_scan_at
          FROM scans
          WHERE session_id = ?
        `).get(id) as {
          total_scans: number;
          accepted_count: number;
          flagged_count: number;
          unmatched_count: number;
          first_scan_at: number | null;
          last_scan_at: number | null;
        };

        const productCounts = db.prepare(`
          SELECT
            COUNT(*) as total_products,
            SUM(CASE WHEN cm_card_id IS NOT NULL THEN 1 ELSE 0 END) as canonicalized_count,
            SUM(CASE WHEN pricing_source = 'ppt' THEN 1 ELSE 0 END) as enriched_count,
            SUM(CASE WHEN pricing_status = 'fresh' THEN 1 ELSE 0 END) as fresh_pricing_count,
            SUM(CASE WHEN pricing_source = 'csv' THEN 1 ELSE 0 END) as csv_fallback_count,
            SUM(CASE WHEN staging_ready = 1 THEN 1 ELSE 0 END) as staging_ready_count,
            SUM(CASE WHEN cm_card_id IS NOT NULL AND staging_ready = 0 THEN 1 ELSE 0 END) as eligible_not_staged_count,
            SUM(CASE WHEN manual_reason_code IS NOT NULL THEN 1 ELSE 0 END) as manual_override_count,
            SUM(CASE WHEN accepted_without_canonical = 1 THEN 1 ELSE 0 END) as accepted_without_canonical_count
          FROM products
          WHERE created_at >= ? AND created_at <= ?
        `).get(session.started_at, session.ended_at ?? Date.now()) as {
          total_products: number;
          canonicalized_count: number;
          enriched_count: number;
          fresh_pricing_count: number;
          csv_fallback_count: number;
          staging_ready_count: number;
          eligible_not_staged_count: number;
          manual_override_count: number;
          accepted_without_canonical_count: number;
        };

        const quotaState = sessionRepo.getQuotaState(id);

        const corpusHashRow = db.prepare(`
          SELECT json_extract(extracted_json, '$.provenance.corpus_hash') as corpus_hash
          FROM scans
          WHERE session_id = ? AND extracted_json IS NOT NULL
          LIMIT 1
        `).get(id) as { corpus_hash: string | null } | undefined;

        summary = {
          session_id: id,
          finalized_at: Date.now(),
          first_scan_at: scanCounts.first_scan_at ?? 0,
          last_scan_at: scanCounts.last_scan_at ?? 0,
          total_scans: scanCounts.total_scans ?? 0,
          accepted_count: scanCounts.accepted_count ?? 0,
          flagged_count: scanCounts.flagged_count ?? 0,
          unmatched_count: scanCounts.unmatched_count ?? 0,
          canonicalized_count: productCounts.canonicalized_count ?? 0,
          enriched_count: productCounts.enriched_count ?? 0,
          fresh_pricing_count: productCounts.fresh_pricing_count ?? 0,
          csv_fallback_count: productCounts.csv_fallback_count ?? 0,
          ppt_calls_consumed: quotaState?.callsConsumed ?? null,
          ppt_daily_remaining: quotaState?.dailyRemaining ?? null,
          staging_ready_count: productCounts.staging_ready_count ?? 0,
          eligible_not_staged_count: productCounts.eligible_not_staged_count ?? 0,
          manual_override_count: productCounts.manual_override_count ?? 0,
          accepted_without_canonical_count: productCounts.accepted_without_canonical_count ?? 0,
          retrieval_corpus_hash: corpusHashRow?.corpus_hash ?? null,
          openai_model: runtimeConfig.openaiModel ?? null,
        };
      } catch (summaryError) {
        logger.warn({ err: summaryError, sessionId: id }, "Failed to compute summary for baseline_finalized event");
      }

      // Emit event for audit with full summary payload
      sessionRepo.addEvent(id, "baseline_finalized", "info", "Session marked as Baseline", summary ?? { session_id: id });

      // Generate baseline_expected.csv from accepted scans in this session
      let baselineCsvPath: string | null = null;
      let acceptanceResult: { success: boolean; output?: string; error?: string } | null = null;

      // Helper: escape CSV field (handle commas, quotes, newlines)
      const escapeCsvField = (value: string | number | null | undefined): string => {
        if (value === null || value === undefined) return "";
        const str = String(value);
        // If contains comma, quote, or newline, wrap in quotes and escape existing quotes
        if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      try {
        const acceptedScans = db.prepare(`
          SELECT
            ROW_NUMBER() OVER (ORDER BY created_at ASC) as sequence_index,
            accepted_name as expected_name,
            COALESCE(accepted_hp, 0) as expected_hp,
            accepted_collector_no as expected_collector_no,
            accepted_set_name as expected_set_name,
            '' as notes
          FROM scans
          WHERE session_id = ? AND status = 'ACCEPTED'
          ORDER BY created_at ASC
        `).all(id) as Array<{
          sequence_index: number;
          expected_name: string;
          expected_hp: number;
          expected_collector_no: string;
          expected_set_name: string;
          notes: string;
        }>;

        if (acceptedScans.length === 0) {
          // Return early with explicit warning - no CSV generated, no SQL run
          logger.warn({ sessionId: id }, "No accepted scans to generate baseline_expected.csv");
          return res.json({
            ok: true,
            session_id: id,
            baseline: true,
            baseline_csv_path: null,
            acceptance_result: { success: false, error: "No accepted scans in session - baseline CSV not generated" },
            warning: "Session finalized as baseline but no accepted scans found. Scan cards and Accept before finalizing.",
          });
        }

        // Build CSV content with proper escaping
        const csvHeader = "sequence_index,expected_name,expected_hp,expected_collector_no,expected_set_name,notes";
        const csvRows = acceptedScans.map((row) =>
          [
            escapeCsvField(row.sequence_index),
            escapeCsvField(row.expected_name),
            escapeCsvField(row.expected_hp),
            escapeCsvField(row.expected_collector_no),
            escapeCsvField(row.expected_set_name),
            escapeCsvField(row.notes),
          ].join(",")
        );
        const csvContent = [csvHeader, ...csvRows].join("\n") + "\n";

        // Write to workspace root baseline_expected.csv
        const workspaceRoot = path.resolve(__dirname, "../../../../..");
        baselineCsvPath = path.join(workspaceRoot, "baseline_expected.csv");
        fs.writeFileSync(baselineCsvPath, csvContent, "utf-8");
        logger.info({ sessionId: id, path: baselineCsvPath, count: acceptedScans.length }, "Generated baseline_expected.csv");

        // Run acceptance SQL validation
        try {
          const dbPath = path.join(workspaceRoot, "apps/backend/cardmint_dev.db");
          const sqlPath = path.join(workspaceRoot, "scripts/validate/acceptance_extraction.sql");

          if (fs.existsSync(sqlPath)) {
            const output = execSync(`sqlite3 "${dbPath}" < "${sqlPath}"`, {
              cwd: workspaceRoot,
              encoding: "utf-8",
              timeout: 30000,
            });
            acceptanceResult = { success: true, output };
            logger.info({ sessionId: id }, "Acceptance extraction SQL completed");
          } else {
            acceptanceResult = { success: false, error: "acceptance_extraction.sql not found" };
            logger.warn({ sessionId: id, sqlPath }, "Acceptance extraction SQL file not found");
          }
        } catch (sqlError) {
          const errorMsg = sqlError instanceof Error ? sqlError.message : String(sqlError);
          acceptanceResult = { success: false, error: errorMsg };
          logger.warn({ err: sqlError, sessionId: id }, "Acceptance extraction SQL failed (non-blocking)");
        }
      } catch (csvError) {
        logger.warn({ err: csvError, sessionId: id }, "Failed to generate baseline_expected.csv (non-blocking)");
      }

      logger.info({ sessionId: id }, "Operator session finalized as Baseline");
      res.json({
        ok: true,
        session_id: id,
        baseline: true,
        baseline_csv_path: baselineCsvPath,
        acceptance_result: acceptanceResult,
      });
    } catch (error) {
      logger.error({ err: error, sessionId: id }, "Failed to finalize baseline session");
      res.status(500).json({ error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) });
    }
  });
}
