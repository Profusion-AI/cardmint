-- Nov 7 MVP: Optional variant disambiguation for Truth Core
-- Persist operator-selected variant tags (JSON array as TEXT)

ALTER TABLE scans ADD COLUMN accepted_variant_tags TEXT; -- JSON-encoded string array

