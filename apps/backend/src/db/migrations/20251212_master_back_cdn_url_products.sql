-- Add missing products.master_back_cdn_url column (Stage 3 back master publish)
-- Fixes runtime warning: "no such column: master_back_cdn_url"
ALTER TABLE products ADD COLUMN master_back_cdn_url TEXT;

