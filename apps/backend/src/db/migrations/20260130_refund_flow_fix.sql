-- Migration: Add EasyPost status cache for refund eligibility checks
-- This allows us to check refund eligibility without making live EasyPost calls on every request

-- Cache EasyPost status to avoid live API calls during refund eligibility checks
-- TTL is enforced in application code (5 minutes)
ALTER TABLE marketplace_shipments ADD COLUMN easypost_status_cached TEXT;
ALTER TABLE marketplace_shipments ADD COLUMN easypost_status_cached_at INTEGER;
