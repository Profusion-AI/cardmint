-- Rollback: Remove idx_marketplace_shipments_is_pwe index.
-- Note: SQLite doesn't support DROP COLUMN directly; is_pwe remains but is unused after rollback.

DROP INDEX IF EXISTS idx_marketplace_shipments_is_pwe;

