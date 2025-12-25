-- Orders table: Human-readable order numbers for customer-facing communication
-- Links to fulfillment via stripe_session_id (both tables use it as unique key)
-- No PII stored - customer email kept in Stripe/Klaviyo only

CREATE TABLE IF NOT EXISTS orders (
  order_uid TEXT PRIMARY KEY,  -- UUID v4
  order_number TEXT NOT NULL UNIQUE,  -- Format: CM-YYYYMMDD-######
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,

  -- Order totals (denormalized for quick lookup)
  item_count INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,

  -- Status mirrors fulfillment for customer-facing display
  -- Mapping: confirmed=pending, processing=label_purchased, shipped, delivered, exception
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN (
    'confirmed',      -- Order placed, awaiting fulfillment
    'processing',     -- Label purchased, being prepared
    'shipped',        -- In transit
    'delivered',      -- Carrier confirmed delivery
    'exception'       -- Delivery issue
  )),

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Trigger to update updated_at on modification
CREATE TRIGGER IF NOT EXISTS orders_updated_at AFTER UPDATE ON orders
BEGIN
  UPDATE orders SET updated_at = strftime('%s', 'now') WHERE order_uid = NEW.order_uid;
END;

-- Order events table for audit trail (no PII)
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_uid TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'created',
    'status_changed',
    'tracking_added',
    'email_sent',
    'exception_raised',
    'exception_resolved'
  )),
  old_value TEXT,  -- JSON for status changes, null for creation
  new_value TEXT,  -- JSON for new state
  actor TEXT,      -- 'webhook', 'operator:kyle', 'system'
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (order_uid) REFERENCES orders(order_uid)
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_uid ON order_events(order_uid);
CREATE INDEX IF NOT EXISTS idx_order_events_created_at ON order_events(created_at);
