/**
 * Metrics Router
 *
 * Phase 2 extraction (Nov 2025).
 * Provides operational metrics for monitoring and debugging.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { runtimeConfig } from "../app/context";

export function registerMetricsRoutes(app: Express, ctx: AppContext): void {
  const { db, logger, queue, metricsCollector, captureAdapter, jobWorker, retrievalService } = ctx;

  // Prometheus-style queue metrics with driver health
  app.get("/metrics", async (_req: Request, res: Response) => {
    const recent = queue.getRecent(10);
    const depth = queue.getQueueDepth();
    const stats = metricsCollector.getMetrics();
    const driverHealth = await captureAdapter.health();

    // Surface kiosk spool telemetry when driver=pi-hq
    const kioskSpool =
      captureAdapter.getDriverName() === "pi-hq"
        ? (driverHealth.details?.spool as any)
        : undefined;

    res.json({
      queueDepth: depth,
      warning: depth >= runtimeConfig.queueWarnDepth,
      recent,
      workerIdleMinutes: jobWorker.getIdleMinutes(),
      ...stats,
      captureDriver: captureAdapter.getDriverName(),
      ...(kioskSpool && {
        kioskSpool: {
          queuedPairs: kioskSpool.queued_pairs ?? 0,
          bytes: kioskSpool.bytes ?? 0,
          enabled: kioskSpool.enabled ?? false,
        },
      }),
    });
  });

  // Override/quota/PPT stats for operator dashboard
  app.get("/api/metrics", (_req: Request, res: Response) => {
    try {
      // Manual override counts by reason code
      const overrideCounts = db
        .prepare(
          `SELECT manual_reason_code, COUNT(*) as count
           FROM products
           WHERE manual_reason_code IS NOT NULL
           GROUP BY manual_reason_code`
        )
        .all() as { manual_reason_code: string; count: number }[];

      const override_by_reason: Record<string, number> = {};
      for (const row of overrideCounts) {
        override_by_reason[row.manual_reason_code] = row.count;
      }

      // Quota exhaustion events count
      const quotaExhaustionCount = db
        .prepare(
          `SELECT COUNT(*) as count
           FROM operator_session_events
           WHERE source = 'quota_exhausted'`
        )
        .get() as { count: number };

      // Average manual note length (where notes exist)
      const noteStats = db
        .prepare(
          `SELECT AVG(LENGTH(manual_note)) as avg_length, COUNT(*) as count
           FROM products
           WHERE manual_note IS NOT NULL`
        )
        .get() as { avg_length: number | null; count: number };

      // UNMATCHED job count
      const unmatchedCount = db
        .prepare(
          `SELECT COUNT(*) as count
           FROM scans
           WHERE status = 'UNMATCHED_NO_REASONABLE_CANDIDATE'`
        )
        .get() as { count: number };

      // PPT failure distribution
      const pptFailureStats = db
        .prepare(
          `SELECT ppt_failure_count, COUNT(*) as count
           FROM scans
           WHERE ppt_failure_count > 0
           GROUP BY ppt_failure_count`
        )
        .all() as { ppt_failure_count: number; count: number }[];

      // Canonical retrieval telemetry
      const canonicalTelemetry = retrievalService.getTelemetrySnapshot();
      const canonicalTotal = canonicalTelemetry.canonical_hit + canonicalTelemetry.pricecharting_fallback;
      const canonicalHitRate = canonicalTotal > 0
        ? Math.round((canonicalTelemetry.canonical_hit / canonicalTotal) * 10000) / 100
        : 0;
      const canonicalGate = {
        passed: canonicalTotal === 0 ? null : canonicalHitRate >= 80 && canonicalTelemetry.canonical_unavailable === 0,
        threshold_hit_rate: 80,
        threshold_unavailable: 0,
      };

      res.json({
        override_by_reason,
        quota_exhaustion_count: quotaExhaustionCount.count,
        avg_manual_note_length: noteStats.avg_length ?? 0,
        manual_override_count: noteStats.count,
        unmatched_job_count: unmatchedCount.count,
        ppt_failure_distribution: pptFailureStats,
        canonical_retrieval: {
          canonical_hit: canonicalTelemetry.canonical_hit,
          pricecharting_fallback: canonicalTelemetry.pricecharting_fallback,
          canonical_unavailable: canonicalTelemetry.canonical_unavailable,
          hit_rate_percent: canonicalHitRate,
          gate: canonicalGate,
        },
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to fetch metrics");
      res.status(500).json({ error: "failed to fetch metrics" });
    }
  });
}
