-- Migration: PPT Cache Canonical SKU
-- Date: 2025-11-18
-- Purpose: Switch PPT price cache from listing_sku to canonical_sku for shared pricing
-- Reference: docs/17nov-production-transition-findings.md Option 2 (Gap 2)

PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;

-- =============================================================================
-- PPT Price Cache: Add canonical_sku for shared pricing across listings
-- =============================================================================

-- Add canonical_sku column (invariant identifier for pricing lookups)
-- Multiple listings of same card (different product_sku) share same pricing via canonical_sku
-- Example: "PKM:TEAMROCKET:45:base:EN" (without UID suffix)
ALTER TABLE ppt_price_cache ADD COLUMN canonical_sku TEXT;

-- Update cache_key generation to use canonical_sku instead of listing_sku
-- Old format: {listing_sku}:{condition} (e.g., "PKM:TEAMROCKET:45:base:EN:F176C369:UNKNOWN:UNKNOWN")
-- New format: {canonical_sku}:{condition} (e.g., "PKM:TEAMROCKET:45:base:EN:UNKNOWN")
-- This allows multiple listings to share the same cached price

-- Create index on canonical_sku for fast lookups
CREATE INDEX IF NOT EXISTS idx_ppt_price_cache_canonical_sku ON ppt_price_cache(canonical_sku);

-- =============================================================================
-- Migration Notes
-- =============================================================================

-- Design Decision: Switch from listing_sku to canonical_sku for cache keys
-- - Reduces PPT API calls (multiple listings share pricing)
-- - Enforces Option 2 intent: canonical_sku = invariant pricing identity
-- - listing_sku column kept for audit/debugging (shows which listing triggered cache write)
--
-- Post-migration tasks:
-- 1. Update PokePriceTrackerAdapter.generateCacheKey() to use canonical_sku
-- 2. Update PokePriceTrackerAdapter method signatures (getPrice, getPriceByParsedTitle, getPriceByPricechartingId)
-- 3. Update server.ts callsites to pass product.canonical_sku instead of product.listing_sku
-- 4. Existing cache entries with NULL canonical_sku will miss until they expire (24h TTL)
-- 5. No backfill needed - cache naturally refreshes within 24 hours
--
-- Expected behavior changes:
-- - First listing of "Dark Vaporeon #45" fetches PPT pricing (cache miss)
-- - Second listing of same card hits cache (shared via canonical_sku)
-- - Operator sees instant enrichment for duplicate scans (no PPT API call)
