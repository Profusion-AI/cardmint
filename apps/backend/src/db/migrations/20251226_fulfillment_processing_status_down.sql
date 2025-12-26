-- Down migration: Remove 'processing' status from fulfillment.status CHECK constraint
-- Reverts: 20251226_fulfillment_processing_status.sql
--
-- CAUTION: Any rows with status='processing' must be reset to 'pending' before rollback
-- This migration handles that automatically.
--
-- Reference: Codex review - Critical rollback requirement

-- Drop triggers first (they reference the old table)
DROP TRIGGER IF EXISTS fulfillment_updated_at;

-- Drop indexes (will be recreated)
DROP INDEX IF EXISTS idx_fulfillment_status;
DROP INDEX IF EXISTS idx_fulfillment_manual_review;
DROP INDEX IF EXISTS idx_fulfillment_tracking;
DROP INDEX IF EXISTS idx_fulfillment_payment_intent;
DROP INDEX IF EXISTS idx_fulfillment_easypost_shipment;

-- 1. Reset any 'processing' rows to 'pending' before schema change
UPDATE fulfillment SET status = 'pending' WHERE status = 'processing';

-- 2. Create new table WITHOUT 'processing' in CHECK constraint
CREATE TABLE fulfillment_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Stripe correlation (primary key for lookups)
  stripe_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,

  -- Order metadata
  item_count INTEGER NOT NULL,
  original_subtotal_cents INTEGER NOT NULL,
  final_subtotal_cents INTEGER NOT NULL,

  -- Shipping method & cost (calculated at checkout)
  shipping_method TEXT NOT NULL CHECK(shipping_method IN ('TRACKED', 'PRIORITY')),
  shipping_cost_cents INTEGER NOT NULL,

  -- Manual review workflow (for orders >$100)
  requires_manual_review INTEGER NOT NULL DEFAULT 0,
  manual_review_completed_at INTEGER,
  manual_review_notes TEXT,
  manual_review_by TEXT,

  -- Fulfillment status (REVERTED: removed 'processing')
  -- pending: awaiting operator action
  -- reviewed: manual review complete (if required)
  -- label_purchased: EasyPost label created
  -- shipped: handed to carrier
  -- delivered: carrier confirmed delivery
  -- exception: delivery issue or cost guardrail triggered
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'reviewed', 'label_purchased',
                     'shipped', 'delivered', 'exception')),

  -- Carrier & tracking (populated after label purchase)
  carrier TEXT,
  tracking_number TEXT,
  tracking_url TEXT,

  -- Shippo integration (legacy, preserved for backward compatibility)
  shippo_transaction_id TEXT,
  shippo_rate_id TEXT,
  label_url TEXT,
  label_purchased_at INTEGER,

  -- Delivery tracking
  shipped_at INTEGER,
  estimated_delivery_date TEXT,
  delivered_at INTEGER,

  -- Exception handling
  exception_type TEXT,
  exception_notes TEXT,
  exception_at INTEGER,

  -- Audit timestamps
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),

  -- EasyPost columns (from 20251223_easypost_integration.sql)
  easypost_shipment_id TEXT,
  easypost_rate_id TEXT,
  easypost_service TEXT,
  label_cost_cents INTEGER
);

-- 3. Copy existing data
INSERT INTO fulfillment_new SELECT * FROM fulfillment;

-- 4. Drop old table and rename new
DROP TABLE fulfillment;
ALTER TABLE fulfillment_new RENAME TO fulfillment;

-- 5. Recreate indexes
CREATE INDEX idx_fulfillment_status ON fulfillment(status);

CREATE INDEX idx_fulfillment_manual_review ON fulfillment(requires_manual_review, status)
  WHERE requires_manual_review = 1 AND status = 'pending';

CREATE INDEX idx_fulfillment_tracking ON fulfillment(tracking_number)
  WHERE tracking_number IS NOT NULL;

CREATE INDEX idx_fulfillment_payment_intent ON fulfillment(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX idx_fulfillment_easypost_shipment ON fulfillment(easypost_shipment_id)
  WHERE easypost_shipment_id IS NOT NULL;

-- 6. Recreate trigger
CREATE TRIGGER fulfillment_updated_at AFTER UPDATE ON fulfillment
BEGIN
  UPDATE fulfillment SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
END;
