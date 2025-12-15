-- Migration: Phase 2 Backfill Logging Tables
-- Renames legacy conflict-tracking tables and creates new backfill run logging tables

-- Rename existing tables to preserve legacy conflict tracking data
ALTER TABLE canonical_backfill_runs RENAME TO canonical_backfill_runs_legacy;
ALTER TABLE canonical_reconciliation_events RENAME TO canonical_reconciliation_events_legacy;

-- Create new backfill run logging table
CREATE TABLE canonical_backfill_runs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL,
    items_processed INTEGER DEFAULT 0,
    items_mapped INTEGER DEFAULT 0,
    items_unmapped INTEGER DEFAULT 0,
    details TEXT
);

-- Create new reconciliation events table for per-entity logging
CREATE TABLE canonical_reconciliation_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(run_id) REFERENCES canonical_backfill_runs(id)
);

-- Create indexes (separate statements for SQLite compatibility)
CREATE INDEX IF NOT EXISTS idx_backfill_events_run_id ON canonical_reconciliation_events(run_id);
CREATE INDEX IF NOT EXISTS idx_backfill_events_entity ON canonical_reconciliation_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_backfill_events_type ON canonical_reconciliation_events(event_type);
