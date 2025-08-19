-- Migration: Add known Pokemon cards reference table for VLM validation
-- Purpose: Store TheFusion21/PokemonCards dataset for improved accuracy
-- Date: 2025-08-19

-- Table to store known Pokemon cards from HuggingFace dataset
CREATE TABLE IF NOT EXISTS known_pokemon_cards (
    id VARCHAR(50) PRIMARY KEY,           -- Card ID from dataset (e.g., "pl3-1")
    name VARCHAR(255) NOT NULL,           -- Pokemon name
    hp INTEGER,                           -- Hit points
    set_name VARCHAR(255),                -- Card set name
    caption TEXT,                         -- Full card description
    image_url TEXT,                       -- Reference image URL
    
    -- Enhanced metadata for matching
    card_number VARCHAR(20),              -- Extracted card number
    has_attacks BOOLEAN DEFAULT false,    -- Has attack moves
    has_ability BOOLEAN DEFAULT false,    -- Has special ability
    is_ex BOOLEAN DEFAULT false,          -- Is EX card
    is_gx BOOLEAN DEFAULT false,          -- Is GX card
    is_vmax BOOLEAN DEFAULT false,        -- Is VMAX card
    is_vstar BOOLEAN DEFAULT false,       -- Is VSTAR card
    rarity VARCHAR(50),                   -- Card rarity level
    
    -- Embedding for similarity search (768 dimensions for BERT-like models)
    embedding VECTOR(768),                -- Vector embedding for similarity
    
    -- Fuzzy matching support
    name_normalized VARCHAR(255),         -- Lowercase, no special chars
    name_soundex VARCHAR(10),             -- Soundex for phonetic matching
    
    -- Statistics for confidence scoring
    match_count INTEGER DEFAULT 0,        -- Times matched in production
    last_matched TIMESTAMP,               -- Last match timestamp
    confidence_boost FLOAT DEFAULT 0.0,   -- Confidence adjustment factor
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Indexes for performance
    INDEX idx_name (name),
    INDEX idx_normalized (name_normalized),
    INDEX idx_set_name (set_name),
    INDEX idx_card_number (card_number),
    INDEX idx_special_cards (is_ex, is_gx, is_vmax, is_vstar),
    INDEX idx_match_count (match_count DESC)
);

-- Table for card name variations and aliases
CREATE TABLE IF NOT EXISTS card_name_aliases (
    id SERIAL PRIMARY KEY,
    card_id VARCHAR(50) NOT NULL,
    alias VARCHAR(255) NOT NULL,
    alias_type VARCHAR(50),              -- 'alternate', 'nickname', 'typo', etc.
    confidence FLOAT DEFAULT 1.0,
    
    FOREIGN KEY (card_id) REFERENCES known_pokemon_cards(id) ON DELETE CASCADE,
    INDEX idx_alias (alias),
    UNIQUE KEY unique_alias (card_id, alias)
);

-- Table for caching validation results
CREATE TABLE IF NOT EXISTS validation_cache (
    id SERIAL PRIMARY KEY,
    input_hash VARCHAR(64) NOT NULL,      -- Hash of input image/text
    matched_card_id VARCHAR(50),          -- Matched known card
    confidence FLOAT NOT NULL,
    match_type VARCHAR(50),               -- 'exact', 'fuzzy', 'similarity', 'none'
    processing_time_ms INTEGER,
    
    -- Cache metadata
    hit_count INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (matched_card_id) REFERENCES known_pokemon_cards(id) ON DELETE SET NULL,
    INDEX idx_input_hash (input_hash),
    INDEX idx_last_accessed (last_accessed DESC)
);

-- Performance statistics table
CREATE TABLE IF NOT EXISTS dataset_performance_metrics (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    total_validations INTEGER DEFAULT 0,
    exact_matches INTEGER DEFAULT 0,
    fuzzy_matches INTEGER DEFAULT 0,
    similarity_matches INTEGER DEFAULT 0,
    no_matches INTEGER DEFAULT 0,
    cache_hits INTEGER DEFAULT 0,
    avg_confidence FLOAT,
    avg_processing_time_ms FLOAT,
    
    -- A/B testing metrics
    vlm_only_accuracy FLOAT,
    vlm_with_dataset_accuracy FLOAT,
    improvement_percentage FLOAT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_date (date)
);

-- Function to normalize card names for matching
CREATE OR REPLACE FUNCTION normalize_card_name(input_name VARCHAR(255))
RETURNS VARCHAR(255)
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT LOWER(
        REGEXP_REPLACE(
            REGEXP_REPLACE(
                REGEXP_REPLACE(input_name, '[^a-zA-Z0-9\s]', ''),  -- Remove special chars
                '\s+', ' '                                          -- Normalize spaces
            ),
            '^\s+|\s+$', ''                                        -- Trim
        )
    );
$$;

-- Function to calculate match confidence
CREATE OR REPLACE FUNCTION calculate_match_confidence(
    exact_match BOOLEAN,
    fuzzy_score FLOAT,
    similarity_score FLOAT,
    match_count INTEGER
)
RETURNS FLOAT
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT CASE
        WHEN exact_match THEN 0.95 + LEAST(match_count * 0.001, 0.04)  -- 95-99% for exact
        WHEN fuzzy_score > 0.9 THEN 0.85 + fuzzy_score * 0.05          -- 85-90% for fuzzy
        WHEN similarity_score > 0.85 THEN 0.70 + similarity_score * 0.15 -- 70-85% for similar
        ELSE similarity_score * 0.70                                     -- Up to 70% otherwise
    END;
$$;

-- Trigger to update normalized name and soundex
CREATE OR REPLACE FUNCTION update_normalized_fields()
RETURNS TRIGGER AS $$
BEGIN
    NEW.name_normalized = normalize_card_name(NEW.name);
    NEW.name_soundex = SOUNDEX(NEW.name);
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_normalized
    BEFORE INSERT OR UPDATE OF name ON known_pokemon_cards
    FOR EACH ROW
    EXECUTE FUNCTION update_normalized_fields();

-- Trigger to update cache statistics
CREATE OR REPLACE FUNCTION update_cache_stats()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        NEW.hit_count = OLD.hit_count + 1;
        NEW.last_accessed = CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_cache_stats
    BEFORE UPDATE ON validation_cache
    FOR EACH ROW
    EXECUTE FUNCTION update_cache_stats();

-- Sample query to find best match for a card
-- This would be used in the validation service
/*
WITH input AS (
    SELECT 'Pikachu VMAX' as search_name
),
exact_match AS (
    SELECT id, name, 1.0 as score, 'exact' as match_type
    FROM known_pokemon_cards
    WHERE name = (SELECT search_name FROM input)
    LIMIT 1
),
fuzzy_match AS (
    SELECT id, name, 
           similarity(name, (SELECT search_name FROM input)) as score,
           'fuzzy' as match_type
    FROM known_pokemon_cards
    WHERE name % (SELECT search_name FROM input)  -- PostgreSQL fuzzy match operator
    ORDER BY score DESC
    LIMIT 1
),
normalized_match AS (
    SELECT id, name,
           0.9 as score,
           'normalized' as match_type
    FROM known_pokemon_cards
    WHERE name_normalized = normalize_card_name((SELECT search_name FROM input))
    LIMIT 1
)
SELECT * FROM exact_match
UNION ALL
SELECT * FROM fuzzy_match WHERE NOT EXISTS (SELECT 1 FROM exact_match)
UNION ALL  
SELECT * FROM normalized_match 
WHERE NOT EXISTS (SELECT 1 FROM exact_match)
  AND NOT EXISTS (SELECT 1 FROM fuzzy_match)
ORDER BY score DESC
LIMIT 1;
*/

-- Add comments for documentation
COMMENT ON TABLE known_pokemon_cards IS 'Reference table of 13,139 known Pokemon cards from TheFusion21 dataset for VLM validation';
COMMENT ON TABLE card_name_aliases IS 'Alternative names and common misspellings for Pokemon cards';
COMMENT ON TABLE validation_cache IS 'Cache of VLM validation results against known cards dataset';
COMMENT ON TABLE dataset_performance_metrics IS 'Daily metrics tracking improvement from dataset integration';

COMMENT ON COLUMN known_pokemon_cards.embedding IS 'Vector embedding for similarity search using pgvector extension';
COMMENT ON COLUMN known_pokemon_cards.confidence_boost IS 'Learned confidence adjustment based on historical accuracy';
COMMENT ON COLUMN validation_cache.match_type IS 'Type of match: exact, fuzzy, similarity, or none';

-- Grant permissions
GRANT SELECT ON known_pokemon_cards TO cardmint_app;
GRANT SELECT, INSERT, UPDATE ON validation_cache TO cardmint_app;
GRANT SELECT, INSERT ON dataset_performance_metrics TO cardmint_app;
GRANT SELECT, INSERT ON card_name_aliases TO cardmint_app;