-- Migration: 20251227c_products_cdn_published_at
-- Purpose: Reconcile missing products.cdn_published_at on fresh DB builds.
-- Used to track when product listing assets have been published to the CDN.
--
-- Policy: Migrations are immutable; reconciliation is forward-only.

ALTER TABLE products ADD COLUMN cdn_published_at INTEGER;

