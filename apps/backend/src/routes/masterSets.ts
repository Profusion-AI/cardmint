/**
 * Master Sets Router
 *
 * Phase 2 extraction (Nov 2025).
 * Serves the canonical master set list from cm_sets table.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";

export function registerMasterSetRoutes(app: Express, ctx: AppContext): void {
  const { db, logger } = ctx;

  app.get("/api/master-sets", (_req: Request, res: Response) => {
    try {
      const sets = db
        .prepare(
          `SELECT cm_set_id, set_name, release_date, release_year, total_cards, series
           FROM cm_sets
           ORDER BY COALESCE(release_year, 0) DESC, set_name COLLATE NOCASE ASC`
        )
        .all() as Array<{
          cm_set_id: string;
          set_name: string;
          release_date: string | null;
          release_year: number | null;
          total_cards: number | null;
          series: string | null;
        }>;

      res.json({ sets });
    } catch (error) {
      logger.error({ error }, "Failed to load master set list");
      res.status(500).json({
        error: "MASTER_SETLIST_UNAVAILABLE",
        message: "Unable to load master set list",
      });
    }
  });
}
