-- Migration: 20260218_reconcile_privacy_requests_checksum
-- Purpose: Correct recorded checksum for 20251217_privacy_requests
-- Background: The migration was originally applied with checksum
-- bf2210416d7981f6a17a1650eded0c13d0ceb2e28d0fea276cd993163576ca73.
-- A later commit updated only a comment in the source file, changing the
-- hash to c6c33b2dbb53e2a046140b46f591db9efd8e610cdf02c83f0b860c73600d8390.
--
-- This is metadata-only and does not modify schema.
-- It silences the recurring checksum mismatch warning during migrate.

UPDATE schema_migrations
SET checksum = 'c6c33b2dbb53e2a046140b46f591db9efd8e610cdf02c83f0b860c73600d8390'
WHERE id = '20251217_privacy_requests';
