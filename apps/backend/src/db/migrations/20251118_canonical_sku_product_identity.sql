-- Migration: Canonical SKU Product Identity
-- Date: 2025-11-18
-- Purpose: Add canonical_sku for pricing/PPT lookups, make product_sku unique per listing
-- Reference: docs/17nov-production-transition-findings.md Option 2

PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;

-- =============================================================================
-- Products Table: Add canonical_sku for invariant identity
-- =============================================================================

-- Add canonical_sku column (canonical identifier WITHOUT UID suffix)
-- Format: PKM:{cm_set_id}:{collector_no}:{variant}:{lang}
-- Example: "PKM:TEAMROCKET:45:base:EN"
-- This is used for:
--   - PPT pricing lookups (multiple listings share same pricing)
--   - CSV pricing imports (canonical card identity)
--   - Analytics/grouping (how many listings for this card?)
--
-- product_sku remains UNIQUE but now includes UID suffix:
-- Format: {canonical_sku}:{short_uid}
-- Example: "PKM:TEAMROCKET:45:base:EN:F176C369"
-- This enforces CardMint's WYSIWYG promise: one PDP, one physical card
ALTER TABLE products ADD COLUMN canonical_sku TEXT;

-- Create index on canonical_sku for pricing/PPT lookups
CREATE INDEX IF NOT EXISTS idx_products_canonical_sku ON products(canonical_sku);

-- =============================================================================
-- Migration Notes
-- =============================================================================

-- Design Decision: Option 2 (UID-Based SKUs)
-- - Preserves "Photographed honestly" brand promise (one listing per physical card)
-- - canonical_sku = invariant identifier for pricing/analytics
-- - product_sku = per-listing key with UID suffix
-- - UNIQUE(product_sku) constraint stays, prevents collisions
--
-- Post-migration tasks:
-- 1. Update SKUCanonicalizer to return both canonical_sku and product_sku
-- 2. Update InventoryService.upsertProduct to store both SKUs
-- 3. Update JobWorker to make inventory failures blocking (no silent catch)
-- 4. Backfill canonical_sku for existing products (derive from product_sku by removing UID suffix)
-- 5. Update PPT adapter to use canonical_sku for pricing lookups
-- 6. Test end-to-end: multiple Dark Vaporeon scans create distinct products
--
-- Expected behavior changes:
-- - Multiple scans of "same card" create multiple products with unique product_sku
-- - PPT enrichment uses canonical_sku to find pricing (shared across listings)
-- - EverShop importer creates separate listings for each scan (each with own images)
-- - Operator can consolidate listings manually if desired (future feature)
