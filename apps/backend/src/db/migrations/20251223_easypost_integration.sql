-- EasyPost integration columns for fulfillment table
-- Dec 2025: Add EasyPost-specific fields alongside existing shippo_* columns
-- (Preserving shippo_* columns for backward compatibility if any code references them)
--
-- Migration is safe: fulfillment table has no data as of 2025-12-23

-- EasyPost shipment tracking (store shipment ID for idempotency)
ALTER TABLE fulfillment ADD COLUMN easypost_shipment_id TEXT;

-- EasyPost rate used for label purchase
ALTER TABLE fulfillment ADD COLUMN easypost_rate_id TEXT;

-- Carrier service name from EasyPost (e.g., "GroundAdvantage", "Priority")
ALTER TABLE fulfillment ADD COLUMN easypost_service TEXT;

-- Label cost in cents (actual carrier rate from EasyPost)
ALTER TABLE fulfillment ADD COLUMN label_cost_cents INTEGER;

-- Index for looking up by EasyPost shipment ID
CREATE INDEX IF NOT EXISTS idx_fulfillment_easypost_shipment
  ON fulfillment(easypost_shipment_id)
  WHERE easypost_shipment_id IS NOT NULL;
