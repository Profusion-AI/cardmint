-- Coupon redemption idempotency (Jan 2026)
-- Ensures promo coupon usage is incremented at most once per Stripe Checkout Session,
-- even if Stripe retries the webhook delivery.

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  stripe_session_id TEXT PRIMARY KEY,
  promo_code TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_promo_code ON coupon_redemptions(promo_code);
