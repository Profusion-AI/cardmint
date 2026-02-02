-- Down migration for combined shipment support
-- Note: SQLite doesn't support DROP COLUMN directly, but better-sqlite3 uses
-- recreate-table approach internally. For safety, we use the standard approach.

-- Drop the index first
DROP INDEX IF EXISTS idx_marketplace_shipments_fulfilled_by;

-- SQLite requires recreating the table to drop columns
-- This is a destructive migration - combined shipment data will be lost
CREATE TABLE marketplace_shipments_backup AS SELECT
  id,
  marketplace_order_id,
  shipment_sequence,
  shipping_address_encrypted,
  shipping_zip,
  address_expires_at,
  easypost_shipment_id,
  easypost_rate_id,
  carrier,
  service,
  tracking_number,
  tracking_url,
  label_url,
  label_cost_cents,
  label_purchased_at,
  status,
  shipped_at,
  delivered_at,
  exception_type,
  exception_notes,
  tracking_match_confidence,
  tracking_matched_at,
  tracking_matched_by,
  parcel_preset_key,
  parcel_weight_oz,
  insured_value_cents,
  item_count,
  is_external,
  is_pwe,
  label_purchase_in_progress,
  label_purchase_locked_at,
  label_viewed_at,
  refund_status,
  refund_requested_at,
  easypost_status_cached,
  easypost_status_cached_at,
  created_at,
  updated_at
FROM marketplace_shipments;

DROP TABLE marketplace_shipments;

ALTER TABLE marketplace_shipments_backup RENAME TO marketplace_shipments;

-- Recreate ALL indexes that existed before this migration
-- Core indexes (from 20260102_marketplace_tables.sql)
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_order_id ON marketplace_shipments(marketplace_order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_tracking ON marketplace_shipments(tracking_number) WHERE tracking_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_status ON marketplace_shipments(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_zip ON marketplace_shipments(shipping_zip);

-- External shipment index (from 20260106)
CREATE INDEX IF NOT EXISTS idx_shipments_is_external ON marketplace_shipments(is_external);

-- PWE index (from 20260119)
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_is_pwe ON marketplace_shipments(is_pwe);

-- Refund status index (from 20260127)
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_refund_status ON marketplace_shipments(refund_status) WHERE refund_status IS NOT NULL;
