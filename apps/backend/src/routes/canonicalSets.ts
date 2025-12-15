/**
 * Canonical Sets Router
 *
 * Phase 1: Read-only exposure of canonical_sets for validation
 * against Truth Core (cm_sets) dropdown.
 *
 * Per RFC: `/api/canonical-sets` returns mapped fields compatible
 * with cm_sets structure for comparison.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { CanonicalGateService } from "../services/canonical/canonicalGate";

interface CanonicalSetRow {
  ppt_set_id: string;
  tcg_player_id: string;
  name: string;
  series: string | null;
  release_date: string | null;
  card_count: number | null;
  has_price_guide: number;
  image_url: string | null;
  fetched_at: number;
}

export function registerCanonicalSetRoutes(app: Express, ctx: AppContext): void {
  const { db, logger } = ctx;
  const gateService = new CanonicalGateService(db, logger);

  /**
   * GET /api/canonical-sets
   *
   * Returns canonical sets in cm_sets-compatible format for comparison.
   * Response includes gate status and set list.
   */
  app.get("/api/canonical-sets", (_req: Request, res: Response) => {
    try {
      const gateResult = gateService.validateGate();

      if (!gateService.hasCanonicalTables()) {
        return res.status(503).json({
          error: "CANONICAL_CATALOG_UNAVAILABLE",
          message: "Canonical catalog tables not found",
          gate: gateResult,
          sets: [],
        });
      }

      const sets = db
        .prepare(
          `SELECT
             ppt_set_id,
             tcg_player_id,
             name,
             series,
             release_date,
             card_count,
             has_price_guide,
             image_url,
             fetched_at
           FROM canonical_sets
           ORDER BY release_date DESC NULLS LAST, name COLLATE NOCASE ASC`
        )
        .all() as CanonicalSetRow[];

      const mappedSets = sets.map((row) => ({
        ppt_id: row.ppt_set_id,
        tcgplayer_id: row.tcg_player_id,
        set_name: row.name,
        series: row.series,
        release_date: row.release_date,
        release_year: row.release_date ? parseInt(row.release_date.substring(0, 4), 10) : null,
        card_count: row.card_count,
        has_price_guide: row.has_price_guide === 1,
        image_url: row.image_url,
        fetched_at: row.fetched_at,
      }));

      res.json({
        gate: gateResult,
        sets: mappedSets,
        count: mappedSets.length,
      });
    } catch (error) {
      logger.error({ error }, "Failed to load canonical sets");
      res.status(500).json({
        error: "CANONICAL_SETS_ERROR",
        message: "Unable to load canonical sets",
      });
    }
  });

  /**
   * GET /api/canonical-sets/gate
   *
   * Returns just the gate validation result (for health checks / CI).
   */
  app.get("/api/canonical-sets/gate", (_req: Request, res: Response) => {
    try {
      const gateResult = gateService.validateGate();

      const status = gateResult.passed ? 200 : 503;
      res.status(status).json(gateResult);
    } catch (error) {
      logger.error({ error }, "Failed to validate canonical gate");
      res.status(500).json({
        passed: false,
        reason: "Gate validation error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * GET /api/canonical-sets/diff
   *
   * Returns diff between canonical_sets and cm_sets for pre-Phase 2 validation.
   * Shows sets that exist in one source but not the other.
   */
  app.get("/api/canonical-sets/diff", (_req: Request, res: Response) => {
    try {
      if (!gateService.hasCanonicalTables()) {
        return res.status(503).json({
          error: "CANONICAL_CATALOG_UNAVAILABLE",
          message: "Canonical catalog tables not found",
        });
      }

      const canonicalSets = db
        .prepare(`SELECT name FROM canonical_sets`)
        .all() as { name: string }[];

      const cmSets = db
        .prepare(`SELECT set_name FROM cm_sets`)
        .all() as { set_name: string }[];

      const canonicalNames = new Set(canonicalSets.map((s) => s.name.toLowerCase()));
      const cmNames = new Set(cmSets.map((s) => s.set_name.toLowerCase()));

      const onlyInCanonical = canonicalSets
        .filter((s) => !cmNames.has(s.name.toLowerCase()))
        .map((s) => s.name);

      const onlyInCmSets = cmSets
        .filter((s) => !canonicalNames.has(s.set_name.toLowerCase()))
        .map((s) => s.set_name);

      res.json({
        canonical_count: canonicalSets.length,
        cm_sets_count: cmSets.length,
        only_in_canonical: onlyInCanonical,
        only_in_cm_sets: onlyInCmSets,
        match_rate: canonicalSets.length > 0
          ? ((canonicalSets.length - onlyInCanonical.length) / canonicalSets.length * 100).toFixed(1) + "%"
          : "N/A",
      });
    } catch (error) {
      logger.error({ error }, "Failed to compute canonical diff");
      res.status(500).json({
        error: "CANONICAL_DIFF_ERROR",
        message: "Unable to compute canonical diff",
      });
    }
  });
}
