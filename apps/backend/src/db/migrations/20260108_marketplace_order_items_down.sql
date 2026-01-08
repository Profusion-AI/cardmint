-- Down migration: Remove marketplace_order_items table

DROP TRIGGER IF EXISTS marketplace_order_items_updated_at;
DROP INDEX IF EXISTS idx_marketplace_order_items_sku;
DROP INDEX IF EXISTS idx_marketplace_order_items_external;
DROP INDEX IF EXISTS idx_marketplace_order_items_order_id;
DROP TABLE IF EXISTS marketplace_order_items;
