-- Migration: Relaxed Canonical Lock (Allow Accept without cm_card_id)
-- Author: Claude Code
-- Date: 2025-11-21
-- Context: Launch tracker line 28 - Allow operator-verified Truth Core to lock/Accept
--          without requiring cm_card_id match, while persisting hints for reconciliation.
-- Fixed: 2025-11-26 - Use table recreation pattern for SQLite FK constraint compatibility

-- Phase 1: Relax products.cm_card_id constraint
-- Allow NULL cm_card_id to support inventory creation before canonical match
-- SQLite requires table recreation when modifying columns with FK constraints

-- Step 1: Create new table with relaxed constraint (cm_card_id nullable, no FK)
CREATE TABLE products_new (
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
  canonical_sku TEXT,
  CHECK (condition_bucket IN ('NM', 'LP', 'MP', 'HP', 'UNKNOWN', 'NO_CONDITION'))
);

-- Step 2: Copy data from old table
INSERT INTO products_new SELECT
  product_uid, cm_card_id, condition_bucket, product_sku, listing_sku,
  card_name, set_name, collector_no, hp_value, rarity,
  market_price, launch_price, pricing_channel, total_quantity, notes,
  created_at, updated_at,
  pricing_source, pricing_status, pricing_updated_at, staging_ready, last_imported_at, import_job_id,
  accepted_without_canonical, manual_reason_code, manual_note,
  listing_image_path, cdn_image_url, primary_scan_id,
  product_slug, ppt_enriched_at, cdn_back_image_url,
  canonical_sku
FROM products;

-- Step 3: Drop triggers that reference products (before dropping the table)
DROP TRIGGER IF EXISTS items_ai_update_product_quantity;
DROP TRIGGER IF EXISTS items_au_update_product_quantity;
DROP TRIGGER IF EXISTS items_ad_update_product_quantity;

-- Step 4: Drop old table and rename
DROP TABLE products;
ALTER TABLE products_new RENAME TO products;

-- Step 5: Recreate indexes (excluding the old FK-based unique constraint idx_products_card_condition)
-- From 20251024_products_items_inventory
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(product_sku);
CREATE INDEX IF NOT EXISTS idx_products_listing_sku ON products(listing_sku);
CREATE INDEX IF NOT EXISTS idx_products_cm_card_id ON products(cm_card_id);
CREATE INDEX IF NOT EXISTS idx_products_condition ON products(condition_bucket);
CREATE INDEX IF NOT EXISTS idx_products_pricing_channel ON products(pricing_channel);
-- From 20251103_manual_override_schema
CREATE INDEX IF NOT EXISTS idx_products_manual_override ON products(manual_reason_code) WHERE manual_reason_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_accepted_without_canonical ON products(accepted_without_canonical);
-- From 20251113_image_pipeline_cdn
CREATE INDEX IF NOT EXISTS idx_products_cdn_image_url ON products(cdn_image_url);
-- From 20251117_production_inventory_readiness
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(product_slug);
-- From 20251118_canonical_sku_product_identity
CREATE INDEX IF NOT EXISTS idx_products_canonical_sku ON products(canonical_sku);

-- Step 6: Recreate triggers for quantity tracking
CREATE TRIGGER IF NOT EXISTS items_ai_update_product_quantity
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

CREATE TRIGGER IF NOT EXISTS items_au_update_product_quantity
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

CREATE TRIGGER IF NOT EXISTS items_ad_update_product_quantity
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

-- The canonical_sku unique index already handles uniqueness correctly
-- (It was added in 20251024_products_items_inventory.sql line 82)

-- Phase 2: Add reconciliation tracking to scans table
-- These columns track cards accepted without canonical match for future reconciliation
ALTER TABLE scans ADD COLUMN reconciliation_status TEXT
  CHECK(reconciliation_status IN ('pending', 'resolved', 'abandoned', NULL));

ALTER TABLE scans ADD COLUMN reconciliation_attempts INTEGER DEFAULT 0;

ALTER TABLE scans ADD COLUMN reconciliation_last_attempt_at INTEGER;

-- Index for reconciliation queries (find all pending cards)
CREATE INDEX IF NOT EXISTS idx_scans_reconciliation_status
  ON scans(reconciliation_status)
  WHERE reconciliation_status IS NOT NULL;

-- Phase 3: Backfill reconciliation_status for existing accepted_without_canonical cards
-- Cards that were accepted via manual override should be marked as pending reconciliation
UPDATE scans
SET reconciliation_status = 'pending'
WHERE status = 'INVENTORIED'
  AND cm_card_id IS NULL
  AND reconciliation_status IS NULL;

-- Verification queries (not executed, for manual testing):
-- SELECT COUNT(*) FROM products WHERE cm_card_id IS NULL; -- Should allow rows
-- SELECT COUNT(*) FROM scans WHERE reconciliation_status = 'pending'; -- Should show cards needing reconciliation
-- SELECT product_sku, cm_card_id FROM products WHERE cm_card_id IS NULL LIMIT 5; -- Should show fallback SKUs
