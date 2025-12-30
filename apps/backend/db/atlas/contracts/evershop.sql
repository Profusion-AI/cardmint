-- EverShop Postgres Contract File
-- Owner: Claude Code | Created: 2025-12-26
--
-- PURPOSE: This is a CONTRACT, not a migration.
-- Used for verification that EverShop Postgres has the columns CardMint depends on.
--
-- CardMint syncs data to EverShop via SSH + psql. If these columns don't exist,
-- the sync pipeline will fail.
--
-- HOW TO VERIFY:
--   ssh cardmint@157.245.213.233 "docker compose exec -T database psql -U postgres -d evershop -f -" < this_file.sql
--
-- EXPECTED OUTPUT: All queries should return rows; zero rows = broken contract

-- =============================================================================
-- CORE EVERSHOP COLUMNS (built-in, should always exist)
-- =============================================================================

-- Product table core columns
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'product'
  AND column_name IN ('product_id', 'uuid', 'sku', 'visibility', 'status', 'name')
ORDER BY column_name;
-- Expected: 6 rows

-- Product description (required for storefront)
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'product_description'
  AND column_name IN ('product_description_id', 'product_description_product_id', 'name', 'short_description');
-- Expected: 4 rows

-- Category linkage
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'product_category'
  AND column_name IN ('product_category_id', 'product_id', 'category_id');
-- Expected: 3 rows

-- Inventory tracking
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'product_inventory'
  AND column_name IN ('product_inventory_id', 'product_inventory_product_id', 'qty', 'manage_stock', 'stock_availability');
-- Expected: 5 rows

-- =============================================================================
-- CARDMINT CUSTOM COLUMNS (added via EverShop migration)
-- =============================================================================

-- CardMint-specific product columns (cm_* prefix)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'product'
  AND column_name LIKE 'cm_%'
ORDER BY column_name;
-- Expected columns:
--   cm_inventory_status
--   cm_market_price
--   cm_pricing_source
--   cm_pricing_status
--   cm_pricing_updated_at
--   cm_product_uid
--   cm_set_name
--   cm_variant

-- =============================================================================
-- INDEXES FOR SYNC QUERIES
-- =============================================================================

-- Verify UUID index exists for webhook lookups
SELECT indexname
FROM pg_indexes
WHERE tablename = 'product'
  AND indexname LIKE '%uuid%';
-- Expected: at least 1 row

-- =============================================================================
-- SUMMARY COUNTS
-- =============================================================================

-- Quick health check: count CardMint products
SELECT COUNT(*) as cardmint_products
FROM product
WHERE uuid IS NOT NULL
  AND cm_product_uid IS NOT NULL;
-- Expected: > 0 (should match CardMint prod inventory)
