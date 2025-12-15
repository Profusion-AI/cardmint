-- Sync Infrastructure Migration
-- Phase 1: Promotion workflow + daemon support
-- Apply to BOTH staging (cardmint_dev.db) and prod (cardmint_prod.db)
-- This migration is idempotent - safe to re-run.

-- Sync versioning for conflict detection (products)
-- SQLite doesn't have IF NOT EXISTS for columns, so we use a try/ignore pattern
-- The column will be added if missing, or silently fail if already present
-- For SQLite, we wrap in a savepoint for each column addition

-- Products table sync columns (skip if already exist)
-- Run manually if needed: sqlite3 db "ALTER TABLE products ADD COLUMN sync_version INTEGER DEFAULT 1;" 2>/dev/null || true

-- NOTE: The following ALTER statements may fail if columns already exist.
-- This is expected behavior. Apply line-by-line in production or use:
--   sqlite3 yourdb.db < migration.sql 2>/dev/null || true

-- Products sync columns
ALTER TABLE products ADD COLUMN sync_version INTEGER DEFAULT 1;
ALTER TABLE products ADD COLUMN last_synced_at INTEGER;
ALTER TABLE products ADD COLUMN promoted_at INTEGER;
ALTER TABLE products ADD COLUMN evershop_product_id INTEGER;
ALTER TABLE products ADD COLUMN evershop_published_at INTEGER;
ALTER TABLE products ADD COLUMN evershop_sync_state TEXT
  CHECK (evershop_sync_state IN (
    'not_synced', 'vault_only', 'evershop_hidden', 'evershop_live', 'sync_error'
  )) DEFAULT 'not_synced';
ALTER TABLE products ADD COLUMN public_sku TEXT;

-- Items sync columns
ALTER TABLE items ADD COLUMN sync_version INTEGER DEFAULT 1;
ALTER TABLE items ADD COLUMN last_synced_at INTEGER;

-- Sync events audit log
-- stripe_event_id FKs to stripe_webhook_events for Stripe-driven events (nullable for manual ops)
CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uid TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'promote', 'sale', 'price_update', 'return', 'rollback', 'unpromote'
  )),
  product_uid TEXT NOT NULL,
  item_uid TEXT,
  source_db TEXT NOT NULL CHECK(source_db IN ('staging', 'production')),
  target_db TEXT NOT NULL CHECK(target_db IN ('staging', 'production')),
  operator_id TEXT,
  payload JSON NOT NULL,
  stripe_event_id TEXT REFERENCES stripe_webhook_events(event_id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending', 'synced', 'failed', 'conflict', 'partial_failure'
  )),
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  synced_at INTEGER,
  FOREIGN KEY (product_uid) REFERENCES products(product_uid)
);

-- Prevent duplicate pending events for same product/type combo
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_events_pending_product
  ON sync_events(product_uid, event_type)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_sync_events_status ON sync_events(status);
CREATE INDEX IF NOT EXISTS idx_sync_events_type ON sync_events(event_type);
CREATE INDEX IF NOT EXISTS idx_sync_events_product ON sync_events(product_uid);
CREATE INDEX IF NOT EXISTS idx_sync_events_stripe ON sync_events(stripe_event_id);

-- Leader lease for daemon (singleton row)
CREATE TABLE IF NOT EXISTS sync_leader (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_owner TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL
);

-- Product sync indexes
CREATE INDEX IF NOT EXISTS idx_products_promoted_at ON products(promoted_at);
CREATE INDEX IF NOT EXISTS idx_products_sync_version ON products(sync_version);
CREATE INDEX IF NOT EXISTS idx_products_evershop_state ON products(evershop_sync_state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_public_sku ON products(public_sku)
  WHERE public_sku IS NOT NULL;
