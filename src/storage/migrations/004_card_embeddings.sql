-- Migration: Add card embeddings table for ML ensemble
-- Supports both lightweight (MobileNet) and future heavy models (TripletResNet101)
-- Date: 2025-08-18

-- Enable pgvector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Create embeddings table with support for multiple models
CREATE TABLE IF NOT EXISTS card_embeddings (
    id SERIAL PRIMARY KEY,
    card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
    
    -- Model information
    model_type VARCHAR(50) NOT NULL, -- 'mobilenet', 'triplet_resnet', 'vit', 'orb'
    model_version VARCHAR(20) DEFAULT '1.0.0',
    
    -- Embedding data
    embedding_dimension INTEGER NOT NULL, -- 576 for MobileNet, 2048 for ResNet
    embedding vector, -- Variable dimension vector
    
    -- Confidence and metadata
    confidence FLOAT DEFAULT 0.0,
    inference_time_ms FLOAT,
    
    -- Image hash for deduplication
    image_hash VARCHAR(64),
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT unique_card_model UNIQUE(card_id, model_type, model_version),
    CONSTRAINT valid_confidence CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT valid_model_type CHECK (model_type IN ('mobilenet', 'triplet_resnet', 'vit', 'orb', 'ensemble'))
);

-- Indexes for fast similarity search
CREATE INDEX idx_embeddings_card_id ON card_embeddings(card_id);
CREATE INDEX idx_embeddings_model_type ON card_embeddings(model_type);
CREATE INDEX idx_embeddings_image_hash ON card_embeddings(image_hash);
CREATE INDEX idx_embeddings_created_at ON card_embeddings(created_at DESC);

-- Index for vector similarity search (using IVFFlat for large datasets)
-- We'll create separate indexes for different embedding dimensions
-- MobileNet embeddings (576 dimensions)
CREATE INDEX idx_mobilenet_embedding ON card_embeddings 
USING ivfflat (embedding vector_cosine_ops)
WHERE model_type = 'mobilenet' AND embedding_dimension = 576;

-- Future: TripletResNet embeddings (2048 dimensions)
-- Commented out until we actually use it
-- CREATE INDEX idx_triplet_embedding ON card_embeddings 
-- USING ivfflat (embedding vector_cosine_ops)
-- WHERE model_type = 'triplet_resnet' AND embedding_dimension = 2048;

-- ORB keypoints storage (stores serialized keypoints, not vectors)
CREATE TABLE IF NOT EXISTS card_keypoints (
    id SERIAL PRIMARY KEY,
    card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
    
    -- ORB specific data
    num_keypoints INTEGER,
    keypoints_data BYTEA, -- Serialized keypoint data
    descriptors_data BYTEA, -- Serialized descriptor data
    
    -- Metadata
    extraction_time_ms FLOAT,
    image_hash VARCHAR(64),
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT unique_card_keypoints UNIQUE(card_id)
);

-- Index for keypoint lookups
CREATE INDEX idx_keypoints_card_id ON card_keypoints(card_id);
CREATE INDEX idx_keypoints_image_hash ON card_keypoints(image_hash);

-- Cache table for ensemble predictions
CREATE TABLE IF NOT EXISTS prediction_cache (
    id SERIAL PRIMARY KEY,
    
    -- Image identification
    image_hash VARCHAR(64) UNIQUE NOT NULL,
    
    -- Prediction results
    card_id INTEGER REFERENCES cards(id),
    card_name VARCHAR(255),
    set_name VARCHAR(255),
    card_number VARCHAR(20),
    rarity VARCHAR(50),
    
    -- Confidence scores
    ensemble_confidence FLOAT,
    mobilenet_confidence FLOAT,
    orb_confidence FLOAT,
    ocr_confidence FLOAT,
    
    -- Performance metrics
    total_inference_ms FLOAT,
    models_used TEXT[], -- Array of model types used
    
    -- Cache metadata
    cache_hits INTEGER DEFAULT 0,
    last_accessed TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for cache
CREATE INDEX idx_cache_image_hash ON prediction_cache(image_hash);
CREATE INDEX idx_cache_expires ON prediction_cache(expires_at);
CREATE INDEX idx_cache_confidence ON prediction_cache(ensemble_confidence DESC);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for updating timestamps
CREATE TRIGGER update_card_embeddings_updated_at 
    BEFORE UPDATE ON card_embeddings
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Helper function to find similar cards using cosine similarity
CREATE OR REPLACE FUNCTION find_similar_cards(
    query_embedding vector,
    model_type_filter VARCHAR(50),
    limit_results INTEGER DEFAULT 10
)
RETURNS TABLE (
    card_id INTEGER,
    similarity FLOAT,
    card_name VARCHAR,
    confidence FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ce.card_id,
        1 - (ce.embedding <=> query_embedding) as similarity,
        c.name as card_name,
        ce.confidence
    FROM card_embeddings ce
    JOIN cards c ON ce.card_id = c.id
    WHERE ce.model_type = model_type_filter
    ORDER BY ce.embedding <=> query_embedding
    LIMIT limit_results;
END;
$$ LANGUAGE plpgsql;

-- Statistics view for monitoring
CREATE OR REPLACE VIEW embedding_statistics AS
SELECT 
    model_type,
    COUNT(*) as total_embeddings,
    AVG(confidence) as avg_confidence,
    AVG(inference_time_ms) as avg_inference_ms,
    MIN(created_at) as first_embedding,
    MAX(created_at) as latest_embedding
FROM card_embeddings
GROUP BY model_type;

-- Cache effectiveness view
CREATE OR REPLACE VIEW cache_statistics AS
SELECT 
    COUNT(*) as total_cached,
    AVG(ensemble_confidence) as avg_confidence,
    SUM(cache_hits) as total_hits,
    AVG(total_inference_ms) as avg_inference_ms,
    COUNT(CASE WHEN expires_at > CURRENT_TIMESTAMP THEN 1 END) as active_cache_entries
FROM prediction_cache;

-- Grant permissions (adjust as needed)
GRANT SELECT, INSERT, UPDATE ON card_embeddings TO cardmint_user;
GRANT SELECT, INSERT, UPDATE ON card_keypoints TO cardmint_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON prediction_cache TO cardmint_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO cardmint_user;

-- Add comments for documentation
COMMENT ON TABLE card_embeddings IS 'Stores ML model embeddings for card similarity search';
COMMENT ON TABLE card_keypoints IS 'Stores ORB keypoint data for exact card matching';
COMMENT ON TABLE prediction_cache IS 'Caches ensemble predictions to reduce inference time';
COMMENT ON COLUMN card_embeddings.embedding IS 'Vector embedding from ML model (dimension varies by model)';
COMMENT ON COLUMN card_embeddings.model_type IS 'Type of model: mobilenet (lightweight), triplet_resnet (future heavy), vit (future heavy), orb (keypoints)';

-- Migration complete
-- To rollback: DROP TABLE prediction_cache, card_keypoints, card_embeddings CASCADE;