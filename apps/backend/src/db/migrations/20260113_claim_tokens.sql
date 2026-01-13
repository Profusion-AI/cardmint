-- P1.3 Claim Order: Token storage + rate limiting tables
-- Supports order claim flow via email link with security controls

-- Claim tokens table: single-use tokens for order claim links
CREATE TABLE IF NOT EXISTS claim_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL UNIQUE,          -- UUID for internal reference
  order_uid TEXT NOT NULL,                -- FK to orders.order_uid (Stripe orders only)
  token_hash TEXT NOT NULL UNIQUE,        -- SHA-256 hash of the actual token (never store plaintext)
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  expires_at INTEGER NOT NULL,            -- Unix timestamp (30-min TTL)
  used_at INTEGER,                        -- Null until claimed
  claimed_by_identity TEXT,               -- WorkOS user ID if claimed while logged in
  FOREIGN KEY (order_uid) REFERENCES orders(order_uid)
);

CREATE INDEX IF NOT EXISTS idx_claim_tokens_order_uid ON claim_tokens(order_uid);
CREATE INDEX IF NOT EXISTS idx_claim_tokens_token_hash ON claim_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_claim_tokens_expires_at ON claim_tokens(expires_at);

-- Rate limiting table: tracks claim attempts per order
-- Prevents enumeration and email spam
CREATE TABLE IF NOT EXISTS claim_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_uid TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('email_send', 'zip_verify')),
  window_start INTEGER NOT NULL,          -- Start of the rate limit window (Unix timestamp)
  count_hourly INTEGER NOT NULL DEFAULT 0,
  count_daily INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  lockout_until INTEGER,                  -- For ZIP verify: 24h lockout after 3 failures
  UNIQUE(order_uid, action)
);

CREATE INDEX IF NOT EXISTS idx_claim_rate_limits_order_uid ON claim_rate_limits(order_uid);
CREATE INDEX IF NOT EXISTS idx_claim_rate_limits_window ON claim_rate_limits(window_start);

-- Claim events audit trail (no PII)
CREATE TABLE IF NOT EXISTS claim_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_uid TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'email_requested',      -- Customer requested claim email
    'email_sent',           -- Email successfully sent
    'email_rate_limited',   -- Rate limit hit
    'token_validated',      -- Token successfully validated
    'token_expired',        -- Token expired
    'token_invalid',        -- Invalid/unknown token
    'claim_completed',      -- Order claimed by identity
    'zip_attempt',          -- ZIP fallback attempted
    'zip_success',          -- ZIP verified
    'zip_failure',          -- ZIP mismatch
    'zip_locked_out'        -- 24h lockout triggered
  )),
  metadata TEXT,            -- JSON with non-PII details (e.g., masked email, attempt count)
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (order_uid) REFERENCES orders(order_uid)
);

CREATE INDEX IF NOT EXISTS idx_claim_events_order_uid ON claim_events(order_uid);
CREATE INDEX IF NOT EXISTS idx_claim_events_created_at ON claim_events(created_at);
