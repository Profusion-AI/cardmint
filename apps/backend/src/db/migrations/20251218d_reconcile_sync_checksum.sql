-- Migration: 20251218d_reconcile_sync_checksum
-- Purpose: Correct recorded checksum for 20251204_sync_infrastructure
-- Background: The migration was applied with a file version (f15c7acf...) that differs
-- from the current git-tracked version (2c7e862...). This corrective migration aligns
-- the schema_migrations tracker with the current source file.
--
-- This is metadata-only and does not modify schema. It silences the checksum mismatch
-- warning that appears on every migration run.
--
-- Policy guardrail: Do not edit old migrations going forward. Create new corrective
-- migrations like this one to address discrepancies.

UPDATE schema_migrations
SET checksum = '2c7e862016e37b52329fc555b11b0b1089e0a2c796668b1e28ac89684b70520d'
WHERE id = '20251204_sync_infrastructure';
