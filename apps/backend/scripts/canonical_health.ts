#!/usr/bin/env tsx
/**
 * Canonical Health CLI
 *
 * Validates canonical_refresh_baseline gates and reports set/card coverage vs cm_sets.
 *
 * Usage:
 *   npm --prefix apps/backend run canonical:health
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDatabase } from "../src/db/connection";
import { CanonicalGateService } from "../src/services/canonical/canonicalGate";
import { runtimeConfig } from "../src/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type HealthResult = {
  gate: ReturnType<CanonicalGateService["validateGate"]>;
  canonical_counts: { sets: number; cards: number };
  cm_sets_count: number;
  cm_vs_canonical_delta_pct: number | null;
  diff: { only_in_canonical: string[]; only_in_cm_sets: string[] };
  status: "pass" | "fail";
};

function readCounts(db: Database.Database): { sets: number; cards: number } {
  const sets = db.prepare(`SELECT COUNT(*) as count FROM canonical_sets`).get() as { count: number };
  const cards = db.prepare(`SELECT COUNT(*) as count FROM canonical_cards`).get() as { count: number };
  return { sets: sets.count ?? 0, cards: cards.count ?? 0 };
}

function main() {
  // canonical.db lives at workspace root (../../.. from apps/backend/scripts)
  const canonicalPath = path.resolve(__dirname, "../../..", "canonical.db");
  const canonicalDb = new Database(canonicalPath);
  const gateService = new CanonicalGateService(canonicalDb, console as any);
  const gate = gateService.validateGate();

  const canonicalCounts = readCounts(canonicalDb);
  const appDb = openDatabase(); // cm_sets live here
  const cmSetsRow = appDb.prepare(`SELECT COUNT(*) as count FROM cm_sets`).get() as { count: number };

  const deltaPct =
    canonicalCounts.sets > 0
      ? ((cmSetsRow.count - canonicalCounts.sets) / canonicalCounts.sets) * 100
      : null;

  const canonicalNames = canonicalDb.prepare(`SELECT name FROM canonical_sets`).all() as Array<{ name: string }>;
  const cmNames = appDb.prepare(`SELECT set_name FROM cm_sets`).all() as Array<{ set_name: string }>;

  const canonicalSet = new Set(canonicalNames.map((s) => s.name.toLowerCase()));
  const cmSet = new Set(cmNames.map((s) => s.set_name.toLowerCase()));

  const onlyInCanonical = canonicalNames
    .filter((s) => !cmSet.has(s.name.toLowerCase()))
    .map((s) => s.name);
  const onlyInCm = cmNames
    .filter((s) => !canonicalSet.has(s.set_name.toLowerCase()))
    .map((s) => s.set_name);

  const result: HealthResult = {
    gate,
    canonical_counts: canonicalCounts,
    cm_sets_count: cmSetsRow.count ?? 0,
    cm_vs_canonical_delta_pct: deltaPct,
    diff: {
      only_in_canonical: onlyInCanonical,
      only_in_cm_sets: onlyInCm,
    },
    status: gate.passed ? "pass" : "fail",
  };

  console.log(JSON.stringify(result, null, 2));

  canonicalDb.close();
  appDb.close();

  if (!gate.passed) {
    process.exit(1);
  }
}

main();
