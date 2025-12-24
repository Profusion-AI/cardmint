-- CardMint Sync Extension: Rollback Migration v1.2.0
-- Removes cm_evershop_sync_state column added by Version-1.2.0.sql
-- WARNING: This will DROP data in cm_evershop_sync_state column

-- Drop the index first
DROP INDEX IF EXISTS idx_product_cm_evershop_sync_state;

-- Drop the column
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_evershop_sync_state'
  ) THEN
    ALTER TABLE product DROP COLUMN cm_evershop_sync_state;
    RAISE NOTICE '[cardmint_sync v1.2.0 ROLLBACK] Dropped cm_evershop_sync_state column';
  ELSE
    RAISE NOTICE '[cardmint_sync v1.2.0 ROLLBACK] cm_evershop_sync_state column does not exist, nothing to drop';
  END IF;
END $$;

-- Verify rollback
DO $$
DECLARE
  col_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product' AND column_name = 'cm_evershop_sync_state'
  ) INTO col_exists;

  IF NOT col_exists THEN
    RAISE NOTICE '[cardmint_sync v1.2.0 ROLLBACK] Rollback complete: cm_evershop_sync_state column removed';
  ELSE
    RAISE WARNING '[cardmint_sync v1.2.0 ROLLBACK] Rollback failed: cm_evershop_sync_state column still exists';
  END IF;
END $$;
