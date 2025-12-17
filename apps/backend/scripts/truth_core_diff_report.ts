#!/usr/bin/env tsx
/**
 * Truth Core Diff Report Generator
 *
 * Generates a comprehensive diff report comparing canonical_sets vs cm_sets
 * for Kyle sign-off before Phase 3 (CSV deprecation).
 *
 * Usage:
 *   npm --prefix apps/backend run canonical:diff-report
 *
 * Output:
 *   - Console summary
 *   - exports/truth_core_diff_report.md (Markdown report for review)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDatabase } from "../src/db/connection";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CanonicalSet {
  ppt_set_id: string;
  name: string;
  series: string | null;
  release_date: string | null;
  card_count: number | null;
}

interface CmSet {
  cm_set_id: string;
  set_name: string;
  series: string | null;
  release_date: string | null;
  total_cards: number | null;
  ppt_id: string | null;
}

interface DiffResult {
  timestamp: string;
  canonical_count: number;
  cm_sets_count: number;
  matched: { canonical: CanonicalSet; cm_set: CmSet }[];
  only_in_canonical: CanonicalSet[];
  only_in_cm_sets: CmSet[];
  naming_differences: { canonical: CanonicalSet; cm_set: CmSet; diff: string }[];
  series_differences: { canonical: CanonicalSet; cm_set: CmSet }[];
}

function main() {
  const db = openDatabase();

  // Check if canonical tables exist
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_sets'`)
    .get() as { name: string } | undefined;

  if (!tableExists) {
    console.error("ERROR: canonical_sets table not found. Run canonical:refresh first.");
    process.exit(1);
  }

  // Load canonical sets
  const canonicalSets = db
    .prepare(
      `SELECT ppt_set_id, name, series, release_date, card_count
       FROM canonical_sets
       ORDER BY release_date DESC NULLS LAST, name COLLATE NOCASE ASC`
    )
    .all() as CanonicalSet[];

  // Load cm_sets
  const cmSets = db
    .prepare(
      `SELECT cm_set_id, set_name, series, release_date, total_cards, ppt_id
       FROM cm_sets
       ORDER BY release_date DESC NULLS LAST, set_name COLLATE NOCASE ASC`
    )
    .all() as CmSet[];

  // Build lookup maps (case-insensitive)
  const canonicalByName = new Map<string, CanonicalSet>();
  for (const cs of canonicalSets) {
    canonicalByName.set(cs.name.toLowerCase(), cs);
  }

  const cmByName = new Map<string, CmSet>();
  for (const cm of cmSets) {
    cmByName.set(cm.set_name.toLowerCase(), cm);
  }

  // Compute diffs
  const matched: DiffResult["matched"] = [];
  const onlyInCanonical: CanonicalSet[] = [];
  const onlyInCmSets: CmSet[] = [];
  const namingDifferences: DiffResult["naming_differences"] = [];
  const seriesDifferences: DiffResult["series_differences"] = [];

  // Find canonical sets that match or don't match cm_sets
  for (const cs of canonicalSets) {
    const cm = cmByName.get(cs.name.toLowerCase());
    if (cm) {
      matched.push({ canonical: cs, cm_set: cm });

      // Check for naming case differences
      if (cs.name !== cm.set_name) {
        namingDifferences.push({
          canonical: cs,
          cm_set: cm,
          diff: `"${cs.name}" vs "${cm.set_name}"`,
        });
      }

      // Check for series differences
      const csSeries = cs.series?.toLowerCase() ?? "";
      const cmSeries = cm.series?.toLowerCase() ?? "";
      if (csSeries !== cmSeries) {
        seriesDifferences.push({ canonical: cs, cm_set: cm });
      }
    } else {
      onlyInCanonical.push(cs);
    }
  }

  // Find cm_sets not in canonical
  for (const cm of cmSets) {
    if (!canonicalByName.has(cm.set_name.toLowerCase())) {
      onlyInCmSets.push(cm);
    }
  }

  const result: DiffResult = {
    timestamp: new Date().toISOString(),
    canonical_count: canonicalSets.length,
    cm_sets_count: cmSets.length,
    matched,
    only_in_canonical: onlyInCanonical,
    only_in_cm_sets: onlyInCmSets,
    naming_differences: namingDifferences,
    series_differences: seriesDifferences,
  };

  // Print summary
  console.log("\n=== Truth Core Diff Report ===");
  console.log(`Generated: ${result.timestamp}`);
  console.log(`\nCounts:`);
  console.log(`  Canonical sets: ${result.canonical_count}`);
  console.log(`  CM sets: ${result.cm_sets_count}`);
  console.log(`  Matched: ${result.matched.length}`);
  console.log(`\nDifferences:`);
  console.log(`  Only in canonical: ${result.only_in_canonical.length}`);
  console.log(`  Only in cm_sets: ${result.only_in_cm_sets.length}`);
  console.log(`  Naming differences: ${result.naming_differences.length}`);
  console.log(`  Series differences: ${result.series_differences.length}`);

  const matchRate = result.canonical_count > 0
    ? ((result.matched.length / result.canonical_count) * 100).toFixed(1)
    : "N/A";
  console.log(`\nMatch rate: ${matchRate}%`);

  // Generate Markdown report
  const reportPath = path.resolve(__dirname, "../exports/truth_core_diff_report.md");
  const report = generateMarkdownReport(result);

  // Ensure exports directory exists
  const exportsDir = path.dirname(reportPath);
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }

  fs.writeFileSync(reportPath, report);
  console.log(`\nReport written to: ${reportPath}`);

  db.close();

  // Exit with non-zero only if significant canonical sets are missing
  const significantMissing = result.only_in_canonical.filter(
    (cs) => !cs.name.toLowerCase().includes("[inactive]") && (cs.card_count ?? 0) > 0
  );

  if (significantMissing.length > 0) {
    console.log(`\n[WARN] ${significantMissing.length} significant canonical sets missing from cm_sets`);
    process.exit(1);
  }

  console.log("\n[OK] Canonical coverage validated - ready for Phase 3");
}

function generateMarkdownReport(result: DiffResult): string {
  const lines: string[] = [];

  lines.push("# Truth Core Diff Report");
  lines.push("");
  lines.push(`**Generated:** ${result.timestamp}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Canonical sets | ${result.canonical_count} |`);
  lines.push(`| CM sets | ${result.cm_sets_count} |`);
  lines.push(`| Matched | ${result.matched.length} |`);
  lines.push(`| Only in canonical | ${result.only_in_canonical.length} |`);
  lines.push(`| Only in cm_sets | ${result.only_in_cm_sets.length} |`);
  lines.push(`| Naming differences | ${result.naming_differences.length} |`);
  lines.push(`| Series differences | ${result.series_differences.length} |`);

  const matchRate = result.canonical_count > 0
    ? ((result.matched.length / result.canonical_count) * 100).toFixed(1)
    : "N/A";
  lines.push(`| **Match rate** | **${matchRate}%** |`);

  if (result.only_in_canonical.length > 0) {
    lines.push("");
    lines.push("## Sets Only in Canonical (not in cm_sets)");
    lines.push("");
    lines.push("These sets exist in the PPT catalog but are missing from cm_sets:");
    lines.push("");
    lines.push("| Set Name | Series | Release Date | Card Count |");
    lines.push("|----------|--------|--------------|------------|");
    for (const cs of result.only_in_canonical.slice(0, 50)) {
      lines.push(`| ${cs.name} | ${cs.series ?? "-"} | ${cs.release_date ?? "-"} | ${cs.card_count ?? "-"} |`);
    }
    if (result.only_in_canonical.length > 50) {
      lines.push(`| ... and ${result.only_in_canonical.length - 50} more | | | |`);
    }
  }

  if (result.only_in_cm_sets.length > 0) {
    lines.push("");
    lines.push("## Sets Only in cm_sets (not in Canonical)");
    lines.push("");
    lines.push("These sets exist in cm_sets but are missing from the canonical catalog:");
    lines.push("");
    lines.push("| Set Name | Series | Release Date | Total Cards |");
    lines.push("|----------|--------|--------------|-------------|");
    for (const cm of result.only_in_cm_sets.slice(0, 50)) {
      lines.push(`| ${cm.set_name} | ${cm.series ?? "-"} | ${cm.release_date ?? "-"} | ${cm.total_cards ?? "-"} |`);
    }
    if (result.only_in_cm_sets.length > 50) {
      lines.push(`| ... and ${result.only_in_cm_sets.length - 50} more | | | |`);
    }
  }

  if (result.naming_differences.length > 0) {
    lines.push("");
    lines.push("## Naming Differences (case/format variations)");
    lines.push("");
    lines.push("| Canonical Name | cm_sets Name |");
    lines.push("|----------------|--------------|");
    for (const nd of result.naming_differences.slice(0, 30)) {
      lines.push(`| ${nd.canonical.name} | ${nd.cm_set.set_name} |`);
    }
    if (result.naming_differences.length > 30) {
      lines.push(`| ... and ${result.naming_differences.length - 30} more | |`);
    }
  }

  if (result.series_differences.length > 0) {
    lines.push("");
    lines.push("## Series Differences");
    lines.push("");
    lines.push("| Set Name | Canonical Series | cm_sets Series |");
    lines.push("|----------|------------------|----------------|");
    for (const sd of result.series_differences.slice(0, 30)) {
      lines.push(`| ${sd.canonical.name} | ${sd.canonical.series ?? "(none)"} | ${sd.cm_set.series ?? "(none)"} |`);
    }
    if (result.series_differences.length > 30) {
      lines.push(`| ... and ${result.series_differences.length - 30} more | | |`);
    }
  }

  lines.push("");
  lines.push("## Recommendation");
  lines.push("");

  // What matters for Phase 3 is: are all canonical sets in cm_sets?
  // Extra sets in cm_sets (Japanese, Chinese, etc.) are fine to keep.
  const canonicalCoverage = result.canonical_count > 0
    ? (result.matched.length / result.canonical_count) * 100
    : 0;

  // Check if missing canonical sets are just inactive/empty sets
  const significantMissingCanonical = result.only_in_canonical.filter(
    (cs) => !cs.name.toLowerCase().includes("[inactive]") && (cs.card_count ?? 0) > 0
  );

  if (significantMissingCanonical.length === 0 && canonicalCoverage >= 98) {
    lines.push("**APPROVED FOR PHASE 3**: All significant canonical sets are present in cm_sets.");
    lines.push("");
    lines.push("The extra sets in cm_sets (Japanese, Chinese, Korean variants, etc.) are expected and acceptable.");
    lines.push("These don't affect canonical-first retrieval and can remain in the Truth Core dropdown.");
  } else if (significantMissingCanonical.length <= 3 && canonicalCoverage >= 95) {
    lines.push("**REVIEW NEEDED**: Minor gaps in canonical coverage. Review missing sets above.");
    lines.push("");
    lines.push(`Missing canonical sets that are significant: ${significantMissingCanonical.map(s => s.name).join(", ") || "none"}`);
  } else {
    lines.push("**NOT READY**: Significant canonical sets missing from cm_sets. Investigate before Phase 3.");
    lines.push("");
    lines.push(`Missing canonical sets: ${significantMissingCanonical.slice(0, 10).map(s => s.name).join(", ")}`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*Report generated by `npm run canonical:diff-report`*");

  return lines.join("\n");
}

main();
