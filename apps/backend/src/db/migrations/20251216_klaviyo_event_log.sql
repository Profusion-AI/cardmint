-- Klaviyo event log for tracking server-side email events
-- Phase 1: Order events (Placed Order, Ordered Product)
-- Reference: docs/december/klaviyo-dec-integration.md
--
-- KYLE CHECKPOINT: This migration creates a new table for Klaviyo event logging.
-- Events are logged before sending to enable replay on failure.

CREATE TABLE IF NOT EXISTS klaviyo_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id TEXT NOT NULL,       -- Link to stripe_webhook_events for audit trail
  event_type TEXT NOT NULL,            -- 'Placed Order', 'Ordered Product', etc.
  payload TEXT NOT NULL,               -- Full JSON payload sent to Klaviyo
  status TEXT DEFAULT 'pending',       -- pending, sent, failed
  response_code INTEGER,               -- HTTP response code from Klaviyo
  error_message TEXT,                  -- Error details if failed
  created_at INTEGER NOT NULL,         -- Unix timestamp when logged
  sent_at INTEGER,                     -- Unix timestamp when successfully sent
  FOREIGN KEY (stripe_event_id) REFERENCES stripe_webhook_events(event_id)
);

-- Index for finding events that need replay
CREATE INDEX IF NOT EXISTS idx_klaviyo_log_status ON klaviyo_event_log(status)
  WHERE status IN ('pending', 'failed');

-- Index for querying by stripe event (audit trail)
CREATE INDEX IF NOT EXISTS idx_klaviyo_log_stripe_event ON klaviyo_event_log(stripe_event_id);
