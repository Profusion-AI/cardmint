-- Marketplace fulfillment tables for TCGPlayer/eBay orders
-- Separate from Stripe-keyed orders/fulfillment tables to avoid worker conflicts
-- Supports 1:N order-to-shipment relationship for split shipments

-- Import batch tracking for idempotency and auditability
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('tcgplayer', 'ebay', 'easypost_tracking')),
  imported_by TEXT NOT NULL,           -- operator username
  imported_at INTEGER NOT NULL,        -- Unix timestamp
  file_checksum TEXT NOT NULL,         -- SHA-256 of CSV content
  file_name TEXT,                      -- Original filename
  row_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  skip_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
  error_details TEXT                   -- JSON array of row-level errors
);

CREATE INDEX IF NOT EXISTS idx_import_batches_source ON import_batches(source);
CREATE INDEX IF NOT EXISTS idx_import_batches_status ON import_batches(status);
CREATE INDEX IF NOT EXISTS idx_import_batches_imported_at ON import_batches(imported_at);

-- Marketplace orders (TCGPlayer, eBay) - separate from Stripe orders
CREATE TABLE IF NOT EXISTS marketplace_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('tcgplayer', 'ebay')),
  external_order_id TEXT NOT NULL,     -- Full TCGPlayer order ID (e.g., 36666676-2BE847-4FC4D)
  display_order_number TEXT NOT NULL,  -- TCG-20260102-000001 (generated, collision-checked)
  customer_name TEXT NOT NULL,         -- "Tyler Carlson"
  customer_name_normalized TEXT NOT NULL, -- "TYLER CARLSON" (for matching)
  order_date INTEGER NOT NULL,         -- Unix timestamp
  item_count INTEGER NOT NULL,
  product_value_cents INTEGER NOT NULL,
  shipping_fee_cents INTEGER NOT NULL,
  product_weight_oz REAL,              -- For label generation
  shipping_method TEXT,                -- "Standard (7-10 days)"
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending',      -- Imported, awaiting label
    'processing',   -- Label being created
    'shipped',      -- All shipments shipped
    'delivered',    -- All shipments delivered
    'exception',    -- Delivery issue
    'cancelled'     -- Order cancelled
  )),
  import_batch_id INTEGER REFERENCES import_batches(id),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE(source, external_order_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_source ON marketplace_orders(source);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_status ON marketplace_orders(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_customer_norm ON marketplace_orders(customer_name_normalized);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_order_date ON marketplace_orders(order_date);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_display_number ON marketplace_orders(display_order_number);

-- Trigger to update updated_at on modification
CREATE TRIGGER IF NOT EXISTS marketplace_orders_updated_at AFTER UPDATE ON marketplace_orders
BEGIN
  UPDATE marketplace_orders SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
END;

-- 1:N shipments per marketplace order (supports split shipments)
CREATE TABLE IF NOT EXISTS marketplace_shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace_order_id INTEGER NOT NULL REFERENCES marketplace_orders(id),
  shipment_sequence INTEGER NOT NULL DEFAULT 1, -- 1, 2, 3... for split shipments

  -- Shipping address (encrypted, retained 90 days post-delivery)
  shipping_address_encrypted TEXT,     -- AES-256 encrypted JSON
  shipping_zip TEXT,                   -- Plaintext for matching (not full PII)
  address_expires_at INTEGER,          -- Unix timestamp when to purge

  -- EasyPost integration
  easypost_shipment_id TEXT,
  easypost_rate_id TEXT,
  carrier TEXT,
  service TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  label_url TEXT,
  label_cost_cents INTEGER,
  label_purchased_at INTEGER,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending',           -- Awaiting label
    'label_purchased',   -- Label bought, ready to ship
    'shipped',           -- Handed to carrier
    'in_transit',        -- Carrier scanned
    'delivered',         -- Carrier confirmed delivery
    'exception'          -- Delivery issue
  )),
  shipped_at INTEGER,
  delivered_at INTEGER,
  exception_type TEXT,
  exception_notes TEXT,

  -- Matching metadata (for EasyPost tracking imports)
  tracking_match_confidence TEXT CHECK(tracking_match_confidence IN ('auto', 'manual', 'unmatched') OR tracking_match_confidence IS NULL),
  tracking_matched_at INTEGER,
  tracking_matched_by TEXT,            -- 'system' or operator username

  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE(marketplace_order_id, shipment_sequence)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_order_id ON marketplace_shipments(marketplace_order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_tracking ON marketplace_shipments(tracking_number);
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_status ON marketplace_shipments(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_shipments_zip ON marketplace_shipments(shipping_zip);

-- Trigger to update updated_at on modification
CREATE TRIGGER IF NOT EXISTS marketplace_shipments_updated_at AFTER UPDATE ON marketplace_shipments
BEGIN
  UPDATE marketplace_shipments SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
END;

-- Unmatched EasyPost tracking (pending manual resolution)
CREATE TABLE IF NOT EXISTS unmatched_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER REFERENCES import_batches(id),
  easypost_tracker_id TEXT NOT NULL UNIQUE, -- UNIQUE to prevent duplicate imports
  easypost_shipment_id TEXT,
  tracking_number TEXT NOT NULL,
  carrier TEXT,
  signed_by TEXT,                      -- Customer name from EasyPost
  signed_by_normalized TEXT,           -- Normalized for matching
  destination_zip TEXT,
  easypost_status TEXT,                -- Tracking status from EasyPost
  created_at_easypost INTEGER,         -- When shipment was created in EasyPost

  -- Resolution
  resolution_status TEXT NOT NULL DEFAULT 'pending' CHECK(resolution_status IN (
    'pending',       -- Awaiting manual resolution
    'matched',       -- Linked to a shipment
    'ignored',       -- Operator marked as irrelevant
    'manual_entry'   -- Operator created new order from this
  )),
  matched_to_shipment_id INTEGER REFERENCES marketplace_shipments(id),
  resolved_by TEXT,
  resolved_at INTEGER,

  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_unmatched_tracking_status ON unmatched_tracking(resolution_status);
CREATE INDEX IF NOT EXISTS idx_unmatched_tracking_signed_by ON unmatched_tracking(signed_by_normalized);
CREATE INDEX IF NOT EXISTS idx_unmatched_tracking_tracking_number ON unmatched_tracking(tracking_number);
