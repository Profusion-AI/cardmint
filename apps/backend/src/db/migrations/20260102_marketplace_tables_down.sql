-- Rollback: Drop marketplace fulfillment tables
-- WARNING: This will delete all marketplace order data

DROP TRIGGER IF EXISTS marketplace_shipments_updated_at;
DROP TRIGGER IF EXISTS marketplace_orders_updated_at;

DROP INDEX IF EXISTS idx_unmatched_tracking_tracking_number;
DROP INDEX IF EXISTS idx_unmatched_tracking_signed_by;
DROP INDEX IF EXISTS idx_unmatched_tracking_status;
DROP INDEX IF EXISTS idx_marketplace_shipments_zip;
DROP INDEX IF EXISTS idx_marketplace_shipments_status;
DROP INDEX IF EXISTS idx_marketplace_shipments_tracking;
DROP INDEX IF EXISTS idx_marketplace_shipments_order_id;
DROP INDEX IF EXISTS idx_marketplace_orders_display_number;
DROP INDEX IF EXISTS idx_marketplace_orders_order_date;
DROP INDEX IF EXISTS idx_marketplace_orders_customer_norm;
DROP INDEX IF EXISTS idx_marketplace_orders_status;
DROP INDEX IF EXISTS idx_marketplace_orders_source;
DROP INDEX IF EXISTS idx_import_batches_imported_at;
DROP INDEX IF EXISTS idx_import_batches_status;
DROP INDEX IF EXISTS idx_import_batches_source;

DROP TABLE IF EXISTS unmatched_tracking;
DROP TABLE IF EXISTS marketplace_shipments;
DROP TABLE IF EXISTS marketplace_orders;
DROP TABLE IF EXISTS import_batches;
