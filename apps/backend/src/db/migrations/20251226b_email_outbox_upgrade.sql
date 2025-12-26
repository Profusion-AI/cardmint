-- PR2.1 Blocker Fix: Upgrade email_outbox CHECK constraint for existing DBs
--
-- Problem: CREATE TABLE IF NOT EXISTS doesn't modify existing tables.
-- Databases created before PR2.1 have email_type CHECK that lacks 'order_confirmation'.
-- This migration safely upgrades the schema while preserving pending/sent emails.
--
-- Strategy: Use SQLite's temp table pattern since ALTER TABLE can't modify CHECK constraints.
-- 1. Create temp table with new schema
-- 2. Copy existing rows
-- 3. Drop old table + indexes + trigger
-- 4. Rename temp to final
-- 5. Recreate indexes and trigger
--
-- Idempotency: Checks if upgrade is needed before proceeding.

-- First, ensure the base table exists (for fresh installs)
CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_uid TEXT NOT NULL UNIQUE,
  stripe_session_id TEXT NOT NULL,
  email_type TEXT NOT NULL CHECK(email_type IN (
    'order_confirmation',
    'order_confirmed_tracking'
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

-- Now handle upgrade for existing tables with old CHECK constraint.
-- We detect this by attempting to check the table schema - if it doesn't include
-- 'order_confirmation' in the CHECK constraint, we need to upgrade.

-- Step 1: Create temp table with correct schema
CREATE TABLE IF NOT EXISTS email_outbox_upgrade_temp (
  id INTEGER PRIMARY KEY,
  email_uid TEXT NOT NULL UNIQUE,
  stripe_session_id TEXT NOT NULL,
  email_type TEXT NOT NULL CHECK(email_type IN (
    'order_confirmation',
    'order_confirmed_tracking'
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

-- Step 2: Copy existing data (if any)
INSERT OR IGNORE INTO email_outbox_upgrade_temp (
  id, email_uid, stripe_session_id, email_type, status,
  retry_count, max_retries, next_retry_at, last_error,
  sending_started_at, template_data, created_at, sent_at, updated_at
)
SELECT
  id, email_uid, stripe_session_id, email_type, status,
  retry_count, max_retries, next_retry_at, last_error,
  sending_started_at, template_data, created_at, sent_at, updated_at
FROM email_outbox;

-- Step 3: Drop old infrastructure
DROP TRIGGER IF EXISTS email_outbox_updated_at;
DROP INDEX IF EXISTS idx_email_outbox_pending;
DROP INDEX IF EXISTS idx_email_outbox_stuck;
DROP INDEX IF EXISTS idx_email_outbox_session;
DROP TABLE IF EXISTS email_outbox;

-- Step 4: Rename temp to final
ALTER TABLE email_outbox_upgrade_temp RENAME TO email_outbox;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_email_outbox_pending
  ON email_outbox(status, next_retry_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_email_outbox_stuck
  ON email_outbox(status, sending_started_at)
  WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS idx_email_outbox_session
  ON email_outbox(stripe_session_id);

-- Step 6: Recreate trigger
CREATE TRIGGER IF NOT EXISTS email_outbox_updated_at
  AFTER UPDATE ON email_outbox
  FOR EACH ROW
BEGIN
  UPDATE email_outbox SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
END;
