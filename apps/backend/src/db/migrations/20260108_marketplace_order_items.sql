-- Marketplace order items: card-level line items from TCGPlayer Pull Sheet
-- Supports "items can arrive before orders" via nullable marketplace_order_id
-- Uses item_key for deterministic idempotent upserts

CREATE TABLE IF NOT EXISTS marketplace_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Order linkage (nullable: items can exist before order is imported)
  marketplace_order_id INTEGER REFERENCES marketplace_orders(id) ON DELETE CASCADE,

  -- Source identification (required: enables linking even without order row)
  source TEXT NOT NULL CHECK(source IN ('tcgplayer', 'ebay')),
  external_order_id TEXT NOT NULL,       -- Raw TCGPlayer order ID (e.g., 36666676-C978EE-DD7D0)

  -- Deterministic item key for idempotency (SKU or hash of card fields)
  item_key TEXT NOT NULL,                -- SkuId if present; else hash of card attributes

  -- TCGPlayer identification
  tcgplayer_sku_id TEXT,                 -- "2995546" from SkuId column (may be NULL)

  -- Card details
  product_name TEXT NOT NULL,            -- "Kabuto"
  set_name TEXT,                         -- "Fossil"
  card_number TEXT,                      -- "50/62"
  condition TEXT,                        -- "Lightly Played 1st Edition"
  rarity TEXT,                           -- "Common"
  product_line TEXT,                     -- "Pokemon"
  set_release_date INTEGER,              -- Unix timestamp of set release

  -- Quantity and pricing
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER,              -- Computed from order total when possible
  price_confidence TEXT DEFAULT 'unavailable' CHECK(price_confidence IN (
    'exact',        -- Single unique item in order: price = order_product_value / total_qty
    'estimated',    -- Multiple items: flat allocation or heuristic
    'unavailable'   -- Order not yet imported, or no price data
  )),

  -- Image
  image_url TEXT,                        -- Main Photo URL from CSV (often empty)

  -- Audit
  import_batch_id INTEGER REFERENCES import_batches(id),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),

  -- Unique on source + order + item key (not marketplace_order_id since it's nullable)
  UNIQUE(source, external_order_id, item_key)
);

-- Index for fast reads by order FK (once attached)
CREATE INDEX IF NOT EXISTS idx_marketplace_order_items_order_id
  ON marketplace_order_items(marketplace_order_id);

-- Index for lookups by external order ID (for attaching items to orders later)
CREATE INDEX IF NOT EXISTS idx_marketplace_order_items_external
  ON marketplace_order_items(source, external_order_id);

-- Index for SKU lookups
CREATE INDEX IF NOT EXISTS idx_marketplace_order_items_sku
  ON marketplace_order_items(tcgplayer_sku_id);

-- Trigger to update updated_at on modification
CREATE TRIGGER IF NOT EXISTS marketplace_order_items_updated_at AFTER UPDATE ON marketplace_order_items
BEGIN
  UPDATE marketplace_order_items SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
END;
