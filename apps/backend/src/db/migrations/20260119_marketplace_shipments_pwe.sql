-- Add PWE (Plain White Envelope / stamp) flag for marketplace shipments.
-- Operator uses this to mark low-value shipments as manual stamp mail (no label purchase/tracking).

ALTER TABLE marketplace_shipments ADD COLUMN is_pwe INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_is_pwe ON marketplace_shipments(is_pwe);

