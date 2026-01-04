-- Rollback Phase 4 audit columns for marketplace shipments
-- SQLite doesn't support DROP COLUMN directly; need to recreate table
-- For simplicity, this down migration just documents the rollback approach

-- To rollback: Create new table without columns, copy data, drop old, rename
-- Not implemented as simple ALTER since it's destructive

-- Manual rollback steps:
-- 1. CREATE TABLE marketplace_shipments_new AS SELECT [all columns except new ones] FROM marketplace_shipments;
-- 2. DROP TABLE marketplace_shipments;
-- 3. ALTER TABLE marketplace_shipments_new RENAME TO marketplace_shipments;
-- 4. Recreate indexes and triggers

-- New columns to remove:
--   parcel_preset_key, parcel_weight_oz, insured_value_cents, item_count, label_purchase_in_progress

-- Marking as forward-only migration due to SQLite limitations
-- ROLLBACK POSTURE: Forward-only (columns are additive, NULL-safe)
