-- Rollback migration for 20251224_capture_calibration.sql
-- Drops calibration-related tables

DROP TABLE IF EXISTS calibration_captures;
DROP TABLE IF EXISTS capture_settings;
