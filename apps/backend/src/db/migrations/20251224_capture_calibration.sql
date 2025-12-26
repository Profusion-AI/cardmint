-- Capture calibration settings (24 Dec 2025)
-- Pre-CDN image tuning controls for operator workbench
--
-- Two tables:
-- 1. capture_settings: Single-row global settings for camera + Stage-3 params
-- 2. calibration_captures: Short-lived tracking for test captures (1h TTL)

PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;

-- ============================================================================
-- capture_settings: Global capture settings (single row enforced by CHECK)
-- ============================================================================
-- Stores operator-tuned camera controls + Stage-3 processing parameters.
-- Normal captures read from this table (with env var fallback).
-- ============================================================================

CREATE TABLE IF NOT EXISTS capture_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Enforce single row

  -- Camera controls (Pi5 HQ camera via kiosk)
  exposure_us INTEGER DEFAULT 10101,           -- ExposureTime in microseconds
  analogue_gain REAL DEFAULT 1.115,            -- AnalogueGain
  colour_gains_red REAL DEFAULT 2.38,          -- ColourGains[0] (red)
  colour_gains_blue REAL DEFAULT 1.98,         -- ColourGains[1] (blue)
  ae_enable INTEGER DEFAULT 0,                 -- AeEnable (0=false, 1=true)
  awb_enable INTEGER DEFAULT 0,                -- AwbEnable (0=false, 1=true)

  -- Stage-3 processing parameters (listing asset generation)
  clahe_clip_limit REAL DEFAULT 1.5,           -- CLAHE clipLimit
  clahe_tile_size INTEGER DEFAULT 8,           -- CLAHE tileGridSize (NxN)
  stage3_awb_enable INTEGER DEFAULT 1,         -- Auto white balance (gray world)

  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Insert default row (uses column defaults)
INSERT OR IGNORE INTO capture_settings (id, created_at, updated_at)
VALUES (1, strftime('%s','now')*1000, strftime('%s','now')*1000);


-- ============================================================================
-- calibration_captures: Short-lived test capture tracking
-- ============================================================================
-- Tracks test captures initiated from Capture QA modal.
-- CRITICAL: capture_uid is used by SFTP ingestion to detect calibration
-- captures and skip job creation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS calibration_captures (
  id TEXT PRIMARY KEY,                         -- UUID
  capture_uid TEXT NOT NULL UNIQUE,            -- Pi5 kiosk UID (for SFTP detection)

  -- Image paths (populated as pipeline progresses)
  raw_image_path TEXT,                         -- Raw capture from Pi5
  stage1_image_path TEXT,                      -- After distortion correction
  stage2_image_path TEXT,                      -- After resize/compress
  processed_image_path TEXT,                   -- After Stage-3 (listing asset)

  -- Settings snapshots
  settings_snapshot_json TEXT,                 -- Camera settings at capture time
  stage3_params_json TEXT,                     -- Stage-3 params used for processing

  -- Status tracking
  status TEXT DEFAULT 'PENDING' CHECK(status IN (
    'PENDING',      -- Capture requested, waiting for SFTP
    'CAPTURED',     -- Raw image received from SFTP
    'STAGE1',       -- Distortion correction complete
    'STAGE2',       -- Resize/compress complete
    'PROCESSED',    -- Stage-3 complete, ready for preview
    'EXPIRED',      -- TTL exceeded, pending cleanup
    'FAILED'        -- Processing error
  )),
  error_message TEXT,                          -- Error details if FAILED

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL                  -- TTL for auto-cleanup (1h default)
);

-- Index for SFTP ingestion lookup (critical path)
CREATE INDEX IF NOT EXISTS idx_calibration_captures_uid ON calibration_captures(capture_uid);

-- Indexes for cleanup job
CREATE INDEX IF NOT EXISTS idx_calibration_captures_status ON calibration_captures(status);
CREATE INDEX IF NOT EXISTS idx_calibration_captures_expires ON calibration_captures(expires_at);
