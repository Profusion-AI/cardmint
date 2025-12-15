-- Webhook Infrastructure Migration
-- EverShop bidirectional sync support
-- Apply to staging (cardmint_dev.db) - idempotent

-- Add EverShop UUID for REST API lookup (nullable, added during import)
-- Note: SQLite doesn't support ADD COLUMN with UNIQUE constraint directly
-- We enforce uniqueness via a unique index instead
ALTER TABLE products ADD COLUMN evershop_uuid TEXT;

-- Unique index for REST API lookups by EverShop UUID (prevents duplicate linkage)
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_evershop_uuid ON products(evershop_uuid)
  WHERE evershop_uuid IS NOT NULL;

-- Webhook events audit log for incoming EverShop webhooks
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uid TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'evershop_product_updated', 'evershop_product_created', 'evershop_product_deleted',
    'stripe_checkout_completed', 'stripe_payment_failed'
  )),
  source TEXT NOT NULL CHECK(source IN ('evershop', 'stripe', 'internal')),
  payload JSON NOT NULL,
  product_uid TEXT,
  item_uid TEXT,
  processed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending', 'processed', 'failed', 'skipped'
  )),
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (product_uid) REFERENCES products(product_uid)
);

-- Indexes for webhook processing
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_source ON webhook_events(source);
CREATE INDEX IF NOT EXISTS idx_webhook_events_product ON webhook_events(product_uid);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events(created_at);

-- Prevent duplicate webhook processing (by event_uid)
-- event_uid should be unique per webhook delivery
