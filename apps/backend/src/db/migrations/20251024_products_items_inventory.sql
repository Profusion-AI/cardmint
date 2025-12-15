-- Migration: Products and Items Inventory Tables (Phase 1.2)
-- Date: 2025-10-24
-- Purpose: Physical inventory tracking with product (card identity) and items (physical units)
-- Reference: docs/MANIFEST_SKU_BEHAVIOR_ANALYSIS.md (lines 282-288, 302-307)
-- Acceptance: Products track unique card variants, items track physical inventory units

PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;

-- =============================================================================
-- Products: Unique Card Identities (One Per Card Variant)
-- =============================================================================

-- products: Unique card identities in inventory
-- One product = one unique (card + condition bucket) combination
-- Multiple items can reference the same product (duplicate physical cards)
CREATE TABLE IF NOT EXISTS products (
  product_uid TEXT PRIMARY KEY,
  -- Unique product identifier (UUID v4)

  cm_card_id TEXT NOT NULL,
  -- Foreign key to cm_cards (canonical card identity)

  condition_bucket TEXT NOT NULL DEFAULT 'UNKNOWN',
  -- Condition: NM, LP, MP, HP, UNKNOWN, NO_CONDITION
  -- Reference: MANIFEST_SKU_BEHAVIOR_ANALYSIS.md lines 332-334

  product_sku TEXT NOT NULL UNIQUE,
  -- Product SKU: PKM:{cm_set_id}:{collector_no}:{variant}:{lang}
  -- Format defined in lines 349-352

  listing_sku TEXT NOT NULL,
  -- Listing SKU: {product_sku}:{condition_bucket}
  -- Format defined in line 351

  card_name TEXT NOT NULL,
  -- Denormalized card name for quick access

  set_name TEXT NOT NULL,
  -- Denormalized set name

  collector_no TEXT NOT NULL,
  -- Denormalized collector number

  hp_value INTEGER,
  -- Denormalized HP value (null for Trainer/Energy)

  rarity TEXT,
  -- Denormalized rarity

  market_price REAL,
  -- Market price (before markup, raw/ungraded for UNKNOWN/NO_CONDITION)

  launch_price REAL,
  -- Launch price (market_price * markup)

  pricing_channel TEXT,
  -- Pricing channel used: "graded", "raw", "blended", "ungraded"
  -- NM/LP → graded/blended, MP/HP/UNKNOWN/NO_CONDITION → raw/ungraded

  total_quantity INTEGER NOT NULL DEFAULT 0,
  -- Total inventory quantity across all items for this product
  -- Updated via trigger when items are added/removed

  notes TEXT,
  -- Operator notes

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (cm_card_id) REFERENCES cm_cards(cm_card_id) ON DELETE CASCADE,

  -- Enforce allowed condition values
  CHECK (condition_bucket IN ('NM', 'LP', 'MP', 'HP', 'UNKNOWN', 'NO_CONDITION'))
);

-- Enforce unique (cm_card_id, condition_bucket) per product
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_card_condition
  ON products(cm_card_id, condition_bucket);

CREATE INDEX IF NOT EXISTS idx_products_sku ON products(product_sku);
CREATE INDEX IF NOT EXISTS idx_products_listing_sku ON products(listing_sku);
CREATE INDEX IF NOT EXISTS idx_products_cm_card ON products(cm_card_id);
CREATE INDEX IF NOT EXISTS idx_products_condition ON products(condition_bucket);
CREATE INDEX IF NOT EXISTS idx_products_pricing_channel ON products(pricing_channel);

-- =============================================================================
-- Items: Physical Inventory Units (Multiple Items Per Product)
-- =============================================================================

-- items: Physical inventory units (actual cards in stock)
-- One item = one physical card (or batch of identical cards)
-- Multiple items can reference same product (rescans or duplicate physical inventory)
CREATE TABLE IF NOT EXISTS items (
  item_uid TEXT PRIMARY KEY,
  -- Unique item identifier (UUID v4)

  product_uid TEXT NOT NULL,
  -- Foreign key to products (which card identity this is)

  quantity INTEGER NOT NULL DEFAULT 1,
  -- Quantity in this item (usually 1, but supports batching)

  acquisition_date INTEGER,
  -- When this item was acquired (timestamp)

  acquisition_source TEXT,
  -- Acquisition source: "scan", "bulk_import", "operator_entry"

  capture_session_id TEXT,
  -- Foreign key to operator_sessions (which session captured this item)

  location TEXT,
  -- Physical storage location (shelf, bin, etc.)

  internal_notes TEXT,
  -- Internal operator notes (not customer-facing)

  status TEXT NOT NULL DEFAULT 'IN_STOCK',
  -- Status: IN_STOCK, RESERVED, SOLD, FLAGGED, REMOVED
  -- IN_STOCK: available for sale
  -- RESERVED: held for pending order
  -- SOLD: sold and shipped
  -- FLAGGED: operator flagged for review
  -- REMOVED: removed from inventory (damaged, etc.)

  sold_at INTEGER,
  -- Timestamp when sold

  sold_price REAL,
  -- Actual sale price

  removed_at INTEGER,
  -- Timestamp when removed from inventory

  removed_reason TEXT,
  -- Reason for removal: "damaged", "lost", "operator_error", "other"

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (product_uid) REFERENCES products(product_uid) ON DELETE CASCADE,
  FOREIGN KEY (capture_session_id) REFERENCES operator_sessions(id) ON DELETE SET NULL,

  CHECK (quantity > 0),
  CHECK (status IN ('IN_STOCK', 'RESERVED', 'SOLD', 'FLAGGED', 'REMOVED'))
);

CREATE INDEX IF NOT EXISTS idx_items_product ON items(product_uid);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_session ON items(capture_session_id);
CREATE INDEX IF NOT EXISTS idx_items_acquisition_date ON items(acquisition_date);

-- =============================================================================
-- Triggers: Maintain Product Total Quantity
-- =============================================================================

-- Update product total_quantity when items are inserted
CREATE TRIGGER IF NOT EXISTS items_ai_update_product_quantity
AFTER INSERT ON items
BEGIN
  UPDATE products
  SET total_quantity = (
    SELECT COALESCE(SUM(quantity), 0)
    FROM items
    WHERE product_uid = NEW.product_uid
      AND status IN ('IN_STOCK', 'RESERVED')
  ),
  updated_at = strftime('%s', 'now')
  WHERE product_uid = NEW.product_uid;
END;

-- Update product total_quantity when items are updated
CREATE TRIGGER IF NOT EXISTS items_au_update_product_quantity
AFTER UPDATE ON items
BEGIN
  UPDATE products
  SET total_quantity = (
    SELECT COALESCE(SUM(quantity), 0)
    FROM items
    WHERE product_uid = NEW.product_uid
      AND status IN ('IN_STOCK', 'RESERVED')
  ),
  updated_at = strftime('%s', 'now')
  WHERE product_uid = NEW.product_uid;
END;

-- Update product total_quantity when items are deleted
CREATE TRIGGER IF NOT EXISTS items_ad_update_product_quantity
AFTER DELETE ON items
BEGIN
  UPDATE products
  SET total_quantity = (
    SELECT COALESCE(SUM(quantity), 0)
    FROM items
    WHERE product_uid = OLD.product_uid
      AND status IN ('IN_STOCK', 'RESERVED')
  ),
  updated_at = strftime('%s', 'now')
  WHERE product_uid = OLD.product_uid;
END;

-- =============================================================================
-- Migration Metadata
-- =============================================================================

-- Migration applied: 2025-10-24
-- Phase 1.2 of CardMint Inventory System migration
