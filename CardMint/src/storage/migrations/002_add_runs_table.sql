-- Migration: Add runs table for tracking capture runs
-- Version: 002
-- Date: 2025-08-14

CREATE TABLE IF NOT EXISTS runs (
    run_id VARCHAR(50) PRIMARY KEY,
    run_dir VARCHAR(500) NOT NULL,
    preset VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    manifest JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_timestamp ON runs(timestamp DESC);
CREATE INDEX idx_runs_preset ON runs(preset);
CREATE INDEX idx_runs_manifest_quality ON runs((manifest->'qualityMetrics'->>'overallQuality'));

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_runs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
CREATE TRIGGER runs_updated_at_trigger
    BEFORE UPDATE ON runs
    FOR EACH ROW
    EXECUTE FUNCTION update_runs_updated_at();

-- Add run_id reference to cards table
ALTER TABLE cards 
ADD COLUMN IF NOT EXISTS run_id VARCHAR(50),
ADD CONSTRAINT fk_cards_run_id 
    FOREIGN KEY (run_id) 
    REFERENCES runs(run_id) 
    ON DELETE SET NULL;

-- Index for joining cards with runs
CREATE INDEX IF NOT EXISTS idx_cards_run_id ON cards(run_id);

-- Comments for documentation
COMMENT ON TABLE runs IS 'Storage for capture run metadata and manifests';
COMMENT ON COLUMN runs.run_id IS 'Unique identifier for the capture run';
COMMENT ON COLUMN runs.run_dir IS 'Filesystem path to run directory';
COMMENT ON COLUMN runs.preset IS 'Capture preset used (catalog, sweep, focus_stack)';
COMMENT ON COLUMN runs.status IS 'Run status (running, completed, failed)';
COMMENT ON COLUMN runs.manifest IS 'Complete run manifest as JSONB';