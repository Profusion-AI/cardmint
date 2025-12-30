-- Migration: 20251227b_scans_corrected_image_path
-- Purpose: Reconcile missing scans.corrected_image_path on fresh DB builds.
-- Background: Some historic migrations are skipped on duplicate-column errors,
-- leaving this column absent when rebuilding from scratch.
--
-- Policy: Migrations are immutable; reconciliation is forward-only.

ALTER TABLE scans ADD COLUMN corrected_image_path TEXT;

