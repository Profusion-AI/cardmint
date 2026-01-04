-- Phase 4 audit columns for marketplace shipments
-- Stores deterministic metadata for label purchase reproducibility/debugging
--
-- Columns:
--   parcel_preset_key: Which preset was used (singlecard, multicard-bubble, multicard-box)
--   parcel_weight_oz: Actual weight used (base or custom override)
--   insured_value_cents: Insurance coverage requested (NULL if no insurance)
--   item_count: Per-shipment card count for split shipment support
--   label_purchase_in_progress: Lock flag to prevent double-spend on label purchase

ALTER TABLE marketplace_shipments ADD COLUMN parcel_preset_key TEXT;
ALTER TABLE marketplace_shipments ADD COLUMN parcel_weight_oz REAL;
ALTER TABLE marketplace_shipments ADD COLUMN insured_value_cents INTEGER;

-- Add item_count to shipment for split shipment support
-- (Per spec: "if split shipments are possible, store per-shipment card count")
ALTER TABLE marketplace_shipments ADD COLUMN item_count INTEGER;

-- Concurrency lock for label purchase - prevents double-spend
-- When 1, a label purchase is in progress. Concurrent requests should wait/retry.
ALTER TABLE marketplace_shipments ADD COLUMN label_purchase_in_progress INTEGER DEFAULT 0;
