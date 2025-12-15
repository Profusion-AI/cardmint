-- Migration: Image Pipeline CDN Integration
-- Date: 2025-11-13
-- Purpose: Add fields for listing asset generation and CDN publishing

-- Scans table: Track listing assets and CDN publication status
ALTER TABLE scans ADD COLUMN listing_image_path TEXT;
ALTER TABLE scans ADD COLUMN cdn_image_url TEXT;
ALTER TABLE scans ADD COLUMN cdn_published_at INTEGER;

-- Products table: Store canonical image URLs for EverShop importer
ALTER TABLE products ADD COLUMN listing_image_path TEXT;
ALTER TABLE products ADD COLUMN cdn_image_url TEXT;
ALTER TABLE products ADD COLUMN primary_scan_id TEXT;

-- Index for importer filtering (products with published images only)
CREATE INDEX IF NOT EXISTS idx_products_cdn_image_url ON products(cdn_image_url);

-- Index for scan CDN lookups
CREATE INDEX IF NOT EXISTS idx_scans_cdn_url ON scans(cdn_image_url);
