-- ============================================================================
-- Migration 003: Inventory Layer with Condition Scale
-- ============================================================================
-- 
-- CRITICAL MIGRATION SAFETY NOTES:
-- 1. SQLite doesn't support column drops - we work around this limitation
-- 2. Foreign keys are deferred until all tables exist
-- 3. Triggers use AFTER timing to avoid recursion (row must exist first)
-- 4. Large indexes are created last to avoid performance impact
-- 5. All operations are wrapped in transaction for atomicity
--
-- ROLLBACK STRATEGY:
-- Due to SQLite limitations, rollback requires dropping tables and recreating
-- from backup. This migration creates backup tables before making changes.
--
-- ============================================================================

PRAGMA foreign_keys = OFF;  -- Disable during migration
BEGIN TRANSACTION;

-- ============================================================================
-- BACKUP EXISTING DATA (if any)
-- ============================================================================

-- Create backup tables for any existing inventory data
CREATE TABLE IF NOT EXISTS inventory_backup_20250829 AS 
    SELECT * FROM inventory WHERE 1=0;  -- Schema only, no data yet

-- If inventory table exists and has data, back it up
INSERT INTO inventory_backup_20250829 
    SELECT * FROM inventory WHERE EXISTS (SELECT 1 FROM inventory LIMIT 1);

-- ============================================================================
-- REFERENCE DATA TABLES (Created First - No Dependencies)
-- ============================================================================

-- Condition Scale: Vendor-agnostic condition hierarchy
CREATE TABLE IF NOT EXISTS condition_scale (
    code TEXT PRIMARY KEY,                    -- 'M','NM','LP','MP','HP','DMG'
    label TEXT NOT NULL,                      -- Human readable
    score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Vendor Condition Mapping: Maps vendor-specific conditions to our scale
CREATE TABLE IF NOT EXISTS vendor_condition_map (
    vendor TEXT NOT NULL,                     -- 'tcgplayer', 'pricecharting', etc
    vendor_condition TEXT NOT NULL,           -- Vendor's condition string
    code TEXT,                               -- Our condition code (NULL for graded)
    grade_min REAL,                          -- Min grade for graded conditions
    grade_max REAL,                          -- Max grade for graded conditions  
    is_graded BOOLEAN NOT NULL DEFAULT 0,    -- Explicit graded handling
    confidence REAL DEFAULT 1.0 CHECK(confidence BETWEEN 0 AND 1),
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    PRIMARY KEY (vendor, vendor_condition),
    FOREIGN KEY (code) REFERENCES condition_scale(code),
    CHECK ((is_graded = 0 AND code IS NOT NULL) OR (is_graded = 1 AND code IS NULL))
);

-- ============================================================================
-- MARKET PRICING (Time Series Architecture) 
-- ============================================================================

-- Time-series market pricing samples (integer cents for performance)
CREATE TABLE IF NOT EXISTS market_price_samples (
    card_id TEXT NOT NULL,                   -- FK to cards.id (deferred)
    vendor TEXT NOT NULL,                    -- Data source
    basis TEXT NOT NULL,                     -- 'ungraded','NM','LP','PSA','BGS','CGC'
    finish TEXT DEFAULT 'normal',            -- Foil variants
    edition TEXT DEFAULT 'unlimited',        -- Edition variants
    price_cents INTEGER NOT NULL CHECK(price_cents >= 0),  -- INTEGER for speed
    currency TEXT DEFAULT 'USD',
    grade_numeric REAL,                      -- For graded cards (9.0, 10.0, etc)
    sampled_at TEXT NOT NULL DEFAULT (datetime('now')),
    product_id TEXT,                         -- Vendor product identifier
    metadata TEXT,                           -- JSON for vendor-specific data
    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    PRIMARY KEY (card_id, vendor, basis, finish, edition, sampled_at)
    -- Foreign key constraint added after cards table is confirmed to exist
);

-- Latest market prices view (for performance)
CREATE VIEW IF NOT EXISTS market_prices_latest AS
    SELECT DISTINCT
        card_id,
        vendor, 
        basis,
        finish,
        edition,
        FIRST_VALUE(price_cents) OVER (
            PARTITION BY card_id, vendor, basis, finish, edition 
            ORDER BY sampled_at DESC
        ) as price_cents,
        FIRST_VALUE(grade_numeric) OVER (
            PARTITION BY card_id, vendor, basis, finish, edition 
            ORDER BY sampled_at DESC  
        ) as grade_numeric,
        FIRST_VALUE(sampled_at) OVER (
            PARTITION BY card_id, vendor, basis, finish, edition 
            ORDER BY sampled_at DESC
        ) as sampled_at
    FROM market_price_samples;

-- ============================================================================
-- INVENTORY LAYER (Per-Copy Fidelity)
-- ============================================================================

-- Drop existing inventory table if it exists (data is backed up)
DROP TABLE IF EXISTS inventory;

-- Recreate inventory table with optimized schema
CREATE TABLE inventory (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    card_id TEXT NOT NULL,                   -- FK to cards.id (deferred)
    
    -- Physical condition (vendor-agnostic)
    condition_code TEXT,                     -- 'NM', 'LP', etc (NULL for graded)
    
    -- Graded card fields (separated from condition scale)
    grading_company TEXT,                    -- 'PSA', 'BGS', 'CGC', etc
    grade_numeric REAL,                      -- 9.0, 10.0, etc
    cert_number TEXT,                        -- Certification number
    
    -- Variant handling (auto-generated)
    variant_key TEXT,                        -- Auto-generated from variant fields
    finish TEXT DEFAULT 'normal',            -- 'normal', 'holo', 'reverse', etc
    language TEXT DEFAULT 'english',
    misprint TEXT,                           -- NULL for normal, description for misprints
    
    -- Inventory tracking
    quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity = 1),  -- Per-copy fidelity
    location TEXT,                           -- Physical storage location
    acquisition_date TEXT DEFAULT (date('now')),
    acquisition_price_cents INTEGER CHECK(acquisition_price_cents IS NULL OR acquisition_price_cents >= 0),
    
    -- Metadata
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    -- Constraints
    FOREIGN KEY (condition_code) REFERENCES condition_scale(code),
    CHECK ((condition_code IS NOT NULL AND grading_company IS NULL) OR 
           (condition_code IS NULL AND grading_company IS NOT NULL)),  -- Either raw or graded
    
    -- Unique constraint: One copy per card+condition+variant combination  
    UNIQUE (card_id, condition_code, grading_company, grade_numeric, cert_number, variant_key)
);

-- ============================================================================
-- TRIGGER: Auto-generate variant_key 
-- ============================================================================
-- Uses AFTER timing to avoid recursion (row exists first)

CREATE TRIGGER IF NOT EXISTS inventory_variant_key_insert
AFTER INSERT ON inventory 
WHEN NEW.variant_key IS NULL
BEGIN
    UPDATE inventory 
    SET variant_key = printf('%s|%s|%s', 
        COALESCE(NEW.finish, 'normal'),
        COALESCE(NEW.language, 'english'), 
        COALESCE(NEW.misprint, 'none')
    )
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS inventory_variant_key_update  
AFTER UPDATE ON inventory
WHEN (OLD.finish != NEW.finish OR 
      OLD.language != NEW.language OR
      OLD.misprint != NEW.misprint OR
      NEW.variant_key IS NULL)
BEGIN
    UPDATE inventory
    SET variant_key = printf('%s|%s|%s',
        COALESCE(NEW.finish, 'normal'),
        COALESCE(NEW.language, 'english'),
        COALESCE(NEW.misprint, 'none')
    ),
    updated_at = datetime('now')
    WHERE id = NEW.id;
END;

-- ============================================================================
-- SEED REFERENCE DATA
-- ============================================================================

-- Populate condition scale (standard 6-point scale)
INSERT OR REPLACE INTO condition_scale (code, label, score, description) VALUES
    ('M',   'Mint',             100, 'Perfect condition, appears unplayed'),
    ('NM',  'Near Mint',         90, 'Minimal wear, tournament legal'),  
    ('LP',  'Lightly Played',    75, 'Minor wear, still attractive'),
    ('MP',  'Moderately Played', 60, 'Noticeable wear but structurally sound'),
    ('HP',  'Heavily Played',    40, 'Major wear, still playable'),  
    ('DMG', 'Damaged',           20, 'Severe wear, collectors only');

-- Populate vendor condition mappings
INSERT OR REPLACE INTO vendor_condition_map 
    (vendor, vendor_condition, code, is_graded, confidence) VALUES
    
    -- TCGPlayer standard conditions
    ('tcgplayer', 'Near Mint', 'NM', 0, 1.0),
    ('tcgplayer', 'Lightly Played', 'LP', 0, 1.0),
    ('tcgplayer', 'Moderately Played', 'MP', 0, 1.0),
    ('tcgplayer', 'Heavily Played', 'HP', 0, 1.0),
    ('tcgplayer', 'Damaged', 'DMG', 0, 1.0),
    
    -- PriceCharting conditions (mixed raw + graded)
    ('pricecharting', 'ungraded', 'NM', 0, 0.8),  -- Assume NM for ungraded
    ('pricecharting', 'PSA 9', NULL, 1, 1.0),     -- Graded conditions
    ('pricecharting', 'PSA 10', NULL, 1, 1.0),
    ('pricecharting', 'BGS 9.5', NULL, 1, 1.0),
    ('pricecharting', 'BGS 10', NULL, 1, 1.0),
    
    -- eBay conditions (approximate mappings)
    ('ebay', 'New', 'M', 0, 0.9),
    ('ebay', 'Like New', 'NM', 0, 0.8),
    ('ebay', 'Very Good', 'LP', 0, 0.7),
    ('ebay', 'Good', 'MP', 0, 0.6),
    ('ebay', 'Acceptable', 'HP', 0, 0.5);

-- Add graded condition mappings with grade ranges  
INSERT OR REPLACE INTO vendor_condition_map
    (vendor, vendor_condition, code, grade_min, grade_max, is_graded, confidence) VALUES
    ('pricecharting', 'PSA 9', NULL, 9.0, 9.0, 1, 1.0),
    ('pricecharting', 'PSA 10', NULL, 10.0, 10.0, 1, 1.0),
    ('pricecharting', 'BGS 9.5', NULL, 9.5, 9.5, 1, 1.0),
    ('pricecharting', 'BGS 10', NULL, 10.0, 10.0, 1, 1.0),
    ('generic', 'PSA 8', NULL, 8.0, 8.0, 1, 1.0),
    ('generic', 'PSA 9', NULL, 9.0, 9.0, 1, 1.0),
    ('generic', 'PSA 10', NULL, 10.0, 10.0, 1, 1.0),
    ('generic', 'BGS 9', NULL, 9.0, 9.0, 1, 1.0),
    ('generic', 'BGS 9.5', NULL, 9.5, 9.5, 1, 1.0),
    ('generic', 'BGS 10', NULL, 10.0, 10.0, 1, 1.0),
    ('generic', 'CGC 9', NULL, 9.0, 9.0, 1, 1.0),
    ('generic', 'CGC 9.5', NULL, 9.5, 9.5, 1, 1.0),
    ('generic', 'CGC 10', NULL, 10.0, 10.0, 1, 1.0);

-- ============================================================================
-- DEFERRED INDEXES (Created After Data Load for Performance)
-- ============================================================================
-- These indexes are expensive on large tables, so we create them last

-- Inventory performance indexes
CREATE INDEX IF NOT EXISTS idx_inventory_card_condition 
    ON inventory(card_id, condition_code) WHERE condition_code IS NOT NULL;
    
CREATE INDEX IF NOT EXISTS idx_inventory_card_graded
    ON inventory(card_id, grading_company, grade_numeric) WHERE grading_company IS NOT NULL;
    
CREATE INDEX IF NOT EXISTS idx_inventory_variant_key 
    ON inventory(variant_key);
    
CREATE INDEX IF NOT EXISTS idx_inventory_acquisition_date
    ON inventory(acquisition_date);

-- Market pricing indexes  
CREATE INDEX IF NOT EXISTS idx_market_prices_card_vendor
    ON market_price_samples(card_id, vendor, basis);
    
CREATE INDEX IF NOT EXISTS idx_market_prices_sampled_at
    ON market_price_samples(sampled_at DESC);

-- Vendor condition mapping index
CREATE INDEX IF NOT EXISTS idx_vendor_condition_lookup
    ON vendor_condition_map(vendor, vendor_condition);

-- ============================================================================
-- FOREIGN KEY CONSTRAINTS (Applied After All Tables Exist)
-- ============================================================================

-- We'll add these constraints via ALTER TABLE in a separate step
-- after confirming the cards table exists

-- ============================================================================
-- MIGRATION COMPLETION
-- ============================================================================

-- Update schema version (if tracking table exists)  
UPDATE schema_version SET version = 3, updated_at = datetime('now') 
    WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version');

COMMIT;
PRAGMA foreign_keys = ON;  -- Re-enable foreign keys

-- ============================================================================
-- POST-MIGRATION VALIDATION
-- ============================================================================

-- These queries will be run by the migration runner to validate success

-- PRAGMA table_info(inventory);
-- PRAGMA table_info(condition_scale);  
-- PRAGMA table_info(vendor_condition_map);
-- PRAGMA table_info(market_price_samples);

-- SELECT COUNT(*) FROM condition_scale; -- Should be 6
-- SELECT COUNT(*) FROM vendor_condition_map; -- Should be ~20

-- PRAGMA integrity_check;
-- PRAGMA foreign_key_check;