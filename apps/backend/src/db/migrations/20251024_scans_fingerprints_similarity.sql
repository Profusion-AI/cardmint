-- Migration: Extend Scans with Fingerprints and Similarity Fields (Phase 1.3)
-- Date: 2025-10-24
-- Purpose: Add duplicate detection and similarity heuristics to scans table
-- Reference: docs/MANIFEST_SKU_BEHAVIOR_ANALYSIS.md (lines 340-343)
-- Acceptance: scan_fingerprint unique after backfill, similarity overhead ≤8ms

PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;

-- =============================================================================
-- Scans Table Extensions: Inventory Linking
-- =============================================================================

-- Link scan to physical inventory item
ALTER TABLE scans ADD COLUMN item_uid TEXT;

-- Foreign key constraint (will be enforced after backfill)
-- FOREIGN KEY (item_uid) REFERENCES items(item_uid) ON DELETE SET NULL

CREATE INDEX IF NOT EXISTS idx_scans_item_uid ON scans(item_uid);

-- =============================================================================
-- Scans Table Extensions: Fingerprints and Similarity
-- =============================================================================

-- scan_fingerprint: SHA256 hash of normalized crop
-- Normalized crop = grayscale, 1024px long-edge, post-transform
-- UNIQUE constraint enforced after backfill validates no collisions
ALTER TABLE scans ADD COLUMN scan_fingerprint TEXT;

-- Perceptual hash (64-bit pHash)
-- Used for similarity scoring, not exact matching
ALTER TABLE scans ADD COLUMN phash TEXT;

-- Difference hash (64-bit dHash)
-- Fast similarity heuristic
ALTER TABLE scans ADD COLUMN dhash TEXT;

-- Wavelet hash (64-bit wHash)
-- Robust to rotation/scaling
ALTER TABLE scans ADD COLUMN whash TEXT;

-- ORB feature signature (binary descriptor)
-- Store as hex-encoded string for keypoint matching
-- Format: JSON array of keypoint descriptors
ALTER TABLE scans ADD COLUMN orb_sig TEXT;

-- Capture session context for proximity scoring
-- Link to operator_sessions.id
ALTER TABLE scans ADD COLUMN capture_session_id TEXT;

-- Card pose/orientation metadata
-- Values: "upright", "rotated_90", "rotated_180", "rotated_270", "unknown"
ALTER TABLE scans ADD COLUMN pose TEXT DEFAULT 'unknown';

-- Blur quality score (0.0-1.0, higher = sharper)
-- Used to prioritize higher quality scans during dedup
ALTER TABLE scans ADD COLUMN blur_score REAL;

-- =============================================================================
-- Scans Table Extensions: SKU and Canonicalization
-- =============================================================================

-- Product SKU (derived from CardMint canonical mapping)
-- Format: PKM:{cm_set_id}:{collector_no}:{variant}:{lang}
-- Populated after canonicalization in pipeline
ALTER TABLE scans ADD COLUMN product_sku TEXT;

-- Listing SKU (product SKU + condition)
-- Format: {product_sku}:{condition_bucket}
ALTER TABLE scans ADD COLUMN listing_sku TEXT;

-- CardMint canonical card ID
-- Foreign key to cm_cards
ALTER TABLE scans ADD COLUMN cm_card_id TEXT;

-- =============================================================================
-- Scans Table Extensions: Processing Metadata
-- =============================================================================

-- Path to raw image (from SFTP inbox)
-- Separated from processed_image_path for audit trail
ALTER TABLE scans ADD COLUMN raw_image_path TEXT;

-- Path to processed image (Stage 2 output)
-- Already exists as image_path in legacy schema, but renamed for clarity
-- Will be populated during backfill: processed_image_path = image_path
ALTER TABLE scans ADD COLUMN processed_image_path TEXT;

-- Path to distortion-corrected image (Stage 1 output)
ALTER TABLE scans ADD COLUMN corrected_image_path TEXT;

-- Capture UID from Pi5 kiosk
-- Links to {uid}.jpg/.json in SFTP inbox
ALTER TABLE scans ADD COLUMN capture_uid TEXT;

-- =============================================================================
-- Indexes for Performance
-- =============================================================================

-- scan_fingerprint index (will become UNIQUE after backfill)
CREATE INDEX IF NOT EXISTS idx_scans_fingerprint ON scans(scan_fingerprint);

-- Similarity hash indexes for duplicate detection queries
CREATE INDEX IF NOT EXISTS idx_scans_phash ON scans(phash);
CREATE INDEX IF NOT EXISTS idx_scans_dhash ON scans(dhash);
CREATE INDEX IF NOT EXISTS idx_scans_whash ON scans(whash);

-- Session context for proximity scoring
CREATE INDEX IF NOT EXISTS idx_scans_capture_session ON scans(capture_session_id);

-- SKU indexes for manifest/export queries
CREATE INDEX IF NOT EXISTS idx_scans_product_sku ON scans(product_sku);
CREATE INDEX IF NOT EXISTS idx_scans_listing_sku ON scans(listing_sku);

-- Canonical card mapping
CREATE INDEX IF NOT EXISTS idx_scans_cm_card_id ON scans(cm_card_id);

-- Capture UID for SFTP inbox matching
CREATE INDEX IF NOT EXISTS idx_scans_capture_uid ON scans(capture_uid);

-- =============================================================================
-- Migration Notes
-- =============================================================================

-- UNIQUE constraint on scan_fingerprint will be added in Phase 1.6 after:
-- 1. Backfill generates fingerprints for all existing scans
-- 2. Validation confirms no collisions exist
-- 3. Acceptance gate passes (≥98% precision, ≤0.1% false-merge)
--
-- Command to add constraint after validation:
-- CREATE UNIQUE INDEX idx_scans_fingerprint_unique ON scans(scan_fingerprint);

-- Foreign key constraint for item_uid will be enforced after backfill:
-- 1. Historical scans mapped to products/items
-- 2. All scans have valid item_uid values
--
-- Note: SQLite doesn't support ALTER TABLE ADD CONSTRAINT, so foreign key
-- enforcement requires table rebuild or manual verification in application code.

-- =============================================================================
-- Migration Metadata
-- =============================================================================

-- Migration applied: 2025-10-24
-- Phase 1.3 of CardMint Inventory System migration
