#!/usr/bin/env npx tsx
/**
 * One-shot script to manually re-trigger Stage 3 promotion for a scan.
 * Usage: npx tsx scripts/retrigger_stage3.ts <scan_id>
 */
import Database from "better-sqlite3";
import pino from "pino";
import { Stage3PromotionService } from "../src/services/stage3Promotion.js";
import { ListingImageService } from "../src/services/listingImageService.js";
import { ImageHostingService } from "../src/services/imageHosting.js";
import { JobRepository } from "../src/repositories/jobRepository.js";
import { PokePriceTrackerAdapter } from "../src/services/pricing/pptAdapter.js";
import { PriceChartingRepository } from "../src/services/retrieval/pricechartingRepository.js";
import { runtimeConfig } from "../src/config.js";

const scanId = process.argv[2];
if (!scanId) {
  console.error("Usage: npx tsx scripts/retrigger_stage3.ts <scan_id>");
  process.exit(1);
}

const logger = pino({ level: "info" });
const db = new Database(runtimeConfig.sqlitePath);

const jobRepo = new JobRepository(db);
const listingImageService = new ListingImageService(logger, db);
const imageHostingService = new ImageHostingService(
  {
    publicKey: runtimeConfig.imageKitPublicKey,
    privateKey: runtimeConfig.imageKitPrivateKey,
    urlEndpoint: runtimeConfig.imageKitUrlEndpoint,
    folder: runtimeConfig.cloudinaryFolder,
  },
  logger
);
const pptAdapter = new PokePriceTrackerAdapter(db, {
  apiKey: runtimeConfig.pokemonPriceTrackerApiKey,
  baseUrl: "https://www.pokemonpricetracker.com",
  tier: runtimeConfig.pokemonPriceTrackerTier,
  dailyLimit: runtimeConfig.pokemonPriceTrackerDailyLimit,
  timeoutMs: runtimeConfig.pokemonPriceTrackerTimeoutMs,
}, logger);
const priceChartingRepo = new PriceChartingRepository(db);

// Initialize ImageKit (in case fallback path is needed)
await imageHostingService.initialize();

// Constructor order: db, jobRepo, imageHostingService, listingImageService, pptAdapter, priceChartingRepo, logger
const stage3 = new Stage3PromotionService(
  db,
  jobRepo,
  imageHostingService,
  listingImageService,
  pptAdapter,
  priceChartingRepo,
  logger
);

console.log(`\nRe-triggering Stage 3 for scan: ${scanId}\n`);
const result = await stage3.promoteAfterAccept(scanId);
console.log("\n=== Result ===");
console.log(JSON.stringify(result, null, 2));

db.close();
