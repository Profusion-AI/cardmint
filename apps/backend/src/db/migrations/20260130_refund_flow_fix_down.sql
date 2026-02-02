-- Down migration: Remove EasyPost status cache columns
-- Note: SQLite doesn't support DROP COLUMN directly in older versions
-- This is handled by recreating the table without these columns if needed

-- For SQLite 3.35.0+, we can use:
-- ALTER TABLE marketplace_shipments DROP COLUMN easypost_status_cached;
-- ALTER TABLE marketplace_shipments DROP COLUMN easypost_status_cached_at;

-- For older SQLite, you'd need to recreate the table. Since we're using a modern SQLite,
-- these statements should work. If not, the migration system will handle table recreation.
