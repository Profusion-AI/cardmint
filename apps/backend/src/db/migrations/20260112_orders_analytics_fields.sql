-- Add discount/coupon fields to orders table for analytics
-- P0.4.3: Required for checkout_completed event financial fields

-- Original subtotal before any discounts applied
ALTER TABLE orders ADD COLUMN original_subtotal_cents INTEGER;

-- Total discount applied (lot builder + promo combined)
ALTER TABLE orders ADD COLUMN discount_cents INTEGER DEFAULT 0;

-- Promo coupon code applied (e.g., "TCGP15"), null if no coupon
ALTER TABLE orders ADD COLUMN promo_code TEXT;

-- Coupon source type for analytics
-- "LOT_BUILDER" = automatic bundle discount
-- "PROMO" = user-entered promo code
-- "COMBINED" = both applied
-- null = no discount
ALTER TABLE orders ADD COLUMN coupon_source TEXT CHECK(coupon_source IN ('LOT_BUILDER', 'PROMO', 'COMBINED') OR coupon_source IS NULL);

-- Tax (currently always 0, but included for completeness)
ALTER TABLE orders ADD COLUMN tax_cents INTEGER DEFAULT 0;
