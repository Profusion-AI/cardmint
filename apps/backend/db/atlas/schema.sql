-- CardMint SQLite Schema Baseline
-- Owner: Claude Code | Generated: 2025-12-26 | Updated: 2025-12-27
--
-- This is the source of truth for Atlas drift detection.
--
-- REGENERATION COMMAND:
--   cd apps/backend && ./scripts/regenerate-baseline.sh
--
-- DRIFT CHECK:
--   cd apps/backend && ./scripts/regenerate-baseline.sh --check
--
-- EXCLUDED from baseline (intentionally):
--   - schema_migrations: Created dynamically by migrate.ts
--   - *_fts* virtual tables and triggers: SQLite FTS internal tables
--   - sqlite_* tables: SQLite internal tables
--
-- Protected columns (require SYNC-COLUMN-JUSTIFICATION in PR):
--   products: evershop_sync_state, sync_version, evershop_uuid, evershop_product_id, public_sku
--   items: sync_version, last_synced_at
--   sync_events: entire table
--   sync_leader: entire table

CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  image_path TEXT,
  extracted_json TEXT DEFAULT '{}',
  top3_json TEXT DEFAULT '[]',
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  operator_id TEXT,
  session_id TEXT,
  timings_json TEXT DEFAULT '{}'
, processor_id TEXT, locked_at INTEGER, market_price REAL, launch_price REAL, condition TEXT, sku TEXT, raw_image_path TEXT, processed_image_path TEXT, capture_uid TEXT, inference_path TEXT, item_uid TEXT, scan_fingerprint TEXT, phash TEXT, dhash TEXT, whash TEXT, orb_sig TEXT, capture_session_id TEXT, pose TEXT DEFAULT 'unknown', blur_score REAL, product_sku TEXT, listing_sku TEXT, cm_card_id TEXT, ppt_failure_count INTEGER DEFAULT 0, manifest_hash TEXT, manifest_version TEXT, accepted_name TEXT, accepted_hp INTEGER, accepted_collector_no TEXT, accepted_set_name TEXT, accepted_set_size INTEGER, accepted_variant_tags TEXT, listing_image_path TEXT, cdn_image_url TEXT, cdn_published_at INTEGER, scan_orientation TEXT CHECK(scan_orientation IS NULL OR scan_orientation IN ('front', 'back')), product_uid TEXT, camera_applied_controls_json TEXT, front_locked INTEGER DEFAULT 0, back_ready INTEGER DEFAULT 0, canonical_locked INTEGER DEFAULT 0, reconciliation_status TEXT
  CHECK(reconciliation_status IN ('pending', 'resolved', 'abandoned', NULL)), reconciliation_attempts INTEGER DEFAULT 0, reconciliation_last_attempt_at INTEGER, ppt_set_id TEXT, ppt_card_id TEXT, canonical_source TEXT NOT NULL DEFAULT 'pricecharting', back_image_path TEXT, master_image_path TEXT, master_cdn_url TEXT, corrected_image_path TEXT);
CREATE TABLE scan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT DEFAULT '{}',
  FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
);
CREATE TABLE scan_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at INTEGER NOT NULL,
  metric_key TEXT NOT NULL,
  metric_value REAL NOT NULL
);
CREATE INDEX idx_scans_status ON scans(status);
CREATE INDEX idx_scan_events_scan_id ON scan_events(scan_id);
CREATE INDEX idx_scan_metrics_key_time ON scan_metrics(metric_key, recorded_at);
CREATE TABLE reference_datasets (
  dataset_key TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_mtime INTEGER NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  ingested_at INTEGER NOT NULL
);
CREATE TABLE pricecharting_cards (
  id TEXT PRIMARY KEY,
  console_name TEXT,
  product_name TEXT NOT NULL,
  release_date TEXT,
  release_year INTEGER,
  sales_volume INTEGER DEFAULT 0,
  card_number TEXT,
  total_set_size TEXT,
  loose_price REAL,
  graded_price REAL
);
CREATE INDEX idx_pricecharting_cards_release_year
  ON pricecharting_cards(release_year);
CREATE INDEX idx_pricecharting_cards_card_number
  ON pricecharting_cards(card_number);
CREATE TABLE operator_sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'PREP',
  -- Status values: PREP, RUNNING, VALIDATING, CLOSED, ABORTED
  started_by TEXT,
  heartbeat_at INTEGER,
  phase TEXT DEFAULT 'PREP',
  -- Phase values: PREP (Phase 0), RUNNING (Phases 1-2), VALIDATING (Phase 3), CLOSED (Phase 4), ABORTED
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, baseline INTEGER DEFAULT 0 CHECK(baseline IN (0,1)));
CREATE TABLE operator_session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  phase TEXT,
  -- Event level: info, warning, error
  level TEXT NOT NULL DEFAULT 'info',
  -- Event source: session_start, session_end, session_abort, capture_triggered,
  -- placeholder_attached, job_status_changed, queue_cleared, gate_b_check, incident_logged
  source TEXT NOT NULL,
  message TEXT,
  -- JSON payload for structured data (count, jobId, exitCode, etc.)
  payload_json TEXT DEFAULT '{}',
  FOREIGN KEY (session_id) REFERENCES operator_sessions(id) ON DELETE CASCADE
);
CREATE INDEX idx_operator_sessions_status ON operator_sessions(status);
CREATE INDEX idx_operator_sessions_phase ON operator_sessions(phase);
CREATE INDEX idx_operator_session_events_session_id ON operator_session_events(session_id);
CREATE INDEX idx_operator_session_events_timestamp ON operator_session_events(timestamp);
CREATE INDEX idx_operator_session_events_level ON operator_session_events(level);
CREATE INDEX idx_scans_raw_image_path ON scans(raw_image_path);
CREATE INDEX idx_scans_processed_image_path ON scans(processed_image_path);
CREATE INDEX idx_scans_capture_uid ON scans(capture_uid);
CREATE INDEX idx_scans_inference_path ON scans(inference_path);
CREATE TABLE cm_sets (
  cm_set_id TEXT PRIMARY KEY,
  -- CardMint canonical set identifier (e.g., "SV04" for Paradox Rift)
  -- Used in SKU: PKM:{cm_set_id}:{collector_no}:{variant}:{lang}

  set_name TEXT NOT NULL,
  -- Full set name (e.g., "Scarlet & Violet—Paradox Rift")

  release_date TEXT,
  -- ISO 8601 date (YYYY-MM-DD)

  release_year INTEGER,
  -- Extracted year for range queries

  total_cards INTEGER,
  -- Total card count including secret rares

  series TEXT,
  -- Series grouping (e.g., "Scarlet & Violet", "Sword & Shield")

  ptcgo_code TEXT,
  -- Pokemon Trading Card Game Online set code (if applicable)

  notes TEXT,
  -- Operator notes or special handling instructions

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, ppt_id TEXT, tcgplayer_id TEXT);
CREATE INDEX idx_cm_sets_release_year ON cm_sets(release_year);
CREATE INDEX idx_cm_sets_series ON cm_sets(series);
CREATE INDEX idx_cm_sets_ptcgo_code ON cm_sets(ptcgo_code);
CREATE TABLE cm_cards (
  cm_card_id TEXT PRIMARY KEY,
  -- CardMint canonical card identifier (format: {cm_set_id}-{collector_no}-{variant_suffix})
  -- Example: "SV04-177-a" for Morgrem base variant, "SV04-177-holo" for holo variant

  cm_set_id TEXT NOT NULL,
  -- Foreign key to cm_sets

  collector_no TEXT NOT NULL,
  -- Collector number as printed on card (e.g., "177", "177/264")

  card_name TEXT NOT NULL,
  -- Canonical card name (e.g., "Morgrem")

  hp_value INTEGER,
  -- HP value (null for Trainer/Energy cards)

  card_type TEXT,
  -- Card type: Pokemon, Trainer, Energy, Special Energy

  rarity TEXT,
  -- Rarity code: Common, Uncommon, Rare, Ultra Rare, Secret Rare, etc.

  variant_bits TEXT,
  -- Variant encoding: holo, reverse-holo, full-art, alt-art, etc.
  -- Format: comma-separated flags aligned with reranker logic
  -- Examples: "holo", "reverse-holo", "full-art,holo", "base"

  lang TEXT NOT NULL DEFAULT 'EN',
  -- Language code: EN, JP, FR, DE, ES, IT, etc.

  artist TEXT,
  -- Card artist name

  notes TEXT,
  -- Operator notes or special handling

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (cm_set_id) REFERENCES cm_sets(cm_set_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_cm_cards_identity
  ON cm_cards(cm_set_id, collector_no, variant_bits, lang);
CREATE INDEX idx_cm_cards_set_id ON cm_cards(cm_set_id);
CREATE INDEX idx_cm_cards_card_name ON cm_cards(card_name);
CREATE INDEX idx_cm_cards_rarity ON cm_cards(rarity);
CREATE TABLE cm_pricecharting_bridge (
  cm_card_id TEXT NOT NULL,
  -- CardMint canonical card ID

  pricecharting_id TEXT NOT NULL,
  -- PriceCharting product ID (from data/pricecharting-pokemon-cards.csv)

  confidence REAL NOT NULL DEFAULT 1.0,
  -- Mapping confidence (1.0 = exact match, <1.0 = fuzzy/operator override)

  match_method TEXT NOT NULL,
  -- How mapping was created: "exact", "fuzzy", "operator", "backfill"

  verified_at INTEGER,
  -- Timestamp when operator verified this mapping (null = unverified)

  verified_by TEXT,
  -- Operator ID who verified mapping

  notes TEXT,
  -- Operator notes on mapping quality or edge cases

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, is_valid INTEGER DEFAULT 1 CHECK(is_valid IN (0, 1)),

  PRIMARY KEY (cm_card_id, pricecharting_id),
  FOREIGN KEY (cm_card_id) REFERENCES cm_cards(cm_card_id) ON DELETE CASCADE,
  FOREIGN KEY (pricecharting_id) REFERENCES pricecharting_cards(id) ON DELETE CASCADE
);
CREATE INDEX idx_cm_pricecharting_cm_card ON cm_pricecharting_bridge(cm_card_id);
CREATE INDEX idx_cm_pricecharting_pc_id ON cm_pricecharting_bridge(pricecharting_id);
CREATE INDEX idx_cm_pricecharting_confidence ON cm_pricecharting_bridge(confidence);
CREATE TABLE cm_tcgplayer_bridge (
  cm_card_id TEXT NOT NULL,
  -- CardMint canonical card ID

  tcgplayer_id TEXT NOT NULL,
  -- TCGPlayer product ID

  tcgplayer_sku TEXT,
  -- TCGPlayer SKU if available

  confidence REAL NOT NULL DEFAULT 1.0,
  -- Mapping confidence

  match_method TEXT NOT NULL,
  -- How mapping was created

  verified_at INTEGER,
  -- Verification timestamp

  verified_by TEXT,
  -- Operator ID

  notes TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (cm_card_id, tcgplayer_id),
  FOREIGN KEY (cm_card_id) REFERENCES cm_cards(cm_card_id) ON DELETE CASCADE
);
CREATE INDEX idx_cm_tcgplayer_cm_card ON cm_tcgplayer_bridge(cm_card_id);
CREATE INDEX idx_cm_tcgplayer_tc_id ON cm_tcgplayer_bridge(tcgplayer_id);
CREATE INDEX idx_cm_tcgplayer_confidence ON cm_tcgplayer_bridge(confidence);
CREATE TABLE items (
  item_uid TEXT PRIMARY KEY,
  -- Unique item identifier (UUID v4)

  product_uid TEXT NOT NULL,
  -- Foreign key to products (which card identity this is)

  quantity INTEGER NOT NULL DEFAULT 1,
  -- Quantity in this item (usually 1, but supports batching)

  acquisition_date INTEGER,
  -- When this item was acquired (timestamp)

  acquisition_source TEXT,
  -- Acquisition source: "scan", "bulk_import", "operator_entry"

  capture_session_id TEXT,
  -- Foreign key to operator_sessions (which session captured this item)

  location TEXT,
  -- Physical storage location (shelf, bin, etc.)

  internal_notes TEXT,
  -- Internal operator notes (not customer-facing)

  status TEXT NOT NULL DEFAULT 'IN_STOCK',
  -- Status: IN_STOCK, RESERVED, SOLD, FLAGGED, REMOVED
  -- IN_STOCK: available for sale
  -- RESERVED: held for pending order
  -- SOLD: sold and shipped
  -- FLAGGED: operator flagged for review
  -- REMOVED: removed from inventory (damaged, etc.)

  sold_at INTEGER,
  -- Timestamp when sold

  sold_price REAL,
  -- Actual sale price

  removed_at INTEGER,
  -- Timestamp when removed from inventory

  removed_reason TEXT,
  -- Reason for removal: "damaged", "lost", "operator_error", "other"

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, stripe_product_id TEXT, stripe_price_id TEXT, checkout_session_id TEXT, payment_intent_id TEXT, reserved_until INTEGER, sync_version INTEGER DEFAULT 1, last_synced_at INTEGER, cart_session_id TEXT, reservation_type TEXT CHECK(reservation_type IN ('cart', 'checkout')), cart_reserved_at INTEGER,

  FOREIGN KEY (product_uid) REFERENCES products(product_uid) ON DELETE CASCADE,
  FOREIGN KEY (capture_session_id) REFERENCES operator_sessions(id) ON DELETE SET NULL,

  CHECK (quantity > 0),
  CHECK (status IN ('IN_STOCK', 'RESERVED', 'SOLD', 'FLAGGED', 'REMOVED'))
);
CREATE INDEX idx_items_product ON items(product_uid);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_session ON items(capture_session_id);
CREATE INDEX idx_items_acquisition_date ON items(acquisition_date);
CREATE INDEX idx_scans_item_uid ON scans(item_uid);
CREATE TABLE ppt_price_cache (
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

  ttl_hours INTEGER DEFAULT 24, canonical_sku TEXT,
  -- Time-to-live in hours (24h default)

  UNIQUE(listing_sku, condition)
);
CREATE INDEX idx_ppt_cache_expiry ON ppt_price_cache(cached_at);
CREATE INDEX idx_ppt_cache_sku ON ppt_price_cache(listing_sku);
CREATE TABLE ppt_quota_log (
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
CREATE INDEX idx_ppt_quota_time ON ppt_quota_log(logged_at DESC);
CREATE TABLE evershop_import_jobs (
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
CREATE INDEX idx_import_jobs_time ON evershop_import_jobs(started_at DESC);
CREATE INDEX idx_scans_ppt_failures ON scans(ppt_failure_count);
CREATE INDEX idx_operator_sessions_baseline ON operator_sessions(baseline);
CREATE INDEX idx_scans_accepted_name ON scans(accepted_name);
CREATE INDEX idx_scans_accepted_collector_no ON scans(accepted_collector_no);
CREATE INDEX idx_scans_accepted_set_size ON scans(accepted_set_size);
CREATE INDEX idx_scans_cdn_url ON scans(cdn_image_url);
CREATE INDEX idx_cm_pricecharting_valid ON cm_pricecharting_bridge(is_valid);
CREATE TABLE product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_uid TEXT NOT NULL,
  orientation TEXT NOT NULL CHECK(orientation IN ('front', 'back')),
  raw_path TEXT,                  -- Original image from kiosk (before processing)
  processed_path TEXT,            -- After image pipeline (distortion correction, etc.)
  cdn_url TEXT,                   -- After CDN upload (published URL)
  published_at INTEGER,           -- Unix timestamp when CDN upload completed
  source_scan_id TEXT,            -- FK to scans.id (if this image came from a scan)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Each product can have at most ONE front and ONE back image
  UNIQUE(product_uid, orientation),

  FOREIGN KEY (product_uid) REFERENCES products(product_uid) ON DELETE CASCADE
);
CREATE INDEX idx_product_images_product ON product_images(product_uid);
CREATE INDEX idx_product_images_orientation ON product_images(product_uid, orientation);
CREATE INDEX idx_scans_orientation ON scans(scan_orientation);
CREATE INDEX idx_scans_product_uid ON scans(product_uid);
CREATE INDEX idx_ppt_price_cache_canonical_sku ON ppt_price_cache(canonical_sku);
CREATE INDEX idx_scans_front_locked ON scans(front_locked);
CREATE INDEX idx_scans_back_ready ON scans(back_ready);
CREATE INDEX idx_scans_canonical_locked ON scans(canonical_locked);
CREATE INDEX idx_scans_stage1b_ready ON scans(back_ready, canonical_locked) WHERE back_ready = 1 AND canonical_locked = 1;
CREATE TABLE IF NOT EXISTS "products" (
  product_uid TEXT PRIMARY KEY,
  cm_card_id TEXT,  -- Now nullable, FK removed to allow orphaned inventory
  condition_bucket TEXT NOT NULL DEFAULT 'UNKNOWN',
  product_sku TEXT NOT NULL UNIQUE,
  listing_sku TEXT NOT NULL,
  card_name TEXT NOT NULL,
  set_name TEXT NOT NULL,
  collector_no TEXT NOT NULL,
  hp_value INTEGER,
  rarity TEXT,
  market_price REAL,
  launch_price REAL,
  pricing_channel TEXT,
  total_quantity INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Columns from 20251028_pricing_enrichment_fields
  pricing_source TEXT,
  pricing_status TEXT,
  pricing_updated_at INTEGER,
  staging_ready INTEGER DEFAULT 0,
  last_imported_at INTEGER,
  import_job_id TEXT,
  -- Columns from 20251103_manual_override_schema
  accepted_without_canonical INTEGER DEFAULT 0,
  manual_reason_code TEXT,
  manual_note TEXT,
  -- Columns from 20251113_image_pipeline_cdn
  listing_image_path TEXT,
  cdn_image_url TEXT,
  primary_scan_id TEXT,
  -- Columns from 20251117_production_inventory_readiness
  product_slug TEXT,
  ppt_enriched_at INTEGER,
  cdn_back_image_url TEXT,
  -- Columns from 20251118_canonical_sku_product_identity
  canonical_sku TEXT, ppt_set_id TEXT, ppt_card_id TEXT, canonical_source TEXT NOT NULL DEFAULT 'pricecharting', sync_version INTEGER DEFAULT 1, last_synced_at INTEGER, promoted_at INTEGER, evershop_product_id INTEGER, evershop_published_at INTEGER, evershop_sync_state TEXT
  CHECK (evershop_sync_state IN (
    'not_synced', 'vault_only', 'evershop_hidden', 'evershop_live', 'sync_error'
  )) DEFAULT 'not_synced', public_sku TEXT, variant_tags TEXT, evershop_uuid TEXT, master_back_cdn_url TEXT, cdn_published_at INTEGER,
  CHECK (condition_bucket IN ('NM', 'LP', 'MP', 'HP', 'UNKNOWN', 'NO_CONDITION'))
);
CREATE INDEX idx_products_sku ON products(product_sku);
CREATE INDEX idx_products_listing_sku ON products(listing_sku);
CREATE INDEX idx_products_cm_card_id ON products(cm_card_id);
CREATE INDEX idx_products_condition ON products(condition_bucket);
CREATE INDEX idx_products_pricing_channel ON products(pricing_channel);
CREATE INDEX idx_products_manual_override ON products(manual_reason_code) WHERE manual_reason_code IS NOT NULL;
CREATE INDEX idx_products_accepted_without_canonical ON products(accepted_without_canonical);
CREATE INDEX idx_products_cdn_image_url ON products(cdn_image_url);
CREATE INDEX idx_products_slug ON products(product_slug);
CREATE INDEX idx_products_canonical_sku ON products(canonical_sku);
CREATE TRIGGER items_ai_update_product_quantity
AFTER INSERT ON items
BEGIN
  UPDATE products
  SET total_quantity = (
    SELECT COALESCE(SUM(quantity), 0)
    FROM items
    WHERE product_uid = NEW.product_uid
      AND status IN ('IN_STOCK', 'RESERVED')
  ),
  updated_at = strftime('%s', 'now')
  WHERE product_uid = NEW.product_uid;
END;
CREATE TRIGGER items_au_update_product_quantity
AFTER UPDATE ON items
BEGIN
  UPDATE products
  SET total_quantity = (
    SELECT COALESCE(SUM(quantity), 0)
    FROM items
    WHERE product_uid = NEW.product_uid
      AND status IN ('IN_STOCK', 'RESERVED')
  ),
  updated_at = strftime('%s', 'now')
  WHERE product_uid = NEW.product_uid;
END;
CREATE TRIGGER items_ad_update_product_quantity
AFTER DELETE ON items
BEGIN
  UPDATE products
  SET total_quantity = (
    SELECT COALESCE(SUM(quantity), 0)
    FROM items
    WHERE product_uid = OLD.product_uid
      AND status IN ('IN_STOCK', 'RESERVED')
  ),
  updated_at = strftime('%s', 'now')
  WHERE product_uid = OLD.product_uid;
END;
CREATE INDEX idx_scans_reconciliation_status
  ON scans(reconciliation_status)
  WHERE reconciliation_status IS NOT NULL;
CREATE TABLE canonical_sets (
  ppt_set_id TEXT PRIMARY KEY,           -- PPT MongoDB ObjectId (e.g., "68af47dd190c4823de25295f")
  tcg_player_id TEXT UNIQUE NOT NULL,    -- TCGPlayer slug (e.g., "team-rocket", "base-set")
  name TEXT NOT NULL,                     -- Display name (e.g., "Team Rocket")
  series TEXT,                            -- Series grouping (e.g., "Base", "Scarlet & Violet")
  release_date TEXT,                      -- ISO 8601 date string
  card_count INTEGER,                     -- Official card count for the set
  has_price_guide INTEGER DEFAULT 1,      -- Whether TCGPlayer has pricing
  image_url TEXT,                         -- Set logo/icon URL
  fetched_at INTEGER NOT NULL             -- Unix timestamp of fetch
);
CREATE INDEX idx_canonical_sets_name ON canonical_sets(name);
CREATE INDEX idx_canonical_sets_series ON canonical_sets(series);
CREATE INDEX idx_canonical_sets_release ON canonical_sets(release_date);
CREATE TABLE canonical_cards (
  ppt_card_id TEXT PRIMARY KEY,           -- PPT MongoDB ObjectId
  tcg_player_id TEXT UNIQUE NOT NULL,     -- TCGPlayer product ID (deterministic lookup key)
  set_tcg_player_id TEXT NOT NULL,        -- FK to canonical_sets.tcg_player_id
  name TEXT NOT NULL,                      -- Card name (e.g., "Dark Raichu")
  card_number TEXT,                        -- Set position (e.g., "83/82", "025")
  total_set_number TEXT,                   -- Total cards in set (e.g., "82")
  rarity TEXT,                             -- Rarity (e.g., "Secret Rare", "Holo Rare")
  card_type TEXT,                          -- Type (e.g., "Lightning", "Fire", "Trainer")
  hp INTEGER,                              -- HP value for Pokemon cards
  stage TEXT,                              -- Evolution stage (e.g., "Basic", "Stage 1")

  -- Pricing snapshot (Near Mint as primary reference)
  market_price REAL,                       -- Current market price (NM default)
  price_nm REAL,                           -- Near Mint price
  price_lp REAL,                           -- Lightly Played price
  price_mp REAL,                           -- Moderately Played price
  price_hp REAL,                           -- Heavily Played price
  price_dmg REAL,                          -- Damaged price

  -- Variant availability flags
  has_1st_edition INTEGER DEFAULT 0,
  has_unlimited INTEGER DEFAULT 0,
  has_reverse_holo INTEGER DEFAULT 0,
  has_holofoil INTEGER DEFAULT 0,

  -- Links and metadata
  tcg_player_url TEXT,                     -- Direct link to TCGPlayer listing
  fetched_at INTEGER NOT NULL, first_seen_at INTEGER, last_seen_at INTEGER,             -- Unix timestamp of fetch

  FOREIGN KEY (set_tcg_player_id) REFERENCES canonical_sets(tcg_player_id)
);
CREATE INDEX idx_canonical_cards_set ON canonical_cards(set_tcg_player_id);
CREATE INDEX idx_canonical_cards_name ON canonical_cards(name);
CREATE INDEX idx_canonical_cards_number ON canonical_cards(card_number);
CREATE INDEX idx_canonical_cards_tcgp ON canonical_cards(tcg_player_id);
CREATE INDEX idx_canonical_cards_set_number ON canonical_cards(set_tcg_player_id, card_number);
CREATE TABLE canonical_catalog_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "canonical_reconciliation_events_legacy" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cm_card_id TEXT,                   -- Truth Core reference (nullable)
  pricecharting_card_id TEXT,        -- PriceCharting reference (nullable)
  ppt_card_id TEXT,                  -- PPT reference (nullable)
  conflict_reason TEXT NOT NULL,     -- name_mismatch, missing_in_ppt, missing_in_pc, set_mismatch
  details TEXT,                      -- JSON with specifics
  first_seen_at INTEGER NOT NULL,    -- When conflict first detected
  last_seen_at INTEGER NOT NULL,     -- Most recent occurrence
  resolved_at INTEGER,               -- Null until manually resolved
  UNIQUE(cm_card_id, pricecharting_card_id, ppt_card_id, conflict_reason)
);
CREATE INDEX idx_reconciliation_reason ON "canonical_reconciliation_events_legacy"(conflict_reason);
CREATE INDEX idx_reconciliation_unresolved ON "canonical_reconciliation_events_legacy"(resolved_at) WHERE resolved_at IS NULL;
CREATE TABLE canonical_refresh_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,            -- 'full' | 'maintenance'
  started_at TEXT NOT NULL,          -- ISO 8601 timestamp
  finished_at TEXT,                  -- ISO 8601 timestamp (null if in progress)
  sets_count INTEGER,                -- Sets in catalog after run
  cards_count INTEGER,               -- Cards in catalog after run
  coverage_ratio REAL,               -- Cards mapped vs PPT metadata
  status TEXT NOT NULL,              -- 'success' | 'failed' | 'in_progress'
  notes TEXT                         -- Human-readable notes
);
CREATE INDEX idx_refresh_runs_status ON canonical_refresh_runs(status);
CREATE INDEX idx_refresh_runs_type_status ON canonical_refresh_runs(run_type, status);
CREATE VIEW canonical_refresh_baseline AS
SELECT *
FROM canonical_refresh_runs
WHERE run_type = 'full' AND status = 'success'
ORDER BY finished_at DESC
LIMIT 1
/* canonical_refresh_baseline(id,run_type,started_at,finished_at,sets_count,cards_count,coverage_ratio,status,notes) */;
CREATE TABLE IF NOT EXISTS "canonical_backfill_runs_legacy" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,          -- ISO 8601 timestamp
  finished_at TEXT,                  -- ISO 8601 timestamp
  total_scans INTEGER,               -- Total scans processed
  backfilled_ppt INTEGER,            -- Mapped to canonical with PPT IDs
  backfilled_pc_only INTEGER,        -- PriceCharting only, no PPT ID
  unmapped INTEGER,                  -- Anomalies requiring review
  status TEXT NOT NULL               -- 'success' | 'failed' | 'in_progress'
, total_products INTEGER, backfilled_products_ppt INTEGER, backfilled_products_pc_only INTEGER, products_unmapped INTEGER, run_type TEXT DEFAULT 'scans+products', notes TEXT);
CREATE INDEX idx_cm_sets_ppt_id ON cm_sets(ppt_id);
CREATE INDEX idx_cm_sets_tcgplayer_id ON cm_sets(tcgplayer_id);
CREATE INDEX idx_scans_ppt_card_id ON scans(ppt_card_id);
CREATE INDEX idx_scans_ppt_set_id ON scans(ppt_set_id);
CREATE INDEX idx_products_ppt_card_id ON products(ppt_card_id);
CREATE INDEX idx_products_ppt_set_id ON products(ppt_set_id);
CREATE INDEX idx_scans_back_image_path ON scans(back_image_path) WHERE back_image_path IS NOT NULL;
CREATE INDEX idx_scans_master_cdn_url ON scans(master_cdn_url) WHERE master_cdn_url IS NOT NULL;
CREATE INDEX idx_items_reserved_until ON items(reserved_until)
  WHERE status = 'RESERVED' AND reserved_until IS NOT NULL;
CREATE TABLE stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  item_uid TEXT,
  processed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (item_uid) REFERENCES items(item_uid)
);
CREATE INDEX idx_stripe_events_item ON stripe_webhook_events(item_uid);
CREATE TABLE evershop_import_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  job_id TEXT,
  user_id TEXT,
  client_ip TEXT,
  request_hash TEXT NOT NULL,  -- SHA256 of sorted payload for replay detection
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  completed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'  -- pending, completed, failed, aborted
);
CREATE INDEX idx_idem_created ON evershop_import_idempotency(created_at);
CREATE INDEX idx_idem_status ON evershop_import_idempotency(status);
CREATE TABLE evershop_import_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  idempotency_key TEXT NOT NULL,
  user_id TEXT,
  client_ip TEXT,
  user_agent TEXT,
  payload_summary TEXT,  -- JSON: {limit, sku_count, first_skus: [...]}
  confirm_mode INTEGER NOT NULL DEFAULT 0,  -- 0=dry_run, 1=confirmed
  products_imported INTEGER DEFAULT 0,
  products_created INTEGER DEFAULT 0,
  products_updated INTEGER DEFAULT 0,
  products_errored INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  completed_at INTEGER,
  result_status TEXT,  -- success, partial, failed
  error_message TEXT
);
CREATE INDEX idx_audit_user ON evershop_import_audit(user_id);
CREATE INDEX idx_audit_started ON evershop_import_audit(started_at);
CREATE INDEX idx_audit_job ON evershop_import_audit(job_id);
CREATE TABLE canonical_backfill_runs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL,
    items_processed INTEGER DEFAULT 0,
    items_mapped INTEGER DEFAULT 0,
    items_unmapped INTEGER DEFAULT 0,
    details TEXT
);
CREATE TABLE canonical_reconciliation_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(run_id) REFERENCES canonical_backfill_runs(id)
);
CREATE INDEX idx_backfill_events_run_id ON canonical_reconciliation_events(run_id);
CREATE INDEX idx_backfill_events_entity ON canonical_reconciliation_events(entity_type, entity_id);
CREATE INDEX idx_backfill_events_type ON canonical_reconciliation_events(event_type);
CREATE TABLE sync_leader (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_owner TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL
);
CREATE INDEX idx_products_promoted_at ON products(promoted_at);
CREATE INDEX idx_products_sync_version ON products(sync_version);
CREATE INDEX idx_products_evershop_state ON products(evershop_sync_state);
CREATE UNIQUE INDEX idx_products_public_sku ON products(public_sku)
  WHERE public_sku IS NOT NULL;
CREATE INDEX idx_products_variant_tags ON products(variant_tags) WHERE variant_tags IS NOT NULL;
CREATE TABLE email_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT DEFAULT 'vault_landing',
  ip_address TEXT,
  unsubscribed_at TEXT
, deleted_at INTEGER, deletion_reason TEXT);
CREATE INDEX idx_email_subscribers_email ON email_subscribers(email);
CREATE INDEX idx_email_subscribers_subscribed_at ON email_subscribers(subscribed_at);
CREATE UNIQUE INDEX idx_products_evershop_uuid ON products(evershop_uuid)
  WHERE evershop_uuid IS NOT NULL;
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uid TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'evershop_product_updated', 'evershop_product_created', 'evershop_product_deleted',
    'stripe_checkout_completed', 'stripe_payment_failed'
  )),
  source TEXT NOT NULL CHECK(source IN ('evershop', 'stripe', 'internal')),
  payload JSON NOT NULL,
  product_uid TEXT,
  item_uid TEXT,
  processed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending', 'processed', 'failed', 'skipped'
  )),
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (product_uid) REFERENCES products(product_uid)
);
CREATE INDEX idx_webhook_events_status ON webhook_events(status);
CREATE INDEX idx_webhook_events_source ON webhook_events(source);
CREATE INDEX idx_webhook_events_product ON webhook_events(product_uid);
CREATE INDEX idx_webhook_events_created ON webhook_events(created_at);
CREATE TABLE klaviyo_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id TEXT NOT NULL,       -- Link to stripe_webhook_events for audit trail
  event_type TEXT NOT NULL,            -- 'Placed Order', 'Ordered Product', etc.
  payload TEXT NOT NULL,               -- Full JSON payload sent to Klaviyo
  status TEXT DEFAULT 'pending',       -- pending, sent, failed
  response_code INTEGER,               -- HTTP response code from Klaviyo
  error_message TEXT,                  -- Error details if failed
  created_at INTEGER NOT NULL,         -- Unix timestamp when logged
  sent_at INTEGER,                     -- Unix timestamp when successfully sent
  FOREIGN KEY (stripe_event_id) REFERENCES stripe_webhook_events(event_id)
);
CREATE INDEX idx_klaviyo_log_status ON klaviyo_event_log(status)
  WHERE status IN ('pending', 'failed');
CREATE INDEX idx_klaviyo_log_stripe_event ON klaviyo_event_log(stripe_event_id);
CREATE TABLE privacy_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT NOT NULL,              -- Base64 encoded email (for audit without storing PII)
  request_type TEXT NOT NULL,            -- 'deletion', 'export', 'correction'
  ip_address TEXT,                       -- IP for rate limiting / fraud detection
  requested_at INTEGER NOT NULL,         -- Unix timestamp
  completed_at INTEGER,                  -- When request was fulfilled
  status TEXT DEFAULT 'processing',      -- 'processing', 'completed', 'failed'
  notes TEXT                             -- Admin notes if needed
);
CREATE INDEX idx_privacy_requests_email_hash ON privacy_requests(email_hash);
CREATE INDEX idx_privacy_requests_status ON privacy_requests(status);
CREATE INDEX idx_email_subscribers_deleted ON email_subscribers(deleted_at);
CREATE INDEX idx_items_cart_session ON items(cart_session_id)
  WHERE cart_session_id IS NOT NULL;
CREATE INDEX idx_items_cart_expiry ON items(reserved_until, reservation_type)
  WHERE status = 'RESERVED' AND reservation_type = 'cart' AND reserved_until IS NOT NULL;
CREATE INDEX idx_items_checkout_expiry ON items(reserved_until, reservation_type)
  WHERE status = 'RESERVED' AND reservation_type = 'checkout' AND reserved_until IS NOT NULL;
CREATE TABLE cart_rate_limits (
  ip_address TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ip_address, window_start)
);
CREATE INDEX idx_cart_rate_limits_window ON cart_rate_limits(window_start);
CREATE TABLE capture_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Enforce single row

  -- Camera controls (Pi5 HQ camera via kiosk)
  exposure_us INTEGER DEFAULT 10101,           -- ExposureTime in microseconds
  analogue_gain REAL DEFAULT 1.115,            -- AnalogueGain
  colour_gains_red REAL DEFAULT 2.38,          -- ColourGains[0] (red)
  colour_gains_blue REAL DEFAULT 1.98,         -- ColourGains[1] (blue)
  ae_enable INTEGER DEFAULT 0,                 -- AeEnable (0=false, 1=true)
  awb_enable INTEGER DEFAULT 0,                -- AwbEnable (0=false, 1=true)

  -- Stage-3 processing parameters (listing asset generation)
  clahe_clip_limit REAL DEFAULT 1.5,           -- CLAHE clipLimit
  clahe_tile_size INTEGER DEFAULT 8,           -- CLAHE tileGridSize (NxN)
  stage3_awb_enable INTEGER DEFAULT 1,         -- Auto white balance (gray world)

  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE calibration_captures (
  id TEXT PRIMARY KEY,                         -- UUID
  capture_uid TEXT NOT NULL UNIQUE,            -- Pi5 kiosk UID (for SFTP detection)

  -- Image paths (populated as pipeline progresses)
  raw_image_path TEXT,                         -- Raw capture from Pi5
  stage1_image_path TEXT,                      -- After distortion correction
  stage2_image_path TEXT,                      -- After resize/compress
  processed_image_path TEXT,                   -- After Stage-3 (listing asset)

  -- Settings snapshots
  settings_snapshot_json TEXT,                 -- Camera settings at capture time
  stage3_params_json TEXT,                     -- Stage-3 params used for processing

  -- Status tracking
  status TEXT DEFAULT 'PENDING' CHECK(status IN (
    'PENDING',      -- Capture requested, waiting for SFTP
    'CAPTURED',     -- Raw image received from SFTP
    'STAGE1',       -- Distortion correction complete
    'STAGE2',       -- Resize/compress complete
    'PROCESSED',    -- Stage-3 complete, ready for preview
    'EXPIRED',      -- TTL exceeded, pending cleanup
    'FAILED'        -- Processing error
  )),
  error_message TEXT,                          -- Error details if FAILED

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL                  -- TTL for auto-cleanup (1h default)
);
CREATE INDEX idx_calibration_captures_uid ON calibration_captures(capture_uid);
CREATE INDEX idx_calibration_captures_status ON calibration_captures(status);
CREATE INDEX idx_calibration_captures_expires ON calibration_captures(expires_at);
CREATE TABLE sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uid TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'promote', 'sale', 'price_update', 'return', 'rollback', 'unpromote',
    'evershop_hide_listing'
  )),
  product_uid TEXT NOT NULL,
  item_uid TEXT,
  stripe_session_id TEXT,
  product_sku TEXT,
  source_db TEXT NOT NULL CHECK(source_db IN ('staging', 'production')),
  target_db TEXT NOT NULL CHECK(target_db IN ('staging', 'production')),
  operator_id TEXT,
  payload JSON NOT NULL,
  stripe_event_id TEXT REFERENCES stripe_webhook_events(event_id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending', 'synced', 'failed', 'conflict', 'partial_failure'
  )),
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  synced_at INTEGER,
  FOREIGN KEY (product_uid) REFERENCES products(product_uid)
);
CREATE UNIQUE INDEX idx_sync_events_pending_product
  ON sync_events(product_uid, event_type)
  WHERE status = 'pending';
CREATE INDEX idx_sync_events_status ON sync_events(status);
CREATE INDEX idx_sync_events_type ON sync_events(event_type);
CREATE INDEX idx_sync_events_product ON sync_events(product_uid);
CREATE INDEX idx_sync_events_stripe ON sync_events(stripe_event_id);
CREATE UNIQUE INDEX idx_sync_events_evershop_hide_dedupe
  ON sync_events(event_type, stripe_session_id, product_sku)
  WHERE event_type = 'evershop_hide_listing'
    AND stripe_session_id IS NOT NULL
    AND product_sku IS NOT NULL;
CREATE TABLE orders (
  order_uid TEXT PRIMARY KEY,  -- UUID v4
  order_number TEXT NOT NULL UNIQUE,  -- Format: CM-YYYYMMDD-######
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,

  -- Order totals (denormalized for quick lookup)
  item_count INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,

  -- Status mirrors fulfillment for customer-facing display
  -- Mapping: confirmed=pending, processing=label_purchased, shipped, delivered, exception
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN (
    'confirmed',      -- Order placed, awaiting fulfillment
    'processing',     -- Label purchased, being prepared
    'shipped',        -- In transit
    'delivered',      -- Carrier confirmed delivery
    'exception'       -- Delivery issue
  )),

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_orders_status ON orders(status);
CREATE TRIGGER orders_updated_at AFTER UPDATE ON orders
BEGIN
  UPDATE orders SET updated_at = strftime('%s', 'now') WHERE order_uid = NEW.order_uid;
END;
CREATE TABLE IF NOT EXISTS "fulfillment" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Stripe correlation (primary key for lookups)
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,

  -- Order metadata
  item_count INTEGER NOT NULL,
  original_subtotal_cents INTEGER NOT NULL,
  final_subtotal_cents INTEGER NOT NULL,

  -- Shipping method & cost (calculated at checkout)
  shipping_method TEXT NOT NULL CHECK(shipping_method IN ('TRACKED', 'PRIORITY')),
  shipping_cost_cents INTEGER NOT NULL,

  -- Manual review workflow (for orders >$100)
  requires_manual_review INTEGER NOT NULL DEFAULT 0,
  manual_review_completed_at INTEGER,
  manual_review_notes TEXT,
  manual_review_by TEXT,

  -- Fulfillment status (UPDATED: added 'processing' for atomic claim)
  -- pending: awaiting operator action
  -- processing: claimed by auto-fulfillment worker (prevents race)
  -- reviewed: manual review complete (if required)
  -- label_purchased: EasyPost label created
  -- shipped: handed to carrier
  -- delivered: carrier confirmed delivery
  -- exception: delivery issue or cost guardrail triggered
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'processing', 'reviewed', 'label_purchased',
                     'shipped', 'delivered', 'exception')),

  -- Carrier & tracking (populated after label purchase)
  carrier TEXT,
  tracking_number TEXT,
  tracking_url TEXT,

  -- Shippo integration (legacy, preserved for backward compatibility)
  shippo_transaction_id TEXT,
  shippo_rate_id TEXT,
  label_url TEXT,
  label_purchased_at INTEGER,

  -- Delivery tracking
  shipped_at INTEGER,
  estimated_delivery_date TEXT,
  delivered_at INTEGER,

  -- Exception handling
  exception_type TEXT,
  exception_notes TEXT,
  exception_at INTEGER,

  -- Audit timestamps
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),

  -- EasyPost columns (from 20251223_easypost_integration.sql)
  easypost_shipment_id TEXT,
  easypost_rate_id TEXT,
  easypost_service TEXT,
  label_cost_cents INTEGER
);
CREATE INDEX idx_fulfillment_status ON fulfillment(status);
CREATE INDEX idx_fulfillment_manual_review ON fulfillment(requires_manual_review, status)
  WHERE requires_manual_review = 1 AND status = 'pending';
CREATE INDEX idx_fulfillment_tracking ON fulfillment(tracking_number)
  WHERE tracking_number IS NOT NULL;
CREATE INDEX idx_fulfillment_payment_intent ON fulfillment(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX idx_fulfillment_easypost_shipment ON fulfillment(easypost_shipment_id)
  WHERE easypost_shipment_id IS NOT NULL;
CREATE TRIGGER fulfillment_updated_at AFTER UPDATE ON fulfillment
BEGIN
  UPDATE fulfillment SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
END;
CREATE TABLE IF NOT EXISTS "email_outbox" (
  id INTEGER PRIMARY KEY,
  email_uid TEXT NOT NULL UNIQUE,
  stripe_session_id TEXT NOT NULL,
  email_type TEXT NOT NULL CHECK(email_type IN (
    'order_confirmation',
    'order_confirmed_tracking'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending',
    'sending',
    'sent',
    'failed'
  )),
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_retry_at INTEGER,
  last_error TEXT,
  sending_started_at INTEGER,
  template_data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  sent_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE(stripe_session_id, email_type)
);
CREATE INDEX idx_email_outbox_pending
  ON email_outbox(status, next_retry_at)
  WHERE status = 'pending';
CREATE INDEX idx_email_outbox_stuck
  ON email_outbox(status, sending_started_at)
  WHERE status = 'sending';
CREATE INDEX idx_email_outbox_session
  ON email_outbox(stripe_session_id);
CREATE TRIGGER email_outbox_updated_at
  AFTER UPDATE ON email_outbox
  FOR EACH ROW
BEGIN
  UPDATE email_outbox SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
END;
CREATE TABLE IF NOT EXISTS "order_events" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_uid TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'created',
    'status_changed',
    'tracking_added',
    'email_sent',
    'exception_raised',
    'exception_resolved',
    'email_resend_triggered'
  )),
  old_value TEXT,
  new_value TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (order_uid) REFERENCES orders(order_uid)
);
CREATE INDEX idx_order_events_order_uid ON order_events(order_uid);
CREATE INDEX idx_order_events_created_at ON order_events(created_at);
