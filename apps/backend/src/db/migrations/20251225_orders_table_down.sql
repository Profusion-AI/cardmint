-- Rollback migration for orders table
-- WARNING: This will DELETE all order data. Use with extreme caution.
-- Only run this if you need to completely remove the orders feature.

-- Drop the trigger first
DROP TRIGGER IF EXISTS orders_updated_at;

-- Drop indexes
DROP INDEX IF EXISTS idx_order_events_created_at;
DROP INDEX IF EXISTS idx_order_events_order_uid;
DROP INDEX IF EXISTS idx_orders_status;
DROP INDEX IF EXISTS idx_orders_created_at;

-- Drop tables (order_events first due to FK)
DROP TABLE IF EXISTS order_events;
DROP TABLE IF EXISTS orders;
