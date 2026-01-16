-- Add USPS tracking fallback fields for unmatched tracking entries

ALTER TABLE unmatched_tracking ADD COLUMN usps_status TEXT;
ALTER TABLE unmatched_tracking ADD COLUMN usps_delivered_at INTEGER;
ALTER TABLE unmatched_tracking ADD COLUMN usps_last_event_at INTEGER;
ALTER TABLE unmatched_tracking ADD COLUMN usps_events_json TEXT;
ALTER TABLE unmatched_tracking ADD COLUMN last_usps_fetch_at INTEGER;
