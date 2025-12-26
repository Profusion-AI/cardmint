-- Cart reservation system for WYSIWYG inventory model
-- Items are reserved immediately on cart add with 15-min TTL
-- Separates cart reservations from checkout reservations

-- Add cart reservation fields to items table
ALTER TABLE items ADD COLUMN cart_session_id TEXT;
ALTER TABLE items ADD COLUMN reservation_type TEXT CHECK(reservation_type IN ('cart', 'checkout'));
ALTER TABLE items ADD COLUMN cart_reserved_at INTEGER;

-- Index for finding items by cart session (for release/promote operations)
CREATE INDEX IF NOT EXISTS idx_items_cart_session ON items(cart_session_id)
  WHERE cart_session_id IS NOT NULL;

-- Index for cart reservation expiry (separate from checkout expiry)
CREATE INDEX IF NOT EXISTS idx_items_cart_expiry ON items(reserved_until, reservation_type)
  WHERE status = 'RESERVED' AND reservation_type = 'cart' AND reserved_until IS NOT NULL;

-- Index for checkout reservation expiry (improves existing query with reservation_type filter)
CREATE INDEX IF NOT EXISTS idx_items_checkout_expiry ON items(reserved_until, reservation_type)
  WHERE status = 'RESERVED' AND reservation_type = 'checkout' AND reserved_until IS NOT NULL;

-- Rate limiting table for cart reserve abuse prevention
CREATE TABLE IF NOT EXISTS cart_rate_limits (
  ip_address TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ip_address, window_start)
);

-- Cleanup old rate limit entries (run periodically)
CREATE INDEX IF NOT EXISTS idx_cart_rate_limits_window ON cart_rate_limits(window_start);

-- Backfill: Set reservation_type='checkout' for existing RESERVED rows with checkout_session_id
-- This ensures legacy checkout reservations are properly tracked and cleaned up by expiry job
UPDATE items
SET reservation_type = 'checkout'
WHERE status = 'RESERVED'
  AND checkout_session_id IS NOT NULL
  AND reservation_type IS NULL;
