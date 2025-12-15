-- EverShop Import Safeguards (Dec 3, 2025)
-- Idempotency keys and audit logging for confirmed imports

-- Idempotency keys for EverShop imports
-- Prevents double-imports via X-Idempotency-Key header
CREATE TABLE IF NOT EXISTS evershop_import_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  job_id TEXT,
  user_id TEXT,
  client_ip TEXT,
  request_hash TEXT NOT NULL,  -- SHA256 of sorted payload for replay detection
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  completed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'  -- pending, completed, failed, aborted
);

CREATE INDEX IF NOT EXISTS idx_idem_created ON evershop_import_idempotency(created_at);
CREATE INDEX IF NOT EXISTS idx_idem_status ON evershop_import_idempotency(status);

-- Audit log for confirmed imports
-- Logs who ran confirm, when, what, and result (even on failure)
CREATE TABLE IF NOT EXISTS evershop_import_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  idempotency_key TEXT NOT NULL,
  user_id TEXT,
  client_ip TEXT,
  user_agent TEXT,
  payload_summary TEXT,  -- JSON: {limit, sku_count, first_skus: [...]}
  confirm_mode INTEGER NOT NULL DEFAULT 0,  -- 0=dry_run, 1=confirmed
  products_imported INTEGER DEFAULT 0,
  products_created INTEGER DEFAULT 0,
  products_updated INTEGER DEFAULT 0,
  products_errored INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  completed_at INTEGER,
  result_status TEXT,  -- success, partial, failed
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON evershop_import_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_started ON evershop_import_audit(started_at);
CREATE INDEX IF NOT EXISTS idx_audit_job ON evershop_import_audit(job_id);
