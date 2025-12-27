-- Down migration: 20251227c_products_cdn_published_at
-- Rollback posture: forward-only migrations.
-- Operational rollback = snapshot restore + redeploy prior tag.
--
-- SQLite does not support DROP COLUMN without table rebuild; no-op.

