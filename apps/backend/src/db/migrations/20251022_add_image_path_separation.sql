-- Migration: Separate raw and processed image paths
-- Date: 2025-10-22
-- Reason: Support operator toggle between raw and processed image views

-- Add new columns for explicit path tracking
ALTER TABLE scans ADD COLUMN raw_image_path TEXT;
ALTER TABLE scans ADD COLUMN processed_image_path TEXT;

-- Backfill: Assume current image_path points to raw images from SFTP inbox
-- Processed images live in apps/backend/images/incoming/{jobId}-front.jpg
UPDATE scans
SET raw_image_path = image_path
WHERE image_path IS NOT NULL;

-- For jobs that have been processed (have processing_ms in timings), processed_image_path backfill
-- NOTE: Backfill deferred to separate script to avoid hard-coding paths in migration
-- Run: node scripts/backfill_processed_image_paths.ts (or similar) after migration
-- Migration remains path-agnostic; processed_image_path will be NULL until backfill runs

-- Keep image_path for backward compatibility (points to best available image)
-- Preference: processed > raw
UPDATE scans
SET image_path = COALESCE(processed_image_path, raw_image_path);

-- Create indexes for new columns
CREATE INDEX IF NOT EXISTS idx_scans_raw_image_path ON scans(raw_image_path);
CREATE INDEX IF NOT EXISTS idx_scans_processed_image_path ON scans(processed_image_path);
