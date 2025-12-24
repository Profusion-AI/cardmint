-- Rollback: Sync Events evershop_hide_listing removal
-- Removes stripe_session_id/product_sku columns and evershop_hide_listing event type
-- Run this to undo 20251224_sync_events_evershop_hide.sql

PRAGMA foreign_keys=off;
BEGIN TRANSACTION;

-- Delete any evershop_hide_listing events (they won't satisfy new CHECK constraint)
DELETE FROM sync_events WHERE event_type = 'evershop_hide_listing';

-- Rename current table
ALTER TABLE sync_events RENAME TO sync_events_new;

-- Recreate original table without new columns and event type
CREATE TABLE sync_events (
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

-- Copy data back (excluding new columns)
INSERT INTO sync_events (
  id,
  event_uid,
  event_type,
  product_uid,
  item_uid,
  source_db,
  target_db,
  operator_id,
  payload,
  stripe_event_id,
  status,
  error_message,
  retry_count,
  created_at,
  synced_at
)
SELECT
  id,
  event_uid,
  event_type,
  product_uid,
  item_uid,
  source_db,
  target_db,
  operator_id,
  payload,
  stripe_event_id,
  status,
  error_message,
  retry_count,
  created_at,
  synced_at
FROM sync_events_new;

-- Drop temp table
DROP TABLE sync_events_new;

-- Recreate original indexes (without the dedupe index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_events_pending_product
  ON sync_events(product_uid, event_type)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_sync_events_status ON sync_events(status);
CREATE INDEX IF NOT EXISTS idx_sync_events_type ON sync_events(event_type);
CREATE INDEX IF NOT EXISTS idx_sync_events_product ON sync_events(product_uid);
CREATE INDEX IF NOT EXISTS idx_sync_events_stripe ON sync_events(stripe_event_id);

COMMIT;
PRAGMA foreign_keys=on;
