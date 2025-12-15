-- Camera control audit trail
-- Store camera_applied_controls from Pi5 manifest for exposure/WB history audit

ALTER TABLE scans ADD COLUMN camera_applied_controls_json TEXT;
