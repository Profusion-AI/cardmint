-- PPT ID Backfill Prep (Phase 2)
-- Date: 2025-11-26
-- Adds ppt_set_id/ppt_card_id + canonical_source to scans/products
-- Extends canonical_backfill_runs for product metrics

-- Scans: add PPT identifiers and canonical source
ALTER TABLE scans ADD COLUMN ppt_set_id TEXT;
ALTER TABLE scans ADD COLUMN ppt_card_id TEXT;
ALTER TABLE scans ADD COLUMN canonical_source TEXT NOT NULL DEFAULT 'pricecharting';

CREATE INDEX IF NOT EXISTS idx_scans_ppt_card_id ON scans(ppt_card_id);
CREATE INDEX IF NOT EXISTS idx_scans_ppt_set_id ON scans(ppt_set_id);

-- Products: add PPT identifiers and canonical source
ALTER TABLE products ADD COLUMN ppt_set_id TEXT;
ALTER TABLE products ADD COLUMN ppt_card_id TEXT;
ALTER TABLE products ADD COLUMN canonical_source TEXT NOT NULL DEFAULT 'pricecharting';

CREATE INDEX IF NOT EXISTS idx_products_ppt_card_id ON products(ppt_card_id);
CREATE INDEX IF NOT EXISTS idx_products_ppt_set_id ON products(ppt_set_id);

-- Extend canonical_backfill_runs to capture product coverage and run type
ALTER TABLE canonical_backfill_runs ADD COLUMN total_products INTEGER;
ALTER TABLE canonical_backfill_runs ADD COLUMN backfilled_products_ppt INTEGER;
ALTER TABLE canonical_backfill_runs ADD COLUMN backfilled_products_pc_only INTEGER;
ALTER TABLE canonical_backfill_runs ADD COLUMN products_unmapped INTEGER;
ALTER TABLE canonical_backfill_runs ADD COLUMN run_type TEXT DEFAULT 'scans+products';
ALTER TABLE canonical_backfill_runs ADD COLUMN notes TEXT;
