-- Unified CSV import support
-- Tracks import format and external fulfillment flag

-- Order-level: which CSV format was used for import
-- 'shipping_export' = full TCGPlayer Shipping Export (has address, label-ready)
-- 'orderlist' = TCGPlayer Order List (no address, tracking/reconciliation only)
ALTER TABLE marketplace_orders ADD COLUMN import_format TEXT DEFAULT 'shipping_export';

-- Shipment-level: external fulfillment flag
-- 0 = CardMint-fulfilled (label purchase possible)
-- 1 = External/TCGPlayer-fulfilled (no label purchase, tracking only)
ALTER TABLE marketplace_shipments ADD COLUMN is_external INTEGER DEFAULT 0;

-- Index for stats query optimization (exclude external from pendingLabels count)
CREATE INDEX IF NOT EXISTS idx_shipments_is_external ON marketplace_shipments(is_external);
