-- Nov 7 MVP follow-up: add accepted_set_size column and index
-- Context: 20251107_truth_core_fields was applied before set_size was added.
-- This migration only adds the deterministic set_size field for Truth Core.

ALTER TABLE scans ADD COLUMN accepted_set_size INTEGER; -- nullable when unknown / not printed
CREATE INDEX idx_scans_accepted_set_size ON scans(accepted_set_size);

