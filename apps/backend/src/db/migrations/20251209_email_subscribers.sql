-- Email subscribers table for mailing list collection
-- Interim solution until Mailchimp/Klaviyo integration (Dec 2025)

CREATE TABLE IF NOT EXISTS email_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT DEFAULT 'vault_landing',
  ip_address TEXT,
  unsubscribed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_subscribers_email ON email_subscribers(email);
CREATE INDEX IF NOT EXISTS idx_email_subscribers_subscribed_at ON email_subscribers(subscribed_at);
