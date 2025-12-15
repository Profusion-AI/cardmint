-- Stripe integration columns for items table
-- Adds checkout/payment tracking for one-off listings

ALTER TABLE items ADD COLUMN stripe_product_id TEXT;
ALTER TABLE items ADD COLUMN stripe_price_id TEXT;
ALTER TABLE items ADD COLUMN checkout_session_id TEXT;
ALTER TABLE items ADD COLUMN payment_intent_id TEXT;
ALTER TABLE items ADD COLUMN reserved_until INTEGER;

-- Index for finding overdue reservations (expiry job)
CREATE INDEX IF NOT EXISTS idx_items_reserved_until ON items(reserved_until)
  WHERE status = 'RESERVED' AND reserved_until IS NOT NULL;

-- Webhook idempotency table
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  item_uid TEXT,
  processed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (item_uid) REFERENCES items(item_uid)
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_item ON stripe_webhook_events(item_uid);
