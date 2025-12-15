-- Backfill reconciliation status for scans/products missing canonical matches (post-relaxed lock)
-- Safe to run after 20251121_relaxed_canonical_lock.sql

-- Mark pending reconciliation where canonical is missing or UNKNOWN_*
UPDATE scans
SET reconciliation_status = 'pending'
WHERE canonical_locked = 1
  AND (cm_card_id IS NULL OR cm_card_id LIKE 'UNKNOWN_%')
  AND (reconciliation_status IS NULL OR reconciliation_status = '');

-- For accepted scans lacking items, leave untouched (handled separately)

-- Verification (manual):
-- SELECT COUNT(*) FROM scans WHERE reconciliation_status = 'pending';
