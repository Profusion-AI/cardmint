-- Rollback: coupon_redemptions idempotency table
-- Safe to drop: only used to prevent double-increment of EverShop coupon usage on Stripe webhook retries.

DROP INDEX IF EXISTS idx_coupon_redemptions_promo_code;
DROP TABLE IF EXISTS coupon_redemptions;
