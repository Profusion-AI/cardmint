-- Migration: Production Inventory Readiness
-- Date: 2025-11-17
-- Purpose: Add product_slug, ppt_enriched_at, and bridge health validation for production launch

PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;

-- =============================================================================
-- Products Table: Add product_slug and ppt_enriched_at
-- =============================================================================

-- Add product_slug column (nullable initially, will be made UNIQUE after backfill)
-- Format: {slugified-card-name}-{slugified-set-name}-{collector-no}-{last-8-chars-of-uid}
-- Example: "pikachu-base-set-25-a1b2c3d4"
ALTER TABLE products ADD COLUMN product_slug TEXT;

-- Add ppt_enriched_at timestamp to track when PPT enrichment last succeeded
-- Used to enforce "no staging_ready=1 without PPT enrichment" policy
ALTER TABLE products ADD COLUMN ppt_enriched_at INTEGER;

-- Create index on product_slug for fast PDP lookups
-- Will be UNIQUE after backfill completes
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(product_slug);

-- =============================================================================
-- Bridge Health Validation: Add is_valid flag to cm_pricecharting_bridge
-- =============================================================================

-- Add is_valid flag to track bridge health (0 = invalid/404, 1 = valid)
-- When PPT API returns 404 for a bridge ID, this flag is set to 0
-- Invalid bridges are skipped in lookups, forcing fallback to parse-title
ALTER TABLE cm_pricecharting_bridge ADD COLUMN is_valid INTEGER DEFAULT 1 CHECK(is_valid IN (0, 1));

-- Create index on is_valid for efficient filtering
CREATE INDEX IF NOT EXISTS idx_cm_pricecharting_valid ON cm_pricecharting_bridge(is_valid);

-- =============================================================================
-- Product Images: Add product_images table for front/back asset tracking
-- =============================================================================

-- Create product_images table to track multiple orientations per product
-- Each product_uid MUST have exactly 2 rows: orientation='front' and orientation='back'
-- This enforces the "WYSIWYG promise": every listing shows front AND back images
CREATE TABLE IF NOT EXISTS product_images (
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

-- Index for fast lookups by product_uid
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_uid);

-- Index for validation queries (find products missing front or back)
CREATE INDEX IF NOT EXISTS idx_product_images_orientation ON product_images(product_uid, orientation);

-- =============================================================================
-- Scans Table: Add orientation column for future capture workflow
-- =============================================================================

-- Add scan_orientation to support two-capture workflow (front → back)
-- NULL for legacy scans (pre-migration); 'front' or 'back' for new captures
ALTER TABLE scans ADD COLUMN scan_orientation TEXT CHECK(scan_orientation IS NULL OR scan_orientation IN ('front', 'back'));

-- Create index for filtering by orientation
CREATE INDEX IF NOT EXISTS idx_scans_orientation ON scans(scan_orientation);

-- Add product_uid to scans table to support direct product linkage in two-capture workflow
-- NULL for legacy scans (joined via items); populated for new back captures
ALTER TABLE scans ADD COLUMN product_uid TEXT;

-- Create index for filtering by product_uid
CREATE INDEX IF NOT EXISTS idx_scans_product_uid ON scans(product_uid);

-- =============================================================================
-- Products Table: Add cdn_back_image_url for quick PDP lookups
-- =============================================================================

-- Add cdn_back_image_url to products for fast access by PDP/importer
-- Denormalized from product_images for query performance
-- Will be populated by backfill script from existing scans
ALTER TABLE products ADD COLUMN cdn_back_image_url TEXT;

-- =============================================================================
-- Migration Metadata
-- =============================================================================

-- Post-migration tasks:
-- 1. Run backfill script: apps/backend/src/scripts/backfill_product_slugs.ts
-- 2. Run backfill script: apps/backend/src/scripts/backfill_product_images.ts
-- 3. After backfills, add UNIQUE constraint: CREATE UNIQUE INDEX idx_products_slug_unique ON products(product_slug);
-- 4. Update acceptance.sql with new validation gates (front/back image enforcement)
-- 5. Verify all gates pass before next capture session

-- Expected behavior changes:
-- - All new products will have product_slug generated at creation time
-- - PPT enrichment endpoint sets ppt_enriched_at timestamp
-- - staging_ready promotion requires ppt_enriched_at IS NOT NULL AND both front/back images exist
-- - Bridge 404s auto-invalidate the bridge mapping (is_valid=0)
-- - Invalid bridges skipped in getPriceByPricechartingId() lookups
-- - product_images table tracks front/back orientations separately
-- - New captures will set scan_orientation to enable two-scan workflow
-- - PDP/importer use cdn_image_url (front) and cdn_back_image_url (back)
