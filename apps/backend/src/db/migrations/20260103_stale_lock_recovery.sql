-- Stale-lock recovery: timestamp for crash detection
-- Allows auto-recovery of locks held > 5 minutes (crash protection)
-- Separate migration from label_purchase_in_progress to avoid migration runner issues
ALTER TABLE marketplace_shipments ADD COLUMN label_purchase_locked_at INTEGER;
