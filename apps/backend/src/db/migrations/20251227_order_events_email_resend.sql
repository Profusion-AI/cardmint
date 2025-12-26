-- PR3: add email_resend_triggered to order_events.event_type CHECK
-- SQLite requires temp-table pattern for CHECK constraint changes.

-- 1) Create temp table with expanded CHECK
CREATE TABLE IF NOT EXISTS order_events_upgrade_temp (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_uid TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'created',
    'status_changed',
    'tracking_added',
    'email_sent',
    'exception_raised',
    'exception_resolved',
    'email_resend_triggered'
  )),
  old_value TEXT,
  new_value TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (order_uid) REFERENCES orders(order_uid)
);

-- 2) Copy data from existing table
INSERT INTO order_events_upgrade_temp (
  id, order_uid, event_type, old_value, new_value, actor, created_at
)
SELECT
  id, order_uid, event_type, old_value, new_value, actor, created_at
FROM order_events;

-- 3) Drop old indexes + table
DROP INDEX IF EXISTS idx_order_events_order_uid;
DROP INDEX IF EXISTS idx_order_events_created_at;
DROP TABLE IF EXISTS order_events;

-- 4) Rename temp -> final
ALTER TABLE order_events_upgrade_temp RENAME TO order_events;

-- 5) Recreate indexes
CREATE INDEX IF NOT EXISTS idx_order_events_order_uid ON order_events(order_uid);
CREATE INDEX IF NOT EXISTS idx_order_events_created_at ON order_events(created_at);
