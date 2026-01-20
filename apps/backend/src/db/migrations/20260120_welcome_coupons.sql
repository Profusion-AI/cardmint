-- Welcome Coupons Table (Jan 2026)
-- Tracks unique 10% welcome codes issued to email subscribers via Stripe Promotion Codes

CREATE TABLE IF NOT EXISTS welcome_coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  stripe_promo_code_id TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  expires_at INTEGER,
  redeemed_at INTEGER,
  stripe_session_id TEXT
);

-- Index for fast lookup by email (idempotency check)
CREATE INDEX IF NOT EXISTS idx_welcome_coupons_email ON welcome_coupons(email);

-- Index for fast lookup by code (checkout validation)
CREATE INDEX IF NOT EXISTS idx_welcome_coupons_code ON welcome_coupons(code);
