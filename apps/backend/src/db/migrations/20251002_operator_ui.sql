-- CardMint operator schema bootstrap (Oct 2025)
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  image_path TEXT,
  extracted_json TEXT DEFAULT '{}',
  top3_json TEXT DEFAULT '[]',
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  operator_id TEXT,
  session_id TEXT,
  timings_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS scan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT DEFAULT '{}',
  FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scan_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at INTEGER NOT NULL,
  metric_key TEXT NOT NULL,
  metric_value REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
CREATE INDEX IF NOT EXISTS idx_scan_events_scan_id ON scan_events(scan_id);
CREATE INDEX IF NOT EXISTS idx_scan_metrics_key_time ON scan_metrics(metric_key, recorded_at);
