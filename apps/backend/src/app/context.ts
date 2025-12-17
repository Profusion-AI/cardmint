/**
 * AppContext: Composition root for CardMint backend.
 *
 * This module defines the application context interface and the createContext()
 * factory that wires up all services, repositories, and workers. By isolating
 * the wiring here, server.ts becomes a thin HTTP adapter that routes requests
 * to the appropriate handlers.
 *
 * Phase 1 of server.ts decomposition (Nov 2025).
 */

import pino, { type Logger } from "pino";
import type { Database } from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { parse as parseCsvSync } from "csv-parse/sync";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { runtimeConfig } from "../config";
import { openDatabase } from "../db/connection";
import { JobRepository } from "../repositories/jobRepository";
import { SessionRepository } from "../repositories/sessionRepository";
import { JobQueue } from "../services/jobQueue";
import { CaptureAdapter } from "../services/captureAdapter";
import { RetrievalService } from "../services/retrieval/retrievalService";
import { JobWorker } from "../services/jobWorker";
import { MetricsCollector } from "../services/metricsCollector";
import { SftpWatchFolderIngestion } from "../services/sftpWatchFolderIngestion";
import { DistortionCorrectionService } from "../services/distortionCorrection";
import { ImageProcessingService } from "../services/imageProcessing";
import { SessionService } from "../services/sessionService";
import { SKUCanonicalizer } from "../services/inventory/skuHelpers";
import { InventoryService } from "../services/inventory/inventoryService";
import { InventoryOverrideService } from "../services/inventory/inventoryOverrideService";
import { JobManifestWriter } from "../services/jobManifestWriter";
import { ImageHostingService } from "../services/imageHosting";
import { ListingImageService } from "../services/listingImageService";
import { PriceChartingRepository } from "../services/retrieval/pricechartingRepository";
import { PokePriceTrackerAdapter } from "../services/pricing/pptAdapter";
import type { PPTConfig } from "../services/pricing/types";
import { CanonicalGateService } from "../services/canonical/canonicalGate";
import { Stage3PromotionService } from "../services/stage3Promotion";
import { StripeService } from "../services/stripeService";
import { StripeExpiryJob } from "../services/stripeExpiryJob";
import { ImportSafeguardsService } from "../services/importer/importSafeguards";
import { SetTriangulator } from "../services/setTriangulator";
import { KlaviyoService } from "../services/klaviyoService";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MASTER_SETLIST_PATH = path.resolve(__dirname, "../../../../data/mastersetlist.csv");

// -----------------------------------------------------------------------------
// AppContext interface
// -----------------------------------------------------------------------------

export interface AppContext {
  logger: Logger;
  db: Database;
  queue: JobQueue;
  jobRepo: JobRepository;
  sessionRepo: SessionRepository;
  sessionService: SessionService;
  captureAdapter: CaptureAdapter;
  retrievalService: RetrievalService;
  inventoryService: InventoryService;
  inventoryOverrideService: InventoryOverrideService;
  skuCanonicalizer: SKUCanonicalizer;
  distortionCorrection: DistortionCorrectionService;
  imageProcessing: ImageProcessingService;
  imageHostingService: ImageHostingService;
  listingImageService: ListingImageService;
  metricsCollector: MetricsCollector;
  manifestWriter: JobManifestWriter;
  jobWorker: JobWorker;
  sftpWatcher: SftpWatchFolderIngestion | null;
  priceChartingRepo: PriceChartingRepository;
  pptAdapter: PokePriceTrackerAdapter;
  stage3Promotion: Stage3PromotionService;
  stripeService: StripeService;
  stripeExpiryJob: StripeExpiryJob;
  importSafeguards: ImportSafeguardsService;
  klaviyoService: KlaviyoService;

  // Shutdown state and helpers
  isShuttingDown: () => boolean;
  setShuttingDown: (value: boolean) => void;
}

// -----------------------------------------------------------------------------
// Logger factory
// -----------------------------------------------------------------------------

export function createLogger(): Logger {
  const destination = pino.destination({ sync: process.env.NODE_ENV !== "production" });
  destination.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EINTR") return;
    console.error("pino destination error", err);
  });
  return pino({ level: runtimeConfig.logLevel ?? "info" }, destination);
}

// -----------------------------------------------------------------------------
// Database bootstrap helpers
// -----------------------------------------------------------------------------

export function assertCanonicalCatalogReady(db: Database, logger: Logger): void {
  const hasCardsTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cm_cards' LIMIT 1`)
    .get() as { name: string } | undefined;

  if (!hasCardsTable) {
    throw new Error(
      `[startup] cm_cards table missing. Check SQLITE_DB (${runtimeConfig.sqlitePath}) points to the canonical catalog database.`
    );
  }

  const cardCountRow = db.prepare(`SELECT COUNT(*) as count FROM cm_cards`).get() as { count: number } | undefined;
  if (!cardCountRow || cardCountRow.count === 0) {
    throw new Error(
      `[startup] cm_cards is empty. Ensure SQLITE_DB (${runtimeConfig.sqlitePath}) is the populated CardMint catalog (not an empty stub).`
    );
  }
}

type MasterSetRow = {
  set_name?: string;
  series?: string;
  release_date?: string;
  card_count?: string | number;
  tcgplayer_id?: string;
  ppt_id?: string;
};

function parseReleaseYear(dateStr?: string): number | null {
  if (!dateStr) return null;
  const match = dateStr.match(/^(\d{4})/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) ? year : null;
}

function parseCardCount(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  const num = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(num) ? num : null;
}

function deriveSetId(row: MasterSetRow, existingIds: Set<string>): string {
  const raw = row.tcgplayer_id || row.ppt_id || row.set_name || "UNKNOWN_SET";
  const base = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);

  const fallback = `SET_${createHash("sha256").update(raw).digest("hex").slice(0, 6).toUpperCase()}`;

  const normalized = base || fallback;
  let candidate = normalized;
  let suffix = 1;
  while (existingIds.has(candidate)) {
    const suffixStr = `_${suffix}`;
    const trimmedBase = normalized.slice(0, Math.max(1, 32 - suffixStr.length));
    candidate = `${trimmedBase}${suffixStr}`;
    suffix += 1;
    if (suffix > 9999) {
      throw new Error(`[startup] deriveSetId exhausted suffix space for raw value "${raw}"`);
    }
  }
  return candidate;
}

export function seedMasterSetsFromCsv(db: Database, logger: Logger, csvPath = MASTER_SETLIST_PATH): void {
  if (!fs.existsSync(csvPath)) {
    throw new Error(
      `[startup] Master set list not found at ${csvPath}. Ensure data/mastersetlist.csv is present before starting backend.`
    );
  }

  const csvContent = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsvSync(csvContent, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as MasterSetRow[];

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`[startup] Master set list parsed empty results from ${csvPath}`);
  }

  const now = Date.now();
  const existing = db
    .prepare(`SELECT cm_set_id, set_name FROM cm_sets`)
    .all() as { cm_set_id: string; set_name: string }[];

  const existingByName = new Map<string, string>();
  const existingIds = new Set<string>();
  for (const row of existing) {
    existingByName.set(row.set_name.toLowerCase(), row.cm_set_id);
    existingIds.add(row.cm_set_id);
  }

  const upsertStmt = db.prepare(`
    INSERT INTO cm_sets (
      cm_set_id, set_name, release_date, release_year, total_cards, series, ptcgo_code, notes, created_at, updated_at
    ) VALUES (@cm_set_id, @set_name, @release_date, @release_year, @total_cards, @series, @ptcgo_code, @notes, @created_at, @updated_at)
    ON CONFLICT(cm_set_id) DO UPDATE SET
      set_name = excluded.set_name,
      release_date = excluded.release_date,
      release_year = excluded.release_year,
      total_cards = excluded.total_cards,
      series = excluded.series,
      updated_at = excluded.updated_at
  `);

  const upsertTx = db.transaction((records: MasterSetRow[]) => {
    for (const record of records) {
      const setName = record.set_name?.trim();
      if (!setName) {
        continue;
      }

      const cm_set_id =
        existingByName.get(setName.toLowerCase()) ??
        deriveSetId(record, existingIds);

      existingIds.add(cm_set_id);

      const release_date = record.release_date?.trim() || null;
      const payload = {
        cm_set_id,
        set_name: setName,
        release_date,
        release_year: parseReleaseYear(release_date ?? undefined),
        total_cards: parseCardCount(record.card_count),
        series: record.series?.trim() || null,
        ptcgo_code: null,
        notes: null,
        created_at: now,
        updated_at: now,
      };

      upsertStmt.run(payload);
    }
  });

  upsertTx(rows);

  const finalCount = db.prepare(`SELECT COUNT(*) as count FROM cm_sets`).get() as { count: number } | undefined;
  logger.info(
    {
      csvPath,
      sets_ingested: rows.length,
      sets_total: finalCount?.count ?? 0,
    },
    "Master set list synced to cm_sets"
  );
}

// -----------------------------------------------------------------------------
// Canonical-first startup seed (Phase 1)
// -----------------------------------------------------------------------------

interface CanonicalSetRow {
  ppt_set_id: string;
  tcg_player_id: string;
  name: string;
  series: string | null;
  release_date: string | null;
  card_count: number | null;
}

export function seedMasterSetsFromCanonical(db: Database, logger: Logger): boolean {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_sets'`)
    .get() as { name: string } | undefined;

  if (!tableExists) {
    logger.warn("[startup] canonical_sets table not found, cannot seed from canonical");
    return false;
  }

  const canonicalCount = db
    .prepare(`SELECT COUNT(*) as count FROM canonical_sets`)
    .get() as { count: number } | undefined;

  if (!canonicalCount || canonicalCount.count === 0) {
    logger.warn("[startup] canonical_sets is empty, cannot seed from canonical");
    return false;
  }

  const rows = db
    .prepare(
      `SELECT ppt_set_id, tcg_player_id, name, series, release_date, card_count
       FROM canonical_sets
       WHERE card_count > 0 OR card_count IS NULL`
    )
    .all() as CanonicalSetRow[];

  if (rows.length === 0) {
    logger.warn("[startup] canonical_sets returned 0 sets with card_count > 0");
    return false;
  }

  const now = Date.now();
  const existing = db
    .prepare(`SELECT cm_set_id, set_name FROM cm_sets`)
    .all() as { cm_set_id: string; set_name: string }[];

  const existingByName = new Map<string, string>();
  const existingIds = new Set<string>();
  for (const row of existing) {
    existingByName.set(row.set_name.toLowerCase(), row.cm_set_id);
    existingIds.add(row.cm_set_id);
  }

  const upsertStmt = db.prepare(`
    INSERT INTO cm_sets (
      cm_set_id, set_name, release_date, release_year, total_cards, series, ptcgo_code, notes, created_at, updated_at, ppt_id, tcgplayer_id
    ) VALUES (@cm_set_id, @set_name, @release_date, @release_year, @total_cards, @series, @ptcgo_code, @notes, @created_at, @updated_at, @ppt_id, @tcgplayer_id)
    ON CONFLICT(cm_set_id) DO UPDATE SET
      set_name = excluded.set_name,
      release_date = excluded.release_date,
      release_year = excluded.release_year,
      total_cards = excluded.total_cards,
      series = excluded.series,
      ppt_id = excluded.ppt_id,
      tcgplayer_id = excluded.tcgplayer_id,
      updated_at = excluded.updated_at
  `);

  const upsertTx = db.transaction((records: CanonicalSetRow[]) => {
    for (const record of records) {
      const setName = record.name?.trim();
      if (!setName) {
        continue;
      }

      const cm_set_id =
        existingByName.get(setName.toLowerCase()) ??
        deriveSetId({ set_name: setName, tcgplayer_id: record.tcg_player_id, ppt_id: record.ppt_set_id }, existingIds);

      existingIds.add(cm_set_id);

      const release_date = record.release_date?.trim() || null;
      const payload = {
        cm_set_id,
        set_name: setName,
        release_date,
        release_year: parseReleaseYear(release_date ?? undefined),
        total_cards: record.card_count,
        series: record.series?.trim() || null,
        ptcgo_code: null,
        notes: null,
        created_at: now,
        updated_at: now,
        ppt_id: record.ppt_set_id,
        tcgplayer_id: record.tcg_player_id,
      };

      upsertStmt.run(payload);
    }
  });

  upsertTx(rows);

  const finalCount = db.prepare(`SELECT COUNT(*) as count FROM cm_sets`).get() as { count: number } | undefined;
  logger.info(
    {
      source: "canonical_sets",
      sets_ingested: rows.length,
      sets_total: finalCount?.count ?? 0,
    },
    "Master set list synced to cm_sets from canonical"
  );

  return true;
}

export function syncMasterSets(db: Database, logger: Logger, csvPath = MASTER_SETLIST_PATH): void {
  // Phase 3 feature flags control seed behavior
  if (runtimeConfig.canonicalSeedEnabled) {
    const canonicalSuccess = seedMasterSetsFromCanonical(db, logger);

    if (canonicalSuccess) {
      logger.info("[startup] Master sets seeded from canonical_sets (CSV fallback skipped)");
      return;
    }

    // Canonical seed failed - check if CSV fallback is allowed
    if (runtimeConfig.canonicalCsvFallback) {
      logger.warn("[startup] Canonical seed failed, falling back to CSV (CANONICAL_CSV_FALLBACK=true)");
      seedMasterSetsFromCsv(db, logger, csvPath);
    } else {
      logger.error("[startup] Canonical seed failed and CSV fallback is disabled (CANONICAL_CSV_FALLBACK=false)");
      throw new Error("Canonical seed required but failed. Set CANONICAL_CSV_FALLBACK=true to allow CSV fallback.");
    }
  } else {
    // Canonical seed disabled, use CSV directly
    logger.info("[startup] Canonical seed disabled (CANONICAL_SEED_ENABLED=false), using CSV");
    seedMasterSetsFromCsv(db, logger, csvPath);
  }
}

// -----------------------------------------------------------------------------
// Canonical Health Check (Phase 2 startup integration)
// -----------------------------------------------------------------------------

export function checkCanonicalGateOnStartup(db: Database, logger: Logger): void {
  try {
    const gateService = new CanonicalGateService(db, logger);
    const readiness = gateService.isCanonicalReady();

    if (!readiness.ready) {
      logger.warn({ reason: readiness.reason }, "[startup] Canonical catalog not ready - falling back to PriceCharting for retrieval");
      return;
    }

    const gate = gateService.validateGate();
    if (!gate.passed) {
      logger.warn(
        {
          reason: gate.reason,
          current_sets: gate.current.sets,
          current_cards: gate.current.cards,
          baseline_sets: gate.baseline?.sets_count,
          baseline_cards: gate.baseline?.cards_count,
        },
        "[startup] Canonical gate validation FAILED - catalog may have regressed"
      );
      return;
    }

    logger.info(
      {
        sets: gate.current.sets,
        cards: gate.current.cards,
        baseline_sets: gate.baseline?.sets_count,
        baseline_cards: gate.baseline?.cards_count,
      },
      "[startup] Canonical gate validation PASSED - catalog ready for retrieval"
    );
  } catch (error) {
    logger.warn({ err: error }, "[startup] Canonical gate check failed (non-blocking)");
  }
}

// -----------------------------------------------------------------------------
// KeepWarm health check
// -----------------------------------------------------------------------------

const execAsync = promisify(exec);

const keepWarmScriptCandidates = [
  path.resolve(__dirname, "../../../../scripts/cardmint-keepwarm-enhanced.py"),
  path.resolve(__dirname, "../../../scripts/cardmint-keepwarm-enhanced.py"),
];

export const keepWarmScriptPath =
  keepWarmScriptCandidates.find((candidate) => fs.existsSync(candidate)) ?? keepWarmScriptCandidates[0];

export const masterCropScriptCandidates = [
  path.resolve(__dirname, "../../../../scripts/create_master_crop.py"),
  path.resolve(__dirname, "../../../scripts/create_master_crop.py"),
];

export const masterCropScriptPath =
  masterCropScriptCandidates.find((candidate) => fs.existsSync(candidate)) ?? masterCropScriptCandidates[0];

export async function checkKeepWarmHealth(logger: Logger): Promise<boolean> {
  try {
    if (!fs.existsSync(keepWarmScriptPath)) {
      logger.warn({ keepWarmScriptPath }, "KeepWarm daemon health check skipped (script not found)");
      return false;
    }
    const { stdout } = await execAsync(`python3 ${keepWarmScriptPath} --check`);
    logger.info({ stdout: stdout.trim() }, "KeepWarm daemon health check passed");
    return true;
  } catch (error) {
    const err = error as any;
    logger.warn({ stderr: err.stderr, code: err.code }, "KeepWarm daemon health check failed (non-blocking)");
    return false;
  }
}

// -----------------------------------------------------------------------------
// Startup cleanup: ensure clean slate on restart
// -----------------------------------------------------------------------------

function performStartupCleanup(db: Database, logger: Logger): void {
  const now = Date.now();

  // DEV_MODE keeps the historical "clean slate" behavior for rapid iteration.
  // Production-style runs should avoid destructive deletes on restart.
  if (runtimeConfig.devMode) {
    const purgeStatuses = [
      "QUEUED",
      "CAPTURING",
      "CAPTURED",
      "BACK_IMAGE",
      "PREPROCESSING",
      "INFERENCING",
      "CANDIDATES_READY",
      "OPERATOR_PENDING",
      "UNMATCHED_NO_REASONABLE_CANDIDATE",
    ];

    // Run cleanup in a transaction to avoid partial state
    const cleanup = db.transaction(() => {
      // 1. Abort/clear any active operator sessions from a previous run
      const activeSessions = db
        .prepare(
          `SELECT id FROM operator_sessions WHERE status IN ('RUNNING', 'VALIDATING', 'PREP')`
        )
        .all() as { id: string }[];

      let abortedSessions = 0;
      let purgedSessionEvents = 0;

      if (activeSessions.length > 0) {
        abortedSessions = db
          .prepare(
            `UPDATE operator_sessions
             SET status = 'ABORTED', ended_at = @now, updated_at = @now
             WHERE status IN ('RUNNING', 'VALIDATING', 'PREP')`
          )
          .run({ now }).changes;

        const sessionIds = activeSessions.map((s) => s.id);
        const placeholders = sessionIds.map(() => "?").join(",");
        purgedSessionEvents = placeholders
          ? db
              .prepare(`DELETE FROM operator_session_events WHERE session_id IN (${placeholders})`)
              .run(...sessionIds).changes
          : 0;
      }

      // 2. Purge any in-flight or waiting jobs so restart starts from a clean slate
      const purgedJobs = db
        .prepare(`DELETE FROM scans WHERE status IN (${purgeStatuses.map(() => "?").join(",")})`)
        .run(...purgeStatuses).changes;

      // 3. Reset any lingering locks on remaining jobs (defensive)
      const unlockedJobs = db
        .prepare(
          `UPDATE scans
           SET processor_id = NULL,
               locked_at = NULL
           WHERE processor_id IS NOT NULL OR locked_at IS NOT NULL`
        )
        .run().changes;

      return { abortedSessions, purgedSessionEvents, purgedJobs, unlockedJobs };
    })();

    // 4. Clear SFTP inbox to prevent reprocessing of old files
    const inboxPath = runtimeConfig.sftpWatchPath;
    let inboxFilesCleared = 0;
    try {
      if (fs.existsSync(inboxPath)) {
        const files = fs.readdirSync(inboxPath);
        for (const file of files) {
          const filePath = path.join(inboxPath, file);
          if (fs.statSync(filePath).isFile()) {
            fs.unlinkSync(filePath);
            inboxFilesCleared++;
          }
        }
        if (inboxFilesCleared > 0) {
          logger.info({ inboxPath, filesCleared: inboxFilesCleared }, "[startup] Cleared SFTP inbox");
        }
      }
    } catch (error) {
      logger.warn({ err: error, inboxPath }, "[startup] Failed to clear SFTP inbox (non-blocking)");
    }

    logger.info(
      {
        sessionsAborted: cleanup.abortedSessions,
        sessionEventsPurged: cleanup.purgedSessionEvents,
        jobsPurged: cleanup.purgedJobs,
        jobsUnlocked: cleanup.unlockedJobs,
        inboxCleared: inboxFilesCleared,
        devMode: true,
      },
      "[startup] Cleanup complete - clean slate ready"
    );

    return;
  }

  // Non-destructive recovery:
  // - Preserve operator sessions + events for audit and for crash recovery.
  // - Re-queue jobs stuck INFERENCING after restart so the worker can resume.
  // - Never delete SFTP inbox files automatically on startup (data-loss guard).
  const recovery = db.transaction(() => {
    const recoveredJobs = db
      .prepare(
        `UPDATE scans
         SET status = CASE
           WHEN scan_orientation = 'back' THEN 'BACK_IMAGE'
           ELSE 'QUEUED'
         END,
         processor_id = NULL,
         locked_at = NULL,
         updated_at = @now,
         error_code = COALESCE(error_code, 'BACKEND_RESTART'),
         error_message = COALESCE(error_message, 'Recovered from backend restart')
         WHERE status = 'INFERENCING'`
      )
      .run({ now }).changes;

    const unlockedJobs = db
      .prepare(
        `UPDATE scans
         SET processor_id = NULL,
             locked_at = NULL
         WHERE processor_id IS NOT NULL OR locked_at IS NOT NULL`
      )
      .run().changes;

    return { recoveredJobs, unlockedJobs };
  })();

  logger.info(
    {
      recoveredJobs: recovery.recoveredJobs,
      jobsUnlocked: recovery.unlockedJobs,
      devMode: false,
    },
    "[startup] Non-destructive recovery complete"
  );
}

// -----------------------------------------------------------------------------
// createContext: main composition root factory
// -----------------------------------------------------------------------------

export async function createContext(): Promise<AppContext> {
  const logger = createLogger();

  // Open database and bootstrap catalog
  let db: Database;
  try {
    db = openDatabase();
    logger.info({ sqlitePath: runtimeConfig.sqlitePath }, "Database opened");
    assertCanonicalCatalogReady(db, logger);
    const setsBefore = db.prepare(`SELECT COUNT(*) as count FROM cm_sets`).get() as { count: number } | undefined;
    logger.info({ setsBefore: setsBefore?.count ?? 0 }, "Syncing master set list into cm_sets (canonical-first)");
    syncMasterSets(db, logger);
    const setsAfter = db.prepare(`SELECT COUNT(*) as count FROM cm_sets`).get() as { count: number } | undefined;
    logger.info({ setsAfter: setsAfter?.count ?? 0 }, "Master set list sync completed");

    // Phase 2: Validate canonical gate on startup (non-blocking in dev)
    checkCanonicalGateOnStartup(db, logger);
  } catch (error) {
    console.error("[startup] failed", error);
    process.exit(1);
  }

  // Repositories
  const jobRepo = new JobRepository(db);
  const sessionRepo = new SessionRepository(db);

  // Startup cleanup: Close stale sessions and mark incomplete jobs
  // This ensures a clean slate on every backend restart
  performStartupCleanup(db, logger);

  // Capture adapter
  const captureAdapter = new CaptureAdapter(jobRepo, logger);

  // Retrieval
  const retrievalService = new RetrievalService(db, runtimeConfig.priceChartingCsvPath, logger);

  // Metrics
  const metricsCollector = new MetricsCollector();

  // Image processing pipeline
  const distortionCorrection = new DistortionCorrectionService(logger, "data/corrected-images");
  const imageProcessing = new ImageProcessingService(logger, "images/incoming", "images/incoming/.tmp", "images/manifest-md5.csv");

  // Session management
  const sessionService = new SessionService(sessionRepo, jobRepo, logger);

  // Inventory services
  const skuCanonicalizer = new SKUCanonicalizer(db, logger);
  const inventoryService = new InventoryService(db, skuCanonicalizer, logger);

  // Job queue (depends on inventoryService)
  const queue = new JobQueue(jobRepo, inventoryService);

  // Inventory override service
  const inventoryOverrideService = new InventoryOverrideService(db, logger);

  // Manifest writer
  const manifestWriter = new JobManifestWriter(logger);

  // CDN/image publishing services
  const imageHostingConfig = {
    publicKey: runtimeConfig.imageKitPublicKey,
    privateKey: runtimeConfig.imageKitPrivateKey,
    urlEndpoint: runtimeConfig.imageKitUrlEndpoint,
    folder: runtimeConfig.cloudinaryFolder,
    fallbackBaseUrl: `http://127.0.0.1:${runtimeConfig.port}`,
  };
  const imageHostingService = new ImageHostingService(imageHostingConfig, logger);
  const listingImageService = new ListingImageService(logger, db);

  if (runtimeConfig.cdnImagesEnabled) {
    await imageHostingService.initialize();
    logger.info({ enabled: true }, "ImageHostingService (ImageKit) enabled");
  } else {
    logger.warn("ImageHostingService disabled (CDN_IMAGES_ENABLED=false)");
  }

  // PPT adapter (moved earlier for Path C SetTriangulator)
  const pptConfig: PPTConfig = {
    apiKey: runtimeConfig.pokemonPriceTrackerApiKey,
    baseUrl: "https://www.pokemonpricetracker.com",
    tier: runtimeConfig.pokemonPriceTrackerTier,
    dailyLimit: runtimeConfig.pokemonPriceTrackerDailyLimit,
    timeoutMs: runtimeConfig.pokemonPriceTrackerTimeoutMs,
  };
  const pptAdapter = new PokePriceTrackerAdapter(db, pptConfig, logger);

  // Path C SetTriangulator (Dec 2025 - set disambiguation)
  let setTriangulator: SetTriangulator | undefined;
  if (runtimeConfig.enablePathCSetDisambig && runtimeConfig.pokemonPriceTrackerApiKey) {
    setTriangulator = new SetTriangulator(
      db,
      logger,
      async (cardName, limit, timeoutMs) => {
        return pptAdapter.searchCardsForTriangulation(cardName, limit, timeoutMs);
      }
    );
    logger.info("Path C SetTriangulator enabled");
  } else if (runtimeConfig.enablePathCSetDisambig) {
    logger.warn("Path C SetTriangulator disabled: PPT API key not configured");
  }

  // Job worker
  const jobWorker = new JobWorker(
    queue,
    logger,
    retrievalService,
    metricsCollector,
    distortionCorrection,
    imageProcessing,
    sessionService,
    inventoryService,
    imageHostingService,
    setTriangulator
  );

  // SFTP watch-folder ingestion (pi-hq driver only)
  const sftpWatcher =
    runtimeConfig.captureDriver === "pi-hq"
      ? new SftpWatchFolderIngestion(queue, logger, sessionService)
      : null;
  if (sftpWatcher) {
    sftpWatcher.start();
    logger.info("SFTP watch-folder ingestion enabled (driver=pi-hq)");
  }

  // Queue event logging (de-noise repeated updates, but always log error/ppt_failure changes)
  const lastJobUpdate = new Map<string, {
    status: string;
    timingsKey: string;
    errorCode: string | null;
    pptFailureCount: number;
    lastSeenAt: number;
  }>();
  let jobUpdateEventsSincePrune = 0;
  const pruneJobUpdateCache = () => {
    const cutoff = Date.now() - 60 * 60 * 1000; // 1h
    for (const [jobId, entry] of lastJobUpdate.entries()) {
      if (entry.lastSeenAt < cutoff) {
        lastJobUpdate.delete(jobId);
      }
    }
    jobUpdateEventsSincePrune = 0;
  };

  queue.on("job:queued", (job) => {
    logger.info({ jobId: job.id }, "job queued");
  });
  queue.on("job:updated", (job) => {
    const timings = (job.timings && typeof job.timings === "object") ? job.timings : {};
    const timingsKey = JSON.stringify(
      Object.entries(timings as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
    );
    const errorCode = (job as { error_code?: string | null }).error_code ?? null;
    const pptFailureCount = (job as { ppt_failure_count?: number }).ppt_failure_count ?? 0;

    const prev = lastJobUpdate.get(job.id);
    const now = Date.now();
    lastJobUpdate.set(job.id, { status: job.status, timingsKey, errorCode, pptFailureCount, lastSeenAt: now });

    jobUpdateEventsSincePrune += 1;
    if (jobUpdateEventsSincePrune >= 1000) {
      pruneJobUpdateCache();
    }

    if (prev &&
        prev.status === job.status &&
        prev.timingsKey === timingsKey &&
        prev.errorCode === errorCode &&
        prev.pptFailureCount === pptFailureCount) {
      return;
    }

    logger.info({ jobId: job.id, status: job.status }, "job updated");
  });

  // Retrieval warmup (non-blocking)
  void retrievalService
    .getCandidates({})
    .catch((error) => logger.warn({ err: error }, "Initial retrieval warmup failed"));

  // KeepWarm health check (non-blocking)
  void checkKeepWarmHealth(logger);

  // Initialize services (non-blocking)
  void distortionCorrection.initialize();
  void imageProcessing.initialize();

  // Start job worker
  jobWorker.start();

  // PriceCharting repository for operator-triggered enrichment (CSV fallback)
  const priceChartingRepo = new PriceChartingRepository(db, runtimeConfig.priceChartingCsvPath, logger);

  // Note: pptAdapter is created earlier (before jobWorker) for Path C SetTriangulator

  // Stage 3 promotion service (auto-publish + enrich on Accept)
  const stage3Promotion = new Stage3PromotionService(
    db,
    jobRepo,
    imageHostingService,
    listingImageService,
    pptAdapter,
    priceChartingRepo,
    logger
  );

  // Stripe payment service (Dec 2025)
  const stripeService = new StripeService(db, logger);
  const stripeExpiryJob = new StripeExpiryJob(stripeService, inventoryService, logger);

  // Start Stripe expiry job if Stripe is configured
  if (stripeService.isConfigured()) {
    stripeExpiryJob.start();
  }

  // EverShop import safeguards (Dec 2025)
  const importSafeguards = new ImportSafeguardsService(db, logger);

  // Klaviyo email tracking (Dec 2025)
  const klaviyoService = new KlaviyoService(db, logger);

  // Cleanup expired/aborted idempotency keys on startup
  const cleanup = importSafeguards.cleanupExpiredKeys();
  if (cleanup.deleted > 0 || cleanup.aborted > 0) {
    logger.info(
      { deleted: cleanup.deleted, aborted: cleanup.aborted },
      "[startup] Cleaned expired import idempotency keys"
    );
  }

  // Shutdown state (closure-based)
  let shuttingDown = false;

  return {
    logger,
    db,
    queue,
    jobRepo,
    sessionRepo,
    sessionService,
    captureAdapter,
    retrievalService,
    inventoryService,
    inventoryOverrideService,
    skuCanonicalizer,
    distortionCorrection,
    imageProcessing,
    imageHostingService,
    listingImageService,
    metricsCollector,
    manifestWriter,
    jobWorker,
    sftpWatcher,
    priceChartingRepo,
    pptAdapter,
    stage3Promotion,
    stripeService,
    stripeExpiryJob,
    importSafeguards,
    klaviyoService,

    isShuttingDown: () => shuttingDown,
    setShuttingDown: (value: boolean) => {
      shuttingDown = value;
    },
  };
}

// Re-export runtimeConfig for convenience
export { runtimeConfig };
