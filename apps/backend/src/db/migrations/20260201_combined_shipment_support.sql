-- Combined shipment support: child shipment references parent shipment
-- Allows operator to combine multiple orders into one physical shipment

-- Add fulfilled_by_shipment_id to reference parent shipment when orders are combined
ALTER TABLE marketplace_shipments ADD COLUMN fulfilled_by_shipment_id INTEGER REFERENCES marketplace_shipments(id);

-- Audit trail for combined shipments
ALTER TABLE marketplace_shipments ADD COLUMN combined_at INTEGER;
ALTER TABLE marketplace_shipments ADD COLUMN combined_by TEXT;
ALTER TABLE marketplace_shipments ADD COLUMN combined_reason TEXT;

-- Index for finding child shipments of a parent (sparse index - most are NULL)
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_fulfilled_by
  ON marketplace_shipments(fulfilled_by_shipment_id)
  WHERE fulfilled_by_shipment_id IS NOT NULL;

-- NOTE: SQLite doesn't support ALTER TABLE ADD CONSTRAINT, so the self-reference check
-- (fulfilled_by_shipment_id IS NULL OR fulfilled_by_shipment_id != id) must be enforced
-- at the application layer in MarketplaceService.validateCombine()
