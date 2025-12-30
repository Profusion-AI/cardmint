-- Down migration: 20251227b_scans_corrected_image_path
-- Rollback posture: forward-only migrations.
-- Operational rollback = snapshot restore + redeploy prior tag.
--
-- SQLite does not support DROP COLUMN without table rebuild; no-op.

