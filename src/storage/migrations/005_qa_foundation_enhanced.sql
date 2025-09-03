-- CardMint QA Foundation Migration
-- Enhanced FTS5 configuration optimized for Pokemon card names
-- Version: 1.0.0
-- Created: August 29, 2025

-- =====================================================
-- Performance PRAGMAs (applied during initialization)
-- =====================================================

-- WAL mode for concurrent reads (applied in init, not migration)
-- PRAGMA journal_mode=WAL;
-- PRAGMA synchronous=NORMAL;
-- PRAGMA cache_size=-80000;      -- 80MB cache
-- PRAGMA temp_store=MEMORY;
-- PRAGMA mmap_size=3000000000;   -- 3GB if available
-- PRAGMA optimize;

-- =====================================================
-- Enhanced Cards Schema with Normalization
-- =====================================================

-- Add normalization columns for better matching
ALTER TABLE cards ADD COLUMN normalized_name TEXT;
ALTER TABLE cards ADD COLUMN normalized_set TEXT; 
ALTER TABLE cards ADD COLUMN normalized_number TEXT;

-- Add canonical key for exact matching (deterministic)
ALTER TABLE cards ADD COLUMN canonical_key TEXT GENERATED ALWAYS AS (
  COALESCE(normalized_name, '') || '|' || 
  COALESCE(normalized_set, '') || '|' || 
  COALESCE(normalized_number, '')
) VIRTUAL;

-- Create indexes on normalized fields
CREATE INDEX IF NOT EXISTS idx_cards_normalized_name ON cards(normalized_name);
CREATE INDEX IF NOT EXISTS idx_cards_normalized_set ON cards(normalized_set);
CREATE INDEX IF NOT EXISTS idx_cards_canonical_key ON cards(canonical_key);

-- =====================================================
-- FTS5 Virtual Table - Optimized for Pokemon Names
-- =====================================================

-- Drop existing FTS table if it exists (migration safety)
DROP TABLE IF EXISTS cards_fts;

-- Create FTS5 table optimized for Pokemon cards
-- unicode61: Handle accents (Pokémon → Pokemon)
-- remove_diacritics 2: More aggressive accent removal
-- NO porter stemming: Pokemon names aren't English words
CREATE VIRTUAL TABLE cards_fts USING fts5(
  name,
  set_name, 
  card_number,
  normalized_name,
  normalized_set,
  content='cards',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- =====================================================
-- FTS5 Sync Triggers (Optimized)
-- =====================================================

-- Insert trigger
CREATE TRIGGER IF NOT EXISTS cards_fts_insert AFTER INSERT ON cards 
WHEN NEW.normalized_name IS NOT NULL  -- Only sync if normalized
BEGIN
  INSERT INTO cards_fts(
    rowid, name, set_name, card_number, normalized_name, normalized_set
  ) VALUES (
    NEW.rowid, NEW.name, NEW.set_name, NEW.card_number, 
    NEW.normalized_name, NEW.normalized_set
  );
END;

-- Update trigger
CREATE TRIGGER IF NOT EXISTS cards_fts_update AFTER UPDATE ON cards
WHEN NEW.normalized_name IS NOT NULL
BEGIN
  -- Remove old entry
  INSERT INTO cards_fts(cards_fts, rowid, name, set_name, card_number, normalized_name, normalized_set)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.set_name, OLD.card_number, OLD.normalized_name, OLD.normalized_set);
  
  -- Add new entry
  INSERT INTO cards_fts(
    rowid, name, set_name, card_number, normalized_name, normalized_set
  ) VALUES (
    NEW.rowid, NEW.name, NEW.set_name, NEW.card_number,
    NEW.normalized_name, NEW.normalized_set
  );
END;

-- Delete trigger
CREATE TRIGGER IF NOT EXISTS cards_fts_delete AFTER DELETE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, name, set_name, card_number, normalized_name, normalized_set)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.set_name, OLD.card_number, OLD.normalized_name, OLD.normalized_set);
END;

-- =====================================================
-- Card Aliases Table (OCR Variations)
-- =====================================================

CREATE TABLE IF NOT EXISTS card_aliases (
  alias TEXT PRIMARY KEY,               -- Normalized input variation
  canonical_id TEXT NOT NULL,           -- Points to cards.id
  alias_type TEXT NOT NULL,             -- 'ocr_variant', 'set_nickname', 'common_typo'
  confidence REAL DEFAULT 1.0,          -- Match confidence (0-1)
  created_at TEXT DEFAULT (datetime('now')),
  created_by TEXT DEFAULT 'system',     -- Track alias source
  
  FOREIGN KEY (canonical_id) REFERENCES cards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON card_aliases(canonical_id);
CREATE INDEX IF NOT EXISTS idx_aliases_type ON card_aliases(alias_type);
CREATE INDEX IF NOT EXISTS idx_aliases_confidence ON card_aliases(confidence DESC);

-- =====================================================
-- QA Verifications Table (Enhanced Durability)
-- =====================================================

CREATE TABLE IF NOT EXISTS qa_verifications (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  card_id TEXT NOT NULL REFERENCES cards(id),
  
  -- Durability & Status Tracking
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|ENQUEUED|PROCESSING|COMPLETED|FAILED|STUCK
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  enqueued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  
  -- Idempotency Versioning
  resolver_version TEXT NOT NULL,        -- Hash of resolver logic + aliases
  model_version TEXT NOT NULL,           -- GPT-OSS-20B version identifier
  input_hash TEXT NOT NULL,              -- Hash of input data (name, set, number, confidence)
  job_version INTEGER NOT NULL DEFAULT 1,
  
  -- Input Data (for replay/debugging)
  input_data TEXT NOT NULL,              -- JSON blob of input
  image_path TEXT,
  source_model TEXT NOT NULL,            -- Vision model that created input
  
  -- Output Data
  verdict TEXT,                          -- OK|CORRECT|NEEDS_REVIEW|ERROR
  chosen_card_id TEXT,
  confidence_adjustment REAL DEFAULT 0,
  final_confidence REAL,
  
  -- Evidence & Metadata
  evidence TEXT,                         -- JSON: tools used, reasoning, performance
  error_message TEXT,
  latency_ms INTEGER,
  retry_count INTEGER DEFAULT 0,
  
  -- Operational Fields
  last_heartbeat TEXT,                   -- Worker liveness
  expires_at TEXT,                       -- TTL for cleanup
  
  FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
);

-- QA Verification Indexes
CREATE INDEX IF NOT EXISTS idx_qa_status ON qa_verifications(status);
CREATE INDEX IF NOT EXISTS idx_qa_card_id ON qa_verifications(card_id);
CREATE INDEX IF NOT EXISTS idx_qa_created_at ON qa_verifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_expires_at ON qa_verifications(expires_at);
CREATE INDEX IF NOT EXISTS idx_qa_heartbeat ON qa_verifications(last_heartbeat);

-- Unique constraint for idempotency (critical!)
CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_idempotency ON qa_verifications(
  card_id, input_hash, resolver_version, model_version
);

-- =====================================================
-- System Metadata Table
-- =====================================================

CREATE TABLE IF NOT EXISTS system_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  description TEXT
);

-- Initialize resolver version tracking
INSERT OR REPLACE INTO system_metadata (key, value, description) VALUES 
('resolver_version', 'v1.0.0', 'Current deterministic resolver version'),
('aliases_last_updated', datetime('now'), 'Last time aliases were modified'),
('fts_schema_version', 'v1.0.0', 'FTS5 schema and tokenizer version'),
('migration_version', '005', 'Last applied migration version');

-- =====================================================
-- Useful Views for Operations
-- =====================================================

-- View for stuck jobs (sweeper target)
CREATE VIEW IF NOT EXISTS qa_stuck_jobs AS
SELECT * FROM qa_verifications 
WHERE status IN ('ENQUEUED', 'PROCESSING')
  AND (
    last_heartbeat IS NULL OR 
    datetime(last_heartbeat) < datetime('now', '-10 minutes')
  );

-- View for verification stats
CREATE VIEW IF NOT EXISTS qa_verification_stats AS
SELECT 
  status,
  COUNT(*) as count,
  AVG(latency_ms) as avg_latency_ms,
  MIN(created_at) as oldest,
  MAX(created_at) as newest
FROM qa_verifications
WHERE created_at > datetime('now', '-24 hours')
GROUP BY status;

-- View for resolver performance
CREATE VIEW IF NOT EXISTS resolver_performance AS
SELECT 
  json_extract(evidence, '$.method') as resolution_method,
  COUNT(*) as count,
  AVG(latency_ms) as avg_latency_ms,
  AVG(json_extract(evidence, '$.score')) as avg_confidence
FROM qa_verifications 
WHERE status = 'COMPLETED'
  AND created_at > datetime('now', '-7 days')
  AND evidence IS NOT NULL
GROUP BY json_extract(evidence, '$.method');

-- =====================================================
-- Initial Data Population Functions
-- =====================================================

-- Function to normalize text for consistent matching
-- (This will be implemented in TypeScript, but documented here)
-- normalize_name('Pikachu-EX') -> 'pikachu ex'  
-- normalize_set('Base Set') -> 'base set'
-- normalize_number('25/102') -> '25'