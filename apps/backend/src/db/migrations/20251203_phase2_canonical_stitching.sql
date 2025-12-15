-- Add canonical stitching columns to scans
ALTER TABLE scans ADD COLUMN ppt_card_id TEXT;
ALTER TABLE scans ADD COLUMN ppt_set_id TEXT;
ALTER TABLE scans ADD COLUMN canonical_source TEXT;

-- Add canonical stitching columns to products
ALTER TABLE products ADD COLUMN ppt_card_id TEXT;
ALTER TABLE products ADD COLUMN ppt_set_id TEXT;
ALTER TABLE products ADD COLUMN canonical_source TEXT;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_scans_ppt_card_id ON scans(ppt_card_id);
CREATE INDEX IF NOT EXISTS idx_products_ppt_card_id ON products(ppt_card_id);
