-- Migration: Add back_image_path column to scans table
-- Date: 2025-12-01
-- Purpose: Fix Stage 3 CDN gap - this column was referenced in code but never created
--
-- The Nov 17-19 migrations added two-capture flow flags (front_locked, back_ready)
-- but never added back_image_path. Result: back images never tracked/published to CDN.

ALTER TABLE scans ADD COLUMN back_image_path TEXT;

-- Index for efficient lookups when linking back images to front scans
CREATE INDEX IF NOT EXISTS idx_scans_back_image_path ON scans(back_image_path) WHERE back_image_path IS NOT NULL;
