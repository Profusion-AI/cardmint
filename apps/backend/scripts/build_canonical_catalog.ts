#!/usr/bin/env npx ts-node
/**
 * CardMint Canonical Catalog Builder
 *
 * Fetches complete Pokemon TCG catalog from PPT API and persists to SQLite.
 * Solves the set name disambiguation bug (Team Rocket vs Team Rocket Returns).
 *
 * SSoT: canonical.db at repo root is the single source of truth.
 * Use --sync-to-dev to also populate apps/backend/cardmint_dev.db.
 *
 * Usage:
 *   npx tsx scripts/build_canonical_catalog.ts [options]
 *
 * Options:
 *   --api-key=KEY       PPT API key (or POKEMONPRICETRACKER_API_KEY env var)
 *   --db=PATH           SQLite database path (default: ../../canonical.db)
 *   --sync-to-dev       Also sync to apps/backend/cardmint_dev.db after build
 *   --priority-only     Only fetch priority sets (Day 1 mode)
 *   --dry-run           Fetch but don't persist to database
 *   --export-json       Export catalog to JSON file
 *   --resume            Resume from last checkpoint
 *   --force             Skip deduplication (re-fetch existing sets)
 *   --verbose           Enable verbose logging
 *
 * Rate Limits (Pro Tier):
 *   - Daily: 20,000 calls
 *   - Per minute: 60 calls
 *   - fetchAllInSet: 1-30 minute calls based on set size
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Types (inlined to avoid cross-package import issues)
// ============================================================================

interface PPTSet {
  id: string;
  tcgPlayerId: string;
  name: string;
  series: string;
  releaseDate: string;
  cardCount: number;
  priceGuideUrl?: string;
  hasPriceGuide: boolean;
  noPriceGuideReason?: string | null;
  imageCdnUrl?: string;
  imageCdnUrl200?: string;
  imageCdnUrl400?: string;
  imageCdnUrl800?: string;
  imageUrl?: string;
  createdAt: string;
  updatedAt: string;
}

interface PPTSetsResponse {
  data: PPTSet[];
  metadata: {
    total: number;
    count: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    language?: string;
  };
}

interface PPTConditionPrice {
  price: number;
  listings: number;
  priceString: string;
}

interface PPTVariantPrices {
  [condition: string]: PPTConditionPrice;
}

interface PPTCardPrices {
  market: number | null;
  listings: number | null;
  primaryCondition?: string;
  conditions?: Record<string, PPTConditionPrice>;
  variants?: Record<string, PPTVariantPrices>;
}

interface PPTCardFull {
  id: string;
  tcgPlayerId: string;
  setId: string;
  setName: string;
  name: string;
  cardNumber?: string;
  totalSetNumber?: string;
  rarity?: string;
  cardType?: string;
  hp?: number;
  stage?: string;
  attacks?: Array<{
    cost: string[];
    name: string;
    damage?: string;
    text?: string;
  }>;
  weakness?: { type: string | null; value: string | null };
  resistance?: { type: string | null; value: string | null };
  retreatCost?: number;
  artist?: string | null;
  tcgPlayerUrl?: string;
  prices?: PPTCardPrices;
  imageUrl?: string;
}

interface PPTCardsResponse {
  data: PPTCardFull[];
  metadata: {
    total: number;
    count: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    includes?: {
      priceHistory?: boolean;
      ebayData?: boolean;
    };
  };
}

// ============================================================================
// Configuration
// ============================================================================

const PPT_API_BASE = "https://www.pokemonpricetracker.com";

const RATE_LIMITS = {
  dailyLimit: 20_000,
  minuteLimit: 60,
  safetyBuffer: 0.05, // Keep 5% reserve
  delayBetweenSets: 2500, // 2.5s between fetchAllInSet calls
  baseDelayOnRateLimit: 61_000, // Base wait on 429
  requestTimeoutMs: 30_000, // 30s request timeout
  maxRetries: 3, // Max retries per request
  backoffMultiplier: 2, // Exponential backoff multiplier
};

// Priority sets to fetch first (highest operator volume)
const PRIORITY_SETS = [
  "base-set",
  "jungle",
  "fossil",
  "team-rocket",
  "gym-heroes",
  "gym-challenge",
  "neo-genesis",
  "neo-discovery",
  "neo-revelation",
  "neo-destiny",
  "legendary-collection",
  "expedition-base-set",
  "aquapolis",
  "skyridge",
  "base-set-2",
  "team-rocket-returns",
  // Modern high-volume
  "scarlet-violet",
  "paldea-evolved",
  "obsidian-flames",
  "temporal-forces",
  "surging-sparks",
  "151",
  "celebrations",
  "evolving-skies",
  "fusion-strike",
  "brilliant-stars",
];

// ============================================================================
// Types
// ============================================================================

interface BuilderConfig {
  apiKey: string;
  dbPath: string;
  syncToDevDb: boolean;  // Also sync to cardmint_dev.db after writing to canonical.db
  syncOnly: boolean;     // Just sync existing canonical.db to dev, no API fetch
  priorityOnly: boolean;
  dryRun: boolean;
  exportJson: boolean;
  exportCsv: boolean;
  resume: boolean;
  force: boolean;  // Skip deduplication check
  verbose: boolean;
}

interface BuildProgress {
  setsTotal: number;
  setsFetched: number;
  cardsTotal: number;
  cardsFetched: number;
  dailyCreditsUsed: number;
  minuteCallsUsed: number;
  lastSetFetched: string | null;
  errors: Array<{ setId: string; error: string; timestamp: number }>;
  startedAt: number;
}

interface RateLimitState {
  dailyRemaining: number;
  minuteRemaining: number;
  lastMinuteReset: number;
}

const writeCsv = (filePath: string, headers: string[], rows: Array<Record<string, string | number | null>>) => {
  const lines = [headers.join(",")];
  for (const row of rows) {
    const line = headers
      .map((h) => {
        const val = row[h] ?? "";
        const str = String(val);
        // Escape commas/quotes
        if (str.includes(",") || str.includes("\"") || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(",");
    lines.push(line);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n"));
};

// ============================================================================
// Utilities
// ============================================================================

function parseArgs(): BuilderConfig {
  const args = process.argv.slice(2);
  const config: BuilderConfig = {
    apiKey: process.env.POKEMONPRICETRACKER_API_KEY || process.env.PPT_API_KEY || "",
    dbPath: path.join(__dirname, "../../../canonical.db"), // SSoT at repo root
    syncToDevDb: false,
    syncOnly: false,
    priorityOnly: false,
    dryRun: false,
    exportJson: false,
    exportCsv: true,
    resume: false,
    force: false,
    verbose: false,
  };

  for (const arg of args) {
    if (arg.startsWith("--api-key=")) {
      config.apiKey = arg.split("=")[1];
    } else if (arg.startsWith("--db=")) {
      config.dbPath = arg.split("=")[1];
    } else if (arg === "--sync-to-dev") {
      config.syncToDevDb = true;
    } else if (arg === "--sync-only") {
      config.syncOnly = true;
      config.syncToDevDb = true;  // sync-only implies sync-to-dev
    } else if (arg === "--priority-only") {
      config.priorityOnly = true;
    } else if (arg === "--dry-run") {
      config.dryRun = true;
    } else if (arg === "--export-json") {
      config.exportJson = true;
    } else if (arg === "--no-export-csv") {
      config.exportCsv = false;
    } else if (arg === "--resume") {
      config.resume = true;
    } else if (arg === "--force") {
      config.force = true;
    } else if (arg === "--verbose") {
      config.verbose = true;
    }
  }

  return config;
}

function log(message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] ${message}`, JSON.stringify(data));
  } else {
    console.log(`[${timestamp}] ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// API Client
// ============================================================================

class PPTApiClient {
  private rateLimits: RateLimitState = {
    dailyRemaining: RATE_LIMITS.dailyLimit,
    minuteRemaining: RATE_LIMITS.minuteLimit,
    lastMinuteReset: Date.now(),
  };

  constructor(
    private readonly apiKey: string,
    private readonly verbose: boolean
  ) {}

  private parseRateLimitHeaders(headers: Headers): void {
    const daily = headers.get("x-ratelimit-daily-remaining");
    const minute = headers.get("x-ratelimit-minute-remaining");

    if (daily) this.rateLimits.dailyRemaining = parseInt(daily, 10);
    if (minute) {
      this.rateLimits.minuteRemaining = parseInt(minute, 10);
      this.rateLimits.lastMinuteReset = Date.now();
    }
  }

  getRateLimits(): RateLimitState {
    return { ...this.rateLimits };
  }

  private async checkRateLimits(): Promise<void> {
    // Check if minute window has reset (60s)
    if (Date.now() - this.rateLimits.lastMinuteReset > 60_000) {
      this.rateLimits.minuteRemaining = RATE_LIMITS.minuteLimit;
      this.rateLimits.lastMinuteReset = Date.now();
    }

    // Wait if minute limit exhausted
    if (this.rateLimits.minuteRemaining <= 1) {
      const waitTime = 60_000 - (Date.now() - this.rateLimits.lastMinuteReset) + 1000;
      if (waitTime > 0) {
        log(`Rate limit reached, waiting ${Math.ceil(waitTime / 1000)}s...`);
        await sleep(waitTime);
        this.rateLimits.minuteRemaining = RATE_LIMITS.minuteLimit;
        this.rateLimits.lastMinuteReset = Date.now();
      }
    }

    // Check daily limit with safety buffer
    const dailyThreshold = RATE_LIMITS.dailyLimit * RATE_LIMITS.safetyBuffer;
    if (this.rateLimits.dailyRemaining <= dailyThreshold) {
      throw new Error(
        `Daily quota nearly exhausted (${this.rateLimits.dailyRemaining} remaining). ` +
          `Run again tomorrow or use --resume flag.`
      );
    }
  }

  async fetchSets(retryCount = 0): Promise<PPTSet[]> {
    await this.checkRateLimits();

    const url = `${PPT_API_BASE}/api/v2/sets?limit=500&language=english`;

    if (this.verbose) log("Fetching sets", { url, attempt: retryCount + 1 });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RATE_LIMITS.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      this.parseRateLimitHeaders(response.headers);

      if (response.status === 429 || response.status >= 500) {
        if (retryCount >= RATE_LIMITS.maxRetries) {
          throw new Error(`Failed to fetch sets after ${RATE_LIMITS.maxRetries} retries: ${response.status}`);
        }
        const backoffMs = response.status === 429
          ? RATE_LIMITS.baseDelayOnRateLimit * Math.pow(RATE_LIMITS.backoffMultiplier, retryCount)
          : 5000 * Math.pow(RATE_LIMITS.backoffMultiplier, retryCount);
        log(`Sets fetch failed (${response.status}), retrying in ${Math.ceil(backoffMs / 1000)}s...`);
        await sleep(backoffMs);
        return this.fetchSets(retryCount + 1);
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch sets: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as PPTSetsResponse;
      log(`Fetched ${data.data.length} sets (total: ${data.metadata.total})`);

      return data.data;

    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('fetch'))) {
        if (retryCount >= RATE_LIMITS.maxRetries) {
          throw new Error(`Network/timeout error fetching sets after ${RATE_LIMITS.maxRetries} retries: ${error.message}`);
        }
        const backoffMs = 5000 * Math.pow(RATE_LIMITS.backoffMultiplier, retryCount);
        log(`Network error fetching sets, retrying in ${Math.ceil(backoffMs / 1000)}s: ${error.message}`);
        await sleep(backoffMs);
        return this.fetchSets(retryCount + 1);
      }

      throw error;
    }
  }

  async fetchSetCards(setTcgPlayerId: string, retryCount = 0): Promise<PPTCardFull[]> {
    await this.checkRateLimits();

    const url = `${PPT_API_BASE}/api/v2/cards?setId=${encodeURIComponent(setTcgPlayerId)}&fetchAllInSet=true`;

    if (this.verbose) log("Fetching cards for set", { setTcgPlayerId, url, attempt: retryCount + 1 });

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RATE_LIMITS.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      this.parseRateLimitHeaders(response.headers);

      // Handle rate limit with exponential backoff
      if (response.status === 429) {
        if (retryCount >= RATE_LIMITS.maxRetries) {
          throw new Error(`Rate limit exceeded after ${RATE_LIMITS.maxRetries} retries for ${setTcgPlayerId}`);
        }
        const backoffMs = RATE_LIMITS.baseDelayOnRateLimit * Math.pow(RATE_LIMITS.backoffMultiplier, retryCount);
        log(`Rate limited (429), backing off ${Math.ceil(backoffMs / 1000)}s (attempt ${retryCount + 1}/${RATE_LIMITS.maxRetries})...`);
        await sleep(backoffMs);
        return this.fetchSetCards(setTcgPlayerId, retryCount + 1);
      }

      // Handle server errors with retry
      if (response.status >= 500) {
        if (retryCount >= RATE_LIMITS.maxRetries) {
          throw new Error(`Server error ${response.status} after ${RATE_LIMITS.maxRetries} retries for ${setTcgPlayerId}`);
        }
        const backoffMs = 5000 * Math.pow(RATE_LIMITS.backoffMultiplier, retryCount);
        log(`Server error ${response.status}, retrying in ${Math.ceil(backoffMs / 1000)}s (attempt ${retryCount + 1}/${RATE_LIMITS.maxRetries})...`);
        await sleep(backoffMs);
        return this.fetchSetCards(setTcgPlayerId, retryCount + 1);
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch cards for ${setTcgPlayerId}: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as PPTCardsResponse;

      if (this.verbose) {
        log(`Fetched ${data.data.length} cards for ${setTcgPlayerId}`);
      }

      return data.data;

    } catch (error) {
      clearTimeout(timeoutId);

      // Handle timeout/network errors with retry
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('fetch'))) {
        if (retryCount >= RATE_LIMITS.maxRetries) {
          throw new Error(`Network/timeout error after ${RATE_LIMITS.maxRetries} retries for ${setTcgPlayerId}: ${error.message}`);
        }
        const backoffMs = 5000 * Math.pow(RATE_LIMITS.backoffMultiplier, retryCount);
        log(`Network error, retrying in ${Math.ceil(backoffMs / 1000)}s (attempt ${retryCount + 1}/${RATE_LIMITS.maxRetries}): ${error.message}`);
        await sleep(backoffMs);
        return this.fetchSetCards(setTcgPlayerId, retryCount + 1);
      }

      throw error;
    }
  }
}

// ============================================================================
// Database Operations
// ============================================================================

class CatalogDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
  }

  ensureTables(): void {
    // Read and execute migration
    const migrationPath = path.join(
      __dirname,
      "../src/db/migrations/20251124_canonical_catalog_tables.sql"
    );

    if (fs.existsSync(migrationPath)) {
      const migration = fs.readFileSync(migrationPath, "utf-8");
      this.db.exec(migration);
      log("Applied canonical catalog migration");
    } else {
      log("Migration file not found, assuming tables exist");
    }
  }

  getProgress(): BuildProgress | null {
    const meta = this.db
      .prepare("SELECT key, value FROM canonical_catalog_meta")
      .all() as Array<{ key: string; value: string }>;

    if (meta.length === 0) return null;

    const values = Object.fromEntries(meta.map((r) => [r.key, r.value]));

    return {
      setsTotal: parseInt(values.sets_total || "0", 10),
      setsFetched: parseInt(values.sets_fetched || "0", 10),
      cardsTotal: parseInt(values.cards_total || "0", 10),
      cardsFetched: parseInt(values.cards_fetched || "0", 10),
      dailyCreditsUsed: parseInt(values.daily_credits_used || "0", 10),
      minuteCallsUsed: parseInt(values.minute_calls_used || "0", 10),
      lastSetFetched: values.last_set_fetched || null,
      errors: JSON.parse(values.errors || "[]"),
      startedAt: parseInt(values.started_at || "0", 10),
    };
  }

  saveProgress(progress: BuildProgress): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO canonical_catalog_meta (key, value, updated_at) VALUES (?, ?, ?)"
    );

    const now = Math.floor(Date.now() / 1000);

    const updates = [
      ["sets_total", String(progress.setsTotal)],
      ["sets_fetched", String(progress.setsFetched)],
      ["cards_total", String(progress.cardsTotal)],
      ["cards_fetched", String(progress.cardsFetched)],
      ["daily_credits_used", String(progress.dailyCreditsUsed)],
      ["minute_calls_used", String(progress.minuteCallsUsed)],
      ["last_set_fetched", progress.lastSetFetched || ""],
      ["errors", JSON.stringify(progress.errors)],
      ["started_at", String(progress.startedAt)],
    ];

    this.db.transaction(() => {
      for (const [key, value] of updates) {
        stmt.run(key, value, now);
      }
    })();
  }

  insertSet(set: PPTSet): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO canonical_sets
         (ppt_set_id, tcg_player_id, name, series, release_date, card_count, has_price_guide, image_url, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        set.id,
        set.tcgPlayerId,
        set.name,
        set.series,
        set.releaseDate,
        set.cardCount,
        set.hasPriceGuide ? 1 : 0,
        set.imageUrl || set.imageCdnUrl || null,
        Math.floor(Date.now() / 1000)
      );
  }

  insertCard(card: PPTCardFull, setTcgPlayerId: string): void {
    const prices = card.prices;
    const conditions = prices?.conditions;
    const variants = prices?.variants;

    // Detect variant availability
    const has1stEdition = variants ? Object.keys(variants).some((k) => k.includes("1st Edition")) : 0;
    const hasUnlimited = variants ? Object.keys(variants).some((k) => k.includes("Unlimited")) : 0;
    const hasReverseHolo = variants ? Object.keys(variants).some((k) => k.includes("Reverse")) : 0;
    const hasHolofoil = variants ? Object.keys(variants).some((k) => k.includes("Holofoil")) : 0;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO canonical_cards
         (ppt_card_id, tcg_player_id, set_tcg_player_id, name, card_number, total_set_number,
          rarity, card_type, hp, stage, market_price, price_nm, price_lp, price_mp, price_hp, price_dmg,
          has_1st_edition, has_unlimited, has_reverse_holo, has_holofoil, tcg_player_url, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        card.id,
        card.tcgPlayerId,
        setTcgPlayerId,
        card.name,
        card.cardNumber || null,
        card.totalSetNumber || null,
        card.rarity || null,
        card.cardType || null,
        card.hp || null,
        card.stage || null,
        prices?.market || null,
        conditions?.["Near Mint"]?.price || null,
        conditions?.["Lightly Played"]?.price || null,
        conditions?.["Moderately Played"]?.price || null,
        conditions?.["Heavily Played"]?.price || null,
        conditions?.["Damaged"]?.price || null,
        has1stEdition ? 1 : 0,
        hasUnlimited ? 1 : 0,
        hasReverseHolo ? 1 : 0,
        hasHolofoil ? 1 : 0,
        card.tcgPlayerUrl || null,
        Math.floor(Date.now() / 1000)
      );
  }

  insertSetCards(cards: PPTCardFull[], setTcgPlayerId: string): number {
    const insertCard = this.insertCard.bind(this);

    this.db.transaction(() => {
      for (const card of cards) {
        insertCard(card, setTcgPlayerId);
      }
    })();

    return cards.length;
  }

  getStats(): { sets: number; cards: number } {
    const setsCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM canonical_sets").get() as { count: number }
    ).count;
    const cardsCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM canonical_cards").get() as { count: number }
    ).count;

    return { sets: setsCount, cards: cardsCount };
  }

  hasCardsForSet(setTcgPlayerId: string): boolean {
    const result = this.db
      .prepare("SELECT COUNT(*) as count FROM canonical_cards WHERE set_tcg_player_id = ?")
      .get(setTcgPlayerId) as { count: number };
    return result.count > 0;
  }

  getCardCountForSet(setTcgPlayerId: string): number {
    const result = this.db
      .prepare("SELECT COUNT(*) as count FROM canonical_cards WHERE set_tcg_player_id = ?")
      .get(setTcgPlayerId) as { count: number };
    return result.count;
  }

  close(): void {
    this.db.close();
  }
}

// ============================================================================
// Sync to Dev DB
// ============================================================================

async function syncToDevDb(config: BuilderConfig): Promise<void> {
  const devDbPath = path.join(__dirname, "../cardmint_dev.db");
  log(`Syncing canonical tables to ${devDbPath}...`);

  const srcDb = new Database(config.dbPath, { readonly: true });
  const dstDb = new Database(devDbPath);

  // Ensure target tables exist (run migration if needed)
  const migrationPath = path.join(
    __dirname,
    "../src/db/migrations/20251124_canonical_catalog_tables.sql"
  );
  if (fs.existsSync(migrationPath)) {
    const migration = fs.readFileSync(migrationPath, "utf-8");
    dstDb.exec(migration);
  }

  // Sync canonical_sets
  const sets = srcDb.prepare("SELECT * FROM canonical_sets").all();
  const upsertSet = dstDb.prepare(`
    INSERT OR REPLACE INTO canonical_sets
    (ppt_set_id, tcg_player_id, name, series, release_date, card_count, has_price_guide, image_url, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  dstDb.transaction(() => {
    for (const s of sets as any[]) {
      upsertSet.run(
        s.ppt_set_id, s.tcg_player_id, s.name, s.series,
        s.release_date, s.card_count, s.has_price_guide, s.image_url, s.fetched_at
      );
    }
  })();

  // Sync canonical_cards (including first_seen_at/last_seen_at for gate integrity)
  const cards = srcDb.prepare("SELECT * FROM canonical_cards").all();
  const upsertCard = dstDb.prepare(`
    INSERT OR REPLACE INTO canonical_cards
    (ppt_card_id, tcg_player_id, set_tcg_player_id, name, card_number, total_set_number,
     rarity, card_type, hp, stage, market_price, price_nm, price_lp, price_mp, price_hp, price_dmg,
     has_1st_edition, has_unlimited, has_reverse_holo, has_holofoil, tcg_player_url, fetched_at,
     first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  dstDb.transaction(() => {
    for (const c of cards as any[]) {
      upsertCard.run(
        c.ppt_card_id, c.tcg_player_id, c.set_tcg_player_id, c.name,
        c.card_number, c.total_set_number, c.rarity, c.card_type, c.hp, c.stage,
        c.market_price, c.price_nm, c.price_lp, c.price_mp, c.price_hp, c.price_dmg,
        c.has_1st_edition, c.has_unlimited, c.has_reverse_holo, c.has_holofoil,
        c.tcg_player_url, c.fetched_at, c.first_seen_at, c.last_seen_at
      );
    }
  })();

  // Sync canonical_catalog_meta
  const meta = srcDb.prepare("SELECT * FROM canonical_catalog_meta").all();
  const upsertMeta = dstDb.prepare(`
    INSERT OR REPLACE INTO canonical_catalog_meta (key, value, updated_at)
    VALUES (?, ?, ?)
  `);

  dstDb.transaction(() => {
    for (const m of meta as any[]) {
      upsertMeta.run(m.key, m.value, m.updated_at);
    }
  })();

  // Sync guard tables (required for Phase 1 gates)
  // canonical_refresh_runs
  dstDb.exec(`
    CREATE TABLE IF NOT EXISTS canonical_refresh_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      sets_count INTEGER,
      cards_count INTEGER,
      coverage_ratio REAL,
      status TEXT NOT NULL,
      notes TEXT
    )
  `);
  const refreshRuns = srcDb.prepare("SELECT * FROM canonical_refresh_runs").all();
  const upsertRefreshRun = dstDb.prepare(`
    INSERT OR REPLACE INTO canonical_refresh_runs
    (id, run_type, started_at, finished_at, sets_count, cards_count, coverage_ratio, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  dstDb.transaction(() => {
    for (const r of refreshRuns as any[]) {
      upsertRefreshRun.run(r.id, r.run_type, r.started_at, r.finished_at,
        r.sets_count, r.cards_count, r.coverage_ratio, r.status, r.notes);
    }
  })();

  // canonical_reconciliation_events
  dstDb.exec(`
    CREATE TABLE IF NOT EXISTS canonical_reconciliation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cm_card_id TEXT,
      pricecharting_card_id TEXT,
      ppt_card_id TEXT,
      conflict_reason TEXT NOT NULL,
      details TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      resolved_at INTEGER,
      UNIQUE(cm_card_id, pricecharting_card_id, ppt_card_id, conflict_reason)
    )
  `);
  const reconEvents = srcDb.prepare("SELECT * FROM canonical_reconciliation_events").all();
  if (reconEvents.length > 0) {
    const upsertReconEvent = dstDb.prepare(`
      INSERT OR REPLACE INTO canonical_reconciliation_events
      (id, cm_card_id, pricecharting_card_id, ppt_card_id, conflict_reason, details,
       first_seen_at, last_seen_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    dstDb.transaction(() => {
      for (const e of reconEvents as any[]) {
        upsertReconEvent.run(e.id, e.cm_card_id, e.pricecharting_card_id, e.ppt_card_id,
          e.conflict_reason, e.details, e.first_seen_at, e.last_seen_at, e.resolved_at);
      }
    })();
  }

  // canonical_backfill_runs
  dstDb.exec(`
    CREATE TABLE IF NOT EXISTS canonical_backfill_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      total_scans INTEGER,
      backfilled_ppt INTEGER,
      backfilled_pc_only INTEGER,
      unmapped INTEGER,
      status TEXT NOT NULL
    )
  `);
  const backfillRuns = srcDb.prepare("SELECT * FROM canonical_backfill_runs").all();
  if (backfillRuns.length > 0) {
    const upsertBackfillRun = dstDb.prepare(`
      INSERT OR REPLACE INTO canonical_backfill_runs
      (id, started_at, finished_at, total_scans, backfilled_ppt, backfilled_pc_only, unmapped, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    dstDb.transaction(() => {
      for (const b of backfillRuns as any[]) {
        upsertBackfillRun.run(b.id, b.started_at, b.finished_at, b.total_scans,
          b.backfilled_ppt, b.backfilled_pc_only, b.unmapped, b.status);
      }
    })();
  }

  // Recreate canonical_refresh_baseline view (required for gate validation)
  dstDb.exec(`DROP VIEW IF EXISTS canonical_refresh_baseline`);
  dstDb.exec(`
    CREATE VIEW canonical_refresh_baseline AS
    SELECT * FROM canonical_refresh_runs
    WHERE run_type = 'full' AND status = 'success'
    ORDER BY finished_at DESC
    LIMIT 1
  `);

  srcDb.close();
  dstDb.close();

  log(`Synced ${sets.length} sets, ${cards.length} cards, and guard tables to ${devDbPath}`);
}

// ============================================================================
// Main Builder
// ============================================================================

async function buildCatalog(config: BuilderConfig): Promise<void> {
  // Handle sync-only mode: skip API fetch, just sync existing canonical.db to dev
  if (config.syncOnly) {
    log("Running in sync-only mode (no API fetch)", { dbPath: config.dbPath });
    await syncToDevDb(config);
    log("Done!");
    return;
  }

  log("Starting CardMint Canonical Catalog Builder", {
    dbPath: config.dbPath,
    priorityOnly: config.priorityOnly,
    dryRun: config.dryRun,
    resume: config.resume,
  });

  if (!config.apiKey) {
    throw new Error("PPT API key required. Use --api-key=KEY or set POKEMONPRICETRACKER_API_KEY env var.");
  }

  const client = new PPTApiClient(config.apiKey, config.verbose);
  const database = config.dryRun ? null : new CatalogDatabase(config.dbPath);

  if (database) {
    database.ensureTables();
  }

  // Initialize or resume progress
  let progress: BuildProgress = {
    setsTotal: 0,
    setsFetched: 0,
    cardsTotal: 0,
    cardsFetched: 0,
    dailyCreditsUsed: 0,
    minuteCallsUsed: 0,
    lastSetFetched: null,
    errors: [],
    startedAt: Date.now(),
  };

  if (config.resume && database) {
    const savedProgress = database.getProgress();
    if (savedProgress && savedProgress.startedAt > 0) {
      progress = savedProgress;
      log("Resuming from checkpoint", {
        setsFetched: progress.setsFetched,
        cardsFetched: progress.cardsFetched,
        lastSet: progress.lastSetFetched,
      });
    }
  }

  // Step 1: Fetch all sets
  log("Fetching all sets...");
  const allSets = await client.fetchSets();
  progress.setsTotal = allSets.length;
  progress.dailyCreditsUsed += 1;

  // Filter to priority sets if requested
  let setsToFetch = allSets;
  if (config.priorityOnly) {
    setsToFetch = allSets.filter((s) => PRIORITY_SETS.includes(s.tcgPlayerId));
    log(`Filtered to ${setsToFetch.length} priority sets`);
  }

  // Sort by priority (if in priority list) then by card count
  setsToFetch.sort((a, b) => {
    const aPriority = PRIORITY_SETS.indexOf(a.tcgPlayerId);
    const bPriority = PRIORITY_SETS.indexOf(b.tcgPlayerId);

    if (aPriority >= 0 && bPriority >= 0) return aPriority - bPriority;
    if (aPriority >= 0) return -1;
    if (bPriority >= 0) return 1;

    return b.cardCount - a.cardCount; // Larger sets first for remaining
  });

  // Insert sets into database
  if (database) {
    for (const set of allSets) {
      database.insertSet(set);
    }
    log(`Inserted ${allSets.length} sets into database`);
  }

  // Step 2: Fetch cards for each set
  const allCards: PPTCardFull[] = [];
  const startIndex = config.resume && progress.lastSetFetched
    ? setsToFetch.findIndex((s) => s.tcgPlayerId === progress.lastSetFetched) + 1
    : 0;

  for (let i = startIndex; i < setsToFetch.length; i++) {
    const set = setsToFetch[i];

    try {
      // Skip if we already have cards for this set (deduplication, unless --force)
      if (!config.force && database && database.hasCardsForSet(set.tcgPlayerId)) {
        const existingCount = database.getCardCountForSet(set.tcgPlayerId);
        log(`[${i + 1}/${setsToFetch.length}] Skipping ${set.name} (${set.tcgPlayerId}) - already have ${existingCount} cards`);
        progress.setsFetched += 1;
        progress.cardsFetched += existingCount;
        continue;
      }

      log(`[${i + 1}/${setsToFetch.length}] Fetching ${set.name} (${set.tcgPlayerId})...`);

      const cards = await client.fetchSetCards(set.tcgPlayerId);
      allCards.push(...cards);

      // Estimate credits used (1 per card with fetchAllInSet)
      progress.dailyCreditsUsed += cards.length;
      progress.minuteCallsUsed += Math.ceil(cards.length / 10);
      progress.cardsFetched += cards.length;
      progress.setsFetched += 1;
      progress.lastSetFetched = set.tcgPlayerId;

      // Insert cards into database
      if (database) {
        database.insertSetCards(cards, set.tcgPlayerId);
      }

      // Log rate limit status
      const limits = client.getRateLimits();
      log(`  -> ${cards.length} cards fetched`, {
        dailyRemaining: limits.dailyRemaining,
        minuteRemaining: limits.minuteRemaining,
        totalCards: progress.cardsFetched,
      });

      // Save progress checkpoint every 3 sets (more frequent for better resume)
      if (database && i % 3 === 0) {
        database.saveProgress(progress);
      }

      // Throttle between sets
      await sleep(RATE_LIMITS.delayBetweenSets);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Error fetching ${set.tcgPlayerId}: ${errorMsg}`);

      progress.errors.push({
        setId: set.tcgPlayerId,
        error: errorMsg,
        timestamp: Date.now(),
      });

      // Save progress on error
      if (database) {
        database.saveProgress(progress);
      }

      // Check if it's a quota error
      if (errorMsg.includes("quota") || errorMsg.includes("Daily")) {
        log("Stopping due to quota limits. Use --resume to continue later.");
        break;
      }

      // Continue with next set on other errors
      await sleep(RATE_LIMITS.delayBetweenSets);
    }
  }

  // Final progress save
  if (database) {
    database.saveProgress(progress);

    const stats = database.getStats();
    log("Build complete", {
      setsInDb: stats.sets,
      cardsInDb: stats.cards,
      creditsUsed: progress.dailyCreditsUsed,
      errors: progress.errors.length,
    });
  }

  // Export JSON if requested
  if (config.exportJson) {
    const exportPath = path.join(__dirname, "../data/cardmint_canonical_catalog.json");
    const catalog = {
      version: "1.0.0",
      generatedAt: new Date().toISOString(),
      stats: {
        totalSets: allSets.length,
        totalCards: allCards.length,
        apiCallsUsed: progress.dailyCreditsUsed,
      },
      sets: allSets,
      cards: allCards,
    };

    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    fs.writeFileSync(exportPath, JSON.stringify(catalog, null, 2));
    log(`Exported catalog to ${exportPath}`);
  }

  if (config.exportCsv) {
    const exportDir = path.resolve(__dirname, "../../../exports");
    const setsCsvPath = path.join(exportDir, "canonical_sets.csv");
    const cardsCsvPath = path.join(exportDir, "canonical_cards.csv");

    writeCsv(
      setsCsvPath,
      ["ppt_set_id", "tcg_player_id", "name", "series", "release_date", "card_count", "has_price_guide"],
      allSets.map((s) => ({
        ppt_set_id: s.id,
        tcg_player_id: s.tcgPlayerId,
        name: s.name,
        series: s.series,
        release_date: s.releaseDate,
        card_count: s.cardCount,
        has_price_guide: s.hasPriceGuide ? 1 : 0,
      }))
    );

    writeCsv(
      cardsCsvPath,
      ["ppt_card_id", "ppt_set_id", "tcg_player_id", "set_name", "card_number", "total_set_number", "rarity", "card_type"],
      allCards.map((c) => ({
        ppt_card_id: c.id,
        ppt_set_id: c.setId,
        tcg_player_id: c.tcgPlayerId,
        set_name: c.setName,
        card_number: c.cardNumber ?? "",
        total_set_number: c.totalSetNumber ?? "",
        rarity: c.rarity ?? "",
        card_type: c.cardType ?? "",
      }))
    );

    log(`Exported CSV backups to ${exportDir}`);
  }

  if (database) {
    database.close();
  }

  // Sync to cardmint_dev.db if requested
  if (config.syncToDevDb && !config.dryRun) {
    try {
      await syncToDevDb(config);
    } catch (error) {
      log(`Warning: Failed to sync to dev DB: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log("Done!");
}

// ============================================================================
// Entry Point
// ============================================================================

const config = parseArgs();

buildCatalog(config).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
