-- Migration: Add inference_path field to scans table
-- Purpose: Track which inference path was used (openai, lmstudio) for unambiguous telemetry
-- Date: 2025-10-23

-- Add inference_path column to scans table
ALTER TABLE scans ADD COLUMN inference_path TEXT;

-- Add index for analytics queries
CREATE INDEX idx_scans_inference_path ON scans(inference_path);

-- Note: Existing rows will have NULL inference_path (no backfill needed)
-- Future scans will populate this field during inference
