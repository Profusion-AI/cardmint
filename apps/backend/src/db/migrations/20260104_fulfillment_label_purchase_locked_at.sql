-- Fulfillment label purchase concurrency lock timestamp (stale-lock recovery)
ALTER TABLE fulfillment ADD COLUMN label_purchase_locked_at INTEGER;

