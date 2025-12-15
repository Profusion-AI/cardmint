-- Dec 8, 2025: Add variant_tags to products table for HITL persistence
-- Variants selected in Truth Core (First Edition, Reverse Holo, Holo, Full Art, Shadowless)
-- should persist through acceptance and sync bidirectionally with EverShop

-- Add variant_tags column (JSON-encoded string array, like scans.accepted_variant_tags)
ALTER TABLE products ADD COLUMN variant_tags TEXT;

-- Create index for filtering by variant
CREATE INDEX idx_products_variant_tags ON products(variant_tags) WHERE variant_tags IS NOT NULL;
