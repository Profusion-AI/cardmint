-- Privacy Requests Table
-- Stores DSAR (Data Subject Access Request) audit trail
-- Required for GDPR/CCPA compliance

-- Create privacy_requests table for audit logging
CREATE TABLE IF NOT EXISTS privacy_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT NOT NULL,              -- SHA-256 hash of normalized email (non-reversible, for audit)
  request_type TEXT NOT NULL,            -- 'deletion', 'export', 'correction'
  ip_address TEXT,                       -- IP for rate limiting / fraud detection
  requested_at INTEGER NOT NULL,         -- Unix timestamp
  completed_at INTEGER,                  -- When request was fulfilled
  status TEXT DEFAULT 'processing',      -- 'processing', 'completed', 'failed'
  notes TEXT                             -- Admin notes if needed
);

-- Index for lookups by email hash
CREATE INDEX IF NOT EXISTS idx_privacy_requests_email_hash ON privacy_requests(email_hash);

-- Index for status monitoring
CREATE INDEX IF NOT EXISTS idx_privacy_requests_status ON privacy_requests(status);

-- Add deleted_at and deletion_reason columns to email_subscribers
-- These support GDPR Article 17 (Right to Erasure)
ALTER TABLE email_subscribers ADD COLUMN deleted_at INTEGER;
ALTER TABLE email_subscribers ADD COLUMN deletion_reason TEXT;

-- Index for finding non-deleted subscribers
CREATE INDEX IF NOT EXISTS idx_email_subscribers_deleted ON email_subscribers(deleted_at);
