import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { loadEnv } from "./config/env.js";
import { runSearch, type SearchCandidate } from "./search/searchService.js";
import { TfIdfVectorAdapter } from "./retrieval/vectorAdapter.js";
import { openDbPool, closeDbPool, getDbStatus, type DbPool } from "./db/connection.js";
import { InventoryAdapter } from "./retrieval/inventoryAdapter.js";
import { ReferenceAdapter } from "./retrieval/referenceAdapter.js";
import type { PipelineOptions } from "./retrieval/searchPipeline.js";
import { QueryTelemetry, confidenceBucket } from "./telemetry/queryTelemetry.js";
import { generateScorecard } from "./telemetry/scorecardReport.js";
import { resolveTier, getTierPolicy } from "./policy/deviceTier.js";

const env = loadEnv();
const app = express();
const telemetry = new QueryTelemetry();
const deviceTier = resolveTier(env.deviceTier);
const tierPolicy = getTierPolicy(deviceTier);

// Init DB pool (per-DB resilient — each DB fails independently)
const dbPool: DbPool = openDbPool(env.inventoryDbPath, env.referenceDbPath);

const inventoryAdapter = dbPool.inventory ? new InventoryAdapter(dbPool.inventory) : null;
const referenceAdapter = dbPool.reference ? new ReferenceAdapter(dbPool.reference) : null;

let pipelineOptions: PipelineOptions | null = null;
if (inventoryAdapter || referenceAdapter) {
  pipelineOptions = {
    inventoryAdapter,
    referenceAdapter,
    minConfidence: env.minConfidence,
  };
}

// Wire vector adapter when enabled by both config and tier policy
const vectorEnabled = env.vectorEnabled && tierPolicy.vectorSearchEnabled;
if (pipelineOptions && vectorEnabled) {
  pipelineOptions.vectorAdapter = new TfIdfVectorAdapter();
}

const status = getDbStatus(dbPool);
console.log(
  `[cardmint-search-app] DB pool: inventory=${status.inventory.connected ? `connected (${status.inventory.productCount ?? "?"} in-stock products)` : "unavailable"} reference=${status.reference.connected ? `connected (${status.reference.corpusCount ?? "?"} corpus rows)` : "unavailable"}`
);

app.use(express.json());

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!env.requireAuth || !req.path.startsWith("/api/")) {
    return next();
  }

  const apiKey = req.header("x-search-api-key");
  if (apiKey !== env.apiKey) {
    return res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Missing or invalid x-search-api-key"
    });
  }

  next();
});

app.get("/health", (_req: Request, res: Response) => {
  const dbStatus = getDbStatus(dbPool);
  res.json({
    ok: true,
    service: "cardmint-search-app",
    stage: env.stage,
    externalTrafficAllowed: env.stage === "trusted_alpha" || env.stage === "public_beta",
    deviceTier,
    vectorSearchEnabled: tierPolicy.vectorSearchEnabled,
    vectorAdapterActive: vectorEnabled,
    db: dbStatus,
    telemetry: { bufferedQueries: telemetry.size, corrections: telemetry.correctionCount },
  });
});

const CandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  confidence: z.number().min(0).max(1),
  source: z.enum(["internal_inventory", "canonical_index", "reference_market"])
});

const SearchRequestSchema = z.object({
  query: z.string().min(1),
  candidates: z.array(CandidateSchema).optional().default([])
});

app.post("/api/search", (req: Request, res: Response) => {
  const parsed = SearchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "BAD_REQUEST",
      message: "Invalid search payload"
    });
  }

  const start = process.hrtime.bigint();
  const body = parsed.data;
  const candidates = body.candidates as SearchCandidate[];
  const result = runSearch(body.query, candidates, env.minConfidence, pipelineOptions);
  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  // Record telemetry
  const topConf = result.chosen?.confidence ?? result.candidates[0]?.confidence ?? null;
  telemetry.record({
    timestamp: Date.now(),
    query: body.query,
    durationMs,
    status: result.status,
    confidenceBucket: confidenceBucket(topConf),
    sourceLabel: result.sourceLabel,
    retrievalPath: result.retrievalPath,
    candidateCount: result.candidates.length,
  });

  res.json({
    ...result,
    stage: env.stage,
    minConfidence: env.minConfidence,
    deviceTier,
  });
});

app.get("/api/scorecard", (_req: Request, res: Response) => {
  const windowMs = 3_600_000; // 1 hour default
  const report = generateScorecard(telemetry, windowMs);
  res.json({
    ...report,
    stage: env.stage,
    deviceTier,
    tierPolicy,
  });
});

const server = app.listen(env.port, () => {
  console.log(
    `[cardmint-search-app] listening on :${env.port} stage=${env.stage} auth=${env.requireAuth ? "on" : "off"}`
  );
});

// Graceful shutdown
process.on("SIGTERM", () => {
  server.close(() => {
    closeDbPool(dbPool);
    process.exit(0);
  });
});
