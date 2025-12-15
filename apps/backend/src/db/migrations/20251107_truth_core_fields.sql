-- Nov 7 MVP: Truth Core persistence
-- When operator clicks "Accept (Lock Truth)", persist the final truth:
-- Name, HP (optional), Collector No, Set Name

ALTER TABLE scans ADD COLUMN accepted_name TEXT;
ALTER TABLE scans ADD COLUMN accepted_hp INTEGER; -- nullable for Trainers
ALTER TABLE scans ADD COLUMN accepted_collector_no TEXT; -- TEXT per CEO_SEMANTICS_MVP.md:46
ALTER TABLE scans ADD COLUMN accepted_set_name TEXT;
-- Deterministic per set (English focus for MVP)
ALTER TABLE scans ADD COLUMN accepted_set_size INTEGER; -- nullable when unknown / not printed

-- Index for baseline scorer queries
CREATE INDEX idx_scans_accepted_name ON scans(accepted_name);
CREATE INDEX idx_scans_accepted_collector_no ON scans(accepted_collector_no);
CREATE INDEX idx_scans_accepted_set_size ON scans(accepted_set_size);
