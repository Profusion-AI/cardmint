-- Migration: Add baseline flag to operator_sessions for Fresh Baseline workflow
-- Date: 2025-11-05
-- Purpose: Mark a finalized operator session as the active Baseline (latest baseline wins)

PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;

-- Add baseline column (0/1) if it does not already exist
ALTER TABLE operator_sessions ADD COLUMN baseline INTEGER DEFAULT 0 CHECK(baseline IN (0,1));

-- Index to quickly find the active baseline session
CREATE INDEX IF NOT EXISTS idx_operator_sessions_baseline ON operator_sessions(baseline);

-- Notes:
--  - Exactly one session should have baseline=1 at a time (enforced in application logic)
--  - "Latest baseline wins" policy will be implemented by server endpoint

