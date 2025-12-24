-- CardMint Sync Extension: Migration v1.2.0
-- Adds cm_evershop_sync_state for Ops Grid Compound Status Badge
-- This enables the admin grid to show both inventory status and visibility state

DO $$
BEGIN
  -- Add cm_evershop_sync_state: Sync state from CardMint
  -- Values: 'evershop_live', 'evershop_hidden', 'vault_only', 'sync_error', 'not_synced'
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_evershop_sync_state'
  ) THEN
    ALTER TABLE product ADD COLUMN cm_evershop_sync_state TEXT;
    RAISE NOTICE '[cardmint_sync v1.2.0] Added cm_evershop_sync_state column';
  ELSE
    RAISE NOTICE '[cardmint_sync v1.2.0] cm_evershop_sync_state column already exists';
  END IF;
END $$;

-- Index for filtering by sync state in admin grid
CREATE INDEX IF NOT EXISTS idx_product_cm_evershop_sync_state ON product(cm_evershop_sync_state);

-- Verify migration
DO $$
DECLARE
  col_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_evershop_sync_state'
  ) INTO col_exists;

  IF col_exists THEN
    RAISE NOTICE '[cardmint_sync v1.2.0] Migration complete: cm_evershop_sync_state column present';
  ELSE
    RAISE WARNING '[cardmint_sync v1.2.0] Migration failed: cm_evershop_sync_state column not found';
  END IF;
END $$;
