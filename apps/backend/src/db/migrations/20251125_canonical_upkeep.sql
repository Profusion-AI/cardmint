-- Canonical Database Upkeep Migration
-- Date: 2025-11-25
-- Purpose: Post-hydration schema alignment and guard table creation
--
-- Addresses:
-- 1. Missing first_seen_at/last_seen_at columns for drift detection
-- 2. Missing RFC-specified guard tables
-- 3. Incorrect canonical_catalog_meta (cards_total=0)
-- 4. Missing baseline run record

-- ============================================================================
-- Step 1: Add missing timestamp columns to canonical_cards
-- ============================================================================
ALTER TABLE canonical_cards ADD COLUMN first_seen_at INTEGER;
ALTER TABLE canonical_cards ADD COLUMN last_seen_at INTEGER;

-- Backfill from existing fetched_at
UPDATE canonical_cards
SET first_seen_at = fetched_at, last_seen_at = fetched_at
WHERE first_seen_at IS NULL;

-- ============================================================================
-- Step 2: Create canonical_reconciliation_events
-- Tracks conflicts between PPT, PriceCharting, and Truth Core
-- ============================================================================
CREATE TABLE IF NOT EXISTS canonical_reconciliation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cm_card_id TEXT,                   -- Truth Core reference (nullable)
  pricecharting_card_id TEXT,        -- PriceCharting reference (nullable)
  ppt_card_id TEXT,                  -- PPT reference (nullable)
  conflict_reason TEXT NOT NULL,     -- name_mismatch, missing_in_ppt, missing_in_pc, set_mismatch
  details TEXT,                      -- JSON with specifics
  first_seen_at INTEGER NOT NULL,    -- When conflict first detected
  last_seen_at INTEGER NOT NULL,     -- Most recent occurrence
  resolved_at INTEGER,               -- Null until manually resolved
  UNIQUE(cm_card_id, pricecharting_card_id, ppt_card_id, conflict_reason)
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_reason ON canonical_reconciliation_events(conflict_reason);
CREATE INDEX IF NOT EXISTS idx_reconciliation_unresolved ON canonical_reconciliation_events(resolved_at) WHERE resolved_at IS NULL;

-- ============================================================================
-- Step 3: Create canonical_refresh_runs for dynamic gates
-- Stores refresh run metadata; baseline view selects last successful full run
-- ============================================================================
CREATE TABLE IF NOT EXISTS canonical_refresh_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,            -- 'full' | 'maintenance'
  started_at TEXT NOT NULL,          -- ISO 8601 timestamp
  finished_at TEXT,                  -- ISO 8601 timestamp (null if in progress)
  sets_count INTEGER,                -- Sets in catalog after run
  cards_count INTEGER,               -- Cards in catalog after run
  coverage_ratio REAL,               -- Cards mapped vs PPT metadata
  status TEXT NOT NULL,              -- 'success' | 'failed' | 'in_progress'
  notes TEXT                         -- Human-readable notes
);

CREATE INDEX IF NOT EXISTS idx_refresh_runs_status ON canonical_refresh_runs(status);
CREATE INDEX IF NOT EXISTS idx_refresh_runs_type_status ON canonical_refresh_runs(run_type, status);

-- View: canonical_refresh_baseline
-- Returns the most recent successful full refresh (authoritative for gates)
CREATE VIEW IF NOT EXISTS canonical_refresh_baseline AS
SELECT *
FROM canonical_refresh_runs
WHERE run_type = 'full' AND status = 'success'
ORDER BY finished_at DESC
LIMIT 1;

-- ============================================================================
-- Step 4: Create canonical_backfill_runs for Phase 2 migration tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS canonical_backfill_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,          -- ISO 8601 timestamp
  finished_at TEXT,                  -- ISO 8601 timestamp
  total_scans INTEGER,               -- Total scans processed
  backfilled_ppt INTEGER,            -- Mapped to canonical with PPT IDs
  backfilled_pc_only INTEGER,        -- PriceCharting only, no PPT ID
  unmapped INTEGER,                  -- Anomalies requiring review
  status TEXT NOT NULL               -- 'success' | 'failed' | 'in_progress'
);

-- ============================================================================
-- Step 5: Fix canonical_catalog_meta
-- cards_total was 0; needs to reflect actual hydrated count
-- ============================================================================
INSERT OR REPLACE INTO canonical_catalog_meta (key, value, updated_at)
VALUES
  ('cards_total', '26581', strftime('%s', 'now')),
  ('sets_total', '212', strftime('%s', 'now'));

-- ============================================================================
-- Step 6: Insert initial baseline run record
-- Records the successful hydration (25 Nov 2025)
-- ============================================================================
INSERT INTO canonical_refresh_runs
  (run_type, started_at, finished_at, sets_count, cards_count, coverage_ratio, status, notes)
VALUES
  ('full', '2025-11-25T14:41:03', '2025-11-25T15:06:24', 212, 26581, 1.0, 'success',
   'Initial hydration complete. 18 empty sets (trainer kits, samples).');
