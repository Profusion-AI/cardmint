-- PR2.1: Email outbox for two-email model
--
-- Email types:
-- 1. order_confirmation - sent immediately at checkout (no tracking)
-- 2. order_confirmed_tracking - sent after label purchase (with tracking)
--
-- Safety: Uses CREATE TABLE IF NOT EXISTS to avoid data loss on reapply.
-- If schema changes are needed after initial deploy, use a new migration
-- that preserves existing rows via temp table pattern.
--
-- Reference: PR2.1 hotfix per docs/fulfillment-north-star.md

CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_uid TEXT NOT NULL UNIQUE,

  stripe_session_id TEXT NOT NULL,

  -- Email type: two-email model
  email_type TEXT NOT NULL CHECK(email_type IN (
    'order_confirmation',       -- Sent at checkout (no tracking)
    'order_confirmed_tracking'  -- Sent after label purchase (with tracking)
  )),

  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending',
    'sending',
    'sent',
    'failed'
  )),

  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_retry_at INTEGER,
  last_error TEXT,
  sending_started_at INTEGER,
  template_data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  sent_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),

  UNIQUE(stripe_session_id, email_type)
);

-- Indexes for worker performance
CREATE INDEX IF NOT EXISTS idx_email_outbox_pending
  ON email_outbox(status, next_retry_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_email_outbox_stuck
  ON email_outbox(status, sending_started_at)
  WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS idx_email_outbox_session
  ON email_outbox(stripe_session_id);

-- Auto-update trigger for updated_at
CREATE TRIGGER IF NOT EXISTS email_outbox_updated_at
  AFTER UPDATE ON email_outbox
  FOR EACH ROW
BEGIN
  UPDATE email_outbox SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
END;
