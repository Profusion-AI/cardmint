-- Migration: Add EverShop catalog fields (Gate B Stage 2)
-- Purpose: Extend scans table with fields required for EverShop import
-- Schema compatibility: Backward-compatible (all nullable)
-- Rationale: These fields are derived during image processing and pricing enrichment

-- Market pricing (before +25% inflation)
ALTER TABLE scans ADD COLUMN market_price REAL;

-- Launch pricing (market_price * 1.25)
ALTER TABLE scans ADD COLUMN launch_price REAL;

-- Card condition (NM, LP, MP, HP, DMG, or from operator input)
ALTER TABLE scans ADD COLUMN condition TEXT;

-- Stock keeping unit (derived from set_number + card_number + condition)
ALTER TABLE scans ADD COLUMN sku TEXT;

-- Path to processed image (from Stage 2: images/incoming/{sku}-front.jpg)
ALTER TABLE scans ADD COLUMN image_path TEXT;

-- Create index on sku for importer lookups (idempotent upsert)
CREATE INDEX IF NOT EXISTS idx_scans_sku ON scans(sku);

-- Create index on image_path for QA queries
CREATE INDEX IF NOT EXISTS idx_scans_image_path ON scans(image_path);
