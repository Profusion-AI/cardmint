-- CardMint Inventory Layer (SQLite) - Time-series pricing + per-copy inventory
-- Safe, idempotent migration for Phase 3.1
-- Applies to SQLite DB at ./data/cardmint.db

BEGIN;

-- 1) Catalog canonicalization (non-breaking)
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_canonical_unique ON cards(
  normalized_name, normalized_set, normalized_number
) WHERE normalized_name != '' AND normalized_set != '' AND normalized_number != '';

CREATE VIEW IF NOT EXISTS prints AS 
SELECT 
  id, 
  name, 
  set_name, 
  card_number, 
  normalized_name, 
  normalized_set, 
  normalized_number,
  lower(COALESCE(normalized_name,'') || '|' || COALESCE(normalized_set,'') || '|' || COALESCE(normalized_number,'')) AS canonical_key
FROM cards;

-- 2) Condition scale (raw conditions only)
CREATE TABLE IF NOT EXISTS condition_scale (
  code TEXT PRIMARY KEY,                  -- 'M','NM','LP','MP','HP','DMG'
  label TEXT NOT NULL,                    -- 'Mint', 'Near Mint', 'Light Play'
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),  -- For sorting/valuation
  description TEXT                        -- Detailed condition description
);

INSERT OR IGNORE INTO condition_scale(code, label, score, description) VALUES
  ('M',  'Mint',         100, 'Perfect condition, no visible wear'),
  ('NM', 'Near Mint',     95, 'Minimal wear, tournament playable'),
  ('LP', 'Light Play',    85, 'Light surface wear, minor edge whitening'),
  ('MP', 'Moderate Play', 70, 'Moderate wear and scratches'),
  ('HP', 'Heavy Play',    55, 'Heavy wear, major scratches, edge damage'),
  ('DMG','Damaged',       30, 'Major damage, creases, tears, or bends');

-- 3) Vendor condition mapping (graded vs raw)
CREATE TABLE IF NOT EXISTS vendor_condition_map (
  vendor TEXT NOT NULL,                   -- 'tcgplayer','pricecharting','psa','bgs','cgc'
  vendor_condition TEXT NOT NULL,         -- 'Near Mint', 'PSA 9', 'loose_price'
  code TEXT,                              -- raw code when is_graded=0, else NULL
  grade_min REAL,                         -- For slab ranges (e.g., 9.0)
  grade_max REAL,
  is_graded BOOLEAN NOT NULL DEFAULT 0,   -- Distinguish slabs
  confidence REAL DEFAULT 1.0,            -- Mapping confidence
  PRIMARY KEY (vendor, vendor_condition),
  CHECK ((is_graded = 0 AND code IS NOT NULL) OR (is_graded = 1 AND code IS NULL))
);

INSERT OR IGNORE INTO vendor_condition_map(vendor, vendor_condition, code, grade_min, grade_max, is_graded, confidence) VALUES
  ('tcgplayer',    'Near Mint',         'NM', NULL, NULL, 0, 1.0),
  ('tcgplayer',    'Lightly Played',    'LP', NULL, NULL, 0, 1.0),
  ('tcgplayer',    'Moderately Played', 'MP', NULL, NULL, 0, 1.0),
  ('tcgplayer',    'Heavily Played',    'HP', NULL, NULL, 0, 1.0),
  ('tcgplayer',    'Damaged',           'DMG',NULL, NULL, 0, 1.0),
  -- PriceCharting 'loose price' is ungraded (basis handled in pricing table)
  ('pricecharting','loose_price',        NULL, NULL, NULL, 0, 0.9),
  -- Grading company signals (code left NULL when graded)
  ('psa',          'PSA 10',             NULL, 10.0, 10.0, 1, 1.0),
  ('psa',          'PSA 9',              NULL,  9.0,  9.0, 1, 1.0),
  ('bgs',          'BGS 10',             NULL, 10.0, 10.0, 1, 1.0),
  ('cgc',          'CGC 10',             NULL, 10.0, 10.0, 1, 1.0),
  ('sgc',          'SGC 10',             NULL, 10.0, 10.0, 1, 1.0);

-- 4) Inventory items (per-copy fidelity; quantity=1)
CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,

  -- Variant attributes (vendor-agnostic)
  language TEXT DEFAULT 'en',
  finish TEXT CHECK (finish IN ('normal','holo','reverse','full','gold','unknown')) DEFAULT 'normal',
  edition TEXT CHECK (edition IN ('1st','unlimited','shadowless','promo','unknown')) DEFAULT 'unknown',
  variant_key TEXT GENERATED ALWAYS AS (lower(language || '|' || finish || '|' || edition)) STORED,
  
  -- Condition & grading
  condition_code TEXT NOT NULL REFERENCES condition_scale(code),
  graded_by TEXT CHECK (graded_by IN ('psa','bgs','cgc','sgc','other')),
  grade_numeric REAL CHECK (grade_numeric BETWEEN 1.0 AND 10.0),
  cert_number TEXT,

  -- Per-copy tracking
  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity = 1),
  acquisition_price_cents INTEGER CHECK(acquisition_price_cents IS NULL OR acquisition_price_cents >= 0),
  acquisition_currency TEXT DEFAULT 'USD',
  acquired_at TEXT, 
  source TEXT,                            -- 'purchase', 'trade', 'gift', 'pull', 'other'
  location TEXT,
  
  -- Listing/sales tracking
  listed_price_cents INTEGER CHECK(listed_price_cents IS NULL OR listed_price_cents >= 0),
  sale_price_cents INTEGER CHECK(sale_price_cents IS NULL OR sale_price_cents >= 0),
  sale_currency TEXT DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'owned' CHECK (status IN ('owned','listed','sold','pending')),

  -- Audit
  notes TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inv_card ON inventory_items(card_id);
CREATE INDEX IF NOT EXISTS idx_inv_status ON inventory_items(status);
CREATE INDEX IF NOT EXISTS idx_inv_condition ON inventory_items(condition_code, grade_numeric);
CREATE INDEX IF NOT EXISTS idx_inv_variant ON inventory_items(variant_key, condition_code);
CREATE INDEX IF NOT EXISTS idx_inv_location ON inventory_items(location);
CREATE INDEX IF NOT EXISTS idx_inv_acquired ON inventory_items(acquired_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_inventory_updated
    AFTER UPDATE ON inventory_items
    BEGIN
        UPDATE inventory_items SET updated_at = datetime('now') WHERE id = NEW.id;
    END;

-- Fallback triggers when generated columns are unavailable on some SQLite builds
-- (Safe to exist even when variant_key is generated; UPDATE will be a no-op)
CREATE TRIGGER IF NOT EXISTS trg_inventory_variant_key_fallback
  AFTER INSERT ON inventory_items
  WHEN NEW.variant_key IS NULL
  BEGIN
    UPDATE inventory_items SET variant_key = 
      lower(coalesce(NEW.language,'en') || '|' || 
            coalesce(NEW.finish,'normal') || '|' || 
            coalesce(NEW.edition,'unknown'))
    WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS trg_inventory_variant_key_fallback_update
  AFTER UPDATE OF language, finish, edition ON inventory_items
  BEGIN
    UPDATE inventory_items SET variant_key = 
      lower(coalesce(NEW.language,'en') || '|' || 
            coalesce(NEW.finish,'normal') || '|' || 
            coalesce(NEW.edition,'unknown'))
    WHERE id = NEW.id;
  END;

-- 5) Market pricing (time-series, integer cents)
CREATE TABLE IF NOT EXISTS market_price_samples (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL,                   -- 'tcgplayer','pricecharting','ebay','comc'
  basis TEXT NOT NULL,                    -- 'ungraded','NM','LP','PSA','BGS','CGC','graded'
  finish TEXT DEFAULT 'normal',
  edition TEXT DEFAULT 'unlimited',
  price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
  currency TEXT DEFAULT 'USD',
  grade_numeric REAL,                     -- e.g., 9.0, 10.0 for slabs
  sampled_at TEXT NOT NULL DEFAULT (datetime('now')),
  product_id TEXT,
  metadata TEXT,
  PRIMARY KEY (card_id, vendor, basis, finish, edition, sampled_at)
);

CREATE INDEX IF NOT EXISTS idx_mps_vendor_basis ON market_price_samples(vendor, basis);
CREATE INDEX IF NOT EXISTS idx_mps_sampled ON market_price_samples(sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_mps_card_sampled ON market_price_samples(card_id, sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_mps_card_basis ON market_price_samples(card_id, basis, finish);

-- View: latest market prices (one per card/vendor/basis/variant)
CREATE VIEW IF NOT EXISTS latest_market_prices AS
WITH latest_samples AS (
  SELECT 
    card_id, vendor, basis, finish, edition,
    MAX(sampled_at) as max_sampled_at
  FROM market_price_samples
  GROUP BY card_id, vendor, basis, finish, edition
)
SELECT 
  mps.*
FROM market_price_samples mps
JOIN latest_samples ls ON (
  mps.card_id = ls.card_id 
  AND mps.vendor = ls.vendor 
  AND mps.basis = ls.basis 
  AND IFNULL(mps.finish,'') = IFNULL(ls.finish,'') 
  AND IFNULL(mps.edition,'') = IFNULL(ls.edition,'')
  AND mps.sampled_at = ls.max_sampled_at
);

COMMIT;

