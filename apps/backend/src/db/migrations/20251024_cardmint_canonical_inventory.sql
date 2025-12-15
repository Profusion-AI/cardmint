-- Migration: CardMint Canonical Inventory System (Phase 1.1)
-- Date: 2025-10-24
-- Purpose: Establish authoritative CardMint identity for sets and cards with external catalog bridges
-- Reference: docs/MANIFEST_SKU_BEHAVIOR_ANALYSIS.md (lines 279-281, 349-352)
-- Acceptance: SKU formation uses CardMint IDs only, never external IDs

PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;

-- =============================================================================
-- CardMint Canonical Sets (Source of Truth)
-- =============================================================================

-- cm_sets: CardMint canonical set definitions
-- Each set has a unique cm_set_id used in SKU formation: PKM:{cm_set_id}:...
CREATE TABLE IF NOT EXISTS cm_sets (
  cm_set_id TEXT PRIMARY KEY,
  -- CardMint canonical set identifier (e.g., "SV04" for Paradox Rift)
  -- Used in SKU: PKM:{cm_set_id}:{collector_no}:{variant}:{lang}

  set_name TEXT NOT NULL,
  -- Full set name (e.g., "Scarlet & Violet—Paradox Rift")

  release_date TEXT,
  -- ISO 8601 date (YYYY-MM-DD)

  release_year INTEGER,
  -- Extracted year for range queries

  total_cards INTEGER,
  -- Total card count including secret rares

  series TEXT,
  -- Series grouping (e.g., "Scarlet & Violet", "Sword & Shield")

  ptcgo_code TEXT,
  -- Pokemon Trading Card Game Online set code (if applicable)

  notes TEXT,
  -- Operator notes or special handling instructions

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cm_sets_release_year ON cm_sets(release_year);
CREATE INDEX IF NOT EXISTS idx_cm_sets_series ON cm_sets(series);
CREATE INDEX IF NOT EXISTS idx_cm_sets_ptcgo_code ON cm_sets(ptcgo_code);

-- =============================================================================
-- CardMint Canonical Cards (Unique Card Variants)
-- =============================================================================

-- cm_cards: CardMint canonical card definitions
-- Each card represents a unique variant (holo vs non-holo, different artwork, etc.)
CREATE TABLE IF NOT EXISTS cm_cards (
  cm_card_id TEXT PRIMARY KEY,
  -- CardMint canonical card identifier (format: {cm_set_id}-{collector_no}-{variant_suffix})
  -- Example: "SV04-177-a" for Morgrem base variant, "SV04-177-holo" for holo variant

  cm_set_id TEXT NOT NULL,
  -- Foreign key to cm_sets

  collector_no TEXT NOT NULL,
  -- Collector number as printed on card (e.g., "177", "177/264")

  card_name TEXT NOT NULL,
  -- Canonical card name (e.g., "Morgrem")

  hp_value INTEGER,
  -- HP value (null for Trainer/Energy cards)

  card_type TEXT,
  -- Card type: Pokemon, Trainer, Energy, Special Energy

  rarity TEXT,
  -- Rarity code: Common, Uncommon, Rare, Ultra Rare, Secret Rare, etc.

  variant_bits TEXT,
  -- Variant encoding: holo, reverse-holo, full-art, alt-art, etc.
  -- Format: comma-separated flags aligned with reranker logic
  -- Examples: "holo", "reverse-holo", "full-art,holo", "base"

  lang TEXT NOT NULL DEFAULT 'EN',
  -- Language code: EN, JP, FR, DE, ES, IT, etc.

  artist TEXT,
  -- Card artist name

  notes TEXT,
  -- Operator notes or special handling

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (cm_set_id) REFERENCES cm_sets(cm_set_id) ON DELETE CASCADE
);

-- Enforce unique (set, collector_no, variant_bits, lang) per card identity
CREATE UNIQUE INDEX IF NOT EXISTS idx_cm_cards_identity
  ON cm_cards(cm_set_id, collector_no, variant_bits, lang);

CREATE INDEX IF NOT EXISTS idx_cm_cards_set_id ON cm_cards(cm_set_id);
CREATE INDEX IF NOT EXISTS idx_cm_cards_card_name ON cm_cards(card_name);
CREATE INDEX IF NOT EXISTS idx_cm_cards_rarity ON cm_cards(rarity);

-- FTS5 index for card name search
CREATE VIRTUAL TABLE IF NOT EXISTS cm_cards_fts
  USING fts5(card_name, content='cm_cards', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS cm_cards_ai
AFTER INSERT ON cm_cards BEGIN
  INSERT INTO cm_cards_fts(rowid, card_name)
    VALUES (new.rowid, new.card_name);
END;

CREATE TRIGGER IF NOT EXISTS cm_cards_ad
AFTER DELETE ON cm_cards BEGIN
  INSERT INTO cm_cards_fts(cm_cards_fts, rowid, card_name)
    VALUES('delete', old.rowid, old.card_name);
END;

CREATE TRIGGER IF NOT EXISTS cm_cards_au
AFTER UPDATE ON cm_cards BEGIN
  INSERT INTO cm_cards_fts(cm_cards_fts, rowid, card_name)
    VALUES('delete', old.rowid, old.card_name);
  INSERT INTO cm_cards_fts(rowid, card_name)
    VALUES (new.rowid, new.card_name);
END;

-- =============================================================================
-- External Catalog Bridge: PriceCharting
-- =============================================================================

-- cm_pricecharting_bridge: Links CardMint cards to PriceCharting catalog
CREATE TABLE IF NOT EXISTS cm_pricecharting_bridge (
  cm_card_id TEXT NOT NULL,
  -- CardMint canonical card ID

  pricecharting_id TEXT NOT NULL,
  -- PriceCharting product ID (from data/pricecharting-pokemon-cards.csv)

  confidence REAL NOT NULL DEFAULT 1.0,
  -- Mapping confidence (1.0 = exact match, <1.0 = fuzzy/operator override)

  match_method TEXT NOT NULL,
  -- How mapping was created: "exact", "fuzzy", "operator", "backfill"

  verified_at INTEGER,
  -- Timestamp when operator verified this mapping (null = unverified)

  verified_by TEXT,
  -- Operator ID who verified mapping

  notes TEXT,
  -- Operator notes on mapping quality or edge cases

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (cm_card_id, pricecharting_id),
  FOREIGN KEY (cm_card_id) REFERENCES cm_cards(cm_card_id) ON DELETE CASCADE,
  FOREIGN KEY (pricecharting_id) REFERENCES pricecharting_cards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cm_pricecharting_cm_card ON cm_pricecharting_bridge(cm_card_id);
CREATE INDEX IF NOT EXISTS idx_cm_pricecharting_pc_id ON cm_pricecharting_bridge(pricecharting_id);
CREATE INDEX IF NOT EXISTS idx_cm_pricecharting_confidence ON cm_pricecharting_bridge(confidence);

-- =============================================================================
-- External Catalog Bridge: TCGPlayer (Future)
-- =============================================================================

-- cm_tcgplayer_bridge: Links CardMint cards to TCGPlayer catalog
-- Schema designed for future integration, not populated in Phase 1
CREATE TABLE IF NOT EXISTS cm_tcgplayer_bridge (
  cm_card_id TEXT NOT NULL,
  -- CardMint canonical card ID

  tcgplayer_id TEXT NOT NULL,
  -- TCGPlayer product ID

  tcgplayer_sku TEXT,
  -- TCGPlayer SKU if available

  confidence REAL NOT NULL DEFAULT 1.0,
  -- Mapping confidence

  match_method TEXT NOT NULL,
  -- How mapping was created

  verified_at INTEGER,
  -- Verification timestamp

  verified_by TEXT,
  -- Operator ID

  notes TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (cm_card_id, tcgplayer_id),
  FOREIGN KEY (cm_card_id) REFERENCES cm_cards(cm_card_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cm_tcgplayer_cm_card ON cm_tcgplayer_bridge(cm_card_id);
CREATE INDEX IF NOT EXISTS idx_cm_tcgplayer_tc_id ON cm_tcgplayer_bridge(tcgplayer_id);
CREATE INDEX IF NOT EXISTS idx_cm_tcgplayer_confidence ON cm_tcgplayer_bridge(confidence);

-- =============================================================================
-- Migration Metadata
-- =============================================================================

-- Note: cm_sets, cm_cards, and bridge tables already exist in production database
-- This migration is preserved for documentation and new environment setup
