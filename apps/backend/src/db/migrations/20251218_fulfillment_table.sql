-- Fulfillment table for shipping lifecycle management
-- Session-level tracking (supports multi-item checkout)
--
-- Design notes:
-- - Keyed by stripe_session_id (not item_uid) because shipping is per-order
-- - No shipping address stored (fetched from Stripe at label purchase time)
-- - Supports Shippo integration for label generation
-- - Manual review workflow for high-value orders

CREATE TABLE IF NOT EXISTS fulfillment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Stripe correlation (primary key for lookups)
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,

  -- Order metadata
  item_count INTEGER NOT NULL,
  original_subtotal_cents INTEGER NOT NULL,   -- Pre-discount sum of item prices
  final_subtotal_cents INTEGER NOT NULL,      -- Post-discount total customer paid (before shipping)

  -- Shipping method & cost (calculated at checkout)
  shipping_method TEXT NOT NULL CHECK(shipping_method IN ('TRACKED', 'PRIORITY')),
  shipping_cost_cents INTEGER NOT NULL,

  -- Manual review workflow (for orders >$100)
  requires_manual_review INTEGER NOT NULL DEFAULT 0,
  manual_review_completed_at INTEGER,
  manual_review_notes TEXT,
  manual_review_by TEXT,  -- Operator identifier

  -- Fulfillment status
  -- pending: awaiting operator action
  -- reviewed: manual review complete (if required)
  -- label_purchased: Shippo label created
  -- shipped: handed to carrier
  -- delivered: carrier confirmed delivery
  -- exception: delivery issue
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'reviewed', 'label_purchased', 'shipped', 'delivered', 'exception')),

  -- Carrier & tracking (populated after label purchase)
  carrier TEXT,                     -- 'usps', 'ups', 'fedex'
  tracking_number TEXT,
  tracking_url TEXT,

  -- Shippo integration
  shippo_transaction_id TEXT,       -- Shippo transaction ID for label
  shippo_rate_id TEXT,              -- Shippo rate object used
  label_url TEXT,                   -- URL to shipping label PDF
  label_purchased_at INTEGER,

  -- Delivery tracking
  shipped_at INTEGER,
  estimated_delivery_date TEXT,     -- ISO date string from carrier
  delivered_at INTEGER,

  -- Exception handling
  exception_type TEXT,              -- 'returned', 'lost', 'damaged', 'address_issue'
  exception_notes TEXT,
  exception_at INTEGER,

  -- Audit timestamps
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_fulfillment_status
  ON fulfillment(status);

CREATE INDEX IF NOT EXISTS idx_fulfillment_manual_review
  ON fulfillment(requires_manual_review, status)
  WHERE requires_manual_review = 1 AND status = 'pending';

CREATE INDEX IF NOT EXISTS idx_fulfillment_tracking
  ON fulfillment(tracking_number)
  WHERE tracking_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fulfillment_payment_intent
  ON fulfillment(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- Trigger to update updated_at on modification
CREATE TRIGGER IF NOT EXISTS fulfillment_updated_at
AFTER UPDATE ON fulfillment
BEGIN
  UPDATE fulfillment SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
END;
