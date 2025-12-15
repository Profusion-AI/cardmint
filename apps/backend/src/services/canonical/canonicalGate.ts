/**
 * Canonical Catalog Gate Service
 *
 * Validates canonical catalog state against baseline for production gates.
 * Per RFC: gates use canonical_refresh_baseline view (not hard-coded counts).
 *
 * Gate Logic:
 * - current_sets_count >= baseline.sets_count (sets must not decrease)
 * - current_cards_count >= baseline.cards_count * 0.98 (cards must not drop >2%)
 */

import type Database from "better-sqlite3";
import type { Logger } from "pino";

export interface CanonicalBaseline {
  id: number;
  run_type: string;
  started_at: string;
  finished_at: string;
  sets_count: number;
  cards_count: number;
  coverage_ratio: number;
  status: string;
  notes: string | null;
}

export interface CanonicalCounts {
  sets: number;
  cards: number;
}

export interface GateResult {
  passed: boolean;
  reason: string | null;
  baseline: CanonicalBaseline | null;
  current: CanonicalCounts;
  details?: {
    setsGate: { expected: number; actual: number; passed: boolean };
    cardsGate: { expected: number; actual: number; threshold: number; passed: boolean };
  };
}

export class CanonicalGateService {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger
  ) {}

  /**
   * Check if canonical catalog tables exist
   */
  hasCanonicalTables(): boolean {
    const tables = ["canonical_sets", "canonical_cards", "canonical_refresh_runs"];
    for (const table of tables) {
      const result = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table) as { name: string } | undefined;
      if (!result) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get the baseline from canonical_refresh_baseline view
   */
  getBaseline(): CanonicalBaseline | null {
    try {
      const viewExists = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='view' AND name='canonical_refresh_baseline'`)
        .get() as { name: string } | undefined;

      if (!viewExists) {
        this.logger.warn("canonical_refresh_baseline view does not exist");
        return null;
      }

      const baseline = this.db
        .prepare(`SELECT * FROM canonical_refresh_baseline`)
        .get() as CanonicalBaseline | undefined;

      return baseline ?? null;
    } catch (error) {
      this.logger.error({ err: error }, "Failed to query canonical_refresh_baseline");
      return null;
    }
  }

  /**
   * Get current counts from canonical tables
   */
  getCurrentCounts(): CanonicalCounts {
    try {
      const setsRow = this.db
        .prepare(`SELECT COUNT(*) as count FROM canonical_sets`)
        .get() as { count: number } | undefined;
      const cardsRow = this.db
        .prepare(`SELECT COUNT(*) as count FROM canonical_cards`)
        .get() as { count: number } | undefined;

      return {
        sets: setsRow?.count ?? 0,
        cards: cardsRow?.count ?? 0,
      };
    } catch {
      return { sets: 0, cards: 0 };
    }
  }

  /**
   * Run gate validation against baseline
   *
   * Gate Logic (from RFC 3.2):
   * - Sets must not decrease: current_sets >= baseline.sets_count
   * - Cards must not drop >2%: current_cards >= baseline.cards_count * 0.98
   */
  validateGate(): GateResult {
    if (!this.hasCanonicalTables()) {
      return {
        passed: false,
        reason: "Canonical catalog tables not found",
        baseline: null,
        current: { sets: 0, cards: 0 },
      };
    }

    const baseline = this.getBaseline();
    const current = this.getCurrentCounts();

    if (!baseline) {
      return {
        passed: false,
        reason: "No baseline found (canonical_refresh_baseline returned empty)",
        baseline: null,
        current,
      };
    }

    const setsThreshold = baseline.sets_count;
    const cardsThreshold = Math.floor(baseline.cards_count * 0.98);

    const setsGatePassed = current.sets >= setsThreshold;
    const cardsGatePassed = current.cards >= cardsThreshold;

    if (!setsGatePassed) {
      return {
        passed: false,
        reason: `Sets gate failed: ${current.sets} < ${setsThreshold} (baseline)`,
        baseline,
        current,
        details: {
          setsGate: { expected: setsThreshold, actual: current.sets, passed: false },
          cardsGate: { expected: cardsThreshold, actual: current.cards, threshold: 0.98, passed: cardsGatePassed },
        },
      };
    }

    if (!cardsGatePassed) {
      return {
        passed: false,
        reason: `Cards gate failed: ${current.cards} < ${cardsThreshold} (98% of ${baseline.cards_count})`,
        baseline,
        current,
        details: {
          setsGate: { expected: setsThreshold, actual: current.sets, passed: true },
          cardsGate: { expected: cardsThreshold, actual: current.cards, threshold: 0.98, passed: false },
        },
      };
    }

    return {
      passed: true,
      reason: null,
      baseline,
      current,
      details: {
        setsGate: { expected: setsThreshold, actual: current.sets, passed: true },
        cardsGate: { expected: cardsThreshold, actual: current.cards, threshold: 0.98, passed: true },
      },
    };
  }

  /**
   * Check if canonical catalog is ready for use as primary source
   * (has tables, has baseline, passes gates)
   */
  isCanonicalReady(): { ready: boolean; reason: string } {
    if (!this.hasCanonicalTables()) {
      return { ready: false, reason: "Canonical tables missing" };
    }

    const current = this.getCurrentCounts();
    if (current.sets === 0) {
      return { ready: false, reason: "canonical_sets is empty" };
    }

    const gate = this.validateGate();
    if (!gate.passed) {
      return { ready: false, reason: gate.reason ?? "Gate validation failed" };
    }

    return { ready: true, reason: "Canonical catalog ready" };
  }
}
