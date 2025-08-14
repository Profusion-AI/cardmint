-- Enhanced Pokemon Card Database Schema for CardMint
-- Supports comprehensive card data, pricing, and inventory management

BEGIN;

-- Drop existing tables if doing a fresh migration (be careful in production!)
-- DROP TABLE IF EXISTS card_prices CASCADE;
-- DROP TABLE IF EXISTS card_images CASCADE;
-- DROP TABLE IF EXISTS card_validation CASCADE;
-- DROP TABLE IF EXISTS inventory_tracking CASCADE;
-- DROP TABLE IF EXISTS pokemon_cards CASCADE;

-- Main Pokemon Cards table with comprehensive fields
CREATE TABLE IF NOT EXISTS pokemon_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Card Identity
  card_name VARCHAR(255) NOT NULL,
  set_name VARCHAR(255) NOT NULL,
  set_code VARCHAR(50),
  card_number VARCHAR(20) NOT NULL,
  set_total INTEGER,
  rarity VARCHAR(50),
  regulation_mark VARCHAR(10),
  
  -- Pokemon-specific fields
  hp INTEGER,
  pokemon_types TEXT[], -- Array of types (Fire, Water, etc.)
  stage VARCHAR(50), -- Basic, Stage 1, Stage 2, VMAX, etc.
  evolves_from VARCHAR(255),
  evolves_to TEXT[], -- Array of evolution possibilities
  pokedex_number INTEGER,
  
  -- Game mechanics
  attacks JSONB, -- Array of attack objects with name, damage, cost, effect
  abilities JSONB, -- Array of ability objects with name, effect, type
  weakness JSONB, -- Type and multiplier
  resistance JSONB, -- Type and value
  retreat_cost INTEGER,
  
  -- Visual characteristics
  is_first_edition BOOLEAN DEFAULT FALSE,
  is_shadowless BOOLEAN DEFAULT FALSE,
  is_holo BOOLEAN DEFAULT FALSE,
  is_reverse_holo BOOLEAN DEFAULT FALSE,
  is_promo BOOLEAN DEFAULT FALSE,
  is_full_art BOOLEAN DEFAULT FALSE,
  is_secret_rare BOOLEAN DEFAULT FALSE,
  variant_type VARCHAR(50), -- e.g., 'alternate_art', 'gold_star'
  
  -- Artist and flavor
  illustrator VARCHAR(255),
  flavor_text TEXT,
  
  -- API identifiers
  pokemontcg_id VARCHAR(100) UNIQUE,
  pricecharting_id INTEGER,
  tcgplayer_id VARCHAR(100),
  cardmarket_id VARCHAR(100),
  
  -- OCR and validation
  ocr_confidence DECIMAL(3,2), -- 0.00 to 1.00
  needs_review BOOLEAN DEFAULT FALSE,
  review_reasons TEXT[],
  last_validated_at TIMESTAMPTZ,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  
  -- Metadata
  metadata JSONB DEFAULT '{}',
  processing_notes TEXT,
  
  CONSTRAINT valid_confidence CHECK (ocr_confidence >= 0 AND ocr_confidence <= 1)
);

-- Card Images table for multiple image versions
CREATE TABLE IF NOT EXISTS card_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES pokemon_cards(id) ON DELETE CASCADE,
  image_type VARCHAR(50) NOT NULL, -- 'captured', 'official_large', 'official_small', 'processed'
  image_url VARCHAR(512),
  image_path VARCHAR(512),
  image_hash VARCHAR(64), -- For duplicate detection
  width INTEGER,
  height INTEGER,
  file_size_bytes INTEGER,
  quality_score DECIMAL(3,2),
  is_primary BOOLEAN DEFAULT FALSE,
  captured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  CONSTRAINT unique_primary_per_card UNIQUE (card_id, image_type, is_primary)
);

-- Pricing data table with multi-source support
CREATE TABLE IF NOT EXISTS card_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES pokemon_cards(id) ON DELETE CASCADE,
  source VARCHAR(50) NOT NULL, -- 'tcgplayer', 'pricecharting', 'cardmarket'
  condition VARCHAR(50) DEFAULT 'near_mint', -- near_mint, lightly_played, etc.
  
  -- Price points in cents (multiply dollars by 100)
  market_price INTEGER,
  low_price INTEGER,
  mid_price INTEGER,
  high_price INTEGER,
  direct_low_price INTEGER,
  
  -- Graded prices (PriceCharting specific)
  psa9_price INTEGER,
  psa10_price INTEGER,
  bgs9_price INTEGER,
  bgs10_price INTEGER,
  cgc9_price INTEGER,
  cgc10_price INTEGER,
  
  -- Market trends
  price_trend VARCHAR(20), -- 'rising', 'falling', 'stable'
  percent_change_24h DECIMAL(5,2),
  percent_change_7d DECIMAL(5,2),
  percent_change_30d DECIMAL(5,2),
  
  -- Metadata
  currency VARCHAR(3) DEFAULT 'USD',
  last_updated_at TIMESTAMPTZ NOT NULL,
  source_url VARCHAR(512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Ensure we only have one price per source/condition combo
  CONSTRAINT unique_price_per_source UNIQUE (card_id, source, condition, last_updated_at)
);

-- Visual validation and comparison results
CREATE TABLE IF NOT EXISTS card_validation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES pokemon_cards(id) ON DELETE CASCADE,
  validation_type VARCHAR(50) NOT NULL, -- 'ocr', 'image', 'api', 'manual'
  
  -- Validation scores
  structural_similarity DECIMAL(3,2), -- SSIM score
  perceptual_hash_similarity DECIMAL(3,2),
  histogram_similarity DECIMAL(3,2),
  feature_match_score DECIMAL(3,2),
  overall_similarity DECIMAL(3,2),
  
  -- OCR validation
  ocr_field_scores JSONB, -- Per-field confidence scores
  ocr_discrepancies TEXT[],
  
  -- API validation
  api_match_confidence DECIMAL(3,2),
  api_discrepancies TEXT[],
  matched_api_id VARCHAR(100),
  
  -- Quality metrics
  image_quality_score DECIMAL(3,2),
  brightness_score DECIMAL(3,2),
  contrast_score DECIMAL(3,2),
  sharpness_score DECIMAL(3,2),
  
  -- Results
  is_valid BOOLEAN DEFAULT FALSE,
  validation_notes TEXT,
  validated_by VARCHAR(100), -- User or system that validated
  validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Inventory tracking table
CREATE TABLE IF NOT EXISTS inventory_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES pokemon_cards(id) ON DELETE CASCADE,
  
  -- Quantities
  quantity_owned INTEGER DEFAULT 0,
  quantity_for_sale INTEGER DEFAULT 0,
  quantity_for_trade INTEGER DEFAULT 0,
  
  -- Physical location
  storage_location VARCHAR(255),
  box_number VARCHAR(50),
  sleeve_type VARCHAR(50),
  
  -- Condition tracking
  condition VARCHAR(50) DEFAULT 'near_mint',
  condition_notes TEXT,
  grading_company VARCHAR(50), -- PSA, BGS, CGC
  grade_value DECIMAL(3,1),
  cert_number VARCHAR(100),
  
  -- Purchase/acquisition info
  purchase_price INTEGER, -- in cents
  purchase_date DATE,
  purchase_source VARCHAR(255),
  
  -- Sales info
  listing_price INTEGER, -- in cents
  listed_date DATE,
  sold_price INTEGER, -- in cents
  sold_date DATE,
  buyer_info VARCHAR(255),
  
  -- Metadata
  notes TEXT,
  tags TEXT[],
  is_favorite BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Processing queue specifically for Pokemon cards
CREATE TABLE IF NOT EXISTS pokemon_processing_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID REFERENCES pokemon_cards(id) ON DELETE CASCADE,
  
  -- Processing stages
  stage VARCHAR(50) NOT NULL, -- 'capture', 'ocr', 'api_match', 'price_lookup', 'validation'
  status VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
  priority INTEGER DEFAULT 0,
  
  -- Retry logic
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  retry_after TIMESTAMPTZ,
  
  -- Timing
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  
  -- Results and errors
  result JSONB,
  error_message TEXT,
  error_details JSONB
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_pokemon_cards_name ON pokemon_cards(card_name);
CREATE INDEX IF NOT EXISTS idx_pokemon_cards_set ON pokemon_cards(set_name, card_number);
CREATE INDEX IF NOT EXISTS idx_pokemon_cards_pokemontcg_id ON pokemon_cards(pokemontcg_id);
CREATE INDEX IF NOT EXISTS idx_pokemon_cards_needs_review ON pokemon_cards(needs_review) WHERE needs_review = TRUE;
CREATE INDEX IF NOT EXISTS idx_pokemon_cards_rarity ON pokemon_cards(rarity);
CREATE INDEX IF NOT EXISTS idx_pokemon_cards_types ON pokemon_cards USING GIN(pokemon_types);
CREATE INDEX IF NOT EXISTS idx_pokemon_cards_metadata ON pokemon_cards USING GIN(metadata);

CREATE INDEX IF NOT EXISTS idx_card_images_card_id ON card_images(card_id);
CREATE INDEX IF NOT EXISTS idx_card_images_type ON card_images(image_type);
CREATE INDEX IF NOT EXISTS idx_card_images_hash ON card_images(image_hash);

CREATE INDEX IF NOT EXISTS idx_card_prices_card_id ON card_prices(card_id);
CREATE INDEX IF NOT EXISTS idx_card_prices_source ON card_prices(source);
CREATE INDEX IF NOT EXISTS idx_card_prices_updated ON card_prices(last_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_card_validation_card_id ON card_validation(card_id);
CREATE INDEX IF NOT EXISTS idx_card_validation_type ON card_validation(validation_type);

CREATE INDEX IF NOT EXISTS idx_inventory_card_id ON inventory_tracking(card_id);
CREATE INDEX IF NOT EXISTS idx_inventory_condition ON inventory_tracking(condition);
CREATE INDEX IF NOT EXISTS idx_inventory_location ON inventory_tracking(storage_location);

CREATE INDEX IF NOT EXISTS idx_processing_queue_status ON pokemon_processing_queue(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_processing_queue_stage ON pokemon_processing_queue(stage, status);

-- Create update trigger for updated_at columns
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to tables with updated_at
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_pokemon_cards_updated_at') THEN
    CREATE TRIGGER update_pokemon_cards_updated_at 
    BEFORE UPDATE ON pokemon_cards 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_inventory_tracking_updated_at') THEN
    CREATE TRIGGER update_inventory_tracking_updated_at 
    BEFORE UPDATE ON inventory_tracking 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- Create view for card overview with latest prices
CREATE OR REPLACE VIEW card_overview AS
SELECT 
  pc.*,
  -- Latest prices from each source
  tcp.market_price as tcgplayer_market,
  tcp.low_price as tcgplayer_low,
  pcp.market_price as pricecharting_market,
  pcp.psa10_price as pricecharting_psa10,
  -- Primary image
  ci.image_url as primary_image_url,
  -- Inventory info
  it.quantity_owned,
  it.condition,
  it.storage_location,
  -- Validation status
  cv.overall_similarity as validation_score,
  cv.is_valid as is_validated
FROM pokemon_cards pc
LEFT JOIN LATERAL (
  SELECT * FROM card_prices 
  WHERE card_id = pc.id AND source = 'tcgplayer'
  ORDER BY last_updated_at DESC 
  LIMIT 1
) tcp ON true
LEFT JOIN LATERAL (
  SELECT * FROM card_prices 
  WHERE card_id = pc.id AND source = 'pricecharting'
  ORDER BY last_updated_at DESC 
  LIMIT 1
) pcp ON true
LEFT JOIN LATERAL (
  SELECT * FROM card_images
  WHERE card_id = pc.id AND is_primary = true
  LIMIT 1
) ci ON true
LEFT JOIN inventory_tracking it ON it.card_id = pc.id
LEFT JOIN LATERAL (
  SELECT * FROM card_validation
  WHERE card_id = pc.id
  ORDER BY validated_at DESC
  LIMIT 1
) cv ON true;

-- Create materialized view for collection statistics
CREATE MATERIALIZED VIEW IF NOT EXISTS collection_stats AS
SELECT 
  COUNT(DISTINCT pc.id) as total_cards,
  COUNT(DISTINCT pc.set_name) as total_sets,
  COUNT(DISTINCT pc.illustrator) as total_artists,
  SUM(it.quantity_owned) as total_quantity,
  SUM(it.quantity_owned * COALESCE(cp.market_price, 0)) / 100.0 as total_value_usd,
  COUNT(CASE WHEN pc.is_first_edition THEN 1 END) as first_edition_count,
  COUNT(CASE WHEN pc.is_holo THEN 1 END) as holo_count,
  COUNT(CASE WHEN pc.rarity = 'Secret Rare' THEN 1 END) as secret_rare_count,
  COUNT(CASE WHEN it.grading_company IS NOT NULL THEN 1 END) as graded_count,
  AVG(pc.ocr_confidence) as avg_ocr_confidence,
  COUNT(CASE WHEN pc.needs_review THEN 1 END) as needs_review_count
FROM pokemon_cards pc
LEFT JOIN inventory_tracking it ON it.card_id = pc.id
LEFT JOIN LATERAL (
  SELECT market_price FROM card_prices 
  WHERE card_id = pc.id 
  ORDER BY last_updated_at DESC 
  LIMIT 1
) cp ON true;

-- Function to calculate collection value
CREATE OR REPLACE FUNCTION calculate_collection_value(
  p_condition VARCHAR DEFAULT NULL,
  p_source VARCHAR DEFAULT 'tcgplayer'
) RETURNS TABLE (
  total_value NUMERIC,
  card_count INTEGER,
  avg_card_value NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    SUM(it.quantity_owned * COALESCE(cp.market_price, 0)) / 100.0 as total_value,
    COUNT(DISTINCT pc.id)::INTEGER as card_count,
    AVG(COALESCE(cp.market_price, 0)) / 100.0 as avg_card_value
  FROM pokemon_cards pc
  JOIN inventory_tracking it ON it.card_id = pc.id
  LEFT JOIN LATERAL (
    SELECT market_price 
    FROM card_prices 
    WHERE card_id = pc.id 
      AND source = p_source
      AND (p_condition IS NULL OR condition = p_condition)
    ORDER BY last_updated_at DESC 
    LIMIT 1
  ) cp ON true
  WHERE it.quantity_owned > 0;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO cardmint;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO cardmint;

COMMIT;

-- Sample data for testing (commented out, uncomment to use)
/*
INSERT INTO pokemon_cards (
  card_name, set_name, set_code, card_number, rarity, hp, 
  pokemon_types, stage, is_holo, pokemontcg_id
) VALUES 
  ('Pikachu', 'McDonald''s Promos 2019', 'MCD19', '12', 'Promo', 60, 
   ARRAY['Lightning'], 'Basic', false, 'mcd19-12'),
  ('Bulbasaur', 'McDonald''s Promos 2019', 'MCD19', '1', 'Promo', 60,
   ARRAY['Grass'], 'Basic', false, 'mcd19-1');
*/