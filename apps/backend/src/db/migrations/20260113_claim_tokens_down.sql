-- P1.3 Claim Order: Rollback migration
-- Drops claim-related tables

DROP INDEX IF EXISTS idx_claim_events_created_at;
DROP INDEX IF EXISTS idx_claim_events_order_uid;
DROP TABLE IF EXISTS claim_events;

DROP INDEX IF EXISTS idx_claim_rate_limits_window;
DROP INDEX IF EXISTS idx_claim_rate_limits_order_uid;
DROP TABLE IF EXISTS claim_rate_limits;

DROP INDEX IF EXISTS idx_claim_tokens_expires_at;
DROP INDEX IF EXISTS idx_claim_tokens_token_hash;
DROP INDEX IF EXISTS idx_claim_tokens_order_uid;
DROP TABLE IF EXISTS claim_tokens;
