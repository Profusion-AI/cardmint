-- Stage 1 Lifecycle Flags Migration
-- Date: 2025-11-19
-- Purpose: Add flags to track Stage 1A/1B state transitions per lifecycle_stages.md
--
-- Stage 1A: Front Locked / Ready for Back
--   - Operator verifies truth core and locks front → front_locked = 1
--   - Enables back capture without requiring Stage 2 (final Accept)
--
-- Stage 1B: Canonical Locked + Back Attached
--   - Back image captured → back_ready = 1
--   - Canonical ID locked → canonical_locked = 1
--   - Both required before final Accept (Stage 2)
--
-- Stage 2: Inventoried (Final Accept)
--   - Entry criteria: front_locked = 1 AND back_ready = 1 AND canonical_locked = 1
--   - Accept atomically creates inventory (dedupAttachOrMint)
--   - Success → status = ACCEPTED, item_uid IS NOT NULL

-- Add Stage 1 lifecycle flags to scans table
ALTER TABLE scans ADD COLUMN front_locked INTEGER DEFAULT 0;
ALTER TABLE scans ADD COLUMN back_ready INTEGER DEFAULT 0;
ALTER TABLE scans ADD COLUMN canonical_locked INTEGER DEFAULT 0;

-- Add indexes for querying by lock state
CREATE INDEX IF NOT EXISTS idx_scans_front_locked ON scans(front_locked);
CREATE INDEX IF NOT EXISTS idx_scans_back_ready ON scans(back_ready);
CREATE INDEX IF NOT EXISTS idx_scans_canonical_locked ON scans(canonical_locked);

-- Add composite index for Stage 1B readiness (both back + canonical locked)
CREATE INDEX IF NOT EXISTS idx_scans_stage1b_ready ON scans(back_ready, canonical_locked) WHERE back_ready = 1 AND canonical_locked = 1;

-- Backfill: Set flags for existing ACCEPTED scans (already in Stage 2)
-- These scans bypassed the Stage 1A/1B flow, so mark all flags as true
UPDATE scans
SET front_locked = 1,
    back_ready = 1,
    canonical_locked = 1
WHERE status = 'ACCEPTED';

-- Note: OPERATOR_PENDING scans remain with flags = 0
-- Operators must explicitly lock front, capture back, and lock canonical before Accept
