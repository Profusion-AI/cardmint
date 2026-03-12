/**
 * Scorecard artifact generator for CardMint Search pipeline evaluation.
 *
 * Replays golden queries against in-memory SQLite fixtures, computes:
 *   1. Wrong-set rate (Top-1)           — target: ≤1.0%
 *   2. High-confidence precision         — target: ≥97%
 *   3. Pipeline latency p95 (synthetic)  — informational baseline
 *   4. API latency p95 (HTTP)            — target: ≤350ms
 *
 * Usage: npm run eval   (or: npx tsx eval/runEval.ts)
 * Output: eval/artifacts/*.json
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import express, { type Request, type Response } from "express";
import { z } from "zod";

import { seedInventoryDb } from "../tests/fixtures/seedInventory.js";
import { seedReferenceDb } from "../tests/fixtures/seedReference.js";
import { InventoryAdapter } from "../src/retrieval/inventoryAdapter.js";
import { ReferenceAdapter } from "../src/retrieval/referenceAdapter.js";
import { runPipeline } from "../src/retrieval/searchPipeline.js";
import type { PipelineOptions } from "../src/retrieval/searchPipeline.js";
import type { SearchResult } from "../src/retrieval/types.js";
import { runSearch } from "../src/search/searchService.js";
import { goldenQueries, type GoldenQuery } from "./goldenQueries.js";

// ── Setup ──────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = join(__dirname, "artifacts");
mkdirSync(ARTIFACTS_DIR, { recursive: true });

const MIN_CONFIDENCE = 0.85;

const inventoryDb = seedInventoryDb();
const referenceDb = seedReferenceDb();

const pipelineOptions: PipelineOptions = {
  inventoryAdapter: new InventoryAdapter(inventoryDb),
  referenceAdapter: new ReferenceAdapter(referenceDb),
  minConfidence: MIN_CONFIDENCE,
};

// ── Phase 1: Pipeline replay (synthetic) ──────────────────────────────

interface QueryResult {
  query: string;
  expected: GoldenQuery["expected"];
  result: SearchResult;
  durationNs: bigint;
}

const results: QueryResult[] = [];

for (const gq of goldenQueries) {
  const start = process.hrtime.bigint();
  const result = runPipeline(gq.query, pipelineOptions);
  const end = process.hrtime.bigint();

  results.push({
    query: gq.query,
    expected: gq.expected,
    result,
    durationNs: end - start,
  });
}

// ── Metric 1: Wrong-set rate (Top-1) ──────────────────────────────────

interface WrongSetDetail {
  query: string;
  expectedSet: string;
  actualSet: string | null;
  confidence: number;
  reason: "wrong_set" | "unresolved";
}

const resolveExpected = results.filter((r) => r.expected.shouldResolve);
const actuallyResolved = resolveExpected.filter(
  (r) => r.result.status === "resolved",
);

const wrongSetDetails: WrongSetDetail[] = [];
let failCount = 0;

// Count wrong-set errors (resolved to wrong set)
for (const r of actuallyResolved) {
  const chosenSet = r.result.chosen?.setName ?? null;
  const expectedSet = r.expected.setName;
  if (chosenSet?.toLowerCase() !== expectedSet.toLowerCase()) {
    failCount++;
    wrongSetDetails.push({
      query: r.query,
      expectedSet,
      actualSet: chosenSet,
      confidence: r.result.chosen?.confidence ?? 0,
      reason: "wrong_set",
    });
  }
}

// Count unresolved errors (should have resolved but didn't)
const unresolvedExpected = resolveExpected.filter(
  (r) => r.result.status !== "resolved",
);
for (const r of unresolvedExpected) {
  failCount++;
  wrongSetDetails.push({
    query: r.query,
    expectedSet: r.expected.setName,
    actualSet: null,
    confidence: 0,
    reason: "unresolved",
  });
}

// Denominator is ALL shouldResolve queries, not just those that resolved
const wrongSetRate =
  resolveExpected.length > 0
    ? (failCount / resolveExpected.length) * 100
    : 0;

const wrongSetArtifact = {
  metric: "wrong_set_rate_top1",
  target: "<=1.0%",
  value: `${wrongSetRate.toFixed(2)}%`,
  status: wrongSetRate <= 1.0 ? "GREEN" : "RED",
  details: {
    totalShouldResolve: resolveExpected.length,
    actuallyResolved: actuallyResolved.length,
    unresolved: unresolvedExpected.length,
    wrongSet: failCount - unresolvedExpected.length,
    totalFails: failCount,
    failedQueries: wrongSetDetails,
  },
};

// ── Metric 2: High-confidence precision ───────────────────────────────

interface HighConfDetail {
  query: string;
  candidateCard: string;
  candidateSet: string;
  confidence: number;
  expectedCard: string;
  expectedSet: string;
  correct: boolean;
}

const highConfDetails: HighConfDetail[] = [];
let highConfTotal = 0;
let highConfCorrect = 0;

for (const r of results) {
  for (const candidate of r.result.candidates) {
    if (candidate.confidence >= MIN_CONFIDENCE) {
      highConfTotal++;

      // For shouldResolve=true: correct if card+set match ground truth.
      // For shouldResolve=false: any high-confidence candidate is an
      // overconfident mistake — the pipeline shouldn't resolve these.
      let correct: boolean;
      if (r.expected.shouldResolve) {
        const nameMatch =
          candidate.cardName.toLowerCase() ===
          r.expected.cardName.toLowerCase();
        const setMatch =
          candidate.setName.toLowerCase() === r.expected.setName.toLowerCase();
        correct = nameMatch && setMatch;
      } else {
        correct = false;
      }

      if (correct) highConfCorrect++;

      highConfDetails.push({
        query: r.query,
        candidateCard: candidate.cardName,
        candidateSet: candidate.setName,
        confidence: candidate.confidence,
        expectedCard: r.expected.cardName,
        expectedSet: r.expected.setName,
        correct,
      });
    }
  }
}

const highConfPrecision =
  highConfTotal > 0 ? (highConfCorrect / highConfTotal) * 100 : 100;

const highConfArtifact = {
  metric: "high_confidence_precision",
  target: ">=97%",
  value: `${highConfPrecision.toFixed(2)}%`,
  status: highConfPrecision >= 97 ? "GREEN" : "RED",
  details: {
    totalHighConfCandidates: highConfTotal,
    correct: highConfCorrect,
    incorrect: highConfTotal - highConfCorrect,
    queries: highConfDetails,
  },
};

// ── Metric 3: Pipeline latency p95 (synthetic) ───────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

const pipelineDurations = results
  .map((r) => Number(r.durationNs) / 1_000_000)
  .sort((a, b) => a - b);

const pipelineP50 = percentile(pipelineDurations, 50);
const pipelineP95 = percentile(pipelineDurations, 95);
const pipelineP99 = percentile(pipelineDurations, 99);

const pipelineLatencyArtifact = {
  metric: "pipeline_latency_p95",
  note: "Synthetic: in-process runPipeline() over in-memory SQLite. Not a substitute for HTTP latency.",
  value: `${pipelineP95.toFixed(2)}ms`,
  details: {
    p50: `${pipelineP50.toFixed(2)}ms`,
    p95: `${pipelineP95.toFixed(2)}ms`,
    p99: `${pipelineP99.toFixed(2)}ms`,
    queryCount: pipelineDurations.length,
    perQuery: results.map((r) => ({
      query: r.query,
      durationMs: (Number(r.durationNs) / 1_000_000).toFixed(3),
    })),
  },
};

// ── Metric 4: API latency p95 (HTTP) ─────────────────────────────────

const SearchRequestSchema = z.object({
  query: z.string().min(1),
  candidates: z.array(z.unknown()).optional().default([]),
});

function createEvalServer(): express.Express {
  const app = express();
  app.use(express.json());

  app.post("/api/search", (req: Request, res: Response) => {
    const parsed = SearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "BAD_REQUEST" });
    }
    const result = runSearch(parsed.data.query, [], MIN_CONFIDENCE, pipelineOptions);
    res.json({ ...result, stage: "internal_dev", minConfidence: MIN_CONFIDENCE });
  });

  return app;
}

async function httpPost(
  port: number,
  body: unknown,
): Promise<{ status: number; durationMs: number }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/search",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          const end = process.hrtime.bigint();
          resolve({
            status: res.statusCode ?? 0,
            durationMs: Number(end - start) / 1_000_000,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function runHttpBenchmark(): Promise<typeof apiLatencyArtifact> {
  const app = createEvalServer();
  const server = app.listen(0); // random available port
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  // Warmup: 3 requests to prime JIT + Express internals
  for (let i = 0; i < 3; i++) {
    await httpPost(port, { query: "warmup" });
  }

  // Benchmark
  const httpDurations: { query: string; durationMs: number }[] = [];

  for (const gq of goldenQueries) {
    const { durationMs } = await httpPost(port, { query: gq.query });
    httpDurations.push({ query: gq.query, durationMs });
  }

  server.close();

  const sorted = httpDurations.map((d) => d.durationMs).sort((a, b) => a - b);
  const httpP50 = percentile(sorted, 50);
  const httpP95 = percentile(sorted, 95);
  const httpP99 = percentile(sorted, 99);

  return {
    metric: "api_latency_p95",
    target: "<=350ms",
    value: `${httpP95.toFixed(2)}ms`,
    status: httpP95 <= 350 ? "GREEN" : "RED",
    details: {
      note: "Real HTTP POST /api/search with Express routing, Zod validation, JSON serialization. In-memory SQLite fixtures.",
      p50: `${httpP50.toFixed(2)}ms`,
      p95: `${httpP95.toFixed(2)}ms`,
      p99: `${httpP99.toFixed(2)}ms`,
      queryCount: httpDurations.length,
      perQuery: httpDurations.map((d) => ({
        query: d.query,
        durationMs: d.durationMs.toFixed(3),
      })),
    },
  };
}

// Placeholder for type reference in the function return type
let apiLatencyArtifact: {
  metric: string;
  target: string;
  value: string;
  status: string;
  details: {
    note: string;
    p50: string;
    p95: string;
    p99: string;
    queryCount: number;
    perQuery: { query: string; durationMs: string }[];
  };
};

// ── Metric 5: Source transparency coverage ────────────────────────────

interface TransparencyDetail {
  query: string;
  candidateCard: string;
  candidateSet: string;
  hasSourceLabel: boolean;
  hasFreshness: boolean;
  hasPriceData: boolean;
  compliant: boolean;
}

const transparencyDetails: TransparencyDetail[] = [];
let priceBearingTotal = 0;
let priceBearingCompliant = 0;

for (const r of results) {
  for (const candidate of r.result.candidates) {
    const hasPriceData = candidate.marketPrice !== null && candidate.marketPrice > 0;
    if (!hasPriceData) continue;

    priceBearingTotal++;

    const hasSourceLabel = candidate.sourceLabel === "internal_truth" || candidate.sourceLabel === "reference_aggregate";
    // Inventory candidates have null freshness (acceptable — they're live truth).
    // Reference candidates must have non-null freshness.
    const hasFreshness = candidate.sourceLabel === "internal_truth" || candidate.freshness !== null;
    const compliant = hasSourceLabel && hasFreshness;

    if (compliant) priceBearingCompliant++;

    transparencyDetails.push({
      query: r.query,
      candidateCard: candidate.cardName,
      candidateSet: candidate.setName,
      hasSourceLabel,
      hasFreshness,
      hasPriceData,
      compliant,
    });
  }
}

const transparencyCoverage =
  priceBearingTotal > 0 ? (priceBearingCompliant / priceBearingTotal) * 100 : 100;

const transparencyArtifact = {
  metric: "source_transparency_coverage",
  target: "100%",
  value: `${transparencyCoverage.toFixed(2)}%`,
  status: transparencyCoverage >= 100 ? "GREEN" : transparencyCoverage >= 99 ? "YELLOW" : "RED",
  details: {
    priceBearingCandidates: priceBearingTotal,
    compliant: priceBearingCompliant,
    nonCompliant: priceBearingTotal - priceBearingCompliant,
    candidates: transparencyDetails,
  },
};

// ── Metric 6: Normalization parity (X vs X/Y) ──────────────────────

interface ParityPair {
  queryX: string;
  queryXY: string;
  topCandidateX: string | null;
  topCandidateXY: string | null;
  match: boolean;
}

const parityPairs: [string, string][] = [
  ["Charizard Base Set 4", "Charizard Base Set 4/102"],
  ["Pikachu Base Set 58", "Pikachu Base Set 58/102"],
  ["Flareon Jungle 3", "Flareon Jungle 3/064"],
  ["Charizard Evolutions 11", "Charizard Evolutions 011/108"],
  ["Dark Gyarados Team Rocket 8", "Dark Gyarados Team Rocket 8/082"],
  ["Venusaur Base Set 15", "Venusaur Base Set 15/102"],
  ["Gengar Fossil 5", "Gengar Fossil 5/062"],
  ["Dragonite Fossil 4", "Dragonite Fossil 4/062"],
  ["Vaporeon Jungle 12", "Vaporeon Jungle 12/064"],
  ["Ting-Lu ex Paldea Evolved 105", "Ting-Lu ex Paldea Evolved 105/193"],
];

const parityDetails: ParityPair[] = [];

for (const [qX, qXY] of parityPairs) {
  const resultX = runPipeline(qX, pipelineOptions);
  const resultXY = runPipeline(qXY, pipelineOptions);

  const topX = resultX.chosen?.cardName ?? resultX.candidates[0]?.cardName ?? null;
  const topXY = resultXY.chosen?.cardName ?? resultXY.candidates[0]?.cardName ?? null;

  const topSetX = resultX.chosen?.setName ?? resultX.candidates[0]?.setName ?? null;
  const topSetXY = resultXY.chosen?.setName ?? resultXY.candidates[0]?.setName ?? null;

  const match = topX === topXY && topSetX === topSetXY;

  parityDetails.push({
    queryX: qX,
    queryXY: qXY,
    topCandidateX: topX ? `${topX} (${topSetX})` : null,
    topCandidateXY: topXY ? `${topXY} (${topSetXY})` : null,
    match,
  });
}

const parityMatches = parityDetails.filter((p) => p.match).length;
const parityRate = parityPairs.length > 0 ? (parityMatches / parityPairs.length) * 100 : 100;

const normalizationParityArtifact = {
  metric: "normalization_parity",
  target: ">=99.5%",
  value: `${parityRate.toFixed(2)}%`,
  status: parityRate >= 99.5 ? "GREEN" : parityRate >= 98 ? "YELLOW" : "RED",
  details: {
    totalPairs: parityPairs.length,
    matched: parityMatches,
    mismatched: parityPairs.length - parityMatches,
    pairs: parityDetails,
  },
};

// ── Metric 7: Duplicate stability (progress match) ─────────────────

// Re-seed a separate DB with extra duplicates and compare results
import Database from "better-sqlite3";

function seedDuplicateInventoryDb(): Database.Database {
  const db = seedInventoryDb();

  const now = Date.now();
  const insertProduct = db.prepare(`
    INSERT INTO products (product_uid, cm_card_id, condition_bucket, product_sku, listing_sku,
      card_name, set_name, collector_no, rarity, market_price, total_quantity, cdn_image_url,
      evershop_sync_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Add 5 extra NM copies of Charizard Base Set
  for (let i = 0; i < 5; i++) {
    insertProduct.run(`prod-char-extra-${i}`, "card-charizard-base", "NM", `SKU-CHAR-X${i}`, `LSK-CHAR-X${i}`,
      "Charizard", "Base Set", "4/102", "Rare Holo", 345 - i, 1, null, "synced", now, now);
  }

  // Add 3 extra NM copies of Pikachu Base Set
  for (let i = 0; i < 3; i++) {
    insertProduct.run(`prod-pika-extra-${i}`, "card-pikachu-base", "NM", `SKU-PIKA-X${i}`, `LSK-PIKA-X${i}`,
      "Pikachu", "Base Set", "58/102", "Common", 14 - i, 1, null, "synced", now, now);
  }

  return db;
}

interface StabilityDetail {
  query: string;
  baselineTop: string | null;
  duplicatedTop: string | null;
  stable: boolean;
}

const stabilityQueries = [
  "Charizard Base Set 4/102",
  "Pikachu Base Set 58/102",
  "Charizard Base Set 4",
  "Pikachu Base Set 58",
  "Charizard",
  "Pikachu",
];

const dupDb = seedDuplicateInventoryDb();
const dupPipelineOptions: PipelineOptions = {
  inventoryAdapter: new InventoryAdapter(dupDb),
  referenceAdapter: new ReferenceAdapter(referenceDb),
  minConfidence: MIN_CONFIDENCE,
};

const stabilityDetails: StabilityDetail[] = [];

for (const q of stabilityQueries) {
  const baseline = runPipeline(q, pipelineOptions);
  const duplicated = runPipeline(q, dupPipelineOptions);

  const baseTop = baseline.chosen?.cardName ?? baseline.candidates[0]?.cardName ?? null;
  const dupTop = duplicated.chosen?.cardName ?? duplicated.candidates[0]?.cardName ?? null;

  const baseSet = baseline.chosen?.setName ?? baseline.candidates[0]?.setName ?? null;
  const dupSet = duplicated.chosen?.setName ?? duplicated.candidates[0]?.setName ?? null;

  const stable = baseTop === dupTop && baseSet === dupSet &&
    baseline.status === duplicated.status;

  stabilityDetails.push({
    query: q,
    baselineTop: baseTop ? `${baseTop} (${baseSet})` : null,
    duplicatedTop: dupTop ? `${dupTop} (${dupSet})` : null,
    stable,
  });
}

dupDb.close();

const stableCount = stabilityDetails.filter((s) => s.stable).length;
const stabilityRate = stabilityQueries.length > 0
  ? (stableCount / stabilityQueries.length) * 100 : 100;

const duplicateStabilityArtifact = {
  metric: "duplicate_stability",
  target: "<=0.5% variance",
  value: `${(100 - stabilityRate).toFixed(2)}% variance`,
  status: (100 - stabilityRate) <= 0.5 ? "GREEN" : (100 - stabilityRate) <= 2 ? "YELLOW" : "RED",
  details: {
    totalQueries: stabilityQueries.length,
    stable: stableCount,
    unstable: stabilityQueries.length - stableCount,
    variance: `${(100 - stabilityRate).toFixed(2)}%`,
    queries: stabilityDetails,
  },
};

// ── Write artifacts ──────────────────────────────────────────────────

function writeArtifact(name: string, data: unknown): void {
  const path = join(ARTIFACTS_DIR, name);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`  ${path}`);
}

async function main() {
  // Run HTTP benchmark
  apiLatencyArtifact = await runHttpBenchmark();

  console.log("\n=== CardMint Search Scorecard Evaluation ===\n");
  console.log(`Queries: ${goldenQueries.length}`);
  console.log(`minConfidence: ${MIN_CONFIDENCE}\n`);

  console.log(`1. Wrong-set rate (Top-1): ${wrongSetArtifact.value}  [${wrongSetArtifact.status}]`);
  console.log(`   ${resolveExpected.length} should resolve, ${actuallyResolved.length} resolved, ${unresolvedExpected.length} unresolved, ${failCount} fails`);

  console.log(`2. High-conf precision:    ${highConfArtifact.value}  [${highConfArtifact.status}]`);
  console.log(`   ${highConfTotal} high-conf candidates, ${highConfCorrect} correct`);

  console.log(`3. Pipeline latency p95:   ${pipelineLatencyArtifact.value}  (synthetic baseline)`);
  console.log(`   p50=${pipelineP50.toFixed(2)}ms  p95=${pipelineP95.toFixed(2)}ms  p99=${pipelineP99.toFixed(2)}ms`);

  console.log(`4. API latency p95 (HTTP): ${apiLatencyArtifact.value}  [${apiLatencyArtifact.status}]`);
  console.log(`   p50=${apiLatencyArtifact.details.p50}  p95=${apiLatencyArtifact.details.p95}  p99=${apiLatencyArtifact.details.p99}`);

  console.log(`5. Source transparency:    ${transparencyArtifact.value}  [${transparencyArtifact.status}]`);
  console.log(`   ${priceBearingTotal} price-bearing candidates, ${priceBearingCompliant} compliant`);

  console.log(`6. Normalization parity:   ${normalizationParityArtifact.value}  [${normalizationParityArtifact.status}]`);
  console.log(`   ${parityPairs.length} pairs, ${parityMatches} matched`);

  console.log(`7. Duplicate stability:    ${duplicateStabilityArtifact.value}  [${duplicateStabilityArtifact.status}]`);
  console.log(`   ${stabilityQueries.length} queries, ${stableCount} stable`);

  const allGreen =
    wrongSetArtifact.status === "GREEN" &&
    highConfArtifact.status === "GREEN" &&
    apiLatencyArtifact.status === "GREEN" &&
    transparencyArtifact.status === "GREEN" &&
    normalizationParityArtifact.status === "GREEN" &&
    duplicateStabilityArtifact.status === "GREEN";

  console.log(`\nOverall: ${allGreen ? "GREEN" : "RED"}\n`);
  console.log("Artifacts:");
  writeArtifact("wrong-set-rate.json", wrongSetArtifact);
  writeArtifact("high-confidence-precision.json", highConfArtifact);
  writeArtifact("pipeline-latency-p95.json", pipelineLatencyArtifact);
  writeArtifact("api-latency-p95.json", apiLatencyArtifact);
  writeArtifact("source-transparency.json", transparencyArtifact);
  writeArtifact("normalization-parity.json", normalizationParityArtifact);
  writeArtifact("duplicate-stability.json", duplicateStabilityArtifact);

  console.log("");

  // Cleanup
  inventoryDb.close();
  referenceDb.close();

  if (!allGreen) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(2);
});
