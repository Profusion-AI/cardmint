-- CardMint Sync Extension: Migration v1.1.0
-- Adds cm_* projection columns for Product Ops Cockpit
-- These columns enable the CardMint admin grid to display pricing/inventory context
-- without requiring navigation to individual product pages
--
-- Authority model:
--   - cm_* columns are READ-ONLY reference data from CardMint
--   - product.price remains EverShop Admin authority (customer-facing price)
--   - CardMint syncs these columns during import/update cycles

DO $$
BEGIN
  -- Add cm_set_name: Reliable set name (fallback when category is missing)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_set_name'
  ) THEN
    ALTER TABLE product ADD COLUMN cm_set_name TEXT;
    RAISE NOTICE '[cardmint_sync v1.1.0] Added cm_set_name column';
  END IF;

  -- Add cm_variant: Canonical variant string (first variant tag)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_variant'
  ) THEN
    ALTER TABLE product ADD COLUMN cm_variant TEXT;
    RAISE NOTICE '[cardmint_sync v1.1.0] Added cm_variant column';
  END IF;

  -- Add cm_market_price: Internal market reference price (from PPT/CSV)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_market_price'
  ) THEN
    ALTER TABLE product ADD COLUMN cm_market_price NUMERIC(12,2);
    RAISE NOTICE '[cardmint_sync v1.1.0] Added cm_market_price column';
  END IF;

  -- Add cm_pricing_source: Where price came from ('ppt', 'csv', 'manual')
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_pricing_source'
  ) THEN
    ALTER TABLE product ADD COLUMN cm_pricing_source TEXT;
    RAISE NOTICE '[cardmint_sync v1.1.0] Added cm_pricing_source column';
  END IF;

  -- Add cm_pricing_status: Pricing data freshness ('fresh', 'stale', 'missing')
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_pricing_status'
  ) THEN
    ALTER TABLE product ADD COLUMN cm_pricing_status TEXT;
    RAISE NOTICE '[cardmint_sync v1.1.0] Added cm_pricing_status column';
  END IF;

  -- Add cm_pricing_updated_at: When pricing was last refreshed
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_pricing_updated_at'
  ) THEN
    ALTER TABLE product ADD COLUMN cm_pricing_updated_at TIMESTAMPTZ;
    RAISE NOTICE '[cardmint_sync v1.1.0] Added cm_pricing_updated_at column';
  END IF;

  -- Add cm_product_uid: Link back to CardMint product_uid
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_product_uid'
  ) THEN
    ALTER TABLE product ADD COLUMN cm_product_uid TEXT;
    RAISE NOTICE '[cardmint_sync v1.1.0] Added cm_product_uid column';
  END IF;

  -- Add cm_inventory_status: Aggregate inventory status ('IN_STOCK', 'OUT_OF_STOCK')
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_inventory_status'
  ) THEN
    ALTER TABLE product ADD COLUMN cm_inventory_status TEXT;
    RAISE NOTICE '[cardmint_sync v1.1.0] Added cm_inventory_status column';
  END IF;
END $$;

-- Create indexes for sorting performance (server-side sorting in admin grid)
CREATE INDEX IF NOT EXISTS idx_product_cm_set_name ON product(cm_set_name);
CREATE INDEX IF NOT EXISTS idx_product_cm_variant ON product(cm_variant);
CREATE INDEX IF NOT EXISTS idx_product_cm_market_price ON product(cm_market_price);
CREATE INDEX IF NOT EXISTS idx_product_cm_pricing_updated_at ON product(cm_pricing_updated_at);
CREATE INDEX IF NOT EXISTS idx_product_cm_product_uid ON product(cm_product_uid);

-- Verify migration
DO $$
DECLARE
  col_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO col_count
  FROM information_schema.columns
  WHERE table_name = 'product'
    AND column_name IN (
      'cm_set_name', 'cm_variant', 'cm_market_price',
      'cm_pricing_source', 'cm_pricing_status', 'cm_pricing_updated_at',
      'cm_product_uid', 'cm_inventory_status'
    );

  IF col_count = 8 THEN
    RAISE NOTICE '[cardmint_sync v1.1.0] Migration complete: all 8 cm_* columns present';
  ELSE
    RAISE WARNING '[cardmint_sync v1.1.0] Migration incomplete: only % of 8 cm_* columns found', col_count;
  END IF;
END $$;
