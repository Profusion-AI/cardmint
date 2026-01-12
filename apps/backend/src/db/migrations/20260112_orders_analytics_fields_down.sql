-- Rollback: remove analytics fields from orders table
-- Note: SQLite doesn't support DROP COLUMN in older versions
-- This creates a new table without the columns and migrates data

PRAGMA foreign_keys=OFF;

CREATE TABLE orders_backup AS SELECT
  order_uid, order_number, stripe_session_id, stripe_payment_intent_id,
  item_count, subtotal_cents, shipping_cents, total_cents,
  status, created_at, updated_at
FROM orders;

DROP TABLE orders;

CREATE TABLE orders (
  order_uid TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,
  item_count INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN (
    'confirmed', 'processing', 'shipped', 'delivered', 'exception'
  )),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

INSERT INTO orders SELECT * FROM orders_backup;
DROP TABLE orders_backup;

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TRIGGER IF NOT EXISTS orders_updated_at AFTER UPDATE ON orders
BEGIN
  UPDATE orders SET updated_at = strftime('%s', 'now') WHERE order_uid = NEW.order_uid;
END;

PRAGMA foreign_keys=ON;
