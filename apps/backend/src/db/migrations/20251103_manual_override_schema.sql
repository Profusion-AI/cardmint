-- Migration: Add manual override and JSON manifest tracking
-- Date: 2025-11-03
-- Purpose: Support manual pricing overrides, PPT failure tracking, and manifest auditability

-- ========================================
-- 1. Add PPT failure tracking and manifest audit to scans table
-- ========================================

-- Track consecutive PPT enrichment failures per scan (persistent across sessions)
ALTER TABLE scans ADD COLUMN ppt_failure_count INTEGER DEFAULT 0;

-- SHA256 hash of manifest JSON for integrity verification
ALTER TABLE scans ADD COLUMN manifest_hash TEXT;

-- Manifest version/timestamp for rollback and audit trail
ALTER TABLE scans ADD COLUMN manifest_version TEXT;


-- ========================================
-- 2. Add manual override tracking to products table
-- ========================================

-- Flag for scans accepted without canonical match (excludes from staging)
ALTER TABLE products ADD COLUMN accepted_without_canonical INTEGER DEFAULT 0
  CHECK(accepted_without_canonical IN (0, 1));

-- Reason code when manual override is used
ALTER TABLE products ADD COLUMN manual_reason_code TEXT
  CHECK(manual_reason_code IN (
    'PPT_OUTAGE_OR_RATE_LIMIT',
    'PPT_NO_MATCH_OR_INCOMPLETE_DATA',
    'VARIANT_MISMATCH_OR_EDGE_CASE',
    'CONDITION_DRIVEN_ADJUSTMENT',
    'MARKET_ANOMALY_OR_SUDDEN_SWING',
    'OTHER'
  ));

-- Operator note for manual override (≥15 chars required when manual_reason_code is set)
ALTER TABLE products ADD COLUMN manual_note TEXT;


-- ========================================
-- 3. Create indexes for manual override queries
-- ========================================

-- Index for finding scans with PPT failures (failure ladder logic)
CREATE INDEX IF NOT EXISTS idx_scans_ppt_failures ON scans(ppt_failure_count);

-- Index for finding products with manual overrides (acceptance SQL)
CREATE INDEX IF NOT EXISTS idx_products_manual_override ON products(manual_reason_code)
  WHERE manual_reason_code IS NOT NULL;

-- Index for finding accepted-without-canonical products (staging exclusion)
CREATE INDEX IF NOT EXISTS idx_products_accepted_without_canonical
  ON products(accepted_without_canonical)
  WHERE accepted_without_canonical = 1;


-- ========================================
-- 4. Migration metadata
-- ========================================

-- Migration applied successfully
-- Timestamp: 2025-11-03
-- Changes:
--   - Added ppt_failure_count, manifest_hash, manifest_version to scans
--   - Added accepted_without_canonical, manual_reason_code, manual_note to products
--   - Created indexes for manual override queries
--   - Supports dual-location manifest persistence (data/sftp-inbox + results/manifests)
--   - Enables PPT failure ladder (blocking modal at 3rd failure)
--   - Enforces manual override validations (reason code enum, ≥15 char notes)
--   - Reason codes: PPT_OUTAGE_OR_RATE_LIMIT, PPT_NO_MATCH_OR_INCOMPLETE_DATA,
--     VARIANT_MISMATCH_OR_EDGE_CASE, CONDITION_DRIVEN_ADJUSTMENT,
--     MARKET_ANOMALY_OR_SUDDEN_SWING, OTHER
