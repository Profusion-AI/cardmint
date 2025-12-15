-- Migration: Add capture_uid for Pi5 placeholder hydration
-- Date: 2025-10-23
-- Reason: Decouple placeholder lookups from session_id after switching to operator UUID

-- Add capture_uid column to store kiosk-provided UID for placeholder hydration
-- This allows SFTP watcher to hydrate placeholders by kiosk UID while session_id
-- references the operator session UUID for analytics joins
ALTER TABLE scans ADD COLUMN capture_uid TEXT;

-- Create non-unique index for fast lookups (duplicates possible during offline replays)
CREATE INDEX IF NOT EXISTS idx_scans_capture_uid ON scans(capture_uid);

-- Backfill: Extract Pi5 UIDs from session_id where format is timestamp-based
-- Session IDs with UUID format (8-4-4-4-12) are operator sessions, leave capture_uid NULL
-- Session IDs with timestamp format (20251022T182346562236) are Pi5 UIDs, copy to capture_uid
UPDATE scans
SET capture_uid = session_id
WHERE session_id NOT LIKE '%-%-%-%-%'  -- Not UUID format
  AND session_id LIKE '2025%T%';       -- Timestamp format
