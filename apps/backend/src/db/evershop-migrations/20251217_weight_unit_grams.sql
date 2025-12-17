-- EverShop weight unit migration: kg -> g
--
-- CardMint uses EverShop admin primarily for merchandising (price edits, status/visibility).
-- EverShop's admin form blocks Save when weight < 1 (default validation), and CardMint imports
-- historically wrote weight=0.0100 (kg). Switching shop.weightUnit to "g" requires converting
-- stored product.weight values to keep semantics and avoid admin validation failures.
--
-- Run ONCE on EverShop PostgreSQL (via SSH to droplet):
--   ssh cardmint@157.245.213.233 "docker compose -f /opt/cardmint/docker-compose.yml exec -T database psql -U evershop -d evershop -f -" < this_file.sql
--
-- Conversion rule:
-- - Convert sub-1 weights (assumed kg) to grams by multiplying by 1000.
-- - Ensure weight is set to a sane default (2g) when missing/invalid.

BEGIN;

-- Convert likely-kg weights to grams (idempotent for CardMint's typical 0.0100 kg values).
UPDATE product
SET weight = weight * 1000
WHERE weight IS NOT NULL
  AND weight > 0
  AND weight < 1;

-- Ensure no product has NULL/zero/negative weight (admin form requires weight and min>=1).
UPDATE product
SET weight = 2
WHERE weight IS NULL OR weight <= 0;

COMMIT;

