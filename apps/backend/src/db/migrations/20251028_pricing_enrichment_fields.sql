-- Migration: Add pricing enrichment fields for PokePriceTracker integration
-- Date: 2025-10-28
-- Purpose: Support PPT API caching, pricing source tracking, and EverShop import workflow

-- ========================================
-- 1. Add pricing enrichment columns to products table
-- ========================================

-- Track pricing data source (PPT API vs CSV fallback vs manual)
ALTER TABLE products ADD COLUMN pricing_source TEXT
  CHECK(pricing_source IN ('ppt', 'csv', 'manual'));

-- Track pricing data freshness
ALTER TABLE products ADD COLUMN pricing_status TEXT
  CHECK(pricing_status IN ('fresh', 'stale', 'missing'))
  DEFAULT 'missing';

-- Track when pricing was last updated (Unix timestamp)
ALTER TABLE products ADD COLUMN pricing_updated_at INTEGER;

-- Gate for EverShop importer eligibility (0=not ready, 1=ready)
ALTER TABLE products ADD COLUMN staging_ready INTEGER DEFAULT 0
  CHECK(staging_ready IN (0, 1));

-- Track when product was last imported to EverShop
ALTER TABLE products ADD COLUMN last_imported_at INTEGER;

-- Track which import job last touched this product
ALTER TABLE products ADD COLUMN import_job_id TEXT;


-- ========================================
-- 2. Create PPT price cache table
-- ========================================

CREATE TABLE IF NOT EXISTS ppt_price_cache (
  cache_key TEXT PRIMARY KEY,
  -- Format: "{listing_sku}:{condition}" (e.g., "PKM:BASE:063:holo:EN:NM")

  listing_sku TEXT NOT NULL,
  -- Full listing SKU for reference

  condition TEXT NOT NULL,
  -- Condition bucket (NM, LP, MP, HP)

  market_price REAL,
  -- Raw market price from PPT

  ppt_card_id TEXT,
  -- PokePriceTracker internal card ID

  hp_value INTEGER,
  -- HP value from PPT (for validation)

  total_set_number TEXT,
  -- Total set number from PPT (e.g., "102" for Base Set)

  enrichment_signals TEXT,
  -- JSON blob with additional signals: {hp_match, set_total_match, attacks, etc.}

  cached_at INTEGER NOT NULL,
  -- Unix timestamp when cached

  ttl_hours INTEGER DEFAULT 24,
  -- Time-to-live in hours (24h default)

  UNIQUE(listing_sku, condition)
);

-- Index for cache expiry queries
CREATE INDEX IF NOT EXISTS idx_ppt_cache_expiry ON ppt_price_cache(cached_at);

-- Index for listing SKU lookups
CREATE INDEX IF NOT EXISTS idx_ppt_cache_sku ON ppt_price_cache(listing_sku);


-- ========================================
-- 3. Create quota tracking table
-- ========================================

CREATE TABLE IF NOT EXISTS ppt_quota_log (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,

  logged_at INTEGER NOT NULL,
  -- Unix timestamp

  calls_consumed INTEGER,
  -- From X-API-Calls-Consumed header

  daily_remaining INTEGER,
  -- From X-RateLimit-Daily-Remaining header

  minute_remaining INTEGER,
  -- From X-RateLimit-Minute-Remaining header

  tier TEXT NOT NULL,
  -- 'free' or 'paid'

  operation TEXT,
  -- 'backfill', 'enrichment', 'cache_refresh', etc.

  notes TEXT
  -- Additional context or warnings
);

-- Index for time-series quota analysis
CREATE INDEX IF NOT EXISTS idx_ppt_quota_time ON ppt_quota_log(logged_at DESC);


-- ========================================
-- 4. Create import job tracking table
-- ========================================

CREATE TABLE IF NOT EXISTS evershop_import_jobs (
  job_id TEXT PRIMARY KEY,
  -- UUID for this import job

  started_at INTEGER NOT NULL,
  completed_at INTEGER,

  environment TEXT NOT NULL,
  -- 'staging' or 'production'

  dry_run INTEGER DEFAULT 0,
  -- 0=real import, 1=dry-run mode

  total_skus INTEGER DEFAULT 0,
  created_count INTEGER DEFAULT 0,
  updated_count INTEGER DEFAULT 0,
  skipped_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,

  report_path TEXT,
  -- Path to detailed import_report.json

  notes TEXT,

  CHECK(dry_run IN (0, 1))
);

-- Index for recent job queries
CREATE INDEX IF NOT EXISTS idx_import_jobs_time ON evershop_import_jobs(started_at DESC);


-- ========================================
-- 5. Migration metadata
-- ========================================

-- Migration applied successfully
-- Timestamp: 2025-10-28
-- Changes:
--   - Added pricing_source, pricing_status, pricing_updated_at to products
--   - Added staging_ready, last_imported_at, import_job_id to products
--   - Created ppt_price_cache table with 24h TTL
--   - Created ppt_quota_log for rate tracking
--   - Created evershop_import_jobs for import workflow
