-- EverShop Traceability Migration
-- Run ONCE on EverShop PostgreSQL (via SSH to droplet)
-- Purpose: Add cardmint_scan_id column to product table for job traceability
--
-- Execution:
--   ssh cardmint@157.245.213.233 "docker compose -f /opt/cardmint/docker-compose.yml exec -T database psql -U evershop -d evershop -f -" < this_file.sql
--
-- Or manually via psql:
--   ALTER TABLE product ADD COLUMN IF NOT EXISTS cardmint_scan_id TEXT;
--   CREATE INDEX IF NOT EXISTS idx_product_cardmint_scan_id ON product(cardmint_scan_id);

-- Add traceability column (nullable, for linking back to CardMint scan/job ID)
ALTER TABLE product ADD COLUMN IF NOT EXISTS cardmint_scan_id TEXT;

-- Index for lookups by scan ID
CREATE INDEX IF NOT EXISTS idx_product_cardmint_scan_id ON product(cardmint_scan_id);

-- Verification query (run after migration):
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'product' AND column_name = 'cardmint_scan_id';
