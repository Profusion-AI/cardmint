-- Fix corrupt EverShop UUID values persisted from psql command-tag output.
-- Example bad value: "<uuid>\n\nINSERT 0 1"
--
-- This migration is safe to re-run.

UPDATE products
SET evershop_uuid = substr(trim(evershop_uuid), 1, 36)
WHERE evershop_uuid IS NOT NULL
  AND length(trim(evershop_uuid)) >= 36
  AND (
    instr(evershop_uuid, 'INSERT') > 0
    OR instr(evershop_uuid, 'UPDATE') > 0
    OR instr(evershop_uuid, 'DELETE') > 0
    OR instr(evershop_uuid, 'SELECT') > 0
  );

