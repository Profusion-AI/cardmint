-- Rollback: Remove import_format and is_external columns
-- Note: SQLite doesn't support DROP COLUMN directly; these would need table recreation
-- For now, columns remain but are simply unused after rollback

DROP INDEX IF EXISTS idx_shipments_is_external;

-- SQLite limitation: Cannot drop columns without table recreation
-- Columns will remain but be unused. Forward migration is preferred.
