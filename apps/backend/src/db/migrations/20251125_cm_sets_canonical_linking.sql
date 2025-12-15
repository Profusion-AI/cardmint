-- cm_sets Canonical Linking Migration
-- Date: 2025-11-25
-- Purpose: Add PPT/TCGPlayer ID columns to cm_sets for canonical integration

-- Add ppt_id column (links to canonical_sets.ppt_set_id)
ALTER TABLE cm_sets ADD COLUMN ppt_id TEXT;

-- Add tcgplayer_id column (links to canonical_sets.tcg_player_id)
ALTER TABLE cm_sets ADD COLUMN tcgplayer_id TEXT;

-- Create index for PPT lookups
CREATE INDEX IF NOT EXISTS idx_cm_sets_ppt_id ON cm_sets(ppt_id);

-- Create index for TCGPlayer lookups
CREATE INDEX IF NOT EXISTS idx_cm_sets_tcgplayer_id ON cm_sets(tcgplayer_id);
