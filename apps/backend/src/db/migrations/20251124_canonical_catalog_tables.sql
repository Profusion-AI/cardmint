-- Canonical Catalog Tables Migration
-- Date: 2025-11-24
-- Purpose: Create tables for PPT-sourced canonical Pokemon TCG catalog
--
-- This replaces the need for fuzzy parse-title matching by storing
-- tcgPlayerId for each card, enabling deterministic lookups.
--
-- Solves: Team Rocket vs Team Rocket Returns disambiguation bug

-- ============================================================================
-- canonical_sets - All Pokemon TCG sets from PPT API
-- ============================================================================
CREATE TABLE IF NOT EXISTS canonical_sets (
  ppt_set_id TEXT PRIMARY KEY,           -- PPT MongoDB ObjectId (e.g., "68af47dd190c4823de25295f")
  tcg_player_id TEXT UNIQUE NOT NULL,    -- TCGPlayer slug (e.g., "team-rocket", "base-set")
  name TEXT NOT NULL,                     -- Display name (e.g., "Team Rocket")
  series TEXT,                            -- Series grouping (e.g., "Base", "Scarlet & Violet")
  release_date TEXT,                      -- ISO 8601 date string
  card_count INTEGER,                     -- Official card count for the set
  has_price_guide INTEGER DEFAULT 1,      -- Whether TCGPlayer has pricing
  image_url TEXT,                         -- Set logo/icon URL
  fetched_at INTEGER NOT NULL             -- Unix timestamp of fetch
);

CREATE INDEX IF NOT EXISTS idx_canonical_sets_name ON canonical_sets(name);
CREATE INDEX IF NOT EXISTS idx_canonical_sets_series ON canonical_sets(series);
CREATE INDEX IF NOT EXISTS idx_canonical_sets_release ON canonical_sets(release_date);

-- ============================================================================
-- canonical_cards - All Pokemon TCG cards from PPT API
-- ============================================================================
CREATE TABLE IF NOT EXISTS canonical_cards (
  ppt_card_id TEXT PRIMARY KEY,           -- PPT MongoDB ObjectId
  tcg_player_id TEXT UNIQUE NOT NULL,     -- TCGPlayer product ID (deterministic lookup key)
  set_tcg_player_id TEXT NOT NULL,        -- FK to canonical_sets.tcg_player_id
  name TEXT NOT NULL,                      -- Card name (e.g., "Dark Raichu")
  card_number TEXT,                        -- Set position (e.g., "83/82", "025")
  total_set_number TEXT,                   -- Total cards in set (e.g., "82")
  rarity TEXT,                             -- Rarity (e.g., "Secret Rare", "Holo Rare")
  card_type TEXT,                          -- Type (e.g., "Lightning", "Fire", "Trainer")
  hp INTEGER,                              -- HP value for Pokemon cards
  stage TEXT,                              -- Evolution stage (e.g., "Basic", "Stage 1")

  -- Pricing snapshot (Near Mint as primary reference)
  market_price REAL,                       -- Current market price (NM default)
  price_nm REAL,                           -- Near Mint price
  price_lp REAL,                           -- Lightly Played price
  price_mp REAL,                           -- Moderately Played price
  price_hp REAL,                           -- Heavily Played price
  price_dmg REAL,                          -- Damaged price

  -- Variant availability flags
  has_1st_edition INTEGER DEFAULT 0,
  has_unlimited INTEGER DEFAULT 0,
  has_reverse_holo INTEGER DEFAULT 0,
  has_holofoil INTEGER DEFAULT 0,

  -- Links and metadata
  tcg_player_url TEXT,                     -- Direct link to TCGPlayer listing
  fetched_at INTEGER NOT NULL,             -- Unix timestamp of fetch

  FOREIGN KEY (set_tcg_player_id) REFERENCES canonical_sets(tcg_player_id)
);

-- Primary lookup indexes
CREATE INDEX IF NOT EXISTS idx_canonical_cards_set ON canonical_cards(set_tcg_player_id);
CREATE INDEX IF NOT EXISTS idx_canonical_cards_name ON canonical_cards(name);
CREATE INDEX IF NOT EXISTS idx_canonical_cards_number ON canonical_cards(card_number);
CREATE INDEX IF NOT EXISTS idx_canonical_cards_tcgp ON canonical_cards(tcg_player_id);

-- Composite index for set+number lookups (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_canonical_cards_set_number ON canonical_cards(set_tcg_player_id, card_number);

-- FTS index for name searching (fallback when tcg_player_id not available)
CREATE VIRTUAL TABLE IF NOT EXISTS canonical_cards_fts USING fts5(
  name,
  card_number,
  set_tcg_player_id,
  content='canonical_cards',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS canonical_cards_ai AFTER INSERT ON canonical_cards BEGIN
  INSERT INTO canonical_cards_fts(rowid, name, card_number, set_tcg_player_id)
  VALUES (NEW.rowid, NEW.name, NEW.card_number, NEW.set_tcg_player_id);
END;

CREATE TRIGGER IF NOT EXISTS canonical_cards_ad AFTER DELETE ON canonical_cards BEGIN
  INSERT INTO canonical_cards_fts(canonical_cards_fts, rowid, name, card_number, set_tcg_player_id)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.card_number, OLD.set_tcg_player_id);
END;

CREATE TRIGGER IF NOT EXISTS canonical_cards_au AFTER UPDATE ON canonical_cards BEGIN
  INSERT INTO canonical_cards_fts(canonical_cards_fts, rowid, name, card_number, set_tcg_player_id)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.card_number, OLD.set_tcg_player_id);
  INSERT INTO canonical_cards_fts(rowid, name, card_number, set_tcg_player_id)
  VALUES (NEW.rowid, NEW.name, NEW.card_number, NEW.set_tcg_player_id);
END;

-- ============================================================================
-- canonical_catalog_meta - Tracks catalog build state for resumability
-- ============================================================================
CREATE TABLE IF NOT EXISTS canonical_catalog_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Insert initial metadata
INSERT OR IGNORE INTO canonical_catalog_meta (key, value, updated_at)
VALUES
  ('version', '1.0.0', strftime('%s', 'now')),
  ('last_full_build', '', strftime('%s', 'now')),
  ('sets_fetched', '0', strftime('%s', 'now')),
  ('cards_fetched', '0', strftime('%s', 'now'));
