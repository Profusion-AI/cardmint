-- Rollback: Welcome Coupons Table

DROP INDEX IF EXISTS idx_welcome_coupons_code;
DROP INDEX IF EXISTS idx_welcome_coupons_email;
DROP TABLE IF EXISTS welcome_coupons;
