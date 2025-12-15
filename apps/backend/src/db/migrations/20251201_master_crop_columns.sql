-- Migration: Add master crop columns for Stage 1.5 / Stage 3 front image publishing
-- These columns support the master crop workflow where front images are pre-uploaded
-- before Accept, then referenced during Stage 3 promotion.

ALTER TABLE scans ADD COLUMN master_image_path TEXT;
ALTER TABLE scans ADD COLUMN master_cdn_url TEXT;

CREATE INDEX idx_scans_master_cdn_url ON scans(master_cdn_url) WHERE master_cdn_url IS NOT NULL;
